'use strict';
// ── HOW MANY ATHLETES THE POSITION CHECK HAS BEEN REFUSING ──────────────────
//
// The writer's fact check turned a stored position into ONE group: the first
// part it recognised. "Infielder / Shortstop" was "infielder", so a pitch that
// said "shortstop" was refused as a false claim, on every business, every
// night. J'Kai'a Graves: eight businesses with confirmed owners, zero cards.
// Fixed in services/pitchWriter (positionKeys: every part counts). This says
// how bad it has been.
//
//   1. MEASURED: every business the writer refused for "says X but the stored
//      position is Y", per athlete, from the nightly run rows (details[].tried
//      reasons), with nights and dates. Also the cards that cost a rewrite
//      for it (refused on the first draft, placed on the retry). On-demand
//      fills write no run row, so this undercounts slightly.
//   2. EXPOSED: every athlete whose stored position lists more than one, run
//      through the shipped position check: COULD FAIL when the parts are
//      different groups (the writer using any part but the first was
//      refused), safe when every part is the same group.
//
//   node scripts/position-audit.js            read-only; there is no --apply
//   /api/admin/scripts/position-audit?text=1
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const PW = require(ROOT + 'server/services/pitchWriter.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const REFUSAL = 'but the stored position is';
const SPLIT = /\s*(?:\/|,|&|\+|\||\band\b|\bor\b)\s*/i;

// The position as the OLD check saw it (one group, the first recognised) and
// as the fixed one does (every part's group).
function exposure(position, sport) {
  const parts = String(position || '').split(SPLIT).map((s) => s.trim()).filter(Boolean);
  const groups = [...new Set(parts.map((p) => PW.positionKey(p, sport)).filter(Boolean))];
  const oldKey = PW.positionKey(position, sport);
  return { parts, groups, oldKey, couldFail: groups.length > 1,
    refusedWords: parts.filter((p) => { const k = PW.positionKey(p, sport); return k && oldKey && k !== oldKey; }) };
}

async function measured(P) {
  const rows = (await P.query(
    `SELECT r.run_date, r.agent_id, d->>'athleteId' AS athlete_id, d->>'athleteName' AS athlete, x->>'reason' AS reason,
            x->>'result' AS result, (x->'writerFirstProblems')::text AS first_problems
       FROM outreach_queue_runs r
       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.details) = 'array' THEN r.details ELSE '[]'::jsonb END) d
       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d->'tried') = 'array' THEN d->'tried' ELSE '[]'::jsonb END) x
      WHERE x->>'reason' LIKE $1 OR (x->'writerFirstProblems')::text LIKE $1`, ['%' + REFUSAL + '%'])).rows;
  const by = new Map();
  for (const r of rows) {
    const k = r.athlete_id || r.athlete;
    const a = by.get(k) || { athlete: r.athlete, athleteId: r.athlete_id, agentId: r.agent_id, refused: 0, retried: 0, nights: new Set(), first: null, last: null, stored: null };
    const refused = r.result !== 'queued' && String(r.reason || '').includes(REFUSAL);
    if (refused) a.refused++; else a.retried++;
    const day = r.run_date instanceof Date ? r.run_date.toISOString().slice(0, 10) : String(r.run_date).slice(0, 10);
    if (refused) a.nights.add(day);
    a.first = !a.first || day < a.first ? day : a.first;
    a.last = !a.last || day > a.last ? day : a.last;
    const m = String(r.reason || r.first_problems || '').match(/stored position is \\?"([^"\\]*)\\?"/);
    if (m && !a.stored) a.stored = m[1];
    by.set(k, a);
  }
  return [...by.values()].sort((a, b) => b.refused - a.refused || b.retried - a.retried);
}

async function exposed(P) {
  const rows = (await P.query(
    `SELECT a.id, a.data->>'name' AS athlete, a.data->>'sport' AS sport, a.data->>'position' AS position, u.name AS agent, u.email AS agent_email
       FROM athletes a LEFT JOIN users u ON u.id = a.agent_id
      WHERE a.data->>'position' ~* '(/|,|&|\\+|\\|)|\\m(and|or)\\M'
      ORDER BY u.name NULLS LAST, a.data->>'name'`)).rows;
  return rows.map((r) => ({ ...r, ...exposure(r.position, r.sport) }));
}

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const out = [];
  const say = (...l) => out.push(...l);
  say('POSITION AUDIT (read-only)', '');

  const m = await measured(P);
  const refusedTotal = m.reduce((s, a) => s + a.refused, 0);
  const retriedTotal = m.reduce((s, a) => s + a.retried, 0);
  const lost = m.filter((a) => a.refused > 0);
  say(`1. MEASURED: ${lost.length} athlete(s), ${refusedTotal} business(es) refused for "${REFUSAL} ...", `
    + `plus ${retriedTotal} card(s) that cost a rewrite for it; nightly run rows, all history`);
  for (const a of m) {
    say(`   ${String(a.refused).padStart(4)} refused  ${String(a.retried).padStart(3)} rewritten  ${String(a.nights.size).padStart(3)} night(s)  `
      + `${a.first || '?'} .. ${a.last || '?'}  ${a.athlete || a.athleteId}  [${a.stored || 'position not in the reason'}]`);
  }
  if (!m.length) say('   none recorded');

  const x = await exposed(P);
  const could = x.filter((r) => r.couldFail);
  say('', `2. EXPOSED: ${x.length} athlete(s) with a stored position that lists more than one; `
    + `${could.length} COULD FAIL (parts in different groups), ${x.length - could.length} safe (every part the same group)`);
  for (const r of could) {
    say(`   COULD FAIL  ${r.athlete}  (${r.agent || r.agent_email || 'no agent'})  ${r.sport || '?'}  "${r.position}"  `
      + `-- the old check read it as "${r.oldKey}"; refused whenever the pitch said: ${r.refusedWords.join(', ')}`);
  }
  for (const r of x.filter((y) => !y.couldFail)) say(`   safe        ${r.athlete}  (${r.agent || r.agent_email || 'no agent'})  ${r.sport || '?'}  "${r.position}"`);

  say('', `SUMMARY: ${lost.length} athlete(s) lost ${refusedTotal} business(es) to the position check; `
    + `${could.length} athlete(s) hold a position the old check could refuse. Fixed: every part of a position now counts.`);
  console.log(out.join('\n'));
  try { await P.end(); } catch (_) {}
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error('position-audit: FAILED', e.message); process.exit(1); });
module.exports = { exposure, measured, exposed, REFUSAL };
