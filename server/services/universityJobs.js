'use strict';
// ── ONE JOB AT A TIME PER UNIVERSITY, AND A LOCK THAT CANNOT STICK ──────────
//
// The lock was an in-memory Map. A crashed build, a deploy mid-build, or a
// second server process left it saying "already running" with nothing
// running, and nothing ever cleared it (Cypress: status said running: null,
// the build said 409 forever). Now:
//   - the lock is a row (university_jobs), shared by every process
//   - the job beats every HEARTBEAT_MS while it runs
//   - a lock with no beat for STALE_MS is free to take
//   - POST /api/admin/university-unlock clears one by hand
//   - status shows the holder, what it is doing and how long since its beat

const HEARTBEAT_MS = 60 * 1000;
const STALE_MS = parseInt(process.env.UNIVERSITY_JOB_STALE_MS, 10) || 20 * 60 * 1000;

let _ready = null;
function ensureTable(pool) {
  if (!_ready) {
    _ready = pool.query(`CREATE TABLE IF NOT EXISTS university_jobs (
      university_id TEXT PRIMARY KEY, label TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      beat_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`).catch((e) => { _ready = null; throw e; });
  }
  return _ready;
}

// { ok: true } when taken; { ok: false, holder } when a live job holds it.
async function acquire(pool, universityId, label) {
  await ensureTable(pool);
  const r = await pool.query(
    `INSERT INTO university_jobs (university_id, label, started_at, beat_at) VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (university_id) DO UPDATE SET label = EXCLUDED.label, started_at = NOW(), beat_at = NOW()
       WHERE university_jobs.beat_at < NOW() - ($3 || ' milliseconds')::interval
     RETURNING university_id`, [universityId, label, String(STALE_MS)]);
  if (r.rowCount) return { ok: true };
  return { ok: false, holder: await status(pool, universityId) };
}
async function beat(pool, universityId, label) {
  await pool.query(`UPDATE university_jobs SET beat_at = NOW(), label = COALESCE($2, label) WHERE university_id = $1`, [universityId, label || null]).catch(() => {});
}
async function release(pool, universityId) {
  await ensureTable(pool);
  await pool.query(`DELETE FROM university_jobs WHERE university_id = $1`, [universityId]).catch(() => {});
}
// The live holder, or null (a stale row reads as nothing running).
async function status(pool, universityId) {
  await ensureTable(pool);
  const r = (await pool.query(`SELECT label, started_at, beat_at, (NOW() - beat_at) > ($2 || ' milliseconds')::interval AS stale
                                 FROM university_jobs WHERE university_id = $1`, [universityId, String(STALE_MS)])).rows[0];
  if (!r) return null;
  return { label: r.label, startedAt: r.started_at, beatAt: r.beat_at, stale: !!r.stale };
}

// Run `work` holding the lock, beating while it runs, releasing however it ends.
async function run(pool, universityId, label, work) {
  const got = await acquire(pool, universityId, label);
  if (!got.ok) return { ok: false, busy: true, holder: got.holder };
  const t = setInterval(() => beat(pool, universityId), HEARTBEAT_MS);
  if (t.unref) t.unref();
  try { return { ok: true, result: await work((l) => beat(pool, universityId, l)) }; }
  finally { clearInterval(t); await release(pool, universityId); }
}

module.exports = { acquire, beat, release, status, run, ensureTable, HEARTBEAT_MS, STALE_MS };
