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
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
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
  pool
};
