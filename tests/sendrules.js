'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/sendrules.js        just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── ONE ADDRESS, ONE RULEBOOK, EVERY SYSTEM ──────────────────────────────────
//
// Luke Mazur got the same email from us every other day. The follow-up
// cadence wrote touch 2 the moment touch 1 sent, stamped four days out, and
// nothing read the stamp: it was in the next morning's batch and out the door
// in the next window. And no sender asked what the others had already sent to
// the address. Now: a follow-up is not shown, approved, or released before it
// is due; never the same subject twice to one address; never two emails to
// one address inside four days from any system; and a suppression list that
// stops everything.

const store = require(REPO + 'server/store.js');
const SR = require(REPO + 'server/services/sendRules.js');
const C = require(REPO + 'server/services/closer.js');
const SUP = require(REPO + 'server/services/suppression.js');
const G = require(REPO + 'server/services/sendGuard.js');
const ND = require(REPO + 'server/services/nightlyDigest.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');
const AG = 'sr-agent';
const LUKE = 'luke@sr.example';
const DAY = 86400000;
// A Tuesday 10:00 Central, inside the send window.
const TUE = Date.parse('2026-08-25T15:00:00Z');

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await G.ensureTable(P);
  await SR.ensureTable(P);
  const clean = async () => {
    await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM agent_send_budget WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM nightly_digest_sends WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM email_suppression WHERE email LIKE '%@sr.example'`).catch(() => {});
    await P.query(`DELETE FROM email_sends WHERE email LIKE '%@sr.example'`).catch(() => {});
    await P.query(`DELETE FROM brand_evidence_cache WHERE brand_key LIKE 'sr:%'`).catch(() => {});
    await P.query(`DELETE FROM compliance_holds WHERE agent_id=$1`, [AG]).catch(() => {});
  };
  // The compliance gate holds a business with no Places record; these are plain restaurants.
  const places = (brand) => P.query(
    `INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at)
     VALUES ($1,'places',$2,$3::jsonb,'OK',NOW()) ON CONFLICT (brand_key, lane) DO UPDATE SET evidence = EXCLUDED.evidence, refreshed_at = NOW()`,
    ['sr:' + brand.toLowerCase(), brand, JSON.stringify({ found: true, types: ['restaurant'], name: brand })]);
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz) VALUES ($1,'Sr Agent',$2,'x','agent','America/Chicago')`, [AG, LUKE]);
  for (const i of [1, 2]) {
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
      ['sr-a' + i, AG, JSON.stringify({ name: 'Client ' + i, school: 'Auburn University' })]);
  }
  const draft = async (id, ath, brand, email, subject, extra = {}) => {
    await places(brand);
    await P.query(
      `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,touch_no,next_follow_up_at,parent_id)
       VALUES ($1,$2,$3,$4,$5,'<p>x</p>','draft',$6,$7,$8,$9)`,
      [id, AG, ath, brand, subject, email, extra.touch || 1, extra.due || null, extra.parent || null]);
  };
  const approve = (ids, now) => C.approveBatch(P, AG, { ids, now });
  const release = async (now) => C.releaseDue(P, { now, send: async (log) => ({ providerMessageId: 'p-' + log.id }) });
  const row = async (id) => (await P.query(`SELECT * FROM outreach_logs WHERE id=$1`, [id])).rows[0];
  const dueAll = async (now) => P.query(`UPDATE outreach_logs SET scheduled_send_at=$2 WHERE agent_id=$1 AND status='approved'`, [AG, new Date(now - 60000)]);

  // ── THE PURE PARTS ───────────────────────────────────────────────────────
  ok('the same words are the same subject, whatever the case and spacing',
    SR.subjectKey('  Quick   idea for Luke ') === SR.subjectKey('quick idea for luke'));
  ok('  but "Re:" is a different subject: a reply in the thread is a different email',
    SR.subjectKey('Re: Quick idea') !== SR.subjectKey('Quick idea'));
  ok('touch 2 threads on the first note', C.followUpSubject('Quick idea', 2) === 'Re: Quick idea');
  ok('touch 3 has its own subject, so the never-twice rule does not stop the cadence',
    C.followUpSubject('Quick idea', 3) === 'Re: Quick idea (last note)', C.followUpSubject('Quick idea', 3));
  ok('  and it is not doubled on a re-run', C.followUpSubject('Re: Quick idea (last note)', 3) === 'Re: Quick idea (last note)');
  ok('the window is four days', SR.WINDOW_DAYS === 4, SR.WINDOW_DAYS);
  ok('a sent row says which system sent it: cadence touch', SR.systemOfLog({ touch_no: 2 }) === 'follow-up');
  ok('  Closer batch', SR.systemOfLog({ touch_no: 1, approved_at: new Date() }) === 'closer');
  ok('  manual send', SR.systemOfLog({ touch_no: 1 }) === 'manual');
  ok('  and the label carries the touch number', /touch 2/.test(SR.labelFor('follow-up', 2)), SR.labelFor('follow-up', 2));
  ok('digests and reports are under the suppression list only, not the 4-day window',
    ['nightly-digest', 'weekly-digest', 'shift-report', 'deliverable-digest'].every((s) => SR.NOTICE_SYSTEMS.has(s)));
  ok('  outreach is under every rule', ['closer', 'follow-up', 'manual', 'compose', 'athlete', 'growth'].every((s) => !SR.NOTICE_SYSTEMS.has(s)));

  // ── A FOLLOW-UP IS NOT READY UNTIL IT IS DUE ─────────────────────────────
  await draft('sr-d1', 'sr-a1', 'Mazur Motors', LUKE, 'Quick idea for Mazur Motors');
  const a1 = await approve(['sr-d1'], TUE);
  ok('touch 1 approves like any draft', a1.scheduled === 1, a1);
  await dueAll(TUE);
  const r1 = await release(TUE);
  ok('  and releases', r1.sent === 1, r1);
  const t2 = (await P.query(`SELECT * FROM outreach_logs WHERE parent_id='sr-d1' AND touch_no=2`)).rows[0];
  ok('touch 2 is written when touch 1 sends', !!t2, t2);
  ok('  due four days later', !!t2 && Math.abs(new Date(t2.next_follow_up_at).getTime() - (TUE + 4 * DAY)) < 60000, t2 && t2.next_follow_up_at);
  ok('  with a Re: subject', !!t2 && t2.subject === 'Re: Quick idea for Mazur Motors', t2 && t2.subject);
  const batchNext = await C.buildBatch(P, AG, { now: TUE + DAY });
  ok('THE NEXT MORNING\'S BATCH DOES NOT CARRY IT', !batchNext.batch.some((b) => b.id === t2.id), batchNext.batch.map((b) => b.id));
  const early = await approve([t2.id], TUE + DAY);
  ok('  approving it early is refused', early.scheduled === 0, early);
  ok('  and the refusal says when it is due', early.dropped.some((d) => /not due until 2026-08-29/.test(d.why)), early.dropped);
  ok('  in the note the agent reads', /not due yet/.test(early.note || ''), early.note);
  ok('  Home does not show it either (services/actionable EMAIL_WHERE)',
    /next_follow_up_at IS NULL OR l\.next_follow_up_at <= NOW\(\)/.test(src('server/services/actionable.js')));
  const onTime = await approve([t2.id], TUE + 5 * DAY);
  ok('once it is due it approves', onTime.scheduled === 1, onTime);
  // Approved early by an older build: the release still holds it.
  await draft('sr-d1x', 'sr-a2', 'Early Co', 'early@sr.example', 'Hello Early', { touch: 2, due: new Date(TUE + 9 * DAY), parent: 'sr-d1' });
  await P.query(`UPDATE outreach_logs SET status='approved', approved_at=NOW(), scheduled_send_at=$1 WHERE id='sr-d1x'`, [new Date(TUE + 5 * DAY)]);
  const rEarly = await release(TUE + 5 * DAY + 3600000);
  const heldEarly = rEarly.detail.find((d) => d.id === 'sr-d1x');
  ok('the release holds a follow-up approved before it was due', !!heldEarly && heldEarly.result === 'held' && /not due until/.test(heldEarly.why), heldEarly);
  await P.query(`UPDATE outreach_logs SET cadence_stopped_at=NOW(), cadence_stop_reason='test' WHERE id='sr-d1x'`);

  // ── NEVER TWO EMAILS TO ONE ADDRESS INSIDE FOUR DAYS, FROM ANY ATHLETE ───
  await draft('sr-d2', 'sr-a2', 'Mazur Motors', LUKE, 'An idea from Client 2 for Mazur Motors');
  await approve(['sr-d2'], TUE);
  await dueAll(TUE);
  const r2 = await release(TUE + 3600000);
  const held = r2.detail.find((d) => d.id === 'sr-d2');
  ok('A SECOND ATHLETE\'S PITCH TO THE SAME ADDRESS AN HOUR LATER IS HELD', !!held && held.result === 'held', held);
  ok('  saying what the address already got and from where', !!held && /already got "Quick idea for Mazur Motors" from the Closer batch/.test(held.why) && /4 days/.test(held.why), held && held.why);
  ok('  it is a hold, not a stop: the draft is still approved', (await row('sr-d2')).status === 'approved' && !(await row('sr-d2')).cadence_stopped_at);
  const chk = await SR.check(P, { email: LUKE, subject: 'Something new', system: 'manual', now: TUE + 2 * DAY });
  ok('  the same answer for a manual send', chk.ok === false && chk.kind === 'window', chk);
  ok('  with the day it clears', chk.retryAfter && Math.abs(new Date(chk.retryAfter).getTime() - (TUE + 4 * DAY)) < 60000, chk.retryAfter);
  const later = await SR.check(P, { email: LUKE, subject: 'Something new', system: 'manual', now: TUE + 4 * DAY + 3600000 });
  ok('  and four days on, it clears', later.ok === true, later);
  // Released a week on: d2 goes; the due touch 2 (approved above, scheduled for the same tick) waits behind it.
  await P.query(`UPDATE outreach_logs SET scheduled_send_at=$1 WHERE id='sr-d2'`, [new Date(TUE + 7 * DAY - 120000)]);
  await P.query(`UPDATE outreach_logs SET scheduled_send_at=$2 WHERE id=$1`, [t2.id, new Date(TUE + 7 * DAY - 60000)]);
  const r3 = await release(TUE + 7 * DAY);
  ok('a week on, the second athlete\'s pitch goes out', r3.detail.some((d) => d.id === 'sr-d2' && d.result === 'sent'), r3.detail);
  const t2After = r3.detail.find((d) => d.id === t2.id);
  ok('  and the follow-up due the same morning waits its four days behind it', !!t2After && t2After.result === 'held' && /4 days/.test(t2After.why), t2After);

  // ── NEVER THE SAME SUBJECT TWICE ─────────────────────────────────────────
  await draft('sr-d3', 'sr-a1', 'Twice Co', 'twice@sr.example', 'Quick idea for Twice Co');
  await approve(['sr-d3'], TUE);
  await dueAll(TUE);
  const r4 = await release(TUE);
  ok('the first note to Twice Co sends', r4.detail.some((d) => d.id === 'sr-d3' && d.result === 'sent'), r4.detail);
  await draft('sr-d4', 'sr-a2', 'Twice Co', 'twice@sr.example', 'quick  idea for twice co');
  await approve(['sr-d4'], TUE + 14 * DAY);
  await P.query(`UPDATE outreach_logs SET scheduled_send_at=$1 WHERE id='sr-d4'`, [new Date(TUE + 14 * DAY - 60000)]);
  const r5 = await release(TUE + 14 * DAY);
  const twice = r5.detail.find((d) => d.id === 'sr-d4');
  ok('THE SAME SUBJECT TO THE SAME ADDRESS TWO WEEKS LATER IS STOPPED, NOT SENT', !!twice && twice.result === 'stopped' && /already sent/.test(twice.why), twice);
  ok('  for good: the draft is cadence-stopped', !!(await row('sr-d4')).cadence_stopped_at);
  const same = await SR.check(P, { email: 'twice@sr.example', subject: 'Quick Idea For Twice Co', system: 'compose', now: TUE + 30 * DAY });
  ok('  and a month later the inbox may not send it either', same.ok === false && same.kind === 'same-subject', same);
  const re = await SR.check(P, { email: 'twice@sr.example', subject: 'Re: Quick idea for Twice Co', system: 'follow-up', now: TUE + 30 * DAY });
  ok('  but the Re: follow-up is a different subject and may go', re.ok === true, re);

  // ── EVERY SEND IS ON THE RECORD ──────────────────────────────────────────
  const hist = await SR.history(P, LUKE, { days: 30, now: TUE + 8 * DAY });
  ok('the history of one address lists every send, newest first',
    hist.length >= 2 && hist[0].sentAt >= hist[hist.length - 1].sentAt, hist.map((h) => [h.sentAt, h.subject, h.label]));
  ok('  naming the system in words', hist.some((h) => h.label === 'Closer batch (approved pitch)') , hist.map((h) => h.label));
  ok('  with the subject and the agent', hist.every((h) => h.subject && h.agentId === AG), hist[0]);
  const mirror = (await P.query(`SELECT system, subject FROM email_sends WHERE email=$1 ORDER BY sent_at`, [LUKE])).rows;
  // Two Closer pitches and, once its four days were up (the TUE+14d release above), the follow-up.
  ok('  and the release wrote the shared send log', mirror.length === 3 && mirror.filter((m) => m.system === 'closer').length === 2 && mirror.some((m) => m.system === 'follow-up' && /^Re: /.test(m.subject)), mirror);
  ok('  which does not double-count a send that is also on outreach_logs', hist.filter((h) => h.subject === 'Quick idea for Mazur Motors').length === 1, hist);
  await SR.record(P, { email: LUKE, subject: 'Hello from the inbox', system: 'compose', agentId: AG, now: TUE + 6 * DAY });
  const hist2 = await SR.history(P, LUKE, { days: 30, now: TUE + 8 * DAY });
  ok('a send that has no table of its own still shows, from the shared log', hist2.some((h) => h.system === 'compose' && h.subject === 'Hello from the inbox'), hist2.map((h) => h.label));

  // ── THE SUPPRESSION LIST STOPS EVERYTHING ────────────────────────────────
  const bad = await SR.suppressManually(P, 'not an address', { reason: 'x' });
  ok('the list refuses a non-address', bad.ok === false, bad);
  await draft('sr-d5', 'sr-a1', 'Mazur Motors', LUKE, 'One more idea for Mazur Motors');
  const sup = await SR.suppressManually(P, 'Luke@SR.example ', { reason: 'asked us to stop', by: AG });
  ok('an admin can add an address by hand', sup.ok === true && sup.email === LUKE, sup);
  ok('  and every unsent draft to it stops at once', sup.stopped >= 1 && !!(await row('sr-d5')).cadence_stopped_at && /suppressed/.test((await row('sr-d5')).cadence_stop_reason), { stopped: sup.stopped, row: await row('sr-d5') });
  ok('  the suppression module sees it', (await SUP.isSuppressed(P, LUKE)).suppressed === true);
  const supChk = await SR.check(P, { email: LUKE, subject: 'Anything', system: 'manual', now: TUE + 60 * DAY });
  ok('  outreach is refused', supChk.ok === false && supChk.kind === 'suppressed', supChk);
  const digChk = await SR.check(P, { email: LUKE, system: 'nightly-digest' });
  ok('  and so is a digest', digChk.ok === false && digChk.kind === 'suppressed', digChk);
  let digestSent = 0;
  const nd = await ND.sendForRun(P, { agentId: AG, runDate: '2026-08-30', details: [{ athleteId: 'sr-a1', filled: 3 }] }, { send: async () => { digestSent++; return { data: { id: 'x' } }; } });
  ok('  the nightly digest itself does not go', nd.sent === false && /suppressed/.test(nd.reason) && digestSent === 0, nd);
  const listed = await SR.listSuppressed(P);
  ok('  the list shows it with the reason and who added it', listed.some((r) => r.email === LUKE && r.kind === 'manual' && /asked us to stop/.test(r.reason) && r.agent_email === LUKE), listed.filter((r) => r.email === LUKE));
  const un = await SR.unsuppress(P, LUKE);
  ok('  and it can be taken off again', un.ok === true && un.removed === 1 && (await SUP.isSuppressed(P, LUKE)).suppressed === false, un);

  // ── EVERY SENDER ASKS ────────────────────────────────────────────────────
  const idx = src('server/index.js');
  ok('the Closer release checks the rules before it reserves a send (services/closer)', /sendRules\.check\(pool, \{[\s\S]{0,200}system: Number\(log\.touch_no \|\| 1\) > 1 \? 'follow-up' : 'closer'/.test(src('server/services/closer.js')));
  ok('  and records the send after', /sendRules\.record\(pool, \{[\s\S]{0,120}subject: log\.subject/.test(src('server/services/closer.js')));
  ok('an agent clicking Send on a draft goes through the same check (routes/outreach)', /sendRules\.check\(pool, \{[\s\S]{0,160}system: Number\(log\.touch_no \|\| 1\) > 1 \? 'follow-up' : 'manual'/.test(src('server/routes/outreach.js')) && /res\.status\(409\)\.json\(\{ error: 'Not sent: ' \+ rule\.reason/.test(src('server/routes/outreach.js')));
  ok('  and a follow-up cannot be hand-sent before it is due', /This follow-up is not due until/.test(src('server/routes/outreach.js')));
  ok('a message composed in the inbox is checked per recipient (routes/email)', /for \(const addr of recipients\) \{\s*const rule = await sendRules\.check/.test(src('server/routes/email.js')) && /system: threadId \? 'reply' : 'compose'/.test(src('server/routes/email.js')));
  ok('an athlete\'s own brand email is checked (index _sendAthleteEmail)', /sendRules\.check\(store\.pool, \{ email: to, subject, system: 'athlete' \}\)/.test(idx) && /sendRules\.record\(store\.pool, \{ email: to, subject, system: 'athlete'/.test(idx));
  const growth = src('server/routes/growth.js');
  ok('the growth sequence is checked per prospect', /sendRules\.check\(store\.pool, \{ email: prospect\.email, subject, system: 'growth' \}\)/.test(growth));
  ok('  and its log row is written on its own, so a failed row can no longer look like a failed send and resend step 1', /SENT but could not log step/.test(growth) && /sendRules\.record\(store\.pool, \{ email: prospect\.email/.test(growth));
  ok('the nightly digest, weekly digest, shift report and deliverable reminders check the suppression list',
    /system: 'nightly-digest'/.test(src('server/services/nightlyDigest.js')) && /system: 'weekly-digest'/.test(src('server/jobs/weeklyDigest.js'))
    && /system: 'shift-report'/.test(idx) && /system: 'deliverable-digest'/.test(idx));
  ok('  as do the athlete report, the media-kit alert and the brand-inquiry forward', /system: 'report'/.test(idx) && /system: 'media-kit'/.test(idx) && /system: 'inquiry'/.test(idx));
  ok('the old follow-up poller writes no inbox drafts any more: the Closer cadence is the only follow-up sequence',
    !/INSERT INTO email_drafts/.test(src('server/services/followUpAutomation.js')) && /NO SECOND FOLLOW-UP SYSTEM/.test(src('server/services/followUpAutomation.js')));
  ok('the send log table is created at boot', /sendRules'\)\.ensureTable\(store\.pool\)/.test(idx));

  // ── THE ADMIN CAN SEE IT AND STOP IT ─────────────────────────────────────
  ok('GET /api/admin/email-history lists every email to one address', /app\.get\('\/api\/admin\/email-history', requireAuth/.test(idx) && /SR\.history\(store\.pool, email, \{ days \}\)/.test(idx));
  ok('the suppression list has list, add and remove endpoints',
    /app\.get\('\/api\/admin\/suppression', requireAuth/.test(idx) && /app\.post\('\/api\/admin\/suppression', requireAuth/.test(idx) && /app\.delete\('\/api\/admin\/suppression\/:email', requireAuth/.test(idx));
  const adminHtml = src('public/admin.html');
  ok('the admin page has the address lookup and the suppression panel', /api\/admin\/email-history\?email=/.test(adminHtml) && /Stop all email to this address/.test(adminHtml) && /Allow again/.test(adminHtml));

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await store.pool.end().catch(() => {});
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('sendrules: FAILED', e); process.exit(1); });
