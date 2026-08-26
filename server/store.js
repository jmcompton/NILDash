// server/store.js — PostgreSQL persistent storage
const { Pool } = require('pg');
// When THIS process started. Used to tell a job left running by a previous
// process from one this process is running right now.
const BOOT_AT = new Date();
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;
    -- First-run onboarding assistant: false until the agent finishes (or skips
    -- past) the guided first-client flow. Drives the assistant's auto-open.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE;
    -- Admin-only comp flag: full access with no card and no charge. Never set by
    -- signup; only an admin (or the one-time comp seed) can turn this on.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS comped BOOLEAN DEFAULT FALSE;
    -- Weekly digest opt-out. Stored per user and honored at send time. The token is
    -- what the unsubscribe link carries, so a link cannot be forged from an email
    -- address alone, and it is generated lazily on first send.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_unsubscribed BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_unsub_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_unsubscribed_at TIMESTAMPTZ;
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
    // Athlete comp, mirroring users.comped: free access, no card, set by hand.
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS comped BOOLEAN DEFAULT FALSE`,
    // Stamped the first time an athlete is granted access while BILLING_ENABLED is
    // off. subscription_status='free' already records that, but status is a column
    // Stripe writes to -- one webhook moves it to 'active' or 'inactive' and the
    // fact that this athlete predates billing is gone. This is write-once and
    // Stripe never touches it, so it survives to answer "was this account free
    // before we started charging" after the switch is flipped.
    `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS free_before_billing TIMESTAMPTZ`,
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

  // ── Social lane brand index ────────────────────────────────────────────────
  // Curated DTC/creator brands that run public athlete or creator ambassador/
  // affiliate programs. The Social Deal Scan lane serves directly from this table
  // (no web search, no AI). sports is lowercase; ARRAY['all'] means sport-agnostic.
  // tier_min/tier_max bound combined IG+TikTok follower reach.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_brands (
      id SERIAL PRIMARY KEY,
      brand TEXT NOT NULL,
      category TEXT NOT NULL,
      website TEXT,
      sports TEXT[] NOT NULL,
      tier_min INT NOT NULL,
      tier_max INT NOT NULL,
      deal_structure TEXT NOT NULL,
      est_low INT,
      est_high INT,
      cadence_note TEXT,
      proof_url TEXT NOT NULL,
      proof_date DATE NOT NULL,
      proof_snippet TEXT,
      tier_stated BOOLEAN DEFAULT FALSE,
      offer_summary TEXT,
      brand_size TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('[init] social_brands table ready'))
    .catch(e => console.error('[init] social_brands:', e.message));
  // Evidence captured from the verified program page + whether the page actually
  // states a follower threshold. ALTER for tables created before these columns.
  await pool.query(`ALTER TABLE social_brands ADD COLUMN IF NOT EXISTS proof_snippet TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE social_brands ADD COLUMN IF NOT EXISTS tier_stated BOOLEAN DEFAULT FALSE`).catch(() => {});
  // One-line AI summary of the verified program page, written once at insert time.
  // Replaces regex snippet extraction for display; proof_snippet is kept for now.
  await pool.query(`ALTER TABLE social_brands ADD COLUMN IF NOT EXISTS offer_summary TEXT`).catch(() => {});
  // Brand size ('small' | 'national' | NULL) from the same summarize call. Small
  // DTC brands sort to the top of the lane; national brands stay below the fold.
  await pool.query(`ALTER TABLE social_brands ADD COLUMN IF NOT EXISTS brand_size TEXT`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_social_brands_sports ON social_brands USING GIN (sports)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_social_brands_tier ON social_brands (tier_min, tier_max)`).catch(() => {});
  // Unique on brand so the verify-seed endpoint can upsert with ON CONFLICT (brand).
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_social_brands_brand ON social_brands (brand)`).catch(() => {});

  // Proof URLs the nightly discovery job already tried and that FAILED the verify
  // gate (non-200 or no program language). Keyed by proof_url so the job never
  // re-checks a dead URL and never re-pays for it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_brand_rejects (
      proof_url TEXT PRIMARY KEY,
      brand TEXT,
      reason TEXT,
      status_code INT,
      last_tried TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('[init] social_brand_rejects table ready'))
    .catch(e => console.error('[init] social_brand_rejects:', e.message));

  // Per-athlete rotation log: which social brands have been shown to which
  // athlete, and when. getSocialBrands excludes a brand shown to THIS athlete in
  // the last 30 days so an agent sees fresh brands across scans. Per athlete, not
  // global -- the same brand can still surface for a different client.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_brand_shown (
      athlete_id TEXT NOT NULL,
      brand_id INT NOT NULL,
      shown_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (athlete_id, brand_id)
    )
  `).then(() => console.log('[init] social_brand_shown table ready'))
    .catch(e => console.error('[init] social_brand_shown:', e.message));

  // ── Media kits ────────────────────────────────────────────────────────────
  // CREATED HERE NOW. The table has been in production since before this file
  // owned the schema, so the ALTERs below assumed it and a FRESH database never
  // got one -- every media-kit route 500s on a new install, and did.
  //
  // UNIQUE on athlete_id, because the product promise is ONE excellent kit per
  // athlete that is always current, not a pile of stale ones. The Analyst's
  // upsert depends on that constraint.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_kits (
      id SERIAL PRIMARY KEY,
      athlete_id TEXT NOT NULL,
      instagram_handle TEXT,
      instagram_followers INT,
      instagram_engagement TEXT,
      tiktok_handle TEXT,
      tiktok_followers INT,
      bio TEXT,
      primary_color TEXT,
      secondary_color TEXT,
      slug TEXT,
      twitter_handle TEXT,
      twitter_followers INT,
      headshot_url TEXT,
      action_shot_data TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`).then(() => console.log('[init] media_kits table ready'))
    .catch((e) => console.error('[init] media_kits:', e.message));
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_media_kits_athlete
                      ON media_kits (athlete_id)`).catch((e) =>
    console.error('[init] media_kits unique athlete:', e.message));
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_media_kits_slug
                      ON media_kits (slug) WHERE slug IS NOT NULL`).catch(() => {});

  // What the kit looked like WHEN IT WAS BUILT, so the Analyst can tell that the
  // athlete's year, position or school has moved on since. Without these the
  // only staleness signal is follower drift, and a kit that still says
  // "sophomore" in October reads as carelessness to a business owner.
  // The PHOTO is athlete-uploaded and lives on headshot_url as a data URL, so a
  // hash is stored rather than the image: comparing multi-megabyte base64 on
  // every athlete every night to answer "did the photo change" is not a thing
  // to do to a database.
  await pool.query(`ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS photo_hash_at_build TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS year_at_build TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS position_at_build TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS school_at_build TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS built_by TEXT`).catch(() => {});

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

  // ── Brand engagement ledger (per athlete) ─────────────────────────────────
  // The source of truth for "has this athlete already been shown / already
  // pitched this brand" in Deal Scan, keyed by a stable brand_key (place_id for
  // local, root domain otherwise, see ai.resolveBrandKey), NOT the display name.
  // Drives scan selection so refresh surfaces new brands and contacted brands
  // never come back. state: shown | contacted | responded | closed | dead.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brand_engagement (
      id SERIAL PRIMARY KEY,
      agent_id TEXT,
      athlete_id TEXT NOT NULL,
      brand_key TEXT NOT NULL,
      brand_name TEXT,
      lane TEXT,
      state TEXT NOT NULL DEFAULT 'shown',
      shown_count INT DEFAULT 0,
      first_shown_at TIMESTAMPTZ,
      last_shown_at TIMESTAMPTZ,
      contacted_at TIMESTAMPTZ,
      contacted_via TEXT,
      outcome TEXT,
      outcome_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (athlete_id, brand_key)
    )
  `).then(() => console.log('[init] brand_engagement table ready'))
    .catch(e => console.error('[init] brand_engagement:', e.message));
  // ── Morning outreach queue ────────────────────────────────────────────────
  // Three slots an athlete, filled by the nightly job and emptied by the agent.
  // Sent and skipped rows STAY: they are the outcome record, and they are what
  // makes "waiting on you" possible. Only a 'queued' row holds its slot.
  pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_queue (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      athlete_id TEXT NOT NULL,
      slot INT NOT NULL,
      brand_key TEXT NOT NULL,
      brand_name TEXT,
      why TEXT,
      contact_name TEXT,
      contact_title TEXT,
      source_note TEXT,
      affiliation_scope TEXT,
      instagram TEXT,
      instagram_scope TEXT,
      phone TEXT,
      phone_ask_for TEXT,
      dm_text TEXT,
      channel TEXT NOT NULL DEFAULT 'call',
      state TEXT NOT NULL DEFAULT 'queued',
      sent_at TIMESTAMPTZ,
      sent_via TEXT,
      outcome TEXT,
      outcome_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(async () => {
    // THE DOUBLE-FILL GUARD, at the database rather than in application logic.
    // Two job runs, or two Railway instances, racing the same athlete get a
    // rejection instead of six cards in three slots.
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_queue_open
      ON outreach_queue (athlete_id, slot) WHERE state = 'queued'`).catch(() => {});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_outreach_queue_agent
      ON outreach_queue (agent_id, state)`).catch(() => {});
    console.log('[init] outreach_queue table ready');
  }).catch(e => console.error('[init] outreach_queue:', e.message));

  // One claim per agent per night. A slot freed at 10am must wait for the next
  // run rather than refilling on the spot, so an agent skipping three cards in
  // one sitting triggers zero lookups.
  pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_queue_runs (
      agent_id TEXT NOT NULL,
      run_date DATE NOT NULL,
      filled INT DEFAULT 0,
      spent_usd NUMERIC(10,4) DEFAULT 0,
      note TEXT,
      -- Per-athlete outcome for this run: [{athleteId, athleteName, filled, open,
      -- note}]. Without this, an athlete the job found zero candidates for left
      -- no row anywhere -- not in outreach_queue, not explained here -- so the
      -- page could not say why that athlete's section is empty. It could only
      -- be silent, which reads exactly like the page not having loaded.
      details JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (agent_id, run_date)
    )
  `).then(async () => {
    await pool.query(`ALTER TABLE outreach_queue_runs ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '[]'::jsonb`).catch(() => {});
    // WHEN THE RUN STOPPED. created_at is the claim, taken before the first
    // lookup, so on its own it cannot tell a finished night from one still
    // writing -- filled defaults to 0 and details to [], which is exactly what
    // an in-flight run looks like too. The daily email fires on a clock and was
    // reporting whatever existed at 7am as though the night were over; the shift
    // window also ran 12 hours past the claim and swept up the on-demand fills
    // the agent's own page load triggers at midday. Both need an end.
    const added = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'outreach_queue_runs' AND column_name = 'finished_at'`).catch(() => null);
    await pool.query(`ALTER TABLE outreach_queue_runs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`).catch(() => {});
    // BACKFILL, ONCE. Every run that already existed when this column was added
    // is finished by definition -- only the new code stamps an end. Without this
    // the morning after the deploy, every agent's report would read last night's
    // row as still in flight and hold the email back for hours before sending it
    // with a caveat that was never true.
    if (!(added && added.rowCount)) {
      const b = await pool.query(
        `UPDATE outreach_queue_runs SET finished_at = created_at WHERE finished_at IS NULL`)
        .catch(() => ({ rowCount: 0 }));
      if (b.rowCount) console.log(`[init] backfilled finished_at on ${b.rowCount} outreach_queue_runs row(s)`);
    }
    console.log('[init] outreach_queue_runs table ready');
  }).catch(e => console.error('[init] outreach_queue_runs:', e.message));

  // ── Weekly digest sends ───────────────────────────────────────────────────
  // The double-send guard. Recurring work in this app runs on in-process
  // setInterval timers, so a restart or a second Railway instance can fire the same
  // week twice. UNIQUE (agent_id, week_start) makes that a database rejection
  // rather than something application logic has to get right. The row is written
  // BEFORE the send, so a crash mid-send fails closed: nobody gets emailed twice.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS digest_sends (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      week_start DATE NOT NULL,
      email TEXT,
      subject TEXT,
      status TEXT NOT NULL DEFAULT 'claimed',
      provider_id TEXT,
      error TEXT,
      new_matches INT DEFAULT 0,
      awaiting_reply INT DEFAULT 0,
      going_cold INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      UNIQUE (agent_id, week_start)
    )
  `).then(() => console.log('[init] digest_sends table ready'))
    .catch(e => console.error('[init] digest_sends:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_digest_sends_week ON digest_sends (week_start)`).catch(() => {});

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_brand_engagement_athlete_state ON brand_engagement (athlete_id, state)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_brand_engagement_agent_key ON brand_engagement (agent_id, brand_key)`).catch(() => {});
  // ── Program Contact Map ───────────────────────────────────────────────────
  // Who holds power at each FBS program. A SHARED asset: built once by a job and
  // served to every agent, never run live per query. One row per (school, role,
  // name), so a genuine disagreement between sources is TWO rows both labeled
  // 'conflicting' rather than one silently chosen winner.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS program_staff (
      id SERIAL PRIMARY KEY,
      school TEXT NOT NULL,
      -- Part of the uniqueness key, so it is declared here rather than only added
      -- by ALTER below: a fresh database would fail to create the table if the
      -- UNIQUE clause named a column the column list did not.
      sport TEXT NOT NULL DEFAULT 'football',
      role TEXT NOT NULL,
      role_label TEXT,
      name TEXT NOT NULL,
      title TEXT,
      email TEXT,
      email_source_url TEXT,
      phone TEXT,
      linkedin_url TEXT,
      source_url TEXT,
      source_tier TEXT,
      confidence TEXT,
      sources JSONB DEFAULT '[]'::jsonb,
      verified_on DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (school, sport, role, name)
    )
  `).then(() => console.log('[init] program_staff table ready'))
    .catch(e => console.error('[init] program_staff:', e.message));
  // Recency + lifecycle columns. status 'current' vs 'previous' is what keeps a
  // predecessor stored (with their date) instead of served as the incumbent.
  await pool.query(`ALTER TABLE program_staff ADD COLUMN IF NOT EXISTS source_date DATE`).catch(() => {});
  await pool.query(`ALTER TABLE program_staff ADD COLUMN IF NOT EXISTS age_months NUMERIC`).catch(() => {});
  await pool.query(`ALTER TABLE program_staff ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'current'`).catch(() => {});
  await pool.query(`ALTER TABLE program_staff ADD COLUMN IF NOT EXISTS superseded_note TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE program_staff ADD COLUMN IF NOT EXISTS reach_via TEXT`).catch(() => {});
  // Which sport the SOURCE actually indicated. An athletics directory covers every
  // sport, so a football map has to record this or a track GM looks like a Tier A hit.
  await pool.query(`ALTER TABLE program_staff ADD COLUMN IF NOT EXISTS sport TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE program_staff ADD COLUMN IF NOT EXISTS source_tier_note TEXT`).catch(() => {});
  // The table now holds the FULL football staff, not five roles. role='staff' means
  // an untagged staff member; role_rank orders the people who share a tagged role,
  // and is_key_contact marks the most senior of them. The five roles are a view over
  // this list rather than a filter that discards everyone else.
  await pool.query(`ALTER TABLE program_staff ADD COLUMN IF NOT EXISTS role_rank INT`).catch(() => {});
  await pool.query(`ALTER TABLE program_staff ADD COLUMN IF NOT EXISTS is_key_contact BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_program_staff_key ON program_staff (school, is_key_contact)`).catch(() => {});
  // The section heading this person was listed under on the source page. On a
  // department-wide directory ("Football Support Staff" vs "Sports Medicine") this is
  // the evidence for why the row was kept, so it is auditable rather than implicit.
  await pool.query(`ALTER TABLE program_staff ADD COLUMN IF NOT EXISTS page_section TEXT`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_program_staff_name ON program_staff (school, lower(name))`).catch(() => {});
  // Per-school SOURCE CONFIG. The football staff page URL is discovered ONCE via
  // search and then persisted here; it is never searched for again. This is what
  // makes the map deterministic: the same URL is fetched every run, so the same page
  // yields the same records instead of a different search result each time.
  // last_staff + last_hash back the weekly re-fetch diff, which is the staff-change
  // alert feature.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS program_source (
      school TEXT,
      sport TEXT NOT NULL DEFAULT 'football',
      staff_url TEXT,
      staff_url_discovered_via TEXT,
      athletics_contact_url TEXT,
      last_fetched_at TIMESTAMPTZ,
      last_hash TEXT,
      last_staff JSONB DEFAULT '[]'::jsonb,
      last_staff_count INT DEFAULT 0,
      parse_via TEXT,
      url_locked BOOLEAN DEFAULT FALSE,
      verified_on DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (school, sport)
    )
  `).then(() => console.log('[init] program_source table ready'))
    .catch(e => console.error('[init] program_source:', e.message));
  await pool.query(`ALTER TABLE program_source ADD COLUMN IF NOT EXISTS url_locked BOOLEAN DEFAULT FALSE`).catch(() => {});

  // Program-level reach info: the football office line and any published recruiting
  // or collective address. This is what makes the map a call list rather than a
  // name list, since schools rarely publish individual staff emails.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS program_contact (
      school TEXT,
      sport TEXT NOT NULL DEFAULT 'football',
      office_phone TEXT,
      office_phone_source_url TEXT,
      recruiting_email TEXT,
      recruiting_email_source_url TEXT,
      collective_email TEXT,
      collective_email_source_url TEXT,
      collective_name TEXT,
      verified_on DATE,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (school, sport)
    )
  `).then(() => console.log('[init] program_contact table ready'))
    .catch(e => console.error('[init] program_contact:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_program_staff_school ON program_staff (school)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_program_staff_school_role ON program_staff (school, role)`).catch(() => {});

  // Sport-aware schema for the program map. Idempotent and a no-op once applied.
  // Run here as well as from the CLI so deploy order cannot matter: a container
  // that boots before the migration is run migrates itself rather than serving
  // traffic against columns the code no longer names. The CLI remains the way to
  // rehearse it, see the counts, and roll it back.
  await require('./services/programSportMigration').ensureSchema(pool).catch((e) => {
    console.error('[init] programSport migration:', e.message);
  });

  // How the row entered the ledger: 'scan' (surfaced by Deal Scan) or 'manual'
  // (the agent added the business by name via Add a Business). Additive and
  // nullable, so existing rows are untouched and read as scan-sourced.
  await pool.query(`ALTER TABLE brand_engagement ADD COLUMN IF NOT EXISTS source TEXT`).catch(() => {});

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

  // One-time: strip any stale 'social' key from athletes.deal_scan_cache. The
  // Social lane is served live from social_brands (getSocialBrands) and must
  // never be cached; older rows persisted a social key from the retired AI
  // brand-lane, which loadDealScanCache would otherwise replay. Guarded by
  // app_flags so it runs exactly once.
  try {
    const flag = await pool.query(`SELECT 1 FROM app_flags WHERE key = 'social_cache_strip_v1'`);
    if (!flag.rows.length) {
      const upd = await pool.query(`UPDATE athletes SET deal_scan_cache = deal_scan_cache - 'social' WHERE deal_scan_cache ? 'social'`);
      await pool.query(`INSERT INTO app_flags (key) VALUES ('social_cache_strip_v1') ON CONFLICT DO NOTHING`).catch(() => {});
      console.log(`[init] social cache strip (v1): ${upd.rowCount || 0} athlete row(s) updated`);
    }
  } catch (e) {
    console.error('[init] social cache strip skipped:', e.message);
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
  // ── Pre-warmed drafts ──────────────────────────────────────────────────────
  // brand_key is the SAME canonical identity the engagement ledger uses
  // (ai.resolveBrandKey): place_id for local, root domain otherwise, so the same
  // chain in three towns is three keys and a name variant is not a fourth.
  // source records where a draft came from ('prewarm' or null for the click path),
  // which is the only way to tell later whether pre-warming is actually the thing
  // the agent sent.
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS brand_key TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS source TEXT`).catch(() => {});
  // PARTIAL, on status='draft' only. One live draft per athlete+business is the
  // cache rule; a SENT outreach must never block a fresh draft for the same brand,
  // which a full unique index would do the moment someone follows up.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_logs_draft_key
       ON outreach_logs(athlete_id, brand_key) WHERE status = 'draft' AND brand_key IS NOT NULL`
  ).catch((e) => console.error('[init] outreach draft key index:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outreach_logs_brand_key ON outreach_logs(brand_key)`).catch(() => {});

  // ── Reply capture: the agent's own public reply address ───────────────────
  // A cold pitch that replies to r8b3e030aceadf56c@ looks like a machine wrote
  // it. Each agent gets johnmark@mynildash.com instead, derived from their name.
  //
  // PERSISTED AND UNIQUE, and once assigned it must NEVER change: it is printed
  // on every email already sent, so a changed local part orphans every reply
  // still in flight. The unique index is what makes the collision ladder in
  // replyCapture.assignReplyLocalPart safe under concurrent signups.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reply_local_part TEXT`).catch(() => {});
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_users_reply_local_part
       ON users (reply_local_part) WHERE reply_local_part IS NOT NULL`
  ).catch((e) => console.error('[init] users reply_local_part index:', e.message));

  // WHO WE ACTUALLY EMAILED. Without a token in the address, the only way to tie
  // an inbound reply back to an outreach is the sender -- so the recipient has
  // to be recorded at send time. It never was: the send route took toEmail and
  // threw it away after handing it to the provider.
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS sent_to_email TEXT`).catch(() => {});
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_outreach_logs_sent_to ON outreach_logs (agent_id, sent_to_email)`
  ).catch(() => {});

  // THE RFC822 MESSAGE-ID WE SET ON THE OUTGOING MAIL. Distinct from
  // email_message_id, which holds the PROVIDER's own id (a Gmail API id, or
  // null from Graph) and is not what a replying client echoes back. A reply
  // echoes the RFC822 Message-ID in In-Reply-To / References, so this is the
  // only field that can tie a reply to one exact outreach now that the address
  // no longer carries a token.
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS message_id TEXT`).catch(() => {});
  // THE ADDRESS THAT ACTUALLY WENT ON THE WIRE, recorded per send. Which
  // Reply-To a given email carried is otherwise unknowable after the fact --
  // it has to be read out of the sent message, which nobody has. With this,
  // "is the running build still writing token addresses" is a row in a table
  // rather than an argument, and it is answered per message rather than per
  // guess about which commit is deployed.
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS reply_to TEXT`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outreach_logs_message_id ON outreach_logs (message_id)`).catch(() => {});

  // ── Every inbound webhook payload, matched or not ─────────────────────────
  // AN UNMATCHED REPLY IS NOT NOISE, IT IS A LOST CUSTOMER. The webhook used to
  // return early and forget anything it could not attribute, so a real reply
  // that failed to match left no trace anywhere. Every accepted inbound now
  // lands here first, and matching decorates the row afterwards.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inbound_messages (
      id SERIAL PRIMARY KEY,
      received_at TIMESTAMPTZ DEFAULT NOW(),
      email_id TEXT,
      from_addr TEXT,
      to_addr TEXT,
      subject TEXT,
      message_id TEXT,
      in_reply_to TEXT,
      matched_outreach_id TEXT,
      match_method TEXT,
      classification TEXT,
      note TEXT,
      payload JSONB
    )
  `).then(() => console.log('[init] inbound_messages table ready'))
    .catch(e => console.error('[init] inbound_messages:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_inbound_messages_received ON inbound_messages (received_at DESC)`).catch(() => {});

  // ── Outreach queue: backoff, and the on-demand day claim ──────────────────
  // WHY BACKOFF EXISTS. slotsToFill returns every empty slot every night, so an
  // athlete whose businesses keep failing the quality bar was re-attempted
  // nightly, forever, at full price -- the single largest source of spend on
  // deals nobody would ever see. consecutive_failures counts nights that SPENT
  // money and placed nothing; a night with no candidates costs nothing and does
  // not count. At BACKOFF_NIGHTS the athlete is paused and the page says so.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_queue_athlete_state (
      athlete_id TEXT PRIMARY KEY,
      consecutive_failures INT NOT NULL DEFAULT 0,
      last_attempt_date DATE,
      paused_at TIMESTAMPTZ,
      paused_reason TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('[init] outreach_queue_athlete_state table ready'))
    .catch(e => console.error('[init] outreach_queue_athlete_state:', e.message));
  // PER ATHLETE PER DAY, not per open. An agent flipping between athletes all
  // morning must not re-trigger a paid fill every time they come back to one,
  // so the row is claimed on the first open of the day and every later open
  // that day is free by construction -- the same claim-before-spending shape
  // outreach_queue_runs uses for the nightly job.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_queue_ondemand (
      athlete_id TEXT NOT NULL,
      run_date DATE NOT NULL,
      spent_usd NUMERIC DEFAULT 0,
      filled INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (athlete_id, run_date)
    )
  `).then(() => console.log('[init] outreach_queue_ondemand table ready'))
    .catch(e => console.error('[init] outreach_queue_ondemand:', e.message));

  // ── Site-email backfill jobs ──────────────────────────────────────────────
  // PROGRESS LIVES IN THE DATABASE, NOT IN A MODULE VARIABLE. A run over
  // hundreds of sites takes many minutes; if the process restarts partway --
  // a deploy, an OOM, an unhandled rejection -- in-memory counters vanish and
  // the page has nothing to show, which is indistinguishable from "never
  // started". A row survives the restart and says exactly how far it got.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_email_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'running',
      total INT DEFAULT 0,
      done INT DEFAULT 0,
      ok INT DEFAULT 0,
      form INT DEFAULT 0,
      none INT DEFAULT 0,
      corporate INT DEFAULT 0,
      fetch_failed INT DEFAULT 0,
      js_rendered INT DEFAULT 0,
      fetched_empty INT DEFAULT 0,
      errors INT DEFAULT 0,
      collapsed INT DEFAULT 0,
      reasons JSONB DEFAULT '{}'::jsonb,
      last_brand TEXT,
      error TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    )
  `).then(() => console.log('[init] site_email_jobs table ready'))
    .catch(e => console.error('[init] site_email_jobs:', e.message));

  // Hunter backfill job. Separate table from site_email_jobs because the tallies
  // are different in kind: this one counts CREDITS, and a run that spends them
  // and finds nothing has to be as legible as one that works.
  pool.query(`
    CREATE TABLE IF NOT EXISTS hunter_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'running',
      total INT DEFAULT 0,
      done INT DEFAULT 0,
      credits INT DEFAULT 0,       -- calls that actually reached Hunter
      with_addresses INT DEFAULT 0,
      zero_addresses INT DEFAULT 0,
      personal_found INT DEFAULT 0,
      generic_found INT DEFAULT 0,
      cached INT DEFAULT 0,        -- served from cache, no credit spent
      failed INT DEFAULT 0,
      outcomes JSONB DEFAULT '{}'::jsonb,
      last_domain TEXT,
      error TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    )
  `).then(() => console.log('[init] hunter_jobs table ready'))
    .catch(e => console.error('[init] hunter_jobs:', e.message));
  // A job left 'running' by a process that died is not running. Anything still
  // marked running at boot is stale by definition, since the only writer is
  // this process.
  // SCOPED TO JOBS OLDER THAN THIS PROCESS. init() is async and the server is
  // already listening while it runs, so an unscoped UPDATE can land AFTER a job
  // this process just started and mark a live run as interrupted.
  await pool.query(
    `UPDATE site_email_jobs SET status='interrupted', error='process restarted mid-run', finished_at=NOW()
      WHERE status='running' AND started_at < $1`, [BOOT_AT]
  ).then((r) => { if (r.rowCount) console.log(`[init] marked ${r.rowCount} interrupted site-email job(s)`); })
    .catch(() => {});
  await pool.query(
    `UPDATE hunter_jobs SET status='interrupted', error='process restarted mid-run', finished_at=NOW()
      WHERE status='running' AND started_at < $1`, [BOOT_AT]
  ).then((r) => { if (r.rowCount) console.log(`[init] marked ${r.rowCount} interrupted hunter job(s)`); })
    .catch(() => {});

  // ── Daily shift report delivery ───────────────────────────────────────────
  // The one thing an agent configures about the report: when it arrives.
  // Default 7am in their own timezone. report_tz is the browser's IANA zone,
  // captured on first load; NULL means we have not learned it yet and the
  // sender falls back to Central rather than guessing UTC (which would deliver
  // a "good morning" note at 1am).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS report_hour INT DEFAULT 7`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS report_tz TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS report_enabled BOOLEAN DEFAULT TRUE`).catch(() => {});
  // One row per agent per local day. The double-send guard: recurring work runs
  // on in-process timers, so a restart or a second instance can otherwise fire
  // the same morning's report twice.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shift_report_sends (
      agent_id TEXT NOT NULL,
      local_date DATE NOT NULL,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      items INT DEFAULT 0,
      PRIMARY KEY (agent_id, local_date)
    )
  `).then(() => console.log('[init] shift_report_sends table ready'))
    .catch(e => console.error('[init] shift_report_sends:', e.message));

  // ── Held outreach ─────────────────────────────────────────────────────────
  // A draft cleared to send is STAMPED with a release time rather than going out
  // at 3am. See services/sendWindow.js for why, and for the rule.
  // ── Why this pitch said what it said ──────────────────────────────────────
  // The angle is the reasoning that produced the message. Stored beside the
  // draft so "why did it pitch that" is answerable from the row, and so replies
  // can be attributed back to an angle rather than to a vague sense that some
  // messages work. category_key is the Google-category playbook that shaped the
  // ask; angle_key is the slug the writer chose.
  await pool.query(`ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS angle TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS angle_key TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS category_key TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS ask TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ`).catch(() => {});

  // ── Which lane produced this card, and why it outranked the rest ──────────
  // The Scout assembles ONE mixed slate per athlete per night; the lane is a
  // property of a result, not a separate run, so it is stored on the row rather
  // than inferred from which query happened to find it. program_url is how a
  // social or national brand is actually reached -- there is no owner to call --
  // and sponsor_signal/sponsor_note carry the deal-history-at-this-school boost
  // so a card can say "they have already done a deal at Auburn" instead of
  // showing the agent a rank with no reason attached.
  // ── The send ceiling, and where an agent stands against it today ─────────
  // 40 a night is a DELIVERABILITY limit, not Google's. Google allows 500 on a
  // personal account and 2,000 on Workspace, but cold outreach above roughly 50
  // a day reads as bulk sending and degrades the sender's reputation over two to
  // four weeks -- on the agent's own mailbox, the one they use for real client
  // work. Keyed by the agent's LOCAL date so the reset is their midnight and not
  // the middle of someone's afternoon.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_send_budget (
      agent_id       TEXT NOT NULL,
      local_date     DATE NOT NULL,
      sent           INT  NOT NULL DEFAULT 0,
      cap            INT  NOT NULL,
      blocked_at     TIMESTAMPTZ,
      blocked_reason TEXT,
      last_send_at   TIMESTAMPTZ,
      PRIMARY KEY (agent_id, local_date)
    )`).then(() => console.log('[init] agent_send_budget table ready'))
    .catch((e) => console.error('[init] agent_send_budget:', e.message));
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_email_cap INT`).catch(() => {});

  // ── Addresses that bounced ───────────────────────────────────────────────
  // A bounce is a fact about the ADDRESS, not about one message, so it is stored
  // per address and every send checks it. Sending again to an address that hard
  // bounced is one of the fastest ways to lose sender reputation, which is the
  // whole thing the ceiling above exists to protect.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_suppression (
      email         TEXT PRIMARY KEY,
      reason        TEXT,
      kind          TEXT,
      agent_id      TEXT,
      outreach_id   TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      hits          INT NOT NULL DEFAULT 1
    )`).then(() => console.log('[init] email_suppression table ready'))
    .catch((e) => console.error('[init] email_suppression:', e.message));

  // ── The Closer's own columns on outreach_logs ────────────────────────────
  // approved_at is the batch decision; touch_no is where in the cadence this
  // message sits; cadence_stopped_at and its reason are why a follow-up chain
  // ended, so "we stopped because they replied" is answerable from the row.
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS approved_by TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS touch_no INT DEFAULT 1`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS parent_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS cadence_stopped_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS cadence_stop_reason TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS send_error TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS send_attempts INT DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS edited_before_approval BOOLEAN DEFAULT FALSE`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outreach_logs_due
                      ON outreach_logs (scheduled_send_at)
                   WHERE status = 'approved' AND scheduled_send_at IS NOT NULL`).catch(() => {});

  // ── Auto mode, per athlete or per lane, never global ─────────────────────
  // Scope is ('athlete', <id>) or ('lane', 'local'|'social'|'national'). There
  // is deliberately no ('global', ...) scope: an agent turning this on for one
  // athlete is a different decision from turning it on for everyone, and the
  // schema should not make the second one easy.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_auto_mode (
      agent_id   TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('athlete','lane')),
      scope_id   TEXT NOT NULL,
      enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_id, scope_kind, scope_id)
    )`).then(() => console.log('[init] agent_auto_mode table ready'))
    .catch((e) => console.error('[init] agent_auto_mode:', e.message));

  // ── The compliance record ────────────────────────────────────────────────
  // THIS TABLE IS THE PRODUCT. The gate itself is a few hundred lines; the value
  // is being able to answer "why did this not send" nine months later, and to
  // hand a school or a state the same answer from the same rows.
  //
  // Nothing here is ever deleted or updated in place except to RESOLVE a row.
  // A resolved hold keeps its reason, its severity and its facts; the resolution
  // is added alongside, so the record reads as a history rather than a state.
  //
  // facts is what we knew AT THE TIME -- the Places types, the derived age, the
  // school, whether the gate failed closed. Never the date of birth itself: the
  // log records that one was on file, not what it was.
  // unchecked is what we did NOT look at, stored per row, so a hold read years
  // from now still states its own limits instead of implying it checked
  // everything.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS compliance_holds (
      id                SERIAL PRIMARY KEY,
      agent_id          TEXT,
      athlete_id        TEXT,
      outreach_log_id   TEXT,
      brand_name        TEXT,
      brand_key         TEXT,
      rule_key          TEXT NOT NULL,
      rule_label        TEXT NOT NULL,
      severity          TEXT NOT NULL CHECK (severity IN ('block','hold','note')),
      reason            TEXT NOT NULL,
      facts             JSONB DEFAULT '{}'::jsonb,
      unchecked         JSONB DEFAULT '[]'::jsonb,
      rules_version     TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at       TIMESTAMPTZ,
      resolved_by       TEXT,
      resolution        TEXT CHECK (resolution IN ('overridden','cancelled','auto-cleared')),
      resolution_reason TEXT
    )`).then(() => console.log('[init] compliance_holds table ready'))
    .catch((e) => console.error('[init] compliance_holds:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_compliance_holds_open
    ON compliance_holds (agent_id, resolved_at) WHERE resolved_at IS NULL`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_compliance_holds_log
    ON compliance_holds (outreach_log_id)`).catch(() => {});
  // ONE OPEN ROW PER RULE PER OUTREACH. releaseDue re-evaluates every tick, and
  // without this a held draft would write a fresh identical row every fifteen
  // minutes until the log was unreadable.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_holds_open
    ON compliance_holds (outreach_log_id, rule_key) WHERE resolved_at IS NULL`).catch(() => {});

  // ── State category rules ─────────────────────────────────────────────────
  // The structured table nilStateRules.js should have been. That file is a
  // REFERENCE DOCUMENT -- prose summaries of agent registration and statute
  // framing, 45 of its 51 entries hedged with "verify the current rule" -- and it
  // contains no category restrictions at all. Reading rules out of it would be
  // inventing them.
  //
  // THIS TABLE SHIPS EMPTY, ON PURPOSE. Nothing in this codebase populates it and
  // nothing should: every row needs a citation to an actual statute or state
  // association rule, entered by someone qualified to read one. A model must
  // never write here.
  //
  // Until a row exists for a (state, category), the gate holds. An empty table
  // therefore changes nothing about today's behaviour -- which is the point. It
  // can only ever make the gate MORE precise, never more permissive by default.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS state_category_rules (
      id            SERIAL PRIMARY KEY,
      state_code    TEXT NOT NULL,
      category      TEXT NOT NULL,
      -- What the rule says for each, independently. 'block' and 'hold' carry the
      -- same meaning as the gate's severities; 'allow' means the state imposes
      -- no restriction, which is a real finding and not the same as no row.
      minor_rule    TEXT NOT NULL CHECK (minor_rule IN ('block','hold','allow')),
      adult_rule    TEXT NOT NULL CHECK (adult_rule IN ('block','hold','allow')),
      -- NOT NULL, with no default. A row without a citation is an opinion, and
      -- the schema refuses to store one.
      citation      TEXT NOT NULL,
      note          TEXT,
      date_checked  DATE NOT NULL,
      confidence    TEXT NOT NULL DEFAULT 'verify' CHECK (confidence IN ('confident','verify')),
      entered_by    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (state_code, category)
    )`).then(() => console.log('[init] state_category_rules table ready'))
    .catch((e) => console.error('[init] state_category_rules:', e.message));
  // A citation of whitespace is not a citation.
  await pool.query(`ALTER TABLE state_category_rules
    ADD CONSTRAINT state_category_rules_citation_not_blank CHECK (LENGTH(TRIM(citation)) >= 8)`)
    .catch(() => {});   // already present

  // One row per market, recording the last time its radius was widened. In the
  // DATABASE and not in memory because the nightly job is a separate process
  // from the web server: an in-process guard would give each its own allowance
  // and the same market could be widened twice in a day.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_deepen_log (
      market_key TEXT PRIMARY KEY,
      last_deepened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_source TEXT,
      deepen_count INT NOT NULL DEFAULT 0
    )`).then(() => console.log('[init] market_deepen_log table ready'))
    .catch((e) => console.error('[init] market_deepen_log:', e.message));

  // Attach the athlete's media kit to every approved email, or do not. A
  // setting on the account rather than a toggle in a modal: the same answer 45
  // times a morning is a setting, and a per-send choice is only a choice the
  // first time. Off by default -- an attachment nobody asked for is a link a
  // spam filter reads before a person does.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS attach_media_kit BOOLEAN DEFAULT false`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS lane TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS program_url TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS sponsor_signal TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS sponsor_note TEXT`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outreach_queue_angle
                      ON outreach_queue (category_key, angle_key) WHERE angle_key IS NOT NULL`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS angle TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS angle_key TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS category_key TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS ask TEXT`).catch(() => {});

  // WHAT KIND of address this is. A corporate inbox on a franchise is a real
  // address and worth having, but it is not the local owner, and the greeting
  // guard and the writer both need to know which one they are looking at rather
  // than finding out from the reply.
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS email_kind TEXT`).catch(() => {});

  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS scheduled_send_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS send_timezone TEXT`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outreach_logs_scheduled
                      ON outreach_logs (scheduled_send_at) WHERE scheduled_send_at IS NOT NULL`).catch(() => {});

  // ── Reply capture (Resend Inbound) ────────────────────────────────────────
  // Set on EVERY inbound event the webhook sees for this row, including bounces
  // and auto-replies -- the diagnostic trail for "did the webhook even fire" is
  // worth keeping regardless of classification. reply_text/html/from/subject are
  // only populated for a genuine reply (never for a bounce or auto-reply), which
  // is also what markReplied gates on.
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS reply_text TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS reply_html TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS reply_from TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS reply_subject TEXT`).catch(() => {});
  // THE ACKNOWLEDGEMENT. Capture was rich -- reply_text, reply_from, replied_at,
  // last_inbound_at -- and there was no counterpart for "the agent dealt with
  // this", so a captured reply sat in NEEDS YOU and owned the report subject
  // line for as long as the row lived. The one designed exit was
  // status <> 'closed', and nothing in the codebase ever wrote that status; the
  // complete set ever written is draft, approved, sent, replied, expired.
  //
  // A SEPARATE COLUMN, NOT A STATUS. `status` encodes where a message is in the
  // send state machine; "a human has seen the answer" is a different fact about
  // the same row, and folding it into status would make 'replied' and 'handled'
  // mutually exclusive when they are not.
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS reply_handled_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS last_inbound_kind TEXT`).catch(() => {});

  // ── Assistant ──────────────────────────────────────────────────────────────
  // Session state, transcript, and pending confirmations. Deliberately its own
  // tables: the assistant writes NOTHING to athletes, deals or outreach_logs, so
  // these three are the whole of its footprint.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS assistant_sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      -- suggestion keys already offered and not taken. Filtered OUT of the next
      -- prompt, so never-nag does not depend on the model choosing to obey it.
      suppressed JSONB DEFAULT '[]'::jsonb,
      -- athleteId -> scans run this session. Deal Scan is the expensive direct
      -- action, so it has a per-session ceiling and the agent is told when they hit it.
      scans_run JSONB DEFAULT '{}'::jsonb,
      replied BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS assistant_messages (
      id SERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS assistant_pending_actions (
      token TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      action TEXT NOT NULL,
      args JSONB NOT NULL,
      args_hash TEXT NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch((e) => console.error('[init] assistant tables:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_assistant_messages_session ON assistant_messages(session_id, id)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_assistant_sessions_agent ON assistant_sessions(agent_id)`).catch(() => {});
  // Auto-open policy. Two dismissals in a row without replying turns it off for this
  // agent permanently; any reply resets the count.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS assistant_dismissals INT DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS assistant_autoopen_off BOOLEAN DEFAULT FALSE`).catch(() => {});
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

  await ensureDealOutcomes();
  await ensureFeedbackColumns();
  await ensureMarketSightings();
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
//
// SCHOOL AND BRAND ARE WRITTEN NOW. They were absent from the column list, so
// every comp created from our OWN closed deals carried NULL for both -- which
// meant our real, verified deal history could never feed the one query that
// asks "has this brand done a deal at this school" (scout.js
// schoolSponsorSignals). The table was left holding only the weekly news scrape
// in nilCompJob.js, which finds disclosed deals over $1,000 and is therefore
// mostly collectives and national brands. Our own closes are the local half of
// that picture and they were being thrown away at the insert.
//
// Still anonymized: no athlete name, no agent, no deal id. School and brand are
// market facts, and they are what makes a comp comparable.
async function saveComp(dealData, athleteData) {
  try {
    await pool.query(`
      INSERT INTO deal_comps (sport, school_tier, school, brand, followers, engagement, deal_type, deal_value, year_in_school, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      athleteData.sport || 'unknown',
      athleteData.schoolTier || 'mid-mid',
      athleteData.school || '',
      dealData.brand || '',
      (parseInt(athleteData.instagram) || 0) + (parseInt(athleteData.tiktok) || 0),
      parseFloat(athleteData.engagement) || 3.0,
      dealData.type || 'ig-post',
      parseInt(dealData.value) || 0,
      athleteData.year || 'unknown',
      'agent-close'
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
  // A CLOSE IS THE STRONGEST THING THE LEDGER CAN KNOW, and it is recorded here
  // rather than in the two route handlers that happen to close deals today --
  // this is the one function every deal write goes through, so a path added
  // later cannot forget. Idempotent: advanceBrandEngagement never moves a state
  // backwards, so re-saving a closed deal is a no-op.
  const stage = String(rest.stage || rest.status || '').toLowerCase();
  if ((stage === 'closed' || rest.status === 'closed') && athleteId && rest.brand) {
    await markBrandClosed(athleteId, {
      agentId: agentId || null, brandName: rest.brand, outcome: 'closed', source: 'deal',
    });
  }
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
// Local businesses do not turn over monthly. A 30-day TTL meant every market
// got a full web-search fan-out twelve times a year for almost no new signal.
// Web search is the per-unit cost driver in a scan, so this is the cheapest
// quality-neutral saving available.
const MARKET_CACHE_TTL_DAYS = 90;
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

// ── Brand engagement ledger ──────────────────────────────────────────────────
// All defensively wrapped: a ledger failure must degrade to "no ledger data",
// never break a scan or an action. brand_key is computed by ai.resolveBrandKey;
// this layer stores and reads rows only, it never derives keys.

// Raw ledger rows for one athlete. The route turns these into the { byKey,
// retiredNameSlugs } shape the scan selection consumes (name-slugs are built with
// ai.brandNameSlug in the route, so slug logic stays single-sourced in ai.js).
async function getBrandLedgerRows(athleteId) {
  if (!athleteId) return [];
  try {
    const r = await pool.query(
      `SELECT brand_key, brand_name, lane, state, shown_count,
              EXTRACT(EPOCH FROM last_shown_at) * 1000 AS last_shown_ms
         FROM brand_engagement WHERE athlete_id = $1`,
      [String(athleteId)]);
    return r.rows || [];
  } catch (e) {
    console.warn(`[brandLedger] load failed athlete=${athleteId}: ${e.message}`);
    return [];
  }
}

// One ledger row for an exact (athlete, brand_key). Backs the manual-add duplicate
// check: if a row exists we return the existing card and its state instead of
// creating a second row (the UNIQUE constraint would reject it anyway).
async function getBrandLedgerRow(athleteId, brandKey) {
  if (!athleteId || !brandKey) return null;
  try {
    const r = await pool.query(
      `SELECT brand_key, brand_name, lane, state, source, shown_count,
              first_shown_at, last_shown_at, contacted_at, contacted_via, outcome, outcome_at,
              GREATEST(COALESCE(contacted_at, to_timestamp(0)), COALESCE(last_shown_at, to_timestamp(0))) AS last_touched_at
         FROM brand_engagement WHERE athlete_id = $1 AND brand_key = $2 LIMIT 1`,
      [String(athleteId), brandKey]);
    return r.rows[0] || null;
  } catch (e) { console.warn(`[brandLedger] row lookup failed key=${brandKey}: ${e.message}`); return null; }
}

// Insert a manually added business as state=shown, source='manual'. Idempotent: on
// conflict it bumps the shown counters and stamps source='manual' but NEVER changes
// state, so adding a business already marked contacted does not un-retire it.
async function insertManualBrand(agentId, athleteId, lane, brandKey, brandName) {
  if (!athleteId || !brandKey) return false;
  try {
    await pool.query(
      `INSERT INTO brand_engagement
         (agent_id, athlete_id, brand_key, brand_name, lane, state, source, shown_count, first_shown_at, last_shown_at)
       VALUES ($1,$2,$3,$4,$5,'shown','manual',1,NOW(),NOW())
       ON CONFLICT (athlete_id, brand_key) DO UPDATE SET
         shown_count = brand_engagement.shown_count + 1,
         last_shown_at = NOW(),
         source = 'manual',
         brand_name = COALESCE(EXCLUDED.brand_name, brand_engagement.brand_name),
         agent_id = COALESCE(brand_engagement.agent_id, EXCLUDED.agent_id),
         updated_at = NOW()`,
      [agentId || null, String(athleteId), brandKey, brandName || null, lane || 'local']);
    return true;
  } catch (e) { console.warn(`[brandLedger] manual insert failed key=${brandKey}: ${e.message}`); return false; }
}

// Upsert one displayed brand as state=shown. Displaying NEVER retires a brand and
// never un-retires one: on conflict we only bump shown_count / last_shown_at and
// leave state untouched (a contacted row stays contacted). items are already
// filtered to non-retired-for-this-athlete brands by selection.
async function upsertShownBrands(agentId, athleteId, lane, items) {
  if (!athleteId || !Array.isArray(items) || !items.length) return 0;
  let n = 0;
  for (const it of items) {
    const bk = it && it.brandKey;
    if (!bk) continue;
    try {
      await pool.query(
        `INSERT INTO brand_engagement
           (agent_id, athlete_id, brand_key, brand_name, lane, state, shown_count, first_shown_at, last_shown_at)
         VALUES ($1,$2,$3,$4,$5,'shown',1,NOW(),NOW())
         ON CONFLICT (athlete_id, brand_key) DO UPDATE SET
           shown_count = brand_engagement.shown_count + 1,
           last_shown_at = NOW(),
           brand_name = COALESCE(EXCLUDED.brand_name, brand_engagement.brand_name),
           agent_id = COALESCE(brand_engagement.agent_id, EXCLUDED.agent_id),
           lane = COALESCE(brand_engagement.lane, EXCLUDED.lane),
           updated_at = NOW()`,
        [agentId || null, String(athleteId), bk, it.brandName || null, lane || null]);
      n++;
    } catch (e) { console.warn(`[brandLedger] shown upsert failed key=${bk}: ${e.message}`); }
  }
  return n;
}

// ── THE LEDGER LEARNS FROM WHAT CAME BACK ────────────────────────────────────
//
// Nothing in the tree ever wrote 'responded' or 'closed'. Both values existed
// only in read filters -- ai.js and index.js treat them as retirement states,
// scout.js reads them as a school-sponsor signal, and every one of those queries
// matched zero rows because no writer existed. The outcome endpoint looked like
// the writer but set brand_engagement.OUTCOME, a different column, leaving state
// on 'contacted' forever.
//
// So the ledger recorded that we contacted someone and never that they answered.
// Three things were reading for an answer that could not arrive:
//   scout.js         a brand that replied for another athlete at this school
//   ai.js / index.js retirement, so a brand that already replied stays offered
//   pitchWriter      learnedAngles, which weights angles by reply rate
//
// STATE ONLY EVER MOVES FORWARD. A late reply on a closed deal must not demote
// it, and re-ticking an outcome must be a no-op rather than a downgrade. 'dead'
// ranks below 'responded' on purpose: a brand we wrote off that then answers is
// answered, not dead.
const ENGAGEMENT_RANK = { shown: 0, contacted: 1, dead: 2, responded: 3, closed: 4 };

// Fallback key for a brand that never went through a scan, so a deal closed on a
// business we never showed still lands in the ledger. ai.resolveBrandKey is the
// real key builder, but requiring ai from store would be circular, and its keys
// (place_id / root domain) are not derivable from a name anyway. Prefixed so a
// name-derived key can never collide with a place_id or a domain.
function _nameBrandKey(brandName) {
  const n = String(brandName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return n ? 'name:' + n.slice(0, 80) : null;
}

// Move a brand's engagement state forward for ONE athlete. Upserts, because a
// reply or a close can arrive for a brand no scan ever surfaced. Never throws:
// a ledger write must not be able to fail a reply or a deal close.
async function advanceBrandEngagement(athleteId, opts = {}) {
  const state = String(opts.state || '').toLowerCase();
  if (!athleteId || ENGAGEMENT_RANK[state] === undefined) return false;
  const brandName = opts.brandName ? String(opts.brandName).trim() : '';
  const brandKey = opts.brandKey || null;
  if (!brandKey && !brandName) return false;
  const ranks = Object.keys(ENGAGEMENT_RANK).filter((k) => ENGAGEMENT_RANK[k] >= ENGAGEMENT_RANK[state]);
  try {
    // 1. Advance an existing row. Matched on brand_key when we have one, and on
    //    the NAME otherwise -- outreach_logs and deals carry a display name, not
    //    the scan's key, and demanding the key here is what would silently drop
    //    the majority of real replies.
    const upd = await pool.query(
      `UPDATE brand_engagement
          SET state = $3,
              updated_at = NOW(),
              contacted_at = COALESCE(contacted_at, NOW()),
              outcome = COALESCE($4, outcome),
              outcome_at = CASE WHEN $4 IS NULL THEN outcome_at ELSE NOW() END
        WHERE athlete_id = $1
          AND ($2::text IS NOT NULL AND brand_key = $2::text
               OR $5::text <> '' AND LOWER(brand_name) = LOWER($5::text))
          AND NOT (state = ANY($6::text[]))
        RETURNING id`,
      [String(athleteId), brandKey, state, opts.outcome || null, brandName, ranks]);
    if (upd.rowCount > 0) return true;

    // Already at or past this state: nothing to do, and that is a success.
    const seen = await pool.query(
      `SELECT 1 FROM brand_engagement
        WHERE athlete_id = $1
          AND ($2::text IS NOT NULL AND brand_key = $2::text
               OR $3::text <> '' AND LOWER(brand_name) = LOWER($3::text))
        LIMIT 1`, [String(athleteId), brandKey, brandName]);
    if (seen.rowCount > 0) return true;

    // 2. No row at all. Insert one, so a close on a business we never scanned
    //    still becomes evidence for the next athlete at that school.
    const bk = brandKey || _nameBrandKey(brandName);
    if (!bk) return false;
    await pool.query(
      `INSERT INTO brand_engagement
         (agent_id, athlete_id, brand_key, brand_name, lane, state, shown_count,
          first_shown_at, last_shown_at, contacted_at, outcome, outcome_at, source)
       VALUES ($1,$2,$3,$4,$5,$6,0,NOW(),NOW(),NOW(),$7,
               CASE WHEN $7::text IS NULL THEN NULL ELSE NOW() END,$8)
       ON CONFLICT (athlete_id, brand_key) DO NOTHING`,
      [opts.agentId || null, String(athleteId), bk, brandName || null,
       opts.lane || null, state, opts.outcome || null, opts.source || 'engagement']);
    return true;
  } catch (e) {
    console.warn(`[brandLedger] advance to ${state} failed athlete=${athleteId} `
      + `brand=${brandName || brandKey}: ${e.message}`);
    return false;
  }
}

// They answered. Called from every path a reply can arrive down: the Resend
// inbound webhook, the manual email tick, and the queue card outcome button.
async function markBrandResponded(athleteId, opts = {}) {
  return advanceBrandEngagement(athleteId, { ...opts, state: 'responded' });
}

// A deal closed with them. Strongest signal the ledger holds.
async function markBrandClosed(athleteId, opts = {}) {
  return advanceBrandEngagement(athleteId, { ...opts, state: 'closed' });
}

// Retire a brand: state=contacted, recording which path did it (contacted_via).
async function markBrandContacted(agentId, athleteId, lane, brandKey, brandName, via) {
  if (!athleteId || !brandKey) return false;
  try {
    await pool.query(
      `INSERT INTO brand_engagement
         (agent_id, athlete_id, brand_key, brand_name, lane, state, shown_count, first_shown_at, last_shown_at, contacted_at, contacted_via)
       VALUES ($1,$2,$3,$4,$5,'contacted',0,NOW(),NOW(),NOW(),$6)
       ON CONFLICT (athlete_id, brand_key) DO UPDATE SET
         state = 'contacted', contacted_at = NOW(), contacted_via = $6,
         brand_name = COALESCE(EXCLUDED.brand_name, brand_engagement.brand_name),
         agent_id = COALESCE(brand_engagement.agent_id, EXCLUDED.agent_id),
         lane = COALESCE(brand_engagement.lane, EXCLUDED.lane),
         updated_at = NOW()`,
      [agentId || null, String(athleteId), brandKey, brandName || null, lane || null, via || null]);
    return true;
  } catch (e) { console.warn(`[brandLedger] contacted mark failed key=${brandKey}: ${e.message}`); return false; }
}

// Undo a soft retirement: revert a just-contacted row back to shown. Only reverts
// state=contacted (never responded/closed/dead), so a real outcome is never lost.
async function unmarkBrandContacted(athleteId, brandKey) {
  if (!athleteId || !brandKey) return false;
  try {
    const r = await pool.query(
      `UPDATE brand_engagement
          SET state = 'shown', contacted_at = NULL, contacted_via = NULL, updated_at = NOW()
        WHERE athlete_id = $1 AND brand_key = $2 AND state = 'contacted'`,
      [String(athleteId), brandKey]);
    return (r.rowCount || 0) > 0;
  } catch (e) { console.warn(`[brandLedger] undo failed key=${brandKey}: ${e.message}`); return false; }
}

// Cross-athlete warning (#4): brands this AGENT already contacted for a DIFFERENT
// athlete. Returns { brandKey: { athleteName, date } }. Never hides a card; the
// route just attaches a badge.
async function getCrossAthleteContacted(agentId, brandKeys, excludeAthleteId) {
  const out = {};
  if (!agentId || !Array.isArray(brandKeys) || !brandKeys.length) return out;
  const keys = Array.from(new Set(brandKeys.filter(Boolean)));
  if (!keys.length) return out;
  try {
    const r = await pool.query(
      `SELECT DISTINCT ON (be.brand_key)
              be.brand_key,
              be.contacted_at,
              COALESCE(a.data->>'name', be.brand_name) AS athlete_name
         FROM brand_engagement be
         LEFT JOIN athletes a ON a.id = be.athlete_id
        WHERE be.agent_id = $1
          AND be.athlete_id <> $2
          AND be.brand_key = ANY($3)
          AND be.state IN ('contacted','responded','closed')
        ORDER BY be.brand_key, be.contacted_at DESC NULLS LAST`,
      [String(agentId), String(excludeAthleteId || ''), keys]);
    for (const row of r.rows || []) {
      out[row.brand_key] = {
        athleteName: row.athlete_name || 'another athlete',
        date: row.contacted_at ? new Date(row.contacted_at).toISOString().slice(0, 10) : null,
      };
    }
  } catch (e) { console.warn(`[brandLedger] cross-athlete lookup failed: ${e.message}`); }
  return out;
}

// ── Program Contact Map storage ──────────────────────────────────────────────
// Replace a school's records wholesale so a rebuild cannot leave a stale person
// behind after a staff change. Runs in a transaction: either the new set lands or
// the old set is untouched.
async function saveProgramStaff(school, records, sportArg) {
  if (!school) return 0;
  const list = records || [];
  // One call writes ONE sport. The delete below is scoped by it, so a mixed batch
  // would delete one sport's rows and insert another's. Refuse loudly rather than
  // half-apply: a silent partial write here loses a school's map.
  const seen = [...new Set(list.map((r) => (r && r.sport) || null).filter(Boolean))];
  if (seen.length > 1) {
    console.error(`[programMap] saveProgramStaff school="${school}" REFUSED: records mix sports (${seen.join(', ')})`);
    return 0;
  }
  if (sportArg && seen.length && seen[0] !== sportArg) {
    console.error(`[programMap] saveProgramStaff school="${school}" REFUSED: called for ${sportArg} but records say ${seen[0]}`);
    return 0;
  }
  const sport = sportArg || seen[0] || 'football';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Scoped to ONE sport. Deleting by school alone would wipe a school's football
    // map the first time its basketball page was saved.
    await client.query('DELETE FROM program_staff WHERE school = $1 AND sport = $2', [school, sport]);
    let n = 0;
    for (const r of (records || [])) {
      if (!r || !r.name || !r.role) continue;
      await client.query(
        `INSERT INTO program_staff
           (school, role, role_label, name, title, email, email_source_url, phone,
            linkedin_url, source_url, source_tier, confidence, sources, verified_on, updated_at,
            source_date, age_months, status, superseded_note, reach_via, sport, source_tier_note,
            role_rank, is_key_contact, page_section)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,CURRENT_DATE,NOW(),$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         ON CONFLICT (school, sport, role, name) DO UPDATE SET
           role_label = EXCLUDED.role_label, title = EXCLUDED.title,
           email = EXCLUDED.email, email_source_url = EXCLUDED.email_source_url,
           phone = EXCLUDED.phone, linkedin_url = EXCLUDED.linkedin_url,
           source_url = EXCLUDED.source_url, source_tier = EXCLUDED.source_tier,
           confidence = EXCLUDED.confidence, sources = EXCLUDED.sources,
           source_date = EXCLUDED.source_date, age_months = EXCLUDED.age_months,
           status = EXCLUDED.status, superseded_note = EXCLUDED.superseded_note,
           reach_via = EXCLUDED.reach_via, sport = EXCLUDED.sport,
           source_tier_note = EXCLUDED.source_tier_note,
           role_rank = EXCLUDED.role_rank, is_key_contact = EXCLUDED.is_key_contact,
           page_section = EXCLUDED.page_section,
           verified_on = CURRENT_DATE, updated_at = NOW()`,
        [school, r.role, r.role_label || null, r.name, r.title || null, r.email || null,
         r.email_source_url || null, r.phone || null, r.linkedin_url || null,
         r.source_url || null, r.source_tier || null, r.confidence || null,
         JSON.stringify(r.sources || []), r.source_date || null,
         r.age_months == null ? null : r.age_months, r.status || 'current',
         r.superseded_note || null, r.reach_via || null, sport, r.source_tier_note || null,
         r.role_rank == null ? null : r.role_rank, !!r.is_key_contact,
         r.page_section || null]);
      n++;
    }
    await client.query('COMMIT');
    console.log(`[programMap] saved school="${school}" records=${n}`);
    return n;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[programMap] save failed school="${school}":`, e.message);
    return 0;
  } finally { client.release(); }
}

// sport defaults to football so every existing caller keeps its exact behavior.
async function getProgramSource(school, sport = 'football') {
  try {
    const r = school
      ? await pool.query('SELECT * FROM program_source WHERE school = $1 AND sport = $2', [school, sport])
      : await pool.query('SELECT * FROM program_source WHERE sport = $1 ORDER BY school', [sport]);
    const rows = r.rows || [];
    // Readers still asking for football_staff_url keep working: the alias is added
    // on the way out so the rename does not have to land in every call site in the
    // same commit as the schema change.
    for (const row of rows) {
      if (row && row.staff_url !== undefined) {
        row.football_staff_url = row.staff_url;
        row.football_staff_url_discovered_via = row.staff_url_discovered_via;
      }
    }
    return school ? (rows[0] || null) : rows;
  } catch (e) { console.error('[programMap] source read failed:', e.message); return school ? null : []; }
}

// Persist a discovered staff URL. Called once per school; after this the URL is read
// from here forever and never re-discovered unless explicitly forced.
async function saveProgramSourceUrl(school, url, via, contactUrl, sport = 'football') {
  if (!school || !url) return false;
  try {
    // A URL set by hand is authoritative and permanent. Discovery guesses paths and
    // gets 404s; it must never be able to clobber a URL a human verified. Only
    // another manual set can replace one.
    if (via !== 'manual') {
      const cur = await pool.query('SELECT url_locked, staff_url FROM program_source WHERE school = $1 AND sport = $2', [school, sport]);
      const row = cur.rows[0];
      if (row && row.url_locked) {
        if (row.staff_url !== url) {
          console.log(`[programMap] school="${school}" sport=${sport} keeping hand-set URL ${row.staff_url}, ignoring ${via} suggestion ${url}`);
        }
        return false;
      }
    }
    await pool.query(
      `INSERT INTO program_source (school, sport, staff_url, staff_url_discovered_via, athletics_contact_url, url_locked, verified_on, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,NOW())
       ON CONFLICT (school, sport) DO UPDATE SET
         staff_url = EXCLUDED.staff_url,
         staff_url_discovered_via = EXCLUDED.staff_url_discovered_via,
         athletics_contact_url = COALESCE(EXCLUDED.athletics_contact_url, program_source.athletics_contact_url),
         url_locked = EXCLUDED.url_locked,
         verified_on = CURRENT_DATE, updated_at = NOW()`,
      [school, sport, url, via || null, contactUrl || null, via === 'manual']);
    return true;
  } catch (e) { console.error(`[programMap] source url save failed school="${school}":`, e.message); return false; }
}

// Record a parse, keeping the previous list so the NEXT run can diff against it.
async function saveProgramStaffSnapshot(school, staff, hash, via, sport = 'football') {
  if (!school) return false;
  try {
    await pool.query(
      `INSERT INTO program_source (school, sport, last_fetched_at, last_hash, last_staff, last_staff_count, parse_via, updated_at)
       VALUES ($1,$2,NOW(),$3,$4::jsonb,$5,$6,NOW())
       ON CONFLICT (school, sport) DO UPDATE SET
         last_fetched_at = NOW(), last_hash = EXCLUDED.last_hash,
         last_staff = EXCLUDED.last_staff, last_staff_count = EXCLUDED.last_staff_count,
         parse_via = EXCLUDED.parse_via, updated_at = NOW()`,
      [school, sport, hash || null, JSON.stringify(staff || []), (staff || []).length, via || null]);
    return true;
  } catch (e) { console.error(`[programMap] snapshot save failed school="${school}":`, e.message); return false; }
}

async function saveProgramContact(school, c, sport = 'football') {
  if (!school || !c) return false;
  try {
    // The old football_-prefixed keys are still accepted from callers so this
    // migration does not have to change every call site at once. Both spellings
    // land in the same sport-neutral column.
    const phone = c.office_phone || c.football_office_phone || null;
    const phoneSrc = c.office_phone_source_url || c.football_office_phone_source_url || null;
    await pool.query(
      `INSERT INTO program_contact
         (school, sport, office_phone, office_phone_source_url,
          recruiting_email, recruiting_email_source_url,
          collective_email, collective_email_source_url, collective_name, verified_on, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_DATE,NOW())
       ON CONFLICT (school, sport) DO UPDATE SET
         office_phone = EXCLUDED.office_phone,
         office_phone_source_url = EXCLUDED.office_phone_source_url,
         recruiting_email = EXCLUDED.recruiting_email,
         recruiting_email_source_url = EXCLUDED.recruiting_email_source_url,
         collective_email = EXCLUDED.collective_email,
         collective_email_source_url = EXCLUDED.collective_email_source_url,
         collective_name = EXCLUDED.collective_name,
         verified_on = CURRENT_DATE, updated_at = NOW()`,
      [school, sport, phone, phoneSrc,
       c.recruiting_email || null, c.recruiting_email_source_url || null,
       c.collective_email || null, c.collective_email_source_url || null, c.collective_name || null]);
    return true;
  } catch (e) { console.error(`[programMap] contact save failed school="${school}":`, e.message); return false; }
}

async function getProgramContact(school, sport = 'football') {
  try {
    const r = school
      ? await pool.query('SELECT * FROM program_contact WHERE school = $1 AND sport = $2', [school, sport])
      : await pool.query('SELECT * FROM program_contact WHERE sport = $1 ORDER BY school', [sport]);
    const rows = r.rows || [];
    // Readers still asking for football_office_phone keep working: the alias is
    // added on the way out so this migration does not break them mid-flight.
    for (const row of rows) {
      if (row && row.office_phone !== undefined) {
        row.football_office_phone = row.office_phone;
        row.football_office_phone_source_url = row.office_phone_source_url;
      }
    }
    return school ? (rows[0] || null) : rows;
  } catch (e) { console.error('[programMap] contact read failed:', e.message); return school ? null : []; }
}

// sport defaults to football, so every existing caller returns exactly what it
// returned before this migration.
async function getProgramStaff(school, sport = 'football') {
  try {
    const r = school
      ? await pool.query("SELECT * FROM program_staff WHERE school = $1 AND sport = $2 ORDER BY (role = 'staff'), is_key_contact DESC, role, role_rank NULLS LAST, (status <> 'current'), name", [school, sport])
      : await pool.query("SELECT * FROM program_staff WHERE sport = $1 ORDER BY school, (role = 'staff'), is_key_contact DESC, role, role_rank NULLS LAST, (status <> 'current'), name", [sport]);
    return r.rows || [];
  } catch (e) { console.error('[programMap] read failed:', e.message); return []; }
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

// ── Local deal outcomes ─────────────────────────────────────────────────────
// saveComp() already records the ATHLETE side of a closed deal (sport, tier,
// followers, value). It records nothing about the BUSINESS or the MARKET, so it
// can answer "what does a G5 softball player get" but never "what does a
// restaurant near Samford pay". This table adds the missing half.
//
// Everything here is derived automatically at close time. There is no form for
// the agent to fill in, on purpose: a form nobody completes produces no data.
async function ensureDealOutcomes() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deal_outcomes (
      id                SERIAL PRIMARY KEY,
      agent_id          TEXT,
      athlete_id        TEXT,
      deal_id           TEXT,
      brand             TEXT,
      business_category TEXT,
      school            TEXT,
      school_tier       TEXT,
      sport             TEXT,
      follower_band     TEXT,
      deliverable       TEXT,
      deal_value        NUMERIC,
      days_to_close     INTEGER,
      closed_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('[init] deal_outcomes table ready'))
    .catch(e => console.error('[init] deal_outcomes:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outcomes_cat ON deal_outcomes(business_category)`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_outcomes_tier ON deal_outcomes(school_tier)`).catch(() => {});
}

function followerBand(n) {
  n = parseInt(n) || 0;
  if (n < 1000)   return 'under-1k';
  if (n < 5000)   return '1k-5k';
  if (n < 10000)  return '5k-10k';
  if (n < 50000)  return '10k-50k';
  if (n < 100000) return '50k-100k';
  return '100k-plus';
}

// Best-effort lookup of what kind of business this brand is. Checked in order of
// how much we trust it. Returns null rather than guessing.
async function lookupBusinessCategory(agentId, brand) {
  if (!brand) return null;
  const tries = [
    [`SELECT brand_category AS c FROM athlete_deal_pipeline
       WHERE agent_id = $1 AND LOWER(brand_name) = LOWER($2)
         AND COALESCE(brand_category,'') <> '' LIMIT 1`, [agentId, brand]],
    [`SELECT industry AS c FROM company_enrichment
       WHERE agent_id = $1 AND LOWER(brand_name) = LOWER($2)
         AND COALESCE(industry,'') <> '' LIMIT 1`, [agentId, brand]],
  ];
  for (const [sql, params] of tries) {
    try {
      const r = await pool.query(sql, params);
      if (r.rows[0]?.c) return String(r.rows[0].c).trim().toLowerCase();
    } catch (e) { /* table may not exist yet */ }
  }
  return null;
}

// closedAt is WHEN THE DEAL CLOSED, passed by the caller. It used to be omitted so
// the column's DEFAULT NOW() supplied insert time -- fine for a live close, wrong for
// a backfill, which stamped every historical deal with the day the backfill ran and
// would pile a whole history into one week of any weekly chart. Pass null when the
// real date is genuinely unknown: the column stores NULL and every dated query
// excludes it, which is honest. Never let it fall back to today.
async function saveDealOutcome(dealId, dealData, athleteData, agentId, closedAt) {
  try {
    const value = parseInt(dealData.value) || 0;
    if (value <= 0) return false;

    const created = dealData.createdAt || dealData.created_at || null;
    let days = null;
    if (created) {
      const d = Math.floor((Date.now() - new Date(created).getTime()) / 86400000);
      if (d >= 0 && d < 3650) days = d;
    }

    const followers = (parseInt(athleteData.instagram) || 0) + (parseInt(athleteData.tiktok) || 0);
    const category = await lookupBusinessCategory(agentId, dealData.brand);

    await pool.query(
      `INSERT INTO deal_outcomes
         (agent_id, athlete_id, deal_id, brand, business_category, school,
          school_tier, sport, follower_band, deliverable, deal_value, days_to_close,
          closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [agentId || null, athleteData.id || null, dealId || null,
       dealData.brand || null, category, athleteData.school || null,
       athleteData.schoolTier || null, athleteData.sport || null,
       followerBand(followers), dealData.type || null, value, days,
       closedAt || dealData.closedAt || null]
    );
    const stamp = closedAt || dealData.closedAt || null;
    console.log(`[outcome] saved brand=${dealData.brand} cat=${category || 'unknown'} $${value} `
      + `days=${days} closed_at=${stamp || 'NULL (date unknown, excluded from dated views)'}`);
    return true;
  } catch (e) {
    console.error('[outcome] save failed:', e.message);
    return false;
  }
}

// Benchmarks across ALL agents. MIN_SAMPLE exists because a "median" computed
// from two deals is worse than showing nothing — it reads as authoritative and
// it is noise. Below the threshold we return the count and no numbers.
const MIN_SAMPLE = 5;

async function getBenchmarks({ category = null, tier = null, band = null } = {}) {
  const where = [`deal_value > 0`];
  const params = [];
  if (category) { params.push(category.toLowerCase()); where.push(`LOWER(business_category) = $${params.length}`); }
  if (tier)     { params.push(tier);                   where.push(`school_tier = $${params.length}`); }
  if (band)     { params.push(band);                   where.push(`follower_band = $${params.length}`); }

  const sql = `
    SELECT business_category,
           COUNT(*)::int AS n,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY deal_value)::numeric AS median,
           PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY deal_value)::numeric AS p25,
           PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY deal_value)::numeric AS p75,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days_to_close)
             FILTER (WHERE days_to_close IS NOT NULL)::numeric AS median_days
      FROM deal_outcomes
     WHERE ${where.join(' AND ')}
     GROUP BY business_category
     ORDER BY n DESC`;

  try {
    const r = await pool.query(sql, params);
    const total = r.rows.reduce((s, x) => s + x.n, 0);
    return {
      totalDeals: total,
      minSample: MIN_SAMPLE,
      rows: r.rows.map(x => ({
        category: x.business_category || 'uncategorized',
        n: x.n,
        enough: x.n >= MIN_SAMPLE,
        median: x.n >= MIN_SAMPLE ? Math.round(Number(x.median)) : null,
        p25: x.n >= MIN_SAMPLE ? Math.round(Number(x.p25)) : null,
        p75: x.n >= MIN_SAMPLE ? Math.round(Number(x.p75)) : null,
        medianDays: x.n >= MIN_SAMPLE && x.median_days != null ? Math.round(Number(x.median_days)) : null,
      })),
    };
  } catch (e) {
    console.error('[benchmarks]', e.message);
    return { totalDeals: 0, minSample: MIN_SAMPLE, rows: [] };
  }
}

// ── Deal Scan feedback loop ─────────────────────────────────────────────────
// deal_scan_feedback was already written on two positive actions (a brand being
// pushed to pipeline or outreach) and never read by anything. Two problems with
// that: nothing learned from it, and it was positive-only, so there was no
// denominator. A brand picked 3 times looked identical to a brand picked 3 times
// out of 3 shown versus 3 out of 300.
//
// So we now also log every card that gets SHOWN. That turns the table into a
// proper rate (acted / shown) per business category, pooled across all agents,
// which is exactly the signal that cannot be bought or scraped.
async function ensureFeedbackColumns() {
  for (const sql of [
    `ALTER TABLE deal_scan_feedback ADD COLUMN IF NOT EXISTS category TEXT`,
    `ALTER TABLE deal_scan_feedback ADD COLUMN IF NOT EXISTS market TEXT`,
  ]) await pool.query(sql).catch(e => console.error('[init] feedback cols:', e.message));
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_feedback_cat_action ON deal_scan_feedback(category, action)`
  ).catch(() => {});
}

// Bulk-log the cards a scan just surfaced. Fire and forget: this must never
// slow down or fail a scan.
async function logScanShown(agentId, athleteId, items, athlete) {
  try {
    const rows = (items || []).filter(o => o && o.brand).slice(0, 40);
    if (!rows.length) return 0;
    const vals = [];
    const params = [];
    rows.forEach((o, i) => {
      const b = i * 8;
      vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},'shown',$${b+5},$${b+6},$${b+7},$${b+8})`);
      params.push(
        agentId || null, athleteId || null, o.brand,
        (o.category || '').toLowerCase() || null,
        athlete?.sport || null, athlete?.position || null,
        athlete?.schoolTier || null, o.market || null
      );
    });
    await pool.query(
      `INSERT INTO deal_scan_feedback
         (agent_id, athlete_id, brand, category, action, sport, position, school_tier, market)
       VALUES ${vals.join(',')}`, params);
    return rows.length;
  } catch (e) {
    console.error('[feedback] logScanShown:', e.message);
    return 0;
  }
}

// Cross-agent act-rate per category. Cached in memory because this runs inside
// the scan path and the numbers move slowly.
const SIGNAL_MIN_SHOWN = 20;   // below this, a rate is noise
let _signalCache = { at: 0, data: null };
const SIGNAL_TTL_MS = 10 * 60 * 1000;

async function getScanSignal() {
  if (_signalCache.data && (Date.now() - _signalCache.at) < SIGNAL_TTL_MS) return _signalCache.data;
  try {
    const r = await pool.query(
      `SELECT COALESCE(category,'') AS category,
              COUNT(*) FILTER (WHERE action = 'shown')::int AS shown,
              COUNT(*) FILTER (WHERE action IN ('pipeline','outreach'))::int AS acted
         FROM deal_scan_feedback
        WHERE COALESCE(category,'') <> ''
        GROUP BY COALESCE(category,'')`);

    const cats = {};
    let totShown = 0, totActed = 0;
    for (const row of r.rows) { totShown += row.shown; totActed += row.acted; }
    const baseline = totShown >= SIGNAL_MIN_SHOWN ? (totActed / totShown) : null;

    if (baseline !== null) {
      for (const row of r.rows) {
        if (row.shown < SIGNAL_MIN_SHOWN) continue;
        cats[row.category] = { shown: row.shown, acted: row.acted, rate: row.acted / row.shown };
      }
    }
    const data = { baseline, categories: cats, ready: baseline !== null && Object.keys(cats).length > 0 };
    _signalCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    console.error('[feedback] getScanSignal:', e.message);
    const data = { baseline: null, categories: {}, ready: false };
    _signalCache = { at: Date.now(), data };
    return data;
  }
}

// Nudge the AI's fitScore by how a category actually performs with real agents.
// Deliberately bounded to +/- MAX_ADJ: this is a tiebreaker on top of the
// model's judgment, not a replacement for it. A category that no agent has ever
// acted on should sink a little, not vanish.
const MAX_ADJ = 8;

function applyScanSignal(items, signal) {
  if (!signal || !signal.ready || !Array.isArray(items) || !items.length) return items;
  const b = signal.baseline;
  if (!b || b <= 0) return items;

  for (const o of items) {
    const c = (o.category || '').toLowerCase();
    const s = signal.categories[c];
    if (!s) continue;
    // ratio of this category's act-rate to the platform baseline, log-damped so
    // one hot category cannot dominate the board
    const ratio = s.rate / b;
    const adj = Math.max(-MAX_ADJ, Math.min(MAX_ADJ, Math.round(Math.log2(ratio || 0.01) * 4)));
    if (!adj) continue;
    const before = Number(o.fitScore) || 0;
    o.fitScore = Math.max(1, Math.min(99, before + adj));
    o._signalAdj = adj;
  }
  items.sort((x, y) => (Number(y.fitScore) || 0) - (Number(x.fitScore) || 0));
  return items;
}

// ── "New in this market" tracking ───────────────────────────────────────────
// Deal Scan had no concept of new. Rescanning a market showed the same
// businesses with no way to tell which had just appeared, so there was never a
// reason to look again. This records the first time each business is seen in a
// market, which makes "6 businesses we hadn't seen here before" answerable.
//
// The established-market guard matters: on the first scan of a market every
// business is technically new, which is meaningless. A market only starts
// reporting newcomers once it has history older than the window.
async function ensureMarketSightings() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_business_seen (
      market_key    TEXT NOT NULL,
      brand         TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (market_key, brand)
    )
  `).then(() => console.log('[init] market_business_seen table ready'))
    .catch(e => console.error('[init] market_business_seen:', e.message));

  // The names a market scan produced that are not businesses. Kept rather than
  // discarded: a scan returning placeholders is a broken scan, and the count is
  // the only way the agent finds out.
  // ── DOES THIS ADDRESS ACCEPT MAIL? ────────────────────────────────────────
  // One row per address, not per draft: a verification is a fact about the
  // mailbox and the same business recurs across athletes and months. Written at
  // DRAFT time so a bad address never reaches a card an agent is asked to
  // approve, and read by Home to hold the definite failures back.
  //
  // result is deliberately three-valued:
  //   valid    a verifier confirmed the mailbox
  //   invalid  the domain takes no mail, or the verifier said undeliverable
  //   unknown  catch-all, or the check could not be run. NOT a failure -- most
  //            small businesses sit on catch-all Workspace/365 domains and no
  //            verifier can answer for them. The card shows it and the agent
  //            decides, which is the same stance the compliance gate takes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_verification (
      email       TEXT PRIMARY KEY,
      result      TEXT NOT NULL CHECK (result IN ('valid','invalid','unknown')),
      detail      TEXT,
      source      TEXT,
      checked_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `).then(() => console.log('[init] email_verification table ready'))
    .catch(e => console.error('[init] email_verification:', e.message));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_business_rejected (
      market_key    TEXT NOT NULL,
      brand         TEXT NOT NULL,
      reason        TEXT,
      first_seen_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (market_key, brand)
    )
  `).then(() => console.log('[init] market_business_rejected table ready'))
    .catch(e => console.error('[init] market_business_rejected:', e.message));
}

const NEW_WINDOW_DAYS = 30;

// Returns a Set of brand names that are newcomers to this market, then records
// every brand passed in. Read-then-write order is deliberate: recording first
// would stamp everything with first_seen = now and nothing would ever be new.
// ── IS THIS THE NAME OF A COMPANY, OR THE MODEL THINKING OUT LOUD? ──────────
// "Core Physical Therapy (or similar local PT/chiro near campus)" was queued as
// a business. Nothing between the market scan's model output and a queued card
// asked whether the string names a real company: rows were written verbatim,
// and normBrand in scout.js only lowercases and strips punctuation, which makes
// it a dedupe key rather than a validator.
//
// These are the shapes a model produces when it is hedging instead of naming.
// Deliberately narrow -- a real business called "Smith & Sons (Est. 1974)" must
// survive, so the parenthetical rules require a hedge WORD inside the brackets,
// not merely brackets.
const PLACEHOLDER_MAX_LEN = 60;   // longer than any plausible business name
const PLACEHOLDER_RULES = [
  { why: 'hedged alternative in brackets', re: /\((?=[^)]*\b(?:or|and)\s+(?:a\s+|any\s+)?similar\b)[^)]*\)/i },
  { why: 'hedged alternative in brackets', re: /\((?=[^)]*\bor\s+(?:a|an|another|other)\b)[^)]*\)/i },
  { why: 'describes a location instead of naming one', re: /\b(?:near|around|close to|by)\s+campus\b/i },
  { why: 'gives an example rather than a name', re: /\b(?:e\.?g\.?|i\.?e\.?|for example|such as|etc\.?)\b/i },
  { why: 'a category with a slash, not a business', re: /\w\/\w/ },
  { why: 'trailing slash', re: /\/\s*$/ },
];
function placeholderReason(name) {
  const s = String(name || '').trim();
  if (!s) return 'empty';
  // Specific rules first: length is the catch-all, and "longer than 60
  // characters" tells whoever reads the log far less than "hedged alternative
  // in brackets" about what the scan actually did wrong.
  for (const r of PLACEHOLDER_RULES) if (r.re.test(s)) return r.why;
  if (s.length > PLACEHOLDER_MAX_LEN) return `longer than ${PLACEHOLDER_MAX_LEN} characters`;
  return null;
}

async function markMarketNewcomers(marketKey, brands) {
  const out = new Set();
  try {
    const raw = Array.from(new Set((brands || []).filter(Boolean).map(b => String(b).trim())));
    // REJECTED, NOT SILENTLY DROPPED. A market scan producing placeholders means
    // that scan returned junk, and binning it quietly hides the fact from the
    // agent whose market it was. The rejection is recorded so the shift report
    // can say how many a scan threw away.
    const list = [];
    const rejected = [];
    for (const b of raw) {
      const why = placeholderReason(b);
      if (why) rejected.push({ brand: b, why }); else list.push(b);
    }
    if (rejected.length) {
      console.warn(`[market-seen] ${marketKey}: rejected ${rejected.length} placeholder name(s): `
        + rejected.map((r) => `"${r.brand.slice(0, 48)}" (${r.why})`).join('; '));
      await pool.query(
        `INSERT INTO market_business_rejected (market_key, brand, reason)
         SELECT $1, u.brand, u.reason FROM UNNEST($2::text[], $3::text[]) AS u(brand, reason)
         ON CONFLICT (market_key, brand) DO UPDATE SET reason = EXCLUDED.reason, last_seen_at = NOW()`,
        [marketKey, rejected.map((r) => r.brand), rejected.map((r) => r.why)]).catch((e) =>
        console.error('[market-seen] could not record rejections:', e.message));
    }
    if (!marketKey || !list.length) return out;

    const est = await pool.query(
      `SELECT COUNT(*)::int AS n FROM market_business_seen
        WHERE market_key = $1 AND first_seen_at < NOW() - ($2 || ' days')::interval`,
      [marketKey, String(NEW_WINDOW_DAYS)]);
    const established = (est.rows[0]?.n || 0) > 0;

    if (established) {
      const known = await pool.query(
        `SELECT brand, first_seen_at FROM market_business_seen
          WHERE market_key = $1 AND brand = ANY($2::text[])`, [marketKey, list]);
      const seen = new Map(known.rows.map(r => [r.brand, r.first_seen_at]));
      const cutoff = Date.now() - NEW_WINDOW_DAYS * 86400000;
      for (const b of list) {
        const f = seen.get(b);
        if (!f) out.add(b);                                   // never seen here
        else if (new Date(f).getTime() > cutoff) out.add(b);  // first seen recently
      }
    }

    const vals = list.map((_, i) => `($1,$${i + 2})`).join(',');
    await pool.query(
      `INSERT INTO market_business_seen (market_key, brand) VALUES ${vals}
       ON CONFLICT (market_key, brand) DO UPDATE SET last_seen_at = NOW()`,
      [marketKey, ...list]);
  } catch (e) {
    console.error('[market-seen]', e.message);
  }
  return out;
}

// ── Social lane brand index ──────────────────────────────────────────────────
// Decorate a raw social_brands row with the deterministic, NO-AI fields the
// Social Deal Scan lane needs: proofAge (whole months since proof_date),
// freshness, a plain-language whyFits built only from the row's own columns, and
// lane='social'.
function _decorateSocialBrand(row) {
  const now = new Date();
  const proof = row.proof_date ? new Date(row.proof_date) : null;
  let proofAge = 0;
  if (proof && !isNaN(proof.getTime())) {
    proofAge = (now.getFullYear() - proof.getFullYear()) * 12 + (now.getMonth() - proof.getMonth());
    if (now.getDate() < proof.getDate()) proofAge -= 1; // not a full month yet
    if (proofAge < 0) proofAge = 0;
  }
  // whyFits leads with the real program note (cadence_note). No follower-range
  // sentence: the Tier field below the line already shows it (or "Not stated").
  // When there is no cadence_note, fall back to the deal-structure description.
  const structDesc = { cash_code: 'Cash + code', affiliate: 'Affiliate only', cash: 'Cash', gifting_code: 'Gifting + code' };
  const cadence = row.cadence_note ? String(row.cadence_note).trim() : '';
  const whyFits = cadence || structDesc[row.deal_structure] || row.deal_structure || 'Runs an athlete program';
  return { ...row, proofAge, freshness: proofAge <= 12 ? 'current' : 'aging', whyFits, lane: 'social' };
}

// ── National brand search, by name ───────────────────────────────────────────
// THE VERIFIED INDEX, LOOKED UP DIRECTLY. Typing "Red Bull" into the national
// box must never reach placesLookup: that is the local lane, and it is what
// resolves a national brand to a nearby storefront. Exact match first, then a
// prefix/contains match so "red bull" finds "Red Bull" and "gymshark" finds
// "Gymshark". Inactive rows are included so a de-activated brand reports as
// known-but-inactive rather than being silently re-researched.
async function findNationalBrand(name) {
  const q = String(name || '').trim().toLowerCase();
  if (!q) return null;
  try {
    const r = await pool.query(
      `SELECT * FROM social_brands
        WHERE lower(brand) = $1
           OR lower(brand) LIKE $2
           OR $1 LIKE lower(brand) || '%'
        ORDER BY (lower(brand) = $1) DESC, active DESC, length(brand) ASC
        LIMIT 1`, [q, q + '%']);
    return r.rows[0] ? _decorateSocialBrand(r.rows[0]) : null;
  } catch (e) {
    console.error('[findNationalBrand]', e.message);
    return null;
  }
}

// FIT AGAINST THE SELECTED ATHLETE, same inputs the Social lane matches on:
// combined reach against the brand's tier band, and sport against its list.
// Returned as a score plus the reason, so the card can say why rather than
// showing a bare number.
function scoreNationalBrandFit(row, athlete) {
  const reach = (Number(athlete && athlete.instagram) || 0) + (Number(athlete && athlete.tiktok) || 0);
  const sport = String((athlete && athlete.sport) || '').trim().toLowerCase();
  const sports = Array.isArray(row.sports) ? row.sports.map((x) => String(x).toLowerCase()) : [];
  const tierMin = Number(row.tier_min) || 0;
  const tierMax = Number(row.tier_max) || 0;

  // NO STATED BAND is not the same as a band of 0-0. A researched brand that
  // publishes no follower threshold used to score as "sits inside their stated
  // tier", which invents a fact: 0 <= reach and tierMax===0 read as open-ended.
  const hasBand = tierMin > 0 || tierMax > 0;
  const sportOk = !sports.length || sports.includes('all') || sports.includes(sport);
  const inBand = hasBand && reach > 0 && tierMin <= reach && (tierMax === 0 || tierMax >= reach);
  const nearBand = hasBand && reach > 0 && !inBand && tierMin <= reach * 1.5 && (tierMax === 0 || tierMax >= reach * 0.5);

  let score = 50;
  const why = [];
  // Naming the sport counts even when the row ALSO carries 'all'. A program page
  // that lists softball by name is a stronger match than a blanket "all sports",
  // and rows commonly carry both.
  if (sportOk) { score += 15; if (sport && sports.includes(sport)) { score += 10; why.push(`works with ${sport} athletes specifically`); } }
  else { score -= 25; why.push(`their program lists ${sports.join(', ')}, not ${sport || 'this sport'}`); }
  if (inBand) { score += 20; why.push(`${reach.toLocaleString()} combined followers sits inside their stated tier`); }
  else if (nearBand) { score += 5; why.push(`${reach.toLocaleString()} followers is near their stated tier`); }
  else if (hasBand && reach > 0 && tierMin > reach) { score -= 15; why.push(`their program starts around ${tierMin.toLocaleString()} followers`); }
  else if (!reach) why.push('no follower counts on file for this athlete yet');
  else if (!hasBand) why.push('they publish no follower threshold, so reach is not a filter here');
  // Freshness only means something for a row backed by a dated proof page. A
  // researched card has no proof_date, so saying "verified 0 months ago" would
  // be claiming a check that never happened.
  if (row.proof_date && row.freshness === 'current') score += 5;
  else if (row.proof_date) why.push(`program page last verified ${row.proofAge} months ago`);

  score = Math.max(1, Math.min(99, score));
  return { fitScore: score, fitWhy: why };
}

// Serve the Social lane straight from the curated social_brands index, matched to
// the athlete's combined IG+TikTok reach and sport. Pure DB read: no web search,
// no AI, no cache write. Returns [] on any error so the lane degrades to empty
// rather than breaking a scan.
async function getSocialBrands(athlete) {
  try {
    const reach = (Number(athlete.instagram) || 0) + (Number(athlete.tiktok) || 0);
    const sport = String(athlete.sport || '').trim().toLowerCase();
    const athleteId = athlete.id || null;

    // Base match: active brands whose tier band brackets this athlete's combined
    // reach and whose sport list includes the sport (or 'all').
    const baseWhere = `active = true
          AND (sports @> ARRAY[$1]::text[] OR sports @> ARRAY['all']::text[])
          AND tier_min <= $2
          AND tier_max >= $3`;
    const baseParams = [sport, reach * 1.25, reach * 0.75];

    // Rotation: exclude brands shown to THIS athlete in the last 30 days (per
    // athlete, not global). Re-running the query (e.g. the Refresh button) pulls
    // the next set. No athlete id -> no exclusion.
    let rows = [];
    if (athleteId) {
      const excl = await pool.query(
        `SELECT * FROM social_brands
          WHERE ${baseWhere}
            AND id NOT IN (
              SELECT brand_id FROM social_brand_shown
               WHERE athlete_id = $4 AND shown_at > NOW() - INTERVAL '30 days'
            )
          ORDER BY (brand_size = 'small') DESC NULLS LAST, proof_date DESC
          LIMIT 12`,
        [...baseParams, athleteId]
      );
      rows = excl.rows;
    }

    // If the exclusion leaves fewer than 5 matches (or there is no athlete id),
    // ignore the exclusion and return the normal top 12. Better to repeat a brand
    // than to show an empty lane.
    if (rows.length < 5) {
      const full = await pool.query(
        `SELECT * FROM social_brands
          WHERE ${baseWhere}
          ORDER BY (brand_size = 'small') DESC NULLS LAST, proof_date DESC
          LIMIT 12`,
        baseParams
      );
      rows = full.rows;
    }

    // Record what we are showing THIS athlete now so the next scan rotates.
    // Best effort: a logging failure must never break the lane.
    if (athleteId && rows.length) {
      try {
        await pool.query(
          `INSERT INTO social_brand_shown (athlete_id, brand_id, shown_at)
           SELECT $1, UNNEST($2::int[]), NOW()
           ON CONFLICT (athlete_id, brand_id) DO UPDATE SET shown_at = NOW()`,
          [athleteId, rows.map((r) => r.id)]
        );
      } catch (e) { console.warn('[getSocialBrands] shown-log failed:', e.message); }
    }

    return rows.map(_decorateSocialBrand);
  } catch (e) {
    console.error('[getSocialBrands]', e.message);
    return [];
  }
}

// Eligibility used by the Social lane: active brands whose sport list includes the
// athlete's sport (or 'all') and whose tier band brackets the athlete's combined
// IG+TikTok reach (+/-25%). Single source so the pool, the depth report, and the
// legacy rotation all agree on what "eligible" means.
function _socialBaseMatch(athlete) {
  const reach = (Number(athlete.instagram) || 0) + (Number(athlete.tiktok) || 0);
  const sport = String(athlete.sport || '').trim().toLowerCase();
  const where = `active = true
        AND (sports @> ARRAY[$1]::text[] OR sports @> ARRAY['all']::text[])
        AND tier_min <= $2
        AND tier_max >= $3`;
  return { where, params: [sport, reach * 1.25, reach * 0.75] };
}

// FULL eligible Social pool for an athlete, fit-ordered (small DTC brands first,
// then freshest proof). NO 12-limit and NO social_brand_shown exclusion: the
// brand_engagement ledger now drives unseen/backfill selection and records shown,
// exactly like the Local lane. Pure DB read.
async function getSocialBrandPool(athlete) {
  try {
    const { where, params } = _socialBaseMatch(athlete);
    const r = await pool.query(
      `SELECT * FROM social_brands WHERE ${where}
        ORDER BY (brand_size = 'small') DESC NULLS LAST, proof_date DESC`,
      params
    );
    return (r.rows || []).map(_decorateSocialBrand);
  } catch (e) { console.error('[getSocialBrandPool]', e.message); return []; }
}

// Depth report for the Social lane: how many verified (active) brands exist in the
// index, and how many are eligible for THIS athlete after the sport + audience
// filters. Drives the "is the real fix growing the index" decision.
async function getSocialDepth(athlete) {
  try {
    const { where, params } = _socialBaseMatch(athlete);
    const [totalR, eligR] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM social_brands WHERE active = true`),
      pool.query(`SELECT COUNT(*)::int AS n FROM social_brands WHERE ${where}`, params),
    ]);
    return { totalActive: totalR.rows[0].n, eligibleForAthlete: eligR.rows[0].n };
  } catch (e) { console.error('[getSocialDepth]', e.message); return { totalActive: 0, eligibleForAthlete: 0 }; }
}

module.exports = {
  getUser, getUserWithPassword, getUserByEmail, getUserByEmailWithPassword, saveUser, getAllUsers,
  getUserByStripeCustomer, getReferralPartner, buildCommissionRow, recordReferralCommission, aggregateReferrals, recordReferralForInvoice,
  getAthlete, getAthletesByAgent, saveAthlete, deleteAthlete,
  getDeal, getDealsByAthlete, getDealsByAgent, saveDeal, deleteDeal,
  saveComp, getComps, getCompStats, getCompsByBrand,
  getBrandEvidence, saveBrandEvidence, getTopNilComps, getSocialBrands,
  getOnboarding, logWizardEvent, completeWizard, markChecklistItem,
  dismissChecklist, markTooltipSeen, backfillChecklist, getOnboardingAnalytics,
  CHECKLIST_ITEMS,
  getMarketCache, setMarketCache, MARKET_CACHE_TTL_DAYS,
  getBrandLedgerRows, getBrandLedgerRow, insertManualBrand, upsertShownBrands, markBrandContacted, unmarkBrandContacted, getCrossAthleteContacted,
  advanceBrandEngagement, markBrandResponded, markBrandClosed, ENGAGEMENT_RANK,
  getSocialBrandPool, getSocialDepth,
  saveProgramStaff, getProgramStaff, saveProgramContact, getProgramContact,
  getProgramSource, saveProgramSourceUrl, saveProgramStaffSnapshot,
  ensureDealOutcomes, saveDealOutcome, getBenchmarks, followerBand,
  ensureFeedbackColumns, logScanShown, getScanSignal, applyScanSignal,
  ensureMarketSightings, markMarketNewcomers, NEW_WINDOW_DAYS,
  placeholderReason, PLACEHOLDER_MAX_LEN,
  findNationalBrand, scoreNationalBrandFit,
  pool
};
