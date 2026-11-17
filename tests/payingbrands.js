'use strict';
// Runs against the local test Postgres. Search and model are stubs; the
// server is booted once for the routes.
//
//   node tests/payingbrands.js
//
// ── BRANDS ALREADY PAYING ATHLETES (services/payingBrands) ──────────────────
// Public proof that a brand paid or partnered with an athlete, kept with the
// link. Brands and athletes are fictional; schools are real directory names
// so the state lookup works.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('payingbrandstest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const PASS = 'paying-pass-1';

const RESULTS = [
  { title: 'Troy softball star Jordan Lake signs NIL deal with Bluebird Smoothies', snippet: 'The Troy University pitcher will promote the smoothie shop.', url: 'https://localnews.example/2026/troy-jordan-lake-bluebird-smoothies' },
  { title: 'Jordan Lake on Instagram: "Love my new kicks from @peakgrip #ad" Troy Softball', snippet: '', url: 'https://www.instagram.com/p/AbC123/' },
  { title: 'Troy athletes partner with Trojan Collective', snippet: 'Collective announces Troy University roster deals.', url: 'https://collective.example/troy' },
  { title: 'Troy University NIL deal tracker | Opendorse', snippet: 'Troy NIL deals listed on Opendorse.', url: 'https://opendorse.example/troy' },
  { title: 'Troy football schedule 2026', snippet: 'Troy University game times.', url: 'https://troytrojans.example/schedule' },
  { title: 'Samford guard signs NIL deal with Iron Gym', snippet: 'Not about the school searched.', url: 'https://news.example/samford-iron-gym' },
];

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  const PB = require(REPO + 'server/services/payingBrands.js');
  await PB.ensureTables(P);

  const lines = PB.linesFrom(RESULTS, 'Troy University');
  ok('search lines: about this school and reading like a deal; the schedule and the other school left out', lines.length === 4 && !lines.some((l) => /schedule|Samford/.test(l.line)), lines.map((l) => l.line.slice(0, 60)));
  ok('refused: the school, a collective, an NIL platform, betting, media', PB.refused('Troy University', 'Troy University') && PB.refused('Trojan Collective', 'Troy University')
    && PB.refused('Opendorse', 'Troy University') && PB.refused('DraftKings', 'Troy University') && PB.refused('ESPN', 'Troy University') && PB.refused('Bluebird Smoothies', 'Troy University') === null);

  let saw = null;
  const chat = async (o) => { saw = o.messages[0].content; return { text: JSON.stringify({ deals: [
    { line: 1, brand: 'Bluebird Smoothies', athlete: 'Jordan Lake', sport: 'Softball' },
    { line: 2, brand: '@peakgrip', athlete: 'Jordan Lake', sport: 'softball' },
    { line: 3, brand: 'Trojan Collective', athlete: '', sport: '' },
    { line: 4, brand: 'Opendorse', athlete: '', sport: '' },
    { line: 1, brand: 'Made Up Brand', athlete: 'Nobody Here', sport: 'golf' },
    { line: 9, brand: 'Bluebird Smoothies', athlete: '', sport: '' }] }) }; };
  const searched = [];
  const search = async (q) => { searched.push(q); return RESULTS; };
  const r = await PB.refresh(P, 'Troy University', { search, chat });
  const proof = (await P.query(`SELECT b.brand, p.athlete, p.sport, p.kind, p.school_state, p.source_url FROM paying_brand_proof p JOIN paying_brands b USING (brand_key) ORDER BY b.brand`)).rows;
  ok('two searches per school, and the model saw numbered lines', searched.length === 2 && /^School: Troy University\n1\. /.test(saw || ''), searched);
  ok('kept: the announced deal and the paid post, each with its link, the athlete, the sport and the state',
    proof.length === 2 && proof[0].brand === '@peakgrip' && proof[0].kind === 'post' && proof[1].brand === 'Bluebird Smoothies' && proof[1].kind === 'announcement'
    && proof.every((x) => x.athlete === 'Jordan Lake' && x.sport === 'softball' && x.school_state === 'AL') && /localnews/.test(proof[1].source_url), proof);
  ok('  dropped: the collective, the platform, a brand not in its line, a line that does not exist', r.added === 2 && r.refused.length === 2 && r.found === 2, r);
  ok('read once per 30 days', (await PB.refresh(P, 'Troy University', { search, chat })).skipped === 'fresh' && searched.length === 2);
  const none = await PB.refresh(P, 'Samford University', { search: async () => [], chat });
  ok('nothing found: noted, nothing guessed', none.found === 0 && /no deal/.test(none.note), none);

  // Connected athletes' captions.
  ok('captions: a paid post names the brand by handle; the athlete, teams and unpaid posts are not brands',
    JSON.stringify(PB.brandsInCaption('Game day fuel from @cedarcoffeeco #ad @troysoftball @me_jordan', 'me_jordan')) === '["cedarcoffeeco"]'
    && PB.brandsInCaption('Great win with @teammate', 'x').length === 0 && JSON.stringify(PB.brandsInCaption('Use code JL10 at @peakgrip.', 'x')) === '["peakgrip"]');
  await require(REPO + 'server/services/instagramConnect.js').ensureTables(P);
  const hash = await bcrypt.hash(PASS, 8);
  await P.query(`INSERT INTO users (id, name, email, password, role, comped) VALUES ('pb-a','Avery Stone','avery@pb.test',$1,'agent',TRUE), ('pb-b','Blair Other','blair@pb.test',$1,'agent',TRUE)`, [hash]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('pb-1','pb-a','{"name":"Riley Moss","school":"University of South Alabama","sport":"Softball"}'::jsonb),
    ('pb-2','pb-b','{"name":"Other Kid","school":"Georgia Southern University","sport":"Softball"}'::jsonb)`);
  await P.query(`INSERT INTO instagram_stats (athlete_id, username, posts) VALUES ('pb-1','rileymoss', $1::jsonb)`,
    [JSON.stringify([{ permalink: 'https://www.instagram.com/p/Xyz/', caption: 'Thanks @cedarcoffeeco for the fuel #ad @southalabamasoftball' }, { permalink: 'https://www.instagram.com/p/Q/', caption: 'Team dinner with @friend' }])]);
  const c = await PB.fromConnected(P);
  const cp = (await P.query(`SELECT * FROM paying_brand_proof WHERE kind = 'connected'`)).rows;
  ok('connected athletes: the paid post is stored once, with the athlete, school and state', c.added === 1 && cp.length === 1 && cp[0].athlete === 'Riley Moss' && cp[0].school_state === 'AL'
    && (await PB.fromConnected(P)).added === 0, { c, cp });

  // Who gets them.
  const fa = await PB.forAthlete(P, { school: 'Samford University', sport: 'Softball' });
  ok('an agent\'s athlete: brands paying softball players in the same state, most athletes first', fa.state === 'AL' && fa.sport === 'softball'
    && fa.nearby.map((x) => x.brand).sort().join(',') === '@cedarcoffeeco,@peakgrip,Bluebird Smoothies' && fa.nearby.every((x) => x.proof.length >= 1 && x.proof[0].url), fa);
  const ga = await PB.forAthlete(P, { school: 'Georgia Southern University', sport: 'Softball' });
  ok('  another state: nothing nearby, the same sport elsewhere', ga.nearby.length === 0 && ga.elsewhere.length === 3, ga);
  const fs1 = await PB.forSchool(P, 'Troy University');
  ok('a school: brands paying at other schools in its state, not the ones already at it', fs1.state === 'AL' && fs1.brands.map((x) => x.brand).join(',') === '@cedarcoffeeco', fs1);
  ok('  a school with none of its own yet sees them all', (await PB.forSchool(P, 'Samford University')).brands.length === 3);

  const html = PB.renderHtml(await PB.overview(P));
  ok('the admin page: each brand, its proof link, and the schools read', /Bluebird Smoothies/.test(html) && /localnews\.example/.test(html) && /Troy University: 2 brands/.test(html) && !/<script/i.test(html), html.slice(-900));
  await P.query(`DELETE FROM paying_brand_runs`);
  await P.query(`INSERT INTO universities (id, name) VALUES ('u1','Georgia Southern University')`).catch(() => {});
  const due = await PB.dueSchools(P);
  ok('due: university accounts\' schools (agents\' schools need a send in 30 days)', due.includes('Georgia Southern University') && !due.includes('University of South Alabama'), due);
  process.env.PAYING_BRANDS_OFF = '1';
  ok('PAYING_BRANDS_OFF=1 stops the job', (await PB.tick(P)).skipped === 'off');
  delete process.env.PAYING_BRANDS_OFF;

  // ── THE REAL SERVER ────────────────────────────────────────────────────
  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'paying-test', CYPRESS_SEED_ON_BOOT: 'off', UNIVERSITY_NIGHTLY: 'off', PORTAL_ROSTER_SWEEP: 'off', PAYING_BRANDS_OFF: '1', RESEND_API_KEY: 're_test_dummy', DATABASE_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let srvErr = ''; srv.stderr.on('data', (x) => { srvErr = (srvErr + x).slice(-3000); });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (m, p, body) => { const rr = await fetch(base + p, { method: m, redirect: 'manual', headers: Object.assign(cookie ? { Cookie: cookie } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = rr.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return rr; };
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/privacy')).ok; } catch (_) {} if (!up) await new Promise((x) => setTimeout(x, 1000)); }
    ok('the server boots', up, srvErr.slice(-400));
    const so = [(await call('GET', '/api/paying-brands?athleteId=pb-1')).status, (await call('GET', '/admin/paying-brands')).status];
    ok('signed out: 401; the admin page is not public', so[0] === 401 && (so[1] === 401 || so[1] === 403), so);
    await call('POST', '/api/auth/login', { email: 'avery@pb.test', password: PASS });
    const got = await (await call('GET', '/api/paying-brands?athleteId=pb-1')).json();
    ok('the agent gets brands paying athletes like theirs', got.state === 'AL' && got.nearby.length === 3, got);
    ok('  another agent\'s athlete: 404; no athlete: 400', (await call('GET', '/api/paying-brands?athleteId=pb-2')).status === 404 && (await call('GET', '/api/paying-brands')).status === 400);
  } finally { srv.kill(); }

  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('wired: the daily job, the admin page, the refresh, the school view', /require\('\.\/services\/payingBrands'\)\.start\(store\.pool\)/.test(idx)
    && /app\.get\('\/admin\/paying-brands'/.test(idx) && /app\.post\('\/api\/admin\/paying-brands\/refresh'/.test(idx) && /app\.get\('\/api\/admin\/paying-brands\/school'/.test(idx));
  ok('no em dashes in the new copy', !/—/.test(fs.readFileSync(REPO + 'server/services/payingBrands.js', 'utf8').replace(/\/\/.*$/gm, '')));
  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.log(OUT.join('\n')); console.error(e); process.exit(1); });
