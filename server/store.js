// server/store.js — PostgreSQL persistent storage
const { Pool } = require('pg');
const scanMeter = require('./scanMeter');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'agent',
      plan TEXT DEFAULT 'beta',
      trial_ends_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'beta';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS athlete_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_tier TEXT DEFAULT 'basic';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_required BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS gcal_refresh_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'inactive';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;
    -- Admin-only comp flag: full access with no card and no charge. Never set by
    -- signup; only an admin (or the one-time comp seed) can turn this on.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS comped BOOLEAN DEFAULT FALSE;
    -- New agents must not silently get free-forever access. The old 'beta' default
    -- was the leak (agentHasAccess used to exempt any non-'free' plan). New rows
    -- default to 'none'; access now comes from a Stripe trial/subscription or comp.
    ALTER TABLE users ALTER COLUMN plan SET DEFAULT 'none';
    -- Referral attribution (first-touch, permanent). Stamped once at agent signup
    -- from the ?ref cookie; never overwritten. NULL for organic/unattributed users.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_at TIMESTAMPTZ;
    -- Referral partners (affiliates). commission_rate is a fraction (0.20 = 20%).
    CREATE TABLE IF NOT EXISTS referral_partners (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      commission_rate NUMERIC(5,4) NOT NULL DEFAULT 0.20,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Seed Greg Glynn / Pliable Marketing. ON CONFLICT DO NOTHING so re-running init
    -- never clobbers later admin edits to the rate or active flag.
    INSERT INTO referral_partners (code, name, email, commission_rate, active)
    VALUES ('pliable', 'Greg Glynn', 'pliablemarketing@gmail.com', 0.20, TRUE)
    ON CONFLICT (code) DO NOTHING;
    -- One row per PAID invoice for a referred user. UNIQUE(stripe_invoice_id) makes
    -- the invoice.payment_succeeded handler idempotent under Stripe webhook retries.
    -- Amounts stored in integer cents (from Stripe) to avoid float rounding.
    CREATE TABLE IF NOT EXISTS referral_commissions (
      id BIGSERIAL PRIMARY KEY,
      partner_code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      stripe_invoice_id TEXT NOT NULL UNIQUE,
      payment_amount_cents INTEGER NOT NULL,
      commission_amount_cents INTEGER NOT NULL,
      commission_rate NUMERIC(5,4) NOT NULL,
      payment_date TIMESTAMPTZ NOT NULL,
      paid_out BOOLEAN NOT NULL DEFAULT FALSE,
      paid_out_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_referral_commissions_partner ON referral_commissions (partner_code);
    CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users (referred_by);
    CREATE TABLE IF NOT EXISTS athletes (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY,
      athlete_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS calendar_events (
      id SERIAL PRIMARY KEY,
      agent_id TEXT,
      title TEXT,
      date TEXT,
      notes TEXT,
      reminderdays INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      email TEXT,
      token TEXT,
      expires_at TIMESTAMPTZ,
      used BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS access_requests (
      id SERIAL PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      agency TEXT,
      athletes TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS athlete_reports (
      id TEXT PRIMARY KEY,
      athlete_id TEXT,
      agent_id TEXT,
      agent_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS athlete_invites (
      id TEXT PRIMARY KEY,
      athlete_id TEXT,
      agent_id TEXT,
      token TEXT UNIQUE,
      visibility JSONB DEFAULT '{}',
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS deal_scan_feedback (
      id SERIAL PRIMARY KEY,
      agent_id TEXT,
      athlete_id TEXT,
      brand TEXT,
      deal_type TEXT,
      action TEXT,
      sport TEXT,
      position TEXT,
      school_tier TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS deal_comps (
      id SERIAL PRIMARY KEY,
      sport TEXT,
      school_tier TEXT,
      school TEXT,
      position TEXT,
      followers INTEGER,
      engagement NUMERIC,
      deal_type TEXT,
      deal_value INTEGER,
      brand TEXT,
      year_in_school TEXT,
      draft_status TEXT,
      ppg NUMERIC,
      rpg NUMERIC,
      apg NUMERIC,
      source TEXT,
      athlete_name TEXT,
      auto_ingested BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // ── Athlete Contracts + Deliverables + Calendar (production-grade, idempotent) ─
  await pool.query(`
    CREATE TABLE IF NOT EXISTS athlete_contracts (
      id TEXT PRIMARY KEY,
      athlete_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      filename TEXT,
      brand TEXT,
      file_hash TEXT,
      raw_text TEXT,
      start_date DATE,
      end_date DATE,
      extraction_status TEXT DEFAULT 'pending',
      extraction_attempts INTEGER DEFAULT 0,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS athlete_deliverables (
      id SERIAL PRIMARY KEY,
      athlete_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      contract_id TEXT,
      deliverable_description TEXT NOT NULL,
      due_date DATE,
      brand TEXT,
      status TEXT DEFAULT 'pending',
      recurrence TEXT,
      recurrence_rule TEXT,
      ai_confidence_score INTEGER DEFAULT 0,
      source TEXT DEFAULT 'ai_extracted',
      sort_order INTEGER DEFAULT 0,
      manually_edited BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS athlete_calendar_events (
      id TEXT PRIMARY KEY,
      athlete_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      deliverable_id INTEGER,
      contract_id TEXT,
      title TEXT NOT NULL,
      event_date DATE NOT NULL,
      brand TEXT,
      color TEXT,
      status TEXT DEFAULT 'pending',
      is_generated BOOLEAN DEFAULT TRUE,
      recurrence_instance BOOLEAN DEFAULT FALSE,
      manually_modified BOOLEAN DEFAULT FALSE,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS contract_audit_log (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      athlete_id TEXT,
      contract_id TEXT,
      action_type TEXT NOT NULL,
      status TEXT,
      metadata JSONB DEFAULT '{}',
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS athlete_outreach (
      id TEXT PRIMARY KEY,
      athlete_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      subject TEXT,
      message TEXT NOT NULL,
      status TEXT DEFAULT 'sent',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(e => console.error('Contract system tables init error:', e.message));

  // Additive column migrations — safe to run on existing DBs
  const _contractMigrations = [
    `ALTER TABLE athlete_contracts ADD COLUMN IF NOT EXISTS file_hash TEXT`,
    `ALTER TABLE athlete_contracts ADD COLUMN IF NOT EXISTS raw_text TEXT`,
    `ALTER TABLE athlete_contracts ADD COLUMN IF NOT EXISTS start_date DATE`,
    `ALTER TABLE athlete_contracts ADD COLUMN IF NOT EXISTS end_date DATE`,
    `ALTER TABLE athlete_contracts ADD COLUMN IF NOT EXISTS extraction_status TEXT DEFAULT 'pending'`,
    `ALTER TABLE athlete_contracts ADD COLUMN IF NOT EXISTS extraction_attempts INTEGER DEFAULT 0`,
    `ALTER TABLE athlete_deliverables ADD COLUMN IF NOT EXISTS recurrence_rule TEXT`,
    `ALTER TABLE athlete_deliverables ADD COLUMN IF NOT EXISTS ai_confidence_score INTEGER DEFAULT 0`,
    `ALTER TABLE athlete_deliverables ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'ai_extracted'`,
    `ALTER TABLE athlete_deliverables ADD COLUMN IF NOT EXISTS manually_edited BOOLEAN DEFAULT FALSE`,
    // Google Calendar — track which NILDash events have been pushed to Google Calendar
    `ALTER TABLE athlete_calendar_events ADD COLUMN IF NOT EXISTS google_event_id TEXT`,
    // ── Athlete-created deliverables ──────────────────────────────────────────
    // Self-managed athletes have NULL agent_id, so the calendar events table can
    // no longer require agent_id. Idempotent: dropping a NOT NULL that's already
    // gone is a harmless no-op. Existing agent-created rows are unaffected.
    `ALTER TABLE athlete_calendar_events ALTER COLUMN agent_id DROP NOT NULL`,
    // Optional platform/type label (Instagram Post, Story, Reel, TikTok, …) and a
    // link to a money-loop deal (athlete_self_deals.id). Both nullable/additive.
    `ALTER TABLE athlete_calendar_events ADD COLUMN IF NOT EXISTS event_type TEXT`,
    `ALTER TABLE athlete_calendar_events ADD COLUMN IF NOT EXISTS deal_id INTEGER`,
  ];
  for (const sql of _contractMigrations) {
    await pool.query(sql).catch(() => {});
  }

  // Idempotency: file_hash unique index (partial — skips NULLs from old rows)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_file_hash ON athlete_contracts(file_hash) WHERE file_hash IS NOT NULL`).catch(() => {});
  // Prevent duplicate calendar events per deliverable + date
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cal_events_deliv_date ON athlete_calendar_events(deliverable_id, event_date) WHERE deliverable_id IS NOT NULL`).catch(() => {});
  // Prevent duplicate deliverables from re-uploads of the same contract
  await pool.query(`ALTER TABLE athlete_deliverables ADD CONSTRAINT athlete_deliverables_unique UNIQUE (athlete_id, contract_id, deliverable_description, due_date)`).catch(() => {});
  // Performance indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deliverables_athlete ON athlete_deliverables(athlete_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deliverables_agent ON athlete_deliverables(agent_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cal_events_athlete ON athlete_calendar_events(athlete_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cal_events_agent ON athlete_calendar_events(agent_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cal_events_date ON athlete_calendar_events(event_date)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON contract_audit_log(agent_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_log_contract ON contract_audit_log(contract_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_athlete_outreach_agent ON athlete_outreach(agent_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_athlete_outreach_athlete ON athlete_outreach(athlete_id)`).catch(() => {});

  // ── Athlete Auth & Onboarding (additive migrations — safe on existing DBs) ─
  const _athleteAuthMigrations = [
    // New top-level columns on athletes table for self-serve auth
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS email TEXT`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS password_hash TEXT`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS phone TEXT`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS instagram_handle TEXT`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS tiktok_handle TEXT`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS twitter_handle TEXT`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS account_activated_at TIMESTAMPTZ`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ`,
    // Google Calendar integration
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS google_refresh_token TEXT`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS google_calendar_id TEXT`,
    // Self-managed athlete support
    `ALTER TABLE athletes ALTER COLUMN agent_id DROP NOT NULL`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS athlete_type TEXT DEFAULT 'agent_managed'`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS email_verify_token TEXT`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS email_verify_expires TIMESTAMPTZ`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'inactive'`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS instagram_followers INTEGER`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS tiktok_followers INTEGER`,
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS twitter_followers INTEGER`,
    // Athlete's home/competition state — drives state-specific NIL compliance.
    // User-editable in Profile; falls back to school→state auto-detection.
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS state TEXT`,
    // First-run onboarding state (welcome wizard, guided tour, activation
    // checklist). Separate from onboarding_complete (which is payment/account
    // activation). Holds JSON like { dismissed, setupDone, checklist:{...} }.
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS onboarding_state JSONB DEFAULT '{}'::jsonb`,
    // Most-recent Deal Scan results, persisted per lane so re-entering Deal Scan
    // (or reloading) re-hydrates the athlete's ranked opportunities instead of a
    // blank slate. Shape: { local:{opportunities:[...],ts}, social:{...}, topnil:{...} }.
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS deal_scan_cache JSONB DEFAULT '{}'::jsonb`,
  ];
  for (const sql of _athleteAuthMigrations) {
    await pool.query(sql).catch(e => console.warn('[migration]', e.message));
  }

  // ── Deal Scan brand-evidence cache ─────────────────────────────────────────
  // Athlete-independent evidence for the SOCIAL (ambassador-program) and TOP NIL
  // (disclosed-deal precedent) lanes. Keyed by (brand_key, lane) so the same
  // program/deal facts are shared across every athlete and re-used for ~7 days
  // instead of paying a fresh web search per scan. The qualification VERDICT is
  // NOT stored here — it is derived per-athlete at scan time from this evidence
  // plus the athlete's own follower counts, so a stale verdict can never leak.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brand_evidence_cache (
      brand_key TEXT NOT NULL,
      lane TEXT NOT NULL,
      brand TEXT,
      website TEXT,
      evidence JSONB DEFAULT '{}'::jsonb,
      outcome TEXT,
      refreshed_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (brand_key, lane)
    );
  `).then(() => console.log('[startup] brand_evidence_cache: ensured'))
    .catch(e => console.error('[startup] brand_evidence_cache init FAILED:', e.message));
  // Explicit existence probe so a production boot log states plainly whether the
  // table is really there (to_regclass is null when it is not).
  try {
    const _probe = await pool.query(`SELECT to_regclass('brand_evidence_cache') AS t`);
    console.log(`[startup] brand_evidence_cache exists=${_probe.rows[0] && _probe.rows[0].t ? 'yes' : 'NO'}`);
  } catch (e) { console.error('[startup] brand_evidence_cache probe error:', e.message); }

  // ── User Onboarding (wizard state, Getting Started checklist, tooltips) ─────
  // Backs Parts A/C/E of the onboarding overhaul. user_id is TEXT to match the
  // users table PK (users.id TEXT). Additive and idempotent — safe on prod.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_onboarding (
      user_id TEXT PRIMARY KEY,
      wizard_step INTEGER DEFAULT 0,
      wizard_completed_at TIMESTAMPTZ,
      wizard_step_events JSONB DEFAULT '[]'::jsonb,
      checklist JSONB DEFAULT '{}'::jsonb,
      checklist_dismissed BOOLEAN DEFAULT FALSE,
      checklist_backfilled BOOLEAN DEFAULT FALSE,
      tooltips_seen JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('[init] user_onboarding table ready'))
    .catch(e => console.error('[init] user_onboarding:', e.message));
  await pool.query(`ALTER TABLE user_onboarding ADD COLUMN IF NOT EXISTS checklist_backfilled BOOLEAN DEFAULT FALSE`).catch(() => {});

  // ── Deal Scan market candidate cache ────────────────────────────────────────
  // Phase-1 category searches discover businesses in a MARKET; markets are
  // shared across athletes and stable across days, so the candidate pools are
  // cached here (key: normalized market + lane, e.g. "homewood-alabama:local").
  // Phase-2 scoring always runs fresh per athlete. Idempotent and additive.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deal_scan_market_cache (
      cache_key TEXT PRIMARY KEY,
      candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('[init] deal_scan_market_cache table ready'))
    .catch(e => console.error('[init] deal_scan_market_cache:', e.message));

  // Media kit theme: 'school' (auto school colors, the original look) or
  // 'nildash' (dark + lime brand). NULL on existing rows = school behavior, so
  // saved kits are unchanged by this deploy. New kits default to 'nildash' in
  // the builder UI, not here.
  await pool.query(`ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS theme TEXT`).catch(() => {});

  // Per-brand kit variants: {brandSlug: {brand, category, opener, matchedTags,
  // rateLead, createdAt}}. Stored beside the kit so the base kit is never
  // modified; the public page personalizes when ?for=<brandSlug> matches.
  await pool.query(`ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS variants JSONB DEFAULT '{}'::jsonb`).catch(() => {});

  // ── Media kit view tracking ────────────────────────────────────────────────
  // One row per unique public view. session_hash is sha256(salt+ip+ua): the
  // raw IP is never stored and the public page sets no cookies. Repeat views
  // by the same hash within 30 minutes are not re-recorded, and views from the
  // kit's own logged-in agent are skipped at the endpoint.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_kit_views (
      id SERIAL PRIMARY KEY,
      kit_slug TEXT NOT NULL,
      athlete_id TEXT,
      agent_id TEXT,
      variant TEXT,
      variant_brand TEXT,
      session_hash TEXT NOT NULL,
      viewed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('[init] media_kit_views table ready'))
    .catch(e => console.error('[init] media_kit_views:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mkv_slug ON media_kit_views(kit_slug, viewed_at)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mkv_agent ON media_kit_views(agent_id, viewed_at)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mkv_hash ON media_kit_views(session_hash, kit_slug, viewed_at)`).catch(() => {});

  // Enforce one account per email (case-insensitive). Partial index so
  // agent-managed athletes without an email are unaffected. If existing
  // duplicates block creation, log and continue (handled at signup too).
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_athletes_email_unique ON athletes (LOWER(email)) WHERE email IS NOT NULL`
  ).catch(e => console.warn('[migration] athletes email unique index:', e.message));

  // New invite tokens table (replaces/supplements athlete_invites for new flow)
  // NOTE: No FK constraint on athlete_id to avoid silent failures on old DBs
  await pool.query(`
    CREATE TABLE IF NOT EXISTS athlete_invite_tokens (
      id SERIAL PRIMARY KEY,
      athlete_id TEXT NOT NULL,
      agent_id TEXT,
      token TEXT UNIQUE NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('[init] athlete_invite_tokens table ready'))
    .catch(e => console.error('[init] athlete_invite_tokens FAILED:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invite_tokens_athlete ON athlete_invite_tokens(athlete_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invite_tokens_token ON athlete_invite_tokens(token)`).catch(() => {});

  // Brand outreach table (athlete-initiated, separate from internal athlete_outreach messages)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS athlete_brand_outreach (
      id SERIAL PRIMARY KEY,
      athlete_id TEXT NOT NULL,
      agent_id TEXT,
      brand_name TEXT NOT NULL,
      brand_contact_email TEXT,
      brand_website TEXT,
      sport_relevance TEXT,
      message_sent TEXT NOT NULL,
      initiated_by TEXT DEFAULT 'athlete',
      status TEXT DEFAULT 'sent',
      agent_notified BOOLEAN DEFAULT FALSE,
      agent_approved BOOLEAN,
      requires_approval BOOLEAN DEFAULT FALSE,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(e => console.error('[init] athlete_brand_outreach:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_brand_outreach_athlete ON athlete_brand_outreach(athlete_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_brand_outreach_agent ON athlete_brand_outreach(agent_id)`).catch(() => {});

  // ── Athlete Activity Log (every athlete action visible to agent) ──────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS athlete_activity_log (
      id SERIAL PRIMARY KEY,
      athlete_id TEXT NOT NULL,
      agent_id TEXT,
      activity_type TEXT NOT NULL,
      description TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('[init] athlete_activity_log table ready'))
    .catch(e => console.error('[init] athlete_activity_log:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activity_log_athlete ON athlete_activity_log(athlete_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activity_log_agent ON athlete_activity_log(agent_id)`).catch(() => {});

  // ── Deal Scan Pipeline (local brand outreach tracking) ────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS athlete_deal_pipeline (
      id SERIAL PRIMARY KEY,
      athlete_id TEXT NOT NULL,
      agent_id TEXT,
      brand_name TEXT NOT NULL,
      brand_category TEXT,
      contact_email TEXT,
      contact_name TEXT,
      status TEXT DEFAULT 'not_contacted',
      deal_value TEXT,
      pitch_subject TEXT,
      pitch_body TEXT,
      notes TEXT,
      pitched_at TIMESTAMPTZ,
      last_contact_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('[init] athlete_deal_pipeline table ready'))
    .catch(e => console.error('[init] athlete_deal_pipeline:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_pipeline_athlete ON athlete_deal_pipeline(athlete_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deal_pipeline_status ON athlete_deal_pipeline(status)`).catch(() => {});

  // ── Athlete Self-Managed Deals ────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS athlete_self_deals (
      id SERIAL PRIMARY KEY,
      athlete_id TEXT NOT NULL,
      agent_id TEXT,
      brand_name TEXT NOT NULL,
      deal_type TEXT DEFAULT 'Other',
      value NUMERIC,
      stage TEXT DEFAULT 'Prospect',
      description TEXT,
      start_date DATE,
      notes TEXT,
      stage_history JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('[init] athlete_self_deals table ready'))
    .catch(e => console.error('[init] athlete_self_deals:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_self_deals_athlete ON athlete_self_deals(athlete_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_self_deals_agent ON athlete_self_deals(agent_id)`).catch(() => {});

  // Additive columns so Brand Tracker can be the single source of truth for
  // tracked brands (Deal Scan "+ Track" now writes here, not a separate store).
  // All nullable; no existing column is altered or dropped.
  const _selfDealsMigrations = [
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS category TEXT`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS contact_name TEXT`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS contact_email TEXT`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS fit_score INTEGER`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual'`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS is_local BOOLEAN`,
    // ── Money Loop columns (agreement → invoice → paid → earnings) ──────────────
    // All additive + nullable (or defaulted). Existing rows backfill cleanly:
    // fee_pct defaults 0 (fee OFF), disclosure_status defaults 'not_required'.
    // These are DISPLAY/RECORD ONLY — no payment processing, no money movement.
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS deliverables TEXT`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS timeline TEXT`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS fee_pct NUMERIC DEFAULT 0`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS fee_amount NUMERIC`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS net_amount NUMERIC`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS paid_date DATE`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS amount_received NUMERIC`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS agreement_text TEXT`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS agreement_json JSONB`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS agreement_generated_at TIMESTAMPTZ`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS invoice_text TEXT`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS invoice_json JSONB`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS invoice_number TEXT`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS invoice_issue_date DATE`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS invoice_due_date DATE`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS payee_info TEXT`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS disclosure_status TEXT DEFAULT 'not_required'`,
    `ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS disclosure_date DATE`,
  ];
  for (const sql of _selfDealsMigrations) {
    await pool.query(sql).catch(e => console.error('[init] self_deals migration:', e.message));
  }

  // ── Stage remap to the full money-loop lifecycle ─────────────────────────────
  // Old stages: Prospect, Contacted, Negotiating, Signed, Completed, Lost.
  // New loop:   Prospect → Pitched → In Talks → Agreed → Contract → Invoiced →
  //             Paid → Completed (plus terminal "Lost"). These UPDATEs are
  //             idempotent: new code never writes the old labels, so after the
  //             first run no rows match and re-running is a no-op. No data lost.
  const _stageRemap = [
    `UPDATE athlete_self_deals SET stage='Pitched'  WHERE stage='Contacted'`,
    `UPDATE athlete_self_deals SET stage='In Talks'  WHERE stage='Negotiating'`,
    `UPDATE athlete_self_deals SET stage='Agreed'    WHERE stage='Signed'`,
  ];
  for (const sql of _stageRemap) {
    await pool.query(sql).catch(e => console.error('[init] self_deals stage remap:', e.message));
  }

  // One-time data migration: fold any pre-existing Deal Scan pipeline rows
  // (athlete_deal_pipeline) into Brand Tracker (athlete_self_deals) as
  // Outreach-stage deals, deduped by athlete + normalized brand. Guarded by an
  // app_flags row so it only runs once and never resurrects deleted deals.
  await pool.query(`CREATE TABLE IF NOT EXISTS app_flags (key TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`).catch(() => {});
  try {
    const flag = await pool.query(`SELECT 1 FROM app_flags WHERE key = 'pipeline_to_deals_migrated'`);
    if (!flag.rows.length) {
      const PSTATUS_TO_STAGE = {
        not_contacted: 'Prospect', pitched: 'Contacted', in_talks: 'Negotiating',
        deal_closed: 'Signed', no_response: 'Contacted',
      };
      const legacy = await pool.query(`SELECT * FROM athlete_deal_pipeline`);
      let moved = 0;
      for (const row of legacy.rows) {
        const dupe = await pool.query(
          `SELECT 1 FROM athlete_self_deals WHERE athlete_id=$1 AND LOWER(TRIM(brand_name))=LOWER(TRIM($2)) LIMIT 1`,
          [row.athlete_id, row.brand_name]
        );
        if (dupe.rows.length) continue;
        const stage = PSTATUS_TO_STAGE[row.status] || 'Prospect';
        // deal_value is free text like "$500-$1500"; keep the original text in
        // notes and try to derive a numeric midpoint for the value column.
        let value = null;
        const nums = String(row.deal_value || '').match(/\d[\d,]*/g);
        if (nums && nums.length) {
          const parsed = nums.map(n => parseInt(n.replace(/,/g, ''), 10)).filter(n => !isNaN(n));
          if (parsed.length) value = Math.round(parsed.reduce((a, b) => a + b, 0) / parsed.length);
        }
        const noteParts = [];
        if (row.deal_value) noteParts.push('Rate range: ' + row.deal_value);
        if (row.notes) noteParts.push(row.notes);
        const stageHistory = JSON.stringify([{ stage, date: new Date().toISOString(), note: 'Migrated from Deal Scan pipeline' }]);
        await pool.query(
          `INSERT INTO athlete_self_deals
             (athlete_id, agent_id, brand_name, deal_type, value, stage, description, notes,
              category, contact_name, contact_email, source, stage_history, created_at)
           VALUES ($1,$2,$3,'Other',$4,$5,$6,$7,$8,$9,$10,'deal_scan',$11,COALESCE($12,NOW()))`,
          [row.athlete_id, row.agent_id || null, row.brand_name, value, stage,
           null, noteParts.join('\n\n') || null, row.brand_category || null,
           row.contact_name || null, row.contact_email || null, stageHistory, row.created_at || null]
        ).then(() => { moved++; }).catch(e => console.error('[init] pipeline->deals row:', e.message));
      }
      await pool.query(`INSERT INTO app_flags (key) VALUES ('pipeline_to_deals_migrated') ON CONFLICT DO NOTHING`).catch(() => {});
      console.log(`[init] pipeline->deals migration complete: ${moved} deal(s) moved`);
    }
  } catch (e) {
    console.error('[init] pipeline->deals migration skipped:', e.message);
  }

  // One-time purge of the contacts evidence cache. Rows written before the
  // widened-source + locality fixes have no version tag and would otherwise serve
  // stale "named:0, wrong-state phone" results for up to 30 days. Deleting them
  // forces every brand to re-run the widened search fresh on the next scan.
  // Guarded by app_flags so it runs exactly once.
  try {
    const flag = await pool.query(`SELECT 1 FROM app_flags WHERE key = 'contacts_cache_purge_v2'`);
    if (!flag.rows.length) {
      const del = await pool.query(`DELETE FROM brand_evidence_cache WHERE lane = 'contacts'`);
      await pool.query(`INSERT INTO app_flags (key) VALUES ('contacts_cache_purge_v2') ON CONFLICT DO NOTHING`).catch(() => {});
      console.log(`[init] contacts cache purge (v2): ${del.rowCount || 0} stale row(s) deleted`);
    }
  } catch (e) {
    console.error('[init] contacts cache purge skipped:', e.message);
  }

  // One-time comp seed for chosen partners: full access, no card, no charge,
  // until an admin removes it. Guarded by app_flags so a later manual un-comp is
  // not undone on the next boot.
  try {
    const flag = await pool.query(`SELECT 1 FROM app_flags WHERE key = 'comp_seed_partners_v1'`);
    if (!flag.rows.length) {
      const r = await pool.query(
        `UPDATE users SET comped = TRUE
           WHERE LOWER(email) IN ('pliablemarketing@gmail.com','rexyfisher@gmail.com')`
      );
      await pool.query(`INSERT INTO app_flags (key) VALUES ('comp_seed_partners_v1') ON CONFLICT DO NOTHING`).catch(() => {});
      console.log(`[init] comp seed: ${r.rowCount || 0} partner account(s) comped (Greg Glynn, Rex Kaplan)`);
    }
  } catch (e) {
    console.error('[init] comp seed skipped:', e.message);
  }

  // ── Email Integration Tables (additive — never modifies existing tables) ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      email_address TEXT NOT NULL,
      access_token_enc TEXT,
      refresh_token_enc TEXT,
      token_expiry TIMESTAMPTZ,
      status TEXT DEFAULT 'active',
      last_sync TIMESTAMPTZ,
      sync_cursor TEXT,
      display_name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, email_address)
    );
    CREATE TABLE IF NOT EXISTS email_threads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      subject TEXT,
      participant_emails TEXT[],
      athlete_id TEXT,
      deal_id TEXT,
      last_message_at TIMESTAMPTZ,
      message_count INTEGER DEFAULT 0,
      has_unread BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS emails (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      account_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      from_address TEXT,
      from_name TEXT,
      to_addresses TEXT[],
      cc_addresses TEXT[],
      subject TEXT,
      body_text TEXT,
      body_html TEXT,
      provider_message_id TEXT,
      provider_thread_id TEXT,
      sent_at TIMESTAMPTZ,
      is_read BOOLEAN DEFAULT FALSE,
      has_attachments BOOLEAN DEFAULT FALSE,
      athlete_id TEXT,
      deal_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(account_id, provider_message_id)
    );
    CREATE TABLE IF NOT EXISTS email_sync_logs (
      id SERIAL PRIMARY KEY,
      account_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      messages_synced INTEGER DEFAULT 0,
      error_message TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS email_drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      thread_id TEXT,
      to_addresses TEXT[],
      cc_addresses TEXT[],
      subject TEXT,
      body_html TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(e => console.error('Email tables init error:', e.message));
  // Email indexes for performance
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_accounts_user ON email_accounts(user_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(thread_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_emails_account ON emails(account_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_emails_athlete ON emails(athlete_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_threads_user ON email_threads(user_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_threads_athlete ON email_threads(athlete_id)`).catch(() => {});

  // Indexes for performance
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_athletes_agent ON athletes(agent_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_athlete ON deals(athlete_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_deals_agent ON deals(agent_id)`).catch(() => {});
  // Add name column if missing (migration for existing DBs)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT`).catch(() => {});

  // ── Outreach Engine Tables (additive — never modifies existing tables) ──────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS company_enrichment (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      brand_name TEXT NOT NULL,
      website TEXT,
      industry TEXT,
      location TEXT,
      phone TEXT,
      general_email TEXT,
      description TEXT,
      social_links JSONB DEFAULT '{}',
      brand_size TEXT,
      employee_count TEXT,
      annual_revenue TEXT,
      marketing_contacts JSONB DEFAULT '[]',
      sponsorship_contacts JSONB DEFAULT '[]',
      partnership_contacts JSONB DEFAULT '[]',
      pr_contacts JSONB DEFAULT '[]',
      athlete_relations_contacts JSONB DEFAULT '[]',
      raw_data JSONB DEFAULT '{}',
      enriched_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS brand_contacts (
      id TEXT PRIMARY KEY,
      enrichment_id TEXT NOT NULL REFERENCES company_enrichment(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      brand_name TEXT NOT NULL,
      name TEXT,
      title TEXT,
      email TEXT,
      phone TEXT,
      linkedin TEXT,
      contact_type TEXT,
      confidence_score NUMERIC DEFAULT 0,
      source TEXT,
      priority_rank INT DEFAULT 99,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS brand_match_scores (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      athlete_id TEXT NOT NULL,
      brand_name TEXT NOT NULL,
      enrichment_id TEXT REFERENCES company_enrichment(id) ON DELETE SET NULL,
      compatibility_score NUMERIC DEFAULT 0,
      reasoning TEXT,
      campaign_ideas JSONB DEFAULT '[]',
      partnership_opportunities JSONB DEFAULT '[]',
      audience_alignment TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pitch_decks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      athlete_id TEXT NOT NULL,
      brand_name TEXT NOT NULL,
      enrichment_id TEXT REFERENCES company_enrichment(id) ON DELETE SET NULL,
      match_score_id TEXT REFERENCES brand_match_scores(id) ON DELETE SET NULL,
      file_path TEXT,
      slide_data JSONB DEFAULT '{}',
      version INT DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS outreach_logs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      athlete_id TEXT NOT NULL,
      brand_name TEXT NOT NULL,
      contact_id TEXT REFERENCES brand_contacts(id) ON DELETE SET NULL,
      enrichment_id TEXT REFERENCES company_enrichment(id) ON DELETE SET NULL,
      deck_id TEXT REFERENCES pitch_decks(id) ON DELETE SET NULL,
      email_account_id TEXT,
      email_message_id TEXT,
      subject TEXT,
      body_html TEXT,
      status TEXT DEFAULT 'draft',
      sent_at TIMESTAMPTZ,
      opened_at TIMESTAMPTZ,
      replied_at TIMESTAMPTZ,
      follow_up_count INT DEFAULT 0,
      next_follow_up_at TIMESTAMPTZ,
      crm_deal_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      athlete_id TEXT NOT NULL,
      brand_name TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      steps_completed JSONB DEFAULT '[]',
      steps_failed JSONB DEFAULT '[]',
      enrichment_id TEXT,
      contact_id TEXT,
      match_score_id TEXT,
      deck_id TEXT,
      outreach_id TEXT,
      error_message TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS workflow_events (
      id SERIAL PRIMARY KEY,
      run_id TEXT REFERENCES automation_runs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(e => console.error('Outreach engine tables init error:', e.message));

  // Outreach engine indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_company_enrichment_agent ON company_enrichment(agent_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_company_enrichment_brand ON company_enrichment(brand_name)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_brand_contacts_enrichment ON brand_contacts(enrichment_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_brand_contacts_agent ON brand_contacts(agent_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_brand_match_athlete ON brand_match_scores(athlete_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outreach_logs_agent ON outreach_logs(agent_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outreach_logs_athlete ON outreach_logs(athlete_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_automation_runs_agent ON automation_runs(agent_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_workflow_events_run ON workflow_events(run_id)`).catch(() => {});


  // ── University Mode Schema (additive — never breaks agent or athlete tables) ──
  // Creates all 18 tables the university services query. Safe to run on existing
  // DBs — every statement uses CREATE TABLE IF NOT EXISTS.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS universities (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      short_name  TEXT,
      conference  TEXT,
      location    TEXT,
      logo_url    TEXT,
      primary_color TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS university_deal_pipeline (
      id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id      TEXT NOT NULL,
      athlete_id         TEXT NOT NULL,
      brand              TEXT NOT NULL,
      deal_value         INTEGER DEFAULT 0,
      deal_type          TEXT DEFAULT 'other',
      status             TEXT DEFAULT 'pending',
      start_date         DATE,
      end_date           DATE,
      disclosure_status  TEXT DEFAULT 'pending',
      notes              TEXT,
      created_by         TEXT,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS athlete_contact_log (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id   TEXT NOT NULL,
      athlete_id      TEXT NOT NULL,
      contact_type    TEXT NOT NULL,
      subject         TEXT,
      body            TEXT,
      created_by      TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS nil_activity_log (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id   TEXT,
      athlete_id      TEXT,
      user_id         TEXT,
      activity_type   TEXT NOT NULL,
      brand           TEXT,
      deal_value      INTEGER,
      metadata        JSONB DEFAULT '{}',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    -- NOTE: university_daily_actions is owned by migration 006
    -- (server/migrations/006_nil_director_dashboard.sql). It was previously
    -- duplicated here with a conflicting legacy schema (priority TEXT, message,
    -- resolved) which made migration 006's CREATE TABLE IF NOT EXISTS a no-op
    -- and caused the is_dismissed index to fail on every deploy. Removed so the
    -- migration's canonical schema (priority INTEGER, title, detail,
    -- is_dismissed, ...) is the single source of truth.

    CREATE TABLE IF NOT EXISTS ingestion_events (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id   TEXT NOT NULL,
      user_id         TEXT,
      source_type     TEXT NOT NULL,
      source_id       TEXT,
      content_hash    TEXT,
      raw_payload     JSONB NOT NULL,
      normalized      JSONB,
      status          TEXT DEFAULT 'queued',
      resolution_id   TEXT,
      confidence      INTEGER DEFAULT 0,
      error_message   TEXT,
      processed_at    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS athlete_entity_links (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id   TEXT NOT NULL,
      athlete_id      TEXT NOT NULL,
      ingestion_event_id TEXT,
      source_type     TEXT,
      source_id       TEXT,
      confidence      INTEGER DEFAULT 0,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS athlete_roster_states (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id   TEXT NOT NULL,
      athlete_id      TEXT NOT NULL,
      status          TEXT DEFAULT 'unknown',
      source          TEXT,
      confidence      INTEGER DEFAULT 0,
      detected_at     TIMESTAMPTZ DEFAULT NOW(),
      resolved_at     TIMESTAMPTZ,
      metadata        JSONB DEFAULT '{}',
      UNIQUE (university_id, athlete_id)
    );

    CREATE TABLE IF NOT EXISTS roster_sync_runs (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id   TEXT NOT NULL,
      triggered_by    TEXT,
      user_id         TEXT,
      status          TEXT DEFAULT 'running',
      athletes_found  INTEGER DEFAULT 0,
      athletes_added  INTEGER DEFAULT 0,
      athletes_updated INTEGER DEFAULT 0,
      error_message   TEXT,
      started_at      TIMESTAMPTZ DEFAULT NOW(),
      completed_at    TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS roster_snapshots (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id   TEXT NOT NULL,
      sport           TEXT,
      snapshot_data   JSONB NOT NULL DEFAULT '[]',
      athlete_count   INTEGER DEFAULT 0,
      source          TEXT,
      created_by      TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS roster_snapshot_athletes (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      snapshot_id     TEXT NOT NULL,
      university_id   TEXT NOT NULL,
      name            TEXT,
      sport           TEXT,
      position        TEXT,
      year            TEXT,
      raw_data        JSONB DEFAULT '{}',
      committed       BOOLEAN DEFAULT FALSE,
      athlete_id      TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS roster_state_history (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id   TEXT NOT NULL,
      athlete_id      TEXT NOT NULL,
      old_status      TEXT,
      new_status      TEXT NOT NULL,
      reason          TEXT,
      changed_by      TEXT,
      changed_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS roster_review_queue (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id   TEXT NOT NULL,
      ingestion_event_id TEXT,
      athlete_name    TEXT,
      sport           TEXT,
      school          TEXT,
      reason          TEXT,
      status          TEXT DEFAULT 'pending',
      resolved_by     TEXT,
      resolved_at     TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS roster_discovery_sources (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id   TEXT NOT NULL,
      sport           TEXT NOT NULL,
      source_type     TEXT NOT NULL,
      url             TEXT,
      confidence      INTEGER DEFAULT 50,
      last_crawled_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (university_id, sport, url)
    );

    CREATE TABLE IF NOT EXISTS roster_discovery_jobs (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id   TEXT NOT NULL,
      sport           TEXT,
      status          TEXT DEFAULT 'pending',
      sources_tried   INTEGER DEFAULT 0,
      athletes_found  INTEGER DEFAULT 0,
      error_message   TEXT,
      started_at      TIMESTAMPTZ DEFAULT NOW(),
      completed_at    TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS roster_intelligence_log (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id   TEXT NOT NULL,
      sport           TEXT,
      action          TEXT NOT NULL,
      result          TEXT,
      athlete_count   INTEGER DEFAULT 0,
      metadata        JSONB DEFAULT '{}',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS university_sync_health (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id   TEXT NOT NULL UNIQUE,
      last_sync_at    TIMESTAMPTZ,
      last_sync_status TEXT,
      consecutive_failures INTEGER DEFAULT 0,
      athlete_count   INTEGER DEFAULT 0,
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS automation_scheduler_log (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id   TEXT,
      job_type        TEXT NOT NULL,
      status          TEXT NOT NULL,
      duration_ms     INTEGER,
      error_message   TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(e => console.error('University schema init error:', e.message));

  // university_id column on users (needed for university mode scoping)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS university_id TEXT`).catch(() => {});

  // University schema indexes
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_univ_deals_university ON university_deal_pipeline(university_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_univ_deals_athlete ON university_deal_pipeline(athlete_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_contact_log_athlete ON athlete_contact_log(athlete_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_nil_activity_univ ON nil_activity_log(university_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_nil_activity_athlete ON nil_activity_log(athlete_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ingestion_events_univ ON ingestion_events(university_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ingestion_events_hash ON ingestion_events(content_hash)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_roster_states_univ ON athlete_roster_states(university_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_snap_athletes_snap ON roster_snapshot_athletes(snapshot_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_review_queue_univ ON roster_review_queue(university_id)`).catch(() => {});

  // ── University Compliance Portal additions ─────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS university_users (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
      university_id TEXT NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'compliance_officer',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS university_athlete_links (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
      university_id TEXT NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
      athlete_id TEXT NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      linked_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(university_id, athlete_id)
    );
  `).catch(() => {});

  await pool.query(`
    CREATE TABLE IF NOT EXISTS university_deal_flags (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
      university_id TEXT NOT NULL,
      athlete_id TEXT NOT NULL,
      deal_id TEXT,
      flag_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      ai_summary TEXT,
      recommended_action TEXT,
      deals_involved TEXT[],
      resolved BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(() => {});

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_univ_users_university ON university_users(university_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_univ_athlete_links_university ON university_athlete_links(university_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_univ_deal_flags_university ON university_deal_flags(university_id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_univ_deal_flags_athlete ON university_deal_flags(athlete_id)`).catch(() => {});

  await pool.query(`
    INSERT INTO universities (id, name, short_name, conference, location) VALUES
      ('univ-samford', 'Samford University', 'Samford', 'SoCon', 'Birmingham, AL'),
      ('univ-alabama', 'University of Alabama', 'Alabama', 'SEC', 'Tuscaloosa, AL'),
      ('univ-duke', 'Duke University', 'Duke', 'ACC', 'Durham, NC')
    ON CONFLICT (id) DO NOTHING
  `).catch(() => {});

  console.log('Database tables ready');
}

// USERS
async function getUser(id) {
  const r = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
  if (r.rows[0]) { const { password, ...safe } = r.rows[0]; return safe; }
  return null;
}
async function getUserWithPassword(id) {
  const r = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
  return r.rows[0] || null;
}
async function getUserByEmail(email) {
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  if (r.rows[0]) { const { password, ...safe } = r.rows[0]; return safe; }
  return null;
}
async function getUserByEmailWithPassword(email) {
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  return r.rows[0] || null;
}
async function getUserByStripeCustomer(customerId) {
  if (!customerId) return null;
  const r = await pool.query('SELECT * FROM users WHERE stripe_customer_id=$1', [customerId]);
  if (r.rows[0]) { const { password, ...safe } = r.rows[0]; return safe; }
  return null;
}

// ── Referral tracking ────────────────────────────────────────────────────────
async function getReferralPartner(code) {
  if (!code) return null;
  const r = await pool.query('SELECT * FROM referral_partners WHERE code=$1', [String(code).toLowerCase().trim()]);
  return r.rows[0] || null;
}
// PURE decision: given a Stripe invoice, the paying user, and the referral
// partner, return the commission row to insert, or null when no commission is due.
// No commission when: $0 (trial) invoice, comped user, unreferred user, or the
// partner is missing / inactive / mismatched. Amounts stay in integer cents.
function buildCommissionRow(invoice, user, partner) {
  if (!invoice || !user || !partner) return null;
  const amountPaid = Number(invoice.amount_paid) || 0; // cents
  if (amountPaid <= 0) return null;                    // $0 trial invoice: no commission
  if (user.comped) return null;                        // comped account: no commission
  if (!user.referred_by) return null;                  // organic signup: no commission
  if (partner.code !== user.referred_by || !partner.active) return null;
  const rate = Number(partner.commission_rate) || 0;
  if (rate <= 0) return null;
  const paidAtUnix = (invoice.status_transitions && invoice.status_transitions.paid_at) || invoice.created || null;
  return {
    partner_code: partner.code,
    user_id: user.id,
    stripe_invoice_id: invoice.id,
    payment_amount_cents: amountPaid,
    commission_amount_cents: Math.round(amountPaid * rate),
    commission_rate: rate,
    payment_date: paidAtUnix ? new Date(paidAtUnix * 1000).toISOString() : new Date().toISOString(),
  };
}
// PURE admin aggregation: given partner rows, referred-user rows, and commission
// rows, compute per-partner stats (signups, converted-to-paid, conversion rate,
// earned all-time / owed-unpaid / paid-out in cents, and the referred-user list).
// A user counts as "converted" once they have at least one commission row (they
// paid at least one real invoice). Extracted so the math is unit-testable.
function aggregateReferrals(partners, users, commissions) {
  const byCode = {};
  const convertedByCode = {};
  for (const c of (commissions || [])) {
    const a = byCode[c.partner_code] || (byCode[c.partner_code] = { earned: 0, owed: 0, paid: 0 });
    const amt = Number(c.commission_amount_cents) || 0;
    a.earned += amt;
    if (c.paid_out) a.paid += amt; else a.owed += amt;
    (convertedByCode[c.partner_code] || (convertedByCode[c.partner_code] = new Set())).add(c.user_id);
  }
  const usersByCode = {};
  for (const u of (users || [])) (usersByCode[u.referred_by] || (usersByCode[u.referred_by] = [])).push(u);
  return (partners || []).map((p) => {
    const referred = usersByCode[p.code] || [];
    const converted = (convertedByCode[p.code] || new Set()).size;
    const sums = byCode[p.code] || { earned: 0, owed: 0, paid: 0 };
    return {
      code: p.code, name: p.name, email: p.email,
      commissionRate: Number(p.commission_rate), active: p.active,
      totalSignups: referred.length,
      convertedToPaid: converted,
      conversionRate: referred.length ? converted / referred.length : 0,
      earnedAllTimeCents: sums.earned,
      owedUnpaidCents: sums.owed,
      paidOutCents: sums.paid,
      referredUsers: referred.map((u) => ({
        id: u.id, name: u.name, email: u.email,
        signupDate: u.created_at, subscriptionStatus: u.subscription_status, comped: u.comped,
      })),
    };
  });
}
// Idempotent insert: UNIQUE(stripe_invoice_id) means a replayed webhook is a no-op.
async function recordReferralCommission(row) {
  const r = await pool.query(
    `INSERT INTO referral_commissions
       (partner_code, user_id, stripe_invoice_id, payment_amount_cents, commission_amount_cents, commission_rate, payment_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (stripe_invoice_id) DO NOTHING
     RETURNING id`,
    [row.partner_code, row.user_id, row.stripe_invoice_id, row.payment_amount_cents,
     row.commission_amount_cents, row.commission_rate, row.payment_date]
  );
  return { inserted: r.rows.length > 0, id: r.rows[0] ? r.rows[0].id : null };
}
// The full commission decision + write for one Stripe invoice, shared by the
// invoice.payment_succeeded webhook and the Stripe test-clock verification so both
// run the SAME path. Returns { recorded, duplicate, reason, row, id }. Never throws
// on a "no commission due" case; only real DB errors propagate.
async function recordReferralForInvoice(invoice) {
  const user = await getUserByStripeCustomer(invoice && invoice.customer);
  if (!user) return { recorded: false, reason: 'no user for customer' };
  if (user.comped) return { recorded: false, reason: 'comped user' };
  if (!user.referred_by) return { recorded: false, reason: 'unreferred user' };
  if (!(Number(invoice.amount_paid) > 0)) return { recorded: false, reason: 'zero-amount (trial) invoice' };
  const partner = await getReferralPartner(user.referred_by);
  const row = buildCommissionRow(invoice, user, partner);
  if (!row) return { recorded: false, reason: 'partner missing, inactive, or code mismatch' };
  const { inserted, id } = await recordReferralCommission(row);
  return { recorded: inserted, duplicate: !inserted, id, row };
}
async function saveUser(id, data) {
  // Never save an account nameless: fall back to the email's local-part.
  const safeName = (data.name && String(data.name).trim())
    || (data.email ? String(data.email).split('@')[0] : '')
    || 'Agent';
  await pool.query(`
    INSERT INTO users (id, name, email, password, role, athlete_id, agent_id, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
    ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name, email=EXCLUDED.email, password=EXCLUDED.password,
      role=EXCLUDED.role, athlete_id=EXCLUDED.athlete_id, agent_id=EXCLUDED.agent_id, updated_at=NOW()
  `, [id, safeName, data.email, data.password, data.role || 'agent', data.athleteId || null, data.agentId || null]);
  return getUser(id);
}
async function getAllUsers() {
  const r = await pool.query('SELECT * FROM users');
  return Object.fromEntries(r.rows.map(u => [u.id, u]));
}

// AGENT SIDE ONLY — do not use in university routes.
// University athletes live in the university_athletes table. Any code that
// imports, reads, or writes university roster data must use that table instead.
async function getAthlete(id) {
  const r = await pool.query('SELECT * FROM athletes WHERE id=$1', [id]);
  if (!r.rows[0]) return null;
  return { id: r.rows[0].id, agentId: r.rows[0].agent_id, ...r.rows[0].data };
}
async function getAthletesByAgent(agentId) {
  // AGENT SIDE ONLY — do not use in university routes
  const r = await pool.query(
    `SELECT * FROM athletes WHERE agent_id=$1`,
    [agentId]
  );
  return r.rows.map(row => ({ id: row.id, agentId: row.agent_id, ...row.data }));
}
async function saveAthlete(id, data) {
  // AGENT SIDE ONLY — do not use in university routes
  const { agentId, ...rest } = data;
  await pool.query(`
    INSERT INTO athletes (id, agent_id, data, updated_at)
    VALUES ($1,$2,$3,NOW())
    ON CONFLICT (id) DO UPDATE SET
      agent_id=EXCLUDED.agent_id, data=EXCLUDED.data, updated_at=NOW()
  `, [id, agentId, rest]);
  return getAthlete(id);
}
async function deleteAthlete(id) {
  // AGENT SIDE ONLY — do not use in university routes
  await pool.query('DELETE FROM athletes WHERE id=$1', [id]);
}

// DEALS
// DEAL COMPS — anonymized closed deals that improve NILViewVal accuracy
async function saveComp(dealData, athleteData) {
  try {
    await pool.query(`
      INSERT INTO deal_comps (sport, school_tier, followers, engagement, deal_type, deal_value, year_in_school)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [
      athleteData.sport || 'unknown',
      athleteData.schoolTier || 'mid-mid',
      (parseInt(athleteData.instagram) || 0) + (parseInt(athleteData.tiktok) || 0),
      parseFloat(athleteData.engagement) || 3.0,
      dealData.type || 'ig-post',
      parseInt(dealData.value) || 0,
      athleteData.year || 'unknown'
    ]);
  } catch(e) {
    console.error('saveComp error:', e.message);
  }
}

async function getComps(sport, schoolTier, limit = 20) {
  try {
    const r = await pool.query(`
      SELECT * FROM deal_comps
      WHERE deal_value > 0
        AND ($1::text IS NULL OR sport = $1)
        AND ($2::text IS NULL OR school_tier = $2)
      ORDER BY created_at DESC
      LIMIT $3
    `, [sport || null, schoolTier || null, limit]);
    return r.rows;
  } catch(e) {
    return [];
  }
}

async function getCompStats(sport, schoolTier) {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) as count,
        AVG(deal_value) as avg_value,
        MIN(deal_value) as min_value,
        MAX(deal_value) as max_value,
        AVG(engagement) as avg_engagement,
        AVG(followers) as avg_followers
      FROM deal_comps
      WHERE deal_value > 0
        AND ($1::text IS NULL OR sport = $1)
        AND ($2::text IS NULL OR school_tier = $2)
    `, [sport || null, schoolTier || null]);
    return r.rows[0];
  } catch(e) {
    return null;
  }
}

async function getDeal(id) {
  const r = await pool.query('SELECT * FROM deals WHERE id=$1', [id]);
  if (!r.rows[0]) return null;
  return { id: r.rows[0].id, athleteId: r.rows[0].athlete_id, agentId: r.rows[0].agent_id, ...r.rows[0].data };
}
// Attach athleteName server-side via LEFT JOIN (same source Outreach/Calendar use:
// a.data->>'name') so Pipeline/Analytics/Commission don't depend on the frontend
// roster to resolve the name. LEFT JOIN keeps deals whose athlete link is missing.
async function getDealsByAthlete(athleteId) {
  const r = await pool.query(
    `SELECT d.*, a.data->>'name' AS athlete_name
       FROM deals d LEFT JOIN athletes a ON a.id = d.athlete_id
      WHERE d.athlete_id=$1`, [athleteId]);
  return r.rows.map(row => ({
    id: row.id, athleteId: row.athlete_id, agentId: row.agent_id, ...row.data,
    athleteName: row.athlete_name || (row.data && row.data.athleteName) || null,
  }));
}
async function getDealsByAgent(agentId) {
  const r = await pool.query(
    `SELECT d.*, a.data->>'name' AS athlete_name
       FROM deals d LEFT JOIN athletes a ON a.id = d.athlete_id
      WHERE d.agent_id=$1`, [agentId]);
  return r.rows.map(row => ({
    id: row.id, athleteId: row.athlete_id, agentId: row.agent_id, ...row.data,
    athleteName: row.athlete_name || (row.data && row.data.athleteName) || null,
  }));
}
async function saveDeal(id, data) {
  const { athleteId, agentId, ...rest } = data;
  await pool.query(`
    INSERT INTO deals (id, athlete_id, agent_id, data, updated_at)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (id) DO UPDATE SET
      data=EXCLUDED.data, updated_at=NOW()
  `, [id, athleteId, agentId, rest]);
  return getDeal(id);
}
async function deleteDeal(id) {
  await pool.query('DELETE FROM deals WHERE id=$1', [id]);
}

// ── User Onboarding helpers (Parts A/C/E) ──────────────────────────────────
// Every helper is defensively wrapped: the onboarding overhaul must never block
// a user from reaching the dashboard, so a missing table or query error degrades
// to a null/no-op instead of throwing into a route handler.
const CHECKLIST_ITEMS = [
  'add_athlete', 'deal_scan', 'media_kit', 'ai_outreach',
  'contract_scan', 'rate_calc', 'log_deal', 'connect_google',
];

async function getOnboarding(userId, { backfill = false } = {}) {
  if (!userId) return null;
  try {
    let r = await pool.query('SELECT * FROM user_onboarding WHERE user_id=$1', [userId]);
    let created = false;
    if (!r.rows[0]) {
      await pool.query(
        'INSERT INTO user_onboarding (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
        [userId]);
      r = await pool.query('SELECT * FROM user_onboarding WHERE user_id=$1', [userId]);
      created = true;
    }
    const row = r.rows[0] || null;
    // Backfill checklist from historical activity the first time we ever see this
    // user (row just created) or when explicitly asked and not yet backfilled.
    if (row && backfill && (created || !row.checklist_backfilled)) {
      await backfillChecklist(userId);
      await pool.query('UPDATE user_onboarding SET checklist_backfilled=TRUE WHERE user_id=$1', [userId]).catch(() => {});
      const r2 = await pool.query('SELECT * FROM user_onboarding WHERE user_id=$1', [userId]);
      return r2.rows[0] || row;
    }
    return row;
  } catch (e) {
    console.error('getOnboarding error:', e.message);
    return null;
  }
}

async function logWizardEvent(userId, step, action) {
  // action: 'entered' | 'completed' | 'skipped'
  if (!userId) return;
  try {
    const evt = JSON.stringify({ step, action, at: new Date().toISOString() });
    await pool.query(
      `INSERT INTO user_onboarding (user_id, wizard_step, wizard_step_events)
         VALUES ($1, $2, jsonb_build_array($3::jsonb))
       ON CONFLICT (user_id) DO UPDATE SET
         wizard_step = $2,
         wizard_step_events = COALESCE(user_onboarding.wizard_step_events, '[]'::jsonb) || $3::jsonb,
         updated_at = NOW()`,
      [userId, step, evt]);
  } catch (e) { console.error('logWizardEvent error:', e.message); }
}

async function completeWizard(userId) {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO user_onboarding (user_id, wizard_completed_at, wizard_step)
         VALUES ($1, NOW(), 5)
       ON CONFLICT (user_id) DO UPDATE SET
         wizard_completed_at = COALESCE(user_onboarding.wizard_completed_at, NOW()),
         updated_at = NOW()`,
      [userId]);
  } catch (e) { console.error('completeWizard error:', e.message); }
}

async function markChecklistItem(userId, item) {
  if (!userId || !CHECKLIST_ITEMS.includes(item)) return;
  try {
    // Preserve the first-completion timestamp: only write when the key is absent.
    await pool.query(
      `INSERT INTO user_onboarding (user_id, checklist)
         VALUES ($1, jsonb_build_object($2::text, to_jsonb(NOW()::text)))
       ON CONFLICT (user_id) DO UPDATE SET
         checklist = user_onboarding.checklist || jsonb_build_object($2::text, to_jsonb(NOW()::text)),
         updated_at = NOW()
       WHERE NOT (user_onboarding.checklist ? $2)`,
      [userId, item]);
  } catch (e) { console.error('markChecklistItem error:', e.message); }
}

async function dismissChecklist(userId, dismissed) {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO user_onboarding (user_id, checklist_dismissed) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET checklist_dismissed = $2, updated_at = NOW()`,
      [userId, !!dismissed]);
  } catch (e) { console.error('dismissChecklist error:', e.message); }
}

async function markTooltipSeen(userId, tool) {
  if (!userId || !tool) return;
  try {
    await pool.query(
      `INSERT INTO user_onboarding (user_id, tooltips_seen)
         VALUES ($1, jsonb_build_object($2::text, to_jsonb(NOW()::text)))
       ON CONFLICT (user_id) DO UPDATE SET
         tooltips_seen = COALESCE(user_onboarding.tooltips_seen, '{}'::jsonb) || jsonb_build_object($2::text, to_jsonb(NOW()::text)),
         updated_at = NOW()`,
      [userId, String(tool)]);
  } catch (e) { console.error('markTooltipSeen error:', e.message); }
}

// Detect prior activity so long-time users don't see a mostly empty checklist.
// Only checks things that are cheap and unambiguous to detect. rate_calc has no
// persisted artifact, so it is intentionally not backfilled.
async function backfillChecklist(userId) {
  if (!userId) return;
  const found = new Set();
  const safe = async (sql) => {
    try { const r = await pool.query(sql, [userId]); return r.rows.length > 0; }
    catch { return false; }
  };
  try {
    if (await safe(`SELECT 1 FROM athletes WHERE agent_id=$1 LIMIT 1`)) found.add('add_athlete');
    if (await safe(`SELECT 1 FROM deals WHERE agent_id=$1 LIMIT 1`)) found.add('log_deal');
    if (await safe(`SELECT 1 FROM athletes WHERE agent_id=$1 AND deal_scan_cache IS NOT NULL AND deal_scan_cache <> '{}'::jsonb LIMIT 1`)) found.add('deal_scan');
    if (await safe(`SELECT 1 FROM media_kits mk JOIN athletes a ON a.id = mk.athlete_id WHERE a.agent_id=$1 LIMIT 1`)) found.add('media_kit');
    if (await safe(`SELECT 1 FROM outreach_logs WHERE agent_id=$1 AND status='sent' LIMIT 1`)) found.add('ai_outreach');
    if (await safe(`SELECT 1 FROM athlete_outreach WHERE agent_id=$1 LIMIT 1`)) found.add('ai_outreach');
    if (await safe(`SELECT 1 FROM athlete_contracts WHERE agent_id=$1 LIMIT 1`)) found.add('contract_scan');
    if (await safe(`SELECT 1 FROM email_accounts WHERE user_id=$1 LIMIT 1`)) found.add('connect_google');
    if (await safe(`SELECT 1 FROM users WHERE id=$1 AND gcal_refresh_token IS NOT NULL LIMIT 1`)) found.add('connect_google');
    for (const item of found) await markChecklistItem(userId, item);
  } catch (e) { console.error('backfillChecklist error:', e.message); }
}

// ── Deal Scan market cache helpers ──────────────────────────────────────────
// The pool of web-searched local businesses per market. Keyed by market+lane
// ONLY (cache_key is the table's PRIMARY KEY, with no agent or user column), so
// the pool is GLOBAL and SHARED: the first agent to scan a market builds it, and
// every other agent scanning any athlete in that same market rides the same pool
// with ZERO new web searches until it expires. Local businesses barely change
// month to month, so the window is long (30 days). The per-athlete rotation
// (shown-set) lives separately on athletes.deal_scan_cache, so a shared pool
// never collides with per-athlete freshness.
// Both are defensively wrapped: a cache failure must degrade to a live search,
// never break a scan.
const MARKET_CACHE_TTL_DAYS = 30;
async function getMarketCache(cacheKey, ttlDays = MARKET_CACHE_TTL_DAYS) {
  if (!cacheKey) return null;
  try {
    const r = await pool.query(
      `SELECT candidates, fetched_at FROM deal_scan_market_cache
        WHERE cache_key = $1 AND fetched_at > NOW() - ($2 || ' days')::interval`,
      [cacheKey, String(ttlDays)]);
    const row = r.rows[0];
    const candidates = row && row.candidates;
    if (!row || !Array.isArray(candidates) || candidates.length === 0) {
      scanMeter.bumpMiss();
      console.log(`[cache] READ key=market:${cacheKey} -> MISS`);
      return null;
    }
    const ageD = row.fetched_at ? ((Date.now() - new Date(row.fetched_at).getTime()) / 8.64e7).toFixed(1) : '?';
    scanMeter.bumpHit();
    console.log(`[cache] READ key=market:${cacheKey} -> HIT age=${ageD}d (0 web searches)`);
    return { candidates, fetchedAt: row.fetched_at };
  } catch (e) {
    scanMeter.bumpMiss();
    console.warn(`[cache] READ key=market:${cacheKey} -> MISS (error ${e.message})`);
    return null;
  }
}

async function setMarketCache(cacheKey, candidates) {
  if (!cacheKey || !Array.isArray(candidates) || candidates.length === 0) return false;
  try {
    await pool.query(
      `INSERT INTO deal_scan_market_cache (cache_key, candidates, fetched_at)
         VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (cache_key) DO UPDATE SET candidates = $2::jsonb, fetched_at = NOW()`,
      [cacheKey, JSON.stringify(candidates)]);
    // Loud on purpose: a silent write failure is how "cache never hits" hides.
    scanMeter.bumpWrite();
    console.log(`[cache] WRITE key=market:${cacheKey} -> ok (${candidates.length} candidates)`);
    return true;
  } catch (e) {
    scanMeter.bumpWriteFail();
    console.error(`[cache] WRITE key=market:${cacheKey} -> FAILED ${e.message}`);
    return false;
  }
}

// Aggregate wizard step drop-off for a lightweight internal analytics view.
async function getOnboardingAnalytics() {
  try {
    const totals = await pool.query(`
      SELECT
        COUNT(*)::int AS total_users,
        COUNT(wizard_completed_at)::int AS completed,
        COUNT(*) FILTER (WHERE wizard_completed_at IS NULL AND wizard_step > 0)::int AS in_progress
      FROM user_onboarding`);
    // Per-step entered / completed / skipped counts from the event log.
    const steps = await pool.query(`
      SELECT
        (e->>'step')::int AS step,
        COUNT(*) FILTER (WHERE e->>'action'='entered')::int   AS entered,
        COUNT(*) FILTER (WHERE e->>'action'='completed')::int AS completed,
        COUNT(*) FILTER (WHERE e->>'action'='skipped')::int   AS skipped
      FROM user_onboarding, jsonb_array_elements(wizard_step_events) AS e
      GROUP BY (e->>'step')::int
      ORDER BY step`);
    return { totals: totals.rows[0] || {}, steps: steps.rows };
  } catch (e) {
    console.error('getOnboardingAnalytics error:', e.message);
    return { totals: {}, steps: [] };
  }
}

// ── Disclosed-deal comps for a single brand (TOP NIL lane precedent) ──────────
// Most recent deal_comps rows whose brand matches `brand` (case-insensitive,
// loose contains so "Raising Cane's" hits "Raising Canes NIL"). A disclosed deal
// is precedent even when the dollar amount was never published, so deal_value is
// not required. Never throws; returns [] on any error.
async function getCompsByBrand(brand, limit = 3) {
  const b = String(brand || '').trim();
  if (!b) return [];
  try {
    const r = await pool.query(`
      SELECT brand, athlete_name, sport, position, followers, deal_type, deal_value, source, created_at
        FROM deal_comps
       WHERE brand IS NOT NULL AND brand <> ''
         AND (LOWER(brand) = LOWER($1) OR brand ILIKE $2 OR $1 ILIKE ('%' || brand || '%'))
       ORDER BY created_at DESC
       LIMIT $3
    `, [b, '%' + b + '%', limit]);
    return r.rows;
  } catch (e) {
    return [];
  }
}

// Top NIL lane, served from deal_comps ONLY (zero web searches). Returns the
// brands with disclosed deals on record, most recent first, each with up to
// `dealsPerBrand` of its deals. Empty when deal_comps holds no brand rows, which
// is the honest state today and correctly renders an empty lane.
async function getTopNilComps(brandLimit = 8, dealsPerBrand = 3) {
  try {
    const bR = await pool.query(`
      SELECT brand, COUNT(*)::int AS n, MAX(created_at) AS recent
        FROM deal_comps
       WHERE brand IS NOT NULL AND btrim(brand) <> ''
       GROUP BY brand
       ORDER BY recent DESC NULLS LAST, n DESC
       LIMIT $1`, [brandLimit]);
    const out = [];
    for (const row of bR.rows) {
      const deals = await getCompsByBrand(row.brand, dealsPerBrand);
      if (deals.length) out.push({ brand: row.brand, count: row.n, deals });
    }
    return out;
  } catch (e) {
    console.warn('getTopNilComps error:', e.message);
    return [];
  }
}

// ── Brand-evidence cache (SOCIAL + TOP NIL lanes) ─────────────────────────────
// Fresh row (refreshed within `maxAgeDays`, default 7) or null. Negative results
// (outcome NO_EVIDENCE) are cached too, so a brand with no findable program is
// not re-searched on every scan for a week.
async function getBrandEvidence(brandKey, lane, maxAgeDays = 7) {
  const key = String(brandKey || '').trim().toLowerCase();
  if (!key || !lane) return null;
  try {
    const r = await pool.query(
      `SELECT brand, website, evidence, outcome, refreshed_at
         FROM brand_evidence_cache
        WHERE brand_key = $1 AND lane = $2
          AND refreshed_at > NOW() - ($3 || ' days')::interval
        LIMIT 1`,
      [key, lane, String(maxAgeDays)]
    );
    const row = r.rows[0] || null;
    if (row) {
      const ageH = row.refreshed_at ? ((Date.now() - new Date(row.refreshed_at).getTime()) / 3.6e6).toFixed(1) : '?';
      scanMeter.bumpHit();
      console.log(`[cache] READ key=${lane}:${key} -> HIT age=${ageH}h`);
    } else {
      scanMeter.bumpMiss();
      console.log(`[cache] READ key=${lane}:${key} -> MISS`);
    }
    return row;
  } catch (e) {
    scanMeter.bumpMiss();
    console.error(`[cache] READ key=${lane}:${key} -> MISS (error ${e.message})`);
    return null;
  }
}

async function saveBrandEvidence(brandKey, lane, brand, website, evidence, outcome) {
  const key = String(brandKey || '').trim().toLowerCase();
  if (!key || !lane) return;
  try {
    await pool.query(
      `INSERT INTO brand_evidence_cache (brand_key, lane, brand, website, evidence, outcome, refreshed_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6, NOW())
       ON CONFLICT (brand_key, lane) DO UPDATE
         SET brand = EXCLUDED.brand,
             website = EXCLUDED.website,
             evidence = EXCLUDED.evidence,
             outcome = EXCLUDED.outcome,
             refreshed_at = NOW()`,
      [key, lane, brand || null, website || null, JSON.stringify(evidence || {}), outcome || null]
    );
    scanMeter.bumpWrite();
    console.log(`[cache] WRITE key=${lane}:${key} -> ok (outcome=${outcome || 'null'})`);
  } catch (e) {
    scanMeter.bumpWriteFail();
    console.error(`[cache] WRITE key=${lane}:${key} -> FAILED ${e.message}`);
  }
}

init().catch(console.error);

module.exports = {
  getUser, getUserWithPassword, getUserByEmail, getUserByEmailWithPassword, saveUser, getAllUsers,
  getUserByStripeCustomer, getReferralPartner, buildCommissionRow, recordReferralCommission, aggregateReferrals, recordReferralForInvoice,
  getAthlete, getAthletesByAgent, saveAthlete, deleteAthlete,
  getDeal, getDealsByAthlete, getDealsByAgent, saveDeal, deleteDeal,
  saveComp, getComps, getCompStats, getCompsByBrand,
  getBrandEvidence, saveBrandEvidence, getTopNilComps,
  getOnboarding, logWizardEvent, completeWizard, markChecklistItem,
  dismissChecklist, markTooltipSeen, backfillChecklist, getOnboardingAnalytics,
  CHECKLIST_ITEMS,
  getMarketCache, setMarketCache, MARKET_CACHE_TTL_DAYS,
  pool
};
