'use strict';
// Runs against the local test Postgres and boots the real server.
//
//   node tests/teamseats.js
//
// ── TEAM SEATS (services/teamSeats) ─────────────────────────────────────────
// An agent invites staff; each gets their own login and works the owner's
// account. Billing, the team and the mailbox stay with the owner. Removing a
// member ends their sessions. Fictional names only.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('teamseatstest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const OWNER_PASS = 'owner-pass-1', MEMBER_PASS = 'member-pass-1';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  const TS = require(REPO + 'server/services/teamSeats.js');
  await TS.ensureColumns(P);
  const hash = await bcrypt.hash(OWNER_PASS, 8);
  await P.query(`INSERT INTO users (id, name, email, password, role, comped) VALUES
    ('ts-owner','Avery Stone','avery@stoneagency.test',$1,'agent',TRUE),
    ('ts-other','Other Agent','other@elsewhere.test',$1,'agent',TRUE),
    ('ts-admin','Admin Person','admin@nildash.test',$1,'admin',TRUE)`, [hash]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('ts-ath1','ts-owner','{"name":"Jordan Lake","sport":"Volleyball"}'::jsonb)`).catch((e) => console.error('athlete seed', e.message));
  const owner = (await P.query(`SELECT * FROM users WHERE id='ts-owner'`)).rows[0];

  // ── THE SERVICE ────────────────────────────────────────────────────────
  const sent = [];
  const send = async (m) => { sent.push(m); };
  ok('an admin account cannot have a team (a staff login would inherit admin)', !(await TS.invite(P, (await P.query(`SELECT * FROM users WHERE id='ts-admin'`)).rows[0], { name: 'X Y', email: 'x@y.test' }, { send })).ok);
  ok('bad input is refused', !(await TS.invite(P, owner, { name: '', email: 'a@b.test' }, { send })).ok && !(await TS.invite(P, owner, { name: 'Sam', email: 'nope' }, { send })).ok
    && !(await TS.invite(P, owner, { name: 'Me', email: 'AVERY@stoneagency.test' }, { send })).ok);
  ok('  an email that already has an account is refused', /already has a NILDash account/.test((await TS.invite(P, owner, { name: 'Other', email: 'other@elsewhere.test' }, { send })).error));
  const inv = await TS.invite(P, owner, { name: 'Casey Reed', email: 'Casey@StoneAgency.test' }, { send });
  ok('an invite: a team_member row on the owner, an email with a set-password link', inv.ok && inv.member.email === 'casey@stoneagency.test' && sent.length === 1 && sent[0].to === 'casey@stoneagency.test'
    && /\/reset\?token=/.test(sent[0].url) && sent[0].ownerName === 'Avery Stone', inv);
  const row = (await P.query(`SELECT role, team_owner_id, password_reset_required FROM users WHERE id = $1`, [inv.member.id])).rows[0];
  ok('  the row is a team member of the owner', row.role === 'team_member' && row.team_owner_id === 'ts-owner' && row.password_reset_required === true, row);
  ok('  inviting them again while active is refused', /already on your team/.test((await TS.invite(P, owner, { name: 'Casey Reed', email: 'casey@stoneagency.test' }, { send })).error));
  const failSend = await TS.invite(P, owner, { name: 'Robin Fox', email: 'robin@stoneagency.test' }, { send: async () => { throw new Error('mail down'); } });
  ok('  a failed email still returns the link to share by hand', failSend.ok && failSend.emailed === false && /\/reset\?token=/.test(failSend.setPasswordUrl));
  const L = await TS.list(P, 'ts-owner');
  ok('the list: both, invited until they sign in, none from another account', L.length === 2 && L.every((m) => m.status === 'invited') && (await TS.list(P, 'ts-other')).length === 0);
  const res = await TS.resolve(P, (await P.query(`SELECT * FROM users WHERE id = $1`, [inv.member.id])).rows[0]);
  ok('sign-in resolves a member to the owner\'s account', res.ok && res.account.id === 'ts-owner' && res.member.id === inv.member.id);
  ok('  a normal agent resolves to themselves', (await TS.resolve(P, owner)).account.id === 'ts-owner');
  ok('owner-only: billing, the team, the mailbox', TS.ownerOnly('POST', '/api/agent/create-checkout') && TS.ownerOnly('POST', '/api/team/invite') && TS.ownerOnly('GET', '/api/email/oauth/gmail')
    && TS.ownerOnly('DELETE', '/api/email/accounts/9') && !TS.ownerOnly('GET', '/api/athletes') && !TS.ownerOnly('GET', '/api/team') && !TS.ownerOnly('POST', '/api/athletes'));

  // ── THE REAL SERVER ────────────────────────────────────────────────────
  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'team-test', CYPRESS_SEED_ON_BOOT: 'off', UNIVERSITY_NIGHTLY: 'off', PORTAL_ROSTER_SWEEP: 'off',
      RESEND_API_KEY: 're_test_dummy', DATABASE_URL: '', APP_URL: 'http://127.0.0.1:' + port },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let srvErr = ''; srv.stderr.on('data', (d) => { srvErr = (srvErr + d).slice(-3000); });
  const base = `http://127.0.0.1:${port}`;
  const jar = () => { let c = ''; return { call: async (m, p, body) => { const r = await fetch(base + p, { method: m, redirect: 'manual', headers: Object.assign(c ? { Cookie: c } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) c = sc.split(';')[0]; return r; } }; };
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/privacy')).ok; } catch (_) {} if (!up) await new Promise((r) => setTimeout(r, 1000)); }
    ok('the server boots', up, srvErr.slice(-400));
    const O = jar();
    ok('the owner signs in', (await O.call('POST', '/api/auth/login', { email: 'avery@stoneagency.test', password: OWNER_PASS })).status === 200);
    const viaHttp = await (await O.call('POST', '/api/team/invite', { name: 'Dana Wolfe', email: 'dana@stoneagency.test' })).json();
    ok('the owner invites over HTTP; the email failing still returns the link', viaHttp.ok && /\/reset\?token=/.test(viaHttp.setPasswordUrl), viaHttp);
    const team = await (await O.call('GET', '/api/team')).json();
    ok('  the team list shows three invited, and the owner can have a team', team.isOwner && team.canHaveTeam && team.members.length === 3, team);

    // Dana sets a password with the link, then signs in.
    const token = viaHttp.setPasswordUrl ? new URL(viaHttp.setPasswordUrl).searchParams.get('token') : '';
    const reset = await fetch(base + '/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: MEMBER_PASS }) });
    ok('the member sets their own password with the link', reset.status === 200, await reset.text());
    const M = jar();
    const login = await (await M.call('POST', '/api/auth/login', { email: 'dana@stoneagency.test', password: MEMBER_PASS })).json();
    ok('the member signs in to the owner\'s account', login.id === 'ts-owner' && login.member && login.member.email === 'dana@stoneagency.test' && login.passwordResetRequired === false, login);
    const me = await (await M.call('GET', '/api/auth/me')).json();
    ok('  /me: the owner\'s account and plan, with who is signed in', me.id === 'ts-owner' && me.member.name === 'Dana Wolfe' && me.isTeamOwner === false && me.agentAccess === true, me);
    const aths = await (await M.call('GET', '/api/athletes')).json();
    ok('  they see the owner\'s athletes', JSON.stringify(aths).includes('Jordan Lake'));
    ok('owner-only for a member: billing, the team, the mailbox', (await M.call('POST', '/api/agent/create-checkout', {})).status === 403
      && (await M.call('POST', '/api/team/invite', { name: 'Z Z', email: 'z@z.test' })).status === 403 && (await M.call('POST', '/api/team/remove', { id: 'x' })).status === 403
      && (await M.call('GET', '/api/email/oauth/gmail')).status === 403);
    const teamAsMember = await (await M.call('GET', '/api/team')).json();
    ok('  a member can see the team, not change it', teamAsMember.isOwner === false && teamAsMember.members.length === 3);
    const cp = await M.call('POST', '/api/auth/change-password', { currentPassword: MEMBER_PASS, newPassword: 'member-pass-2' });
    ok('a member changes their own password, never the owner\'s', cp.status === 200
      && (await jar().call('POST', '/api/auth/login', { email: 'avery@stoneagency.test', password: OWNER_PASS })).status === 200
      && (await jar().call('POST', '/api/auth/login', { email: 'dana@stoneagency.test', password: 'member-pass-2' })).status === 200);
    const status = (await (await O.call('GET', '/api/team')).json()).members.find((m) => m.email === 'dana@stoneagency.test').status;
    ok('  once signed in, the list says active', status === 'active', status);

    const danaId = viaHttp.member.id;
    ok('the owner removes the member', (await O.call('POST', '/api/team/remove', { id: danaId })).status === 200);
    ok('  their open session ends at once', (await M.call('GET', '/api/auth/me')).status === 401);
    const again = await jar().call('POST', '/api/auth/login', { email: 'dana@stoneagency.test', password: 'member-pass-2' });
    ok('  and they cannot sign in', again.status === 403 && /removed by the account owner/.test((await again.json()).error));
    ok('  another agent cannot remove someone on this team', (await (async () => { const X = jar(); await X.call('POST', '/api/auth/login', { email: 'other@elsewhere.test', password: OWNER_PASS }); return (await X.call('POST', '/api/team/remove', { id: inv.member.id })).status; })()) === 404);
    const back = await (await O.call('POST', '/api/team/invite', { name: 'Dana Wolfe', email: 'dana@stoneagency.test' })).json();
    ok('inviting a removed member again brings them back with a new link', back.ok && back.member.id === danaId);
  } finally { srv.kill(); }

  // ── THE PAGE AND THE SWEEPS ────────────────────────────────────────────
  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('team members get no shift report or digest of their own', (idx.match(/role <> 'athlete' AND role <> 'team_member'/g) || []).length === 2 && /u\.role <> 'athlete' AND u\.role <> 'team_member'/.test(idx));
  const page = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('Settings: Your team card, priced by athletes not people', /id="team-card"/.test(page) && /priced by athletes, not people/.test(page) && /setTimeout\(loadTeam, 60\)/.test(page));
  ok('no em dashes in the new copy', !/[—]/.test(fs.readFileSync(REPO + 'server/services/teamSeats.js', 'utf8').replace(/\/\/.*$/gm, '')));

  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.log(OUT.join('\n')); console.error(e); process.exit(1); });
