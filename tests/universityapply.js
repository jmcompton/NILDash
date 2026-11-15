'use strict';
// Runs against the local test Postgres.
//
//   node tests/universityapply.js
//
// ── ATHLETE DEALS FOR A WHOLE ROSTER (services/universityApply)
// A department's roster, matched to brands that run their own athlete
// programs, each with the application written. University tables only; the
// brand catalog (social_brands) is public, web-verified data.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('universityapplytest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };

async function main() {
  const UA = require(REPO + 'server/services/universityApply.js');

  // ── PURE ───────────────────────────────────────────────────────────────
  ok("women's soccer reads as soccer, women", UA.sportOf("Women's Soccer").sport === 'soccer' && UA.sportOf("Women's Soccer").women === true);
  ok('football reads as football, not women', UA.sportOf('Football').sport === 'football' && !UA.sportOf('Football').women);
  ok('"all" fits every sport', UA.sportFits(['all'], 'Baseball').ok && !UA.sportFits(['all'], 'Baseball').named);
  ok('a named sport fits, and says so', UA.sportFits(['soccer'], "Women's Soccer").named === true);
  ok('another sport does not fit', !UA.sportFits(['football'], "Women's Soccer").ok);

  const athletes = Array.from({ length: 10 }, (_, i) => ({ id: 'a' + i, sport: i < 5 ? 'Football' : "Women's Soccer" }));
  const brands = [
    { brand: 'AllA', sports: ['all'], proof_url: 'u' }, { brand: 'AllB', sports: ['all'], proof_url: 'u' },
    { brand: 'AllC', sports: ['all'], proof_url: 'u' }, { brand: 'Kicks', sports: ['soccer'], proof_url: 'u' },
  ];
  const picks = UA.pick({ athletes, brands, existing: new Map(), perAthlete: 2 });
  const count = (b) => picks.filter((p) => p.brand === b).length;
  ok('two per athlete', athletes.every((a) => picks.filter((p) => p.athleteId === a.id).length === 2), picks.length);
  ok('spread: no brand takes the roster', Math.max(count('AllA'), count('AllB'), count('AllC'), count('Kicks')) <= 6, { AllA: count('AllA'), AllB: count('AllB'), AllC: count('AllC'), Kicks: count('Kicks') });
  ok('a soccer-only program goes only to soccer players', picks.filter((p) => p.brand === 'Kicks').every((p) => Number(p.athleteId.slice(1)) >= 5));
  const ex = new Map([['a0', { brands: new Set(['alla']), open: 3 }]]);
  ok('an athlete with three open gets no more', !UA.pick({ athletes: [athletes[0]], brands, existing: ex }).length);
  const ex2 = new Map([['a0', { brands: new Set(['alla', 'allb']), open: 0 }]]);
  ok('never the same brand twice for one athlete', UA.pick({ athletes: [athletes[0]], brands, existing: ex2 }).every((p) => !['AllA', 'AllB'].includes(p.brand)));

  // ── AGAINST THE DATABASE ───────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  await UA.ensureTables(P);
  await P.query(`INSERT INTO universities (id, name, short_name, location) VALUES ('univ-test','Test State University','Test State','Testville, AL'), ('univ-other','Other College','Other','Elsewhere, AL')`);
  const ath = (id, uni, name, sport, pos, year, hometown) => P.query(
    `INSERT INTO university_athletes (id, university_id, name, sport, position, year, source, data) VALUES ($1,$2,$3,$4,$5,$6,'roster-import',$7)`,
    [id, uni, name, sport, pos, year, JSON.stringify({ hometown })]);
  await ath('t:fb:1', 'univ-test', 'Riley Stone', 'Football', 'WR', 'Junior', 'Mobile, AL');
  await ath('t:fb:2', 'univ-test', 'Casey Hill', 'Football', 'LB', 'Senior', null);
  await ath('t:ws:1', 'univ-test', 'Morgan Lane', "Women's Soccer", 'Midfielder', 'Sophomore', 'Dothan, AL');
  await ath('t:vb:1', 'univ-test', 'Jordan Park', "Women's Volleyball", 'Libero', 'Freshman', null);
  await ath('o:fb:1', 'univ-other', 'Other Kid', 'Football', 'QB', 'Senior', null);
  const sb = (brand, sports, url, website, tierMin, cat) => P.query(
    `INSERT INTO social_brands (brand, category, website, sports, tier_min, tier_max, deal_structure, proof_url, offer_summary, proof_date, active)
     VALUES ($1,$2,$3,$4,$5,1000000,'affiliate',$6,'Free product and a commission on sales',CURRENT_DATE,true)`, [brand, cat, website, sports, tierMin, url]);
  await sb('Fuel Co', ['all'], 'https://fuelco.example/pages/ambassadors', 'https://fuelco.example', 0, 'Sports nutrition');
  await sb('Wear Co', ['all'], 'https://wearco.example/athletes', 'https://wearco.example', 500, 'Apparel');
  await sb('Kick Co', ['soccer'], 'https://kickco.example/pages/athlete-program', 'https://kickco.example', 0, 'Footwear');
  await sb('Home Co', ['all'], 'https://homeco.example/', 'https://homeco.example', 0, 'Apparel');
  await sb('Big Co', ['all'], 'https://bigco.example/ambassadors', 'https://bigco.example', 50000, 'Apparel');
  const cat = await UA.catalog(P);
  ok('the catalog drops a homepage and a program with a high follower floor', cat.map((b) => b.brand).sort().join(',') === 'Fuel Co,Kick Co,Wear Co', cat.map((b) => b.brand));

  const r1 = await UA.refresh(P, 'univ-test');
  ok('refresh: 4 athletes, 3 usable brands, 8 applications opened', r1.athletes === 4 && r1.brands === 3 && r1.opened === 8, r1);
  const r2 = await UA.refresh(P, 'univ-test');
  // Football and volleyball fit only the two all-sports programs, already
  // opened; the soccer player has the third. So one more, and nothing repeats.
  ok('a second refresh opens only what is left, never a repeat', r2.opened === 1, r2);
  const rows = (await P.query(`SELECT athlete_id, brand FROM university_applications WHERE university_id = 'univ-test'`)).rows;
  ok('Kick Co only for the soccer player', rows.filter((r) => r.brand === 'Kick Co').every((r) => r.athlete_id === 't:ws:1'), rows);
  ok("the other university's athlete got nothing from this refresh", !(await P.query(`SELECT 1 FROM university_applications WHERE athlete_id = 'o:fb:1'`)).rows.length);

  const L = await UA.list(P, 'univ-test', { staff: { name: 'Pat Director', title: 'Director of NIL', email: 'pat@teststate.example' } });
  ok('totals: 4 athletes, all 4 covered', L.totals.athletes === 4 && L.totals.covered === 4, L.totals);
  ok('by team, with women\'s teams marked', L.bySport.find((s) => s.sport === "Women's Soccer").women === true && L.bySport.find((s) => s.sport === 'Football').athletes === 2, L.bySport);
  const one = L.applications.find((a) => a.athleteName === 'Morgan Lane' && a.brand === 'Kick Co');
  const field = (a, l) => (a.fields.find((f) => f.label === l) || {}).value;
  ok('an application: school, sport, position, year, hometown', one && field(one, 'School') === 'Test State University' && field(one, 'Position') === 'Midfielder'
    && field(one, 'Class year') === 'Sophomore' && field(one, 'Hometown') === 'Dothan, AL', one && one.fields);
  ok("why, from the program naming the sport", /^I'm a sophomore on the Test State University women's soccer team, playing Midfielder\..*Your program works with women's soccer athletes/.test(field(one, "Why I'm a fit for Kick Co") || ''), field(one, "Why I'm a fit for Kick Co"));
  ok('the school contact, not "Representation"', field(one, 'School contact') === 'Pat Director, Director of NIL, Test State NIL office, pat@teststate.example' && !field(one, 'Representation'), one.fields.map((f) => f.label));
  ok('a text for the athlete', /^Hey Morgan, Kick Co has an athlete program/.test(one.athleteText));
  ok('no Instagram on file: listed as missing, never invented', one.missing.includes('Instagram') && !/followers/.test(one.text));
  const fb = L.applications.filter((a) => a.sport === 'Football');
  ok('filter by team', (await UA.list(P, 'univ-test', { sport: 'Football' })).applications.every((a) => a.sport === 'Football') && fb.length >= 4);

  const s1 = await UA.setState(P, 'univ-test', one.id, 'applied', 'u1');
  ok('mark applied', s1.ok && s1.state === 'applied');
  ok('the other university cannot mark it', !(await UA.setState(P, 'univ-other', one.id, 'skipped', 'u2')).ok);
  ok('an unknown state is refused', !(await UA.setState(P, 'univ-test', one.id, 'won', 'u1')).ok);
  const L2 = await UA.list(P, 'univ-test', {});
  ok('applied counts up', L2.totals.applied === 1, L2.totals);
  ok('another university sees none of it', (await UA.list(P, 'univ-other', {})).applications.length === 0);

  // ── ROUTES, THE WALL, THE PAGE ─────────────────────────────────────────
  const campus = fs.readFileSync(REPO + 'server/routes/campus.js', 'utf8');
  ok('routes behind the staff guard, scoped by the session', /app\.get\('\/api\/university\/applications', guard/.test(campus)
    && /UA\.list\(pool, req\.staff\.university_id/.test(campus) && /UA\.setState\(pool, req\.staff\.university_id/.test(campus));
  ok('viewing as admin is read only', (campus.match(/viewingAsAdmin\) return res\.status\(403\)/g) || []).length >= 2);
  const MG = fs.readFileSync(REPO + 'server/middleware/modeGuard.js', 'utf8');
  ok('the wall lets a university session reach them', /'GET \/api\/university\/applications'/.test(MG) && /\['POST', '\/api\/university\/applications\/'\]/.test(MG));
  const page = fs.readFileSync(REPO + 'public/university.html', 'utf8');
  ok('the portal has Athlete Deals', /\["athletes","Athlete Deals"\]/.test(page) && /athletes:vAthletes/.test(page) && /\/api\/university\/applications\/refresh/.test(page));
  const night = fs.readFileSync(REPO + 'server/services/campusNightly.js', 'utf8');
  ok('every night opens new applications for the roster', /require\('\.\/universityApply'\)\.refresh\(pool, universityId\)/.test(night));
  const svc = fs.readFileSync(REPO + 'server/services/universityApply.js', 'utf8');
  const sqlTables = [...svc.replace(/\/\/.*$/gm, '').matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
  ok('only university tables and the public brand catalog in its SQL', sqlTables.every((t) => /^university_|^universities$|^social_brands$|^lateral$/.test(t)), sqlTables);

  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
