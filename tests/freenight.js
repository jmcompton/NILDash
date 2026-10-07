'use strict';
// Runs against the local test Postgres.
//
//   node tests/freenight.js
//
// ── THE FREE NIGHT: FREE SOURCES FOR EVERY CARD, NAMES BOUGHT PER SCHOOL ────
// Buying a named contact for every business every night spent most of $5 on
// guesses, 17 times over (once a team). Now:
//   - every card comes from the free sources (listing, website, Instagram)
//   - each business goes to the one team it fits best
//   - one flat budget a night for the SCHOOL buys owner names for the best
//     nameless cards; "Find the owner" buys one when staff ask, capped a month
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

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const U = 'univ-freetest', MK = 'freetown, ca';

const ai = {
  oneShot: async (prompt) => {
    const biz = (prompt.match(/BUSINESS: (.+)/) || [])[1];
    return `SUBJECT: The team and ${biz}\nBODY:\n${biz} is a good partner for the program this season. Could we set up a short call?`;
  },
};
// The paid lookup: counted, and it names Sam Hill for every business.
const paid = [];
const contactsAi = {
  deepContactCtx: (o) => ({ ...o }),
  getBrandContacts: async (brand) => { paid.push(brand); return { contacts: [{ name: 'Sam Hill', title: 'Owner', email: `sam@${brand.split(' ')[0].toLowerCase()}.test`, source: 'site' }], addressLadder: {} }; },
  webSearchJson: async () => ({ text: '{"name": null}', citations: [] }),
};
// The free steps, by website.
const SITES = {
  'https://hoop.test': { personalEmail: 'rosa@hoop.test', people: [{ name: 'Rosa Diaz', title: 'Owner' }] },
  'https://corner.test': { roleEmail: 'info@corner.test', people: [] },
  'https://fade.test': { people: [] },
  'https://glow.test': { roleEmail: 'hello@glow.test', people: [] },
};
const freeDeps = {
  places: { lookupPlaceById: async () => null },
  site: { findSiteEmail: async (url) => SITES[url] || null },
  ig: { findInstagram: async (url) => (url === 'https://fade.test' ? { handle: 'fadebarbers', scope: 'business' } : null) },
};

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await TS.ensureTables(P); await CP.ensureTables(P); await CB.ensureTables(P); await OL.ensureTable(P);
  const clean = async () => {
    for (const t of ['university_contacts', 'university_market_runs', 'university_crm', 'university_touches', 'university_drafts', 'university_brand_engagement',
      'university_social_brands', 'university_owner_lookups']) await P.query(`DELETE FROM ${t} WHERE university_id = $1`, [U]).catch(() => {});
    await P.query(`DELETE FROM university_research_claims WHERE team_id LIKE 'ft:%'`);
    await P.query(`DELETE FROM university_teams WHERE university_id = $1`, [U]);
    await P.query(`DELETE FROM university_market_seen WHERE market_key = $1`, [MK]);
    await P.query(`DELETE FROM university_discovery_cells WHERE market_key = $1`, [MK]).catch(() => {});
    await P.query(`DELETE FROM universities WHERE id = $1`, [U]);
  };
  await clean();

  await P.query(`INSERT INTO universities (id, name, short_name, location) VALUES ($1,'Free Test College','FTC','1 College Way, Freetown, CA 90000')`, [U]);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, market_key) VALUES
    ('ft:bb',$1,'Basketball','basketball',$2), ('ft:sb',$1,'Softball','softball',$2), ('ft:soc',$1,'Soccer','soccer',$2)`, [U, MK]);
  const biz = async (name, kind, i, row) => {
    await P.query(`INSERT INTO university_market_seen (market_key, brand, place_id, category, types, primary_type, address, distance_m, fit) VALUES ($1,$2,$3,'local',$4::jsonb,$5,'x',$6,60)`,
      [MK, name, 'fp-' + i, JSON.stringify([kind]), kind, 800 + i * 100]);
    if (row) await P.query(`INSERT INTO university_contacts (university_id, market_key, brand, place_id, website, phone, status) VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
      [U, MK, name, 'fp-' + i, row.website || null, row.phone || null]);
  };
  await biz('Hoop City Gym', 'gym', 0, { website: 'https://hoop.test' });           // a named owner, free
  await biz('Corner Cafe', 'cafe', 1, { website: 'https://corner.test' });          // a shared inbox, no name
  await biz('Fade Barbers', 'barber_shop', 2, { website: 'https://fade.test' });    // Instagram only
  await biz('Taco Spot', 'mexican_restaurant', 3, { phone: '(714) 555-0101' });     // a phone only
  await biz('Glow Smoothies', 'cafe', 4, { website: 'https://glow.test' });         // a shared inbox, no name
  await biz('Nothing Bakery', 'bakery', 5, {});                                     // nothing free: no card
  for (const b of ['Grip Socks Co', 'Hydra Drink']) {
    await P.query(`INSERT INTO university_social_brands (university_id, brand, website, program_url, category, sports, proof_date, offer, evidence)
                   VALUES ($1,$2,$3,$4,'apparel',ARRAY['all'],NOW(),'free gear for athletes','program states no minimum')`,
      [U, b, `https://${b.split(' ')[0].toLowerCase()}.test`, `https://${b.split(' ')[0].toLowerCase()}.test/athletes`]);
  }

  // ── THE ESTIMATE: flat for the school ────────────────────────────────────
  const e3 = await CN.estimate(P, U);
  ok('the estimate is a free night: 3 teams x 2 = 6 cards, 3 social', e3.ok && e3.free && e3.cards === 6 && e3.socialCards === 3 && e3.localCards === 3, e3);
  ok('  the names budget is one number for the school', e3.namesUsd === CN.NAMES_USD && e3.namesFound > 0, e3);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, market_key) VALUES
    ('ft:vb',$1,'Volleyball','volleyball',$2), ('ft:wp',$1,'Water Polo','water polo',$2), ('ft:tn',$1,'Tennis','tennis',$2)`, [U, MK]);
  const e6 = await CN.estimate(P, U);
  ok('COST PER SCHOOL DOES NOT SCALE WITH TEAMS: names and discovery the same for 3 teams and 6', e6.namesUsd === e3.namesUsd && e6.discoveryUsd === e3.discoveryUsd, { e3: [e3.namesUsd, e3.discoveryUsd], e6: [e6.namesUsd, e6.discoveryUsd] });
  ok('  only the per-card part grows (writing and listing details)', e6.writerUsd > e3.writerUsd, { e3: e3.writerUsd, e6: e6.writerUsd });
  ok('  and it is printed per school', /for the school -- names \$\d+\.\d\d and discovery \$\d+\.\d\d \(flat\)/.test(CN.formatEstimate(e6)), CN.formatEstimate(e6));
  await P.query(`DELETE FROM university_teams WHERE id IN ('ft:vb','ft:wp','ft:tn')`);

  // ── THE NIGHT, no names budget: what the free sources alone make ──────────
  const night = '2026-10-20';
  const r = await CN.runNight(P, U, { ai, contactsAi, freeDeps, night, names: false });
  const cards = (await P.query(`SELECT * FROM university_drafts WHERE university_id = $1 AND night = $2`, [U, night])).rows;
  const by = Object.fromEntries(cards.map((d) => [d.brand_name, d]));
  ok('every team gets its two: 6 cards, none short', r.ok && r.cards === 6 && r.short.length === 0, { cards: r.cards, short: r.short, perTeam: r.perTeam });
  ok('NOTHING PAID ALL NIGHT: the contact lookup was never called', paid.length === 0, paid);
  ok('  nothing bought for tomorrow', r.replenish && r.replenish.found === 0 && /free nights/.test(r.replenish.stoppedFor || ''), r.replenish);
  ok('  the night cost cents, not dollars', r.costUsd < 0.5, r.spend);
  ok('social brands on top: one a team', cards.filter((d) => d.lane === 'social').length === 3);
  const local = cards.filter((d) => d.lane !== 'social');
  ok('each local business is carded once, for one team', new Set(local.map((d) => d.brand_name)).size === local.length && local.length === 3, local.map((d) => [d.team_id, d.brand_name]));
  ok('  no business with nothing free to reach it', !by['Nothing Bakery']);
  const nameless = local.filter((d) => !d.contact_name);
  ok('A CARD WITH NO NAME YET is written to the business', nameless.every((d) => /^Hi .+ team,/.test(d.body)), nameless.map((d) => d.body.split('\n')[0]));
  if (by['Hoop City Gym']) ok('  a name the website gave is on the card', by['Hoop City Gym'].contact_name === 'Rosa Diaz' && /^Hi Rosa,/.test(by['Hoop City Gym'].body), by['Hoop City Gym']);
  if (by['Fade Barbers']) ok('  Instagram only: a DM card', by['Fade Barbers'].channel === 'dm' && by['Fade Barbers'].contact_instagram === 'fadebarbers', by['Fade Barbers']);
  if (by['Taco Spot']) ok('  a phone only: a call card', by['Taco Spot'].channel === 'call', by['Taco Spot']);

  // ── BEST FIT: the first pass gives a team only what fits it best ──────────
  const all = (await P.query(`SELECT id, name, sport FROM university_teams WHERE university_id = $1`, [U])).rows;
  let firstPassOk = true;
  for (const t of all) {
    const s = await TS.pitchSlate(P, { universityId: U, teamId: t.id, marketKey: MK, limit: 50, bestFitOnly: true });
    const others = await Promise.all(all.filter((x) => x.id !== t.id).map((x) => TS.pitchSlate(P, { universityId: U, teamId: x.id, marketKey: MK, limit: 50, bestFitOnly: true })));
    const mine = new Set(s.picks.map((p) => p.brand_name));
    if (others.some((o) => o.picks.some((p) => mine.has(p.brand_name)))) firstPassOk = false;
  }
  ok('BEST FIT: no business is offered to two teams on the first pass', firstPassOk);

  // ── FIND THE OWNER, when staff ask ────────────────────────────────────────
  const target = nameless[0];
  const f1 = await OL.findOwner(P, U, 'staff-1', target.id, { ai: contactsAi, free: freeDeps });
  const after = (await P.query(`SELECT * FROM university_drafts WHERE id = $1`, [target.id])).rows[0];
  ok('"Find the owner" puts the name on the card', f1.ok && f1.found && after.contact_name === 'Sam Hill' && paid.length === 1, { f1, paid });
  ok('  the greeting is now their first name', /^Hi Sam,/.test(after.body) || /^Hi Sam,/.test(after.dm_text || '') || after.channel === 'call', after.body);
  const f2 = await OL.findOwner(P, U, 'staff-1', target.id, { ai: contactsAi, free: freeDeps });
  ok('  a second tap costs nothing', f2.ok && f2.cached && f2.costUsd === 0 && paid.length === 1, f2);
  await P.query(`INSERT INTO university_owner_lookups (university_id, brand, user_id, cost_usd, found) VALUES ($1,'(spent)','staff-1',$2,TRUE)`, [U, OL.MONTHLY_USD]);
  const capped = nameless[1] ? await OL.findOwner(P, U, 'staff-1', nameless[1].id, { ai: contactsAi, free: freeDeps }) : { status: 402 };
  ok('  the monthly cap stops it, and says so', capped.status === 402 && paid.length === 1, capped);

  // ── THE NIGHT'S NAMES: one budget for the school ──────────────────────────
  const n = await OL.nameTonight(P, U, night, CN.NAMES_USD, { ai: contactsAi, free: freeDeps });
  const leftNameless = (await P.query(`SELECT COUNT(*)::int n FROM university_drafts WHERE university_id = $1 AND night = $2 AND lane <> 'social' AND contact_name IS NULL`, [U, night])).rows[0].n;
  ok('THE NIGHT BUYS NAMES for the nameless cards, outside the staff cap', n.tried === nameless.length - 1 && n.found === n.tried && leftNameless === 0, { n, leftNameless });
  ok('  never twice: the business staff already looked up was skipped', paid.filter((b) => b === target.brand_name).length === 1, paid);
  ok('  recorded as the night', (await P.query(`SELECT COUNT(*)::int n FROM university_owner_lookups WHERE university_id = $1 AND user_id = 'night'`, [U])).rows[0].n === n.tried);
  const z = await OL.nameTonight(P, U, night, 0, { ai: contactsAi, free: freeDeps });
  ok('  no budget, no lookups', z.tried === 0 && z.stoppedFor === 'no budget', z);

  const txt = CN.formatNight(r);
  ok('THE NIGHT PRINTS ITS COST FOR THE SCHOOL', /COST FOR THE SCHOOL: \$\d+\.\d\d tonight for 3 teams/.test(txt) && /the only part that grows with teams/.test(txt), txt);

  // ── A WHOLE NIGHT WITH THE NAMES BUDGET ON (the default) ──────────────────
  for (const t of ['university_drafts', 'university_owner_lookups', 'university_brand_engagement', 'university_market_runs']) await P.query(`DELETE FROM ${t} WHERE university_id = $1`, [U]);
  await P.query(`DELETE FROM university_research_claims WHERE team_id LIKE 'ft:%'`);
  await P.query(`UPDATE university_contacts SET contact_name = NULL, contact_title = NULL, email = NULL, reachable = FALSE, status = 'pending' WHERE university_id = $1 AND brand <> 'Hoop City Gym'`, [U]);
  paid.length = 0;
  const r2 = await CN.runNight(P, U, { ai, contactsAi, freeDeps, night: '2026-10-21' });
  const c2 = (await P.query(`SELECT * FROM university_drafts WHERE university_id = $1 AND night = '2026-10-21' AND lane <> 'social'`, [U])).rows;
  ok('A FULL NIGHT: free cards, then names bought for the nameless ones from the school budget', r2.ok && r2.cards === 6 && r2.names && r2.names.found > 0
    && r2.names.tried === paid.length && c2.every((d) => d.contact_name), { names: r2.names, paid, cards: c2.map((d) => [d.brand_name, d.contact_name]) });
  ok('  the names spend is its own line, under the cap', r2.spend.namesUsd >= 0 && r2.costUsd <= 5 && /owner names +\$/.test(CN.formatNight(r2)), CN.formatNight(r2));

  await clean();
}

main().then(() => { console.log(OUT.join('\n')); console.log(`\nfailures: ${F}`); process.exit(F ? 1 : 0); })
  .catch((e) => { console.log(OUT.join('\n')); console.log('FAIL threw: ' + (e && e.stack)); process.exit(1); });
