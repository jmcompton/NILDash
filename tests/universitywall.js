'use strict';
// Runs against the local test Postgres, and boots the real server on a spare
// port to drive it with real sessions. No outside network.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/universitywall.js   just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE WALL BETWEEN THE UNIVERSITY AND AGENT SIDES ─────────────────────────
// middleware/modeGuard universityWall, mounted once on /api. A university-role
// session reaches only what public/university.html fetches; it cannot reach an
// agent route and cannot create an athlete in the agent athletes table. Agent
// and admin sessions are unaffected, and admin still reaches both sides.
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const store = require(REPO + 'server/store.js');
const MG = require(REPO + 'server/middleware/modeGuard.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');
const U = { uni: 'uw-uni', agent: 'uw-agent', admin: 'uw-admin', legacy: 'uw-legacy' };
const PASS = 'wall-test-pass-1';

// A fake request through the wall: what happened, and the status if refused.
async function through(session, method, url) {
  let status = null, nexted = false;
  const res = { status(s) { status = s; return this; }, json() { return this; } };
  await MG.universityWall({ session, method, originalUrl: url, url }, res, () => { nexted = true; });
  return nexted ? 'next' : status;
}

async function freePort() {
  return new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  // ── 1. THE WALL, AS A FUNCTION ────────────────────────────────────────────
  OUT.push('-- the wall --');
  const uni = { userId: 'x', role: 'university' };
  ok('a university session may GET its teams and inventory', await through(uni, 'GET', '/api/university/teams') === 'next'
    && await through(uni, 'GET', '/api/university/inventory?x=1') === 'next');
  ok('  and sign in and out', await through(uni, 'POST', '/api/auth/login') === 'next' && await through(uni, 'POST', '/api/auth/logout') === 'next');
  ok('  and nothing else: an agent route is 403', await through(uni, 'POST', '/api/athletes') === 403
    && await through(uni, 'GET', '/api/athletes') === 403 && await through(uni, 'GET', '/api/agent/pipeline') === 403);
  ok('  nor another university route outside the list (the purge, the old dashboard)',
    await through(uni, 'DELETE', '/api/university/roster/purge-imports') === 403 && await through(uni, 'GET', '/api/university/dashboard') === 403);
  ok('  nor an allowed path with another method', await through(uni, 'POST', '/api/university/teams') === 403
    && await through(uni, 'DELETE', '/api/university/inventory') === 403);
  ok('  case and a trailing slash do not get round it', await through(uni, 'POST', '/API/Athletes/') === 403
    && await through(uni, 'GET', '/api/University/TEAMS/') === 'next');
  ok('university_admin is confined the same way', await through({ userId: 'x', role: 'university_admin' }, 'POST', '/api/athletes') === 403);
  ok('an agent, an athlete and an admin pass untouched', await through({ userId: 'x', role: 'agent' }, 'POST', '/api/athletes') === 'next'
    && await through({ userId: 'x', role: 'athlete' }, 'GET', '/api/athlete/me') === 'next'
    && await through({ userId: 'x', role: 'admin' }, 'POST', '/api/athletes') === 'next');
  ok('no session passes to the route, whose own auth answers', await through({}, 'POST', '/api/athletes') === 'next'
    && await through(undefined, 'GET', '/api/athletes') === 'next');

  // FAILS CLOSED: a session with no role on it, and the lookup broken.
  const realGetUser = store.getUser;
  store.getUser = async () => { throw new Error('database is down'); };
  const closed = await through({ userId: 'x' }, 'GET', '/api/university/teams');
  store.getUser = async () => null;
  const gone = await through({ userId: 'x' }, 'GET', '/api/athletes');
  store.getUser = async () => ({ role: 'university' });
  const legacyUni = { userId: 'x' };
  const legacy = await through(legacyUni, 'POST', '/api/athletes');
  store.getUser = realGetUser;
  ok('fails closed: a role it cannot look up is refused (503), not guessed', closed === 503, closed);
  ok('  a session whose user is gone is refused', gone === 401, gone);
  ok('  and a legacy session with no role is looked up, confined, and remembered', legacy === 403 && legacyUni.role === 'university', [legacy, legacyUni]);

  // ── 2. THE ALLOWLIST IS WHAT THE PAGE FETCHES ─────────────────────────────
  OUT.push('', '-- the allowlist --');
  const page = read('public/university.html');
  const fetched = new Set();
  for (const m of page.matchAll(/getJson\("(\/api\/[^"]+)"\)/g)) fetched.add('GET ' + m[1]);
  for (const m of page.matchAll(/fetch\("(\/api\/[^"]+)",\s*\{\s*method:\s*"(\w+)"/g)) fetched.add(m[2].toUpperCase() + ' ' + m[1]);
  const every = new Set(page.match(/\/api\/[a-z/_-]+/g));
  ok('every API path in university.html is accounted for', [...every].every((p) => [...fetched].some((f) => f.endsWith(' ' + p))), [...every]);
  ok('  and the allowlist is exactly those, no more',
    [...MG.UNIVERSITY_ALLOWED].sort().join('|') === [...fetched].sort().join('|'), { allowed: [...MG.UNIVERSITY_ALLOWED], fetched: [...fetched] });
  ok('admin is not a confined role', !MG.UNIVERSITY_ONLY_ROLES.has('admin') && !MG.UNIVERSITY_ONLY_ROLES.has('agent'));

  // ── 3. MOUNTED ONCE, BEFORE EVERY SESSION ROUTE; requireAgentMode GONE ─────
  OUT.push('', '-- wiring --');
  const IDX = read('server/index.js');
  const wallAt = IDX.indexOf("app.use('/api', universityWall);");
  ok('the wall is mounted on /api, once', wallAt > 0 && IDX.split("app.use('/api', universityWall)").length === 2);
  ok('  straight after the session middleware', wallAt > IDX.indexOf('app.use(session({') && wallAt - IDX.indexOf('app.use(session({') < 1200);
  const before = [...IDX.slice(0, wallAt).matchAll(/app\.(get|post|put|patch|delete|all)\('(\/api[^']*)'/g)].map((m) => m[2]);
  ok('  and no API route that could carry a session is registered above it',
    before.every((p) => /stripe-webhook|webhooks/.test(p)), before);
  const repoFiles = ['server/index.js', 'server/middleware/modeGuard.js'].concat(fs.readdirSync(REPO + 'server/routes').map((f) => 'server/routes/' + f));
  ok('requireAgentMode is gone, not left looking applied',
    !repoFiles.some((f) => /requireAgentMode\s*[,(=]|requireAgentMode\s*\}/.test(read(f).replace(/\/\/[^\n]*/g, ''))) && MG.requireAgentMode === undefined);

  // ── 4. THE REAL SERVER, REAL SESSIONS ─────────────────────────────────────
  OUT.push('', '-- the real server --');
  const hash = await bcrypt.hash(PASS, 8);
  await P.query(`DELETE FROM athletes WHERE agent_id = ANY($1)`, [Object.values(U)]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id = ANY($1) OR email LIKE '%@wall.test'`, [Object.values(U)]).catch(() => {});
  await require(REPO + 'scripts/seed-cypress.js').seed(P);
  const mk = (id, role, uid) => P.query(`INSERT INTO users (id, name, email, password, role, university_id, plan_tier)
    VALUES ($1, $1, $2, $3, $4, $5, 'unlimited')`, [id, id + '@wall.test', hash, role, uid]);
  await mk(U.uni, 'university', 'univ-cypress');
  await mk(U.agent, 'agent', null);
  await mk(U.admin, 'admin', 'univ-cypress');

  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'wall-test',
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
        body: JSON.stringify({ email: id + '@wall.test', password: PASS }) });
      return (r.headers.get('set-cookie') || '').split(';')[0];
    };
    const call = async (cookie, method, path, body) => {
      const r = await fetch(base + path, { method, headers: Object.assign({ Cookie: cookie }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined });
      let j = null; try { j = await r.json(); } catch (_) {}
      return { status: r.status, body: j };
    };
    const count = async (agentId) => (await P.query(`SELECT COUNT(*)::int n FROM athletes WHERE agent_id = $1`, [agentId])).rows[0].n;
    const total = async () => (await P.query(`SELECT COUNT(*)::int n FROM athletes`)).rows[0].n;
    const athlete = { name: 'Wall Test Athlete', sport: 'football', school: 'Auburn University' };

    const cu = await login(U.uni);
    ok('the university account signs in', !!cu);
    const beforeAll = await total();
    const create = await call(cu, 'POST', '/api/athletes', athlete);
    ok('UNIVERSITY: POST /api/athletes is refused 403', create.status === 403 && create.body && create.body.code === 'UNIVERSITY_ROLE_BLOCKED', create);
    ok('  and no athlete was created in the agent athletes table, by anyone', (await count(U.uni)) === 0 && (await total()) === beforeAll);
    const list = await call(cu, 'GET', '/api/athletes');
    ok('  GET /api/athletes (a representative agent route) is 403', list.status === 403, list.status);
    const pipe = await call(cu, 'GET', '/api/agent/pipeline');
    ok('  and so is the agent pipeline', pipe.status === 403, pipe.status);
    const t = await call(cu, 'GET', '/api/university/teams');
    const i = await call(cu, 'GET', '/api/university/inventory');
    ok('  its own portal still works: teams and inventory', t.status === 200 && t.body.teams.length === 14 && i.status === 200 && i.body.items.length === 65, [t.status, i.status]);
    const out = await call(cu, 'POST', '/api/auth/logout');
    ok('  and it can sign out', out.status === 200, out.status);

    const ca = await login(U.agent);
    const made = await call(ca, 'POST', '/api/athletes', athlete);
    ok('AGENT: POST /api/athletes works as before', made.status >= 200 && made.status < 300 && (await count(U.agent)) === 1, [made.status, made.body]);
    const alist = await call(ca, 'GET', '/api/athletes');
    ok('  GET /api/athletes works as before', alist.status === 200 && Array.isArray(alist.body) && alist.body.length === 1, alist.status);
    const aUni = await call(ca, 'GET', '/api/university/teams');
    ok('  and the university side is still closed to it (requireUniversityMode)', aUni.status === 403, aUni.status);

    const cd = await login(U.admin);
    const dList = await call(cd, 'GET', '/api/athletes');
    const dTeams = await call(cd, 'GET', '/api/university/teams');
    ok('ADMIN: reaches the agent side', dList.status === 200, dList.status);
    ok('  and the university side', dTeams.status === 200 && dTeams.body.teams.length === 14, dTeams.status);

    // THE LEGACY PORTAL IS GONE: nothing answers where it used to.
    const reg = await call('', 'POST', '/api/university/register', { email: 'x@x.test', password: 'x', universityId: 'univ-cypress', name: 'x' });
    const ulog = await call('', 'POST', '/api/university/login', { email: 'x@x.test', password: 'x' });
    const ulist = await call('', 'GET', '/api/university/list');
    ok('LEGACY: /api/university/register, /login and /list are 404', reg.status === 404 && ulog.status === 404 && ulist.status === 404,
      [reg.status, ulog.status, ulist.status]);

    // THE WAY IN NOW: an account made by scripts/create-university-user.js.
    const CU = require(REPO + 'scripts/create-university-user.js');
    const madeU = await CU.createUniversityUser(P, { email: U.legacy + '@wall.test', name: 'Script Made', universityId: 'univ-cypress', password: PASS });
    const cs = await login(U.legacy);
    const sTeams = await call(cs, 'GET', '/api/university/teams');
    const sInv = await call(cs, 'GET', '/api/university/inventory');
    const sAgent = await call(cs, 'POST', '/api/athletes', athlete);
    ok('SCRIPT-MADE ACCOUNT: signs in and sees Cypress: 14 teams, 65 items',
      madeU.ok && sTeams.status === 200 && sTeams.body.teams.length === 14 && sInv.status === 200 && sInv.body.items.length === 65, [madeU, sTeams.status]);
    ok('  and is walled off from the agent side like any university account', sAgent.status === 403, sAgent.status);
  } finally {
    srv.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    await P.query(`DELETE FROM athletes WHERE agent_id = ANY($1)`, [Object.values(U)]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id = ANY($1) OR email LIKE '%@wall.test'`, [Object.values(U)]).catch(() => {});
  }

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('universitywall: FAILED', e); process.exit(1); });
