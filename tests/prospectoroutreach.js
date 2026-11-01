'use strict';
// ── PROSPECTOR OUTREACH: OUR OWN COLD EMAILS TO IT COMPANIES ────────────────
// services/prospector/outreach. Local test Postgres; the mailboxes, the alert
// and the sample builder are stand-ins.
//
//   - an import is a draft until approved; bad, repeat, same-company,
//     customer and suppressed addresses are skipped;
//   - nothing goes out while off, outside weekday hours, or without the
//     mailing address; every email carries the unsubscribe and the address;
//   - one send per mailbox per tick, 4 minutes apart, under the warm-up cap;
//   - follow-ups on day 3 and day 7 in the same thread from the same mailbox;
//   - a reply stops the sequence; "yes" gets the free sample link (auto only
//     with PROSPECTOR_AUTOSEND_ON); "stop" and bounces go on the suppression
//     list; too many bounces pause everything; Microsoft limiting a mailbox
//     stops that mailbox for the day;
//   - the routes are wired and admin only.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('prospectoroutreachtest', { schema: true });
require('./helpers/offlineDns').install();
delete process.env.PROSPECTOR_OUTREACH_ON;
delete process.env.PROSPECTOR_AUTOSEND_ON;
delete process.env.BUSINESS_MAILING_ADDRESS;
process.env.PROSPECTOR_FROM_ADDRESS = 'john@salesbox.test, jm@salesbox.test';
process.env.PROSPECTOR_BASE_URL = 'https://mynildash.com';

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const O = require(REPO + 'server/services/prospector/outreach.js');
const MB = require(REPO + 'server/services/salesMailbox.js');
const sup = require(REPO + 'server/services/suppression.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const P = () => store.pool;

// Tuesday 3 Nov 2026, 10:00 Central (16:00 UTC; daylight time ended 1 Nov).
const T0 = new Date('2026-11-03T16:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60000);
const days = (d, min = 0) => new Date(T0.getTime() + d * 86400000 + min * 60000);

function fakeMail() {
  const sent = [];
  let inbox = [], failNext = null;
  return {
    sent,
    setInbox(m) { inbox = m; },
    failWith(e) { failNext = e; },
    sendNew: async (mb, { to, subject, text }) => {
      if (failNext) { const e = failNext; failNext = null; throw e; }
      sent.push({ kind: 'new', from: mb.address, to, subject, text }); return { messageId: 'msg_' + to, conversationId: 'conv_' + to };
    },
    reply: async (mb, { messageId, to, text }) => { sent.push({ kind: 'reply', from: mb.address, messageId, to, text }); return {}; },
    findSent: async () => null,
    // The inbox of the first mailbox; the second one is empty.
    inboxSince: async (mb) => (mb.address === 'john@salesbox.test' ? inbox : []),
    ensureFolder: async () => 'folder1',
    move: async () => ({}),
    textOf: MB.textOf, fromOf: MB.fromOf,
  };
}
const alerts = [];
const samples = [];
const mail = fakeMail();
const deps = {
  mail,
  account: async (addr) => ({ ok: true, address: addr, accountId: 1, canSend: true, canRead: true, canMove: true }),
  alert: async (m) => { alerts.push(m); },
  createSample: async (pool, input) => { samples.push(input); return { token: 'tok' + samples.length }; },
  classifyDeps: { offline: true },
};
const msg = (from, subject, body, extra = {}) => ({ id: 'in_' + Math.random().toString(36).slice(2), from: { emailAddress: { address: from } },
  subject, body: { contentType: 'text', content: body }, receivedDateTime: (extra.at || at(1)).toISOString(), conversationId: extra.conv || null,
  internetMessageHeaders: extra.headers || [] });
const row = async (email) => (await P().query(`SELECT * FROM prospector_outreach WHERE email = $1`, [email])).rows[0];

const ROWS = [
  { email: 'bwelch@acci.test', first: 'Bobby', last: 'Welch', company: 'ACCi', area: 'Birmingham, AL', subject: '3 businesses near you with an email gap',
    body: 'Hi Bobby,\n\nThree near you.\n\nJohnMark Compton\nCompton Group', fu1: 'Hi Bobby,\n\nQuick follow-up.\n\nJohnMark', fu2: 'Hi Bobby,\n\nLast note.\n\nJohnMark' },
  { email: 'amy@hooverit.test', first: 'Amy', company: 'Hoover IT', area: 'Hoover, AL',
    picks: [{ business: 'Family Care Dental', kind: 'dental office', town: 'Hoover', gap: 'no DMARC record' }], checked: 145, withGap: 93 },
  { email: 'sam@marietta-msp.test', first: 'Sam', company: 'Marietta MSP', area: 'Marietta, GA', subject: 'S', body: 'B' },
  { email: 'tom@marietta-msp.test', first: 'Tom', company: 'Marietta MSP', area: 'Marietta, GA', subject: 'S', body: 'B' },
  { email: 'not-an-email', company: 'X' },
  { email: 'gone@bounced.test', company: 'Gone IT', area: 'Mobile, AL', subject: 'S', body: 'B' },
  { email: 'nopicks@nothing.test', company: 'Nothing IT', area: 'Mobile, AL' },
  { email: 'owner@payingco.test', company: 'Paying Co', area: 'Dothan, AL', subject: 'S', body: 'B' },
];

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));
  await O.ensureTables(P());
  await sup.suppress(P(), 'gone@bounced.test', { reason: 'hard bounce' });
  await P().query(`CREATE TABLE IF NOT EXISTS prospector_customers (id SERIAL PRIMARY KEY, email TEXT)`);
  await P().query(`INSERT INTO prospector_customers (email) VALUES ('billing@payingco.test')`);

  OUT.push('-- the first email --');
  const c = O.compose({ first: 'Amy Lee', area: 'Hoover, AL', picks: [{ business: 'A Dental', kind: 'dental office', town: 'Hoover', gap: 'no DMARC record' },
    { business: 'B Law', kind: 'law firm', gap: 'no SPF record' }, { business: 'C Vet' }], checked: 145, withGap: 93 });
  ok('composed from three businesses near them, with the run\'s numbers', c.subject === '3 businesses near you with an email gap'
    && /^Hi Amy,/.test(c.body) && c.body.includes('A Dental (dental office, Hoover): no DMARC record') && c.body.includes('93 of the 145') && c.body.includes('Three near you'), c);
  ok('nothing to write about, nothing composed', O.compose({ first: 'X', picks: [] }) === null);
  ok('follow-ups name the area; the last one says one IT company per area', /Birmingham, AL area are ready/.test(O.followUp({ first_name: 'Bo', area: 'Birmingham, AL' }, 1))
    && /one IT company per area/.test(O.followUp({ first_name: 'Bo', area: 'Birmingham, AL' }, 2)));

  OUT.push('-- import --');
  const imp = await O.importRows(P(), ROWS, { batch: 'b1' });
  const why = Object.fromEntries(imp.skipped.map((s) => [s.email, s.why]));
  ok('three added, as drafts', imp.added === 3 && imp.queued === 0, imp);
  ok('a second person at the same company is skipped', /already on the list/.test(why['tom@marietta-msp.test'] || ''), why);
  ok('a bad address, a suppressed one, one with nothing to say and a paying customer are skipped',
    why['not-an-email'] && why['gone@bounced.test'] && /no subject/.test(why['nopicks@nothing.test'] || '') && why['owner@payingco.test'] === 'already a customer', why);
  ok('importing again adds nothing', (await O.importRows(P(), ROWS.slice(0, 1))).added === 0);
  const amy = await row('amy@hooverit.test');
  ok('a row with businesses but no text is composed', amy && /Family Care Dental/.test(amy.body) && amy.subject === '1 business near you with an email gap', amy && amy.subject);

  OUT.push('-- the gates --');
  ok('off: nothing sent', (await O.sendTick(P(), { now: T0, deps })).skipped === 'PROSPECTOR_OUTREACH_ON is off');
  process.env.PROSPECTOR_OUTREACH_ON = '1';
  ok('no mailing address: nothing sent', /BUSINESS_MAILING_ADDRESS/.test((await O.sendTick(P(), { now: T0, deps })).skipped || ''));
  process.env.BUSINESS_MAILING_ADDRESS = '123 Main St, Birmingham, AL 35203';
  ok('the weekend: nothing sent', (await O.sendTick(P(), { now: new Date('2026-11-07T16:00:00Z'), deps })).skipped === 'weekend');
  ok('before 9 Central: nothing sent', /outside/.test((await O.sendTick(P(), { now: new Date('2026-11-03T14:30:00Z'), deps })).skipped || ''));
  let t = await O.sendTick(P(), { now: T0, deps });
  ok('drafts are never sent without the OK', mail.sent.length === 0 && (t.sent || []).length === 0, t);
  ok('approve needs a selection', await O.approve(P(), {}).then(() => false, (e) => e.status === 400));
  ok('approving the batch queues all three', (await O.approve(P(), { batch: 'b1' })).approved === 3);

  OUT.push('-- sending --');
  t = await O.sendTick(P(), { now: T0, deps });
  ok('one email per mailbox per tick: two sent, from different mailboxes', mail.sent.length === 2 && new Set(mail.sent.map((s) => s.from)).size === 2, t);
  const s0 = mail.sent[0];
  ok('the first email goes out as written, to the right person', s0.to === 'bwelch@acci.test' && s0.subject === '3 businesses near you with an email gap' && s0.text.startsWith('Hi Bobby,'));
  ok('it carries the reason, the unsubscribe link and the mailing address', /You received this because ACCi is an IT company in Birmingham, AL/.test(s0.text)
    && /Unsubscribe: https?:\/\/\S+unsubscribe/.test(s0.text) && s0.text.includes('123 Main St, Birmingham, AL 35203'), s0.text);
  const bo = await row('bwelch@acci.test');
  ok('the prospect is active, pinned to its mailbox, follow-up due on day 3', bo.state === 'active' && bo.step === 1 && bo.mailbox === s0.from
    && Math.round((new Date(bo.next_at) - T0) / 86400000) === 3 && bo.message_id === 'msg_bwelch@acci.test');
  t = await O.sendTick(P(), { now: at(1), deps });
  ok('a minute later: the 4-minute gap holds', mail.sent.length === 2 && /no mailbox free/.test(t.skipped || ''), t);
  t = await O.sendTick(P(), { now: at(5), deps });
  ok('5 minutes later: the third goes out', mail.sent.length === 3 && mail.sent[2].to === 'sam@marietta-msp.test', t);

  OUT.push('-- warm-up --');
  const box = s0.from;
  const today = O.central(T0).date;
  let cap = await O.capFor(P(), box, today);
  ok('day 1: 10 a day', cap.day === 1 && cap.cap === 10, cap);
  for (let i = 0; i < 2; i++) await P().query(`INSERT INTO prospector_outreach_events (kind, step, mailbox, at) VALUES ('sent', 1, $1, $2)`, [box, days(-1 - i)]);
  cap = await O.capFor(P(), box, today);
  ok('after two sending days: 16 a day', cap.day === 3 && cap.cap === 16, cap);
  for (let i = 0; i < 30; i++) await P().query(`INSERT INTO prospector_outreach_events (kind, step, mailbox, at) VALUES ('sent', 1, $1, $2)`, [box, days(-3 - i)]);
  cap = await O.capFor(P(), box, today);
  ok('never past 30 a day', cap.cap === 30, cap);
  await P().query(`DELETE FROM prospector_outreach_events WHERE outreach_id IS NULL AND kind = 'sent'`);
  for (let i = 0; i < 9; i++) await P().query(`INSERT INTO prospector_outreach_events (kind, step, mailbox, at) VALUES ('sent', 1, $1, $2)`, [box, at(-60 + i)]);
  const boxes = await O.mailboxStatus(P(), at(10), deps);
  ok('a mailbox at its cap for today is not free', boxes.find((b) => b.address === box).free === false && boxes.find((b) => b.address !== box).free === true, boxes.map((b) => [b.address, b.sentToday, b.cap, b.free]));
  await P().query(`DELETE FROM prospector_outreach_events WHERE outreach_id IS NULL AND kind = 'sent'`);

  OUT.push('-- follow-ups --');
  mail.sent.length = 0;
  t = await O.sendTick(P(), { now: days(3, 10), deps });
  const fu = mail.sent.filter((s) => s.to === 'bwelch@acci.test')[0];
  ok('day 3: follow-up 1 in the same thread, from the same mailbox, as written', fu && fu.kind === 'reply' && fu.messageId === 'msg_bwelch@acci.test'
    && fu.from === box && fu.text.startsWith('Hi Bobby,\n\nQuick follow-up.') && /Unsubscribe:/.test(fu.text), mail.sent);
  const amyFu = mail.sent.filter((s) => s.to === 'amy@hooverit.test')[0];
  ok('a prospect without its own follow-up gets the standard one', amyFu && /The 10 for the Hoover, AL area are ready/.test(amyFu.text), amyFu);
  mail.sent.length = 0;
  await O.sendTick(P(), { now: days(7, 10), deps });
  await O.sendTick(P(), { now: days(7, 15), deps });
  const last = mail.sent.filter((s) => s.to === 'bwelch@acci.test')[0];
  ok('day 7: the last note', last && last.text.startsWith('Hi Bobby,\n\nLast note.'), mail.sent);
  ok('then the sequence is done', (await row('bwelch@acci.test')).state === 'done' && (await row('bwelch@acci.test')).next_at === null);
  mail.sent.length = 0;
  await O.sendTick(P(), { now: days(10, 10), deps });
  ok('nothing more is ever sent to a finished sequence', !mail.sent.some((s) => s.to === 'bwelch@acci.test'));

  OUT.push('-- replies --');
  await P().query(`DELETE FROM prospector_outreach`);
  await O.importRows(P(), [
    { email: 'yes@one.test', first: 'Yes', company: 'One IT', area: 'Pelham, AL', subject: 'S', body: 'B' },
    { email: 'stop@two.test', first: 'Stop', company: 'Two IT', area: 'Pelham, AL', subject: 'S', body: 'B' },
    { email: 'later@three.test', first: 'Later', company: 'Three IT', area: 'Pelham, AL', subject: 'S', body: 'B' },
    { email: 'ooo@four.test', first: 'Ooo', company: 'Four IT', area: 'Pelham, AL', subject: 'S', body: 'B' },
    { email: 'bad@five.test', first: 'Bad', company: 'Five IT', area: 'Pelham, AL', subject: 'S', body: 'B' },
    { email: 'auto@six.test', first: 'Auto', company: 'Six IT', area: 'Pelham, AL', subject: 'S', body: 'B' },
  ], { approve: true });
  const D = days(14);
  for (let i = 0; i < 4; i++) await O.sendTick(P(), { now: new Date(D.getTime() + i * 5 * 60000), deps });
  const active = (await P().query(`SELECT COUNT(*)::int AS n FROM prospector_outreach WHERE state = 'active'`)).rows[0].n;
  ok('approved on import: all six sent', active === 6, active);
  mail.sent.length = 0; alerts.length = 0;
  mail.setInbox([
    msg('yes@one.test', 'RE: S', 'Sure, send them over.\n\nOn Tue, JohnMark wrote:\n> B'),
    msg('stop@two.test', 'RE: S', 'Please remove me from your list.'),
    msg('later@three.test', 'RE: S', 'Not right now, maybe next quarter.'),
    msg('ooo@four.test', 'Automatic reply: S', 'I am out of the office.', { headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }),
    msg('postmaster@five.test', 'Undeliverable: S', 'Delivery has failed to these recipients: bad@five.test'),
    msg('stranger@nowhere.test', 'Hello', 'Unrelated mail'),
  ]);
  let rep = await O.scanReplies(P(), { now: D, deps: { ...deps, mailOnly: true } });
  const y = await row('yes@one.test');
  ok('"sure, send them over" is interested and the sequence stops', y.state === 'replied' && y.reply_tag === 'interested' && y.next_at === null, y);
  ok('their free sample is built in their area, signed with their company', samples.length === 1 && samples[0].area === 'Pelham, AL' && samples[0].company === 'One IT'
    && samples[0].source === 'outreach' && y.sample_token === 'tok1', samples);
  ok('auto-answer off: nothing sent back, JohnMark gets the link and the words', mail.sent.length === 0 && alerts.some((a) => /One IT is interested/.test(a.subject)
    && a.text.includes('https://mynildash.com/s/tok1') && /PROSPECTOR_AUTOSEND_ON/.test(a.text)), alerts.map((a) => a.subject));
  ok('their own words are kept, not the quoted email', y.reply_text === 'Sure, send them over.', y.reply_text);
  const st2 = await row('stop@two.test');
  ok('"remove me" stops them and puts them on the suppression list', st2.state === 'stopped' && (await sup.isSuppressed(P(), 'stop@two.test')).suppressed);
  const l3 = await row('later@three.test');
  ok('"not right now" stops the sequence and tells JohnMark', l3.state === 'replied' && l3.reply_tag === 'not now' && alerts.some((a) => /not now/.test(a.subject)));
  ok('an out-of-office reply does not stop the sequence', (await row('ooo@four.test')).state === 'active');
  const b5 = await row('bad@five.test');
  ok('a bounce stops the address and suppresses it', b5.state === 'stopped' && b5.stop_reason === 'bounced' && (await sup.isSuppressed(P(), 'bad@five.test')).suppressed);
  ok('mail from strangers is left alone', rep.replies === 3 && rep.bounces === 1, rep);
  const cur = (await O.getState(P())).cursors;
  ok('each mailbox remembers where it read up to', Object.keys(cur).length === 2, cur);

  process.env.PROSPECTOR_AUTOSEND_ON = '1';
  mail.sent.length = 0; alerts.length = 0;
  const yesMsg = msg('auto@six.test', 'RE: S', 'Yes please');
  mail.setInbox([yesMsg]);
  await P().query(`UPDATE prospector_outreach_state SET cursors = '{}'`);
  await O.scanReplies(P(), { now: D, deps });
  const a6 = await row('auto@six.test');
  const back = mail.sent.find((s) => s.to === 'auto@six.test');
  ok('auto-answer on: the link goes back in their thread', back && back.kind === 'reply' && back.messageId === yesMsg.id && back.text.includes('https://mynildash.com/s/tok2')
    && /lock Pelham, AL on that page/.test(back.text) && a6.answered_at, back);
  ok('and JohnMark is told it was handled', alerts.some((a) => /sent back automatically/.test(a.text)));
  mail.sent.length = 0;
  await P().query(`UPDATE prospector_outreach_state SET cursors = '{}'`);
  await O.scanReplies(P(), { now: D, deps });
  ok('a second read of the same reply never answers twice', !mail.sent.some((s) => s.to === 'auto@six.test'));
  delete process.env.PROSPECTOR_AUTOSEND_ON;

  OUT.push('-- protecting the mailboxes --');
  await O.importRows(P(), [{ email: 'next@seven.test', company: 'Seven IT', area: 'Pelham, AL', subject: 'S', body: 'B' },
    { email: 'later@eight.test', company: 'Eight IT', area: 'Pelham, AL', subject: 'S', body: 'B' }], { approve: true });
  await sup.suppress(P(), 'later@eight.test', { reason: 'unsubscribed from a NILDash email', kind: 'unsubscribe' });
  mail.failWith(Object.assign(new Error('Graph 403 ErrorSendAsDenied: SubmissionQuotaExceeded'), { status: 403 }));
  alerts.length = 0;
  const D2 = days(15);
  t = await O.sendTick(P(), { now: D2, deps });
  const lim = await O.getState(P());
  ok('Microsoft limiting a mailbox stops it for the day and tells JohnMark', Object.keys(lim.limited).length === 1 && alerts.some((a) => /limited/.test(a.subject)), t);
  ok('the email it could not send waits in the queue', ['queued'].includes((await row('next@seven.test')).state) || ['queued'].includes((await row('later@eight.test')).state));
  await O.sendTick(P(), { now: new Date(D2.getTime() + 5 * 60000), deps });
  const e8 = await row('later@eight.test');
  ok('an address suppressed after import is never sent to', e8.state === 'stopped' && !mail.sent.some((s) => s.to === 'later@eight.test'), e8);
  const limitedBox = Object.keys(lim.limited)[0];
  const st3 = await O.mailboxStatus(P(), new Date(D2.getTime() + 10 * 60000), deps);
  ok('the limited mailbox stays off today; the other keeps going', st3.find((b) => b.address === limitedBox).free === false);
  const st4 = await O.mailboxStatus(P(), days(16), deps);
  ok('and it is back the next day', st4.find((b) => b.address === limitedBox).limited === false);
  alerts.length = 0;
  mail.setInbox([msg('no-reply@accountprotection.microsoft.com', 'Your account has been restricted from sending', 'We detected unusual sending activity')]);
  await P().query(`UPDATE prospector_outreach_state SET cursors = '{}', limited = '{}'`);
  await O.scanReplies(P(), { now: days(16), deps });
  ok('a Microsoft warning in the inbox stops that mailbox too', Object.keys((await O.getState(P())).limited).length >= 1 && alerts.some((a) => /limited/.test(a.subject)));
  for (let i = 0; i < 20; i++) await P().query(`INSERT INTO prospector_outreach_events (kind, step, mailbox, at) VALUES ('sent', 1, 'john@salesbox.test', $1)`, [days(16)]);
  await P().query(`INSERT INTO prospector_outreach_events (kind, at) VALUES ('bounce', $1)`, [days(16)]);
  alerts.length = 0;
  const bc = await O.bounceCheck(P(), { now: days(16, 60), deps });
  ok('bounces over 2% pause everything and say why', bc.paused && (await O.getState(P())).paused && alerts.some((a) => /too many bounces/.test(a.subject)), bc);
  ok('paused: nothing sent', /^paused/.test((await O.sendTick(P(), { now: days(16, 120), deps })).skipped || ''));
  await O.resume(P());
  ok('resumed', !(await O.getState(P())).paused);

  OUT.push('-- status --');
  const s = await O.status(P(), { now: T0, deps });
  ok('the status counts every state and shows both mailboxes with a connect link', s.on === true && s.counts.replied >= 2 && s.mailboxes.length === 2
    && s.mailboxes.every((m) => m.connectUrl.startsWith('/admin/prospector/connect-mailbox?address=')), s);
  const noAcct = await O.status(P(), { now: T0, deps: { ...deps, account: async (a) => ({ ok: false, address: a, why: a + ' is not connected' }) } });
  ok('a mailbox not connected is named as a problem', noAcct.problems.some((p) => /not connected/.test(p)), noAcct.problems);
  const real = await MB.account(P(), 'jm@salesbox.test');
  ok('the shared mailbox lookup takes another address and points at its own connect link', real.ok === false && real.address === 'jm@salesbox.test'
    && real.why.includes('/admin/prospector/connect-mailbox?address=jm%40salesbox.test'), real);
  ok('without an address it is still the NILDash sales mailbox', (await MB.account(P())).address === MB.fromAddress());

  OUT.push('-- wiring --');
  const IX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  const routes = ["app.get('/admin/prospector/connect-mailbox'", "app.get('/api/lab/prospector/outreach'", "app.post('/api/lab/prospector/outreach/import'",
    "app.post('/api/lab/prospector/outreach/approve'", "app.post('/api/lab/prospector/outreach/remove'", "app.post('/api/lab/prospector/outreach/pause'",
    "app.post('/api/lab/prospector/outreach/resume'", "app.post('/api/lab/prospector/outreach/scan'"];
  ok('every route exists', routes.every((r) => IX.includes(r)), routes.filter((r) => !IX.includes(r)));
  const adm = (r) => { const i = IX.indexOf(r); return IX.slice(i, i + 200).includes('_statusAdminOk(req)'); };
  ok('every route checks admin first', routes.every(adm), routes.filter((r) => !adm(r)));
  ok('the clock starts with the server', IX.includes("require('./services/prospector/outreach').start(store.pool)"));
  const EM = fs.readFileSync(REPO + 'server/routes/email.js', 'utf8');
  ok('the sign-in hint only ever names one of our own mailboxes', /function _salesHint/.test(EM) && /ours\.includes\(h\)/.test(EM));
  const src = fs.readFileSync(REPO + 'server/services/prospector/outreach.js', 'utf8');
  ok('plain text only: no tracking pixel or HTML body', !/<img|contentType: 'HTML'|sendHtml/i.test(src));

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
