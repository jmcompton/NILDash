'use strict';
// Runs against the local test Postgres. No network.
//
//   node tests/run.js                every suite, against the committed baseline
//   node tests/universityportal.js   just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE UNIVERSITY PORTAL, FIRST SLICE ──────────────────────────────────────
// Migration 013, the Cypress seed, the two scoped read APIs and the page at
// /university. The APIs are the REAL route code lifted out of server/index.js
// and served by a small express app, so what is tested is what ships: they
// refuse no session, refuse an agent, and cannot return another university's
// rows however the request is written.
const fs = require('fs');
const http = require('http');
const { execSync } = require('child_process');
const express = require('express');
const store = require(REPO + 'server/store.js');
const Seed = require(REPO + 'scripts/seed-cypress.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');
const IDX = read('server/index.js');
const MIG = read('server/migrations/013_university_teams_inventory.sql');

const OTHER = 'univ-test-other';
const U = { cyp: 'ut-cyp-ad', other: 'ut-other-ad', agent: 'ut-agent', unlinked: 'ut-unlinked', admin: 'ut-admin' };

// The route block, exactly as it is in index.js, mounted on a test app.
function liftRoutes() {
  const a = IDX.indexOf('// ── The university portal: teams and inventory (public/university.html)');
  const b = IDX.indexOf("app.get('/api/university/inventory'", a);
  const end = IDX.indexOf('\n});\n', b) + 5;
  if (a < 0 || b < 0) throw new Error('the university portal routes are not in server/index.js');
  return IDX.slice(a, end);
}
function liftFn(name) {
  const s = IDX.indexOf('function ' + name);
  const e = IDX.indexOf('\n}\n', s) + 2;
  return IDX.slice(IDX.lastIndexOf('\n', s) + 1, e);
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  // ── 1. THE MIGRATION ──────────────────────────────────────────────────────
  OUT.push('-- migration 013 --');
  const stmts = MIG.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
  ok('every statement is IF NOT EXISTS', stmts.every((s) => /^CREATE (TABLE|INDEX) IF NOT EXISTS /i.test(s)), stmts.map((s) => s.slice(0, 50)));
  let twice = true;
  for (let i = 0; i < 2; i++) for (const s of stmts) { try { await P.query(s); } catch (e) { twice = false; OUT.push('  ' + e.message); } }
  ok('  and it runs twice without an error', twice);
  const cols = async (t) => (await P.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`, [t])).rows.map((r) => r.column_name);
  ok('university_teams has the specified columns',
    JSON.stringify(await cols('university_teams')) === JSON.stringify(['id', 'university_id', 'name', 'sport', 'season', 'roster_size', 'venue', 'home_dates', 'market_key', 'created_at', 'updated_at']),
    await cols('university_teams'));
  ok('university_inventory has the specified columns',
    JSON.stringify(await cols('university_inventory')) === JSON.stringify(['id', 'university_id', 'team_id', 'name', 'price_cents', 'status', 'created_at', 'updated_at']),
    await cols('university_inventory'));
  const idx = (await P.query(`SELECT indexname FROM pg_indexes WHERE tablename IN ('university_teams','university_inventory')`)).rows.map((r) => r.indexname);
  ok('  indexed on university_id (both) and team_id', ['university_teams_university_id_idx', 'university_inventory_university_id_idx', 'university_inventory_team_id_idx'].every((i) => idx.includes(i)), idx);
  let badSeason = false;
  try { await P.query(`INSERT INTO university_teams (id, university_id, name, season) VALUES ('ut-bad','x','x','Summer')`); } catch (_) { badSeason = true; }
  let badStatus = false;
  try { await P.query(`INSERT INTO university_inventory (id, university_id, name, price_cents, status) VALUES ('ut-bad','x','x',1,'gone')`); } catch (_) { badStatus = true; }
  ok('  a season or a status outside the list is refused', badSeason && badStatus);

  // ── 2. ISOLATION (migrations/007) ─────────────────────────────────────────
  OUT.push('', '-- isolation --');
  const SEED = read('scripts/seed-cypress.js'), SVC = read('server/services/universityPortal.js');
  const writesAgent = /(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE)\s+(athletes|users|outreach_\w+|deals)\b/i;
  ok('the migration, the seed and the service never write an agent table',
    !writesAgent.test(MIG) && !writesAgent.test(SEED) && !writesAgent.test(SVC));
  ok('  and add no university column to one', !/ALTER TABLE\s+(athletes|users)/i.test(MIG));
  ok('  and the service reads only university tables',
    (SVC.match(/(FROM|JOIN)\s+(\w+)/g) || []).every((m) => /(university_teams|university_inventory|universities)$/.test(m)), SVC.match(/(FROM|JOIN)\s+(\w+)/g));

  // ── 3. THE SEED ───────────────────────────────────────────────────────────
  OUT.push('', '-- seed-cypress --');
  const clean = async () => {
    await P.query(`DELETE FROM university_inventory WHERE university_id IN ('univ-cypress', $1) OR id = 'ut-bad'`, [OTHER]).catch(() => {});
    await P.query(`DELETE FROM university_teams WHERE university_id IN ('univ-cypress', $1) OR id = 'ut-bad'`, [OTHER]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id = ANY($1)`, [Object.values(U)]).catch(() => {});
  };
  await clean();
  const athletesBefore = (await P.query(`SELECT COUNT(*)::int n FROM athletes`)).rows[0].n;
  const r1 = await Seed.seed(P);
  const r2 = await Seed.seed(P);
  // The AD's confirmed list (seed-cypress CONFIRMED_TEAMS): 14 teams, 65 items.
  ok('the first run writes the 14 confirmed teams and 65 items', r1.teams === 14 && r1.inventory === 65, r1);
  ok('  the second run writes nothing', r2.university === 0 && r2.teams === 0 && r2.inventory === 0, r2);
  ok('  and the agent athletes table is untouched', (await P.query(`SELECT COUNT(*)::int n FROM athletes`)).rows[0].n === athletesBefore);
  const uni = (await P.query(`SELECT name, location FROM universities WHERE id = 'univ-cypress'`)).rows[0];
  ok('Cypress College, 9200 Valley View St, Cypress, CA 90630', uni && uni.name === 'Cypress College' && uni.location === '9200 Valley View St, Cypress, CA 90630', uni);

  // Every value against the demo, read independently of the seed's reader.
  const html = read('public/athletics.html');
  // The TEAM LIST is the AD's (Seed.CONFIRMED_TEAMS); the demo still supplies
  // season, venue, roster and inventory for the teams it had.
  const A = Seed.liftConst(html, 'ASSETS'), D = Seed.liftConst(html, 'DEPT_ASSETS');
  const T = Seed.readDemo().teams.map((t) => ({ id: t.id.replace('univ-cypress:', ''), name: t.name, sport: t.sport, season: t.season,
    roster: t.roster_size, venue: t.venue, dates: t.home_dates, kind: (Seed.liftConst(html, 'TEAMS').find((x) => 'univ-cypress:' + x.id === t.id) || {}).kind
      || (Seed.CONFIRMED_TEAMS.find((c) => 'univ-cypress:' + c.id === t.id) || {}).kind }));
  const teams = (await P.query(`SELECT * FROM university_teams WHERE university_id = 'univ-cypress' ORDER BY id`)).rows;
  const byId = new Map(teams.map((t) => [t.id, t]));
  const teamMismatch = T.filter((t) => {
    const r = byId.get('univ-cypress:' + t.id);
    return !r || r.name !== t.name || r.sport !== t.sport || r.season !== t.season || r.roster_size !== t.roster
      || r.venue !== t.venue || r.home_dates !== t.dates;
  }).map((t) => t.id);
  ok('every team matches the confirmed list, with the demo\'s details where it had them', teams.length === T.length && teamMismatch.length === 0, teamMismatch);
  ok('  no football, no track, no golf; men\'s water polo and beach volleyball are there', !teams.some((t) => /football|track|golf/i.test(t.name + ' ' + t.sport))
    && teams.some((t) => t.name === "Men's Water Polo") && teams.some((t) => t.name === 'Beach Volleyball'), teams.map((t) => t.name));
  // A team that is not on the list (Men's Golf, from the demo) is removed with its work.
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport) VALUES ('univ-cypress:mgolf', 'univ-cypress', 'Men''s Golf', 'golf') ON CONFLICT DO NOTHING`);
  await P.query(`INSERT INTO university_inventory (id, university_id, team_id, name, price_cents) VALUES ('univ-cypress:mgolf:1', 'univ-cypress', 'univ-cypress:mgolf', 'Golf banner', 10000) ON CONFLICT DO NOTHING`);
  const r3 = await Seed.seed(P);
  ok('  a seeded Men\'s Golf is removed, with its items, and the run says so', JSON.stringify(r3.removed) === JSON.stringify(["Men's Golf"])
    && !(await P.query(`SELECT 1 FROM university_teams WHERE id = 'univ-cypress:mgolf'`)).rowCount
    && !(await P.query(`SELECT 1 FROM university_inventory WHERE team_id = 'univ-cypress:mgolf'`)).rowCount, r3);
  ok('  market_key is the agent-side key for the campus', teams.every((t) => t.market_key === require(REPO + 'server/services/regionKey.js').marketPoolKey('Cypress, CA')) && teams[0].market_key === 'cypress, ca', teams[0].market_key);
  const inv = (await P.query(`SELECT * FROM university_inventory WHERE university_id = 'univ-cypress'`)).rows;
  const want = [];
  T.forEach((t) => (A[t.kind] || []).forEach(([n, p]) => want.push(`univ-cypress:${t.id}|${n}|${p * 100}`)));
  D.forEach(([n, p]) => want.push(`null|${n}|${p * 100}`));
  const got = inv.map((i) => `${i.team_id}|${i.name}|${i.price_cents}`);
  ok('every item and price matches ASSETS and DEPT_ASSETS, in cents',
    want.length === got.length && want.slice().sort().join('\n') === got.slice().sort().join('\n'),
    want.filter((w) => !got.includes(w)).concat(got.filter((g) => !want.includes(g))));
  ok('  department-wide items have no team', inv.filter((i) => i.team_id === null).length === D.length);
  ok('  all available, $35,150 in all', inv.every((i) => i.status === 'available') && inv.reduce((s, i) => s + i.price_cents, 0) === 3515000);

  // A second university, to prove nobody sees it but its own.
  await P.query(`INSERT INTO universities (id, name, short_name) VALUES ($1, 'Other Test College', 'Other') ON CONFLICT (id) DO NOTHING`, [OTHER]);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, season, roster_size) VALUES ('ut-other:t1', $1, 'Other Rowing', 'rowing', 'Spring', 20)`, [OTHER]);
  await P.query(`INSERT INTO university_inventory (id, university_id, team_id, name, price_cents) VALUES ('ut-other:i1', $1, 'ut-other:t1', 'Other boathouse banner', 99900)`, [OTHER]);

  // ── 4. THE APIS ───────────────────────────────────────────────────────────
  OUT.push('', '-- GET /api/university/teams and /inventory --');
  const users = [
    [U.cyp, 'university', 'univ-cypress'], [U.other, 'university', OTHER],
    [U.agent, 'agent', null], [U.unlinked, 'university', null], [U.admin, 'admin', null],
  ];
  for (const [id, role, uid] of users) {
    await P.query(`INSERT INTO users (id, name, email, password, role, university_id) VALUES ($1,$1,$2,'x',$3,$4)`,
      [id, id + '@ut.test', role, uid]);
  }
  const app = express();
  app.use(express.json());
  // The session a signed-in user would carry, from a test header.
  app.use((req, res, next) => { req.session = {}; const who = req.get('x-test-user'); if (who) req.session.userId = who; next(); });
  const { requireUniversityMode } = require(REPO + 'server/middleware/modeGuard.js');
  new Function('app', 'store', 'require', 'requireUniversityMode',
    liftFn('requireAuth') + '\n' + liftFn('resolveSessionUniversity').replace(/^async /, 'async ') + '\n' + liftRoutes())(
    // The routes' own require('./services/...') resolves from server/, as in index.js.
    app, store, (m) => require(m.startsWith('./') ? REPO + 'server/' + m.slice(2) : m), requireUniversityMode);
  const server = http.createServer(app).listen(0);
  const port = server.address().port;
  const call = async (path, who, extra = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: Object.assign(who ? { 'x-test-user': who } : {}, extra.headers || {}),
      method: extra.method || 'GET', body: extra.body });
    let body = null; try { body = await r.json(); } catch (_) {}
    return { status: r.status, body };
  };
  try {
    for (const ep of ['/api/university/teams', '/api/university/inventory']) {
      const anon = await call(ep, null);
      ok(`${ep}: no session is refused (401)`, anon.status === 401, anon);
      const ag = await call(ep, U.agent);
      ok(`  an agent is refused (403)`, ag.status === 403 && ag.body.code === 'UNIVERSITY_ROLE_REQUIRED', ag);
      const un = await call(ep, U.unlinked);
      ok(`  a university account with no university is refused (403)`, un.status === 403 && un.body.code === 'NO_UNIVERSITY_LINKED', un);
      const ad = await call(ep, U.admin);
      ok(`  an admin with no university of their own gets none`, ad.status === 403, ad);
    }
    const t = await call('/api/university/teams', U.cyp);
    ok('Cypress sees its 14 teams, with each team\'s inventory total', t.status === 200 && t.body.teams.length === 14
      && t.body.university.name === 'Cypress College'
      && t.body.teams.find((x) => x.id === 'univ-cypress:mbb').inventory_cents === 315000, t.body && t.body.teams && t.body.teams.length);
    const i = await call('/api/university/inventory', U.cyp);
    ok('  and its 65 items', i.status === 200 && i.body.items.length === 65, i.body && i.body.items && i.body.items.length);
    const leak = (b) => JSON.stringify(b).includes(OTHER) || JSON.stringify(b).includes('ut-other') || JSON.stringify(b).includes('Other Rowing');
    ok('  and nothing of the other university\'s', !leak(t.body) && !leak(i.body));
    // Every way a request could try to name another university.
    const tries = [
      `/api/university/teams?university_id=${OTHER}`, `/api/university/inventory?university_id=${OTHER}`,
      `/api/university/teams?universityId=${OTHER}`, `/api/university/inventory?universityId=${OTHER}&team_id=ut-other:t1`,
    ];
    let leaked = [];
    for (const p of tries) { const r = await call(p, U.cyp); if (r.status !== 200 || leak(r.body)) leaked.push(p); }
    const post = await call('/api/university/inventory', U.cyp, { headers: { 'x-university-id': OTHER } });
    if (leak(post.body)) leaked.push('header');
    ok('a query string or header naming another university changes nothing', leaked.length === 0, leaked);
    const o = await call('/api/university/inventory', U.other);
    ok('the other university sees only its own one item', o.status === 200 && o.body.items.length === 1
      && o.body.items[0].name === 'Other boathouse banner' && !JSON.stringify(o.body).includes('univ-cypress'), o.body);
  } finally { server.close(); }

  // ── 5. THE PAGE AND THE ROUTE ─────────────────────────────────────────────
  OUT.push('', '-- /university --');
  const page = read('public/university.html');
  const cssOf = (h) => h.slice(h.indexOf('<style>'), h.indexOf('</style>') + 8);
  ok('the page\'s CSS is the demo\'s, byte for byte', cssOf(page) === cssOf(html));
  ok('  and its shell is the demo\'s: brand, nav, crumb, who', ['<nav class="side">', '<div class="eyebrow">UNIVERSITY PORTAL</div>',
    '<div class="eyebrow">ADMINISTRATION</div>', '<span class="ready"><i></i>AI READY</span>', '<div class="navwrap"><div class="navlist" id="nav1"></div></div>']
    .every((s) => page.includes(s) && html.includes(s)));
  ok('  the nav lists every demo item', /\["home","Home"\], \["scan","Sponsor Scan"\], \["teams","My Teams"\], \["inventory","Inventory"\]/.test(page)
    && /const NAV2 = \[\["compliance","Compliance"\], \["settings","Settings"\]\];/.test(page));
  ok('  only My Teams and Inventory do anything', /const LIVE = \{ teams:true, inventory:true \}/.test(page));
  ok('  it reads only its two APIs and signs in with the account login',
    (page.match(/\/api\/[a-z/_-]+/g) || []).every((u) => ['/api/university/teams', '/api/university/inventory', '/api/auth/login', '/api/auth/logout'].includes(u)),
    [...new Set(page.match(/\/api\/[a-z/_-]+/g))]);
  ok('  and never sends anyone to the agent app', !/location(\.href)?\s*=/.test(page) && !/href="\/"/.test(page));
  ok('it is not part of the agent app', !/university\.html/.test(read('public/index.html')));
  const route = IDX.match(/app\.get\('\/university',\s*([^\n]*)\n/);
  ok('GET /university has its own route with no auth in front of it', !!route && /^\(req, res\) => \{$/.test(route[1].trim()), route && route[0]);
  ok('  serving public/university.html, no-cache, above the app catch-all',
    /app\.get\('\/university', \(req, res\) => \{\s*res\.sendFile\(path\.join\(__dirname, '\.\.', 'public', 'university\.html'\),\s*\{ cacheControl: false, headers: \{ 'Cache-Control': DEMO_NO_CACHE \} \}\);/.test(IDX)
    && IDX.indexOf("app.get('/university',") < IDX.indexOf("app.get('*',"));

  // The page itself, in a browser, against the same answers the APIs give.
  let pw = null;
  try { pw = require(_tp.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright')); } catch (_) { pw = null; }
  if (!pw) OUT.push('SKIP the browser run: playwright is not installed globally on this machine');
  else {
    const teamsBody = (await P.query(`SELECT 1`)) && null;
    const b = await pw.chromium.launch();
    try {
      const fixture = { university: { id: 'univ-cypress', name: 'Cypress College' } };
      const svc = require(REPO + 'server/services/universityPortal.js');
      const T2 = await svc.listTeams(P, 'univ-cypress'), I2 = await svc.listInventory(P, 'univ-cypress');
      const mk = async (state) => {
        const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
        const p = await ctx.newPage();
        const errs = []; p.on('pageerror', (e) => errs.push(e.message));
        await p.route('**/*', (r) => {
          const u = new URL(r.request().url());
          if (u.hostname !== 'uni.test') return r.abort();
          if (u.pathname === '/university') return r.fulfill({ status: 200, contentType: 'text/html', body: page });
          if (u.pathname === '/api/auth/login') { state.signedIn = state.loginAs; return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); }
          if (u.pathname.startsWith('/api/university/')) {
            if (!state.signedIn) return r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Not authenticated"}' });
            if (state.signedIn === 'agent') return r.fulfill({ status: 403, contentType: 'application/json', body: '{"code":"UNIVERSITY_ROLE_REQUIRED"}' });
            return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(u.pathname.endsWith('teams') ? T2 : I2) });
          }
          return r.fulfill({ status: 404, body: '' });
        });
        await p.goto('http://uni.test/university'); await p.waitForTimeout(300);
        return { p, errs };
      };
      const s1 = { loginAs: 'cypress' };
      const { p, errs } = await mk(s1);
      ok('logged out: the sign-in screen, not a blank page and not the agent app',
        !!(await p.$('#loginForm')) && !(await p.$('.shell')) && p.url().endsWith('/university'));
      await p.fill('#lemail', 'ad@cypress.test'); await p.fill('#lpass', 'x'); await p.click('#lgo'); await p.waitForTimeout(400);
      ok('signed in: My Teams, from the API', (await p.textContent('#crumbNow')) === 'My Teams' && (await p.$$('.tablewrap tbody tr')).length === 14);
      ok('  the KPIs say 14 teams, 220 athletes, 138 home dates, $35,150 (golf removed; two new teams have no roster yet)',
        /TEAMS14nofootball/.test((await p.textContent('.kpi-grid')).replace(/\s+/g, '')) && /ATHLETES220/.test((await p.textContent('.kpi-grid')).replace(/\s+/g, ''))
        && /HOMEDATES138/.test((await p.textContent('.kpi-grid')).replace(/\s+/g, '')) && /\$35,150/.test(await p.textContent('.kpi-grid')), await p.textContent('.kpi-grid'));
      await p.click('[data-goto="inventory"]'); await p.waitForTimeout(150);
      ok('Inventory: 65 items', (await p.textContent('#crumbNow')) === 'Inventory' && (await p.$$('.tablewrap tbody tr')).length === 65);
      await p.click('[data-inv="Department"]'); await p.waitForTimeout(100);
      ok('  the Department filter shows the three department-wide items', (await p.$$('.tablewrap tbody tr')).length === 3);
      await p.click('#nav1 [aria-disabled="true"]', { force: true }); await p.waitForTimeout(100);
      ok('the other nav items are there and do nothing', (await p.$$('[aria-disabled="true"]')).length === 10 && (await p.textContent('#crumbNow')) === 'Inventory');
      ok('  and nothing threw', errs.length === 0, errs);
      const s2 = { loginAs: 'agent' };
      const q = await mk(s2);
      await q.p.fill('#lemail', 'agent@x.test'); await q.p.fill('#lpass', 'x'); await q.p.click('#lgo'); await q.p.waitForTimeout(300);
      ok('an agent who signs in here is told so and stays on the sign-in screen',
        /not a university account/.test(await q.p.textContent('#lerr')) && !(await q.p.$('.shell')));
      void fixture; void teamsBody;
    } finally { await b.close(); }
  }

  await P.query(`DELETE FROM university_inventory WHERE university_id = $1`, [OTHER]).catch(() => {});
  await P.query(`DELETE FROM university_teams WHERE university_id = $1`, [OTHER]).catch(() => {});
  await P.query(`DELETE FROM universities WHERE id = $1`, [OTHER]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id = ANY($1)`, [Object.values(U)]).catch(() => {});
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('universityportal: FAILED', e); process.exit(1); });
