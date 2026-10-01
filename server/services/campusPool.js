'use strict';
// ── A DEPARTMENT'S WHOLE TOWN, NOT A FIRST PAGE OF IT ────────────────────────
//
// A department has one town and wants to go hunting in it, so its pool has to
// be the town: Cypress had 667 businesses. This deepens a campus's pool
// (university_market_seen, migrations/014) ring by ring from Google Places,
// through the same discovery the team scan uses (teamScan.discover: blocked
// categories marked, never dropped silently), until it holds TARGET usable
// businesses or the widest ring is done. One market, one-time cost; the run
// and its cost are recorded on university_market_runs.
//
//   node scripts/campus-market.js --university univ-cypress --pool
const fs = require('fs');
const path = require('path');

const TARGET = parseInt(process.env.CAMPUS_POOL_TARGET, 10) || 1000;
const RINGS = String(process.env.CAMPUS_POOL_RINGS_M || '8000,12000,16000,20000,24000,32000').split(',')
  .map((x) => parseInt(x, 10)).filter((x) => x > 0);

async function ensureTables(pool) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '015_university_market_crm.sql'), 'utf8');
  for (const s of sql.replace(/--[^\n]*/g, '').split(';').map((x) => x.trim()).filter(Boolean)) await pool.query(s);
}

async function universityOf(pool, universityId) {
  const u = (await pool.query(`SELECT id, name, short_name, location FROM universities WHERE id = $1`, [universityId])).rows[0];
  if (!u) return null;
  const TS = require('./teamScan');
  const { marketPoolKey } = require('./regionKey');
  const team = (await pool.query(`SELECT market_key FROM university_teams WHERE university_id = $1 AND market_key IS NOT NULL LIMIT 1`, [universityId])).rows[0];
  return { ...u, marketKey: (team && team.market_key) || marketPoolKey(TS.cityOf(u.location)) || null };
}

async function poolCount(pool, marketKey) {
  const r = await pool.query(`SELECT COUNT(*) FILTER (WHERE blocked_reason IS NULL)::int AS usable, COUNT(*)::int AS total
                                FROM university_market_seen WHERE market_key = $1`, [marketKey]);
  return r.rows[0];
}

// Deepen until TARGET usable or the widest ring. opts: { places, target, rings, ringsFrom }
async function deepen(pool, universityId, opts = {}) {
  await ensureTables(pool);
  const TS = require('./teamScan');
  await TS.ensureTables(pool);
  const u = await universityOf(pool, universityId);
  if (!u) return { ok: false, error: `no university "${universityId}"` };
  if (!u.location || !u.marketKey) return { ok: false, error: `${u.name} has no campus address` };
  const target = opts.target || TARGET;
  const rings = opts.rings || RINGS;
  const before = await poolCount(pool, u.marketKey);
  const run = (await pool.query(`INSERT INTO university_market_runs (university_id, kind) VALUES ($1,'pool') RETURNING id`, [universityId])).rows[0].id;
  const steps = [];
  let placesCalls = 0, count = before;
  for (const radiusM of rings) {
    if (count.usable >= target) break;
    const d = await TS.discover(pool, { university: u, marketKey: u.marketKey, places: opts.places, radiusM });
    placesCalls += d.placesCalls || 0;
    count = await poolCount(pool, u.marketKey);
    steps.push({ radiusM, ok: d.ok, found: d.found || 0, placesCalls: d.placesCalls || 0, usable: count.usable, reason: d.ok ? null : d.reason });
    if (!d.ok) {
      require('./ourFault').record('google-places', `campus pool ring ${radiusM} m for ${u.name} failed: ${d.reason}`, 'campusPool ' + universityId).catch(() => {});
      break;
    }
  }
  const Q = require('./outreachQueue');
  const costUsd = Math.round(placesCalls * Q.USD_PER_PLACES_REQUEST * 100) / 100;
  const summary = { marketKey: u.marketKey, before, after: count, target, reached: count.usable >= target, steps, placesCalls, costUsd };
  await pool.query(`UPDATE university_market_runs SET finished_at = NOW(), summary = $2 WHERE id = $1`, [run, summary]);
  return { ok: true, university: u, ...summary };
}

module.exports = { deepen, poolCount, universityOf, ensureTables, TARGET, RINGS };
