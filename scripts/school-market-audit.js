'use strict';
// ── IS ANY ATHLETE GETTING ANOTHER TOWN'S BUSINESSES? ──────────────────────
//
// "Columbia University" resolved to Columbia, Missouri. This answers, for every
// athlete on every roster: the school, the market the resolver gives it now,
// and the markets their cards of the last 30 days were actually built in
// (outreach_queue.market_key). A card market that is not the school's market
// is an athlete who was pitched to the wrong town.
//
//   (default)  free: the resolver and the stored cards only
//   --verify   also locate each named school with Places (cached 30 days,
//              about two calls per school) and compare against its market
//   --apply    with --verify: save each correction (school_market_overrides),
//              so every path uses the school's real town from now on
//
//   node scripts/school-market-audit.js [--verify] [--apply]
//   /api/admin/scripts/school-market-audit?text=1   (&verify=1, &apply=1)
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const VERIFY = process.argv.includes('--verify');
const APPLY = process.argv.includes('--apply');
// The names that are both a school and a city somewhere else.
const SHARED = /\b(columbia|miami|washington|jackson|charleston|auburn|dayton)\b/i;

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const SMC = require(ROOT + 'server/services/schoolMarketCheck.js');
  await SMC.load(P);
  const job = require(ROOT + 'server/jobs/outreachQueue.js');
  let canon = (x) => String(x || '').trim().toLowerCase();
  try { canon = require(ROOT + 'server/services/regionKey').canonicalRegion || canon; } catch (_) {}
  const SG = require(ROOT + 'server/services/schoolGeocode.js');

  const rows = (await P.query(`
    SELECT a.id, a.data, a.data->>'name' AS name, a.data->>'school' AS school, u.name AS agent, u.email AS agent_email,
           COALESCE(u.archived, FALSE) AS archived
      FROM athletes a JOIN users u ON u.id = a.agent_id
     WHERE COALESCE(u.role, 'agent') IN ('agent', 'admin') AND COALESCE(a.data->>'school', '') <> ''`)).rows;
  const cards = (await P.query(`
    SELECT athlete_id, market_key, COUNT(*)::int AS n, MAX(created_at) AS last
      FROM outreach_queue WHERE created_at > NOW() - INTERVAL '30 days' AND market_key IS NOT NULL
     GROUP BY athlete_id, market_key`)).rows;
  const byAth = new Map();
  for (const c of cards) { if (!byAth.has(c.athlete_id)) byAth.set(c.athlete_id, []); byAth.get(c.athlete_id).push(c); }

  // The cached Places answer for a school the rules do not place (free).
  const geoCache = async (school) => {
    try {
      const hit = await store.getBrandEvidence('school:' + String(school).trim().toLowerCase().replace(/\s+/g, ' '), SG.CACHE_LANE, SG.CACHE_DAYS);
      return hit && hit.evidence && hit.evidence.found !== false && hit.evidence.city ? `${hit.evidence.city}, ${hit.evidence.state}` : null;
    } catch (_) { return null; }
  };

  const out = [];
  const schools = new Map();      // school -> resolved market (for --verify)
  for (const a of rows) {
    let p; try { p = job.athleteProfile(a); } catch (_) { p = {}; }
    const market = p && p.hasLocalMarket ? p.market : (await geoCache(a.school));
    const expected = market ? canon(market) : null;
    const theirs = byAth.get(a.id) || [];
    const wrong = expected ? theirs.filter((c) => canon(c.market_key) !== expected) : [];
    out.push({ ...a, market, expected, cards: theirs, wrong });
    if (market && SMC.specific(a.school)) schools.set(a.school.trim(), market);
  }

  console.log(`SCHOOL MARKET AUDIT  ${new Date().toISOString()}  ${rows.length} athletes with a school\n`);

  const hitList = out.filter((x) => x.wrong.length);
  console.log(`1. ATHLETES WHOSE CARDS (LAST 30 DAYS) ARE IN A DIFFERENT MARKET FROM THEIR SCHOOL: ${hitList.length}`);
  for (const x of hitList) {
    console.log(`   ${x.name} (${x.school}) -- agent ${x.agent} <${x.agent_email}>${x.archived ? ' [archived]' : ''}`);
    console.log(`     school's market now: ${x.market}`);
    for (const c of x.wrong) console.log(`     ${c.n} card(s) built in "${c.market_key}" (last ${new Date(c.last).toISOString().slice(0, 10)})`);
  }

  const shared = out.filter((x) => SHARED.test(x.school));
  console.log(`\n2. EVERY ATHLETE AT A SCHOOL NAMED FOR A CITY THAT EXISTS ELSEWHERE (${shared.length})`);
  for (const x of shared) {
    const cm = x.cards.map((c) => `${c.market_key} x${c.n}`).join(', ') || 'no cards in 30 days';
    console.log(`   ${x.school.padEnd(38)} -> ${String(x.market || 'NO MARKET').padEnd(26)} cards: ${cm}  (${x.name}, ${x.agent})`);
  }

  // From this deploy on, a name that is more than one real school stops: no
  // cards until the agent picks on Home.
  const R = require(ROOT + 'server/services/schoolResolver.js');
  const amb = out.map((x) => ({ ...x, amb: R.ambiguity(x.school, { state: x.data && x.data.state }) })).filter((x) => x.amb && x.amb.candidates);
  console.log(`\n2b. NOW ASKED "WHICH SCHOOL IS THIS?" ON HOME, NO CARDS UNTIL PICKED: ${amb.length}`);
  for (const x of amb) {
    const cm = x.cards.map((c) => `${c.market_key} x${c.n}`).join(', ') || 'no cards in 30 days';
    console.log(`   "${x.school}"  ${x.name}, agent ${x.agent} <${x.agent_email}>  -- cards so far: ${cm}`);
    console.log(`      could be: ${x.amb.candidates.map((c) => `${c.name} (${c.city}, ${c.state})`).join('; ')}`);
  }

  const none = out.filter((x) => !x.market && !(R.ambiguity(x.school, { state: x.data && x.data.state }) || {}).candidates);
  console.log(`\n3. NO MARKET YET (the nightly will look the school up with Places): ${none.length}`);
  for (const x of none.slice(0, 40)) console.log(`   ${x.school}  (${x.name}, ${x.agent})`);

  if (VERIFY) {
    console.log(`\n4. EACH NAMED SCHOOL LOCATED WITH PLACES AND COMPARED WITH ITS MARKET (${schools.size} schools, max ${SMC.MAX_KM} km)${APPLY ? '  -- CORRECTIONS SAVED' : '  -- report only; &apply=1 saves'}`);
    let bad = 0, unk = 0;
    for (const [school, market] of schools) {
      const v = await SMC.verify(school, market);
      if (!v.checked) { unk++; console.log(`   ?  ${school} -> ${market}: ${v.why}`); continue; }
      if (v.ok) continue;
      bad++;
      console.log(`   WRONG  ${school} -> ${market}, ${v.km} km from the school (${v.schoolAddress || '?'}); should be ${v.market || '?'}`);
      if (APPLY && v.market) await SMC.saveOverride(P, school, market, v);
    }
    console.log(`   ${schools.size - bad - unk} within ${SMC.MAX_KM} km, ${bad} wrong, ${unk} could not be checked`);
  } else {
    console.log(`\n4. Not located with Places (free run). &verify=1 checks every named school's market against where the school is.`);
  }
}

main()
  .catch((e) => { console.error('school-market-audit FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => { try { await store.pool.end(); } catch (_) {} });
