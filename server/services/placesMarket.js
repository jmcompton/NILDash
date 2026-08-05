'use strict';
// Google Places market discovery: build the FULL local-business pool for a school
// market from Google Places (Nearby Search), instead of asking an LLM to recall a
// handful. Returns candidates in the exact shape the deal-scan market cache stores
// (name/website/category/email/evidence/franchise/market) plus Places extras
// (place_id/lat/lng/rating/user_ratings_total/business_status/price_level/chain).
//
// Uses the LEGACY Places API (nearbysearch + textsearch) because only it supports
// pagination (next_page_token, up to 3 pages / 60 results per type). The key must
// have the "Places API" (legacy) product enabled, same GOOGLE_PLACES_API_KEY.

const { isNationalChain } = require('./nationalChains');

const NEARBY_URL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const TEXT_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const RADIUS_M = 8000;
const MAX_PAGES = 3;          // Places caps pagination at 3 pages (60 results) per query
const PAGE_DELAY_MS = 2100;   // Google needs ~2s before a next_page_token activates
const MIN_RATINGS = 10;       // filter: drop businesses with fewer than this many reviews
const REQ_TIMEOUT_MS = 8000;

// Places Nearby type -> readable category, aligned with the pitch/card category
// rules (budget: auto/dealership/bank/insurance/realestate; food; service: gym/
// wellness/salon; retail).
const TYPE_CATEGORY = {
  restaurant: 'restaurant', cafe: 'coffee', bar: 'bar', meal_takeaway: 'restaurant', bakery: 'food',
  gym: 'gym', spa: 'wellness', hair_care: 'salon', beauty_salon: 'salon',
  clothing_store: 'apparel', shoe_store: 'apparel', jewelry_store: 'retail',
  car_dealer: 'dealership', car_repair: 'auto', bicycle_store: 'retail', pet_store: 'retail',
  book_store: 'retail', furniture_store: 'retail', home_goods_store: 'retail', hardware_store: 'retail',
  supermarket: 'retail', pharmacy: 'retail', dentist: 'medspa', physiotherapist: 'wellness',
  real_estate_agency: 'realestate', insurance_agency: 'insurance', bank: 'bank',
  florist: 'retail', sporting_goods_store: 'retail', veterinary_care: 'wellness',
};
const NEARBY_TYPES = Object.keys(TYPE_CATEGORY);

const _geoCache = new Map(); // school (lower) -> { lat, lng } | null

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function _getJson(url, params) {
  const qs = new URLSearchParams(params).toString();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const resp = await fetch(`${url}?${qs}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return { status: 'HTTP_' + resp.status, results: [] };
    return await resp.json();
  } catch (e) {
    clearTimeout(t);
    return { status: 'ERROR_' + (e.message || 'fetch'), results: [] };
  }
}

// Resolve a school name to { lat, lng } via Places Text Search (cached in-process).
async function geocodeSchool(school, apiKey) {
  const key = String(school || '').trim().toLowerCase();
  if (!key) return { coords: null, calls: 0 };
  if (_geoCache.has(key)) return { coords: _geoCache.get(key), calls: 0 };
  const data = await _getJson(TEXT_URL, { query: school, key: apiKey });
  const loc = data && Array.isArray(data.results) && data.results[0]
    && data.results[0].geometry && data.results[0].geometry.location;
  const coords = loc ? { lat: loc.lat, lng: loc.lng } : null;
  _geoCache.set(key, coords);
  if (!coords) console.warn(`[placesMarket] geocode failed for "${school}" status=${data && data.status}`);
  return { coords, calls: 1 };
}

// One Nearby type, paged up to MAX_PAGES. Returns { results, calls }.
async function _nearbyType(lat, lng, type, apiKey) {
  const out = [];
  let calls = 0;
  let params = { location: `${lat},${lng}`, radius: String(RADIUS_M), type, key: apiKey };
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await _getJson(NEARBY_URL, params);
    calls++;
    if (Array.isArray(data.results)) out.push(...data.results);
    const token = data.next_page_token;
    if (!token || data.status !== 'OK') break;
    await _sleep(PAGE_DELAY_MS); // token needs a moment to become valid
    params = { pagetoken: token, key: apiKey };
  }
  return { results: out, calls };
}

// Build the full school-market pool from Places. Returns:
// { ok, candidates, placesCalls, ms, poolBeforeFilter, geocoded, reason? }
async function buildMarketPoolFromPlaces(school) {
  const t0 = Date.now();
  const apiKey = (process.env.GOOGLE_PLACES_API_KEY || '').trim();
  if (!apiKey) return { ok: false, candidates: [], placesCalls: 0, ms: 0, reason: 'no_api_key' };

  const geo = await geocodeSchool(school, apiKey);
  let placesCalls = geo.calls;
  if (!geo.coords) return { ok: false, candidates: [], placesCalls, ms: Date.now() - t0, reason: 'geocode_failed' };
  const { lat, lng } = geo.coords;

  // All types in parallel; each paginates internally.
  const perType = await Promise.all(NEARBY_TYPES.map((type) =>
    _nearbyType(lat, lng, type, apiKey).then((r) => ({ type, ...r }))));

  // Dedupe on place_id across every type. First type that returns a place wins its
  // category (search types are ordered so food/service/retail lead).
  const byId = new Map();
  for (const { type, results, calls } of perType) {
    placesCalls += calls;
    for (const r of results) {
      if (!r || !r.place_id || byId.has(r.place_id)) continue;
      byId.set(r.place_id, { r, type });
    }
  }
  const poolBeforeFilter = byId.size;

  // Filter: OPERATIONAL only, >= MIN_RATINGS reviews. Flag chains, never drop them.
  let dropClosed = 0, dropThin = 0, chains = 0;
  const candidates = [];
  for (const { r, type } of byId.values()) {
    if (r.business_status && r.business_status !== 'OPERATIONAL') { dropClosed++; continue; }
    const ratings = Number(r.user_ratings_total) || 0;
    if (ratings < MIN_RATINGS) { dropThin++; continue; }
    const chain = isNationalChain(r.name);
    if (chain) chains++;
    const loc = (r.geometry && r.geometry.location) || {};
    candidates.push({
      // Exact shape the market cache stores:
      name: r.name,
      website: null,                       // nearby has no website; lookupPlace fills later
      category: TYPE_CATEGORY[type] || 'local',
      email: null,
      evidence: null,                      // scorer writes the rationale, not discovery
      franchise: false,                    // Places can't assert a locally-owned franchise
      market: 'school',
      // Places extras (pass through the JSONB cache):
      chain,
      place_id: r.place_id,
      types: Array.isArray(r.types) ? r.types : [],
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
  console.log(`[placesMarket] school="${school}" @${lat},${lng} placesCalls=${placesCalls} raw=${poolBeforeFilter} -> pool=${candidates.length} (dropped closed=${dropClosed} thinReviews=${dropThin}, flaggedChains=${chains}) in ${ms}ms`);
  return { ok: true, candidates, placesCalls, ms, poolBeforeFilter, geocoded: geo.coords };
}

module.exports = { buildMarketPoolFromPlaces, geocodeSchool, NEARBY_TYPES, TYPE_CATEGORY };
