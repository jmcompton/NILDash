'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/inactiveskip.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── AN AGENT WHO HAS NOT SIGNED IN FOR 14 DAYS IS SKIPPED, WITH THE REASON ──
//
// Their cards expire unworked and the spend buys nothing. The scheduled run
// writes a run row whose note says "skipped: last login N days ago", so the
// shift report and Home say why. It resumes on its own: last_login moves on
// the next sign-in and the next night fills them. A run for one named agent
// never skips.

const store = require(REPO + 'server/store.js');
const Job = require(REPO + 'server/jobs/outreachQueue.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;
const IDS = ['ia-fresh', 'ia-stale', 'ia-never'];
const DAY = 86400000;

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const clean = async () => {
    await P().query(`DELETE FROM outreach_queue_runs WHERE agent_id = ANY($1)`, [IDS]).catch(() => {});
    await P().query(`DELETE FROM users WHERE id = ANY($1)`, [IDS]).catch(() => {});
  };
  await clean();

  // ── 1. THE RULE ──────────────────────────────────────────────────────────
  OUT.push('-- the rule --');
  const now = new Date('2026-09-15T08:00:00Z');
  ok('14 days is the line', Job.INACTIVE_AFTER_DAYS === 14, Job.INACTIVE_AFTER_DAYS);
  ok('a login 3 days ago is not skipped', Job.inactiveSkip({ last_login: new Date(now - 3 * DAY) }, now) === null);
  ok('a login exactly 14 days ago is not skipped', Job.inactiveSkip({ last_login: new Date(now - 14 * DAY) }, now) === null);
  const why15 = Job.inactiveSkip({ last_login: new Date(now - 15 * DAY) }, now);
  ok('a login 15 days ago is skipped, with the count and the date', /^skipped: last login 15 days ago \(2026-08-31\)/.test(why15), why15);
  ok('  and the note says how it resumes', /resumes the night after they next sign in/.test(why15), why15);
  const whyNever = Job.inactiveSkip({ last_login: null }, now);
  ok('never signed in is skipped, and says so', /never signed in/.test(whyNever), whyNever);
  ok('a junk date is treated as never', /never signed in/.test(Job.inactiveSkip({ last_login: 'not a date' }, now)));

  // ── 2. THE RUN ───────────────────────────────────────────────────────────
  OUT.push('', '-- the scheduled run writes the skip as a run row --');
  // Three agents with no athletes: the fresh one is claimed and fills nothing
  // (an empty roster is fast and needs no network); the stale one is skipped;
  // the never-signed-in one is skipped.
  await P().query(`INSERT INTO users (id,name,email,password,role,last_login) VALUES
    ('ia-fresh','Fresh','ia-fresh@x.com','x','agent',NOW() - INTERVAL '2 days'),
    ('ia-stale','Stale','ia-stale@x.com','x','agent',NOW() - INTERVAL '20 days'),
    ('ia-never','Never','ia-never@x.com','x','agent',NULL)`);
  const runDate = '2099-01-01';   // a date no real run will ever claim
  const before = (await P().query(`SELECT COUNT(*)::int n FROM outreach_queue_runs WHERE run_date = $1`, [runDate])).rows[0].n;
  const out = await Job.run({ runDate });
  ok('the run reports how many it skipped', out.skipped >= 2, out);
  const rows = (await P().query(
    `SELECT agent_id, filled, note, finished_at, details FROM outreach_queue_runs WHERE run_date = $1 AND agent_id = ANY($2) ORDER BY agent_id`, [runDate, IDS])).rows;
  const stale = rows.find((r) => r.agent_id === 'ia-stale');
  const never = rows.find((r) => r.agent_id === 'ia-never');
  const fresh = rows.find((r) => r.agent_id === 'ia-fresh');
  ok('the stale agent has a run row', !!stale, rows.map((r) => r.agent_id));
  ok('  filled 0, finished, with the skip reason in the note', stale && stale.filled === 0 && stale.finished_at && /^skipped: last login 20 days ago/.test(stale.note || ''), stale);
  ok('  and an empty details list, not a missing one', stale && Array.isArray(stale.details) && stale.details.length === 0, stale && stale.details);
  ok('the never-signed-in agent has a row saying so', never && /never signed in/.test(never.note || ''), never && never.note);
  ok('the fresh agent was claimed and filled normally (empty roster, nothing to do)', fresh && !/^skipped/.test(fresh.note || ''), fresh);

  // ── 3. IT RESUMES ON ITS OWN ─────────────────────────────────────────────
  OUT.push('', '-- a sign-in lifts it for the next night --');
  await P().query(`UPDATE users SET last_login = NOW() WHERE id = 'ia-stale'`);
  const runDate2 = '2099-01-02';
  await Job.run({ runDate: runDate2 });
  const stale2 = (await P().query(`SELECT note FROM outreach_queue_runs WHERE run_date = $1 AND agent_id = 'ia-stale'`, [runDate2])).rows[0];
  ok('after a sign-in the next run claims the agent and does not skip', stale2 && !/^skipped/.test(stale2.note || ''), stale2);

  // ── 4. A NAMED RUN NEVER SKIPS ───────────────────────────────────────────
  OUT.push('', '-- a run for one named agent always fills --');
  const runDate3 = '2099-01-03';
  const one = await Job.run({ runDate: runDate3, agentId: 'ia-never' });
  const never3 = (await P().query(`SELECT note FROM outreach_queue_runs WHERE run_date = $1 AND agent_id = 'ia-never'`, [runDate3])).rows[0];
  ok('--agent on a never-signed-in agent runs the fill', one.skipped === 0 && never3 && !/^skipped/.test(never3.note || ''), { one, never3 });

  // ── 5. RESUME: CARDS KEPT, OPEN SLOTS FILLED, STATE SHOWN ───────────────
  OUT.push('', '-- a dormant agent who signs in keeps their cards and gets filled now --');
  const idx = require('fs').readFileSync(REPO + 'server/index.js', 'utf8');
  const jobSrc = require('fs').readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the login route stamps users.last_login', /UPDATE users SET last_login = NOW\(\) WHERE id = \$1/.test(idx));
  ok('  and, for a dormant agent, starts resumeAgent in the background', /_wasDormant && OQfillOnDemandEnabled\(\)/.test(idx) && /resumeAgent\(store\.pool, user\.id\)/.test(idx));
  ok('the skipped agent\'s cards are NOT expired: expiry runs only inside the fill', (jobSrc.match(/expireStaleCards\(pool, \{ agentId \}\)/g) || []).length === 1 && /if \(!ctx\.keepStale\) await expireStaleCards/.test(jobSrc));
  ok('  and the resume fill passes keepStale', /fillOnDemand\(pool, ath, \{ keepStale: true, budget \}\)/.test(jobSrc));
  ok('  under one shared budget the size of a night', /const budget = opts\.budget \|\| Q\.newBudget\(CAP_USD\);/.test(jobSrc));
  ok('  only for athletes with an open slot', /if \(!Q\.slotsToFill\(held\)\.length\) continue;/.test(jobSrc));
  ok('the on-demand fill marks the athlete as filling for the page, and records how long it took',
    /Q\.markFilling\(ath\.id\);[\s\S]*?Q\.unmarkFilling\(ath\.id\);/.test(jobSrc) && /SET filled = \$3, spent_usd = \$4, ms = \$5/.test(jobSrc));
  const Qs = require(REPO + 'server/services/outreachQueue.js');
  Qs.markFilling('ia-x'); ok('the filling marker works', Qs.isFilling('ia-x') && Qs.fillingIds().includes('ia-x')); Qs.unmarkFilling('ia-x'); ok('  and clears', !Qs.isFilling('ia-x'));
  ok('Home reports it', /out\.filling = !!\(out\.selected && OQs\.isFilling\(out\.selected\)\)/.test(idx));
  const html = require('fs').readFileSync(REPO + 'public/index.html', 'utf8');
  ok('  and the page shows "finding businesses" and looks again', /Finding businesses for/.test(html) && /HQ\._fillingTimer = setTimeout/.test(html));
  // ── THE SINGLE ADD MOVED OUT OF index.js ───────────────────────────────
  // This grepped server/index.js for runOnDemandFills(user.id, id), which is
  // where the one-athlete path used to live. It is services/athleteCreate.js
  // now, and singular there (runOnDemandFill), so the assertion has been red
  // since the extraction while the behaviour it guards never stopped working.
  // Read where the code is, and read BOTH ways in, because an import is the
  // path that added twenty athletes at once and the one that would be missed
  // quietly.
  const ac = require('fs').readFileSync(REPO + 'server/services/athleteCreate.js', 'utf8');
  ok('adding an athlete starts an on-demand fill for them',
    /runOnDemandFill\(user\.id, id\)/.test(ac) && /markFilling\(id\)/.test(ac));
  ok('  and so does an import, one athlete at a time',
    /runOnDemandFills\(user\.id, c\.id\)/.test(idx) && /markFilling\(c\.id\)/.test(idx));
  ok('the on-demand row records ms', /ALTER TABLE outreach_queue_ondemand ADD COLUMN IF NOT EXISTS ms INT/.test(require('fs').readFileSync(REPO + 'server/store.js', 'utf8')));

  await P().query(`DELETE FROM outreach_queue_runs WHERE run_date IN ('2099-01-01','2099-01-02','2099-01-03')`).catch(() => {});
  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
