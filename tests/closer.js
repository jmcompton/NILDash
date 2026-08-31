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
// THE CLOSER: allocation, one-decision approval, the release that never existed,
// the cadence, and auto mode that has to be earned.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const C = require(ROOT + 'server/services/closer.js');
const A = require(ROOT + 'server/services/closerAllocator.js');
const G = require(ROOT + 'server/services/sendGuard.js');
const SUP = require(ROOT + 'server/services/suppression.js');
const SW = require(ROOT + 'server/services/sendWindow.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'cl-agent';

// A Tuesday 10:00 Central, inside the window, so the release tests are not
// hostage to when the suite happens to run.
const TUE = Date.parse('2026-08-25T15:00:00Z');

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await G.ensureTable(P);
  const clean = async () => {
    await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM agent_send_budget WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM agent_auto_mode WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM email_suppression WHERE email LIKE '%@cl.example'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'A','cl@x.com','x','agent','America/Chicago')`, [AG]);

  // ── ALLOCATION: NOT DIVIDED EVENLY ───────────────────────────────────────
  // 40 across 45 athletes is 0.9 each, which is one weak pitch for everyone and
  // momentum for nobody.
  const roster = Array.from({ length: 45 }, (_, i) => ({
    id: 'a' + i, name: 'Athlete ' + i,
    daysSinceTouch: 2, daysSinceReply: null, daysSinceClose: null,
    queuedNow: 5, neverTouched: false, marketThin: false, gameWithinDays: null,
  }));
  const even = A.allocate(roster, 40);
  ok('40 across 45 athletes does NOT go one each',
    even.covered < 45, { covered: even.covered, of: 45 });
  ok('  it covers a subset properly instead', even.covered > 0 && even.covered <= 20, even.covered);
  ok('  and spends the whole budget', even.spent === 40, even.spent);
  ok('  never more than the budget', even.spent <= 40);

  // ── WHAT MOVES AN ATHLETE UP ─────────────────────────────────────────────
  const mixed = [
    { id: 'warm', name: 'Warm', daysSinceTouch: 2, daysSinceReply: 1, daysSinceClose: null,
      queuedNow: 5, neverTouched: false, marketThin: false, gameWithinDays: null },
    { id: 'quiet', name: 'Quiet', daysSinceTouch: 11, daysSinceReply: null, daysSinceClose: null,
      queuedNow: 5, neverTouched: false, marketThin: false, gameWithinDays: null },
    { id: 'thin', name: 'Thin', daysSinceTouch: 2, daysSinceReply: null, daysSinceClose: null,
      queuedNow: 0, neverTouched: false, marketThin: true, gameWithinDays: null },
    { id: 'fresh', name: 'Fresh', daysSinceTouch: null, daysSinceReply: null, daysSinceClose: null,
      queuedNow: 5, neverTouched: true, marketThin: false, gameWithinDays: null },
    { id: 'yesterday', name: 'Yesterday', daysSinceTouch: 0.5, daysSinceReply: null, daysSinceClose: null,
      queuedNow: 5, neverTouched: false, marketThin: false, gameWithinDays: null },
  ];
  const sWarm = A.scoreAthlete(mixed[0]).score;
  const sThin = A.scoreAthlete(mixed[2]).score;
  const sYest = A.scoreAthlete(mixed[4]).score;
  const sFresh = A.scoreAthlete(mixed[3]).score;
  ok('a business that just REPLIED outranks a thin market', sWarm > sThin, { sWarm, sThin });
  ok('  and outranks one worked yesterday', sWarm > sYest, { sWarm, sYest });
  ok('a never-touched athlete scores high', sFresh > sYest, { sFresh, sYest });
  ok('a thin market scores NEGATIVE', sThin < 0, sThin);
  const why = A.scoreAthlete(mixed[0]).why.join('; ');
  ok('  and the reason is in words, not a number', /replied/.test(why), why);

  const plan = A.allocate(mixed, 12);
  ok('the warm athlete is allocated first', plan.picks[0].athleteId === 'warm', plan.picks.map((p) => p.athleteId));
  ok('  no athlete takes more than the per-athlete ceiling',
    plan.picks.every((p) => p.count <= A.MAX_PER_ATHLETE), plan.picks);

  // ── THE FLOOR IS NOT A TIEBREAK ──────────────────────────────────────────
  // An athlete nobody has touched in over a week gets allocated even though
  // their score is bad, because "the algorithm ranked your son low" is not an
  // answer an agent can give a parent.
  const withStale = mixed.concat([{
    id: 'stale', name: 'Stale', daysSinceTouch: 30, daysSinceReply: null, daysSinceClose: null,
    queuedNow: 0, neverTouched: false, marketThin: true, gameWithinDays: null,
  }]);
  const staleScore = A.scoreAthlete(withStale[5]).score;
  const floorPlan = A.allocate(withStale, 12);
  const stalePick = floorPlan.picks.find((p) => p.athleteId === 'stale');
  ok('AN ATHLETE PAST THE WEEKLY FLOOR IS TOUCHED REGARDLESS', !!stalePick, floorPlan.picks.map((p) => p.athleteId));
  ok('  even with a thin market dragging their score down', staleScore < sWarm, { staleScore, sWarm });
  ok('  and the row says it was the floor, not merit',
    stalePick.floor === true && /weekly floor/.test(stalePick.reason), stalePick);

  // Everyone gets touched inside a week when the budget allows it.
  const smallRoster = mixed.slice(0, 3).map((a) => ({ ...a, daysSinceTouch: 9 }));
  const allFloor = A.allocate(smallRoster, 40);
  ok('with room, every athlete past the floor is covered',
    allFloor.covered === 3, allFloor.covered);

  const none = A.allocate(mixed, 0);
  ok('no allowance means no allocation, with a reason',
    none.picks.length === 0 && /no email allowance/.test(none.note), none);

  // ── THE BATCH, AND THE ONE DECISION ──────────────────────────────────────
  for (let i = 0; i < 3; i++) {
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
      ['cl-a' + i, AG, JSON.stringify({ name: 'Client ' + i, school: 'Auburn University' })]);
  }
  const mk = async (id, ath, brand, email) => {
    await P.query(
      `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,touch_no)
       VALUES ($1,$2,$3,$4,'Hi','<p>x</p>','draft',$5,1)`, [id, AG, ath, brand, email]);
  };
  for (let i = 0; i < 9; i++) {
    await mk('cl-l' + i, 'cl-a' + (i % 3), 'Brand ' + i, `b${i}@cl.example`);
  }
  const batch = await C.buildBatch(P, AG, { now: TUE });
  ok('the batch is built from ready drafts', batch.batch.length > 0, batch.note);
  ok('  and never exceeds the nightly ceiling', batch.batch.length <= 40, batch.batch.length);
  ok('  each item says why that athlete was chosen',
    batch.batch.every((b) => !!b.why), batch.batch[0]);

  // A BOUNCED ADDRESS NEVER REACHES THE BATCH.
  await SUP.suppress(P, 'b3@cl.example', { reason: 'hard bounce' });
  const batch2 = await C.buildBatch(P, AG, { now: TUE });
  ok('A PREVIOUSLY BOUNCED ADDRESS IS DROPPED FROM THE BATCH',
    !batch2.batch.some((b) => b.toEmail === 'b3@cl.example'),
    batch2.batch.map((b) => b.toEmail));
  ok('  and the drop is reported, not silent',
    batch2.dropped.some((d) => /bounced/.test(d.why)), batch2.dropped);

  // ── APPROVE ALL, MINUS A FEW ─────────────────────────────────────────────
  const ids = batch2.batch.map((b) => b.id);
  const skipped = ids.slice(0, 2);
  const appr = await C.approveBatch(P, AG, { ids, skip: skipped, now: TUE });
  ok('approving the batch schedules the rest', appr.scheduled > 0, appr);
  ok('  the unchecked ones are NOT approved', appr.skipped === 2, appr);
  const skippedRow = (await P.query(
    `SELECT status, approved_at FROM outreach_logs WHERE id=$1`, [skipped[0]])).rows[0];
  ok('  and stay drafts', skippedRow.status === 'draft' && !skippedRow.approved_at, skippedRow);

  // THE AGENT NEVER PICKS THE TIME.
  const sched = (await P.query(
    `SELECT scheduled_send_at, send_timezone FROM outreach_logs
      WHERE agent_id=$1 AND status='approved' LIMIT 5`, [AG])).rows;
  ok('every approved message carries a send time it did not ask for',
    sched.length > 0 && sched.every((r) => !!r.scheduled_send_at), sched.length);
  ok('  IN THE RECIPIENT\'S TIMEZONE', sched.every((r) => !!r.send_timezone), sched[0]);
  ok('  and every one lands inside the window',
    sched.every((r) => SW.isSendable(r.scheduled_send_at, { timezone: r.send_timezone })), sched);
  // dow is a JS day number, Sun=0, so Tue/Wed/Thu is [2,3,4] -- SEND_DAYS itself.
  ok('  never on a weekend, never Mon or Fri',
    sched.every((r) => SW.SEND_DAYS.includes(
      SW.partsIn(new Date(r.scheduled_send_at), r.send_timezone).dow)),
    sched.map((r) => SW.partsIn(new Date(r.scheduled_send_at), r.send_timezone).dow));
  ok('  and inside 9:30-11:00 local', sched.every((r) => {
    const p = SW.partsIn(new Date(r.scheduled_send_at), r.send_timezone);
    const min = p.hour * 60 + p.minute;
    return min >= SW.WINDOW_START_MIN && min < SW.WINDOW_END_MIN;
  }), sched.map((r) => { const p = SW.partsIn(new Date(r.scheduled_send_at), r.send_timezone);
    return p.hour + ':' + p.minute; }));

  // ── RELEASE: THE JOB THAT DID NOT EXIST ──────────────────────────────────
  await P.query(`UPDATE outreach_logs SET scheduled_send_at = $2
                  WHERE agent_id=$1 AND status='approved'`, [AG, new Date(TUE - 60000)]);
  const sentIds = [];
  const rel = await C.releaseDue(P, {
    now: TUE, send: async (log) => { sentIds.push(log.id); return { providerMessageId: 'p-' + log.id }; },
  });
  ok('THE RELEASE ACTUALLY SENDS', rel.sent > 0, rel);
  const sentRows = (await P.query(
    `SELECT COUNT(*)::int n FROM outreach_logs WHERE agent_id=$1 AND status='sent'`, [AG])).rows[0].n;
  ok('  and the rows say sent', sentRows === rel.sent, { sentRows, rel: rel.sent });
  const spend = await G.status(P, AG, { now: TUE });
  ok('  each send spent one from the ceiling', spend.used === rel.sent, { used: spend.used, sent: rel.sent });

  // ── THE CADENCE ──────────────────────────────────────────────────────────
  ok('the cadence is three touches, not one and not five', C.MAX_TOUCHES === 3, C.MAX_TOUCHES);
  ok('  spaced over a fortnight, widening',
    C.CADENCE[1].afterDays === 4 && C.CADENCE[2].afterDays === 9, C.CADENCE);
  const followUps = (await P.query(
    `SELECT id, touch_no, parent_id, status FROM outreach_logs
      WHERE agent_id=$1 AND touch_no = 2`, [AG])).rows;
  ok('a sent message queues its next touch', followUps.length > 0, followUps.length);
  ok('  as a DRAFT, so it goes through the same one decision',
    followUps.every((f) => f.status === 'draft'), followUps[0]);
  ok('  linked to the thread root', followUps.every((f) => !!f.parent_id), followUps[0]);
  ok('  with a Re: subject', C.followUpSubject('Quick idea') === 'Re: Quick idea');
  ok('  and it does not double up the Re:', C.followUpSubject('Re: Quick idea') === 'Re: Quick idea');

  // ── STOP ON REPLY, BEFORE IT GOES OUT ────────────────────────────────────
  const rootId = followUps[0].parent_id;
  await P.query(`UPDATE outreach_logs SET status='approved', scheduled_send_at=$2, replied_at=NOW()
                  WHERE id=$1`, [followUps[0].id, new Date(TUE - 60000)]);
  const rel2 = await C.releaseDue(P, { now: TUE, send: async () => ({ providerMessageId: 'x' }) });
  const stoppedRow = (await P.query(
    `SELECT cadence_stopped_at, cadence_stop_reason, status FROM outreach_logs WHERE id=$1`,
    [followUps[0].id])).rows[0];
  ok('A REPLY STOPS THE FOLLOW-UP BEFORE IT SENDS',
    !!stoppedRow.cadence_stopped_at && stoppedRow.status !== 'sent', stoppedRow);
  ok('  saying so in words', /replied/.test(stoppedRow.cadence_stop_reason), stoppedRow.cadence_stop_reason);
  void rel2; void rootId;

  // ── A BOUNCE STOPS THE WHOLE THREAD AND FLAGS THE ADDRESS ────────────────
  await mk('cl-b1', 'cl-a0', 'Bounce Co', 'dead@cl.example');
  await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,status,touch_no,parent_id,sent_to_email)
                 VALUES ('cl-b1-t2',$1,'cl-a0','Bounce Co','Re: Hi','draft',2,'cl-b1','dead@cl.example')`, [AG]);
  const bRow = (await P.query(`SELECT * FROM outreach_logs WHERE id='cl-b1'`)).rows[0];
  const bounced = await SUP.onBounce(P, bRow, { reason: 'mailer-daemon' });
  ok('a hard bounce suppresses the address', bounced.suppressed === true && bounced.hard === true, bounced);
  const sup = await SUP.isSuppressed(P, 'dead@cl.example');
  ok('  so nothing sends there again', sup.suppressed === true, sup);
  const t2 = (await P.query(`SELECT cadence_stopped_at FROM outreach_logs WHERE id='cl-b1-t2'`)).rows[0];
  ok('  AND THE REST OF THE THREAD STOPS', !!t2.cadence_stopped_at, t2);

  // A SOFT bounce is not a dead address.
  await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,status,touch_no,sent_to_email)
                 VALUES ('cl-s1',$1,'cl-a1','Soft Co','Hi','sent',1,'full@cl.example')`, [AG]);
  const sRow = (await P.query(`SELECT * FROM outreach_logs WHERE id='cl-s1'`)).rows[0];
  const soft = await SUP.onBounce(P, sRow, { reason: 'mailbox is full, try again' });
  ok('a FULL MAILBOX is not a dead address', soft.hard === false, soft);
  ok('  so the address is not suppressed',
    (await SUP.isSuppressed(P, 'full@cl.example')).suppressed === false);
  ok('  but the cadence still stops', soft.stopped === true, soft);

  // ── AUTO MODE IS EARNED ──────────────────────────────────────────────────
  const prog0 = await C.autoModeProgress(P, AG);
  ok('auto mode is not eligible on day one', prog0.eligible === false, prog0);
  ok('  and says how many approvals are left', prog0.remaining > 0, prog0);
  const denied = await C.setAutoMode(P, AG, { scopeKind: 'athlete', scopeId: 'cl-a0', enabled: true });
  ok('  turning it on early is REFUSED', denied.ok === false, denied);
  ok('  with the count, so the offer is earned not asked for',
    /approvals with no edits/.test(denied.error), denied.error);

  const globalTry = await C.setAutoMode(P, AG, { scopeKind: 'global', scopeId: 'all', enabled: true });
  ok('THERE IS NO GLOBAL AUTO MODE', globalTry.ok === false, globalTry);
  ok('  and the refusal says why', /per athlete or per lane/.test(globalTry.error), globalTry.error);

  // 30 clean approvals unlocks it; one edit anywhere does not.
  await P.query(`UPDATE outreach_logs SET approved_at = NOW(), edited_before_approval = FALSE
                  WHERE agent_id = $1`, [AG]);
  for (let i = 0; i < 40; i++) {
    await P.query(
      `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,status,approved_at,edited_before_approval)
       VALUES ($1,$2,'cl-a0','Filler','s','sent',NOW(),FALSE) ON CONFLICT DO NOTHING`,
      ['cl-f' + i, AG]);
  }
  const prog1 = await C.autoModeProgress(P, AG);
  ok('30 approvals with no edits unlocks it', prog1.eligible === true, prog1);
  const allowed = await C.setAutoMode(P, AG, { scopeKind: 'athlete', scopeId: 'cl-a0', enabled: true });
  ok('  and then it can be turned on, per athlete', allowed.ok === true, allowed);
  const auto = await C.autoModeFor(P, AG);
  ok('  scoped to that athlete only', auto.athletes.has('cl-a0') && auto.lanes.size === 0, [...auto.athletes]);
  ok('  a different athlete is NOT auto', C.isAuto(auto, { athlete_id: 'cl-a1', lane: 'local' }) === false);
  ok('  the chosen one is', C.isAuto(auto, { athlete_id: 'cl-a0', lane: 'local' }) === true);

  await P.query(`UPDATE outreach_logs SET edited_before_approval = TRUE WHERE id='cl-f1'`);
  const prog2 = await C.autoModeProgress(P, AG);
  ok('ONE EDIT MEANS THE WRITING IS NOT TRUSTED YET', prog2.eligible === false, prog2);
  ok('  and it says so plainly', /were edited first/.test(prog2.note || ''), prog2.note);

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
