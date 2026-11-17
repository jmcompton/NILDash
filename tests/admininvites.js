'use strict';
// node tests/admininvites.js  (local test Postgres, real server)
// ── THE ADMIN MAKES AN AGENT'S INSTAGRAM LINKS (/api/admin/instagram-invites) ──
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('admininvitestest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  const hash = await bcrypt.hash('pw-123456', 8);
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ('ai-admin','Admin','boss@ai.test',$1,'admin'), ('ai-g','Greg Coach','greg@ai.test',$1,'agent'), ('ai-x','Other','x@ai.test',$1,'agent')`, [hash]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('ai-1','ai-g','{"name":"Amber Breton"}'::jsonb), ('ai-2','ai-g','{"name":"Cooper Farrall"}'::jsonb), ('ai-3','ai-x','{"name":"Madelyn Deprey"}'::jsonb)`);
  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], { env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'ai-test', ADMIN_EMAIL: 'boss@ai.test',
    CYPRESS_SEED_ON_BOOT: 'off', UNIVERSITY_NIGHTLY: 'off', PORTAL_ROSTER_SWEEP: 'off', RESEND_API_KEY: 're_test_dummy', DATABASE_URL: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; srv.stderr.on('data', (x) => { err = (err + x).slice(-3000); });
  const base = `http://127.0.0.1:${port}`;
  const login = async (email) => (((await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'pw-123456' }) })).headers.get('set-cookie')) || '').split(';')[0];
  const post = (c, body) => fetch(base + '/api/admin/instagram-invites', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: c }, body: JSON.stringify(body) });
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/privacy')).ok; } catch (_) {} if (!up) await new Promise((x) => setTimeout(x, 1000)); }
    ok('the server boots', up, err.slice(-300));
    const agentC = await login('greg@ai.test');
    ok('an agent cannot use it', (await post(agentC, { agentEmail: 'greg@ai.test', athletes: ['Amber Breton'] })).status === 403);
    const adminC = await login('boss@ai.test');
    const r = await (await post(adminC, { agentEmail: 'GREG@ai.test', athletes: ['amber breton', 'Cooper Farrall', 'Madelyn Deprey'] })).json();
    ok('the admin gets links for the agent\'s athletes, by name, any case', r.ok && r.links.length === 2 && r.links.every((l) => /\/athlete\/connect\/[A-Za-z0-9_-]+$/.test(l.url)), r);
    ok('  an athlete of another agent is not matched, and is reported missing', JSON.stringify(r.missing) === JSON.stringify(['madelyn deprey']), r.missing);
    const tok = (await P.query(`SELECT agent_id FROM instagram_connect_tokens WHERE athlete_id = 'ai-1' AND revoked_at IS NULL`)).rows;
    ok('  the invite is recorded under the athlete\'s own agent', tok.length === 1 && tok[0].agent_id === 'ai-g', tok);
    ok('unknown agent: 404; no names: 400', (await post(adminC, { agentEmail: 'nobody@ai.test', athletes: ['A'] })).status === 404 && (await post(adminC, { agentEmail: 'greg@ai.test' })).status === 400);
  } finally { srv.kill(); }
  console.log(OUT.join('\n')); console.log(`\n${OUT.length - F}/${OUT.length} passed`); process.exit(F ? 1 : 0);
}
main().catch((e) => { console.log(OUT.join('\n')); console.error(e); process.exit(1); });
