#!/usr/bin/env node
'use strict';
// ── WHY AN AGENT GOT ZERO CARDS LAST NIGHT ───────────────────────────────────
//
//   node scripts/why-zero.js --agent cs@9091sportsagency.com
//   node scripts/why-zero.js --agent cs@9091sportsagency.com --date 2026-09-15
//
// Report only. Writes nothing.
//
// For the agent: the user row (role, archived, last login), whether the
// nightly run claimed them at all for that date, and the run row's note.
// Then for EVERY athlete on the roster:
//   cards     how many cards are queued right now, which slots, how old
//   last run  the run row's entry for this athlete: filled, open, tried,
//             the note, the empty reason, paused -- or "no entry", which
//             means the loop never reached them
//   state     the athlete_state row: consecutive failures, paused since
//   market    what the record resolves to: market, source, or the note
//             saying why the local lane has no town
// "tried=0" has exactly these causes in the job, and each leaves one of
// those marks: slots full (5 queued cards), paused (three-nights backoff),
// no market and no other lane, the agent's cap spent before this athlete, or
// an exception ("this athlete was skipped: ..."). A missing run row means the
// scheduler never claimed the agent that night.

const store = require('../server/store');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;

process.exitCode = 1;
let settled = false;
process.on('beforeExit', () => { if (!settled) { console.log('why-zero: main() never settled. Exiting 1.'); process.exit(1); } });
function fail(where, e) { const m = `why-zero: FAILED (${where}): ${e && e.message ? e.message : e}`; console.log(m); console.error(m); settled = true; process.exit(1); }
function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; }
function target() {
  const url = process.env.DATABASE_URL;
  if (url) { try { const u = new URL(url); return `DATABASE_URL -> ${u.hostname}${u.pathname} (ssl)`; } catch (_) { return 'DATABASE_URL'; } }
  return `PG* env -> ${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}`;
}
const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n);
const ago = (d) => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) + 'd ago' : 'never';

async function main() {
  const who = arg('agent', null);
  if (!who) return fail('args', new Error('give --agent <email or id>'));
  const date = arg('date', null);
  console.log(`why-zero: connecting via ${target()}`);
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;

  let u;
  try {
    u = (await P.query(`SELECT id, email, role, archived, last_login, created_at FROM users
                         WHERE id = $1 OR LOWER(TRIM(email)) = LOWER(TRIM($1)) LIMIT 1`, [who])).rows[0];
  } catch (e) { return fail('user', e); }
  if (!u) { console.log(`\nNo user matches "${who}". Done.\n`); settled = true; process.exit(0); }
  console.log(`\nAGENT ${u.email} (${u.id})  role=${u.role}  archived=${u.archived === true}  last login ${ago(u.last_login)} (${u.last_login ? String(u.last_login).slice(0, 10) : 'never'})`);
  const eligible = ['agent', 'admin'].includes(u.role) && u.archived !== true;
  console.log(`   nightly run selects this user: ${eligible ? 'YES' : 'NO (role must be agent/admin and archived must not be true)'}`);

  let run;
  try {
    run = (await P.query(
      `SELECT run_date, filled, spent_usd, note, details, created_at, finished_at FROM outreach_queue_runs
        WHERE agent_id = $1 ${date ? 'AND run_date = $2' : ''} ORDER BY run_date DESC LIMIT 1`,
      date ? [u.id, date] : [u.id])).rows[0];
  } catch (e) { return fail('runs', e); }
  if (!run) {
    console.log(`   RUN ROW: none${date ? ' for ' + date : ' at all'}. The scheduler never claimed this agent${date ? ' that night' : ''}: OUTREACH_QUEUE_ENABLED off, the window never fired, or the agent was not selected.`);
  } else {
    console.log(`   RUN ROW: ${String(run.run_date).slice(0, 10)}  claimed ${String(run.created_at).slice(0, 19)}  finished ${run.finished_at ? String(run.finished_at).slice(0, 19) : 'NEVER (crashed or still running)'}  filled=${run.filled}  spent=$${Number(run.spent_usd || 0).toFixed(2)}`);
    if (run.note) console.log(`   run note: ${run.note}`);
  }
  const details = run && Array.isArray(run.details) ? run.details : [];
  const byAthlete = new Map(details.map((d) => [d.athleteId, d]));

  let athletes;
  try {
    athletes = (await P.query(`SELECT id, data, created_at FROM athletes WHERE agent_id = $1 ORDER BY created_at ASC`, [u.id])).rows;
  } catch (e) { return fail('athletes', e); }
  console.log(`\n${athletes.length} athlete(s); ${details.length} appear in the run row${run ? '' : ' (no run row)'}\n`);

  const Job = require('../server/jobs/outreachQueue');
  const AR = require('../server/services/athleteRecord');
  const ai = require('../server/ai');
  for (const a of athletes) {
    const d = a.data || {};
    const name = d.name || a.id;
    const cards = (await P.query(
      `SELECT slot, channel, brand_name, created_at FROM outreach_queue WHERE athlete_id = $1 AND state = 'queued' ORDER BY slot`, [a.id]).catch(() => ({ rows: [] }))).rows;
    const st = (await P.query(
      `SELECT consecutive_failures, last_attempt_date, paused_at, paused_reason FROM outreach_queue_athlete_state WHERE athlete_id = $1`, [a.id]).catch(() => ({ rows: [] }))).rows[0];
    let rec = null;
    try { rec = AR.resolveAthlete(a, { schoolLocation: ai.lookupSchoolLocation }); } catch (_) {}
    const entry = byAthlete.get(a.id);

    console.log(`── ${name}  (${a.id})  ${d.athleteType === 'pro' ? 'PRO ' + (d.team || '') + ' / ' + (d.city || '') : 'school: ' + (d.school || 'MISSING')}`);
    console.log(`   cards queued now: ${cards.length}${cards.length ? '  slots ' + cards.map((c) => c.slot + ':' + c.channel + ' ' + ago(c.created_at)).join(', ') : ''}${cards.length >= 5 ? '   <- ALL SLOTS HELD: the job cannot place anything until these are worked or expire' : ''}`);
    if (!entry) console.log(`   last run: NO ENTRY for this athlete -- the loop never reached them (cap spent earlier, run crashed, or roster changed since)`);
    else {
      console.log(`   last run: filled=${entry.filled} open=${entry.open === null || entry.open === undefined ? '?' : entry.open} tried=${(entry.tried || []).length}${entry.paused ? ' PAUSED' : ''}${entry.emptyReason ? ' reason=' + entry.emptyReason : ''}${entry.faults ? ' faults=' + entry.faults : ''}`);
      if (entry.note) console.log(`   note: ${entry.note}`);
    }
    if (st) console.log(`   state: failures=${st.consecutive_failures || 0} last attempt ${st.last_attempt_date ? String(st.last_attempt_date).slice(0, 10) : 'never'}${st.paused_at ? '  PAUSED since ' + String(st.paused_at).slice(0, 10) + ' (' + (st.paused_reason || 'no reason recorded') + ')' : ''}`);
    else console.log('   state: no state row (never attempted, or attempts never recorded)');
    if (rec) {
      const geocoded = !rec.market && rec.school ? '(the nightly run would try a geocode; not attempted here)' : '';
      console.log(`   market: ${rec.market ? rec.market + ' (' + rec.marketSource + ')' : 'NONE ' + geocoded}${rec.localLaneNote ? '  ' + rec.localLaneNote : ''}${rec.stateNote ? '  STATE: ' + rec.stateNote : ''}`);
    }
    console.log('');
  }
  console.log('Done.\n');
  settled = true;
  await P.end().catch(() => {});
  process.exit(0);
}
main().catch((e) => fail('main', e));
