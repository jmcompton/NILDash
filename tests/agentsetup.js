'use strict';
// Runs against the local test Postgres, boots the real server, and drives the
// real page in headless Chromium (the browser part is skipped, and says so,
// where Playwright is not installed).
//
//   node tests/agentsetup.js
//
// ── THE FIRST SESSION FOR EVERY NEW AGENT (AGENT_SETUP_ON) ──────────────────
//   invite and set-password links for new agents last 30 days, not 7
//   an expired link is not a dead end: one button, "Send me a new link"
//   before Home, three required steps in order -- connect your email, your
//   business address, add an athlete or import a roster -- one screen each,
//   "2 of 3 done", and leaving and coming back resumes where they left off
//   for new agents and existing agents who have never sent an email
//   it replaces the 3-step wizard; the assistant no longer takes over Home
//   each step stamped; onboarding-funnel prints the eight steps
//   off: nothing changes
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
delete process.env.AGENT_SETUP_ON;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const fs = require('fs');
const net = require('net');
const { spawn, execSync } = require('child_process');
const bcrypt = require('bcryptjs');
const store = require(REPO + 'server/store.js');
const AS = require(REPO + 'server/services/agentSetup.js');
const PR = require(REPO + 'server/services/passwordReset.js');
const OF = require(REPO + 'server/services/onboardingFunnel.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const DAY = 86400000;
const P = () => store.pool;
const on = () => { process.env.AGENT_SETUP_ON = '1'; };
const off = () => { delete process.env.AGENT_SETUP_ON; };
const PASS = 'setup-pass-123';
const U = { fresh: 'as-fresh', sent: 'as-sent', ready: 'as-ready', browser: 'as-browser', admin: 'as-admin', funnel: 'as-funnel' };
const IDS = Object.values(U);
const EMAIL = (id) => id + '@as-test.test';
const read = (f) => fs.readFileSync(REPO + f, 'utf8');

async function clean() {
  await P().query(`DELETE FROM agent_setup WHERE user_id = ANY($1)`, [IDS]).catch(() => {});
  await P().query(`DELETE FROM email_accounts WHERE user_id = ANY($1)`, [IDS]).catch(() => {});
  await P().query(`DELETE FROM athletes WHERE agent_id = ANY($1)`, [IDS]).catch(() => {});
  await P().query(`DELETE FROM outreach_logs WHERE agent_id = ANY($1)`, [IDS]).catch(() => {});
  await P().query(`DELETE FROM password_resets WHERE email LIKE '%@as-test.test'`).catch(() => {});
  await P().query(`DELETE FROM users WHERE id = ANY($1)`, [IDS]).catch(() => {});
}
async function mkUser(id, role, extra = {}) {
  await P().query(`INSERT INTO users (id, name, email, password, role, plan_tier, comped, created_at, last_login, first_login_at)
    VALUES ($1, $2, $3, $4, $5, 'unlimited', TRUE, $6, $7, $8)`,
    [id, extra.name || 'Avery Setup', EMAIL(id), await bcrypt.hash(PASS, 6), role, extra.created || new Date(), extra.login || null, extra.firstLogin || null]);
}
const mailbox = (id) => P().query(`INSERT INTO email_accounts (id, user_id, provider, email_address, status, can_send) VALUES ($1, $2, 'gmail', $3, 'active', TRUE)`, [id + '-mbx', id, EMAIL(id)]);
const address = (id) => P().query(`UPDATE users SET business_street = '1 Main St', business_city = 'Auburn', business_state = 'AL', business_zip = '36830', business_address_at = NOW() WHERE id = $1`, [id]);
const athlete = (id) => P().query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1, $2, $3::jsonb)`, [id + '-ath', id, JSON.stringify({ name: 'Tess Court', school: 'Auburn University', sport: 'Tennis' })]);
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  await AS.ensureTable(P());
  await clean();

  // ── 1. WHO, AND WHERE THEY ARE (pure) ────────────────────────────────────
  OUT.push('-- who gets the setup, and where they are --');
  const f0 = { role: 'agent', mailbox: false, address: false, athletes: 0, everSent: false };
  ok('off: nobody is asked', AS.evaluate(f0, null, false).required === false);
  const e0 = AS.evaluate(f0, null, true);
  ok('on: a new agent is asked, starting with their email, "0 of 3 done"', e0.required && e0.current === 'mailbox' && e0.progress === '0 of 3 done', e0);
  ok('  the steps are in order: email, address, athletes', JSON.stringify(e0.steps.map((s) => s.key)) === '["mailbox","address","athlete"]');
  ok('  mailbox done: the address is next', AS.evaluate({ ...f0, mailbox: true }, null, true).current === 'address');
  ok('  an address but no mailbox: still the mailbox first (the order holds)', AS.evaluate({ ...f0, address: true }, null, true).current === 'mailbox');
  ok('  two done: "2 of 3 done", the athletes next', AS.evaluate({ ...f0, mailbox: true, address: true }, null, true).progress === '2 of 3 done'
    && AS.evaluate({ ...f0, mailbox: true, address: true }, null, true).current === 'athlete');
  ok('an existing agent who has sent an email is never asked', AS.evaluate({ ...f0, everSent: true }, null, true).required === false);
  ok('  one who has all three already is not asked', AS.evaluate({ ...f0, mailbox: true, address: true, athletes: 2 }, null, true).required === false);
  ok('  finished once, never asked again (even after a disconnect)', AS.evaluate(f0, { done_at: new Date() }, true).required === false);
  ok('  only agents: not an admin or a university account', AS.evaluate({ ...f0, role: 'admin' }, null, true).required === false);

  // ── 2. STAMPED AS IT HAPPENS ─────────────────────────────────────────────
  OUT.push('', '-- each step stamped --');
  await mkUser(U.fresh, 'agent');
  await mkUser(U.sent, 'agent');
  await P().query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_at) VALUES ('as-log', $1, 'x', 'Biz', 's', '<p>x</p>', 'sent', NOW())`, [U.sent]);
  off();
  ok('off: the state says not required and nothing is written', !(await AS.state(P(), U.fresh)).required
    && (await P().query(`SELECT COUNT(*)::int n FROM agent_setup WHERE user_id = $1`, [U.fresh])).rows[0].n === 0);
  on();
  const s1 = await AS.state(P(), U.fresh);
  ok('on: a new agent is required, at the email step', s1.required && s1.current === 'mailbox', s1);
  await mailbox(U.fresh);
  const s2 = await AS.state(P(), U.fresh);
  const row2 = (await P().query(`SELECT * FROM agent_setup WHERE user_id = $1`, [U.fresh])).rows[0];
  ok('  the mailbox is connected: the address is next, and the mailbox step is stamped', s2.current === 'address' && row2.mailbox_at && !row2.address_at, row2);
  await address(U.fresh); await athlete(U.fresh);
  const s3 = await AS.state(P(), U.fresh);
  const row3 = (await P().query(`SELECT * FROM agent_setup WHERE user_id = $1`, [U.fresh])).rows[0];
  ok('  all three: finished, every step and the finish stamped', !s3.required && s3.why === 'finished' && row3.address_at && row3.athlete_at && row3.done_at, { s3, row3 });
  await P().query(`DELETE FROM email_accounts WHERE user_id = $1`, [U.fresh]);
  ok('  a later disconnect does not bring the setup back', !(await AS.state(P(), U.fresh)).required);
  ok('an agent who has sent an email: not required, and no row written for them',
    !(await AS.state(P(), U.sent)).required && (await P().query(`SELECT COUNT(*)::int n FROM agent_setup WHERE user_id = $1`, [U.sent])).rows[0].n === 0);
  off();

  // ── 3. LINKS: 30 DAYS, AND NEVER A DEAD END ──────────────────────────────
  OUT.push('', '-- invite links --');
  ok('off: a new agent\'s invite lasts 7 days, as before', PR.agentInviteTtlMs() === 7 * DAY);
  on();
  ok('on: 30 days', PR.agentInviteTtlMs() === 30 * DAY);
  const issue = async (email, ttl) => (await PR.issueResetToken(P(), { email, ttlMs: ttl })).token;
  const tValid = await issue(EMAIL(U.fresh), DAY);
  ok('a working link reads "valid"', (await PR.linkStatus(P(), tValid)).state === 'valid');
  await P().query(`UPDATE password_resets SET expires_at = NOW() - INTERVAL '1 day', created_at = NOW() - INTERVAL '40 days' WHERE token_hash = $1`, [PR.hashToken(tValid)]);
  ok('  an expired one reads "expired"; a made-up one "unknown"', (await PR.linkStatus(P(), tValid)).state === 'expired' && (await PR.linkStatus(P(), 'ab'.repeat(32))).state === 'unknown');
  await mkUser(U.ready, 'agent');   // never logged in
  const tOld = await issue(EMAIL(U.ready), DAY);
  await P().query(`UPDATE password_resets SET expires_at = NOW() - INTERVAL '1 day', created_at = NOW() - INTERVAL '10 days' WHERE token_hash = $1`, [PR.hashToken(tOld)]);
  const mails = [];
  const rs = await PR.resendFor({ pool: P(), token: tOld, appUrl: 'https://mynildash.com', findUser: (e) => store.getUserByEmail(e), sendMail: async (m) => { mails.push(m); } });
  const fresh = (String((mails[0] || {}).text || '').match(/reset\?token=([a-f0-9]{64})/) || [])[1];
  const freshRow = fresh && (await P().query(`SELECT expires_at, used FROM password_resets WHERE token_hash = $1`, [PR.hashToken(fresh)])).rows[0];
  ok('"Send me a new link" on an expired link: a fresh one goes to the same address', rs.sent && mails.length === 1 && mails[0].to === EMAIL(U.ready) && fresh && freshRow && !freshRow.used, { rs, mails: mails.map((m) => m.to) });
  ok('  someone who never signed in gets a login link that lasts 30 days, in plain words', (new Date(freshRow.expires_at) - Date.now()) / DAY > 29.9
    && mails[0].subject === 'Your NILDash login link' && /set up and waiting/.test(mails[0].text), mails[0] && mails[0].subject);
  const rs2 = await PR.resendFor({ pool: P(), token: tOld, appUrl: 'https://mynildash.com', findUser: (e) => store.getUserByEmail(e), sendMail: async (m) => { mails.push(m); } });
  ok('  pressed twice in a row: one email, not two', !rs2.sent && rs2.reason === 'just_sent' && mails.length === 1, rs2);
  const rs3 = await PR.resendFor({ pool: P(), token: 'cd'.repeat(32), appUrl: 'x', findUser: (e) => store.getUserByEmail(e), sendMail: async (m) => { mails.push(m); } });
  ok('  a link we never issued sends nothing (and the page says the same either way)', !rs3.sent && mails.length === 1);
  off();

  // ── 4. THE FUNNEL ────────────────────────────────────────────────────────
  OUT.push('', '-- onboarding-funnel --');
  await mkUser(U.funnel, 'agent', { created: new Date('2026-09-01T12:00:00Z'), login: new Date('2026-09-20T12:00:00Z'), firstLogin: new Date('2026-09-03T12:00:00Z') });
  await P().query(`INSERT INTO password_resets (email, token_hash, expires_at, used, created_at) VALUES ($1, 'as-f-1', NOW(), TRUE, '2026-09-01T13:00:00Z')`, [EMAIL(U.funnel)]);
  await mailbox(U.funnel);
  await P().query(`UPDATE email_accounts SET created_at = '2026-09-04T12:00:00Z' WHERE user_id = $1`, [U.funnel]);
  await P().query(`UPDATE users SET business_street = '1 Main St', business_city = 'Auburn', business_state = 'AL', business_zip = '36830', business_address_at = NULL WHERE id = $1`, [U.funnel]);
  const fr = await OF.run(P(), { agentId: U.funnel });
  const st = fr.agents[0].steps;
  ok('each step with the day it first happened', fr.agents.length === 1 && String(st.link.at.toISOString()).startsWith('2026-09-01')
    && String(st.login.at.toISOString()).startsWith('2026-09-03') && String(st.mailbox.at.toISOString()).startsWith('2026-09-04'), st);
  ok('  an address set before the stamp existed is "yes", not a made-up date', st.address.yes && !st.address.at && st.address.note === 'before tracking', st.address);
  ok('  not yet: athlete, approved, sent', !st.athlete.yes && !st.approved.yes && !st.sent.yes);
  const ft = OF.format(fr);
  ok('the printout: totals, and per agent the eight steps and the next one',
    /^ONBOARDING FUNNEL: 1 agent account/.test(ft) && /first email sent/.test(ft) && /created: 2026-09-01 · link sent: 2026-09-01 · first login: 2026-09-03 · mailbox connected: 2026-09-04 · address added: yes · first athlete: -/.test(ft)
    && /next step: first athlete/.test(ft), ft);
  const def = require(REPO + 'server/services/adminScripts.js').registry()['onboarding-funnel'];
  ok('  registered as an admin script', def && def.file === 'scripts/onboarding-funnel.js' && fs.existsSync(REPO + def.file) && JSON.stringify(def.args({ agent: 'a@b.com;x' })) === '["--agent","a@b.comx"]');

  // ── 5. THE WIRING ────────────────────────────────────────────────────────
  OUT.push('', '-- the wiring --');
  const idx = read('server/index.js');
  ok('sign-in stamps the first login', /UPDATE users SET last_login = NOW\(\), first_login_at = COALESCE\(first_login_at, NOW\(\)\) WHERE id = \$1', \[user\.id\]/.test(idx));
  ok('the comped-agent invite uses the 30-day lifetime under the switch, and its email says what to do when it runs out',
    /const inviteTtl = pwReset\.agentInviteTtlMs\(\);/.test(idx) && /open it anyway and press "Send me a new link"/.test(idx));
  const page = read('public/index.html');
  ok('Home asks for the setup before anything else is decided', /_setup = await fetch\(`\$\{API_BASE\}\/api\/agent\/setup`\)/.test(page) && /window\.agentSetup\.start\(_setup\)/.test(page)
    && /<script src="\/agent-setup\.js"><\/script>/.test(page));
  ok('  it replaces the 3-step wizard', /if \(window\.__agentSetup && window\.__agentSetup\.on\) return;/.test(page));
  ok('  and the assistant no longer takes over Home', /onboarding: currentUser\.role === 'agent' && currentUser\.athleteCount === 0 && !\(_setup && _setup\.on\)/.test(page));
  const js = read('public/agent-setup.js');
  ok('  no skip button anywhere in it', !/skip/i.test(js.replace(/\/\*[\s\S]*?\*\//, '').replace(/\/\/.*$/gm, '')));
  ok('  back from Google or Microsoft to the setup, not Settings', /returnTo=' \+ encodeURIComponent\('\/#setup'\)/.test(js)
    && /fromSetup && typeof window\.agentSetupRefresh === 'function'/.test(read('public/email.js')));
  ok('the reset page shows one button for a link that ran out', /Send me a new link/.test(read('public/reset.html')) && /api\/auth\/reset-status/.test(read('public/reset.html')));

  // ── 6. THE REAL SERVER, AND THE REAL PAGE ────────────────────────────────
  OUT.push('', '-- the real server and page (AGENT_SETUP_ON=1) --');
  await mkUser(U.browser, 'agent', { name: 'Bea Browser' });
  await mkUser(U.admin, 'admin');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'setup-test', AGENT_SETUP_ON: '1',
      ADMIN_EMAIL: EMAIL(U.admin), FOUNDER_EMAILS: '', RESEND_API_KEY: process.env.RESEND_API_KEY || 're_test_dummy', DATABASE_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let srvErr = ''; srv.stderr.on('data', (d) => { srvErr = (srvErr + d).slice(-3000); });
  let browser = null;
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/privacy')).ok; } catch (_) {} if (!up) await new Promise((r) => setTimeout(r, 1000)); }
    ok('the server boots', up, srvErr.slice(-400));
    const lr = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL(U.browser), password: PASS }) });
    const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
    const call = async (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    await new Promise((r) => setTimeout(r, 300));
    ok('signing in stamps the first login', !!(await P().query(`SELECT first_login_at FROM users WHERE id = $1`, [U.browser])).rows[0].first_login_at);
    const sj = await (await call('/api/agent/setup')).json();
    ok('GET /api/agent/setup: required, at the email step, "0 of 3 done"', sj.on && sj.required && sj.current === 'mailbox' && sj.progress === '0 of 3 done', sj);
    const rc = await call('/reconnect-mailbox?provider=gmail&back=setup');
    ok('the connect link goes straight to Google and back to the setup', rc.status === 302 && rc.headers.get('location') === '/api/email/oauth/gmail?returnTo=%2F%23setup', [rc.status, rc.headers.get('location')]);
    const rc0 = await fetch(base + '/reconnect-mailbox?provider=outlook&back=setup', { redirect: 'manual' });
    ok('  signed out, it signs in first and comes back to it', /^\/\?next=%2Freconnect-mailbox%3Fprovider%3Doutlook%26back%3Dsetup$/.test(rc0.headers.get('location') || ''), rc0.headers.get('location'));
    const cm = await fetch(base + '/connect-mailbox');
    const cmh = await cm.text();
    ok('/connect-mailbox: one page, Gmail or Outlook', cm.ok && /Connect Gmail/.test(cmh) && /Connect Outlook/.test(cmh) && /provider=gmail&back=setup/.test(cmh));
    const sf = await (await call('/api/agent/sign-first-name', { method: 'POST', body: JSON.stringify({ signFirstName: 'JohnMark' }) })).json();
    const sg = await (await call('/api/agent/signature')).json();
    ok('Settings: "First name for sign-offs" saves exactly as typed', sf.ok && sf.signFirstName === 'JohnMark' && sg.signFirstName === 'JohnMark', [sf, sg.signFirstName]);
    const bad = await call('/api/agent/sign-first-name', { method: 'POST', body: JSON.stringify({ signFirstName: 'jm@x.com' }) });
    const after = await (await call('/api/agent/signature')).json();
    ok('  an address is refused in plain words, not "cleaned" into a name, and the saved one is kept', bad.status === 400 && after.signFirstName === 'JohnMark', [bad.status, after.signFirstName]);
    const tExp = await issue(EMAIL(U.ready), DAY);
    await P().query(`UPDATE password_resets SET expires_at = NOW() - INTERVAL '1 hour' WHERE token_hash = $1`, [PR.hashToken(tExp)]);
    const rst = await (await fetch(base + '/api/auth/reset-status?token=' + tExp)).json();
    ok('GET /api/auth/reset-status: an expired link says so before anyone types a password', rst.on === true && rst.state === 'expired', rst);

    // The page itself.
    let pw = null;
    try { pw = require(_tp.join(execSync('npm root -g').toString().trim(), 'playwright')); } catch (_) { pw = null; }
    if (!pw) { OUT.push('SKIP the browser walk-through: Playwright is not installed here'); return; }
    try { browser = await pw.chromium.launch(); }
    catch (_) { browser = await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => null); }
    if (!browser) { OUT.push('SKIP the browser walk-through: no Chromium'); return; }
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: base }]);
    const pg = await ctx.newPage();
    pg.on('pageerror', () => {});
    await pg.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await pg.goto(base + '/', { waitUntil: 'domcontentloaded' });
    const shown = async () => pg.evaluate(() => { const e = document.getElementById('agentSetup'); return !!(e && e.style.display === 'block'); });
    const text = async () => pg.evaluate(() => (document.getElementById('agentSetup') || {}).innerText || '');
    await pg.waitForFunction(() => { const e = document.getElementById('agentSetup'); return e && e.style.display === 'block'; }, null, { timeout: 30000 }).catch(() => {});
    const t1 = await text();
    ok('THE PAGE: before Home, "Connect your email", "0 of 3 done", Gmail or Outlook', await shown() && /Connect your email/.test(t1) && /0 of 3 done/.test(t1) && /Connect Gmail/.test(t1) && /Connect Outlook/.test(t1), t1.slice(0, 300));
    ok('  the old wizard is not shown, and the assistant has not taken over Home', await pg.evaluate(() => {
      const w = document.getElementById('onboardingOverlay');
      return !(w && getComputedStyle(w).display !== 'none') && !document.body.classList.contains('na-onboarding');
    }));
    ok('  fits a phone: no sideways scroll', await pg.evaluate(() => document.getElementById('agentSetup').scrollWidth <= window.innerWidth + 1));
    // Back from Google (the connect itself is the provider's page).
    await mailbox(U.browser);
    // THE RACE THAT WIPED A TYPED ADDRESS. Coming back from the provider draws
    // the step at boot, and again when the "connected" marker asks the server;
    // that second answer is held back here so it lands while the agent is
    // typing. The saved-address prefill is held back too, carrying a stale
    // street. And the agent types slowly, one key at a time, as a person does.
    let setupCalls = 0, prefills = 0;
    const setupRoute = async (route) => { setupCalls++; if (setupCalls === 2) await new Promise((r) => setTimeout(r, 1500)); await route.continue(); };
    const addrRoute = async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      prefills++;
      await new Promise((r) => setTimeout(r, 2500));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ street: '9 Old Rd', city: '', state: '', zip: '', set: false, needed: true }) });
    };
    await pg.route('**/api/agent/setup', setupRoute);
    await pg.route('**/api/agent/business-address', addrRoute);
    // The provider's redirect is a full page load, not a hash change.
    await pg.goto('about:blank');
    await pg.goto(base + '/#setup?emailConnected=gmail', { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => /Your business address/.test((document.getElementById('agentSetup') || {}).innerText || ''), null, { timeout: 30000 }).catch(() => {});
    const t2 = await text();
    ok('back from the provider: the address step, "1 of 3 done" (it resumes where they were)', /Your business address/.test(t2) && /1 of 3 done/.test(t2), t2.slice(0, 200));
    const slow = { delay: 90 };
    const typeInto = async (sel, v) => { await pg.click(sel); await pg.keyboard.type(v, slow); };
    const values = () => pg.evaluate(() => ['as-street', 'as-city', 'as-state', 'as-zip'].map((id) => (document.getElementById(id) || {}).value));
    await typeInto('#as-street', '1 Main St');
    await pg.evaluate(() => window.agentSetupRefresh());   // one more draw of the same step, mid-typing
    await typeInto('#as-city', 'Auburn');
    await typeInto('#as-state', 'AL');
    await typeInto('#as-zip', '3683');
    await pg.waitForTimeout(1500);                           // every held-back answer has landed by now
    const typed = await values();
    ok('TYPED SLOWLY THROUGH TWO LATE REDRAWS AND A LATE PREFILL: every field still holds what was typed',
      JSON.stringify(typed) === JSON.stringify(['1 Main St', 'Auburn', 'AL', '3683']), typed);
    ok('  the late answers really did arrive mid-typing (the race was run, not avoided)', setupCalls >= 3 && prefills >= 1, { setupCalls, prefills });
    await pg.click('#agentSetup >> text=Save and continue');
    await pg.waitForFunction(() => { const e = document.getElementById('as-err'); return e && e.style.display === 'block'; }, null, { timeout: 10000 }).catch(() => {});
    ok('  a bad ZIP is refused in plain words, and they stay on the step with what they typed', /ZIP is five digits/.test(await text())
      && !/all required/.test(await text()) && (await values())[0] === '1 Main St', [await text(), await values()]);
    await pg.click('#as-zip', { clickCount: 3 });
    await pg.keyboard.type('36830', slow);
    await pg.click('#agentSetup >> text=Save and continue');
    await pg.waitForFunction(() => /Add your athletes/.test((document.getElementById('agentSetup') || {}).innerText || ''), null, { timeout: 15000 }).catch(() => {});
    const t3 = await text();
    ok('  saved: the athlete step, "2 of 3 done", with the add form, the import and the assistant', /Add your athletes/.test(t3) && /2 of 3 done/.test(t3)
      && /Add an athlete/.test(t3) && /Import a roster/.test(t3) && /assistant/.test(t3), t3.slice(0, 300));
    const saved = (await P().query(`SELECT business_street, business_city, business_state, business_zip FROM users WHERE id = $1`, [U.browser])).rows[0];
    ok('  the account holds exactly what was typed, not the stale prefill', saved.business_street === '1 Main St' && saved.business_city === 'Auburn'
      && saved.business_state === 'AL' && saved.business_zip === '36830', saved);
    await pg.unroute('**/api/agent/setup', setupRoute);
    await pg.unroute('**/api/agent/business-address', addrRoute);
    await pg.click('#agentSetup >> text=Add an athlete');
    await pg.waitForTimeout(500);
    ok('"Add an athlete" opens the existing add-athlete form, the setup stepping aside', !(await shown())
      && await pg.evaluate(() => { const v = document.getElementById('view-add-athlete'); return !!(v && v.offsetParent !== null); }));
    await pg.evaluate(() => showView('home', document.getElementById('homeNavBtn')));
    await pg.waitForFunction(() => { const e = document.getElementById('agentSetup'); return e && e.style.display === 'block'; }, null, { timeout: 10000 }).catch(() => {});
    ok('  going to Home without adding one brings the setup back: the step cannot be skipped', await shown() && /Add your athletes/.test(await text()));
    await pg.click('#agentSetup >> text=Add an athlete');
    await athlete(U.browser);
    // The page checks back every few seconds while they are in the add form.
    let finished = null;
    for (let i = 0; i < 30 && !finished; i++) {
      finished = (await P().query(`SELECT done_at FROM agent_setup WHERE user_id = $1 AND done_at IS NOT NULL`, [U.browser])).rows[0] || null;
      if (!finished) await new Promise((r) => setTimeout(r, 500));
    }
    await pg.waitForFunction(() => { const v = document.getElementById('view-home'); return v && v.offsetParent !== null; }, null, { timeout: 10000 }).catch(() => {});
    ok('the athlete exists: the setup finishes on its own and Home is next', !!finished && !(await shown())
      && await pg.evaluate(() => { const v = document.getElementById('view-home'); return !!(v && v.offsetParent !== null); }));
    const done = (await P().query(`SELECT mailbox_at, address_at, athlete_at, done_at FROM agent_setup WHERE user_id = $1`, [U.browser])).rows[0];
    ok('  every step stamped, and the finish', done && done.mailbox_at && done.address_at && done.athlete_at && done.done_at, done);
    await pg.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(3000);
    ok('  signing in again goes straight to Home', !(await shown()));
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill('SIGTERM');
  }
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  off();
  try { await clean(); } catch (_) {}
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass}/${pass + F} passed`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
