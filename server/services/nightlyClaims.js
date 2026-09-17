'use strict';
// ── THE NIGHT'S LOOP STOPS ───────────────────────────────────────────────────
//
// Two rules the ledger showed being broken: a discovery scan ("market
// refill", "widen") re-run for the same athlete again and again in one night,
// and the same business researched for the same athlete more than once. Both
// are counted in the database, keyed by the night, so every path into the
// fill (the nightly run, a resume, an on-demand fill, a second process) sees
// the same count. A service of its own because services/outreachQueue is
// pure by rule (tests/queue: it issues no SQL of its own).

const MAX_DISCOVERY_PER_ATHLETE_NIGHT = parseInt(process.env.OUTREACH_QUEUE_MAX_DISCOVERY_NIGHT, 10) || 5;
const RESEARCHED_TONIGHT_REASON = 'already researched for this athlete tonight';

// claimDiscovery(pool, athleteId, label, night) -> { ok, n }. n is the count
// AFTER this claim; ok is false once it passes the cap. A database failure
// says ok (the cap is a stop, not a gate the night should die on).
async function claimDiscovery(pool, athleteId, label, night) {
  try {
    const r = await pool.query(
      `INSERT INTO discovery_nightly (athlete_id, night, label, n) VALUES ($1, $2, $3, 1)
       ON CONFLICT (athlete_id, night, label) DO UPDATE SET n = discovery_nightly.n + 1
       RETURNING n`, [String(athleteId), night, String(label || 'discovery')]);
    const n = (r.rows[0] && r.rows[0].n) || 1;
    return { ok: n <= MAX_DISCOVERY_PER_ATHLETE_NIGHT, n };
  } catch (e) {
    console.warn('[queue] claimDiscovery failed: ' + e.message);
    return { ok: true, n: 0 };
  }
}

// claimResearch(pool, athleteId, brand, night) -> true the first time tonight,
// false after. Keyed on the folded brand name.
async function claimResearch(pool, athleteId, brand, night) {
  const key = String(brand || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return true;
  try {
    const r = await pool.query(
      `INSERT INTO research_claims (athlete_id, brand_key, night) VALUES ($1, $2, $3)
       ON CONFLICT (athlete_id, brand_key, night) DO NOTHING`, [String(athleteId), key, night]);
    return r.rowCount > 0;
  } catch (e) {
    console.warn('[queue] claimResearch failed: ' + e.message);
    return true;
  }
}

module.exports = { claimDiscovery, claimResearch, MAX_DISCOVERY_PER_ATHLETE_NIGHT, RESEARCHED_TONIGHT_REASON };
