'use strict';
// ── AN AMBIGUOUS SCHOOL THAT IS ALREADY WORKING KEEPS WORKING ───────────────
//
// A bare name that is more than one school ("Kentucky", "Miami") is asked, not
// guessed (schoolResolver.ambiguity). But switching off an athlete who is
// already producing cards in the right town, to prevent a bug that hit nobody,
// is a regression: the audit found four ("Kentucky" -> Lexington, "Arkansas" ->
// Fayetteville, "Minnesota" -> Minneapolis, "Iowa" -> Iowa City), every one
// correct.
//
// So per athlete: if the market the name resolved to BEFORE the stop
// (resolveSchool with ignoreAmbiguity) has produced cards for them, that
// market is kept, the night runs as before, and Home asks passively (a note
// they can dismiss). Only an athlete with no working market is stopped.
//
// Loaded at boot and at the start of every nightly run, so the resolver's
// synchronous callers (athleteRecord) can ask keepFor(athleteId).
const _keep = new Map();     // athleteId -> { city, state, market, cards }
const _dismissed = new Set(); // athleteId: the agent dismissed the passive note

let canon = (x) => String(x || '').trim().toLowerCase();
try { canon = require('./regionKey').canonicalRegion || canon; } catch (_) {}

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS school_question_dismissed (
    athlete_id TEXT PRIMARY KEY, agent_id TEXT, school TEXT, dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

async function load(pool) {
  const R = require('./schoolResolver');
  try {
    await ensureTable(pool);
    const rows = (await pool.query(`SELECT id, data->>'school' AS school, data->>'state' AS state FROM athletes
                                     WHERE COALESCE(data->>'school', '') <> ''`)).rows;
    const next = new Map();
    for (const a of rows) {
      const amb = R.ambiguity(a.school, { state: a.state });
      if (!amb || !amb.candidates) continue;
      const was = R.resolveSchool(a.school, { ignoreAmbiguity: true });
      if (!was || !was.city) continue;
      const st = R.stateCode(was.state || '') || was.state;
      const market = `${was.city}, ${st}`;
      const n = (await pool.query(`SELECT COUNT(*)::int n FROM outreach_queue WHERE athlete_id = $1 AND market_key = $2`,
        [a.id, canon(market)])).rows[0].n;
      if (n > 0) next.set(a.id, { city: was.city, state: st, market, cards: n });
    }
    _keep.clear();
    for (const [k, v] of next) _keep.set(k, v);
    const d = (await pool.query(`SELECT athlete_id FROM school_question_dismissed`)).rows;
    _dismissed.clear();
    for (const r of d) _dismissed.add(r.athlete_id);
    return _keep.size;
  } catch (e) {
    console.error('[schoolKeep] load:', e.message);
    return 0;
  }
}

function keepFor(athleteId) { return athleteId ? (_keep.get(String(athleteId)) || null) : null; }
function dismissed(athleteId) { return _dismissed.has(String(athleteId)); }

async function dismiss(pool, agentId, athleteId) {
  await ensureTable(pool);
  const a = (await pool.query(`SELECT id, data->>'school' AS school FROM athletes WHERE id = $1 AND agent_id = $2`, [athleteId, agentId])).rows[0];
  if (!a) return { ok: false, status: 404, error: 'Athlete not found' };
  await pool.query(`INSERT INTO school_question_dismissed (athlete_id, agent_id, school) VALUES ($1,$2,$3)
                    ON CONFLICT (athlete_id) DO UPDATE SET dismissed_at = NOW(), school = EXCLUDED.school`, [a.id, agentId, a.school]);
  _dismissed.add(String(a.id));
  return { ok: true };
}

function _setForTests(id, v) { if (v) _keep.set(id, v); else _keep.delete(id); }
function _reset() { _keep.clear(); _dismissed.clear(); }

module.exports = { load, keepFor, dismissed, dismiss, ensureTable, _setForTests, _reset };
