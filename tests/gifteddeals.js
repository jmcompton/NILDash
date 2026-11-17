'use strict';
// Runs against the local test Postgres and boots the real server.
//
//   node tests/gifteddeals.js
//
// ── GIFTED DEALS AND THE ATHLETE'S NIL REPORT (services/giftedDeals) ─────────
// Log product an athlete was sent to post; a monthly or yearly report per
// athlete with cash deals and gifts, totals, and businesses at $600 or more.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('giftedtest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const PASS = 'gifts-pass-1';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  const GD = require(REPO + 'server/services/giftedDeals.js');
  await GD.ensureTables(P);
  const hash = await bcrypt.hash(PASS, 8);
  await P.query(`INSERT INTO users (id, name, email, password, role, comped) VALUES ('gd-a','Avery Stone','avery@gd.test',$1,'agent',TRUE), ('gd-b','Blair Other','blair@gd.test',$1,'agent',TRUE)`, [hash]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('gd-1','gd-a','{"name":"Jordan Lake","school":"Pinecrest High","sport":"Volleyball"}'::jsonb), ('gd-2','gd-b','{"name":"Other Kid"}'::jsonb)`);

  ok('periods: a year and a month', JSON.stringify(GD.periodOf('2026')) === JSON.stringify({ kind: 'year', label: '2026', start: '2026-01-01', end: '2027-01-01' })
    && GD.periodOf('2026-12').end === '2027-01-01' && GD.periodOf('2026-11').label === 'November 2026' && GD.periodOf('2026-13') === null && GD.periodOf('nov') === null);

  const g1 = await GD.add(P, 'gd-a', { athleteId: 'gd-1', brand: 'Lola Blankets', product: 'Throw blanket', retailValue: '$180', receivedOn: '2026-11-03', platform: 'instagram story', posted: 'Story unboxing', postUrl: 'instagram.com/stories/x' });
  ok('log a gift: brand, product, value, where it was posted, a link made whole', g1.ok && g1.gift.retailValue === 180 && g1.gift.platform === 'instagram story' && g1.gift.postUrl === 'https://instagram.com/stories/x', g1);
  await GD.add(P, 'gd-a', { athleteId: 'gd-1', brand: 'Lola Blankets', product: 'Two more', retailValue: 450, receivedOn: '2026-11-20' });
  await GD.add(P, 'gd-a', { athleteId: 'gd-1', brand: 'Glow Drinks', receivedOn: '2026-10-02' });
  await GD.add(P, 'gd-a', { athleteId: 'gd-1', brand: 'Last Year Co', retailValue: 50, receivedOn: '2025-12-30' });
  ok('refused: another agent\'s athlete, no brand, a bad value, a bad date, an unknown platform',
    (await GD.add(P, 'gd-a', { athleteId: 'gd-2', brand: 'X Co' })).status === 404 && (await GD.add(P, 'gd-a', { athleteId: 'gd-1', brand: '' })).status === 400
    && (await GD.add(P, 'gd-a', { athleteId: 'gd-1', brand: 'X Co', retailValue: 'free' })).status === 400 && (await GD.add(P, 'gd-a', { athleteId: 'gd-1', brand: 'X Co', receivedOn: 'yesterday' })).status === 400
    && (await GD.add(P, 'gd-a', { athleteId: 'gd-1', brand: 'X Co', platform: 'myspace' })).status === 400);

  // Cash: a logged deal (with its Pipeline row's received amount), a signed Pipeline deal never logged, and an unsigned one.
  const d1 = (await P.query(`INSERT INTO athlete_self_deals (athlete_id, agent_id, brand_name, value, amount_received) VALUES ('gd-1','gd-a','Pinecrest Ford',500,500) RETURNING id`)).rows[0].id;
  await P.query(`INSERT INTO deal_outcomes (agent_id, athlete_id, deal_id, brand, deal_value, deliverable, closed_at) VALUES ('gd-a','gd-1',$1,'Pinecrest Ford',500,'2 posts','2026-11-05')`, [String(d1)]);
  await P.query(`ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS crm_stage TEXT`); await P.query(`ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS crm_stage_at TIMESTAMPTZ`);
  await P.query(`INSERT INTO athlete_self_deals (athlete_id, agent_id, brand_name, value, crm_stage, crm_stage_at, deliverables) VALUES ('gd-1','gd-a','Bean There',250,'contract_signed','2026-11-12','1 reel')`);
  await P.query(`INSERT INTO athlete_self_deals (athlete_id, agent_id, brand_name, value, crm_stage, crm_stage_at) VALUES ('gd-1','gd-a','Not Yet',900,'replied','2026-11-12')`);

  const nov = await GD.report(P, 'gd-a', 'gd-1', '2026-11');
  ok('November: two cash deals (logged and signed), the unsigned one left out', nov.cash.length === 2 && nov.cash.map((c) => c.brand).join(',') === 'Pinecrest Ford,Bean There', nov.cash);
  ok('  two gifts, totals for signed, received and gift value', nov.gifts.length === 2 && nov.totals.cashSigned === 750 && nov.totals.cashReceived === 500 && nov.totals.giftedValue === 630, nov.totals);
  ok('  a business at $600 or more counts gifts too (Lola Blankets 180 + 450)', JSON.stringify(nov.overThreshold) === JSON.stringify([{ brand: 'Lola Blankets', total: 630 }]), nov.overThreshold);
  const yr = await GD.report(P, 'gd-a', 'gd-1', '2026');
  ok('the year: October\'s unvalued gift in, last December\'s out, and the unvalued one counted', yr.gifts.length === 3 && yr.totals.unvaluedGifts === 1 && !yr.gifts.some((g) => g.brand === 'Last Year Co'), yr.totals);
  ok('another agent\'s athlete: nothing', (await GD.report(P, 'gd-b', 'gd-1', '2026')) === null);
  const html = GD.renderHtml(nov);
  ok('the printable page: the athlete, the period, both tables, and the plain note', /Jordan Lake: NIL report/.test(html) && /November 2026/.test(html) && /Lola Blankets/.test(html) && /Pinecrest Ford/.test(html)
    && /not tax or eligibility advice/.test(html) && /compliance office/.test(html) && /Print or save as PDF/.test(html));

  // ── THE REAL SERVER ────────────────────────────────────────────────────
  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'gifts-test', CYPRESS_SEED_ON_BOOT: 'off', UNIVERSITY_NIGHTLY: 'off', PORTAL_ROSTER_SWEEP: 'off', RESEND_API_KEY: 're_test_dummy', DATABASE_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let srvErr = ''; srv.stderr.on('data', (x) => { srvErr = (srvErr + x).slice(-3000); });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (m, p, body) => { const r = await fetch(base + p, { method: m, redirect: 'manual', headers: Object.assign(cookie ? { Cookie: cookie } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return r; };
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/privacy')).ok; } catch (_) {} if (!up) await new Promise((x) => setTimeout(x, 1000)); }
    ok('the server boots', up, srvErr.slice(-400));
    ok('signed out: 401', (await call('GET', '/api/gifts')).status === 401);
    await call('POST', '/api/auth/login', { email: 'avery@gd.test', password: PASS });
    const added = await (await call('POST', '/api/gifts', { athleteId: 'gd-1', brand: 'Snack Box', retailValue: 40, receivedOn: '2026-11-15' })).json();
    ok('POST /api/gifts saves one', added.ok && added.gift.brand === 'Snack Box');
    const list = await (await call('GET', '/api/gifts?athleteId=gd-1')).json();
    ok('GET /api/gifts lists the athlete\'s gifts, newest first', list.gifts.length === 5 && list.gifts[0].brand === 'Lola Blankets' && list.gifts[0].receivedOn === '2026-11-20', list.gifts.map((g) => g.receivedOn));
    ok('DELETE removes your own', (await call('DELETE', '/api/gifts/' + added.gift.id)).status === 200 && (await call('DELETE', '/api/gifts/' + added.gift.id)).status === 404);
    const page = await call('GET', '/api/nil-report/gd-1?period=2026-11&format=html');
    ok('the report page, printable', page.status === 200 && /text\/html/.test(page.headers.get('content-type')) && /Jordan Lake: NIL report/.test(await page.text()));
    ok('  JSON too; a bad period is refused; another agent\'s athlete is not found', (await (await call('GET', '/api/nil-report/gd-1?period=2026')).json()).totals.gifts === 3
      && (await call('GET', '/api/nil-report/gd-1?period=soon')).status === 400 && (await call('GET', '/api/nil-report/gd-2?period=2026')).status === 404);
  } finally { srv.kill(); }

  const idx = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('the Gifts & Reports tab: nav, view, loader, and the Open report button', /showView\('gifts',this\)/.test(idx) && /id="view-gifts"/.test(idx) && /if \(id === 'gifts'\) gfInit\(\);/.test(idx) && /onclick="gfOpenReport\(\)"/.test(idx));
  ok('no em dashes in the new copy', !/—/.test(fs.readFileSync(REPO + 'server/services/giftedDeals.js', 'utf8').replace(/\/\/.*$/gm, '')));
  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.log(OUT.join('\n')); console.error(e); process.exit(1); });
