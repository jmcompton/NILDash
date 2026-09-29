'use strict';
// ── REBUILD A PLACES MARKET POOL, AND SAY HOW MANY IT FOUND ─────────────────
//
// Runs services/placesMarket (Places API New) for an agent market and/or a
// university campus, and prints the pool size, the raw count before the
// filters, how many business types came back full and were tiled, and how
// many requests it spent. A failure prints Google's own reason.
//
//   node scripts/places-rebuild.js --market "Auburn University"
//   node scripts/places-rebuild.js --campus univ-cypress
//   node scripts/places-rebuild.js --market "Auburn University" --campus univ-cypress
//   /api/admin/scripts/places-rebuild?market=Auburn%20University&campus=univ-cypress&text=1
//
// --market takes a school name, resolved the way Deal Scan resolves it, and
// WRITES the result where a scan would: the market cache (deal_scan_market_cache)
// and the market pool (market_business_seen), so the nightly run can use it.
// --campus takes a university id and writes university_market_seen, the
// university's own pool, through services/teamScan. --no-write prints only.
//
// Spends Places requests (roughly 30 to 150 a market). The key is read from
// GOOGLE_PLACES_API_KEY and never printed.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const PM = require(ROOT + 'server/services/placesMarket.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

function argsOf(argv) {
  const out = { write: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--market') out.market = argv[++i];
    else if (argv[i] === '--campus') out.campus = argv[++i];
    else if (argv[i] === '--no-write') out.write = false;
  }
  return out;
}

function summary(label, r) {
  if (!r.ok) return `${label}\n  FAILED: ${r.reason}\n  ${r.placesCalls || 0} Places request(s) spent`;
  const cats = {};
  for (const c of r.candidates) cats[c.category] = (cats[c.category] || 0) + 1;
  const top = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(', ');
  return `${label}\n  ${r.candidates.length} businesses in the pool (${r.poolBeforeFilter} found before the filters)`
    + `\n  ${r.placesCalls} Places request(s), ${(r.ms / 1000).toFixed(1)}s${r.warning ? `\n  WARNING: ${r.warning}` : ''}`
    + `\n  by kind: ${top || '-'}`;
}

async function main() {
  const a = argsOf(process.argv.slice(2));
  if (!a.market && !a.campus) {
    console.error('Usage: node scripts/places-rebuild.js [--market "<school name>"] [--campus <university id>] [--no-write]');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  console.log(`PLACES MARKET REBUILD  ${new Date().toISOString()}  (Places API New)\n`);
  let failed = 0;

  if (a.market) {
    const ai = require(ROOT + 'server/ai.js');
    const loc = await ai.getSchoolLocation(a.market);
    const schoolMarket = `${loc.city}, ${loc.state}`;
    const cacheKey = await ai.resolveLocalMarketKey(a.market);
    const r = await PM.buildMarketPoolFromPlaces(a.market, { source: 'rebuild-script' });
    console.log(summary(`AGENT MARKET  "${a.market}"  -> ${schoolMarket}  (cache ${cacheKey})`, r));
    if (!r.ok) failed++;
    else if (a.write && loc.known === false) {
      // Never file a pool under "unknown city": nothing reads that key.
      console.log(`  NOT written: "${a.market}" did not resolve to a town, so there is no market key to file it under`);
      failed++;
    } else if (a.write && r.candidates.length) {
      await store.setMarketCache(cacheKey, r.candidates);
      const rec = await store.recordMarketPool(r.candidates, { schoolMarket });
      console.log(`  written: market cache ${cacheKey}, market pool "${rec.schoolKey}" (${rec.school} businesses)`);
    }
    console.log('');
  }

  if (a.campus) {
    const TS = require(ROOT + 'server/services/teamScan.js');
    await TS.ensureTables(P);
    const uni = (await P.query(`SELECT id, name, location FROM universities WHERE id = $1`, [a.campus])).rows[0];
    if (!uni || !uni.location) { console.log(`CAMPUS  ${a.campus}\n  FAILED: no university with that id, or it has no campus address\n`); failed++; }
    else if (a.write) {
      const { marketPoolKey } = require(ROOT + 'server/services/regionKey.js');
      const marketKey = marketPoolKey(TS.cityOf(uni.location));
      const d = await TS.discover(P, { university: uni, marketKey });
      if (!d.ok) { console.log(`CAMPUS  ${uni.name}, ${uni.location}\n  FAILED: ${d.reason}\n`); failed++; }
      else {
        console.log(`CAMPUS  ${uni.name}, ${uni.location}  (pool "${marketKey}")\n  ${d.kept} businesses in the university pool`
          + ` (${d.found} found, ${d.blocked.length} blocked: ${[...new Set(d.blocked.map((b) => b.key))].join(', ') || 'none'})`
          + `\n  ${d.placesCalls} Places request(s)\n`);
      }
    } else {
      const r = await PM.buildMarketPoolFromPlaces(uni.location, { source: 'rebuild-script' });
      console.log(summary(`CAMPUS  ${uni.name}, ${uni.location}`, r) + '\n');
      if (!r.ok) failed++;
    }
  }
  try { await P.end(); } catch (_) {}
  process.exit(failed ? 1 : 0);
}
if (require.main === module) main().catch((e) => { console.error('places-rebuild: FAILED', e.message); process.exit(1); });
module.exports = { argsOf };
