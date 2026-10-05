'use strict';
// Runs against the local test Postgres. No network.
//
//   node tests/run.js           every suite, against the committed baseline
//   node tests/followups.js     just this one
//
// ── FOLLOW-UPS, WITH THE SAME APPROVE BUTTON ───────────────────────────────
// 52 contacted, 2 replies, and no follow-up ever reached a business. The
// definition of done, as a test:
//   a sent email with no reply after 4 days becomes a follow-up card on Home
//   second follow-up 7 days after the first; three touches is the hard ceiling,
//     then the address rests 90 days
//   a reply (on any touch, in a connected mailbox) stops the sequence
//   a bounce, an unsubscribe or a suppression never starts one
//   the agent marking it dead stops it; an unsent first email never starts one
//   it never says "following up", never names a price, never reuses the first
//     email, and the last touch is the easiest to say no to
//   Home: replies at the top with what they said, every card with its history,
//     and a plain line of what happened since yesterday
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const FUP = require(REPO + 'server/services/followUps.js');
const FA = require(REPO + 'server/services/followUpAutomation.js');
const HQ = require(REPO + 'server/services/homeQueue.js');
const SR = require(REPO + 'server/services/sendRules.js');
const SUP = require(REPO + 'server/services/suppression.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const AG = 'fu-agent', ATH = 'fu-ath';
const DAY = 86400000;
const FIRST = '<p>Hi Pat,</p><p>Here is something concrete for FU Bakery: two Instagram posts and one in-store meet-up, with Fay on camera and the content yours to keep.</p><p>Fay Player plays softball at Auburn and grew up nearby.</p><p>Jo</p>';

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await require(REPO + 'server/services/dealLog.js').ensureTable(P);
  await SR.ensureTable(P);
  const clean = async () => {
    await P.query(`DELETE FROM outreach_logs WHERE agent_id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM brand_engagement WHERE athlete_id = $1`, [ATH]).catch(() => {});
    await P.query(`DELETE FROM emails WHERE user_id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM email_suppression WHERE email LIKE '%@fu.example'`).catch(() => {});
    await P.query(`DELETE FROM email_sends WHERE email LIKE '%@fu.example'`).catch(() => {});
    await P.query(`DELETE FROM market_business_seen WHERE market_key = 'fu-town, al'`).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE id = $1`, [ATH]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id, name, email, role, password) VALUES ($1, 'Jo Agent', 'jo@agency.example', 'agent', 'x')`, [AG]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1, $2, '{"name":"Fay Player","school":"Auburn University","sport":"Softball","stats":"hit .340 with 9 home runs","over18":"true"}'::jsonb)`, [ATH, AG]);
  await P.query(`INSERT INTO market_business_seen (market_key, brand, category) VALUES ('fu-town, al', 'FU Climbing Gym', 'gym') ON CONFLICT DO NOTHING`);
  // One sent first email per business, sentDaysAgo back, with its card.
  let slot = 0;
  const first = async (key, brand, email, sentDaysAgo, { sent = true, body = FIRST } = {}) => {
    const id = 'fu-' + key;
    await P.query(
      `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, brand_key, subject, body_html, status, touch_no, sent_to_email, sent_at, approved_at, created_at, category_key)
       VALUES ($1,$2,$3,$4,$5,'Fay Player x ' || $4, $6, $7, 1, $8, $9, $9, $9, 'restaurant')`,
      [id, AG, ATH, brand, 'place:' + key, body, sent ? 'sent' : 'approved', email, sent ? new Date(Date.now() - sentDaysAgo * DAY) : null]);
    await P.query(
      `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, state, channel, sent_via, sent_at, contact_name, lane, outreach_log_id, business_category, market_key)
       VALUES ($1,$2,$3,$4,$5,$6,'email','email',$7,'Pat Owner','local',$8,'bakery','fu-town, al')`,
      [AG, ATH, ++slot, 'place:' + key, brand, sent ? 'sent' : 'queued', sent ? new Date(Date.now() - sentDaysAgo * DAY) : null, id]);
    await P.query(`INSERT INTO brand_engagement (agent_id, athlete_id, brand_key, brand_name, lane, state, contacted_at) VALUES ($1,$2,$3,$4,'local','contacted',NOW()) ON CONFLICT DO NOTHING`,
      [AG, ATH, 'place:' + key, brand]);
    return id;
  };
  const due = await first('bakery', 'FU Bakery', 'pat@fu.example', 5);
  const early = await first('early', 'FU Early', 'early@fu.example', 3);
  const bounced = await first('bounce', 'FU Bounce', 'dead@fu.example', 6);
  await SUP.suppress(P, 'dead@fu.example', { reason: 'hard bounce', kind: 'bounce' });
  const unsub = await first('unsub', 'FU Unsub', 'stop@fu.example', 6);
  await SUP.suppress(P, 'stop@fu.example', { reason: 'unsubscribed', kind: 'unsubscribe' });
  const unsent = await first('unsent', 'FU Unsent', 'never@fu.example', 6, { sent: false });
  const marked = await first('dead', 'FU Dead', 'dead2@fu.example', 6);
  await P.query(`UPDATE brand_engagement SET state = 'dead' WHERE athlete_id = $1 AND brand_key = 'place:dead'`, [ATH]);
  // The OLD empty follow-up the closer used to write: no body, created at the send.
  const legacy = await first('legacy', 'FU Legacy', 'legacy@fu.example', 9);
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, status, touch_no, parent_id, sent_to_email, created_at, next_follow_up_at, source)
                 VALUES ($1,$2,$3,'FU Legacy','Re: x','expired',2,$4,'legacy@fu.example',NOW() - INTERVAL '9 days', NOW() - INTERVAL '5 days','closer-cadence')`, [legacy + '-t2', AG, ATH, legacy]);

  // ── 1. WHAT IS WRITTEN, AND WHEN ─────────────────────────────────────────
  OUT.push('-- written when due, as a draft card --');
  const run1 = await FUP.run(P, { agentId: AG });
  const written = new Set(run1.written.map((w) => w.id));
  ok('a sent email with no reply after 4 days becomes a follow-up draft (touch 2)', written.has(due + '-t2'), run1);
  ok('  not at 3 days', !written.has(early + '-t2'));
  ok('A BOUNCE NEVER STARTS ONE, nor an unsubscribe', !written.has(bounced + '-t2') && !written.has(unsub + '-t2')
    && run1.stopped.some((x) => x.root === bounced) && run1.stopped.some((x) => x.root === unsub), run1.stopped);
  ok('  nor a first email that never sent', !written.has(unsent + '-t2'));
  ok('  nor one the agent marked dead', !written.has(marked + '-t2') && run1.stopped.some((x) => x.root === marked && /dead/.test(x.why)), run1.stopped);
  ok('the old EMPTY follow-up is written now, with a body', written.has(legacy + '-t2')
    && !!(await P.query(`SELECT body_html FROM outreach_logs WHERE id = $1`, [legacy + '-t2'])).rows[0].body_html);
  const t2 = (await P.query(`SELECT * FROM outreach_logs WHERE id = $1`, [due + '-t2'])).rows[0];
  ok('  an ordinary draft in the agent queue: status draft, due, created now (the 7-day expiry counts from today)',
    t2.status === 'draft' && t2.parent_id === due && Number(t2.touch_no) === 2 && new Date(t2.next_follow_up_at) <= new Date()
    && Date.now() - new Date(t2.created_at) < 60000, t2);
  ok('  threads under the first subject', /^Re: Fay Player x FU Bakery$/.test(t2.subject), t2.subject);
  const again = await FUP.run(P, { agentId: AG });
  ok('  a second pass writes nothing twice', !again.written.length && again.waiting >= 2, again);

  // ── 2. WHAT IT SAYS ──────────────────────────────────────────────────────
  OUT.push('', '-- what it says --');
  const body2 = FUP.textOf(t2.body_html);
  ok('A FOLLOW-UP NEVER REUSES THE FIRST EMAIL: the first email already offered the deliverable, so the follow-up does not repeat it',
    !FUP.reuses(t2.body_html, [FIRST]) && !/two Instagram posts and one in-store meet-up/.test(body2) && !/Here is something concrete/.test(body2), body2);
  ok('  and adds something the first did not: the athlete record on file', /hit \.340 with 9 home runs/.test(body2), body2);
  const fresh = FUP.compose({ contactFirst: 'Lee', brand: 'FU Gym', category: 'gym', athlete: { name: 'Fay Player', first: 'Fay' }, deliverable: FUP.deliverableFor('gym'), nearby: null, agentFirst: 'Jo', signature: {} }, 2, []);
  ok('  with nothing used yet, touch 2 leads with a concrete deliverable and a count', /four short training videos/.test(fresh.text) && fresh.material.includes('deliverable'), fresh.text);
  const bare = FUP.compose({ contactFirst: null, brand: 'FU Gym', category: 'gym', athlete: { name: 'Fay Player', first: 'Fay' }, deliverable: FUP.deliverableFor('gym'), nearby: null, agentFirst: 'Jo', signature: {} }, 2, [fresh.html]);
  ok('  and when every idea was already said, it still brings something new rather than only asking for a call', bare.material.some((k) => k !== 'ask') && !FUP.reuses(bare.html, [fresh.html]), bare);
  ok('  never "following up", "checking in", "circling back", "bumping"', !FUP.BANNED.some((re) => re.test(body2)), body2);
  ok('  the checker catches each of them', ['Just following up on this.', 'Checking in on my note.', 'Circling back here.', 'Bumping this to the top.', 'As I mentioned before, we would love this.'].every((t) =>
    FUP.checkFollowUp({ subject: 'Re: x', body: '<p>' + t + ' If this is not for you, tell me and I will stop.</p>', earlier: [], touch: 3 }).some((p) => /phrase/.test(p))));
  ok('  never anchors on the season (pitchWriter\'s rule: we do not hold the schedule)', FUP.checkFollowUp({ subject: 'Re: x', body: '<p>Two posts before the season starts.</p>', earlier: [], touch: 2 }).some((p) => /season/.test(p)));
  ok('  no price, ever (pitchWriter\'s rule)', FUP.checkFollowUp({ subject: 'Re: x', body: '<p>Two posts for $500.</p>', earlier: [], touch: 2 }).some((p) => /price/.test(p)));
  ok('  reuse is refused: a sentence or any seven-word run from an earlier touch', !!FUP.reuses('<p>Fay Player plays softball at Auburn and grew up nearby.</p>', [FIRST])
    && !!FUP.reuses('<p>with Fay on camera and the content yours to keep, as discussed</p>', [FIRST]) && !FUP.reuses('<p>Hi Pat,</p><p>Jo</p>', [FIRST]));

  // ── 3. THE THIRD TOUCH, AND THE CEILING ──────────────────────────────────
  OUT.push('', '-- the third touch, and three is the ceiling --');
  // Touch 2 goes out (as the closer would mark it), and seven days pass.
  await P.query(`UPDATE outreach_logs SET status = 'sent', sent_at = NOW() - INTERVAL '8 days', approved_at = NOW() - INTERVAL '8 days' WHERE id = $1`, [due + '-t2']);
  await P.query(`UPDATE outreach_logs SET sent_at = NOW() - INTERVAL '13 days' WHERE id = $1`, [due]);
  const run3 = await FUP.run(P, { agentId: AG });
  const t3 = (await P.query(`SELECT * FROM outreach_logs WHERE id = $1`, [due + '-t3'])).rows[0];
  ok('touch 3 is written 7 days after touch 2', run3.written.some((w) => w.id === due + '-t3') && t3 && Number(t3.touch_no) === 3, run3);
  const body3 = FUP.textOf(t3 && t3.body_html);
  ok('  the last touch is the easiest to say no to', /tell me and I will stop/i.test(body3) && /\(last note\)$/.test(t3.subject), body3);
  ok('  and adds something new again: another business nearby, as an idea', /FU Climbing Gym/.test(body3), body3);
  ok('  reusing neither earlier touch', !FUP.reuses(t3.body_html, [FIRST, (await P.query(`SELECT body_html FROM outreach_logs WHERE id = $1`, [due + '-t2'])).rows[0].body_html]));
  await P.query(`UPDATE outreach_logs SET status = 'sent', sent_at = NOW() - INTERVAL '1 day', approved_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [due + '-t3']);
  await P.query(`UPDATE outreach_logs SET sent_at = NOW() - INTERVAL '9 days' WHERE id = $1`, [due + '-t2']);
  const run4 = await FUP.run(P, { agentId: AG, now: new Date(Date.now() + 30 * DAY) });
  ok('THREE TOUCHES IS THE HARD CEILING: nothing is ever written after touch 3', !run4.written.some((w) => w.id.startsWith(due)) && !(await P.query(`SELECT 1 FROM outreach_logs WHERE id = $1`, [due + '-t4'])).rows.length, run4);
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, touch_no, parent_id, sent_to_email, approved_at)
                 VALUES ($1,$2,$3,'FU Bakery','Re: x 4','<p>x</p>','approved',4,$4,'pat@fu.example',NOW())`, [due + '-t4', AG, ATH, due]);
  ok('  and a fourth that somehow exists is refused at send', /three touches/.test(await FUP.stopForSend(P, { touch_no: 4, parent_id: due }) || ''));
  await P.query(`DELETE FROM outreach_logs WHERE id = $1`, [due + '-t4']);
  const rest = await SR.check(P, { email: 'pat@fu.example', subject: 'A brand new pitch', system: 'closer' });
  ok('  then the business rests 90 days: a new first email to it is refused', !rest.ok && rest.kind === 'rest' && /rests until/.test(rest.reason), rest);

  // ── 4. A REPLY STOPS IT ──────────────────────────────────────────────────
  OUT.push('', '-- a reply stops the sequence --');
  // FU Legacy: touch 2 is written and waiting. They reply to touch 1.
  await FA.markReplied(legacy, new Date(), { text: 'Yes, we would love to talk. Call me Tuesday.', from: 'legacy@fu.example' });
  const lg2 = (await P.query(`SELECT cadence_stopped_at, cadence_stop_reason FROM outreach_logs WHERE id = $1`, [legacy + '-t2'])).rows[0];
  ok('A REPLY STOPS THE SEQUENCE AT ONCE: the waiting follow-up is stopped', !!lg2.cadence_stopped_at && /replied/.test(lg2.cadence_stop_reason), lg2);
  ok('  and if it was approved anyway, the send refuses it (the reply is on another touch)', /replied/.test(await FUP.stopForSend(P, { touch_no: 2, parent_id: legacy }) || ''));
  // FU Early: a reply that only reached the agent's connected Gmail.
  await P.query(`UPDATE outreach_logs SET sent_at = NOW() - INTERVAL '5 days' WHERE id = $1`, [early]);
  await P.query(`INSERT INTO emails (id, account_id, thread_id, user_id, direction, from_address, subject, body_text, sent_at) VALUES ('fu-e1', 'fu-acct', 'fu-th1', $1, 'received', 'early@fu.example', 'Out of office', 'I am away', NOW() - INTERVAL '2 days')`, [AG]);
  let runE = await FUP.run(P, { agentId: AG });
  const eLive = (await P.query(`SELECT body_html, cadence_stopped_at FROM outreach_logs WHERE id = $1`, [early + '-t2'])).rows[0];
  ok('  an out-of-office auto-reply is not a reply: the follow-up stays live', eLive && eLive.body_html && !eLive.cadence_stopped_at && !runE.stopped.some((x) => x.root === early), { eLive, runE });
  await P.query(`INSERT INTO emails (id, account_id, thread_id, user_id, direction, from_address, subject, body_text, sent_at) VALUES ('fu-e2', 'fu-acct', 'fu-th2', $1, 'received', 'early@fu.example', 'Re: Fay Player x FU Early', 'Sounds good, what dates work?', NOW() - INTERVAL '20 hours')`, [AG]);
  runE = await FUP.run(P, { agentId: AG });
  const er = (await P.query(`SELECT replied_at, reply_text FROM outreach_logs WHERE id = $1`, [early])).rows[0];
  const et2 = (await P.query(`SELECT cadence_stopped_at FROM outreach_logs WHERE id = $1`, [early + '-t2'])).rows[0];
  ok('  a reply in any connected mailbox is found, recorded with what it said, and stops the sequence',
    runE.replies >= 1 && !!er.replied_at && /what dates work/.test(er.reply_text || '') && !!et2.cadence_stopped_at, { runE, er, et2 });
  // A bounce that landed in the mailbox.
  const mb = await first('mbounce', 'FU Mailbox Bounce', 'gone@fu.example', 6);
  await P.query(`INSERT INTO emails (id, account_id, thread_id, user_id, direction, from_address, subject, body_text, sent_at) VALUES ('fu-e3', 'fu-acct', 'fu-th3', $1, 'received', 'mailer-daemon@googlemail.com', 'Delivery Status Notification (Failure)', 'Address not found: gone@fu.example does not exist. 550 5.1.1 user unknown', NOW() - INTERVAL '5 days')`, [AG]);
  const runB = await FUP.run(P, { agentId: AG });
  ok('  a bounce that came back to the mailbox suppresses the address and never starts one', (await SUP.isSuppressed(P, 'gone@fu.example')).suppressed && !runB.written.some((w) => w.id === mb + '-t2'), runB);

  // ── 5. THE AGENT SEES WHAT HAPPENED ──────────────────────────────────────
  OUT.push('', '-- Home shows what happened --');
  // A fresh due follow-up for the page.
  const page = await first('page', 'FU Page Shop', 'page@fu.example', 6);
  await FUP.run(P, { agentId: AG });
  const home = await HQ.buildHome(P, AG, { athleteId: ATH });
  const fuCard = (home.cards || []).find((c) => c.id === 'email:' + page + '-t2');
  ok('the follow-up is a card in the normal morning queue, same email card, same Approve', !!fuCard && fuCard.channel === 'email', (home.cards || []).map((c) => [c.id, c.channel]));
  ok('  it says which follow-up it is, with the thread so far', fuCard && fuCard.followUp && fuCard.followUp.n === 1 && fuCard.followUp.history.some((h) => /^Sent /.test(h)) && fuCard.followUp.history.includes('no reply'), fuCard && fuCard.followUp);
  ok('  and ranks first on the page', (home.cards || []).length && (home.cards[0].followUp || null) !== null, (home.cards || []).map((c) => c.id));
  const rep = (home.replies || []).find((r) => r.business === 'FU Legacy');
  ok('A REPLY GOES TO THE TOP with what they said, roster-wide, until it is handled', rep && /Call me Tuesday/.test(rep.text) && !!rep.cardId, home.replies);
  ok('  the mailbox reply too', (home.replies || []).some((r) => r.business === 'FU Early' && /what dates work/.test(r.text)));
  ok('"since yesterday" says it plainly: businesses replied, follow-ups ready', home.sinceYesterday && home.sinceYesterday.replied >= 2 && home.sinceYesterday.followUpsReady >= 1, home.sinceYesterday);
  const sentRow = (home.sent || []).find((r) => r.business === 'FU Bakery');
  ok('every sent card carries its history: sent, follow-up 1 sent, follow-up 2 sent, no reply', sentRow
    && /^Sent /.test(sentRow.history[0]) && sentRow.history.some((h) => /^Follow-up 1 sent/.test(h)) && sentRow.history.some((h) => /^Follow-up 2 sent/.test(h)) && sentRow.history.includes('no reply'), sentRow);
  const repRow = (home.sent || []).find((r) => r.business === 'FU Legacy');
  ok('  and a replied one says so', repRow && repRow.history.some((h) => /^Replied /.test(h)) && !repRow.history.includes('no reply'), repRow);
  await P.query(`UPDATE outreach_logs SET reply_handled_at = NOW() WHERE id = $1`, [legacy]);
  ok('  "Handled" takes it off the top', !((await HQ.buildHome(P, AG, { athleteId: ATH })).replies || []).some((r) => r.business === 'FU Legacy'));

  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  const pg = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('the page renders the replies and the since-yesterday line above the tabs, and the follow-up badge on the card',
    /<div id="home-news"><\/div>/.test(pg) && /news\.innerHTML = hqNewsHtml\(d\)/.test(pg) && /Follow-up ' \+ c\.followUp\.n \+ ' of '/.test(pg) && /hqReplyHandled\(/.test(pg));
  ok('"Stop follow-ups" on a sent card marks it dead and stops the thread', />Stop follow-ups</.test(pg) && /outcome === 'dead'\) \{[\s\S]{0,300}state: 'dead'/.test(idx) && /stopsFollowUps && card\.outreach_log_id/.test(idx));
  const closerSrc = fs.readFileSync(REPO + 'server/services/closer.js', 'utf8');
  ok('the closer no longer writes empty follow-ups at send time, and asks the whole thread before sending one',
    !/INSERT INTO outreach_logs[\s\S]{0,300}'closer-cadence'/.test(closerSrc) && /require\('\.\/followUps'\)\.stopForSend/.test(closerSrc));
  const fa = fs.readFileSync(REPO + 'server/services/followUpAutomation.js', 'utf8');
  ok('the hourly poller runs it', /require\('\.\/followUps'\)\.run\(pool\)/.test(fa));

  const { spawnSync } = require('child_process');
  const pl = spawnSync(process.execPath, [REPO + 'scripts/follow-up-plan.js'], { env: { ...process.env, INIT_WAIT_MS: '3000' }, encoding: 'utf8', timeout: 120000 });
  ok('the admin plan shows every thread by agent with what happens next', pl.status === 0 && /Jo Agent <jo@agency\.example>/.test(pl.stdout) && /STOPPED: hard bounce/.test(pl.stdout) && /SUMMARY/.test(pl.stdout), (pl.stdout || '') + (pl.stderr || ''));
  ok('  registered as an admin script', /'follow-up-plan': \{ file: 'scripts\/follow-up-plan\.js'/.test(idx));

  await clean();
  OUT.push('', 'failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
})().catch((e) => { OUT.push('FAIL threw: ' + (e && e.stack)); console.log(OUT.join('\n')); process.exit(1); });
