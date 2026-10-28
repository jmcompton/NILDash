'use strict';
// ── STILL TRUE? THE LAST LOOK BEFORE AN AUTOMATIC SEND ───────────────────────
//
// Automatic sending (services/autoSend) puts a pitch in front of a business
// with nobody reading it first. A draft can sit for days, and in that time an
// athlete can transfer, change position or leave the roster. "Jay plays guard
// at Texas State" sent after Jay moved schools is the email that costs the
// agent their name. So every pitch gets one last look right before it goes,
// and anything that is no longer true, or was never good enough to send
// unread, waits for the agent instead.
//
// A pitch waits (it stays a draft; nothing is deleted) when:
//   - the athlete is gone from this agent's roster;
//   - the athlete's school, sport, position, class year or team changed since
//     the pitch was written (from the facts saved with the draft);
//   - for a draft written before facts were saved, when the athlete was
//     edited after it: a fact in the pitch no longer matches the athlete on
//     file (pitchWriter.verifyAthleteFacts);
//   - a blank or placeholder is left in it;
//   - it was written by the plain fallback, not the pitch writer;
//   - the card was thin (little known about the business).
// It fails closed: a pitch that cannot be checked waits.

const KEYS = ['school', 'sport', 'position', 'year', 'team'];
const LABEL = { school: 'school', sport: 'sport', position: 'position', year: 'class year', team: 'team' };

let _ensured = false;
async function ensureColumns(pool) {
  if (_ensured) return;
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS athlete_facts JSONB`);
  _ensured = true;
}

const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The facts a pitch rests on, from athletes.data.
function factsOf(data) {
  const d = data || {};
  const pick = { school: d.school, sport: d.sport, position: d.position, year: d.year || d.classYear, team: d.team || d.currentTeam };
  const out = {};
  for (const k of KEYS) { const v = String(pick[k] == null ? '' : pick[k]).trim(); if (v) out[k] = v; }
  return out;
}

// What changed, in plain words. Only a fact that was set when the pitch was
// written counts: adding a position the pitch never mentioned changes nothing.
function changes(then, now) {
  const out = [];
  for (const k of KEYS) {
    if (!then || !then[k]) continue;
    if (norm(then[k]) !== norm(now && now[k])) {
      out.push(now && now[k] ? `the athlete's ${LABEL[k]} changed from ${then[k]} to ${now[k]}` : `the athlete's ${LABEL[k]} (${then[k]}) is no longer on file`);
    }
  }
  return out;
}

// Saved with the draft when it is written (jobs/outreachQueue.insertCard).
async function snapshot(pool, logId, athleteId) {
  if (!logId || !athleteId) return;
  await ensureColumns(pool);
  const r = await pool.query(`SELECT data FROM athletes WHERE id = $1`, [athleteId]);
  if (!r.rows[0]) return;
  await pool.query(`UPDATE outreach_logs SET athlete_facts = $2 WHERE id = $1 AND athlete_facts IS NULL`,
    [logId, JSON.stringify(factsOf(r.rows[0].data))]);
}

const textOf = (html) => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// Facts about who the athlete IS. Follower counts move every day and are not
// a reason to hold a pitch.
const IDENTITY = /position|sport|year|hometown|school|team|college|pro\b|student/i;

function reasonFor(row, agentId, deps) {
  if (!row.a_agent || String(row.a_agent) !== String(agentId)) return 'the athlete is no longer on your roster';
  const data = row.adata || {};
  if (data.archived === true || /^(inactive|archived|removed)$/i.test(String(data.status || ''))) return 'the athlete is no longer active';
  const now = factsOf(data);
  if (row.athlete_facts) {
    const c = changes(row.athlete_facts, now);
    if (c.length) return c[0];
  } else if (row.a_updated && row.l_created && new Date(row.a_updated) > new Date(row.l_created)) {
    // Written before facts were saved with drafts, and the athlete was edited
    // since: re-read the pitch against the athlete as they are now. An athlete
    // untouched since the pitch was written passed this same check then.
    const PW = require('./pitchWriter');
    const prof = deps.profileOf ? deps.profileOf(row) : require('../jobs/outreachQueue').athleteProfile({ id: row.athlete_id, agent_id: row.a_agent, data });
    const f = PW.verifyAthleteFacts(textOf(row.body_html), prof || {});
    const p = (f.problems || []).filter((x) => IDENTITY.test(x));
    if (p.length) return 'the pitch no longer matches the athlete: ' + p[0];
  }
  if (require('./placeholders').has(textOf(row.body_html))) return 'a blank was left in the pitch';
  if (row.source === 'nightly-queue' && !row.angle) return 'it was written without the pitch writer, so it needs your eyes';
  if (row.thin) return 'NILDash had little to go on for this business';
  return null;
}

// ids -> { ok: Set(id), reasons: Map(id -> plain reason) }
async function check(pool, agentId, ids, deps = {}) {
  const want = (ids || []).map(String);
  const ok = new Set();
  const reasons = new Map();
  if (!want.length) return { ok, reasons };
  await ensureColumns(pool);
  const rows = (await pool.query(
    `SELECT l.id, l.athlete_id, l.body_html, l.source, l.angle, l.athlete_facts, l.created_at AS l_created,
            a.data AS adata, a.agent_id AS a_agent, a.updated_at AS a_updated,
            EXISTS (SELECT 1 FROM outreach_queue q WHERE q.outreach_log_id = l.id AND q.thin IS TRUE) AS thin
       FROM outreach_logs l LEFT JOIN athletes a ON a.id = l.athlete_id
      WHERE l.id = ANY($1::text[])`, [want])).rows;
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  for (const id of want) {
    const row = byId.get(id);
    let why = null;
    try { why = row ? reasonFor(row, agentId, deps) : 'it could not be found to check'; }
    catch (e) { console.error(`[still-true] could not check ${id}: ${e.message}`); why = 'it could not be checked'; }
    if (why) reasons.set(id, why); else ok.add(id);
  }
  return { ok, reasons };
}

module.exports = { check, snapshot, factsOf, changes, ensureColumns, textOf, KEYS, _reset() { _ensured = false; } };
