'use strict';
// Runs against the local test Postgres. No network.
//
//   node tests/run.js                   every suite, against the committed baseline
//   node tests/createuniversityuser.js  just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── scripts/create-university-user.js, AND THE LEGACY PORTAL GONE ───────────
const fs = require('fs');
const { spawnSync } = require('child_process');
const bcrypt = require('bcryptjs');
const store = require(REPO + 'server/store.js');
const CU = require(REPO + 'scripts/create-university-user.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');
const E = (k) => `cu-${k}@cu.test`;
const PW = 'correct-horse-battery-staple';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = () => P.query(`DELETE FROM users WHERE email LIKE '%@cu.test'`).catch(() => {});
  await clean();
  await require(REPO + 'scripts/seed-cypress.js').seed(P);

  // ── 1. THE LEGACY COMPLIANCE PORTAL IS GONE ───────────────────────────────
  OUT.push('-- the legacy portal --');
  const IDX = read('server/index.js').replace(/\/\/[^\n]*/g, '');
  const legacy = ['/api/university/register', '/api/university/login', '/api/university/logout', '/api/university/me',
    '/api/university/list', '/api/university/ai/compliance-check', '/api/university/ai/deal-recommendations/:athleteId',
    '/api/university/flags', '/api/university/flags/:id/resolve', '/api/university/compliance-dashboard',
    '/api/university/athlete-links/:id'];
  const still = legacy.filter((p) => IDX.includes(`'${p}'`));
  ok('all eleven legacy routes are deleted', still.length === 0, still);
  const serverJs = [];
  (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = _tp.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) serverJs.push(p);
  } })(REPO + 'server');
  const live = serverJs.filter((p) => /requireUniversityAuth|universityUserId/.test(fs.readFileSync(p, 'utf8').replace(/\/\/[^\n]*/g, '')));
  ok('requireUniversityAuth and universityUserId are gone from server code', live.length === 0, live);
  ok('  nothing in any page but the old portal code called them',
    !fs.readdirSync(REPO + 'public').filter((f) => /\.(html|js)$/.test(f) && f !== 'index.html')
      .some((f) => /\/api\/university\/(register|login|list|me)\b/.test(read('public/' + f))));

  // ── 2. THE SCRIPT'S RULES ─────────────────────────────────────────────────
  OUT.push('', '-- create-university-user --');
  const made = await CU.createUniversityUser(P, { email: ' CU-One@CU.test ', name: 'Pat Doe', universityId: 'univ-cypress', password: PW });
  const row = (await P.query(`SELECT * FROM users WHERE email = $1`, [E('one')])).rows[0];
  ok('creates a users row: role university, the university linked, the email normalised',
    made.ok && made.created && row && row.role === 'university' && row.university_id === 'univ-cypress' && row.name === 'Pat Doe', [made, row && row.role]);
  ok('  the password stored only as a bcrypt hash', row && row.password !== PW && await bcrypt.compare(PW, row.password));
  const again = await CU.createUniversityUser(P, { email: E('one'), name: 'Someone Else', universityId: 'univ-cypress', password: 'a-different-password-9' });
  const row2 = (await P.query(`SELECT * FROM users WHERE email = $1`, [E('one')])).rows[0];
  ok('run twice: says it exists and changes nothing, not even the password',
    again.ok && again.unchanged && row2.password === row.password && row2.name === 'Pat Doe', again);
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ('cu-agent', 'An Agent', $1, 'agent-hash', 'agent')`, [E('agent')]);
  const clash = await CU.createUniversityUser(P, { email: E('agent'), name: 'X', universityId: 'univ-cypress', password: PW });
  const agentRow = (await P.query(`SELECT role, password, university_id FROM users WHERE email = $1`, [E('agent')])).rows[0];
  ok('an email that belongs to an agent is refused, and the agent is untouched',
    !clash.ok && /already belongs to a agent account/.test(clash.error) && agentRow.role === 'agent' && agentRow.password === 'agent-hash' && agentRow.university_id === null, [clash, agentRow]);
  await P.query(`INSERT INTO universities (id, name) VALUES ('cu-other-uni', 'CU Other Uni') ON CONFLICT (id) DO NOTHING`);
  const moved = await CU.createUniversityUser(P, { email: E('one'), name: 'Pat Doe', universityId: 'cu-other-uni', password: PW });
  ok('  so is one that belongs to another university\'s account', !moved.ok && /linked to univ-cypress/.test(moved.error), moved);
  const noUni = await CU.createUniversityUser(P, { email: E('two'), name: 'X', universityId: 'univ-nope', password: PW });
  ok('an unknown university is refused', !noUni.ok && /No university with id/.test(noUni.error));
  ok('a short password, a bad email or no name is refused',
    !(await CU.createUniversityUser(P, { email: E('two'), name: 'X', universityId: 'univ-cypress', password: 'short' })).ok
    && !(await CU.createUniversityUser(P, { email: 'not-an-email', name: 'X', universityId: 'univ-cypress', password: PW })).ok
    && !(await CU.createUniversityUser(P, { email: E('two'), name: ' ', universityId: 'univ-cypress', password: PW })).ok);
  ok('  and none of those wrote a row', (await P.query(`SELECT COUNT(*)::int n FROM users WHERE email = $1`, [E('two')])).rows[0].n === 0);

  // ── 3. THE COMMAND LINE ───────────────────────────────────────────────────
  OUT.push('', '-- the command line --');
  const cli = (args, env) => spawnSync(process.execPath, [REPO + 'scripts/create-university-user.js', ...args],
    { encoding: 'utf8', env: { ...process.env, ...env }, input: '', timeout: 60000 });
  const withArg = cli(['--email', E('three'), '--name', 'Three', '--university', 'univ-cypress', '--password', PW]);
  ok('a password on the command line is refused before anything is written',
    withArg.status === 1 && /never pass a password on the command line/.test(withArg.stderr)
    && (await P.query(`SELECT COUNT(*)::int n FROM users WHERE email = $1`, [E('three')])).rows[0].n === 0, withArg.stderr);
  const noTty = cli(['--email', E('three'), '--name', 'Three', '--university', 'univ-cypress'], { NILDASH_NEW_USER_PASSWORD: '' });
  ok('  with no terminal and no password it stops and says how', noTty.status === 1 && /NILDASH_NEW_USER_PASSWORD/.test(noTty.stderr), noTty.stderr);
  const viaEnv = cli(['--email', E('three'), '--name', 'Three Person', '--university', 'univ-cypress'], { NILDASH_NEW_USER_PASSWORD: PW });
  const r3 = (await P.query(`SELECT role, university_id, password FROM users WHERE email = $1`, [E('three')])).rows[0];
  ok('from the environment it creates the account', viaEnv.status === 0 && r3 && r3.role === 'university' && await bcrypt.compare(PW, r3.password), [viaEnv.stdout, viaEnv.stderr]);
  ok('  and the password appears nowhere in what it printed', !(viaEnv.stdout + viaEnv.stderr).includes(PW));
  const rerun = cli(['--email', E('three'), '--name', 'Three Person', '--university', 'univ-cypress'], { NILDASH_NEW_USER_PASSWORD: 'another-password-123' });
  ok('  run again it changes nothing', rerun.status === 0 && /Nothing was changed/.test(rerun.stdout)
    && (await P.query(`SELECT password FROM users WHERE email = $1`, [E('three')])).rows[0].password === r3.password, rerun.stdout);
  const none = cli(['--email', E('four'), '--name', 'Four', '--university', 'univ-cypress', '--no-password'], {});
  ok('--no-password creates it with a password nobody knows, and says how to set one',
    none.status === 0 && /Forgot password/.test(none.stdout)
    && (await P.query(`SELECT COUNT(*)::int n FROM users WHERE email = $1 AND role = 'university'`, [E('four')])).rows[0].n === 1, none.stdout);
  // One HTTP route, for the admin only (Cypress, without a terminal): it
  // generates the password and returns it once. Nothing else reaches it, and
  // it is not in the admin script runner. To be replaced by an emailed
  // set-password link.
  ok('the only HTTP route to it is the admin one, and it is not in the admin script runner',
    (IDX.match(/create-university-user/g) || []).length === 1
    && /app\.post\('\/api\/admin\/university-users', requireAuth, requireCampusAdmin,/.test(IDX)
    && /password: r\.created \? password : undefined/.test(IDX));

  await clean();
  await P.query(`DELETE FROM universities WHERE id = 'cu-other-uni'`).catch(() => {});
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('createuniversityuser: FAILED', e); process.exit(1); });
