// server/scripts/verifyMarketCacheShared.js
//
// Prove the 30-day SHARED market pool cache in a REAL environment (real Postgres
// cache table + real web searches). Runs TWO Deal Scans for two DIFFERENT
// synthetic athletes in the SAME market (same school), back to back, and prints
// the market-cache line and the COST line for each.
//
// Expected:
//   SCAN 1 (cold market): market cache key=<market>:local -> MISS (building pool, 5 web searches)
//                         [dealScan] COST ... webSearches=5 ...
//   SCAN 2 (same market): market cache key=<market>:local -> HIT age=..d (0 web searches)
//                         [dealScan] COST ... webSearches=0 cacheHits>=1 ...
//
// The second scan is a DIFFERENT athlete, so a HIT with webSearches=0 proves the
// pool is shared per market, not per athlete or per agent. It uses the real store
// (real DB), so it writes a real cache row for the chosen market.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... DATABASE_URL=postgres://... \
//     node server/scripts/verifyMarketCacheShared.js "University of Alabama" football
//
// Args (optional): [school] [sport]
'use strict';

const scanMeter = require('../scanMeter');

const school = process.argv[2] || 'University of Alabama';
const sport = process.argv[3] || 'football';

if (!process.env.ANTHROPIC_API_KEY) { console.error('ERROR: set ANTHROPIC_API_KEY.'); process.exit(2); }
if (!process.env.DATABASE_URL) { console.error('ERROR: set DATABASE_URL (this proof uses the REAL market cache table).'); process.exit(2); }

const ai = require('../ai');

const mkAthlete = (name) => ({
  name, sport, position: '', year: 'Junior', school, hometown: '',
  instagram: 25000, tiktok: 40000, engagement: 5.5, stats: '', notes: '', tags: [], productWants: '',
});

// Tee console.log so we can echo the market-cache line while it still prints
// normally (so the full [dealScan] search logs stay visible too).
let captured = [];
const origLog = console.log.bind(console);
console.log = (...a) => { const s = a.map(String).join(' '); if (/\[dealScan\] market cache key=/.test(s)) captured.push(s); origLog(...a); };

async function runScan(label, athlete, exclude) {
  captured = [];
  const t0 = Date.now();
  const { result, meter } = await scanMeter.run(() => ai.getDealRecommendations(athlete, 'agent', exclude || [], 'local'));
  const ms = Date.now() - t0;
  return {
    label,
    cacheLine: captured[0] || '(no market-cache line: scan fell to the knowledge path, check search logs above)',
    costLine: `[dealScan] COST lane=local webSearches=${meter.webSearches} aiCalls=${meter.aiCalls} cacheHits=${meter.cacheHits} cacheMisses=${meter.cacheMisses} totalMs=${ms}`,
    count: result.length, poolTotal: result._poolTotal,
  };
}

(async () => {
  const s1 = await runScan('SCAN 1 (Probe A, cold market)', mkAthlete('Probe A'));
  const s2 = await runScan('SCAN 2 (Probe B, SAME market, different athlete)', mkAthlete('Probe B'));

  origLog('\n──────────────── SHARED MARKET CACHE PROOF ────────────────');
  origLog(`school: ${school}`);
  for (const s of [s1, s2]) {
    origLog(`\n=== ${s.label} ===`);
    origLog('  ' + s.cacheLine);
    origLog('  ' + s.costLine);
    origLog(`  returned ${s.count} cards from a pool of ${s.poolTotal}`);
  }
  const shared = /HIT/.test(s2.cacheLine) && / webSearches=0\b/.test(s2.costLine);
  origLog('\n' + (shared
    ? 'PASS: second same-market scan HIT the shared pool with 0 web searches.'
    : 'CHECK: second scan did not show HIT/webSearches=0. If SCAN 1 also fell to the knowledge path (no web pool), the market may not have yielded a cacheable pool; check the search logs above.'));
  process.exit(shared ? 0 : 1);
})().catch((e) => { origLog('THREW:', e); process.exit(1); });
