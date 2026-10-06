'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/universityleads.js  just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE ATHLETICS DIRECTOR'S MORNING: /university, HOME AND SPONSORS ────────
// A real server, the real page, a real browser. A department with leads sees
// them on Home, grouped by team, each with the person, how to reach them, why,
// and the email; "Open in email" is a mailto with the email in it, and it and
// "Mark contacted" record the touch for the whole staff. A department with no
// leads yet is told when they come and shown the nearest businesses with a
// named person. Sponsors lists every business, filters, sets a stage, writes a
// pitch, and downloads the spreadsheet. Another department's data never shows.
const fs = require('fs');
const net = require('net');
const { spawn, execSync } = require('child_process');
const bcrypt = require('bcryptjs');
const store = require(REPO + 'server/store.js');
const TS = require(REPO + 'server/services/teamScan.js');
const CP = require(REPO + 'server/services/campusPool.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const A = 'univ-ul-a', B = 'univ-ul-b', MKA = 'leadtown, ca', MKB = 'quiettown, ca', PASS = 'ul-pass-1', MI = 1609.34;
async function freePort() { return new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); }); }

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await TS.ensureTables(P); await CP.ensureTables(P);
  const clean = async () => {
    for (const t of ['university_crm_touches', 'university_crm', 'university_drafts', 'university_contacts', 'university_staff']) await P.query(`DELETE FROM ${t} WHERE university_id = ANY($1)`, [[A, B]]).catch(() => {});
    await P.query(`DELETE FROM university_market_seen WHERE market_key = ANY($1)`, [[MKA, MKB]]).catch(() => {});
    await P.query(`DELETE FROM university_inventory WHERE university_id = ANY($1)`, [[A, B]]).catch(() => {});
    await P.query(`DELETE FROM university_teams WHERE university_id = ANY($1)`, [[A, B]]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id IN ('ul-xavier','ul-bstaff')`).catch(() => {});
    await P.query(`DELETE FROM universities WHERE id = ANY($1)`, [[A, B]]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO universities (id, name, short_name, location) VALUES ($1,'Lead Test College','LTC','1 College Way, Leadtown, CA 90000'),($2,'Quiet College','QC','1 Main, Quiettown, CA 90001')`, [A, B]);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, season, roster_size, market_key) VALUES
    ('ul:wbb',$1,'Women''s Basketball','basketball','Winter',14,$2), ('ul:sb',$1,'Softball','softball','Spring',20,$2), ('ulb:wp',$3,'Water Polo','water polo','Fall',16,$4)`, [A, MKA, B, MKB]);
  const hash = await bcrypt.hash(PASS, 8);
  await P.query(`INSERT INTO users (id, name, email, password, role, university_id, plan_tier) VALUES ('ul-xavier','Xavier Brown','ul-xavier@ul.test',$1,'university',$2,'unlimited'),
                 ('ul-bstaff','Quiet Staff','ul-b@ul.test',$1,'university',$3,'unlimited')`, [hash, A, B]);
  for (let i = 0; i < 12; i++) {
    const brand = `Lead Biz ${i}`;
    await P.query(`INSERT INTO university_market_seen (market_key, brand, place_id, category, types, address, distance_m) VALUES ($1,$2,$3,'gym',$6::jsonb,$4,$5)`,
      [MKA, brand, 'ul-' + i, `${i} Main St`, Math.round((1 + i * 0.3) * MI),
       // Eight kinds by Google type: no kind over the list's 15% share (campusQuality).
       JSON.stringify([['gym', 'restaurant', 'cafe', 'clothing_store', 'barber_shop', 'physiotherapist', 'car_dealer', 'bakery'][i % 8]])]);
    await P.query(`INSERT INTO university_contacts (university_id, market_key, brand, place_id, contact_name, contact_title, email, phone, reachable, status, team_fit)
                   VALUES ($1,$2,$3,$4,$5,'Owner',$6,'(714) 555-0100',$7,$8,$9::jsonb)`,
      [A, MKA, brand, 'ul-' + i, i < 8 ? 'Dana Reed' : null, i < 8 ? `dana${i}@biz.test` : null, i < 8, i < 8 ? 'reachable' : 'unreachable',
        JSON.stringify([{ team_id: 'ul:wbb', team: "Women's Basketball", score: 30, why: 'a gym: players train there' }])]);
  }
  for (let i = 0; i < 5; i++) {
    await P.query(`INSERT INTO university_market_seen (market_key, brand, place_id, category, types, address, distance_m) VALUES ($1,$2,$3,'cafe','["cafe"]','x',$4)`, [MKB, 'Quiet Cafe ' + i, 'qc-' + i, 800 + i * 400]);
    await P.query(`INSERT INTO university_contacts (university_id, market_key, brand, place_id, contact_name, email, reachable, status, team_fit) VALUES ($1,$2,$3,$4,'Sam Hill',$5,TRUE,'reachable','[]'::jsonb)`,
      [B, MKB, 'Quiet Cafe ' + i, 'qc-' + i, `sam${i}@cafe.test`]);
  }
  const night = '2026-10-05';
  const draft = (id, team, brand, n) => P.query(`INSERT INTO university_drafts (id, university_id, team_id, brand_key, brand_name, subject, body, model, status, kind, why, contact_name, contact_title, contact_email, contact_phone, night)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'m','awaiting_approval','pitch',$8,'Dana Reed','Owner',$9,'(714) 555-0100',$10)`,
    [id, A, team, brand.toLowerCase(), brand, 'Backing the team this season', `Hi Dana,\n\n${brand} is close to campus. Would you support the team this season?`, 'a gym: players train there', `dana${n}@biz.test`, night]);
  await draft('ud-1', 'ul:wbb', 'Lead Biz 0', 0); await draft('ud-2', 'ul:wbb', 'Lead Biz 1', 1); await draft('ud-3', 'ul:sb', 'Lead Biz 2', 2);

  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'ul-test', CYPRESS_SEED_ON_BOOT: 'off', UNIVERSITY_NIGHTLY: 'off',
      RESEND_API_KEY: process.env.RESEND_API_KEY || 're_test_dummy', DATABASE_URL: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let srvErr = ''; srv.stderr.on('data', (d) => { srvErr = (srvErr + d).slice(-2000); });
  const base = `http://127.0.0.1:${port}`;
  let browser = null;
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/privacy')).ok; } catch (_) {} if (!up) await new Promise((r) => setTimeout(r, 1000)); }
    ok('the server boots', up, srvErr.slice(-400));
    let chromium;
    try { chromium = require(execSync('npm root -g').toString().trim() + '/playwright').chromium; } catch (_) {}
    if (!chromium) { ok('playwright is available', false); return; }
    browser = await chromium.launch();
    const signIn = async (email) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
      const page = await ctx.newPage();
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/*', (r) => (new URL(r.request().url()).host !== `127.0.0.1:${port}` ? r.fulfill({ status: 204, body: '' }) : r.continue()));
      await page.goto(base + '/university');
      await page.fill('#lemail', email); await page.fill('#lpass', PASS);
      await page.click('#lgo');
      await page.waitForSelector('.shell', { timeout: 15000 });
      await page.waitForTimeout(800);
      return { page, errors };
    };

    // ── 1. HOME WITH LEADS ──────────────────────────────────────────────────
    OUT.push('-- Home: this morning\'s leads --');
    const { page, errors } = await signIn('ul-xavier@ul.test');
    const home = await page.evaluate(() => ({
      crumb: document.getElementById('crumbNow').textContent, h1: (document.querySelector('.head h1') || {}).textContent || '',
      teams: [...document.querySelectorAll('.teamhead h3')].map((h) => h.textContent), leads: document.querySelectorAll('.lead').length,
      kpi: [...document.querySelectorAll('.kpi')].map((k) => k.innerText.replace(/\s+/g, ' ')), text: document.getElementById('view').innerText,
      mailto: (document.querySelector('.lead a[href^="mailto:"][data-sent]') || {}).href || '',
    }));
    ok('Home is where Xavier lands, and it says what NILDash does in one sentence', home.crumb === 'Home' && /Sponsor leads for Lead Test College Athletics/.test(home.h1)
      && /finds the person who decides, and writes the first email for you/.test(home.text) && /Nothing goes out without you/.test(home.text), home.h1);
    ok('  the numbers: 3 leads this morning for two teams, 12 businesses near campus, 8 with a named person, 2 teams',
      /LEADS THIS MORNING 3 for two teams/.test(home.kpi[0]) && /BUSINESSES NEAR CAMPUS 12/.test(home.kpi[1]) && /WITH A NAMED PERSON 8/.test(home.kpi[2]) && /YOUR TEAMS 2/.test(home.kpi[3]), home.kpi);
    ok('  three steps, in plain words', /1\. Read the lead/.test(home.text) && /2\. Send the email/.test(home.text) && /3\. Mark it contacted/.test(home.text));
    ok('the leads, grouped by team: Softball (1) and Women\'s Basketball (2)', JSON.stringify(home.teams) === JSON.stringify(['Softball', "Women's Basketball"]) && home.leads === 3, home.teams);
    ok('  each lead: the business, the person and title, email and phone, why it fits', /Lead Biz 0/.test(home.text) && /Dana Reed\s*·\s*Owner/.test(home.text) && /dana0@biz\.test/.test(home.text)
      && /\(714\) 555-0100/.test(home.text) && /a gym: players train there/.test(home.text), home.text.slice(home.text.indexOf('Lead Biz'), home.text.indexOf('Lead Biz') + 300));
    ok('  "Open in email" is the department\'s own mail with the lead\'s email in it', /^mailto:dana2%40biz\.test\?subject=Backing%20the%20team%20this%20season&body=Hi%20Dana/.test(home.mailto) || /^mailto:dana\d%40biz\.test\?subject=Backing/.test(home.mailto), home.mailto);
    await page.click('[data-mark="ud-1"]');
    await page.waitForTimeout(700);
    const t1 = (await P.query(`SELECT stage FROM university_crm WHERE university_id = $1 AND brand = 'Lead Biz 0'`, [A])).rows[0];
    const marked = await page.evaluate(() => [...document.querySelectorAll('.lead')].find((l) => /Lead Biz 0/.test(l.innerText)).innerText);
    ok('"Mark contacted" moves the business to Contacted for the whole staff, and the card says so', t1 && t1.stage === 'contacted' && /CONTACTED/.test(marked), { t1, marked });
    ok('  no script error', !errors.length, errors);

    // ── 2. SPONSORS ────────────────────────────────────────────────────────
    OUT.push('', '-- Sponsors --');
    await page.click('[data-goto="sponsors"]');
    await page.waitForFunction(() => /businesses/.test((document.querySelector('.stats') || {}).innerText || '') && !/Loading/.test(document.querySelector('.stats').innerText), null, { timeout: 10000 });
    const sp = await page.evaluate(() => ({ stats: document.querySelector('.stats').innerText, rows: document.querySelectorAll('.tablewrap tbody tr').length,
      first: (document.querySelector('.tablewrap tbody tr') || {}).innerText || '', csv: (document.querySelector('a[href*="format=csv"]') || {}).getAttribute('href') }));
    ok('every business with a named person, nearest first, with who and how to reach', /8 businesses/.test(sp.stats) && sp.rows === 8 && /Lead Biz 0/.test(sp.first) && /Dana Reed/.test(sp.first), sp);
    await page.uncheck('#spcontact');
    await page.waitForFunction(() => /12 businesses/.test(document.querySelector('.stats').innerText), null, { timeout: 10000 });
    ok('  unticking "With a named person" shows all 12', true);
    await page.selectOption('select[data-stage="Lead Biz 5"]', 'in_talks');
    await page.waitForTimeout(700);
    const st5 = (await P.query(`SELECT stage FROM university_crm WHERE university_id = $1 AND brand = 'Lead Biz 5'`, [A])).rows[0];
    ok('setting a stage in the list saves it', st5 && st5.stage === 'in_talks', st5);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('a[href*="format=csv"]')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    ok('"Download as spreadsheet" downloads the list as CSV, with the person and email for each business',
      /^﻿?Business,Kind,Address,Miles from campus,Contact,Title,Email,Phone/.test(csv) && /Lead Biz 0,.*Dana Reed,Owner,dana0@biz\.test/.test(csv) && csv.split('\n').filter(Boolean).length === 13, csv.slice(0, 300));
    ok('  no script error', !errors.length, errors);
    await page.context().close();

    // ── 3. A DEPARTMENT WITH NO LEADS YET ──────────────────────────────────
    OUT.push('', '-- a department with no leads yet --');
    const q = await signIn('ul-b@ul.test');
    const qt = await q.page.evaluate(() => document.getElementById('view').innerText);
    ok('it says no leads yet and when they come, and shows the nearest businesses with a named person',
      /No leads written yet/.test(qt) && /nightly run writes a few leads for every team/.test(qt) && /Quiet Cafe 0/.test(qt) && /Sam Hill/.test(qt), qt.slice(0, 500));
    ok('  and nothing of the other department', !/Lead Biz|Lead Test College|Dana Reed/.test(qt));
    ok('  no script error', !q.errors.length, q.errors);
    await q.page.context().close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
