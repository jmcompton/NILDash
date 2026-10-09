'use strict';
// Runs against the local test Postgres.
//
//   node tests/univchains.js
//
// ── NO CHAIN OR HOTEL BRAND ON A UNIVERSITY CARD, NO HOUSEKEEPING DIRECTOR AS THE CONTACT
// Tillys and IHG hotel properties reached Cypress cards: neither was on the
// national chain list the night checks. A "Director of Housekeeping" passed
// the junior-title check on the word "director". Both are judged at pick
// time, so businesses and contacts stored before the rule are caught too.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
delete process.env.UNIVERSITY_NIGHT_PAID_CONTACTS;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
delete process.env.GOOGLE_PLACES_API_KEY;
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const ai = { oneShot: async (prompt) => { const biz = (prompt.match(/BUSINESS: (.+)/) || [])[1]; return `SUBJECT: The team and ${biz}\nBODY:\n${biz} is close to campus and our fans live around you. Could we set up a short call?`; } };

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const store = require(REPO + 'server/store.js');
  const TS = require(REPO + 'server/services/teamScan.js');
  const CP = require(REPO + 'server/services/campusPool.js');
  const P = store.pool;
  await TS.ensureTables(P); await CP.ensureTables(P);
  const U = 'univ-chaintest', MK = 'chaintown, ca';
  const clean = async () => {
    for (const t of ['university_contacts', 'university_drafts', 'university_brand_engagement', 'university_crm', 'university_touches']) await P.query(`DELETE FROM ${t} WHERE university_id = $1`, [U]).catch(() => {});
    await P.query(`DELETE FROM university_research_claims WHERE team_id LIKE 'ct:%'`);
    await P.query(`DELETE FROM university_teams WHERE university_id = $1`, [U]);
    await P.query(`DELETE FROM university_market_seen WHERE market_key = $1`, [MK]);
    await P.query(`DELETE FROM universities WHERE id = $1`, [U]);
  };
  await clean();
  await P.query(`INSERT INTO universities (id, name, short_name, location) VALUES ($1,'Chain Test College','CTC','1 College Way, Chaintown, CA 90000')`, [U]);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, market_key) VALUES ('ct:bb',$1,'Basketball','basketball',$2)`, [U, MK]);
  // Stored before the rule: no blocked_reason on any of them.
  const biz = async (name, kind, c) => {
    await P.query(`INSERT INTO university_market_seen (market_key, brand, category, types, primary_type, address, distance_m, fit) VALUES ($1,$2,'local',$3::jsonb,$4,'x',900,70)`,
      [MK, name, JSON.stringify([kind]), kind]);
    await P.query(`INSERT INTO university_contacts (university_id, market_key, brand, contact_name, contact_title, email, phone, instagram, reachable, status)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,'reachable')`, [U, MK, name, c.name, c.title, c.email || null, c.phone || null, c.ig || null]);
  };
  await biz('Tillys', 'clothing_store', { name: 'Pat Store', title: 'Store Manager', email: 'pat@tillys.example', phone: '(714) 555-0201' });
  await biz('Holiday Inn Express & Suites Chaintown', 'hotel', { name: 'Gina Hotel', title: 'General Manager', email: 'gina@hiexpress.example', phone: '(714) 555-0202' });
  await biz('Chaintown Valley Inn', 'hotel', { name: 'Rosa Clean', title: 'Director of Housekeeping', email: 'rosa@valleyinn.example', phone: '(714) 555-0203' });
  await biz('Main Street Gym', 'gym', { name: 'Ana Owner', title: 'Owner', email: 'ana@mainstgym.example', phone: '(714) 555-0204' });
  // Cards written before the rule (last night), for the report.
  for (const [id, brand, cn, ct] of [['ct-d1', 'Tillys', 'Pat Store', 'Store Manager'], ['ct-d2', 'Chaintown Valley Inn', 'Rosa Clean', 'Director of Housekeeping'], ['ct-d3', 'Main Street Gym', 'Ana Owner', 'Owner']]) {
    await P.query(`INSERT INTO university_drafts (id, university_id, team_id, brand_key, brand_name, subject, body, status, kind, contact_name, contact_title, night, lane)
                   VALUES ($1,$2,'ct:bb',$3,$4,'s','b','awaiting_approval','pitch',$5,$6,'2026-10-08','local')`, [id, U, 'k:' + brand, brand, cn, ct]);
  }

  // ── THE REPORT, before tonight ────────────────────────────────────────────
  const R = require(REPO + 'scripts/univ-card-recheck.js');
  const rep = await R.run(P, U);
  ok('THE REPORT: Tillys is DROPPED (a national chain)', rep.dropped.some((x) => x.brand_name === 'Tillys' && /national brand/.test(x.why)), rep.lines);
  ok('  the housekeeping director is CONTACT REMOVED, the inn stays', rep.removed.some((x) => x.brand_name === 'Chaintown Valley Inn' && /housekeeping/.test(x.why))
    && !rep.dropped.some((x) => x.brand_name === 'Chaintown Valley Inn'), rep.lines);
  ok('  the owner\'s card is untouched', !rep.dropped.concat(rep.removed).some((x) => x.brand_name === 'Main Street Gym'));
  ok('  it changes nothing', (await P.query(`SELECT COUNT(*)::int n FROM university_drafts WHERE university_id = $1`, [U])).rows[0].n === 3);
  await P.query(`DELETE FROM university_drafts WHERE university_id = $1`, [U]);

  // ── TONIGHT ───────────────────────────────────────────────────────────────
  await TS.runTeamScan(P, { universityId: U, teamId: 'ct:bb', limit: 5, mode: 'pitch', discoverPool: false, deps: { ai, night: '2026-10-09', socialPerTeam: 0 } });
  const cards = Object.fromEntries((await P.query(`SELECT * FROM university_drafts WHERE university_id = $1`, [U])).rows.map((d) => [d.brand_name, d]));
  ok('TONIGHT: no card for Tillys', !cards.Tillys, Object.keys(cards));
  ok('  no card for the Holiday Inn Express, even with a general manager on file', !cards['Holiday Inn Express & Suites Chaintown'], Object.keys(cards));
  const vi = cards['Chaintown Valley Inn'];
  ok('  the independent inn is pitched, to the business, not to its housekeeping director', vi && !vi.contact_name && !/Rosa/.test(vi.body) && vi.contact_email !== 'rosa@valleyinn.example', vi);
  ok('  the owner\'s card is written to the owner', cards['Main Street Gym'] && /^Hi Ana,/.test(cards['Main Street Gym'].body), cards['Main Street Gym']);
  const seen = (await P.query(`SELECT brand, blocked_reason FROM university_market_seen WHERE market_key = $1`, [MK])).rows;
  ok('  the stored rows were re-judged: the chain and the hotel brand are blocked on file', seen.filter((r) => r.blocked_reason).map((r) => r.brand).sort().join('|') === 'Holiday Inn Express & Suites Chaintown|Tillys', seen);
  await clean();
}
main().then(() => { console.log(OUT.join('\n')); console.log(`\nfailures: ${F}`); process.exit(F ? 1 : 0); })
  .catch((e) => { console.log(OUT.join('\n')); console.log('FAIL threw: ' + (e && e.stack)); process.exit(1); });
