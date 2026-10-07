'use strict';
// Runs against the local test Postgres (the merge); the names need nothing.
//
//   node tests/teamnames.js
//
// ── ONE TEAM, ONE NAME ──────────────────────────────────────────────────────
// Cypress's import read "Women's Swim & Dive" and "Women's Swimming & Diving"
// off cypresschargers.com as two teams; the duplicate drew five cards a night.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const TN = require(REPO + 'server/services/teamNames.js');
const RI = require(REPO + 'server/services/universityRosterImport.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };

// ── THE NAMES ──────────────────────────────────────────────────────────────
const same = [
  ["Men's Swim & Dive", "Men's Swimming & Diving", 'Mens Swimming and Diving', "Men's Swim and Dive", 'Men Swim-Dive'],
  ["Women's Swim & Dive", "Women's Swimming & Diving", 'Womens Swimming & Diving', "Women's Swim/Dive"],
  ["Men's Track & Field", "Men's Track and Field", 'Mens Track & Field', "Men's T&F"],
  ["Women's Cross Country", "Women's XC", 'Womens Cross-Country', "Women's Cross Country"],
  ["Men's Basketball", 'Mens Basketball', "Men’s Basketball"],
];
for (const g of same) {
  ok(`one team: ${g.join(' = ')}`, new Set(g.map(TN.teamKey)).size === 1, g.map(TN.teamKey));
  ok(`  stored as "${g[0]}"`, g.every((n) => TN.canonicalName(n) === g[0]), g.map(TN.canonicalName));
}
ok('men and women stay two teams', TN.teamKey("Men's Swim & Dive") !== TN.teamKey("Women's Swim & Dive"));
ok('track and cross country stay two teams', TN.teamKey("Men's Track & Field") !== TN.teamKey("Men's Cross Country"));
ok('beach volleyball is not volleyball', TN.teamKey('Beach Volleyball') !== TN.teamKey("Women's Volleyball"));

// ── THE IMPORT: two codes for one sport are one team ────────────────────────
const html = `<a href="/sports/mswim/2025-26/roster">Men's Swim &amp; Dive</a><a href="/sports/mswimdive">Men's Swimming &amp; Diving</a>
  <a href="/sports/wswim">Women's Swim &amp; Dive</a><a href="/sports/wswimdive">Women's Swimming &amp; Diving</a>
  <a href="/sports/mtrack">Mens Track and Field</a><a href="/sports/mxc">Men's XC</a><a href="/sports/mbkb">Men's Basketball</a>`;
const found = RI.discoverTeams(html, 'https://cypresschargers.com');
ok('THE IMPORT: seven links, five teams', found.length === 5, found.map((t) => t.name));
const sw = found.find((t) => t.name === "Men's Swim & Dive");
ok('  the swim team keeps both codes to look for its roster', sw && sw.codes.join(',') === 'mswim,mswimdive' && sw.seasons.includes('2025-26'), sw);
ok('  names stored canonical', found.some((t) => t.name === "Men's Track & Field") && found.some((t) => t.name === "Men's Cross Country"), found.map((t) => t.name));

// ── THE IMPORT, end to end, and THE MERGE ───────────────────────────────────
async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const store = require(REPO + 'server/store.js');
  const TS = require(REPO + 'server/services/teamScan.js');
  const CP = require(REPO + 'server/services/campusPool.js');
  const M = require(REPO + 'server/services/teamMerge.js');
  const P = store.pool;
  await TS.ensureTables(P); await CP.ensureTables(P); await RI.ensureColumns(P);
  const U = 'univ-tntest';
  const clean = async () => {
    for (const t of ['university_drafts', 'university_brand_engagement', 'university_athletes', 'university_contacts']) await P.query(`DELETE FROM ${t} WHERE university_id = $1`, [U]).catch(() => {});
    await P.query(`DELETE FROM university_research_claims WHERE team_id LIKE 'univ-tntest:%'`).catch(() => {});
    await P.query(`DELETE FROM university_teams WHERE university_id = $1`, [U]);
    await P.query(`DELETE FROM universities WHERE id = $1`, [U]);
  };
  await clean();
  await P.query(`INSERT INTO universities (id, name, short_name, location) VALUES ($1,'TN College','TNC','1 College Way, Tntown, CA 90000')`, [U]);

  // The import against a site with both swim codes: one team.
  const roster = (names) => `<table><thead><tr><th>Name</th><th>Year</th></tr></thead><tbody>${names.map((n) => `<tr><td>${n}</td><td>Fr.</td></tr>`).join('')}</tbody></table>`;
  const pages = {
    'https://tn.test/': html.replace(/cypresschargers\.com/g, 'tn.test'),
    'https://tn.test/sports/mswim/roster': roster(['Ava Stone', 'Ben Lake']),
  };
  const deps = { fetch: async (u) => ({ ok: !!pages[u], status: pages[u] ? 200 : 404, url: u, text: pages[u] || '' }) };
  const imp = await RI.importRosters(P, { universityId: U, siteUrl: 'https://tn.test/' }, deps).catch((e) => ({ ok: false, error: e.message }));
  const swimTeams = (await P.query(`SELECT name FROM university_teams WHERE university_id = $1 AND name ILIKE '%swim%'`, [U])).rows;
  if (imp.ok) ok("THE IMPORT WRITES ONE MEN'S SWIM TEAM, named Swim & Dive", swimTeams.length === 1 && swimTeams[0].name === "Men's Swim & Dive", { imp, swimTeams });
  else OUT.push('SKIP the import end to end (its page reader takes no stub here): ' + imp.error);

  // Cypress as it is: both spellings already on file, athletes and cards on each.
  await P.query(`DELETE FROM university_athletes WHERE university_id = $1`, [U]);
  await P.query(`DELETE FROM university_teams WHERE university_id = $1`, [U]);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport) VALUES
    ('univ-tntest:wswim',$1,'Women''s Swim & Dive','Swim & Dive'), ('univ-tntest:wswimdive',$1,'Women''s Swimming & Diving','Swimming & Diving'),
    ('univ-tntest:mbkb',$1,'Men''s Basketball','Basketball')`, [U]);
  const ath = async (team, teamName, name) => P.query(`INSERT INTO university_athletes (id, university_id, name, sport, data) VALUES ($1,$2,$3,$4,$5)`,
    [`${team}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, U, name, teamName, JSON.stringify({ teamId: team, team: teamName })]);
  await ath('univ-tntest:wswim', "Women's Swim & Dive", 'Cara Reef');
  await ath('univ-tntest:wswimdive', "Women's Swimming & Diving", 'Cara Reef');      // on both rosters
  await ath('univ-tntest:wswimdive', "Women's Swimming & Diving", 'Dina Wave');
  await ath('univ-tntest:wswimdive', "Women's Swimming & Diving", 'Erin Tide');
  for (const [id, team, brand] of [['ud1', 'univ-tntest:wswimdive', 'Pool Supply'], ['ud2', 'univ-tntest:wswimdive', 'Surf Shop'], ['ud3', 'univ-tntest:wswim', 'Juice Bar']]) {
    await P.query(`INSERT INTO university_drafts (id, university_id, team_id, brand_key, brand_name, subject, body, status, kind) VALUES ($1,$2,$3,$4,$5,'s','b','awaiting_approval','pitch')`,
      [id, U, team, 'k:' + brand, brand]);
  }
  // The same business shown to both: a key on (team_id, brand_key) collides when moved.
  for (const team of ['univ-tntest:wswim', 'univ-tntest:wswimdive']) {
    await P.query(`INSERT INTO university_brand_engagement (university_id, team_id, brand_key, brand_name, lane, state) VALUES ($1,$2,'k:Juice Bar','Juice Bar','local','shown')`, [U, team]);
  }
  await P.query(`INSERT INTO university_contacts (university_id, market_key, brand, team_fit) VALUES ($1,'tn','Pool Supply',$2::jsonb)`,
    [U, JSON.stringify([{ team_id: 'univ-tntest:wswim', score: 30 }, { team_id: 'univ-tntest:wswimdive', score: 30 }, { team_id: 'univ-tntest:mbkb', score: 10 }])]);

  const dry = await M.run(P, U);
  ok('THE MERGE, DRY RUN: 3 teams -> 2, nothing written', dry.teamsBefore === 3 && dry.teamsAfter === 2
    && (await P.query(`SELECT COUNT(*)::int n FROM university_teams WHERE university_id = $1`, [U])).rows[0].n === 3, dry);
  ok('  keeps "Swim & Dive", drops "Swimming & Diving"', dry.merges[0].keep.id === 'univ-tntest:wswim' && dry.merges[0].dropped[0].id === 'univ-tntest:wswimdive', dry.merges);
  ok('  says 2 athletes move and 1 was already on the kept roster', dry.athletesMoved === 2 && dry.athletesAlreadyOnKept === 1, dry);
  const r = await M.run(P, U, { apply: true });
  ok('APPLIED: 2 teams', r.ok && r.teamsAfter === 2, r);
  const kept = (await P.query(`SELECT id, name FROM university_athletes WHERE university_id = $1 AND data->>'teamId' = 'univ-tntest:wswim' ORDER BY name`, [U])).rows;
  ok('  every swimmer on the kept team, once', kept.map((a) => a.name).join(',') === 'Cara Reef,Dina Wave,Erin Tide' && kept.every((a) => a.id.startsWith('univ-tntest:wswim:')), kept);
  ok('  the cards moved', (await P.query(`SELECT COUNT(*)::int n FROM university_drafts WHERE university_id = $1 AND team_id = 'univ-tntest:wswim'`, [U])).rows[0].n === 3);
  ok('  a colliding row is kept once, not twice', (await P.query(`SELECT COUNT(*)::int n FROM university_brand_engagement WHERE university_id = $1 AND brand_key = 'k:Juice Bar'`, [U])).rows[0].n === 1);
  ok("  the dropped team is gone from every business's team fit", !(await P.query(`SELECT team_fit::text t FROM university_contacts WHERE university_id = $1`, [U])).rows[0].t.includes('wswimdive'));
  ok('  nothing left naming it', (await P.query(`SELECT COUNT(*)::int n FROM university_drafts WHERE team_id = 'univ-tntest:wswimdive'`)).rows[0].n === 0
    && (await P.query(`SELECT COUNT(*)::int n FROM university_teams WHERE id = 'univ-tntest:wswimdive'`)).rows[0].n === 0);
  ok('  printed', /ATHLETES MOVED: 2/.test(M.format(r)) && /TEAMS AFTER: 2/.test(M.format(r)), M.format(r));
  ok('  a second run finds nothing to merge', (await M.run(P, U)).merges.length === 0);

  // ── CYPRESS AS IT REALLY IS: the roster on one row, the schedule and the
  // inventory on the other.
  await P.query(`DELETE FROM university_inventory WHERE university_id = $1`, [U]).catch(() => {});
  await P.query(`DELETE FROM university_athletes WHERE university_id = $1`, [U]);
  await P.query(`DELETE FROM university_teams WHERE university_id = $1`, [U]);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, home_dates, venue, season) VALUES
    ('univ-tntest:mswim',$1,'Men''s Swim & Dive','Swim & Dive',7,'Aquatics Center','Spring')`, [U]);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, roster_size, roster_url) VALUES
    ('univ-tntest:mswimdive',$1,'Men''s Swimming & Diving','Swimming & Diving',16,'https://tn.test/sports/mswimdive/2025-26/roster')`, [U]);
  for (let i = 0; i < 16; i++) await ath('univ-tntest:mswimdive', "Men's Swimming & Diving", `Swimmer Number${String.fromCharCode(65 + i)}`);
  await P.query(`INSERT INTO university_inventory (id, university_id, team_id, name, price_cents) VALUES
    ('inv-1',$1,'univ-tntest:mswim','Pool deck banner',75000), ('inv-2',$1,'univ-tntest:mswim','Meet sponsor',50000)`, [U]);
  const sd = await M.run(P, U);
  const sm = sd.merges[0];
  ok('THE SPLIT, DRY RUN: keeps "Swim & Dive" (the schedule and inventory row)', sm && sm.keep.id === 'univ-tntest:mswim' && sm.keep.name === "Men's Swim & Dive", sm && sm.keep);
  ok('  BEFORE: 16 athletes, 2 items $1,250, 7 home dates across both rows', sm.before.athletes === 16 && sm.before.inventoryCents === 125000 && sm.before.inventoryItems === 2 && sm.before.homeDates === 7, sm.before);
  ok('  AFTER: the kept row holds all of it', sm.after.athletes === 16 && sm.after.inventoryCents === 125000 && sm.after.inventoryItems === 2 && sm.after.homeDates === 7, sm.after);
  ok('  printed, row by row and before and after', /now  univ-tntest:mswim .*0 athletes, 2 inventory items \$1,250, 7 home dates/.test(M.format(sd))
    && /now  univ-tntest:mswimdive .*16 athletes, 0 inventory items \$0, 0 home dates/.test(M.format(sd))
    && /AFTER  \(kept row\):  16 athletes, 2 inventory items \$1,250, 7 home dates/.test(M.format(sd)), M.format(sd));
  ok('  the dry run wrote nothing', (await P.query(`SELECT COUNT(*)::int n FROM university_teams WHERE university_id = $1`, [U])).rows[0].n === 2
    && (await P.query(`SELECT COUNT(*)::int n FROM university_athletes WHERE university_id = $1 AND id LIKE 'univ-tntest:mswimdive:%'`, [U])).rows[0].n === 16);

  // A LOSS IS REFUSED: an inventory row that will not move (a trigger stands
  // in for whatever would stop it) leaves the kept row with less.
  await P.query(`CREATE OR REPLACE FUNCTION tn_pin() RETURNS trigger AS $$ BEGIN IF OLD.id = 'inv-x' THEN RETURN NULL; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
  await P.query(`DROP TRIGGER IF EXISTS tn_pin ON university_inventory`);
  await P.query(`CREATE TRIGGER tn_pin BEFORE UPDATE ON university_inventory FOR EACH ROW EXECUTE FUNCTION tn_pin()`);
  await P.query(`INSERT INTO university_inventory (id, university_id, team_id, name, price_cents) VALUES ('inv-x',$1,'univ-tntest:mswimdive','Lane sign',30000)`, [U]);
  const refused = await M.run(P, U, { apply: true });
  ok('A DROP IN INVENTORY IS REFUSED and rolled back, even with apply', !refused.ok && /inventoryCents 155000 -> 125000/.test(refused.merges[0].refused || '')
    && (await P.query(`SELECT COUNT(*)::int n FROM university_teams WHERE university_id = $1`, [U])).rows[0].n === 2, refused.merges[0]);
  ok('  and says so', /REFUSED, rolled back: .*would drop/.test(M.format(refused)) && /NOT ALL MERGED/.test(M.format(refused)), M.format(refused));
  await P.query(`DROP TRIGGER IF EXISTS tn_pin ON university_inventory`);
  await P.query(`DELETE FROM university_inventory WHERE id = 'inv-x'`);

  const sa = await M.run(P, U, { apply: true });
  const keptRows = (await P.query(`SELECT * FROM university_teams WHERE university_id = $1`, [U])).rows;
  ok('THE SPLIT, APPLIED: one team, "Men\'s Swim & Dive"', sa.ok && keptRows.length === 1 && keptRows[0].id === 'univ-tntest:mswim' && keptRows[0].name === "Men's Swim & Dive", keptRows);
  ok('  with the roster (16, roster_size 16), the schedule (7 home dates, venue) and the inventory ($1,250)', keptRows[0].roster_size === 16 && keptRows[0].home_dates === 7
    && keptRows[0].venue === 'Aquatics Center' && (await P.query(`SELECT COALESCE(SUM(price_cents),0)::int c FROM university_inventory WHERE team_id = 'univ-tntest:mswim'`)).rows[0].c === 125000
    && (await P.query(`SELECT COUNT(*)::int n FROM university_athletes WHERE university_id = $1 AND data->>'teamId' = 'univ-tntest:mswim'`, [U])).rows[0].n === 16, keptRows[0]);
  ok('  the roster URL comes across too', (await P.query(`SELECT roster_url FROM university_teams WHERE id = 'univ-tntest:mswim'`)).rows[0].roster_url === 'https://tn.test/sports/mswimdive/2025-26/roster');
  await P.query(`DELETE FROM university_inventory WHERE university_id = $1`, [U]).catch(() => {});
  await clean();
}
main().then(() => { console.log(OUT.join('\n')); console.log(`\nfailures: ${F}`); process.exit(F ? 1 : 0); })
  .catch((e) => { console.log(OUT.join('\n')); console.log('FAIL threw: ' + (e && e.stack)); process.exit(1); });
