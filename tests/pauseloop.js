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

// ── THE PAUSE HAD NO EXIT ───────────────────────────────────────────────────
//
// Exactly one statement in the codebase cleared paused_at: inside recordAttempt,
// on its filled > 0 branch. fillAthlete returned before ever reaching
// recordAttempt when an athlete was paused, and both call sites also guarded on
// !r.paused. So the exit condition required doing the thing the pause prevented.
//
// On 2026-08-23 six athletes on one roster hit exactly three consecutive
// failures within eight minutes of each other and produced nothing for nine
// days. Nothing about six markets changed in eight minutes:
//
//   NIGHTLY_SLOTS was 1, so three businesses were evaluated per athlete, ever.
//   The deliverable lint demanded a quantifier followed by a noun.
//   The sign-off regex \bjohn\b could not match "JohnMark" -- the agent's name.
//
// f1b11aa fixed all three the next day. The pause outlived the bug by nine days
// because nothing could clear it. This suite is about never doing that again.

const fs = require('fs');
const ROOT = REPO;
const store = require(ROOT + 'server/store');
const Q = require(ROOT + 'server/services/outreachQueue');
const job = require(ROOT + 'server/jobs/outreachQueue');
const Deepen = require(ROOT + 'server/services/marketDeepen');
const Scout = require(ROOT + 'server/services/scout');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};
const AG = 'pause-agent';
const DAY = 86400000;

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM outreach_queue_athlete_state WHERE athlete_id LIKE 'pz-%'`).catch(() => {});
    await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM market_deepen_log WHERE market_key LIKE 'pz %'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role)
                 VALUES ($1,'Pause Tester','pz@x.com','x','agent') ON CONFLICT DO NOTHING`, [AG]);

  // ── THE RELEASE RULE ──────────────────────────────────────────────────────
  const now = Date.UTC(2026, 8, 1);
  ok('an athlete paused today is not retried today',
    Q.pauseRelease({ paused_at: new Date(now - 1 * DAY) }, { now, retryDays: 7 }).retry === false);
  ok('  and the page can say when we come back',
    !!Q.pausedUntilNote(Q.pauseRelease({ paused_at: new Date(now - 1 * DAY) }, { now, retryDays: 7 })));
  ok('AN ATHLETE PAUSED N DAYS AGO IS RETRIED',
    Q.pauseRelease({ paused_at: new Date(now - 7 * DAY) }, { now, retryDays: 7 }).retry === true);
  ok('  and one paused nine days ago certainly is',
    Q.pauseRelease({ paused_at: new Date(now - 9 * DAY) }, { now, retryDays: 7 }).retry === true);
  ok('  the held duration is reported in whole days',
    Q.pauseRelease({ paused_at: new Date(now - 9 * DAY) }, { now, retryDays: 7 }).days === 9);
  ok('an athlete who is not paused is not "due a retry"',
    Q.pauseRelease({ paused_at: null }, { now }).paused === false);
  // pg hands back a Date, and Date.parse takes a string. Getting this backwards
  // is what sorted email cards above queue cards in the Home ladder.
  ok('a Date object and an ISO string give the same answer',
    Q.pauseRelease({ paused_at: new Date(now - 8 * DAY) }, { now, retryDays: 7 }).retry
      === Q.pauseRelease({ paused_at: new Date(now - 8 * DAY).toISOString() }, { now, retryDays: 7 }).retry);
  ok('AN UNREADABLE TIMESTAMP RETRIES RATHER THAN HOLDING FOREVER',
    Q.pauseRelease({ paused_at: 'not a date' }, { now, retryDays: 7 }).retry === true,
    Q.pauseRelease({ paused_at: 'not a date' }, { now, retryDays: 7 }));

  // ── releasePause ACTUALLY CLEARS IT ───────────────────────────────────────
  await P.query(`INSERT INTO outreach_queue_athlete_state
      (athlete_id, consecutive_failures, paused_at, paused_reason)
      VALUES ('pz-1', 3, NOW() - INTERVAL '9 days', 'stuck')`);
  const rel = await job.releasePause(P, 'pz-1', 'test');
  const after = (await P.query(
    `SELECT paused_at, paused_reason, consecutive_failures, release_source
       FROM outreach_queue_athlete_state WHERE athlete_id='pz-1'`)).rows[0];
  ok('releasePause clears paused_at', rel === true && after.paused_at === null, after);
  ok('  and the reason with it', after.paused_reason === null, after);
  ok('  RESETTING THE COUNTER, so a resumed athlete gets a full three nights',
    after.consecutive_failures === 0, after);
  ok('  and recording which exit fired, so the next diagnosis is not guesswork',
    after.release_source === 'test', after);
  ok('releasing an athlete who is not paused is not an error, just false',
    (await job.releasePause(P, 'pz-1', 'test')) === false);

  // ── THE BACKOFF NO LONGER COUNTS OUR OWN FAILURES ─────────────────────────
  const D = '2026-09-01';
  const stateOf = async (id) => (await P.query(
    `SELECT consecutive_failures, paused_at FROM outreach_queue_athlete_state WHERE athlete_id=$1`,
    [id])).rows[0] || null;

  // A night where every attempt threw on our side.
  await job.recordAttempt(P, 'pz-fault', { filled: 0, spent: 0.2, runDate: D,
    faults: 3, tried: [{ fault: true }, { fault: true }, { fault: true }], systemic: false });
  ok('A NIGHT THAT ONLY PRODUCED OUR OWN ERRORS DOES NOT COUNT',
    (await stateOf('pz-fault')) === null, await stateOf('pz-fault'));

  // A night where the market genuinely had nothing reachable.
  await job.recordAttempt(P, 'pz-real', { filled: 0, spent: 0.2, runDate: D,
    faults: 0, tried: [{ result: 'rejected' }, { result: 'rejected' }], systemic: false });
  ok('  but a night of genuine rejections still does',
    (await stateOf('pz-real')).consecutive_failures === 1, await stateOf('pz-real'));

  // A mix: some ours, some theirs. Real evidence is still evidence.
  await job.recordAttempt(P, 'pz-mix', { filled: 0, spent: 0.2, runDate: D,
    faults: 1, tried: [{ fault: true }, { result: 'rejected' }, { result: 'rejected' }], systemic: false });
  ok('  and a night that was only PARTLY our fault still counts',
    (await stateOf('pz-mix')).consecutive_failures === 1, await stateOf('pz-mix'));

  // ── THE GUARD THAT WOULD HAVE STOPPED 2026-08-23 ──────────────────────────
  await job.recordAttempt(P, 'pz-sys', { filled: 0, spent: 0.2, runDate: D,
    faults: 0, tried: [{ result: 'rejected' }], systemic: true });
  ok('A RUN THAT FAILED ACROSS THE ROSTER COUNTS AGAINST NOBODY',
    (await stateOf('pz-sys')) === null, await stateOf('pz-sys'));

  // Three genuine nights still pause. The escape hatch must not disarm the cap.
  for (const d of ['2026-09-02', '2026-09-03', '2026-09-04']) {
    await job.recordAttempt(P, 'pz-real', { filled: 0, spent: 0.2, runDate: d,
      faults: 0, tried: [{ result: 'rejected' }], systemic: false });
  }
  const paused = await stateOf('pz-real');
  ok('THREE GENUINELY THIN NIGHTS STILL PAUSE', !!paused.paused_at, paused);
  ok('  at the documented threshold', paused.consecutive_failures >= Q.BACKOFF_NIGHTS, paused);
  // And the same day twice does not double-count.
  const before = (await stateOf('pz-real')).consecutive_failures;
  await job.recordAttempt(P, 'pz-real', { filled: 0, spent: 0.2, runDate: '2026-09-04',
    faults: 0, tried: [{ result: 'rejected' }], systemic: false });
  ok('  and re-running the same day cannot double-count',
    (await stateOf('pz-real')).consecutive_failures === before);

  // A card placed clears everything, which is the original exit and still works.
  await job.recordAttempt(P, 'pz-real', { filled: 1, spent: 0.2, runDate: '2026-09-05' });
  const cleared = await stateOf('pz-real');
  ok('placing a card still unpauses, as it always did',
    cleared.paused_at === null && cleared.consecutive_failures === 0, cleared);

  // ── THE WIDEN CLAIM IS PER ATHLETE ────────────────────────────────────────
  const SCHOOL = 'PZ State University';
  const a1 = await Deepen.claimDeepen(P, SCHOOL, { athleteId: 'pz-w1', source: 'test' });
  const a2 = await Deepen.claimDeepen(P, SCHOOL, { athleteId: 'pz-w2', source: 'test' });
  ok('TWO ATHLETES AT ONE SCHOOL BOTH GET TO WIDEN', a1 === true && a2 === true, { a1, a2 });
  const again = await Deepen.claimDeepen(P, SCHOOL, { athleteId: 'pz-w1', source: 'test' });
  ok('  but the same athlete cannot widen twice inside the window', again === false);
  const gate = await Deepen.canDeepen(P, SCHOOL, { athleteId: 'pz-w1' });
  ok('  and is told why, in words', gate.ok === false && /already widened/.test(gate.reason), gate);
  const fresh = await Deepen.canDeepen(P, SCHOOL, { athleteId: 'pz-w3' });
  ok('  while a third athlete is still allowed', fresh.ok === true, fresh);

  // The market budget still bounds the cost: 20 athletes at one school must not
  // mean 20 deep searches in a night.
  for (let i = 3; i <= Deepen.MAX_PER_MARKET + 2; i++) {
    await Deepen.claimDeepen(P, SCHOOL, { athleteId: 'pz-w' + i, source: 'test' });
  }
  const capped = await Deepen.canDeepen(P, SCHOOL, { athleteId: 'pz-wLAST' });
  ok('THE MARKET STILL HAS A BUDGET, so one school cannot drain the night',
    capped.ok === false && /cap of/.test(capped.reason || ''), capped);
  const other = await Deepen.canDeepen(P, 'PZ Other College', { athleteId: 'pz-w1' });
  ok('  and a different market is unaffected by it', other.ok === true, other);

  // ── emptyReason REACHES THE RUN ROW ───────────────────────────────────────
  ok('there is a named reason for a night that failed on our side',
    Scout.EMPTY.FAULT === 'our-fault' && !!Scout.EMPTY_TEXT[Scout.EMPTY.FAULT]);
  const jobSrc = fs.readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
  const noComments = jobSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('THE DETAILS PUSH CARRIES emptyReason, which used to be computed and dropped',
    /details\.push\(\{[\s\S]{0,600}emptyReason: r\.emptyReason/.test(noComments), null);
  ok('  and the fault count, so a systemic night is legible the next morning',
    /details\.push\(\{[\s\S]{0,700}faults: r\.faults/.test(noComments), null);
  ok('  and when a held athlete comes back',
    /details\.push\(\{[\s\S]{0,800}nextRetryAt: r\.nextRetryAt/.test(noComments), null);
  ok('every fillAthlete exit names a structured reason, not just prose',
    (noComments.match(/emptyReason: Scout\.EMPTY\./g) || []).length >= 3, null);
  ok('THE BACKOFF IS SETTLED AFTER THE RUN, not per athlete in isolation',
    noComments.indexOf('attempts.push({') < noComments.indexOf('const systemic =')
      && /for \(const a of attempts\)/.test(noComments), null);
  ok('a lookup that threw is marked as our fault, not the market\'s',
    /result: 'error'[\s\S]{0,80}fault: true/.test(noComments), null);

  // ── THE AGENT-FACING SURFACE ──────────────────────────────────────────────
  const idx = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
  ok('there is an endpoint that resumes a paused athlete',
    /\/api\/outreach-queue\/athletes\/:athleteId\/resume/.test(idx), null);
  ok('  scoped to the caller\'s own roster',
    /FROM athletes WHERE id = \$1 AND agent_id = \$2/.test(idx), null);
  ok('  and the paused payload offers the action rather than only a reason',
    /canResume: true/.test(idx) && /retryNote:/.test(idx), null);
  const html = fs.readFileSync(ROOT + 'public/index.html', 'utf8');
  // ON HOME, NOT ON OUTREACH. This named hqResumeAthlete and _p.days, which were
  // the Outreach queue renderer's symbols; that renderer was removed and the
  // button moved to Home as hqResume, over the paused row it reads from
  // buildHome. The assertions were about the right thing under names that had
  // stopped existing, so they failed on working code.
  ok('THE PAGE RENDERS A RESUME BUTTON ON A PAUSED ATHLETE',
    /function hqResume\(athleteId, btn\)/.test(html) && /Resume this athlete/.test(html), null);
  ok('  and says how long they have been held',
    /Paused '[\s\S]{0,20}_paused\.days/.test(html), null);

  // ── THE SCRIPT ────────────────────────────────────────────────────────────
  const scr = fs.readFileSync(ROOT + 'scripts/resume-paused-athletes.js', 'utf8');
  const scrNoComments = scr.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok('the resume script is a dry run unless --apply',
    /const APPLY = has\('--apply'\)/.test(scrNoComments) && /if \(!APPLY\)/.test(scrNoComments), null);
  ok('  it clears the pause and resets the counter',
    /paused_at = NULL[\s\S]{0,120}consecutive_failures = 0/.test(scrNoComments), null);
  ok('  and it surfaces same-day clusters, because simultaneity is the tell',
    /spread_minutes/.test(scrNoComments), null);

  await clean();
  await P.query(`DELETE FROM outreach_queue_athlete_state WHERE athlete_id LIKE 'pz-%'`).catch(() => {});
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
