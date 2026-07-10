// server/scanMeter.js
// Per-scan cost meter. A single Deal Scan request runs one lane; this counts the
// real API calls and cache outcomes for THAT request so the endpoint can log an
// honest [dealScan] COST line and prove whether the caches are working.
//
// Implemented with AsyncLocalStorage so parallel scans (the three lanes fire as
// separate HTTP requests) each get their own isolated counter with no leakage,
// and so the deep call sites (oneShotWebSearch, oneShot, the Postgres cache
// reads/writes in store.js) can bump the current scan's counter without threading
// a context object through every function signature.
'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

function current() {
  return als.getStore() || null;
}

// Run fn inside a fresh meter context. Returns { result, meter }.
async function run(fn) {
  const meter = { webSearches: 0, aiCalls: 0, cacheHits: 0, cacheMisses: 0, cacheWrites: 0, cacheWriteFails: 0 };
  const result = await als.run(meter, fn);
  return { result, meter };
}

function _bump(key, n) {
  const m = current();
  if (m && typeof m[key] === 'number') m[key] += (n || 1);
}

module.exports = {
  run,
  current,
  bumpWeb: (n) => _bump('webSearches', n),
  bumpAi: (n) => _bump('aiCalls', n),
  bumpHit: (n) => _bump('cacheHits', n),
  bumpMiss: (n) => _bump('cacheMisses', n),
  bumpWrite: (n) => _bump('cacheWrites', n),
  bumpWriteFail: (n) => _bump('cacheWriteFails', n),
};
