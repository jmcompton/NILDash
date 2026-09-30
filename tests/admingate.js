'use strict';
// Runs against the local test Postgres and a real server on a free port.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/admingate.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── EVERY ROUTE UNDER /admin AND /api/admin REFUSES ANYONE BUT THE ADMIN ───
// /admin/state-rules answered GET, POST and DELETE to the open internet: the
// compliance rules that keep alcohol and gambling away from minors. This walks
// EVERY admin route in server/index.js (read from the source, so a new one is
// covered the day it is added) against a real server, three ways: no session,
// a signed-in agent, and an account with role='admin' that is not the admin.
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const store = require(REPO + 'server/store.js');
const AG = require(REPO + 'server/middleware/adminGate.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const IDX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
const PASS = 'gate-test-pass-1';
const U = { admin: 'ag-admin', agent: 'ag-agent', roleadmin: 'ag-roleadmin' };
const ADMIN_EMAIL = 'ag-admin@gate.test';

async function freePort() {
  return new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
}

// Every admin route in the source, with its method and a concrete path.
function adminRoutes() {
  const out = [];
  for (const m of IDX.matchAll(/app\.(get|post|put|patch|delete)\(\s*'((?:\/api)?\/admin(?:\/[^']*)?)'/g)) {
    const path = m[2].replace(/:email/g, 'nobody%40gate.test').replace(/:[a-zA-Z_]+/g, '0');
    out.push({ method: m[1].toUpperCase(), path, src: m[2] });
  }
  return out;
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  // ── 1. THE GATE ITSELF ────────────────────────────────────────────────────
  OUT.push('-- the gate --');
  const gate = AG.makeAdminGate({ getUser: async (id) => ({ a: { email: 'Boss@X.test' }, f: { email: 'f@x.test' }, r: { email: 'r@x.test', role: 'admin' } }[id] || null),
    adminEmail: 'boss@x.test', isFounderEmail: (e) => e === 'f@x.test' });
  const through = async (session, url) => {
    let status = null, nexted = false;
    const res = { status(s) { status = s; return this; }, json() { return this; }, type() { return this; }, send() { return this; } };
    await gate({ session, originalUrl: url }, res, () => { nexted = true; });
    return nexted ? 'next' : status;
  };
  ok('no session: 401', await through({}, '/admin/state-rules') === 401 && await through(null, '/api/admin/users') === 401);
  ok('the admin (any case) passes', await through({ userId: 'a' }, '/admin/state-rules') === 'next');
  ok('  a founder passes', await through({ userId: 'f' }, '/api/admin/users') === 'next');
  ok('role=admin alone does NOT pass', await through({ userId: 'r' }, '/admin/state-rules') === 403);
  ok('an unknown user id is 403', await through({ userId: 'zz' }, '/admin/state-rules') === 403);
  const boom = AG.makeAdminGate({ getUser: async () => { throw new Error('db down'); }, adminEmail: 'boss@x.test', isFounderEmail: () => false });
  let st = null, nx = false;
  await boom({ session: { userId: 'a' }, originalUrl: '/admin/x' }, { status(s) { st = s; return this; }, type() { return this; }, send() { return this; }, json() { return this; } }, () => { nx = true; });
  ok('a failed user lookup fails CLOSED (503), never open', st === 503 && !nx, st);

  // ── 2. WHERE IT IS MOUNTED ────────────────────────────────────────────────
  OUT.push('', '-- mounted once, before every admin route --');
  const gateAt = IDX.indexOf('app.use(AG.PREFIXES, AG.makeAdminGate(');
  const sessionAt = IDX.indexOf('app.use(session({');
  const routes = adminRoutes();
  const firstRoute = Math.min(...[...IDX.matchAll(/app\.(get|post|put|patch|delete|use)\(\s*'(?:\/api)?\/admin/g)].map((m) => m.index));
  ok('the gate is mounted after the session', gateAt > sessionAt && sessionAt > 0, { gateAt, sessionAt });
  ok('  and before the first admin route', gateAt > 0 && gateAt < firstRoute, { gateAt, firstRoute });
  ok('  on both prefixes', JSON.stringify(AG.PREFIXES) === JSON.stringify(['/admin', '/api/admin']));
  ok(`the sweep found every admin route (${routes.length})`, routes.length >= 74, routes.length);
  const staticAt = IDX.indexOf('app.use(express.static(');
  const redirAt = IDX.indexOf("require('./middleware/adminGate').STATIC_PAGES[req.path]");
  ok('the admin pages in public/ are redirected before express.static serves them', redirAt > 0 && redirAt < staticAt);
  ok('  both of them', AG.STATIC_PAGES['/admin.html'] === '/admin' && AG.STATIC_PAGES['/admin-connections.html'] === '/admin/connections'
    && fs.readdirSync(REPO + 'public').filter((f) => /^admin.*\.html$/.test(f)).every((f) => AG.STATIC_PAGES['/' + f]));

  // ── 3. THE REAL SERVER ────────────────────────────────────────────────────
  OUT.push('', '-- the real server, every admin route --');
  const hash = await bcrypt.hash(PASS, 8);
  await P.query(`DELETE FROM users WHERE id = ANY($1) OR email LIKE '%@gate.test'`, [Object.values(U)]).catch(() => {});
  const mk = (id, role) => P.query(`INSERT INTO users (id, name, email, password, role, plan_tier) VALUES ($1, $1, $2, $3, $4, 'unlimited')`,
    [id, id + '@gate.test', hash, role]);
  await mk(U.admin, 'agent');
  await mk(U.agent, 'agent');
  await mk(U.roleadmin, 'admin');

  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'gate-test', ADMIN_EMAIL, FOUNDER_EMAILS: '',
      RESEND_API_KEY: process.env.RESEND_API_KEY || 're_test_dummy', DATABASE_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let srvErr = ''; srv.stderr.on('data', (d) => { srvErr = (srvErr + d).slice(-2000); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
      try { up = (await fetch(base + '/privacy')).ok; } catch (_) {}
      if (!up) await new Promise((r) => setTimeout(r, 1000));
    }
    ok('the server boots', up, srvErr.slice(-400));
    const login = async (id) => {
      const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: id + '@gate.test', password: PASS }) });
      return (r.headers.get('set-cookie') || '').split(';')[0];
    };
    const call = async (cookie, method, path, body) => {
      const r = await fetch(base + path, { method, redirect: 'manual',
        headers: Object.assign(cookie ? { Cookie: cookie } : {}, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : (method === 'GET' ? undefined : '{}') });
      const text = await r.text();
      return { status: r.status, text, location: r.headers.get('location') };
    };
    const cAgent = await login(U.agent);
    const cRole = await login(U.roleadmin);
    const cAdmin = await login(U.admin);
    ok('the three test users sign in', !!cAgent && !!cRole && !!cAdmin);

    const leaks = { anon: [], agent: [], roleadmin: [] };
    for (const r of routes) {
      const a = await call('', r.method, r.path);
      if (a.status !== 401) leaks.anon.push(`${r.method} ${r.src} -> ${a.status}`);
      const g = await call(cAgent, r.method, r.path);
      if (g.status !== 403) leaks.agent.push(`${r.method} ${r.src} -> ${g.status}`);
      const ro = await call(cRole, r.method, r.path);
      if (ro.status !== 403) leaks.roleadmin.push(`${r.method} ${r.src} -> ${ro.status}`);
    }
    ok(`with no session, all ${routes.length} admin routes answer 401`, leaks.anon.length === 0, leaks.anon);
    ok(`  a signed-in agent gets 403 on every one`, leaks.agent.length === 0, leaks.agent);
    ok(`  and so does role='admin' without the admin's email`, leaks.roleadmin.length === 0, leaks.roleadmin);

    // The three routes that were open, by name.
    const sr = await call('', 'GET', '/admin/state-rules');
    ok('GET /admin/state-rules with no session: 401 and no rules in the body', sr.status === 401 && !/state_code|citation|Citation/.test(sr.text), sr.status);
    const before = (await P.query(`SELECT COUNT(*)::int n FROM state_category_rules`)).rows[0].n;
    const post = await call('', 'POST', '/admin/state-rules', { stateCode: 'ZZ', category: 'alcohol', minorRule: 'allow', adultRule: 'allow',
      citation: 'an attacker wrote this', dateChecked: '2026-09-29' });
    const after = (await P.query(`SELECT COUNT(*)::int n FROM state_category_rules`)).rows[0].n;
    ok('POST /admin/state-rules with no session: 401, and nothing is written', post.status === 401 && after === before, [post.status, before, after]);
    const del = await call(cAgent, 'DELETE', '/admin/state-rules/1');
    ok('DELETE /admin/state-rules/:id as an agent: 403', del.status === 403, del.status);
    ok('/admin/cache-health with no session: 401', (await call('', 'GET', '/admin/cache-health')).status === 401);
    ok('the referral payouts are closed to agents', (await call(cAgent, 'POST', '/api/admin/referrals/mark-paid')).status === 403
      && (await call(cAgent, 'GET', '/api/admin/referrals/export')).status === 403);

    // The static pages.
    const st1 = await call('', 'GET', '/admin.html');
    const st2 = await call('', 'GET', '/admin-connections.html');
    ok('/admin.html is not served statically: it redirects to the gated /admin', st1.status === 302 && st1.location === '/admin', st1);
    ok('  /admin-connections.html likewise', st2.status === 302 && st2.location === '/admin/connections', st2);

    // The admin still gets in, and a rule change records who made it.
    ok('the admin gets /admin/state-rules', (await call(cAdmin, 'GET', '/admin/state-rules')).status === 200);
    ok('  and /admin/status and /admin/cache-health', (await call(cAdmin, 'GET', '/admin/status')).status === 200
      && (await call(cAdmin, 'GET', '/admin/cache-health')).status === 200);
    // The loop's numbers render on /admin/scan-rejects (jobs/outreachQueue details[].loop).
    await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id = $1`, [U.agent]).catch(() => {});
    await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, details) VALUES ($1, CURRENT_DATE, $2::jsonb)`, [U.agent, JSON.stringify([
      { athleteId: 'g1', athleteName: 'Gate Athlete', tried: [{ brand: 'X', result: 'queued', lane: 'local' }],
        loop: { stop: 'floor', candidates: 22, candidatesToFloor: 22, rungs: ['local'], held: 5, floor: 5, channels: { email: 3, dm: 2 }, byLane: { local: { tried: 22, passed: 5 } } } },
      { athleteId: 'g2', athleteName: 'Gate Short', tried: [],
        loop: { stop: 'ladder', candidates: 40, candidatesToFloor: null, rungs: ['local', 'local-wide', 'social'], held: 2, floor: 5, byLane: { social: { tried: 10, passed: 0 } } } }])]);
    const sr2 = await call(cAdmin, 'GET', '/admin/scan-rejects');
    ok('/admin/scan-rejects renders the floor of five: candidates to five, lanes, who fell short', sr2.status === 200
      && /The floor of five/.test(sr2.text) && /median 22/.test(sr2.text) && /Gate Short/.test(sr2.text) && /2\/5/.test(sr2.text) && /email 3 \(60%\)/.test(sr2.text), sr2.text.slice(0, 300));
    await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id = $1`, [U.agent]).catch(() => {});
    const cats = require(REPO + 'server/services/compliance').CATEGORIES.map((c) => c.key);
    const cat = cats.includes('alcohol') ? 'alcohol' : cats[0];
    await P.query(`DELETE FROM state_category_rules WHERE state_code = 'ZZ'`);
    const save = await call(cAdmin, 'POST', '/admin/state-rules', { stateCode: 'ZZ', category: cat, minorRule: 'block', adultRule: 'allow',
      citation: 'Gate test citation 1', dateChecked: '2026-09-29', enteredBy: 'somebody else entirely' });
    const row = (await P.query(`SELECT id, entered_by FROM state_category_rules WHERE state_code = 'ZZ' AND category = $1`, [cat])).rows[0];
    ok('a rule saved by the admin records the SIGNED-IN admin, not the name in the body', save.status === 200 && row && row.entered_by === ADMIN_EMAIL, [save.status, row]);

    // ── THE CHANGE HISTORY ─────────────────────────────────────────────────
    // The insert above is already in it; everything after is checked by id.
    const H = async (since) => (await P.query(`SELECT id, action, old_value, new_value, changed_by FROM state_category_rules_history
      WHERE state_code = 'ZZ' AND id > $1 ORDER BY id`, [since])).rows;
    const lastId = async () => (await P.query(`SELECT COALESCE(MAX(id), 0)::bigint AS m FROM state_category_rules_history`)).rows[0].m;
    const ins = (await P.query(`SELECT action, new_value, changed_by FROM state_category_rules_history WHERE rule_id = $1 AND action = 'INSERT' ORDER BY id DESC LIMIT 1`, [row && row.id])).rows[0];
    ok('HISTORY: the new rule is recorded, with its values and who added it', ins && ins.changed_by === ADMIN_EMAIL && ins.new_value.minor_rule === 'block', ins);
    let mark = await lastId();
    const edit = { stateCode: 'ZZ', category: cat, minorRule: 'hold', adultRule: 'allow', citation: 'Gate test citation 2', dateChecked: '2026-09-29' };
    await call(cAdmin, 'POST', '/admin/state-rules', edit);
    let h = await H(mark);
    ok('  a change records the old value and the new', h.length === 1 && h[0].action === 'UPDATE' && h[0].old_value.minor_rule === 'block'
      && h[0].new_value.minor_rule === 'hold' && h[0].old_value.citation === 'Gate test citation 1' && h[0].changed_by === ADMIN_EMAIL, h);
    mark = await lastId();
    await call(cAdmin, 'POST', '/admin/state-rules', edit);
    ok('  saving the same values again records nothing', (await H(mark)).length === 0, await H(mark));
    mark = await lastId();
    await P.query(`UPDATE state_category_rules SET adult_rule = 'hold' WHERE state_code = 'ZZ'`);
    h = await H(mark);
    ok('  a change made outside the page (straight SQL) is recorded too, as unattributed', h.length === 1 && /^unattributed \(database user /.test(h[0].changed_by), h);
    const page = await call(cAdmin, 'GET', '/admin/state-rules');
    ok('  the rules page shows the history, old and new', /Change history/.test(page.text) && /minor_rule: <s>block<\/s> &rarr; <b>hold<\/b>/.test(page.text)
      && page.text.includes(ADMIN_EMAIL));
    let refusedU = false, refusedD = false;
    try { await P.query(`UPDATE state_category_rules_history SET changed_by = 'someone else' WHERE state_code = 'ZZ'`); } catch (e) { refusedU = /append-only/.test(e.message); }
    try { await P.query(`DELETE FROM state_category_rules_history WHERE state_code = 'ZZ'`); } catch (e) { refusedD = /append-only/.test(e.message); }
    ok('  the history cannot be edited or deleted', refusedU && refusedD, [refusedU, refusedD]);
    mark = await lastId();
    const gone = row ? await call(cAdmin, 'DELETE', '/admin/state-rules/' + row.id) : { status: 0 };
    ok('  and the admin can delete it', gone.status === 200
      && (await P.query(`SELECT COUNT(*)::int n FROM state_category_rules WHERE state_code = 'ZZ'`)).rows[0].n === 0);
    h = await H(mark);
    ok('  the delete is recorded with the whole rule that was removed, and who', h.length === 1 && h[0].action === 'DELETE' && h[0].new_value === null
      && h[0].old_value.citation === 'Gate test citation 2' && h[0].changed_by === ADMIN_EMAIL, h);
    ok('  an agent cannot read the history (it is on the gated page only)', (await call(cAgent, 'GET', '/admin/state-rules')).status === 403);
  } finally {
    srv.kill('SIGTERM');
  }
  await P.query(`DELETE FROM state_category_rules WHERE state_code = 'ZZ'`).catch(() => {});
  await P.query(`DELETE FROM users WHERE id = ANY($1)`, [Object.values(U)]).catch(() => {});
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
