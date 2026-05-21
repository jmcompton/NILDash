// server/store.js — PostgreSQL persistent storage
const { Pool } = require('pg');

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

    CREATE TABLE IF NOT EXISTS university_daily_actions (
      id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      university_id   TEXT NOT NULL,
      action_type     TEXT NOT NULL,
      athlete_id      TEXT,
      priority        TEXT DEFAULT 'medium',
      message         TEXT,
      metadata        JSONB DEFAULT '{}',
      resolved        BOOLEAN DEFAULT FALSE,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

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
async function saveUser(id, data) {
  await pool.query(`
    INSERT INTO users (id, name, email, password, role, athlete_id, agent_id, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
    ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name, email=EXCLUDED.email, password=EXCLUDED.password,
      role=EXCLUDED.role, athlete_id=EXCLUDED.athlete_id, agent_id=EXCLUDED.agent_id, updated_at=NOW()
  `, [id, data.name || '', data.email, data.password, data.role || 'agent', data.athleteId || null, data.agentId || null]);
  return getUser(id);
}
async function getAllUsers() {
  const r = await pool.query('SELECT * FROM users');
  return Object.fromEntries(r.rows.map(u => [u.id, u]));
}

// ATHLETES
async function getAthlete(id) {
  const r = await pool.query('SELECT * FROM athletes WHERE id=$1', [id]);
  if (!r.rows[0]) return null;
  return { id: r.rows[0].id, agentId: r.rows[0].agent_id, ...r.rows[0].data };
}
async function getAthletesByAgent(agentId) {
  // Exclude university-imported roster athletes — those belong to the University Portal only
  const r = await pool.query(
    `SELECT * FROM athletes WHERE agent_id=$1
       AND (data->>'source' IS DISTINCT FROM 'espn_import')
       AND (data->>'source' IS DISTINCT FROM 'university_import')`,
    [agentId]
  );
  return r.rows.map(row => ({ id: row.id, agentId: row.agent_id, ...row.data }));
}
async function saveAthlete(id, data) {
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
async function getDealsByAthlete(athleteId) {
  const r = await pool.query('SELECT * FROM deals WHERE athlete_id=$1', [athleteId]);
  return r.rows.map(row => ({ id: row.id, athleteId: row.athlete_id, agentId: row.agent_id, ...row.data }));
}
async function getDealsByAgent(agentId) {
  const r = await pool.query('SELECT * FROM deals WHERE agent_id=$1', [agentId]);
  return r.rows.map(row => ({ id: row.id, athleteId: row.athlete_id, agentId: row.agent_id, ...row.data }));
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

init().catch(console.error);

module.exports = {
  getUser, getUserWithPassword, getUserByEmail, getUserByEmailWithPassword, saveUser, getAllUsers,
  getAthlete, getAthletesByAgent, saveAthlete, deleteAthlete,
  getDeal, getDealsByAthlete, getDealsByAgent, saveDeal, deleteDeal,
  saveComp, getComps, getCompStats,
  pool
};
