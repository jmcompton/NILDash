'use strict';
// ── CLIENT ACCOUNTS: THE FOUNDER WORKS INSIDE AN AGENT'S ACCOUNT ────────────
//
//   node tests/workas.js
//
// services/workAs and its routes: only the admin account can open a client,
// only an agent's account can be opened, the session then works that agent's
// account, the agent's password, billing, team and mailbox connection stay
// theirs, going back restores the admin's own account, and every open and
// close is logged. The routes are run for real: the block is cut out of
// server/index.js and mounted on a small app with a session.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('workastest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const http = require('http');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 700) : '')); } };

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const store = require(REPO + 'server/store');
  const P = store.pool;
  const WA = require(REPO + 'server/services/workAs');
  const ADMIN_EMAIL = 'founder@nildash.test';

  const u = (id, email, name, role, extra) => P.query(
    `INSERT INTO users (id, email, name, password, role, archived) VALUES ($1,$2,$3,'x',$4,$5)`, [id, email, name, role, !!(extra && extra.archived)]);
  await u('adm', ADMIN_EMAIL, 'the founder', 'admin');
  await u('ag1', 'dana@riverbendsports.com', 'dana whitfield', 'agent');
  await u('ag2', 'lee@otheragency.com', 'Lee Park', 'agent');
  await u('ag3', 'gone@old.com', 'Gone Agent', 'agent', { archived: true });
  await u('ath1', 'kid@school.edu', 'An Athlete', 'athlete');
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('a1','ag1',$1), ('a2','ag1',$1)`, [JSON.stringify({ name: 'X', school: 'Auburn University' })]);
  const ES = require(REPO + 'server/services/emailStore');
  await ES.saveEmailAccount('ea1', 'ag1', 'imap', 'dana@riverbendsports.com', 'd', 'pw', '{"smtpHost":"smtppro.zoho.com","smtpPort":465}', null, ['smtp.send'], true);

  console.log('-- who can be opened --');
  const admin = await store.getUser('adm');
  ok('an agent account opens', (await WA.open(P, admin, 'ag1')).ok === true);
  ok('not an athlete, not an archived agent, not a missing id, not his own', (await WA.open(P, admin, 'ath1')).ok === false
    && (await WA.open(P, admin, 'ag3')).ok === false && (await WA.open(P, admin, 'nope')).status === 404 && (await WA.open(P, admin, 'adm')).ok === false);
  ok('no admin, no opening', (await WA.open(P, null, 'ag1')).ok === false);
  await WA.open(P, admin, 'ag2');
  let log = (await P.query(`SELECT agent_id, ended_at FROM work_as_log WHERE admin_id = 'adm' ORDER BY id`)).rows;
  ok('every open is logged, and opening another closes the one before', log.length === 2 && log[0].agent_id === 'ag1' && log[0].ended_at !== null && log[1].agent_id === 'ag2' && log[1].ended_at === null, log);
  await WA.close(P, 'adm');
  log = (await P.query(`SELECT ended_at FROM work_as_log WHERE admin_id = 'adm' AND ended_at IS NULL`)).rows;
  ok('going back closes the log line', log.length === 0);

  console.log('-- the list he picks from --');
  const list = await WA.clients(P);
  const d = list.find((c) => c.id === 'ag1');
  ok('agents only: no admin, athlete or archived account', list.length === 2 && !list.some((c) => ['adm', 'ath1', 'ag3'].includes(c.id)), list.map((c) => c.id));
  ok('each shows the mailbox it sends from, athletes, and what is waiting', d && d.mailbox === 'dana@riverbendsports.com' && d.athletes === 2 && d.waiting === 0 && d.sent === 0, d);
  ok('a name typed in lowercase is shown properly', d && d.name === 'Dana Whitfield', d && d.name);
  ok('an agent with no mailbox says so', list.find((c) => c.id === 'ag2').mailbox === null);

  console.log('-- done-for-you clients, and telling the founder when one gets a reply --');
  const MC = require(REPO + 'server/services/managedClients');
  ok('an agent can be marked done-for-you; an athlete or a missing id cannot', (await MC.set(P, 'ag2', true)).managed === true && (await MC.set(P, 'ath1', true)).ok === false && (await MC.set(P, 'nope', true)).status === 404);
  let l2 = await WA.clients(P);
  ok('  and is listed first, marked', l2[0].id === 'ag2' && l2[0].managed === true && l2.find((c) => c.id === 'ag1').managed === false, l2.map((c) => [c.id, c.managed]));
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, sent_at, replied_at, reply_text, reply_from)
    VALUES ('ol-m', 'ag2', 'a1', 'Taco Shop', 'replied', NOW(), NOW(), $1, 'owner@tacoshop.com'),
           ('ol-u', 'ag1', 'a1', 'Bagel Place', 'replied', NOW(), NOW(), 'Sure, call me.', 'x@bagel.com')`,
    ['Hi, we would love to talk about this. Can you call Tuesday?\n\nOn Mon, Nov 23, 2026 at 9:00 AM Lee wrote:\n> Hello from the pitch\n> more of the pitch']);
  const sentTo = [];
  const deps = { adminEmail: ADMIN_EMAIL, send: async (to, msg) => { sentTo.push({ to, msg }); } };
  let o = await MC.onReply(P, 'ol-m', deps);
  ok('a reply to a done-for-you client emails the admin', o.alerted === true && sentTo.length === 1 && sentTo[0].to === ADMIN_EMAIL, o);
  const m0 = sentTo[0] && sentTo[0].msg;
  ok('  it says whose client, which business and which athlete', m0 && /Reply for Lee Park: Taco Shop about X/.test(m0.subject), m0 && m0.subject);
  ok('  it carries what the business said, without the quoted pitch under it', m0 && /Can you call Tuesday\?/.test(m0.text) && !/Hello from the pitch/.test(m0.text), m0 && m0.text);
  ok('  it has a text to paste to the agent, in the first person', m0 && /^Hey Lee! Taco Shop just replied to the email we sent for X\./.test(m0.paste) && /You take it from here/.test(m0.paste) && /Answer them at owner@tacoshop\.com from your own email/.test(m0.paste), m0 && m0.paste);
  ok('  it says the agent answers the business, not the founder', m0 && /Lee answers the business from here/.test(m0.text));
  o = await MC.onReply(P, 'ol-m', deps);
  ok('the same reply seen again does not email twice', o.skipped === 'already alerted' && sentTo.length === 1, o);
  o = await MC.onReply(P, 'ol-u', deps);
  ok('a reply to an agent who is not done-for-you does not email the admin', o.skipped === 'not a done-for-you client' && sentTo.length === 1, o);
  await P.query(`UPDATE outreach_logs SET founder_alerted_at = NULL WHERE id = 'ol-m'`);
  o = await MC.onReply(P, 'ol-m', { adminEmail: ADMIN_EMAIL, send: async () => { throw new Error('mail down'); } });
  const again = (await P.query(`SELECT founder_alerted_at FROM outreach_logs WHERE id = 'ol-m'`)).rows[0].founder_alerted_at;
  ok('an alert that could not be sent is tried again next time, and never throws', /send failed/.test(o.skipped || '') && again === null, [o, again]);
  ok('a pitch that does not exist is skipped quietly', (await MC.onReply(P, 'nope', deps)).skipped === 'no such pitch');
  ok('every reply passes through it', /require\('\.\/managedClients'\)\.onReply\(pool, outreachLogId\)/.test(fs.readFileSync(REPO + 'server/services/followUpAutomation.js', 'utf8')));
  l2 = await WA.clients(P);
  ok('the list shows how many replies each client has', l2.find((c) => c.id === 'ag2').replies === 1 && l2.find((c) => c.id === 'ag1').replies === 1);
  await require(REPO + 'server/services/mailboxNotice').ensureTable(P);
  await P.query(`INSERT INTO mailbox_notices (account_id, user_id, email_address, provider, reason) SELECT id, user_id, email_address, provider, 'refused' FROM email_accounts WHERE user_id = 'ag1'`);
  const broke = (await WA.clients(P)).find((c) => c.id === 'ag1');
  ok('a mailbox the provider is refusing is shown as disconnected, not as sending', broke.mailbox === null && broke.mailboxBroken === 'dana@riverbendsports.com', broke);
  await P.query(`DELETE FROM mailbox_notices`);
  ok('stopping done-for-you stops it', (await MC.set(P, 'ag2', false)).managed === false && (await MC.onReply(P, 'ol-m', deps)).skipped === 'not a done-for-you client');

  console.log('-- what stays with the agent --');
  ok('their password, billing, team and mailbox connection', WA.blocked('POST', '/api/auth/change-password') && WA.blocked('POST', '/api/agent/create-checkout')
    && WA.blocked('POST', '/api/team/invite') && WA.blocked('POST', '/api/email/connect/imap') && WA.blocked('GET', '/api/email/oauth/gmail') && WA.blocked('DELETE', '/api/email/accounts/ea1'));
  ok('the work he is there for is not blocked', !WA.blocked('POST', '/api/athletes') && !WA.blocked('POST', '/api/agent/closer/approve') && !WA.blocked('POST', '/api/agent/settings/script') && !WA.blocked('GET', '/api/agent/home'));

  console.log('-- the routes, run for real --');
  const SRC = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  const a = SRC.indexOf('// ── CLIENT ACCOUNTS (services/workAs)');
  const b = SRC.indexOf("\n});\n", SRC.indexOf("app.post('/api/admin/work-as/stop'", a)) + 5;
  ok('the block is present, after the session and before the routes it guards', a > SRC.indexOf('app.use(session({') && a < SRC.indexOf("app.post('/api/auth/change-password'") && b > a);
  const express = require('express');
  const app = express(); app.use(express.json());
  const sessions = {};
  app.use((rq, _rs, next) => { const k = rq.headers['x-sess'] || 'none'; rq.session = sessions[k] || (sessions[k] = { save(cb) { cb(); } }); next(); });
  // The real gate that sits in front of every /api/admin route in the app. The
  // first live open got stuck behind it: the session user was the agent, so
  // the gate refused the way back.
  { const AG = require(REPO + 'server/middleware/adminGate');
    app.use(AG.PREFIXES, AG.makeAdminGate({ getUser: (id) => store.getUser(id), adminEmail: ADMIN_EMAIL, isFounderEmail: () => false })); }
  app.get('/api/admin/users', (rq, rs) => rs.json({ users: true }));
  { const require_ = require; // the cut block requires './services/workAs' relative to server/
    // eslint-disable-next-line no-eval
    (function (require) { eval(SRC.slice(a, b)); })((m) => require_(m.startsWith('./') ? REPO + 'server/' + m.slice(2) : m)); }
  app.post('/api/auth/change-password', (rq, rs) => rs.json({ changed: true }));
  app.post('/api/agent/closer/approve', (rq, rs) => rs.json({ approvedIn: rq.session.userId }));
  app.get('/api/whoami', (rq, rs) => rs.json({ userId: rq.session.userId || null, adminId: rq.session.adminId || null, role: rq.session.role || null }));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const call = (sess, method, path, body) => new Promise((res, rej) => {
    const rq = http.request({ host: '127.0.0.1', port: srv.address().port, path, method, headers: { 'Content-Type': 'application/json', 'x-sess': sess } }, (r) => {
      let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => { let j = null; try { j = JSON.parse(t); } catch (_) {} res({ code: r.statusCode, body: j }); });
    });
    rq.on('error', rej); if (body) rq.write(JSON.stringify(body)); rq.end();
  });
  sessions.A = { userId: 'adm', role: 'admin', save(cb) { cb(); } };
  sessions.Z = { userId: 'ag2', role: 'agent', save(cb) { cb(); } };
  sessions.X = { save(cb) { cb(); } };

  let r = await call('Z', 'GET', '/api/admin/clients');
  ok('an agent cannot see the client list', r.code === 403, r);
  sessions.Y = { userId: 'ag2', role: 'agent', adminId: 'ag2', save(cb) { cb(); } };
  r = await call('Y', 'GET', '/api/admin/clients');
  ok('  nor can a session that claims an admin id that is not the admin', r.code === 403, r);
  r = await call('Z', 'POST', '/api/admin/work-as', { agentId: 'ag1' });
  ok('an agent cannot open another agent\'s account', r.code === 403 && sessions.Z.userId === 'ag2' && !sessions.Z.adminId, [r, sessions.Z.userId]);
  r = await call('X', 'POST', '/api/admin/work-as', { agentId: 'ag1' });
  ok('nobody signed in cannot either', (r.code === 401 || r.code === 403) && !sessions.X.userId, r);
  r = await call('A', 'GET', '/api/admin/clients');
  ok('the admin sees the list, and is in nobody\'s account yet', r.code === 200 && r.body.clients.length === 2 && r.body.workingAs === null, r.body);
  r = await call('A', 'POST', '/api/admin/work-as', { agentId: 'ath1' });
  ok('the admin cannot open an athlete\'s account', r.code === 400 && sessions.A.userId === 'adm', r);
  r = await call('A', 'POST', '/api/admin/work-as', { agentId: 'ag1' });
  let who = (await call('A', 'GET', '/api/whoami')).body;
  ok('opening a client: the session works the agent\'s account and remembers the admin', r.code === 200 && who.userId === 'ag1' && who.adminId === 'adm' && who.role === 'agent', who);
  r = await call('A', 'POST', '/api/agent/closer/approve', {});
  ok('  what he approves is approved in the agent\'s account', r.code === 200 && r.body.approvedIn === 'ag1', r);
  r = await call('A', 'POST', '/api/auth/change-password', { password: 'new' });
  ok('  the agent\'s password cannot be changed from there', r.code === 403 && r.body.workingAs === true, r);
  r = await call('A', 'GET', '/api/admin/clients');
  ok('  the list still loads, and says whose account he is in', r.code === 200 && r.body.workingAs && r.body.workingAs.id === 'ag1' && r.body.workingAs.mailbox === 'dana@riverbendsports.com', r.body && r.body.workingAs);
  r = await call('A', 'GET', '/api/admin/users');
  ok('  every other admin route is closed while he is in a client\'s account', r.code === 403, r);
  r = await call('A', 'POST', '/api/admin/clients/managed', { agentId: 'ag1', on: true });
  ok('  he can mark a client done-for-you from inside an account too', r.code === 200 && r.body.managed === true, r);
  r = await call('Z', 'POST', '/api/admin/clients/managed', { agentId: 'ag2', on: true });
  ok('  an agent cannot', r.code === 403, r);
  r = await call('A', 'POST', '/api/admin/work-as', { agentId: 'ag2' });
  who = (await call('A', 'GET', '/api/whoami')).body;
  ok('  switching straight to another client works', r.code === 200 && who.userId === 'ag2' && who.adminId === 'adm', who);
  r = await call('A', 'POST', '/api/admin/work-as/stop');
  who = (await call('A', 'GET', '/api/whoami')).body;
  ok('going back: his own account again, nothing left behind', r.code === 200 && who.userId === 'adm' && who.adminId === null && who.role === 'admin', who);
  r = await call('A', 'POST', '/api/auth/change-password', { password: 'new' });
  ok('  and his own password is his again', r.code === 200 && r.body.changed === true, r);
  r = await call('Z', 'POST', '/api/admin/work-as/stop');
  ok('an agent calling "go back" is refused and changes nothing', r.code === 403 && sessions.Z.userId === 'ag2' && !sessions.Z.adminId, [r.code, sessions.Z.userId]);
  const open = (await P.query(`SELECT COUNT(*)::int n FROM work_as_log WHERE ended_at IS NULL`)).rows[0].n;
  const all = (await P.query(`SELECT COUNT(*)::int n FROM work_as_log`)).rows[0].n;
  ok('the log has every open, all closed', open === 0 && all === 4, { open, all });
  srv.close();

  console.log('-- on the page --');
  const UI = fs.readFileSync(REPO + 'public/work-as.js', 'utf8'), IX = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('the page loads it', /<script src="\/work-as\.js"><\/script>/.test(IX));
  ok('nothing is drawn for anyone the server refuses', /return r\.ok \? r\.json\(\) : null/.test(UI) && /if \(!d\) return;/.test(UI));
  ok('names and emails are written as text, never as HTML', !/innerHTML/.test(UI));
  ok('the bar says whose account and which mailbox, with a way back', /You are working in /.test(UI) && /Emails you approve send from /.test(UI) && /Back to my account/.test(UI));

  console.log(`\n${N - F}/${N} passed`);
  await P.end().catch(() => {});
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
