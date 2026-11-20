'use strict';
// ── THE NEW LOOK REACHES EVERY AGENT PAGE (public/ui-v2.js) ──────────────────
//
//   node tests/v2places.js
//
// NIL Go and Gifts & Reports shipped after the redesign; the new sidebar hid
// their buttons and no tab row led to them. Now NIL Go is a tab on Pipeline and
// Gifts & reports a tab on Reports. Walked in a real browser as a signed-in agent.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('v2placestest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const net = require('net');
const { spawn, execSync } = require('child_process');
const bcrypt = require('bcryptjs');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const PASS = 'v2-places-1';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  await P.query(`INSERT INTO users (id, name, email, password, role, plan_tier, comped, created_at, last_login, first_login_at)
    VALUES ('v2p-agent', 'Avery Places', 'v2p@places.test', $1, 'agent', 'unlimited', TRUE, NOW(), NOW(), NOW())`, [await bcrypt.hash(PASS, 6)]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('v2p-ath', 'v2p-agent', '{"name":"Tess Court","school":"Auburn University","sport":"Tennis"}'::jsonb)`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'v2p-test', CYPRESS_SEED_ON_BOOT: 'off', UNIVERSITY_NIGHTLY: 'off',
      PORTAL_ROSTER_SWEEP: 'off', PAYING_BRANDS_OFF: '1', AGENT_SETUP_ON: '', RESEND_API_KEY: 're_test_dummy', DATABASE_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let srvErr = ''; srv.stderr.on('data', (d) => { srvErr = (srvErr + d).slice(-3000); });
  let browser = null;
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/privacy')).ok; } catch (_) {} if (!up) await new Promise((r) => setTimeout(r, 1000)); }
    ok('the server boots', up, srvErr.slice(-400));
    const lr = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'v2p@places.test', password: PASS }) });
    const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
    ok('the agent signs in', lr.ok && !!cookie);

    let pw = null;
    try { pw = require('playwright'); } catch (_) { try { pw = require(_tp.join(execSync('npm root -g').toString().trim(), 'playwright')); } catch (__) { pw = null; } }
    if (!pw) { OUT.push('SKIP the browser walk-through: Playwright is not installed here'); return; }
    browser = await pw.chromium.launch().catch(() => null);
    if (!browser) { OUT.push('SKIP the browser walk-through: no Chromium'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: base }]);
    const pg = await ctx.newPage();
    pg.on('pageerror', () => {});
    await pg.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await pg.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => document.documentElement.getAttribute('data-ui') === 'v2' && document.querySelector('.sidebar-nav .nav-item[data-v2]'), null, { timeout: 30000 }).catch(() => {});
    const side = await pg.evaluate(() => Array.from(document.querySelectorAll('.sidebar-nav .nav-item')).filter((n) => !n.classList.contains('v2-hide') && n.offsetParent !== null).map((n) => n.textContent.trim()));
    ok('the new sidebar is built', side.includes('Pipeline') && side.includes('Reports'), side);
    // The app's own first load ends on Home; let it settle before clicking.
    await pg.waitForLoadState('networkidle').catch(() => {});
    await pg.waitForTimeout(1500);

    const tabsOn = async (navLabel) => {
      await pg.evaluate((l) => { const b = Array.from(document.querySelectorAll('.sidebar-nav .nav-item')).find((n) => n.textContent.trim() === l); if (b) b.click(); }, navLabel);
      await pg.waitForTimeout(400);
      return pg.evaluate(() => Array.from(document.querySelectorAll('#v2Tabs button')).map((b) => b.textContent.trim()));
    };
    const clickTab = async (label) => {
      await pg.evaluate((l) => { const b = Array.from(document.querySelectorAll('#v2Tabs button')).find((x) => x.textContent.trim() === l); if (b) b.click(); }, label);
      await pg.waitForTimeout(400);
    };
    const active = () => pg.evaluate(() => { const v = document.querySelector('.view.active'); return v ? v.id : null; });

    const pt = await tabsOn('Pipeline');
    ok('Pipeline shows two tabs: Pipeline and NIL Go', JSON.stringify(pt) === '["Pipeline","NIL Go"]', pt);
    await clickTab('NIL Go');
    ok('  NIL Go opens its page, with the tab row still there', (await active()) === 'view-nilgo'
      && JSON.stringify(await pg.evaluate(() => Array.from(document.querySelectorAll('#v2Tabs button')).map((b) => b.textContent.trim()))) === '["Pipeline","NIL Go"]', await active());
    ok('  Pipeline stays lit in the sidebar', await pg.evaluate(() => { const a = document.querySelector('.sidebar-nav .nav-item.active'); return !!a && a.textContent.trim() === 'Pipeline'; }));

    const rt = await tabsOn('Reports');
    ok('Reports shows Overview, Commission and Gifts & reports', JSON.stringify(rt) === '["Overview","Commission","Gifts & reports"]', rt);
    await clickTab('Gifts & reports');
    ok('  Gifts & reports opens its page', (await active()) === 'view-gifts', await active());
    ok('  the page title says where you are', await pg.evaluate(() => (document.getElementById('breadcrumb') || {}).textContent === 'Gifts & reports'));
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
}
main().then(() => { console.log(OUT.join('\n')); console.log(`\n${OUT.length - F}/${OUT.length} passed`); process.exit(F ? 1 : 0); })
  .catch((e) => { console.log(OUT.join('\n')); console.error(e); process.exit(1); });
