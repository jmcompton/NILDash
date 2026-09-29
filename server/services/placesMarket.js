'use strict';
// Google Places market discovery: build the FULL local-business pool for a school
// market from Google Places (Nearby Search), instead of asking an LLM to recall a
// handful. Returns candidates in the exact shape the deal-scan market cache stores
// (name/website/category/email/evidence/franchise/market) plus Places extras
// (place_id/lat/lng/rating/user_ratings_total/business_status/price_level/chain).
//
// ── PLACES API (NEW), places.googleapis.com/v1 ─────────────────────────────
// This file used the LEGACY API (maps/api/place/nearbysearch + textsearch) for
// its next_page_token. Google disabled the legacy Places and Geocoding APIs on
// our project, every call came back REQUEST_DENIED, and this returned ok:false
// to a caller that quietly fell back to web search: new businesses discovered a
// day went from 1,512 on Sep 16 to 18, then 0. Everything else here already
// used the New API; this was the last file on the old one.
//
//   geocode   POST places:searchText, one result, the location only.
//   nearby    POST places:searchNearby, one call per business type.
//
// PAGINATION IS GONE. searchNearby returns at most 20 places and has no page
// token; the legacy call paged to 60 per type. So a type that comes back FULL
// (20, meaning there are more) is asked again over four overlapping
// sub-circles, each ranked by popularity: up to 100 per type where the market
// is deep, one call where it is not. Results outside the original circle are
// dropped, so the pool covers the same ground it always did.
//
// A FAILED BUILD IS LOUD. It logs an error naming the market and Google's own
// message, and every build, failed or not, is written to places_market_builds,
// which scripts/nightly-run-report.js reads. ok:false never disappears again.

const { isNationalChain } = require('./nationalChains');
const { isNoLocalAuthority } = require('./dealScanRanking');

const SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';
const SEARCH_NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const RADIUS_M = 8000;
const MAX_PER_CALL = 20;      // searchNearby's ceiling; there is no next page
// Sub-circles for a type that came back full: centred on the four diagonals at
// half the radius, each three quarters of the radius, so together they cover the
// whole original circle (a point on its edge is within 0.74R of a sub-centre).
const TILE_OFFSET = 0.5;
const TILE_RADIUS = 0.75;
const CONCURRENCY = 8;
// Every Places request is counted on the current scan's meter, so a cold
// market build prices itself instead of being the one free thing in the night.
const scanMeter = require('../scanMeter');
const MIN_RATINGS = 10;       // filter: drop businesses with fewer than this many reviews
const REQ_TIMEOUT_MS = 8000;

// primaryTypeDisplayName is Google's own word for what the place IS ("Race
// Course", "Sports Bar"). Same field tier as primaryType. The compliance
// check reads it, because the types list can say `restaurant` for a racetrack.
const NEARBY_FIELDS = ['id', 'displayName', 'formattedAddress', 'shortFormattedAddress', 'types', 'primaryType',
  'primaryTypeDisplayName', 'location', 'rating', 'userRatingCount', 'businessStatus', 'priceLevel'];
const NEARBY_MASK = NEARBY_FIELDS.map((f) => 'places.' + f).join(',');
const GEOCODE_MASK = 'places.id,places.location,places.formattedAddress';

// Places Nearby type -> readable category, aligned with the pitch/card category
// rules (budget: auto/dealership/bank/insurance/realestate; food; service: gym/
// wellness/salon; retail).
const TYPE_CATEGORY = {
  restaurant: 'restaurant', cafe: 'coffee', bar: 'bar', meal_takeaway: 'restaurant', bakery: 'food',
  gym: 'gym', spa: 'wellness', hair_care: 'salon', beauty_salon: 'salon',
  clothing_store: 'apparel', shoe_store: 'apparel', jewelry_store: 'retail',
  car_dealer: 'dealership', car_repair: 'auto', bicycle_store: 'retail', pet_store: 'retail',
  book_store: 'retail', furniture_store: 'retail', home_goods_store: 'retail', hardware_store: 'retail',
  supermarket: 'retail', pharmacy: 'retail', dentist: 'health', physiotherapist: 'health',
  real_estate_agency: 'realestate', insurance_agency: 'insurance', bank: 'bank',
  florist: 'retail', sporting_goods_store: 'retail', veterinary_care: 'wellness',
};
const NEARBY_TYPES = Object.keys(TYPE_CATEGORY);

// WHAT THE PLACE IS, not what we searched for. Google's primaryType first, then
// its description; the search type only when Google gave neither. A primaryType
// that is not one of our kinds ("race_course", "event_venue") is 'local', an
// unknown kind -- never the kind of the search that happened to find it.
function categoryFor(r, searchType) {
  const BC = require('./businessCategory');
  if (r.primary_type || r.primary_type_label) {
    return BC.normalise(r.primary_type) || BC.normalise(r.primary_type_label) || 'local';
  }
  return TYPE_CATEGORY[searchType] || 'local';
}

// The New API's price level is an enum; the pool stored the legacy 0-4 number.
const PRICE_LEVEL = {
  PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

const _geoCache = new Map(); // school (lower) -> { lat, lng }; failures are never cached

// One POST to the New API. Never throws. Returns
//   { ok: true, body }                                  a 2xx with JSON
//   { ok: false, http, status, message }                anything else, with
//                                                       Google's own words
// `opts.fetch` is injectable for tests; production uses the global fetch.
async function _post(url, body, apiKey, fieldMask, opts = {}) {
  const fetch = opts.fetch || globalThis.fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    scanMeter.bumpPlaces();
    const resp = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask },
      body: JSON.stringify(body),
    });
    clearTimeout(t);
    let json = null;
    try { json = await resp.json(); } catch (_) { json = null; }
    if (!resp.ok) {
      const err = (json && json.error) || {};
      return { ok: false, http: resp.status, status: err.status || 'HTTP_' + resp.status,
        message: String(err.message || 'no message').slice(0, 300) };
    }
    return { ok: true, body: json || {} };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, http: null, status: e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK',
      message: String(e.message || 'fetch failed').slice(0, 300) };
  }
}

const _fail = (r) => `${r.status}: ${r.message}`;

// Resolve a school name or a campus address to { lat, lng } with Places Text
// Search (New). Same name and shape as before, so server/index.js keeps working:
// { coords, calls } and now `error`, Google's reason when it could not answer.
async function geocodeSchool(school, apiKey, opts = {}) {
  const key = String(school || '').trim().toLowerCase();
  if (!key) return { coords: null, calls: 0, error: 'no query' };
  if (_geoCache.has(key)) return { coords: _geoCache.get(key), calls: 0 };
  const r = await _post(SEARCH_TEXT_URL, { textQuery: String(school).trim(), pageSize: 1 }, apiKey, GEOCODE_MASK, opts);
  if (!r.ok) {
    console.error(`[placesMarket] GEOCODE FAILED for "${school}": ${_fail(r)}`);
    return { coords: null, calls: 1, error: _fail(r) };
  }
  const p = Array.isArray(r.body.places) ? r.body.places[0] : null;
  const loc = p && p.location;
  if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) {
    console.error(`[placesMarket] GEOCODE FAILED for "${school}": Places returned no location`);
    return { coords: null, calls: 1, error: 'no result for that query' };
  }
  const coords = { lat: loc.latitude, lng: loc.longitude };
  _geoCache.set(key, coords);
  return { coords, calls: 1 };
}

// A New-API place, in the legacy shape the rest of this file (and everything
// downstream of the pool) was written against.
function _legacyShape(p) {
  return {
    place_id: p.id || null,
    name: (p.displayName && p.displayName.text) || null,
    vicinity: p.shortFormattedAddress || p.formattedAddress || null,
    formatted_address: p.formattedAddress || null,
    types: Array.isArray(p.types) ? p.types : [],
    primary_type: p.primaryType || null,
    primary_type_label: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || null,
    geometry: { location: p.location ? { lat: p.location.latitude, lng: p.location.longitude } : {} },
    rating: p.rating != null ? p.rating : null,
    user_ratings_total: p.userRatingCount != null ? p.userRatingCount : 0,
    business_status: p.businessStatus || null,
    price_level: p.priceLevel && PRICE_LEVEL[p.priceLevel] != null ? PRICE_LEVEL[p.priceLevel] : null,
  };
}

async function _nearby(center, radius, type, apiKey, opts) {
  const r = await _post(SEARCH_NEARBY_URL, {
    includedTypes: [type], maxResultCount: MAX_PER_CALL, rankPreference: 'POPULARITY',
    locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius } },
  }, apiKey, NEARBY_MASK, opts);
  if (!r.ok) return { ok: false, error: _fail(r), results: [] };
  return { ok: true, results: (r.body.places || []).map(_legacyShape) };
}

// Metres to a lat/lng offset at this latitude.
function _offset(c, dNorth, dEast) {
  return { lat: c.lat + dNorth / 111320, lng: c.lng + dEast / (111320 * Math.cos((c.lat * Math.PI) / 180)) };
}
function _distance(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// One business type. The centre circle first; the four sub-circles only when
// the centre came back full. Returns { type, results, calls, errors, saturated }.
async function _nearbyType(center, type, apiKey, opts = {}) {
  const errors = [];
  const first = await _nearby(center, RADIUS_M, type, apiKey, opts);
  let calls = 1;
  if (!first.ok) { errors.push(first.error); return { type, results: [], calls, errors, saturated: false }; }
  const results = first.results.slice();
  const saturated = first.results.length >= MAX_PER_CALL;
  if (saturated) {
    const d = RADIUS_M * TILE_OFFSET / Math.SQRT2;
    const tiles = [[d, d], [d, -d], [-d, d], [-d, -d]].map(([n, e]) => _offset(center, n, e));
    const more = await Promise.all(tiles.map((c) => _nearby(c, RADIUS_M * TILE_RADIUS, type, apiKey, opts)));
    calls += more.length;
    for (const m of more) {
      if (!m.ok) { errors.push(m.error); continue; }
      for (const r of m.results) {
        const loc = r.geometry.location;
        // The pool covers the same circle it always did.
        if (loc.lat != null && _distance(center, loc) <= RADIUS_M) results.push(r);
      }
    }
  }
  return { type, results, calls, errors, saturated };
}

async function _limit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]); }
  }));
  return out;
}

// ── EVERY BUILD IS WRITTEN DOWN ─────────────────────────────────────────────
// places_market_builds (store.js). Best effort: a failure to record is logged,
// never allowed to fail the build it describes.
async function recordBuild(row) {
  try {
    const { pool } = require('../store');
    await pool.query(
      `INSERT INTO places_market_builds (query, source, ok, reason, pool_size, raw_size, places_calls, failed_calls, saturated_types, ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [String(row.query || '').slice(0, 200), row.source || null, !!row.ok, row.reason ? String(row.reason).slice(0, 500) : null,
        row.poolSize || 0, row.rawSize || 0, row.placesCalls || 0, row.failedCalls || 0, row.saturatedTypes || 0, row.ms || 0]);
  } catch (e) {
    console.error('[placesMarket] could not record the build in places_market_builds:', e.message);
  }
}

// Build the full school-market pool from Places. Returns:
// { ok, candidates, placesCalls, ms, poolBeforeFilter, geocoded, reason? }
// `school` is anything Places can find: a school name or a street address.
// opts: { source } labels the caller in places_market_builds; { fetch } for tests;
// { record: false } skips the row.
async function buildMarketPoolFromPlaces(school, opts = {}) {
  const t0 = Date.now();
  const source = opts.source || 'deal-scan';
  const done = async (res, extra = {}) => {
    res.ms = Date.now() - t0;
    if (!res.ok) {
      // LOUD. console.error, the market, Google's words, and what it means.
      console.error(`[placesMarket] MARKET BUILD FAILED query="${school}" source=${source}: ${res.reason}. `
        + 'This market got no Places discovery; the caller falls back to web search only. '
        + 'Recorded in places_market_builds (scripts/nightly-run-report.js).');
    }
    if (opts.record !== false) {
      await recordBuild({ query: school, source, ok: res.ok, reason: res.reason || extra.warning || null,
        poolSize: (res.candidates || []).length, rawSize: res.poolBeforeFilter || 0, placesCalls: res.placesCalls || 0,
        failedCalls: extra.failedCalls || 0, saturatedTypes: extra.saturatedTypes || 0, ms: res.ms });
    }
    return res;
  };

  const apiKey = (process.env.GOOGLE_PLACES_API_KEY || '').trim();
  if (!apiKey) return done({ ok: false, candidates: [], placesCalls: 0, reason: 'no_api_key: GOOGLE_PLACES_API_KEY is not set' });

  const geo = await geocodeSchool(school, apiKey, opts);
  let placesCalls = geo.calls;
  if (!geo.coords) return done({ ok: false, candidates: [], placesCalls, reason: 'geocode_failed: ' + (geo.error || 'unknown') });
  const center = geo.coords;

  const perType = await _limit(NEARBY_TYPES, CONCURRENCY, (type) => _nearbyType(center, type, apiKey, opts));

  // Dedupe on place_id across every type. The search type is only a fallback
  // for the category now (categoryFor below): it said what we SEARCHED for, not
  // what the place is, and every racetrack or bowling alley with a kitchen came
  // back from the restaurant search first and was filed as a restaurant.
  const byId = new Map();
  const errors = [];
  let saturatedTypes = 0, failedCalls = 0;
  for (const { type, results, calls, errors: errs, saturated } of perType) {
    placesCalls += calls;
    if (saturated) saturatedTypes++;
    if (errs.length) { failedCalls += errs.length; errors.push(`${type}: ${errs[0]}`); }
    for (const r of results) {
      if (!r || !r.place_id || byId.has(r.place_id)) continue;
      byId.set(r.place_id, { r, type });
    }
  }
  const poolBeforeFilter = byId.size;

  // Every call failed: nothing was learned about this market. A failure, not
  // an empty market.
  if (!poolBeforeFilter && errors.length) {
    return done({ ok: false, candidates: [], placesCalls, poolBeforeFilter, geocoded: center,
      reason: `nearby_failed on ${errors.length} of ${NEARBY_TYPES.length} types: ${errors[0]}` }, { failedCalls });
  }
  if (errors.length) {
    console.error(`[placesMarket] PARTIAL BUILD query="${school}": ${errors.length} of ${NEARBY_TYPES.length} types failed, `
      + `e.g. ${errors[0]}`);
  }

  // Filter: OPERATIONAL only, >= MIN_RATINGS reviews. Flag chains, never drop them.
  // HARD DROP the no-local-authority corporate brands (Walmart, banks, national
  // pharmacy/grocery, gas stations): no local manager can approve a deal there, so
  // they are removed from the pool entirely rather than ranked. This does NOT narrow
  // the Places pull (every type/radius is still fetched); it filters the results.
  let dropClosed = 0, dropThin = 0, dropCorporate = 0, chains = 0;
  const candidates = [];
  for (const { r, type } of byId.values()) {
    if (r.business_status && r.business_status !== 'OPERATIONAL') { dropClosed++; continue; }
    const ratings = Number(r.user_ratings_total) || 0;
    if (ratings < MIN_RATINGS) { dropThin++; continue; }
    if (isNoLocalAuthority(r.name)) { dropCorporate++; continue; }
    const chain = isNationalChain(r.name);
    if (chain) chains++;
    const loc = (r.geometry && r.geometry.location) || {};
    candidates.push({
      // Exact shape the market cache stores:
      name: r.name,
      website: null,                       // nearby has no website; lookupPlace fills later
      category: categoryFor(r, type),
      email: null,
      evidence: null,                      // scorer writes the rationale, not discovery
      franchise: false,                    // Places can't assert a locally-owned franchise
      market: 'school',
      // Places extras (pass through the JSONB cache):
      chain,
      place_id: r.place_id,
      types: Array.isArray(r.types) ? r.types : [],
      primary_type: r.primary_type || null,
      primary_type_label: r.primary_type_label || null,
      address: r.vicinity || r.formatted_address || null,
      lat: loc.lat != null ? loc.lat : null,
      lng: loc.lng != null ? loc.lng : null,
      rating: r.rating != null ? r.rating : null,
      user_ratings_total: ratings,
      business_status: r.business_status || 'OPERATIONAL',
      price_level: r.price_level != null ? r.price_level : null,
    });
  }

  const ms = Date.now() - t0;
  console.log(`[placesMarket] school="${school}" @${center.lat},${center.lng} placesCalls=${placesCalls} raw=${poolBeforeFilter} -> pool=${candidates.length} (dropped closed=${dropClosed} thinReviews=${dropThin} corporate=${dropCorporate}, flaggedChains=${chains}, fullTypesTiled=${saturatedTypes}, failedCalls=${failedCalls}) in ${ms}ms`);
  // A market with places but none that survive the filter is still a real
  // answer (ok, empty), not a failure; the caller already treats it as "nothing".
  return done({ ok: true, candidates, placesCalls, poolBeforeFilter, geocoded: center,
    ...(errors.length ? { warning: `${errors.length} type call(s) failed: ${errors[0]}` } : {}) },
  { failedCalls, saturatedTypes, warning: errors.length ? `partial: ${errors.length} type(s) failed, e.g. ${errors[0]}` : null });
}

module.exports = { categoryFor, buildMarketPoolFromPlaces, geocodeSchool, recordBuild, NEARBY_TYPES, TYPE_CATEGORY,
  RADIUS_M, MAX_PER_CALL, SEARCH_NEARBY_URL, SEARCH_TEXT_URL, NEARBY_MASK, _legacyShape };
