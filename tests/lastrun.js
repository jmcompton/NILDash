'use strict';
// Runs from a checkout on any machine: repo-relative paths, overridable
// Postgres settings, and a startup wait the runner can shorten once the schema
// has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const ROOT = REPO;

// ── "4 BUSINESSES TRIED, NONE PASSED THE BAR" ───────────────────────────────
//
// outreach_queue holds a row only for a business that PASSED the bar. An athlete
// the nightly job worked all night and found nothing for leaves NO ROW THERE AT
// ALL -- so from the queue alone, an athlete we tried and an athlete nobody ran
// look identical, and both rendered as "slots full". On an athlete with zero
// cards that is not merely unhelpful, it is false: there are no slots to be full
// of. Six athletes read that page for nine consecutive days.
//
// The answer was already being written. fillAthlete composes the sentence and
// fillAgent persists it per athlete in outreach_queue_runs.details, every night,
// read by nothing an agent can see. This suite is about reading it back, and
// about the four cases NOT being collapsed into one:
//
//   the run tried and found nothing   -> the job's own sentence
//   the run did not include them      -> said as that, not as a market verdict
//   the run placed cards, all worked  -> the only case "slots full" ever meant
//   no run row at all                 -> never run, not "nothing passed"
//
// And one honesty rule that outranks all four: the newest run row is not always
// last night, so how stale it is gets said out loud.

const store = require(ROOT + 'server/store.js');
const H = require(ROOT + 'server/services/homeQueue.js');

let F = 0;
const ok = (n, c, g) => {
  if (c) console.log('  PASS ' + n);
  else { F++; console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

const AG = 'lr-agent', A1 = 'lr-ath-1', A2 = 'lr-ath-2';

// The shape fillAgent pushes, minus the fields this file does not read.
const detail = (o) => Object.assign({
  athleteId: null, athleteName: null, filled: 0, open: 5, note: null,
  tried: [], paused: false, emptyReason: null, noMarket: false, faults: 0,
  spentUsd: 0, spendLog: [],
}, o);

async function putRun(P, runDate, details) {
  await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id = $1`, [AG]);
  await P.query(
    `INSERT INTO outreach_queue_runs (agent_id, run_date, filled, spent_usd, details, finished_at)
     VALUES ($1, $2, 0, 0, $3, NOW())`, [AG, runDate, JSON.stringify(details)]);
}

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  for (const t of ['outreach_logs', 'outreach_queue', 'outreach_queue_runs', 'athletes']) {
    await P.query(`DELETE FROM ${t} WHERE agent_id = $1`, [AG]).catch(() => {});
  }
  await P.query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  await P.query(
    `INSERT INTO users (id,name,email,password,role) VALUES ($1,'LR','lr@x.example','x','agent')`, [AG]);
  for (const [id, name] of [[A1, 'Amber Bretton'], [A2, 'Noah Carpenter']]) {
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
      [id, AG, JSON.stringify({ name, school: 'Auburn', over18: true })]);
  }

  // Dates relative to now, so this suite does not rot on a fixed calendar.
  const day = (n) => {
    const d = new Date(Date.now() - n * 86400000);
    return d.toISOString().slice(0, 10);
  };

  console.log('\n-- 1. TRIED AND FOUND NOTHING: the job\'s own sentence --');
  {
    await putRun(P, day(1), [
      detail({ athleteId: A1, athleteName: 'Amber Bretton',
        note: '4 businesses tried, none passed the bar',
        emptyReason: 'below-bar', tried: [1, 2, 3, 4] }),
    ]);
    const h = await H.buildHome(P, AG, { athleteId: A1 });
    ok('no read errors', h.errors.length === 0, h.errors);
    ok('the empty athlete carries last night\'s reason', !!h.lastRun, h.lastRun);
    ok('  VERBATIM, not paraphrased',
      h.lastRun.note === '4 businesses tried, none passed the bar', h.lastRun.note);
    ok('  with the structured cause alongside the prose',
      h.lastRun.emptyReason === 'below-bar', h.lastRun.emptyReason);
    ok('  and the count of what was tried', h.lastRun.tried === 4, h.lastRun.tried);
    ok('  said to be last night, because it was', h.lastRun.when === 'Last night', h.lastRun.when);
    ok('  and marked as a night this athlete was actually in', h.lastRun.ran === true, h.lastRun.ran);
  }

  console.log('\n-- 2. A RUN THAT SKIPPED THIS ATHLETE IS NOT A VERDICT ON THEIR MARKET --');
  {
    // The run happened; A2 is not in it. Reporting A1's reason here, or any
    // reason at all, would be describing work that was never done for them.
    const h = await H.buildHome(P, AG, { athleteId: A2 });
    ok('the run row is still read', !!h.lastRun, h.lastRun);
    ok('  but this athlete is marked as NOT in it', h.lastRun.ran === false, h.lastRun.ran);
    ok('  and carries no borrowed reason', h.lastRun.note === null, h.lastRun.note);
    ok('  nor a borrowed cause', h.lastRun.emptyReason === null, h.lastRun.emptyReason);
  }

  console.log('\n-- 3. OUR FAULTS ARE COUNTED SEPARATELY FROM THEIR MARKET --');
  {
    await putRun(P, day(1), [
      detail({ athleteId: A1, note: '3 businesses tried, none passed the bar (3 failed on our side, not theirs)',
        emptyReason: 'our-fault', tried: [1, 2, 3], faults: 3 }),
    ]);
    const h = await H.buildHome(P, AG, { athleteId: A1 });
    ok('the fault count survives to the page', h.lastRun.faults === 3, h.lastRun.faults);
    ok('  and is named as ours by the stored cause',
      h.lastRun.emptyReason === 'our-fault', h.lastRun.emptyReason);
  }

  console.log('\n-- 4. NINE DAYS OF SILENCE MUST NOT READ AS "LAST NIGHT" --');
  {
    // The exact shape of the incident this whole line exists for: a paused
    // roster whose newest run row was nine days old.
    await putRun(P, day(9), [
      detail({ athleteId: A1, note: 'no candidates were tried', emptyReason: 'paused', paused: true }),
    ]);
    const h = await H.buildHome(P, AG, { athleteId: A1 });
    ok('A NINE-DAY-OLD ROW SAYS SO', h.lastRun.when === '9 nights ago', h.lastRun.when);
    ok('  and still gives up its reason', h.lastRun.note === 'no candidates were tried', h.lastRun.note);
  }

  console.log('\n-- 5. CARDS PLACED AND ALL WORKED: the one case "slots full" meant --');
  {
    await putRun(P, day(1), [detail({ athleteId: A1, filled: 5, note: null, open: 0 })]);
    const h = await H.buildHome(P, AG, { athleteId: A1 });
    ok('a full night has no reason to report', h.lastRun.note === null, h.lastRun.note);
    ok('  and reports what it placed instead', h.lastRun.filled === 5, h.lastRun.filled);
  }

  console.log('\n-- 6. NO RUN AT ALL IS NOT "NOTHING PASSED THE BAR" --');
  {
    await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id = $1`, [AG]);
    const h = await H.buildHome(P, AG, { athleteId: A1 });
    ok('lastRun is null when the job has never completed', h.lastRun === null, h.lastRun);
    ok('  and that is not reported as an error', h.errors.length === 0, h.errors);
  }

  console.log('\n-- 7. THE NEWEST ROW WINS, not the one that mentions this athlete --');
  {
    // A stale row that HAS an answer must not outrank a fresh row that does not.
    // Otherwise the page would happily print a week-old verdict as today's.
    await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id = $1`, [AG]);
    await P.query(
      `INSERT INTO outreach_queue_runs (agent_id, run_date, filled, spent_usd, details, finished_at)
       VALUES ($1,$2,0,0,$3,NOW())`,
      [AG, day(4), JSON.stringify([detail({ athleteId: A1, note: 'stale answer' })])]);
    await P.query(
      `INSERT INTO outreach_queue_runs (agent_id, run_date, filled, spent_usd, details, finished_at)
       VALUES ($1,$2,0,0,$3,NOW())`,
      [AG, day(1), JSON.stringify([detail({ athleteId: A2, note: 'fresh answer' })])]);
    const h = await H.buildHome(P, AG, { athleteId: A1 });
    ok('the fresher run is the one read', h.lastRun.when === 'Last night', h.lastRun.when);
    ok('  and the stale answer is NOT resurrected', h.lastRun.note === null, h.lastRun.note);
    ok('  with this athlete marked absent from it', h.lastRun.ran === false, h.lastRun.ran);
  }

  console.log('\n-- 8. A BROKEN READ NEVER EMPTIES THE PAGE --');
  {
    // Every read in buildHome is wrapped precisely because a swallowed query
    // renders identically to a quiet morning. This one has to fail loudly on
    // the payload rather than quietly returning no reason.
    const bad = {
      query: (sql, params) => (/outreach_queue_runs/.test(sql)
        ? Promise.reject(new Error('boom'))
        : P.query(sql, params)),
    };
    const h = await H.buildHome(bad, AG, { athleteId: A1 });
    ok('the roster still renders', h.athletes.length === 2, h.athletes.length);
    ok('  lastRun is null rather than invented', h.lastRun === null, h.lastRun);
    ok('  AND the failure is reported, not swallowed',
      h.errors.some((e) => /last run: boom/.test(e)), h.errors);
  }

  console.log('\nfailures: ' + F);
  await P.end().catch(() => {});
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('FAULT ' + e.message); process.exit(2); });
