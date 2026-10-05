'use strict';
// Runs against the local test Postgres. No network: Graph is a stand-in.
//
//   node tests/run.js                every suite, against the committed baseline
//   node tests/mailboxprospects.js   just this one
//
// ── TALKED TO, NO DEAL ──────────────────────────────────────────────────────
// The admin's real pipeline is in one Outlook mailbox. The definition of done:
//   ONLY that mailbox, and only under the admin login: a customer's mailbox,
//     or this address connected under someone else, is never read
//   a Calendly or Teams meeting that is clearly a NILDash sales call becomes a
//     prospect with its attendees; any other meeting does not
//   an email conversation with someone who is not a user, not internal and
//     not a machine becomes a prospect; one per company; company, people and
//     the date we last spoke
//   newest silence first
//   follow-ups: 4 days after the last word, then 7, three touches at most,
//     and a reply in the mailbox stops it dead (even one not yet synced)
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
process.env.ADMIN_EMAIL = 'mbp-admin@admin.example';
process.env.BUSINESS_MAILING_ADDRESS = process.env.BUSINESS_MAILING_ADDRESS || 'Compton Group LLC, 1 Test St, Austin, TX 78701';
delete process.env.PROSPECT_MAILBOX;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const MP = require(REPO + 'server/services/mailboxProspects.js');
const SR = require(REPO + 'server/services/sendRules.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const DAY = 86400000;
const ago = (d, h = 0) => new Date(Date.now() - d * DAY - h * 3600000).toISOString();
const ME = 'john@comptongroupllc.com';
const ADMIN = 'mbp-admin', CUSTOMER = 'mbp-customer', USERP = 'mbp-user';

// ── THE MAILBOX, AS GRAPH WOULD RETURN IT ───────────────────────────────────
const addr = (a, n) => ({ emailAddress: { address: a, name: n || '' } });
const MAIL = [];
// One conversation per subject root, as Outlook groups a thread.
const convOf = (subject) => 'conv:' + String(subject || '').replace(/^(re|fw|fwd):\s*/i, '').replace(/\s*\(last note\)$/i, '').toLowerCase();
const mail = (from, to, subject, at, { cc = [], conv } = {}) => { const id = 'm' + MAIL.length; MAIL.push({ id, conversationId: conv || convOf(subject), from: addr(from[0], from[1]), toRecipients: to.map((t) => addr(t[0], t[1])), ccRecipients: cc.map((t) => addr(t[0], t[1])), subject, sentDateTime: at, receivedDateTime: at, isDraft: false }); return id; };
// Dubose Sports: two people; they wrote 8 days ago, John answered 6 days ago.
mail(['jamie@dubosesports.com', 'Jamie Dubose'], [[ME, 'John']], 'NILDash for Dubose Sports', ago(8));
const DUB_LAST = mail([ME, 'John'], [['jamie@dubosesports.com', 'Jamie Dubose']], 'Re: NILDash for Dubose Sports', ago(6), { cc: [['ops@dubosesports.com', 'Riley Ops']] });
// Lee (a personal address): John wrote 10 days ago, Lee answered yesterday.
mail([ME, 'John'], [['lee.agent@gmail.com', 'Lee Park']], 'Roster question', ago(10));
mail(['lee.agent@gmail.com', 'Lee Park'], [[ME, 'John']], 'Re: Roster question', ago(1));
// Not prospects:
mail([ME, 'John'], [['keith@comptongroupllc.com', 'Keith Compton']], 'Internal', ago(3));          // internal
mail([ME, 'John'], [['already@user.example', 'Already User']], 'Hello', ago(3));                    // a NILDash user
mail(['noreply@calendly.com', 'Calendly'], [[ME]], 'New Event: NILDash Demo', ago(5));              // a machine
mail(['cold.inbound@spam.example', 'Sam Spam'], [[ME]], 'Buy our leads', ago(2));                   // inbound only, never answered
mail([ME, 'John'], [['notifications@hubspot.com']], 'Re: x', ago(2));                                // a machine
// Calendar traffic in the mailbox: the invitation to Pat, and Pat's acceptance
// AFTER the call -- neither is a conversation, and the acceptance is no reply.
MAIL.push({ id: 'inv1', '@odata.type': '#microsoft.graph.eventMessageRequest', conversationId: 'conv:invite', from: addr(ME), toRecipients: [addr('pat@bsports.com', 'Pat Barnes')], ccRecipients: [], subject: 'NILDash Demo', sentDateTime: ago(7), receivedDateTime: ago(7), isDraft: false });
MAIL.push({ id: 'acc1', conversationId: 'conv:invite', from: addr('pat@bsports.com', 'Pat Barnes'), toRecipients: [addr(ME)], ccRecipients: [], subject: 'Accepted: NILDash Demo', sentDateTime: ago(4), receivedDateTime: ago(4), isDraft: false });
const EVENTS = [
  { id: 'e1', subject: 'NILDash Demo', bodyPreview: 'Event Name: NILDash Demo. Powered by Calendly.com', start: { dateTime: ago(5, 1).replace('Z', '') }, end: { dateTime: ago(5).replace('Z', '') },
    attendees: [{ type: 'required', emailAddress: { address: 'pat@bsports.com', name: 'Pat Barnes' }, status: { response: 'accepted' } }, { type: 'required', emailAddress: { address: ME }, status: { response: 'organizer' } }],
    organizer: addr(ME), isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', isCancelled: false },
  { id: 'e2', subject: 'NILDash walkthrough', bodyPreview: 'Microsoft Teams meeting. Join on your computer', start: { dateTime: ago(2, 1).replace('Z', '') }, end: { dateTime: ago(2).replace('Z', '') },
    attendees: [{ type: 'required', emailAddress: { address: 'cara@csports.com', name: 'Cara Cole' }, status: { response: 'accepted' } }],
    organizer: addr(ME), isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness', isCancelled: false },
  { id: 'e3', subject: 'Weekly vendor sync', bodyPreview: 'Microsoft Teams meeting', start: { dateTime: ago(3, 1).replace('Z', '') }, end: { dateTime: ago(3).replace('Z', '') },
    attendees: [{ type: 'required', emailAddress: { address: 'vendor@printshop.com', name: 'Vic Vendor' } }], organizer: addr(ME), onlineMeetingProvider: 'teamsForBusiness', isCancelled: false },
  { id: 'e4', subject: 'NILDash Demo', bodyPreview: 'Calendly', start: { dateTime: ago(4, 1).replace('Z', '') }, end: { dateTime: ago(4).replace('Z', '') },
    attendees: [{ type: 'required', emailAddress: { address: 'gone@cancelled.com', name: 'Gone' } }], organizer: addr(ME), isCancelled: true },
];
const CALLS = [];
let LIVE_REPLY = null;          // what the live "did they write?" check returns
const graph = async (path, ctx) => {
  CALLS.push({ path, accountId: ctx.accountId, address: ctx.address });
  if (/from\/emailAddress\/address eq/.test(path)) return LIVE_REPLY ? [LIVE_REPLY] : [];
  const cm = path.match(/conversationId eq '([^']+)'/);
  if (cm) return MAIL.filter((m) => m.conversationId === cm[1].replace(/''/g, "'"));
  if (path.startsWith('/me/messages')) return MAIL.slice();
  if (path.startsWith('/me/calendarView')) return EVENTS.slice();
  throw new Error('unexpected Graph path ' + path);
};
const deps = { graph, send: async (m) => { SENT.push(m); return {}; }, awaitSend: true };
const SENT = [];

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await SR.ensureTable(P);
  await MP.ensureTables(P);
  const clean = async () => {
    await P.query(`DELETE FROM email_accounts WHERE user_id IN ($1,$2)`, [ADMIN, CUSTOMER]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id IN ($1,$2,$3)`, [ADMIN, CUSTOMER, USERP]).catch(() => {});
    await P.query(`DELETE FROM mailbox_prospect_drafts`).catch(() => {});
    await P.query(`DELETE FROM mailbox_prospect_people`).catch(() => {});
    await P.query(`DELETE FROM mailbox_prospects`).catch(() => {});
    await P.query(`DELETE FROM mailbox_prospect_runs`).catch(() => {});
    await P.query(`DELETE FROM email_sends WHERE email LIKE '%sports.com' OR email LIKE '%@gmail.com'`).catch(() => {});
    await P.query(`DELETE FROM email_suppression WHERE email LIKE '%sports.com'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id, name, email, role, password) VALUES ($1,'John Compton',$2,'admin','x'), ($3,'A Customer','customer@agency.example','agent','x'), ($4,'Already User','already@user.example','agent','x')`,
    [ADMIN, process.env.ADMIN_EMAIL, CUSTOMER, USERP]);
  const scopes = ['https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Calendars.Read', 'https://graph.microsoft.com/User.Read'];

  // ── 1. ONLY THIS MAILBOX, ONLY UNDER THE ADMIN ───────────────────────────
  OUT.push('-- one mailbox, never a customer\'s --');
  let r = await MP.run(P, { deps });
  ok('not connected: nothing is read, and the page says so', !r.ok && /not connected/.test(r.why) && CALLS.length === 0, r);
  await P.query(`INSERT INTO email_accounts (id, user_id, provider, email_address, granted_scopes) VALUES ('mbp-cust-acct', $1, 'outlook', $2, $3)`, [CUSTOMER, ME, scopes]);
  await P.query(`INSERT INTO email_accounts (id, user_id, provider, email_address, granted_scopes) VALUES ('mbp-cust-own', $1, 'outlook', 'customer@agency.example', $2)`, [CUSTOMER, scopes]);
  r = await MP.run(P, { deps });
  ok('THE SAME ADDRESS CONNECTED UNDER A CUSTOMER\'S LOGIN IS REFUSED, and no Graph call is made', !r.ok && /not under the admin login/.test(r.why) && CALLS.length === 0, r);
  await P.query(`INSERT INTO email_accounts (id, user_id, provider, email_address, granted_scopes) VALUES ('mbp-admin-acct', $1, 'outlook', $2, $3)`, [ADMIN, ME, scopes]);
  r = await MP.run(P, { deps });
  ok('under the admin login it is read', r.ok && r.messages === MAIL.length && r.meetings === 2, r);
  ok('  EVERY Graph call is on the admin\'s account for this address, never the customer\'s', CALLS.length > 0 && CALLS.every((c) => c.accountId === 'mbp-admin-acct' && c.address === ME), CALLS);
  const src = fs.readFileSync(REPO + 'server/services/mailboxProspects.js', 'utf8');
  ok('  and nothing reads the synced copies of anyone\'s mail (emails / email_threads tables)', !/FROM emails\b|FROM email_threads\b/.test(src));

  // ── 2. WHO BECOMES A PROSPECT ────────────────────────────────────────────
  OUT.push('', '-- who becomes a prospect --');
  const list = await MP.list(P);
  const byKey = Object.fromEntries(list.map((p) => [p.key, p]));
  ok('a Calendly NILDash demo is a prospect, with its attendee', byKey['bsports.com'] && byKey['bsports.com'].people.some((x) => x.email === 'pat@bsports.com' && x.name === 'Pat Barnes') && /Calendly/.test(byKey['bsports.com'].via), byKey['bsports.com']);
  ok('  a Teams meeting that says NILDash is one', !!byKey['csports.com']);
  ok('  a Teams meeting that does not ("Weekly vendor sync") is not; nor a cancelled one', !byKey['printshop.com'] && !byKey['cancelled.com']);
  ok('  the classifier, directly', MP.salesCall({ subject: 'NILDash Demo', bodyPreview: 'calendly.com/john' }).ok && !MP.salesCall({ subject: 'Lunch', bodyPreview: 'calendly' }).ok
    && MP.salesCall({ subject: 'Intro', bodyPreview: 'Calendly booking: Demo' }).ok && !MP.salesCall({ subject: 'NILDash chat', bodyPreview: 'phone call' }).ok);
  const dub = byKey['dubosesports.com'];
  ok('an email conversation is a prospect: one per company, both people, the company from the domain', dub && dub.company === 'Dubosesports' && dub.people.length === 2
    && dub.people.some((x) => x.email === 'jamie@dubosesports.com') && dub.people.some((x) => x.email === 'ops@dubosesports.com'), dub);
  ok('  with the date we last spoke and how', dub && Math.abs(new Date(dub.last_spoke_at) - new Date(ago(6))) < 60000 && dub.last_spoke_how === 'you emailed' && /Dubose Sports/.test(dub.last_subject), dub);
  ok('  a personal address is its own prospect', !!byKey['lee.agent@gmail.com'] && byKey['lee.agent@gmail.com'].company === null);
  ok('NOT: internal (the mailbox\'s own domain), a NILDash user, a machine, someone who only wrote in and was never answered',
    !list.some((p) => /comptongroupllc|user\.example|calendly|hubspot|spam\.example/.test(p.key)), list.map((p) => p.key));
  ok('NEWEST SILENCE FIRST', list.map((p) => p.key).join() === ['lee.agent@gmail.com', 'csports.com', 'bsports.com', 'dubosesports.com'].join(), list.map((p) => [p.key, p.last_spoke_at]));

  // ── 3. THE FOLLOW-UPS ────────────────────────────────────────────────────
  OUT.push('', '-- follow-ups --');
  const pend = (k) => (MP.list(P).then((l) => (l.find((p) => p.key === k) || {}).pending));
  const dd = await pend('dubosesports.com');
  ok('your last word 6 days ago, no reply: follow-up 1 is drafted, to the person you wrote to', dd && dd.touch_no === 2 && dd.email === 'jamie@dubosesports.com' && /^Re: NILDash for Dubose Sports$/.test(dd.subject), dd);
  ok('  AS A REPLY IN THE THREAD: the thread\'s subject, its conversation and its newest message', dd.kind === 'reply' && dd.conversation_id === 'conv:nildash for dubose sports' && dd.reply_message_id === DUB_LAST, dd);
  ok('  it adds something, never "following up", and names no price', /send me your roster/i.test(dd.body_text) && !/follow(ing)?[- ]?up|check(ing)? in|circl/i.test(dd.body_text) && /^Hi Jamie,/.test(dd.body_text), dd.body_text);
  const bNew = await pend('bsports.com');
  ok('a call 5 days ago with no email since: follow-up 1 is drafted', !!bNew);
  ok('  an attendee\'s "Accepted:" and the invitation are not a conversation: no reply recorded, no thread', MP.isCalendarMessage({ subject: 'Accepted: NILDash Demo' })
    && MP.isCalendarMessage({ '@odata.type': '#microsoft.graph.eventMessageRequest', subject: 'NILDash Demo' }) && !MP.isCalendarMessage({ subject: 'Re: NILDash Demo' }));
  ok('  AS A NEW EMAIL, because there is no thread, with its own subject and the call date for the card', bNew && bNew.kind === 'new' && !bNew.reply_message_id && bNew.subject === 'NILDash for Bsports' && !!bNew.meeting_at, bNew);
  ok('  a call 2 days ago: not yet (4 days)', !(await pend('csports.com')));
  const lee = (await MP.list(P)).find((p) => p.key === 'lee.agent@gmail.com');
  ok('THEY WROTE LAST (Lee, yesterday): nothing is drafted; it says it is your move', !lee.pending && /they replied/.test(lee.state_note || ''), lee);

  // Approve follow-up 1 for Dubose; it shows up in the mailbox as a sent message.
  const a1 = await MP.approve(P, dd.id, {}, deps);
  ok('approve sends it, from this mailbox, with the unsubscribe footer', a1.ok && SENT.length === 1 && SENT[0].to === 'jamie@dubosesports.com' && /unsubscribe/i.test(SENT[0].html), { a1, SENT });
  ok('  as a Graph reply to the newest message in that thread, never a new email', SENT[0].kind === 'reply' && SENT[0].replyToMessageId === DUB_LAST, SENT[0]);
  const sentAt = (await P.query(`SELECT sent_at FROM mailbox_prospect_drafts WHERE id = $1`, [dd.id])).rows[0].sent_at;
  const FU1 = mail([ME, 'John'], [['jamie@dubosesports.com']], 'RE: NILDash for Dubose Sports', new Date(sentAt).toISOString(), { conv: 'conv:nildash for dubose sports' });
  r = await MP.run(P, { deps, now: new Date(Date.now() + 3 * DAY) });
  ok('our own follow-up in the sent folder does not count as you speaking (no new sequence)', !(await pend('dubosesports.com')), r);
  r = await MP.run(P, { deps, now: new Date(Date.now() + 8 * DAY) });
  const d3 = await pend('dubosesports.com');
  ok('7 days after follow-up 1: follow-up 2, the last, the easiest no, still in the thread', d3 && d3.touch_no === 3 && /tell me and I will stop/i.test(d3.body_text) && d3.kind === 'reply' && d3.conversation_id === 'conv:nildash for dubose sports', d3);
  ok('  and it reuses nothing from follow-up 1', !require(REPO + 'server/services/followUps.js').reuses('<p>' + d3.body_text + '</p>', ['<p>' + dd.body_text + '</p>']));
  // Seven days have passed (the 4-day send rule would otherwise hold it).
  await P.query(`DELETE FROM email_sends WHERE email = 'jamie@dubosesports.com'`);
  const a3 = await MP.approve(P, d3.id, {}, deps);
  ok('  approving it sends it, threaded under follow-up 1 (now the newest message)', a3.ok && SENT.length === 2 && SENT[1].kind === 'reply' && SENT[1].replyToMessageId === FU1, { a3, err: (await P.query(`SELECT send_error FROM mailbox_prospect_drafts WHERE id = $1`, [d3.id])).rows[0] });
  mail([ME, 'John'], [['jamie@dubosesports.com']], 'RE: NILDash for Dubose Sports', new Date().toISOString(), { conv: 'conv:nildash for dubose sports' });
  r = await MP.run(P, { deps, now: new Date(Date.now() + 40 * DAY) });
  const dubAfter = (await MP.list(P)).find((p) => p.key === 'dubosesports.com');
  ok('THREE TOUCHES IS THE CEILING: nothing more is ever drafted', !dubAfter.pending && /three touches/.test(dubAfter.state_note || '') && SENT.length === 2, dubAfter);

  // ── 4. A REPLY STOPS IT DEAD ─────────────────────────────────────────────
  OUT.push('', '-- a reply stops it dead --');
  const bd = await pend('bsports.com');
  LIVE_REPLY = { id: 'live1', from: addr('pat@bsports.com'), receivedDateTime: new Date().toISOString(), subject: 'Re: NILDash Demo' };
  const a2 = await MP.approve(P, bd.id, {}, deps);
  const bRow = (await P.query(`SELECT status, status_note FROM mailbox_prospect_drafts WHERE id = $1`, [bd.id])).rows[0];
  ok('A REPLY IN THE MAILBOX, NOT YET SYNCED, STOPS THE SEND AT APPROVE (checked live)', !a2.ok && /they replied/.test(a2.error) && bRow.status === 'skipped' && SENT.length === 2, { a2, bRow });
  LIVE_REPLY = null;
  // Cara: a call, then she replies before the 4 days are up, as the sync sees it.
  mail(['cara@csports.com', 'Cara Cole'], [[ME]], 'Re: NILDash walkthrough', ago(1));
  r = await MP.run(P, { deps, now: new Date(Date.now() + 10 * DAY) });
  const cara = (await MP.list(P)).find((p) => p.key === 'csports.com');
  ok('  and at every sync: she wrote after the call, so nothing is ever drafted', !cara.pending && /they replied/.test(cara.state_note || ''), cara);
  // A pending draft when the reply lands is withdrawn at the next sync.
  await P.query(`INSERT INTO mailbox_prospect_drafts (id, prospect_id, email, subject, body_text, touch_no) VALUES ('mbp-old', $1, 'cara@csports.com', 'Re: x', 'Hi', 2)`, [cara.id]);
  await MP.run(P, { deps });
  ok('  a waiting draft is withdrawn the moment a sync sees the reply', (await P.query(`SELECT status FROM mailbox_prospect_drafts WHERE id = 'mbp-old'`)).rows[0].status === 'skipped');
  // Bounce / unsubscribe: never starts.
  await require(REPO + 'server/services/suppression.js').suppress(P, 'pat@bsports.com', { reason: 'unsubscribed', kind: 'unsubscribe' });
  ok('a suppressed address is refused at send', /unsubscribed|suppress/.test(await MP.stopForSend(P, { prospect_id: bd.prospect_id, email: 'pat@bsports.com' }, deps) || ''));

  // ── 4b. IN THE THREAD OR NOT AT ALL ──────────────────────────────────────
  OUT.push('', '-- in the thread, or not at all --');
  // A clean prospect (nothing stops it), whose thread has since been deleted.
  const gp = (await P.query(`INSERT INTO mailbox_prospects (key, company, last_spoke_at, last_spoke_how, last_out_at) VALUES ('gone.example', 'Gone', $1, 'you emailed', $1) RETURNING id`, [ago(6)])).rows[0].id;
  await P.query(`INSERT INTO mailbox_prospect_people (prospect_id, email, name) VALUES ($1, 'nobody@gone.example', 'No Body')`, [gp]);
  await P.query(`INSERT INTO mailbox_prospect_drafts (id, prospect_id, email, subject, body_text, touch_no, kind, conversation_id, status)
                 VALUES ('mbp-gone', $1, 'nobody@gone.example', 'RE: lost', 'Hi', 2, 'reply', 'conv:a thread deleted from the mailbox', 'sending')`, [gp]);
  const n0 = SENT.length;
  const gone = await MP.sendOne(P, (await P.query(`SELECT * FROM mailbox_prospect_drafts WHERE id = 'mbp-gone'`)).rows[0], { ...deps, graph: async (pth, c) => (/conversationId eq/.test(pth) ? [] : graph(pth, c)) });
  const goneRow = (await P.query(`SELECT status, send_error FROM mailbox_prospect_drafts WHERE id = 'mbp-gone'`)).rows[0];
  ok('A REPLY WHOSE THREAD CANNOT BE FOUND IS NOT SENT, and is never turned into a new email', SENT.length === n0 && !gone.ok
    && goneRow.status === 'failed' && /never sent outside the thread/.test(goneRow.send_error || ''), { gone, goneRow });
  await P.query(`DELETE FROM mailbox_prospect_people WHERE prospect_id = $1`, [gp]);
  await P.query(`DELETE FROM mailbox_prospects WHERE id = $1`, [gp]);
  await P.query(`DELETE FROM mailbox_prospect_drafts WHERE id = 'mbp-gone'`);
  // A draft from before this change (no kind): withdrawn, never sent as it is.
  const cara2 = (await MP.list(P)).find((p) => p.key === 'csports.com');
  await P.query(`INSERT INTO mailbox_prospect_drafts (id, prospect_id, email, subject, body_text, touch_no) VALUES ('mbp-legacy', $1, 'cara@csports.com', 'Re: x', 'Hi', 2)`, [cara2.id]);
  const leg = await MP.approve(P, 'mbp-legacy', {}, deps);
  ok('an old draft written before threading is refused at Approve', !leg.ok && /rewritten/.test(leg.error), leg);
  await P.query(`UPDATE mailbox_prospects SET status = 'open' WHERE id = $1`, [cara2.id]);
  await MP.run(P, { deps });
  ok('  and withdrawn at the next read (superseded, not "skipped": the touch is offered again)', (await P.query(`SELECT status FROM mailbox_prospect_drafts WHERE id = 'mbp-legacy'`)).rows[0].status !== 'pending');
  const ps = fs.readFileSync(REPO + 'server/services/mailboxProspects.js', 'utf8');
  ok('the real send is Graph\'s reply on that message, addressed to the person', /OL\.sendEmail\(full\.accessToken, full\.refreshToken, \{ to: \[d\.email\], replyToMessageId: target, bodyHtml: html \}\)/.test(ps));
  const pg2 = fs.readFileSync(REPO + 'public/admin-prospects.html', 'utf8');
  ok('the card says which kind: "Reply in the thread" or "New email" with why', />Reply in the thread</.test(pg2) && />New email</.test(pg2) && /There is no email thread with/.test(pg2));

  // ── 5. THE PAGE AND THE PERMISSION ───────────────────────────────────────
  OUT.push('', '-- the page and the permission --');
  const page = fs.readFileSync(REPO + 'public/admin-prospects.html', 'utf8');
  ok('/admin/prospects has the "Talked to, no deal" group with Approve, Skip and the marks', />Talked to, no deal</.test(page) && /mbpApprove\(/.test(page) && /mbpMark\(/.test(page) && /loadMailboxProspects\(\);/.test(page));
  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('  every route is admin-only', ['/admin/prospects/connect-mailbox', '/api/admin/mailbox-prospects', '/api/admin/mailbox-prospects/sync', '/api/admin/mailbox-prospects/drafts/:id/approve', '/api/admin/mailbox-prospects/:id/mark']
    .every((pth) => new RegExp(`app\\.(get|post)\\('${pth.replace(/[/:]/g, (c) => '\\' + c)}', _coldAdmin`).test(idx)));
  const em = fs.readFileSync(REPO + 'server/routes/email.js', 'utf8');
  ok('calendar access is only ever asked for on the admin login', /if \(req\.query\.calendar === '1'\)[\s\S]{0,500}adminEmail\(\)[\s\S]{0,200}status\(403\)/.test(em));
  const OL = require(REPO + 'server/services/providers/outlook.js');
  ok('  the ordinary connections are unchanged: send-only and read-only ask for no calendar', !OL.SCOPES_SEND.some((s) => /Calendars/.test(s)) && !OL.SCOPES_READ.some((s) => /Calendars/.test(s)) && OL.SCOPES_PROSPECTS.some((s) => /Calendars\.Read$/.test(s)));
  const fa = fs.readFileSync(REPO + 'server/services/followUpAutomation.js', 'utf8');
  ok('the hourly poller reads it', /require\('\.\/mailboxProspects'\)\.run\(pool\)/.test(fa));

  await clean();
  OUT.push('', 'failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
})().catch((e) => { OUT.push('FAIL threw: ' + (e && e.stack)); console.log(OUT.join('\n')); process.exit(1); });
