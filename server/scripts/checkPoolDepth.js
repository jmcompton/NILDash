// server/scripts/checkPoolDepth.js
//
// Measure the REAL Deal Scan local pool depth for a real-school market. Runs the
// actual getDealRecommendations web-search path and reports the pool size, so we
// can confirm a real market yields the 30+ candidate pool the pagination needs.
//
// It needs ANTHROPIC_API_KEY (a live web search + scoring call), but NOT a
// database: the market cache is stubbed to always miss, so every run does a fresh
// live search and prints the true first-scan pool size.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node server/scripts/checkPoolDepth.js
//   ANTHROPIC_API_KEY=sk-ant-... node server/scripts/checkPoolDepth.js "University of Alabama" football Tuscaloosa
//
// Args (all optional): [school] [sport] [hometown]
'use strict';

const path = require('path');

// Stub ./store so no Postgres is needed and the market cache always MISSES,
// forcing a fresh live web search that reports the honest first-scan pool.
const storePath = require.resolve(path.join(__dirname, '..', 'store.js'));
require.cache[storePath] = {
  id: storePath, filename: storePath, loaded: true,
  exports: {
    getMarketCache: async () => null,
    setMarketCache: async () => {},
    pool: { query: async () => ({ rows: [] }) },
  },
};

const ai = require('../ai');

const school = process.argv[2] || 'University of Alabama';
const sport = process.argv[3] || 'football';
const hometown = process.argv[4] || '';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ERROR: set ANTHROPIC_API_KEY to run a live pool-depth check.');
  process.exit(2);
}

const athlete = {
  name: 'Pool Depth Probe', sport, position: '', year: 'Junior',
  school, hometown, instagram: 25000, tiktok: 40000, engagement: 5.5,
  stats: '', notes: '', tags: [], productWants: '',
};

(async () => {
  console.log(`\nRunning a fresh local Deal Scan for: ${school}${hometown ? ` (hometown ${hometown})` : ''}, sport=${sport}`);
  console.log('Watch for the line: [dealScan] local shownSet=.. poolAfterExclude=.. poolTotal=.. source=web\n');
  const t0 = Date.now();
  const result = await ai.getDealRecommendations(athlete, 'agent', [], 'local');
  const ms = Date.now() - t0;

  const poolTotal = result && result._poolTotal;
  const source = (result && result[0] && result[0].source) || 'unknown';
  console.log('\n──────────── POOL DEPTH RESULT ────────────');
  console.log(`school:        ${school}`);
  console.log(`poolTotal:     ${poolTotal != null ? poolTotal : 'n/a'}  (target 30+)`);
  console.log(`returned page: ${result.length}`);
  console.log(`poolExhausted: ${!!result._poolExhausted}`);
  console.log(`card source:   ${source}   (want "web" for a real market)`);
  console.log(`elapsed:       ${ms}ms`);
  console.log(`first page:    ${result.map((c) => c.brand).join(', ')}`);
  console.log('───────────────────────────────────────────');
  if (source !== 'web') console.log('WARNING: source is not "web". The web pool did not build; check the search logs above.');
  else if (poolTotal != null && poolTotal < 30) console.log('NOTE: poolTotal < 30 for a real market. Widen per-category yield or geography.');
  else console.log('OK: real market built a 30+ web pool.');
  process.exit(0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
