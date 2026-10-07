'use strict';
// Runs against the local test Postgres.
//
//   node tests/resetlanding.js
//
// ── A UNIVERSITY ACCOUNT GOES FROM THE EMAIL STRAIGHT TO ITS PORTAL ──────────
// After setting a password, every account was sent to "/", the public site's
// agent pitch (For agents, Pricing), to sign in again. A university account
// (a coordinator we onboarded) is now signed in and sent to /university; an
// agent or an athlete keeps the "sign in with your new password" screen.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 500) : '')); } };

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const store = require(REPO + 'server/store.js');
  const PR = require(REPO + 'server/services/passwordReset.js');
  const UA = require(REPO + 'server/services/universityAdmin.js');
  const P = store.pool;
  const U = 'univ-resettest';
  const clean = async () => {
    await P.query(`DELETE FROM users WHERE email IN ('coord@resettest.example','agent@resettest.example')`);
    await P.query(`DELETE FROM university_staff WHERE university_id = $1`, [U]).catch(() => {});
    await P.query(`DELETE FROM universities WHERE id = $1`, [U]);
  };
  await clean();
  await P.query(`INSERT INTO universities (id, name, short_name, location) VALUES ($1,'Reset Test College','RTC','1 College Way, Resettown, CA 90000')`, [U]);

  // The coordinator, onboarded the way Xavier was: a set-password link.
  const made = await UA.createUniversityUser(P, { email: 'coord@resettest.example', name: 'Pat Coordinator', title: 'NIL Coordinator', universityId: U });
  ok('the coordinator gets a set-password link', made.ok && /\/reset\?token=/.test(made.resetUrl || ''), made);
  const token = new URL(made.resetUrl).searchParams.get('token');
  const out = await PR.completeReset({ pool: P, token, password: 'a-new-password-1' });
  const land = await PR.landingFor(P, out);
  ok('A UNIVERSITY ACCOUNT IS SIGNED IN AND SENT TO /university', out.ok && land.signIn === true && land.redirect === '/university' && land.userId === made.userId
    && PR.UNIVERSITY_ROLES.includes(land.role), { out, land });

  // An agent: unchanged.
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ('u-resettest-agent','An Agent','agent@resettest.example','x','agent')`);
  const at = await PR.issueResetToken(P, { email: 'agent@resettest.example' });
  const aout = await PR.completeReset({ pool: P, token: at.token, password: 'a-new-password-2' });
  const aland = await PR.landingFor(P, aout);
  ok("AN AGENT KEEPS TODAY'S SCREEN: not signed in, no redirect", aout.ok && aland.signIn === false && aland.redirect === null, aland);
  ok('  a failed reset is never a sign-in', (await PR.landingFor(P, { ok: false })).signIn === false);

  // The route and the page.
  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  const route = idx.slice(idx.indexOf("app.post('/api/auth/reset-password'"), idx.indexOf("app.post('/api/auth/reset-password'") + 1600);
  ok('the route signs a university account in on a fresh session and returns the portal', /landingFor/.test(route) && /session\.regenerate/.test(route)
    && /req\.session\.userId = land\.userId/.test(route) && /redirect: land\.redirect/.test(route));
  const page = fs.readFileSync(REPO + 'public/reset.html', 'utf8');
  ok('the page goes straight there, and keeps the old screen for everyone else', /if \(data\.ok && data\.redirect\)[\s\S]{0,200}window\.location\.replace\(data\.redirect\)/.test(page)
    && /Sign in with your new password/.test(page) && /credentials: "same-origin"/.test(page));
  await clean();
}
main().then(() => { console.log(OUT.join('\n')); console.log(`\nfailures: ${F}`); process.exit(F ? 1 : 0); })
  .catch((e) => { console.log(OUT.join('\n')); console.log('FAIL threw: ' + (e && e.stack)); process.exit(1); });
