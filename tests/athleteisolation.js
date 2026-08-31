'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
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
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// ONE ATHLETE THROWS. Does the rest of the roster still run?
//
// Not simulated with a stub loop -- the real fillAgent is driven, with a real
// throw injected into the real fillAthlete, against real Postgres, and the
// assertion is on what lands in outreach_queue_runs.details.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const Scout = require(ROOT + 'server/services/scout.js');
const job = require(ROOT + 'server/jobs/outreachQueue.js');
const SR = require(ROOT + 'server/services/shiftReport.js');
const SE = require(ROOT + 'server/services/shiftEmail.js');

const out = [];
const check = (n, c, d) => { out.push({ n, ok: !!c }); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d ? '   ' + d : '')); };

const AG = 'iso-agent';
const ROSTER = ['Amber Bretton', 'Boom Explodes', 'Carla Diaz', 'Devon Pike', 'Elena Ross'];

async function seed(P) {
  await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'Jordan','iso@x.com','x','agent','America/Chicago')`, [AG]);
  for (let i = 0; i < ROSTER.length; i++) {
    await P.query(`INSERT INTO athletes (id,agent_id,data,created_at)
                   VALUES ($1,$2,$3, NOW() - ($4||' minutes')::interval)`,
      ['iso-' + i, AG, JSON.stringify({ name: ROSTER[i], school: 'Alabama', dob: '2004-09-02' }),
        String(100 - i)]);
  }
}

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await seed(P);

  // NO TEST HOOKS IN PRODUCTION CODE. fillAthlete calls Scout.assembleSlate as a
  // property on the required module and does not guard it, so replacing that one
  // property makes the REAL fillAthlete throw for one athlete. Everything under
  // test -- the loop, the catch, the details entry -- is the shipping code.
  const seen = [];
  const realSlate = Scout.assembleSlate;
  Scout.assembleSlate = async (pool, ctx) => {
    const nm = (ctx.athlete && ctx.athlete.name) || ctx.athleteName || '';
    seen.push(nm);
    if (/Boom Explodes/.test(nm)) throw new Error('Places lookup exploded for this athlete');
    // A slate with no picks: the athlete completes normally with zero cards,
    // which is the healthy-but-empty path and needs no network.
    return { picks: [], laneCounts: {}, emptyReason: Scout.EMPTY.MARKET_EXHAUSTED,
      emptyText: 'nothing left in this market', signalCount: 0, localExhausted: false };
  };

  console.log('\n1. THE WHOLE ROSTER STILL RUNS');
  const res = await job.run({ agentId: AG, runDate: '2026-08-27' });
  console.log('    reached: ' + seen.join(' → '));
  check('every athlete was attempted, including the ones after the throw',
    seen.length === ROSTER.length, seen.length + '/' + ROSTER.length);
  check('the run completed rather than aborting', res && typeof res.filled === 'number',
    JSON.stringify(res));

  console.log('\n2. THE FAILURE IS RECORDED, NOT SWALLOWED');
  const row = (await P.query(
    `SELECT filled, finished_at, details FROM outreach_queue_runs WHERE agent_id=$1`, [AG])).rows[0];
  const details = row.details || [];
  check('the run row has one entry per athlete', details.length === ROSTER.length, 'details=' + details.length);
  const bad = details.find((d) => d.athleteName === 'Boom Explodes');
  check('the failed athlete is in details', !!bad, JSON.stringify(bad));
  check('  with an error field', bad && /exploded/.test(bad.error || ''), bad && bad.error);
  check('  a note a human can read', bad && /skipped/.test(bad.note || ''), bad && bad.note);
  check('  and filled 0', bad && Number(bad.filled) === 0);
  check('the run is stamped finished', !!row.finished_at);
  check('the healthy athletes completed with a recorded reason, not an error',
    details.filter((d) => !d.error && d.note).length === 4,
    JSON.stringify(details.filter((d) => !d.error).map((d) => d.note)));

  console.log('\n3. NO RETRY');
  check('the failed athlete was attempted exactly once',
    seen.filter((n) => n === 'Boom Explodes').length === 1,
    'attempts=' + seen.filter((n) => n === 'Boom Explodes').length);

  console.log('\n4. THE BACKOFF IS NOT POISONED BY OUR OWN BUG');
  const att = (await P.query(
    `SELECT athlete_id FROM outreach_queue_athlete_state WHERE athlete_id = 'iso-1'`)).rows;
  check('an errored athlete records no failed attempt (it would pause the roster)',
    att.length === 0, JSON.stringify(att));

  console.log('\n5. THE AGENT IS TOLD');
  const rep = await SR.buildShiftReport(P, AG);
  check('the report carries a faults block', !!(rep.faults && rep.faults.line), rep.faults && rep.faults.line);
  check('  naming the athlete', rep.faults && /Boom Explodes/.test(rep.faults.line));
  check('  and the reason', rep.faults && /exploded/.test(rep.faults.line));
  check('coverage counts the error separately', rep.coverage && rep.coverage.errored === 1,
    rep.coverage && rep.coverage.errored);
  const mail = SE.renderShiftEmail(rep, { agentName: 'Jordan' });
  check('the email says it in HTML', /Boom Explodes/.test(mail.html));
  check('  and in plain text', /Boom Explodes/.test(mail.text));
  check('  and says nothing was retried', /Nothing was retried/.test(mail.html));

  console.log('\n6. A CLEAN NIGHT SAYS NOTHING ABOUT FAULTS');
  await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id=$1`, [AG]);
  seen.length = 0;
  Scout.assembleSlate = async () => ({ picks: [], laneCounts: {},
    emptyReason: Scout.EMPTY.MARKET_EXHAUSTED, emptyText: 'nothing left in this market',
    signalCount: 0, localExhausted: false });
  await job.run({ agentId: AG, runDate: '2026-08-28' });
  const clean = await SR.buildShiftReport(P, AG);
  check('no faults block on a clean run', !clean.faults, JSON.stringify(clean.faults));
  const cleanMail = SE.renderShiftEmail(clean, { agentName: 'Jordan' });
  check('and the email is silent about it', !/was skipped by an error/.test(cleanMail.html + cleanMail.text));

  Scout.assembleSlate = realSlate;
  const failed = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - failed.length) + '/' + out.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
