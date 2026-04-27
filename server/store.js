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
  `);
  // Add name column if missing (migration for existing DBs)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT`).catch(() => {});
  console.log('Database tables ready');
}

// USERS
async function getUser(id) {
  const r = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
  return r.rows[0] || null;
}
async function getUserByEmail(email) {
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
  return r.rows[0] || null;
}
async function saveUser(id, data) {
  await pool.query(`
    INSERT INTO users (id, name, email, password, role, updated_at)
    VALUES ($1,$2,$3,$4,$5,NOW())
    ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name, email=EXCLUDED.email, password=EXCLUDED.password,
      role=EXCLUDED.role, updated_at=NOW()
  `, [id, data.name || '', data.email, data.password, data.role || 'agent']);
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
      CREATE TABLE IF NOT EXISTS deal_comps (
        id SERIAL PRIMARY KEY,
        sport TEXT,
        school_tier TEXT,
        followers INTEGER,
        engagement NUMERIC,
        deal_type TEXT,
        deal_value INTEGER,
        year_in_school TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
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
    await pool.query(`CREATE TABLE IF NOT EXISTS deal_comps (id SERIAL PRIMARY KEY, sport TEXT, school_tier TEXT, followers INTEGER, engagement NUMERIC, deal_type TEXT, deal_value INTEGER, year_in_school TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
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
    await pool.query(`CREATE TABLE IF NOT EXISTS deal_comps (id SERIAL PRIMARY KEY, sport TEXT, school_tier TEXT, followers INTEGER, engagement NUMERIC, deal_type TEXT, deal_value INTEGER, year_in_school TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
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
  getUser, getUserByEmail, saveUser, getAllUsers,
  getAthlete, getAthletesByAgent, saveAthlete, deleteAthlete,
  getDeal, getDealsByAthlete, getDealsByAgent, saveDeal, deleteDeal,
  saveComp, getComps, getCompStats,
  pool
};
