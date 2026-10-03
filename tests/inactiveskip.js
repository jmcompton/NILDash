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

// ── ACTIVE AGENTS NIGHTLY, DORMANT AGENTS WEEKLY, THEIR CARDS KEPT ─────────
//
// Active: signed in within 14 days, filled every night. Dormant (longer, or
// never): filled once a week, so an agent who comes back finds deals waiting.
// The other nights are a run row whose note says "skipped: dormant ... next
// <date>". A dormant account's cards do not age; when the agent signs back in
// every queued card's seven days restart. A run for one named agent never
// skips.

const store = require(REPO + 'server/store.js');
const Job = require(REPO + 'server/jobs/outreachQueue.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;
const IDS = ['ia-fresh', 'ia-stale', 'ia-never'];
const RUN_DATES = ['2099-01-01', '2099-01-02', '2099-01-03', '2099-01-04', '2099-01-07', '2099-01-08'];
const DAY = 86400000;

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const clean = async () => {
    await P().query(`DELETE FROM outreach_queue_runs WHERE agent_id = ANY($1)`, [IDS]).catch(() => {});
    await P().query(`DELETE FROM outreach_queue WHERE agent_id = ANY($1)`, [IDS]).catch(() => {});
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
  ok('a login 15 days ago is dormant, with the count and the date', /^last login 15 days ago \(2026-08-31\)/.test(why15), why15);
  const whyNever = Job.inactiveSkip({ last_login: null }, now);
  ok('never signed in is dormant, and says so', /never signed in/.test(whyNever), whyNever);
  ok('a junk date is treated as never', /never signed in/.test(Job.inactiveSkip({ last_login: 'not a date' }, now)));
  ok('dormant accounts are filled every 7 days', Job.DORMANT_EVERY_DAYS === 7, Job.DORMANT_EVERY_DAYS);

  // ── 2. THE CADENCE ───────────────────────────────────────────────────────
  OUT.push('', '-- dormant: filled once a week, not never --');
  // Agents with no athletes: a fill is fast, spends nothing and needs no network.
  await P().query(`INSERT INTO users (id,name,email,password,role,last_login) VALUES
    ('ia-fresh','Fresh','ia-fresh@x.com','x','agent',NOW() - INTERVAL '2 days'),
    ('ia-stale','Stale','ia-stale@x.com','x','agent',NOW() - INTERVAL '20 days'),
    ('ia-never','Never','ia-never@x.com','x','agent',NULL)`);
  await P().query(`DELETE FROM outreach_queue_runs WHERE run_date = ANY($1::date[])`, [RUN_DATES]).catch(() => {});
  const night = async (d) => { await Job.run({ runDate: d }); return Object.fromEntries((await P().query(
    `SELECT agent_id, filled, note, finished_at, details FROM outreach_queue_runs WHERE run_date = $1 AND agent_id = ANY($2)`, [d, IDS])).rows.map((r) => [r.agent_id, r])); };
  const n1 = await night('2099-01-01');
  ok('night 1: the dormant agent has had no fill, so tonight is its weekly fill (not skipped)',
    n1['ia-stale'] && !/^skipped/.test(n1['ia-stale'].note || '') && /weekly fill for a dormant account: last login 20 days ago/.test(n1['ia-stale'].note || ''), n1['ia-stale']);
  ok('  the never-signed-in agent too', n1['ia-never'] && /weekly fill for a dormant account: this agent has never signed in/.test(n1['ia-never'].note || ''), n1['ia-never']);
  ok('  the active agent is filled as always, with no note', n1['ia-fresh'] && !n1['ia-fresh'].note, n1['ia-fresh']);
  const n2 = await night('2099-01-02');
  ok('night 2: the dormant agent is skipped, finished, filled 0, and the note says when the next fill is',
    n2['ia-stale'] && n2['ia-stale'].filled === 0 && n2['ia-stale'].finished_at && /^skipped: dormant, last login 20 days ago .*filled once a week, last 2099-01-01, next 2099-01-08/.test(n2['ia-stale'].note || ''), n2['ia-stale']);
  ok('  with an empty details list, not a missing one', n2['ia-stale'] && Array.isArray(n2['ia-stale'].details) && n2['ia-stale'].details.length === 0);
  ok('  the active agent runs again', n2['ia-fresh'] && !/^skipped/.test(n2['ia-fresh'].note || ''));
  const n7 = await night('2099-01-07');
  ok('night 7: still skipped (six days since the fill)', n7['ia-stale'] && /^skipped: dormant/.test(n7['ia-stale'].note || ''), n7['ia-stale']);
  const n8 = await night('2099-01-08');
  ok('night 8: seven days on, the weekly fill runs again', n8['ia-stale'] && /^weekly fill for a dormant account/.test(n8['ia-stale'].note || ''), n8['ia-stale']);

  // ── 3. A SIGN-IN MAKES THEM NIGHTLY AGAIN ────────────────────────────────
  OUT.push('', '-- a sign-in lifts it for the next night --');
  await P().query(`UPDATE users SET last_login = NOW() WHERE id = 'ia-stale'`);
  await P().query(`DELETE FROM outreach_queue_runs WHERE run_date = '2099-01-03'`);
  const n3 = await night('2099-01-03');
  ok('after a sign-in the next run fills the agent as active: no skip, no dormant note', n3['ia-stale'] && !n3['ia-stale'].note, n3['ia-stale']);

  // ── 3b. THE CARDS WAIT FOR THEM ──────────────────────────────────────────
  OUT.push('', '-- a dormant account\'s cards wait for the agent --');
  const card = (id, brand, extra) => P().query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, state, created_at${extra ? ', expire_from' : ''})
     VALUES ($1, 'ia-ath', $2, $3, $3, 'queued', NOW() - INTERVAL '20 days'${extra ? ', NOW()' : ''})`, [id, brand === 'b-old' ? 1 : 2, brand]);
  await card('ia-stale', 'b-old', false); await card('ia-stale', 'b-back', true);
  await Job.expireStaleCards(P(), { agentId: 'ia-stale' });
  const st = Object.fromEntries((await P().query(`SELECT brand_key, state FROM outreach_queue WHERE agent_id = 'ia-stale'`)).rows.map((r) => [r.brand_key, r.state]));
  ok('a card whose clock restarted today is kept though created 20 days ago; one that never restarted expires',
    st['b-back'] === 'queued' && st['b-old'] === 'expired', st);
  await P().query(`UPDATE outreach_queue SET state = 'queued', expire_from = NULL WHERE agent_id = 'ia-stale'`);
  const restarted = await Job.restartCardClock(P(), 'ia-stale');
  await Job.expireStaleCards(P(), { agentId: 'ia-stale' });
  const st2 = (await P().query(`SELECT COUNT(*) FILTER (WHERE state = 'queued')::int q, COUNT(*) FILTER (WHERE expire_from > NOW() - INTERVAL '1 minute')::int fresh FROM outreach_queue WHERE agent_id = 'ia-stale'`)).rows[0];
  ok('restartCardClock: every waiting card gets a fresh seven days, and none expires tonight', restarted === 2 && st2.q === 2 && st2.fresh === 2, { restarted, st2 });
  const jobSrc0 = require('fs').readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the weekly fill keeps the dormant account\'s cards (keepStale: no expiry while they are away)', /keepStale: !!opts\.dormant,/.test(jobSrc0) && /dormant: true/.test(jobSrc0));
  const idx0 = require('fs').readFileSync(REPO + 'server/index.js', 'utf8');
  ok('both ways back (sign-in and roster import) restart the clock', (idx0.match(/restartCardClock\(store\.pool, user\.id\)/g) || []).length === 2);

  // ── 4. A NAMED RUN NEVER SKIPS ───────────────────────────────────────────
  OUT.push('', '-- a run for one named agent always fills --');
  const runDate3 = '2099-01-04';
  const one = await Job.run({ runDate: runDate3, agentId: 'ia-never' });
  const never3 = (await P().query(`SELECT note FROM outreach_queue_runs WHERE run_date = $1 AND agent_id = 'ia-never'`, [runDate3])).rows[0];
  ok('--agent on a never-signed-in agent runs the fill', one.skipped === 0 && never3 && !/^skipped/.test(never3.note || ''), { one, never3 });

  // ── 5. RESUME: CARDS KEPT, OPEN SLOTS FILLED, STATE SHOWN ───────────────
  OUT.push('', '-- a dormant agent who signs in keeps their cards and gets filled now --');
  const idx = require('fs').readFileSync(REPO + 'server/index.js', 'utf8');
  const jobSrc = require('fs').readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the login route stamps users.last_login', /UPDATE users SET last_login = NOW\(\) WHERE id = \$1/.test(idx));
  ok('  and, for a dormant agent, starts resumeAgent in the background', /_wasDormant && OQfillOnDemandEnabled\(\)/.test(idx) && /resumeAgent\(store\.pool, user\.id\)/.test(idx));
  ok('a dormant agent\'s cards are NOT expired: expiry runs only inside the fill, and not on the weekly fill', (jobSrc.match(/expireStaleCards\(pool, \{ agentId \}\)/g) || []).length === 1 && /if \(!ctx\.keepStale\) \{\s*try \{ await expireStaleCards/.test(jobSrc));
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

  await P().query(`DELETE FROM outreach_queue_runs WHERE run_date = ANY($1::date[])`, [RUN_DATES]).catch(() => {});
  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
