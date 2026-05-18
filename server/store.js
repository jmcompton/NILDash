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
  const r = await pool.query('SELECT * FROM athletes WHERE agent_id=$1', [agentId]);
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
