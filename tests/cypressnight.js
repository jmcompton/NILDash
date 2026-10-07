'use strict';
// Runs against the local test Postgres.
//
//   node tests/cypressnight.js
//
// ── A NIGHT SHAPED LIKE CYPRESS ─────────────────────────────────────────────
// 15 teams (after the swim merge), 88 businesses near campus, 66 with an
// Instagram handle, a phone on most, an email on a quarter, a name on half;
// 20 social brands; the school's lookup history (123 lookups, $0.083, 87%).
// The three things a Cypress night must do:
//   every team has at least one card, and no team stops on the night cap
//   cardsByChannel.dm > 0
//   the night costs $5 or less
// The model and the lookups are stubbed; the tables are real.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
delete process.env.UNIVERSITY_NIGHT_PAID_CONTACTS;
delete process.env.UNIVERSITY_CARDS_PER_TEAM;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
delete process.env.GOOGLE_PLACES_API_KEY;

const store = require(REPO + 'server/store.js');
const CP = require(REPO + 'server/services/campusPool.js');
const CN = require(REPO + 'server/services/campusNightly.js');
const CB = require(REPO + 'server/services/campusBuild.js');
const TS = require(REPO + 'server/services/teamScan.js');
const OL = require(REPO + 'server/services/ownerLookup.js');
const RI = require(REPO + 'server/services/universityRosterImport.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
// NO ATHLETES, NO PITCH (campusNightly.athletesByTeam): every fixture team gets one.
const roster = (P, uid) => P.query(`INSERT INTO university_athletes (id, university_id, name, sport, data)
  SELECT t.id || ':roster-athlete', t.university_id, 'Roster Athlete', t.name, jsonb_build_object('teamId', t.id)
    FROM university_teams t WHERE t.university_id = $1 ON CONFLICT (id) DO NOTHING`, [uid]);
const U = 'univ-cyptest', MK = 'cyptown, ca';
const ai = { oneShot: async (prompt) => { const biz = (prompt.match(/BUSINESS: (.+)/) || [])[1]; return `SUBJECT: The team and ${biz}\nBODY:\n${biz} is a good partner for the program this season. Could we set up a short call?`; } };
let n = 0;
const contactsAi = {
  deepContactCtx: (o) => ({ ...o }),
  getBrandContacts: async (brand) => (++n % 8 === 0 ? { contacts: [], addressLadder: {} }
    : { contacts: [{ name: 'Lee Park', title: 'Owner', email: `lee@${brand.toLowerCase().replace(/[^a-z0-9]+/g, '')}.test`, source: 'site' }], addressLadder: {} }),
  webSearchJson: async () => ({ text: '{"name": null}', citations: [] }),
};
const freeDeps = { places: { lookupPlaceById: async () => null }, site: { findSiteEmail: async () => null }, ig: { findInstagram: async () => null } };
const TEAMS = ['Baseball', 'Softball', "Men's Basketball", "Women's Basketball", "Men's Soccer", "Women's Soccer", "Women's Volleyball", 'Beach Volleyball',
  'Flag Football', "Men's Swim & Dive", "Women's Swim & Dive", "Men's Water Polo", "Women's Water Polo", "Men's Track & Field", "Women's Track & Field"];
const KINDS = ['gym', 'cafe', 'mexican_restaurant', 'clothing_store', 'barber_shop', 'physiotherapist', 'car_dealer', 'bakery', 'florist', 'pizza_restaurant', 'sporting_goods_store', 'dentist'];

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await TS.ensureTables(P); await CP.ensureTables(P); await CB.ensureTables(P); await OL.ensureTable(P);
  const clean = async () => {
    for (const t of ['university_athletes', 'university_contacts', 'university_market_runs', 'university_crm', 'university_touches', 'university_drafts', 'university_brand_engagement',
      'university_social_brands', 'university_owner_lookups']) await P.query(`DELETE FROM ${t} WHERE university_id = $1`, [U]).catch(() => {});
    await P.query(`DELETE FROM university_research_claims WHERE team_id LIKE 'cy:%'`);
    await P.query(`DELETE FROM university_teams WHERE university_id = $1`, [U]);
    await P.query(`DELETE FROM university_market_seen WHERE market_key = $1`, [MK]);
    await P.query(`DELETE FROM university_discovery_cells WHERE market_key = $1`, [MK]).catch(() => {});
    await P.query(`DELETE FROM universities WHERE id = $1`, [U]);
  };
  await clean();
  await P.query(`INSERT INTO universities (id, name, short_name, location) VALUES ($1,'Cyp Test College','CTC','9200 Valley View St, Cyptown, CA 90630')`, [U]);
  for (const [i, t] of TEAMS.entries()) {
    await P.query(`INSERT INTO university_teams (id, university_id, name, sport, market_key) VALUES ($1,$2,$3,$4,$5)`, ['cy:' + i, U, t, RI.sportOf(t), MK]);
  }
  for (let i = 0; i < 88; i++) {
    const kind = KINDS[i % KINDS.length], brand = `Cyp Biz ${i}`;
    await P.query(`INSERT INTO university_market_seen (market_key, brand, place_id, category, types, primary_type, address, distance_m, fit) VALUES ($1,$2,$3,'local',$4::jsonb,$5,'x',$6,60)`,
      [MK, brand, 'cy-' + i, JSON.stringify([kind]), kind, 600 + (i % 20) * 120]);
    const handle = i < 66 ? `cypbiz${i}` : null, email = i % 4 === 0 ? `owner${i}@cyp.test` : null, phone = i % 5 !== 0 ? `(714) 555-${String(1000 + i)}` : null;
    const name = i % 2 === 0 ? 'Dana Reed' : null;
    const reach = !!(handle || email || phone);
    await P.query(`INSERT INTO university_contacts (university_id, market_key, brand, place_id, contact_name, contact_title, email, phone, instagram, reachable, status)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [U, MK, brand, 'cy-' + i, name, name ? 'Owner' : null, email, phone, handle, !!(name && reach), name && reach ? 'reachable' : reach ? 'free-checked' : 'pending']);
  }
  // CYPRESS'S LOOKUP HISTORY, EXACTLY: 123 lookups, 107 named, $0.083 each.
  // The named contacts above were bought too, so they are part of the 123 and
  // carry the cost; the rest of the history makes up the difference.
  const onFile = (await P.query(`SELECT COUNT(*)::int n FROM university_contacts WHERE university_id = $1 AND status = 'reachable'`, [U])).rows[0].n;
  await P.query(`UPDATE university_contacts SET cost_usd = 0.083 WHERE university_id = $1 AND status = 'reachable'`, [U]);
  for (let i = 0; i < 123 - onFile; i++) {
    await P.query(`INSERT INTO university_contacts (university_id, market_key, brand, status, reachable, cost_usd) VALUES ($1,'(history)',$2,$3,$4,0.083)`,
      [U, 'History ' + i, i < 107 - onFile ? 'reachable' : 'unreachable', i < 107 - onFile]);
  }
  for (let i = 0; i < 20; i++) {
    await P.query(`INSERT INTO university_social_brands (university_id, brand, website, program_url, category, sports, proof_date, offer, evidence)
                   VALUES ($1,$2,$3,$4,'apparel',ARRAY['all'],NOW(),'free gear for athletes','program states no minimum')`,
      [U, 'Social Brand ' + i, `https://sb${i}.test`, `https://sb${i}.test/athletes`]);
  }

  await roster(P, U);
  // Women's Tennis: home dates and inventory, no roster published. Never pitched.
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, market_key, home_dates) VALUES ('cy:wten',$1,'Women''s Tennis','Tennis',$2,6)`, [U, MK]);
  const est = await CN.estimate(P, U);
  OUT.push('', CN.formatEstimate(est), '');
  const r = await CN.runNight(P, U, { ai, contactsAi, freeDeps, night: '2026-10-30' });
  OUT.push(CN.formatNight(r), '');
  const v = await CB.verify(P, U);
  const zero = r.perTeam.filter((t) => t.cards < 1 && t.stop !== 'no-roster');
  const wten = r.perTeam.find((t) => t.teamId === 'cy:wten');
  ok('NO ATHLETES, NO PITCH: Women\'s Tennis has no roster and no cards, and is listed as not pitched', wten && wten.cards === 0 && wten.stop === 'no-roster'
    && r.noRoster.includes("Women's Tennis") && !r.short.some((x) => x.team === "Women's Tennis")
    && (await P.query(`SELECT COUNT(*)::int n FROM university_drafts WHERE team_id = 'cy:wten'`)).rows[0].n === 0, { wten, noRoster: r.noRoster });
  ok('  printed', /NOT PITCHED, no athletes on file: Women's Tennis/.test(CN.formatNight(r)), CN.formatNight(r));
  ok('  and left out of the estimate (15 teams with a roster, not 16)', est.teams === 15, est.teams);
  const capped = r.perTeam.filter((t) => t.stop === 'night-cap');
  ok('EVERY TEAM WITH A ROSTER HAS AT LEAST ONE CARD', zero.length === 0 && r.perTeam.length === 16, zero.map((t) => t.team));
  ok('NO TEAM STOPS ON THE NIGHT CAP', capped.length === 0, capped.map((t) => t.team));
  ok('CARDSBYCHANNEL.DM > 0', v.cardsByChannel && v.cardsByChannel.dm > 0, v.cardsByChannel);
  ok('THE NIGHT COSTS $5 OR LESS (stubbed lookups cost nothing here: see the estimate)', r.costUsd <= 5 && est.totalUsd[0] <= 5, { night: r.costUsd, projected: est.totalUsd });
  ok('  the projection uses the measured rate: $0.083 a lookup, $0.10 a name, from 123 lookups', est.perLookupUsd === 0.083 && est.perNamedUsd === 0.1
    && /this university's 123 lookups/.test(est.costFrom), { perLookupUsd: est.perLookupUsd, perNamedUsd: est.perNamedUsd, costFrom: est.costFrom });
  OUT.push(`cards ${r.cards} of ${r.target}; by channel ${JSON.stringify(v.cardsByChannel)}; names ${JSON.stringify(r.names)}`);
  await clean();
}
main().then(() => { console.log(OUT.join('\n')); console.log(`\nfailures: ${F}`); process.exit(F ? 1 : 0); })
  .catch((e) => { console.log(OUT.join('\n')); console.log('FAIL threw: ' + (e && e.stack)); process.exit(1); });
