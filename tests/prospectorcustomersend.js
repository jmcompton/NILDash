'use strict';
// ── PROSPECTOR: SENDING A CUSTOMER'S LEADS FROM THEIR OWN MAILBOX ───────────
// services/prospector/mailboxes + customerSend, and the delivery hand-off.
// Local test Postgres; Microsoft, the mailbox and the alert are stand-ins.
//
//   - the customer connects their mailbox with their token; tokens are stored
//     encrypted, refreshed when stale, and a refused refresh disconnects it;
//   - a Territory batch is queued for sending; a Starter one is not;
//   - nothing goes out without the mailbox, the mailing address, a live
//     subscription, inside weekday hours, or while off;
//   - every email carries THEIR address and an unsubscribe link;
//   - one at a time per mailbox, 4 minutes apart, under the warm-up cap;
//   - follow-ups on day 3 and day 7 in the thread, in the customer's name;
//   - a reply stops it; "stop" and bounces are suppressed; DFY replies reach
//     JohnMark; too many bounces pause the customer;
//   - the guarantee is checked after 30 days;
//   - the routes are wired.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('prospectorcustsendtest', { schema: true });
require('./helpers/offlineDns').install();
process.env.EMAIL_ENCRYPTION_KEY = 'a'.repeat(64);
delete process.env.PROSPECTOR_CUSTOMER_SEND_ON;
process.env.PROSPECTOR_BASE_URL = 'https://mynildash.com';

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const CS = require(REPO + 'server/services/prospector/customerSend.js');
const MX = require(REPO + 'server/services/prospector/mailboxes.js');
const D = require(REPO + 'server/services/prospector/delivery.js');
const R = require(REPO + 'server/services/prospector/run.js');
const MB = require(REPO + 'server/services/salesMailbox.js');
const sup = require(REPO + 'server/services/suppression.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const P = () => store.pool;
// Tuesday 3 Nov 2026, 10:00 Central.
const T0 = new Date('2026-11-03T16:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60000);
const days = (d, min = 0) => new Date(T0.getTime() + d * 86400000 + min * 60000);

const fakeOutlook = {
  refreshes: 0, failRefresh: null,
  getAuthUrl: (state, opts) => `https://login.microsoftonline.test/authorize?state=${state}&read=${opts.read ? 1 : 0}`,
  exchangeCode: async (code) => ({ accessToken: 'AT-' + code, refreshToken: 'RT-' + code, expiry: new Date(Date.now() + 3600e3),
    email: 'Amy@HooverIT.test', displayName: 'Amy Lee', grantedScopes: ['Mail.Send', 'Mail.Read'], canSend: true, canRead: true }),
  async refreshAccessToken(rt) {
    if (this.failRefresh) { const e = this.failRefresh; throw e; }
    this.refreshes++; return { accessToken: 'AT-new', refreshToken: rt + '-2', expiry: new Date(Date.now() + 3600e3) };
  },
};
function fakeMail() {
  const sent = []; let inbox = [];
  return { sent, setInbox(m) { inbox = m; },
    sendNew: async (mb, { to, subject, text }) => { sent.push({ kind: 'new', from: mb.address, to, subject, text }); return { messageId: 'm_' + to, conversationId: 'c_' + to }; },
    reply: async (mb, { messageId, to, text }) => { sent.push({ kind: 'reply', from: mb.address, messageId, to, text }); return {}; },
    findSent: async () => null, inboxSince: async () => inbox, textOf: MB.textOf, fromOf: MB.fromOf };
}
const mail = fakeMail();
const alerts = [];
const acct = async (id) => ({ ok: true, address: id === 1 ? 'amy@hooverit.test' : 'box' + id + '@it.test', customerId: id, canSend: true, canRead: true });
const deps = { mail, account: acct, alert: async (m) => alerts.push(m) };
const msg = (from, subject, body, extra = {}) => ({ id: 'in_' + Math.random().toString(36).slice(2), from: { emailAddress: { address: from } }, subject,
  body: { contentType: 'text', content: body }, receivedDateTime: (extra.at || at(1)).toISOString(), conversationId: extra.conv || null, internetMessageHeaders: extra.headers || [] });

async function customer(o) {
  return (await P().query(`INSERT INTO prospector_customers (token, email, company, sender_name, area, area_key, plan, period, status, onboarded_at, checkout_session_id, mailing_address)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'monthly',$8,NOW(),$1,$9) RETURNING *`,
  [o.token, o.email, o.company, o.sender, o.area, o.area.toLowerCase().replace(/[^a-z0-9]+/g, '-'), o.plan, o.status || 'active', o.address === undefined ? '9 Oak St, Hoover, AL 35244' : o.address])).rows[0];
}
function fakeRun(n, tag) {
  return async (pool, input) => {
    await R.ensureTables(pool);
    const run = (await pool.query(`INSERT INTO prospector_runs (playbook, area, sender, status) VALUES ('it-msp',$1,$2,'done') RETURNING id`, [input.area, JSON.stringify(input.sender)])).rows[0];
    for (let i = 1; i <= n; i++) {
      const d = `${tag}${i}.test`;
      await pool.query(`INSERT INTO prospector_leads (run_id, business, domain, level, finding, person, verified, email) VALUES ($1,$2,$3,'high',$4,$5,true,$6)`,
        [run.id, 'Biz ' + i, d, JSON.stringify({ problems: ['No DMARC'] }), i === n ? null : JSON.stringify({ first: 'Owner' + i, last: 'X', email: `owner@${d}` }),
          JSON.stringify({ subject: 'Your email at Biz ' + i, body: `Hi Owner${i},\n\nQuick note.\n\n${input.sender.name}` })]);
    }
    return { runId: run.id, summary: {} };
  };
}

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));
  await CS.ensureTables(P());

  OUT.push('-- connecting their mailbox --');
  const amy = await customer({ token: 'tokAmy', email: 'amy@hooverit.test', company: 'Hoover IT', sender: 'Amy Lee', area: 'Hoover, AL', plan: 'territory' });
  const url = MX.connectUrl('tokAmy', { outlook: fakeOutlook });
  const st = JSON.parse(Buffer.from(new URL(url).searchParams.get('state'), 'base64url').toString());
  ok('the sign-in link carries their token, asks to send and read', st.prospector === 'tokAmy' && /read=1/.test(url), st);
  ok('a wrong token cannot connect anything', await MX.onCallback(P(), { prospector: 'nope' }, 'c1', { outlook: fakeOutlook }).then(() => false, (e) => e.status === 404));
  const cb = await MX.onCallback(P(), st, 'c1', { outlook: fakeOutlook });
  ok('connected: their address, able to send', cb.mailbox.address === 'amy@hooverit.test' && cb.mailbox.can_send === true && cb.customer.id === amy.id, cb.mailbox);
  const raw = (await P().query(`SELECT * FROM prospector_mailboxes WHERE customer_id = $1`, [amy.id])).rows[0];
  ok('tokens are stored encrypted, never in the clear', raw.access_token_enc && !raw.access_token_enc.includes('AT-c1') && !raw.refresh_token_enc.includes('RT-c1'));
  ok('what the page sees has no token', !('access_token_enc' in cb.mailbox) && !('refresh_token_enc' in cb.mailbox));
  const a1 = await MX.account(P(), amy.id, { outlook: fakeOutlook });
  ok('a fresh token is used as is', (await a1.getToken()) === 'AT-c1' && fakeOutlook.refreshes === 0);
  await P().query(`UPDATE prospector_mailboxes SET token_expiry = NOW() WHERE customer_id = $1`, [amy.id]);
  ok('a stale one is refreshed and saved', (await a1.getToken()) === 'AT-new' && fakeOutlook.refreshes === 1);
  ok('the shared Graph code uses the customer\'s token', /typeof mb\.getToken === 'function'/.test(fs.readFileSync(REPO + 'server/services/salesMailbox.js', 'utf8')));
  await P().query(`UPDATE prospector_mailboxes SET token_expiry = NOW() WHERE customer_id = $1`, [amy.id]);
  fakeOutlook.failRefresh = Object.assign(new Error('invalid_grant: AADSTS50173'), { status: 400, code: 'invalid_grant' });
  await a1.getToken().catch(() => {});
  ok('a refused refresh marks the mailbox disconnected', (await MX.get(P(), amy.id)).status === 'disconnected');
  fakeOutlook.failRefresh = null;
  await MX.onCallback(P(), st, 'c2', { outlook: fakeOutlook });
  ok('connecting again brings it back', (await MX.get(P(), amy.id)).status === 'active');

  OUT.push('-- a batch is queued --');
  const r1 = await D.deliver(P(), amy, { now: T0, deps: { run: fakeRun(5, 'hoover'), alert: async () => {}, sendCustomer: async () => {} } });
  ok('a Territory batch queues every lead with a person to write to', r1.queued === 4 && r1.delivered === 5, r1);
  const sam = await customer({ token: 'tokSam', email: 'sam@s.test', company: 'Sam IT', sender: 'Sam', area: 'Pelham, AL', plan: 'starter' });
  const r2 = await D.deliver(P(), sam, { now: T0, deps: { run: fakeRun(3, 'pelham'), alert: async () => {}, sendCustomer: async () => {} } });
  ok('a Starter batch is not sent for them', !r2.queued && (await P().query(`SELECT COUNT(*)::int AS n FROM prospector_sends WHERE customer_id = $1`, [sam.id])).rows[0].n === 0, r2);
  await sup.suppress(P(), 'owner@gone1.test', { reason: 'bounced before' });
  const zed = await customer({ token: 'tokZed', email: 'z@z.test', company: 'Zed IT', sender: 'Zed Cole', area: 'Trussville, AL', plan: 'dfy', address: null });
  const r3 = await D.deliver(P(), zed, { now: T0, deps: { run: fakeRun(3, 'gone'), alert: async () => {}, sendCustomer: async () => {} } });
  ok('a suppressed address is never queued', r3.queued === 1, r3);

  OUT.push('-- the gates --');
  ok('off: nothing sent', (await CS.sendTick(P(), { now: T0, deps })).skipped === 'PROSPECTOR_CUSTOMER_SEND_ON is off');
  process.env.PROSPECTOR_CUSTOMER_SEND_ON = '1';
  ok('the weekend: nothing sent', (await CS.sendTick(P(), { now: new Date('2026-11-08T16:00:00Z'), deps })).skipped === 'weekend');
  ok('after 16:00 Central: nothing sent', /outside/.test((await CS.sendTick(P(), { now: new Date('2026-11-03T22:30:00Z'), deps })).skipped || ''));
  await MX.onCallback(P(), { prospector: 'tokZed' }, 'z1', { outlook: fakeOutlook });
  let t = await CS.sendTick(P(), { now: T0, deps });
  const zedSkip = (t.sent || []).find((x) => x.customer === zed.id);
  ok('no mailing address: nothing sent for that customer, and it says why', zedSkip && /mailing address/.test(zedSkip.skipped), t);
  ok('blocked without a mailbox, a live plan or send permission', /Connect your mailbox/.test(CS.blocker({ ...amy, mailing_address: 'x 1' }, null))
    && /past_due/.test(CS.blocker({ ...amy, status: 'past_due' }, { ok: true, canSend: true })) && /permission to send/.test(CS.blocker(amy, { ok: true, canSend: false })));

  OUT.push('-- sending --');
  const amySent = () => mail.sent.filter((s) => s.from === 'amy@hooverit.test');
  ok('one email for Amy this tick', amySent().length === 1, mail.sent);
  const first = amySent()[0];
  ok('from their mailbox, to the business owner, as written', first.to === 'owner@hoover1.test' && first.subject === 'Your email at Biz 1' && first.text.startsWith('Hi Owner1,'));
  ok('with THEIR mailing address and an unsubscribe link', first.text.includes('9 Oak St, Hoover, AL 35244') && /Unsubscribe: \S+/.test(first.text)
    && /because Hoover IT works with businesses in Hoover, AL/.test(first.text), first.text);
  await CS.sendTick(P(), { now: at(2), deps });
  ok('4 minutes apart', amySent().length === 1);
  await CS.sendTick(P(), { now: at(5), deps });
  await CS.sendTick(P(), { now: at(10), deps });
  await CS.sendTick(P(), { now: at(15), deps });
  ok('then the rest, one at a time', amySent().length === 4 && new Set(amySent().map((s) => s.to)).size === 4);
  let cap = await CS.capFor(P(), amy, '2026-11-03');
  ok('warm-up: 10 on the first day', cap.cap === 10 && cap.sentToday === 4, cap);
  for (let i = 0; i < 30; i++) await P().query(`INSERT INTO prospector_send_events (customer_id, kind, step, at) VALUES ($1,'sent',1,$2)`, [amy.id, days(-1 - i)]);
  cap = await CS.capFor(P(), amy, '2026-11-03');
  ok('never past 30 a day for Territory', cap.cap === 30, cap);
  ok('Done For You may go to 50', CS.CAPS.dfy === 50);
  await P().query(`DELETE FROM prospector_send_events WHERE send_id IS NULL AND kind = 'sent'`);

  OUT.push('-- follow-ups --');
  mail.sent.length = 0;
  for (let i = 0; i < 4; i++) await CS.sendTick(P(), { now: days(3, 30 + i * 5), deps });
  const fu = amySent().find((s) => s.to === 'owner@hoover1.test');
  ok('day 3: a follow-up in the thread, signed by Amy, with the footer', fu && fu.kind === 'reply' && fu.messageId === 'm_owner@hoover1.test'
    && /Following up on my note about Biz 1/.test(fu.text) && /\n\nAmy\n/.test(fu.text) && fu.text.includes('9 Oak St'), fu);
  mail.sent.length = 0;
  for (let i = 0; i < 4; i++) await CS.sendTick(P(), { now: days(7, 30 + i * 5), deps });
  ok('day 7: the last note, then done', amySent().length === 4 && /Last note from me/.test(amySent()[0].text)
    && (await P().query(`SELECT COUNT(*)::int AS n FROM prospector_sends WHERE customer_id = $1 AND state = 'done'`, [amy.id])).rows[0].n === 4);

  OUT.push('-- replies --');
  await P().query(`UPDATE prospector_sends SET state = 'active', step = 1, next_at = $2 WHERE customer_id = $1`, [amy.id, days(20)]);
  mail.setInbox([
    msg('owner@hoover1.test', 'RE: Your email at Biz 1', 'Sure, can you call me Tuesday?'),
    msg('owner@hoover2.test', 'RE: Your email at Biz 2', 'Please stop emailing me.'),
    msg('postmaster@hoover3.test', 'Undeliverable: Your email at Biz 3', 'Delivery has failed to these recipients: owner@hoover3.test'),
    msg('owner@hoover4.test', 'Automatic reply: away', 'Out of office', { headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }),
  ]);
  alerts.length = 0;
  const rep = await CS.scanReplies(P(), { now: days(8), deps });
  const row = async (e) => (await P().query(`SELECT * FROM prospector_sends WHERE email = $1`, [e])).rows[0];
  ok('a reply stops that business\'s emails', (await row('owner@hoover1.test')).state === 'replied' && (await row('owner@hoover1.test')).next_at === null, rep);
  ok('"stop" is suppressed for good', (await row('owner@hoover2.test')).reply_tag === 'unsubscribe' && (await sup.isSuppressed(P(), 'owner@hoover2.test')).suppressed);
  ok('a bounce stops and suppresses the address', (await row('owner@hoover3.test')).state === 'stopped' && (await sup.isSuppressed(P(), 'owner@hoover3.test')).suppressed);
  ok('an out-of-office does not stop anything', (await row('owner@hoover4.test')).state === 'active');
  ok('Territory replies are theirs: JohnMark is not emailed', !alerts.some((a) => /DFY reply/.test(a.subject)));
  mail.setInbox([msg('owner@gone2.test', 'RE: hi', 'Yes, interested')]);
  await P().query(`UPDATE prospector_sends SET step = 1, state = 'active' WHERE customer_id = $1`, [zed.id]);
  await CS.scanReplies(P(), { now: days(8), deps });
  ok('a Done For You reply goes to JohnMark to answer', alerts.some((a) => /DFY reply for Zed IT/.test(a.subject) && /Yes, interested/.test(a.text)), alerts.map((a) => a.subject));

  OUT.push('-- protection --');
  for (let i = 0; i < 20; i++) await P().query(`INSERT INTO prospector_send_events (customer_id, kind, step, at) VALUES ($1,'sent',1,$2)`, [amy.id, days(8)]);
  for (let i = 0; i < 2; i++) await P().query(`INSERT INTO prospector_send_events (customer_id, kind, at) VALUES ($1,'bounce',$2)`, [amy.id, days(8)]);
  alerts.length = 0;
  const bc = await CS.bounceCheck(P(), amy, { now: days(8, 60), deps });
  ok('bounces over 5% pause that customer and say why', bc.paused && alerts.some((a) => /sending paused for Hoover IT/.test(a.subject)), bc);
  ok('paused: their page says so', /Paused/.test(CS.blocker((await P().query(`SELECT * FROM prospector_customers WHERE id = $1`, [amy.id])).rows[0], { ok: true, canSend: true })));

  OUT.push('-- the guarantee --');
  alerts.length = 0;
  let g = await CS.guaranteeCheck(P(), { now: days(20), deps });
  ok('not checked before 30 days of sending', g.length === 0, g);
  g = await CS.guaranteeCheck(P(), { now: days(45), deps });
  const ga = g.find((x) => x.customer === amy.id), gz = g.find((x) => x.customer === zed.id);
  ok('one human reply in 30 days: missed, and JohnMark is told to credit', ga && ga.replies === 1 && !ga.met && alerts.some((a) => /guarantee missed: Hoover IT/.test(a.subject)), g);
  ok('a "stop" does not count as a reply', ga.replies === 1);
  ok('checked once only; a customer that never sent is not judged', (await CS.guaranteeCheck(P(), { now: days(46), deps })).length === 0 && !gz);

  OUT.push('-- their page --');
  const v = await D.portal(P(), 'tokAmy');
  ok('the page shows their mailbox and the counts', v.sending && v.sending.mailbox.address === 'amy@hooverit.test' && v.sending.emailsSent >= 12 && v.sending.replied === 2, v.sending);
  const vz = await D.portal(P(), 'tokZed');
  ok('and asks for the address when it is missing', vz.sending.hasAddress === false && /mailing address/.test(vz.sending.blocker), vz.sending);
  ok('a Starter page has no sending card', (await D.portal(P(), 'tokSam')).sending === null);

  OUT.push('-- wiring --');
  const IX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  const routes = ["app.get('/api/prospector/portal/:token/connect'", "app.post('/api/prospector/portal/:token/address'", "app.post('/api/prospector/portal/:token/disconnect'"];
  ok('the page routes exist', routes.every((x) => IX.includes(x)), routes.filter((x) => !IX.includes(x)));
  ok('the address and disconnect routes are rate limited', /portal\/:token\/address', _prospectorPublicLimiter/.test(IX) && /portal\/:token\/disconnect', _prospectorPublicLimiter/.test(IX));
  ok('the clock starts with the server', IX.includes("require('./services/prospector/customerSend').start(store.pool)"));
  const EM = fs.readFileSync(REPO + 'server/routes/email.js', 'utf8');
  const cbi = EM.indexOf("if (st.prospector) {"), uid = EM.indexOf("const { userId } = st;");
  ok('the Microsoft callback hands a Prospector connection over before the NILDash login check', cbi > 0 && uid > 0 && cbi < uid);
  ok('a cancelled sign-in goes back to their page', /if \(st\.prospector\) return res\.redirect\('\/p\/'/.test(EM));
  const W = fs.readFileSync(REPO + 'server/views/prospector-welcome.html', 'utf8');
  ok('onboarding asks a sending plan for the mailing address and links their page', /mailingAddress/.test(W) && /c\.sends/.test(W) && /Open your leads page/.test(W));

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
