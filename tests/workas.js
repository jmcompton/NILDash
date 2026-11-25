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
  r = await call('Z', 'POST', '/api/admin/work-as', { agentId: 'ag1' });
  ok('an agent cannot open another agent\'s account', r.code === 403 && sessions.Z.userId === 'ag2' && !sessions.Z.adminId, [r, sessions.Z.userId]);
  r = await call('X', 'POST', '/api/admin/work-as', { agentId: 'ag1' });
  ok('nobody signed in cannot either', r.code === 403 && !sessions.X.userId, r);
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
  r = await call('A', 'POST', '/api/admin/work-as', { agentId: 'ag2' });
  who = (await call('A', 'GET', '/api/whoami')).body;
  ok('  switching straight to another client works', r.code === 200 && who.userId === 'ag2' && who.adminId === 'adm', who);
  r = await call('A', 'POST', '/api/admin/work-as/stop');
  who = (await call('A', 'GET', '/api/whoami')).body;
  ok('going back: his own account again, nothing left behind', r.code === 200 && who.userId === 'adm' && who.adminId === null && who.role === 'admin', who);
  r = await call('A', 'POST', '/api/auth/change-password', { password: 'new' });
  ok('  and his own password is his again', r.code === 200 && r.body.changed === true, r);
  r = await call('Z', 'POST', '/api/admin/work-as/stop');
  ok('an agent calling "go back" changes nothing', r.code === 200 && sessions.Z.userId === 'ag2', sessions.Z.userId);
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
