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
  // placesCalls: Google Places requests. Never counted before, so a cold
  // market build was invisible on the COST line and to the nightly cap.
  const meter = { webSearches: 0, aiCalls: 0, placesCalls: 0, cacheHits: 0, cacheMisses: 0, cacheWrites: 0, cacheWriteFails: 0 };
  const result = await als.run(meter, fn);
  return { result, meter };
}

// ── WHO IS ASKING ────────────────────────────────────────────────────────────
// label(fields, fn) runs fn with { site, agentId, athleteId, brand } attached
// to the current meter, so the model entry points in ai.js can write a ledger
// row that says which call site spent the tokens, for which athlete, for
// which agent. Nested labels inherit: a 'contacts' label around the ladder and
// a 'contacts.chamber' label around one source both count against the same
// counters, and the ledger row carries the innermost site.
//
// The counters stay on the ROOT meter (the object run() created). The labelled
// object is a child whose prototype is the parent, so reading a counter still
// works anywhere, and _bump walks to the root before adding.
function label(fields, fn) {
  const outer = current();
  const base = outer || { webSearches: 0, aiCalls: 0, placesCalls: 0, cacheHits: 0, cacheMisses: 0, cacheWrites: 0, cacheWriteFails: 0 };
  const inner = Object.create(base);
  inner.ctx = Object.assign({}, (outer && outer.ctx) || {}, fields || {});
  return als.run(inner, fn);
}

// The innermost context, or {} when no label is in force.
function ctx() {
  const m = current();
  return (m && m.ctx) || {};
}

function _root(m) {
  let r = m;
  while (r) {
    const p = Object.getPrototypeOf(r);
    if (!p || typeof p.webSearches !== 'number') break;
    r = p;
  }
  return r;
}

function _bump(key, n) {
  const m = _root(current());
  if (m && typeof m[key] === 'number') m[key] += (n || 1);
}

module.exports = {
  run,
  current,
  label, ctx,
  bumpWeb: (n) => _bump('webSearches', n),
  bumpAi: (n) => _bump('aiCalls', n),
  bumpHit: (n) => _bump('cacheHits', n),
  bumpMiss: (n) => _bump('cacheMisses', n),
  bumpWrite: (n) => _bump('cacheWrites', n),
  bumpWriteFail: (n) => _bump('cacheWriteFails', n),
  bumpPlaces: (n) => _bump('placesCalls', n),
};
