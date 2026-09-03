// Google Places (New) lookup for reliable local-business contact basics:
// phone + website + maps URL. Cached 30 days in brand_evidence_cache (lane
// 'places') so Google is billed at most once per business per month. Any
// failure (no key, network, bad response) returns null so callers fall back
// to the existing web-search behavior.
const store = require('../store');
const { canonicalRegion } = require('./regionKey');

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_URL = 'https://places.googleapis.com/v1/places/';
// places.id added so callers get a STABLE place_id: it is the brand_engagement
// ledger identity for local businesses (the Homewood store is a different key
// from the Hoover one). types/rating come along because the Deal Scan tier logic
// (dealScanRanking.businessTier) keys on the Places types array.
const PLACE_FIELDS = 'id,displayName,formattedAddress,nationalPhoneNumber,internationalPhoneNumber,websiteUri,googleMapsUri,types,primaryType,businessStatus,rating,userRatingCount';
const FIELD_MASK = PLACE_FIELDS.split(',').map((f) => 'places.' + f).join(',');
const TIMEOUT_MS = 4500;
const CACHE_DAYS = 30;
// Bumped when the cached evidence SHAPE changes. v2 adds place_id/types/rating;
// rows written before that have none, so the key change forces one clean re-fetch
// instead of serving a place_id-less blob the ledger cannot key on.
const CACHE_V = 'v2';

// The region is canonicalised, never taken as the caller spelled it. The card path
// says "Fayetteville, AR" and the outreach workflow says "Fayetteville, Arkansas",
// which cached the same business twice and made every deep lookup re-pay for a
// Places call it already had.
function _key(brand, loc) {
  const b = String(brand || '').trim().toLowerCase();
  const l = canonicalRegion(loc);
  return (l ? `${b} | ${l}` : b) + ` | ${CACHE_V}`;
}

// Shared mapper: Places (New) place resource -> our flat shape.
function _mapPlace(p, fallbackName) {
  return {
    found: true,
    place_id: p.id || null,
    phone: p.nationalPhoneNumber || p.internationalPhoneNumber || null,
    website: p.websiteUri || null,
    address: p.formattedAddress || null,
    mapsUrl: p.googleMapsUri || null,
    name: (p.displayName && p.displayName.text) || fallbackName || null,
    types: Array.isArray(p.types) ? p.types : [],
    primaryType: p.primaryType || null,
    businessStatus: p.businessStatus || null,
    rating: p.rating != null ? p.rating : null,
    userRatingCount: p.userRatingCount != null ? p.userRatingCount : null,
  };
}

// ── "NOTHING" AND "WE COULD NOT ASK" ARE DIFFERENT ANSWERS ──────────────────
//
// lookupPlace returns null four ways -- no API key, an HTTP error, a timeout or
// abort, and Places genuinely having no such place -- and never throws. A caller
// holding only that null cannot tell a place that does not exist from a call
// that did not happen, so any caller that REMEMBERS a null remembers our own
// outage as a fact about the world.
//
// That is exactly what happened to Bentley University: schoolGeocode wrapped
// this call in a try/catch so that a failed lookup would not be cached as "not a
// school", and because this function never throws, that catch could not fire.
// Every failure landed in the branch that writes the negative.
//
// So the honest shape is returned here and lookupPlace becomes a thin wrapper
// over it, unchanged for every existing caller:
//
//   { ok: false, place: null, reason }  we could not ask -- REMEMBER NOTHING
//   { ok: true,  place: null, reason }  we asked; there is no such place
//   { ok: true,  place: {...}, reason } we asked; here it is
//
// This function decides caching for its own lane on the same rule: a live
// "found=0" is cached (it is an answer), an HTTP error or a timeout is not.
async function lookupPlaceResult(brand, locationHint = '') {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return { ok: false, place: null, reason: 'no-api-key' };
  if (!brand || !String(brand).trim()) return { ok: false, place: null, reason: 'no-query' };

  const cacheKey = _key(brand, locationHint);
  try {
    const cached = await store.getBrandEvidence(cacheKey, 'places', CACHE_DAYS);
    if (cached && cached.evidence) {
      const ev = cached.evidence;
      return ev.found === false
        ? { ok: true, place: null, reason: 'cached-not-found' }
        : { ok: true, place: ev, reason: 'cache' };
    }
  } catch (_) { /* fall through to live lookup */ }

  const query = locationHint ? `${brand} ${locationHint}` : String(brand);
  let data = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const resp = await fetch(PLACES_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
    });
    clearTimeout(t);
    // NOT CACHED, and now not silently indistinguishable from an empty result
    // either. A 429 or a 500 says nothing whatsoever about the place.
    if (!resp.ok) {
      console.warn('[places] brand=' + brand + ' http=' + resp.status);
      return { ok: false, place: null, reason: 'http-' + resp.status };
    }
    data = await resp.json();
  } catch (e) {
    console.warn('[places] brand=' + brand + ' error=' + e.message);
    return { ok: false, place: null, reason: 'error:' + e.message };
  }

  const p = data && Array.isArray(data.places) && data.places[0];
  if (!p) {
    try { await store.saveBrandEvidence(cacheKey, 'places', brand, null, { found: false }, 'NONE'); } catch (_) {}
    console.log('[places] brand=' + brand + ' found=0');
    return { ok: true, place: null, reason: 'not-found' };
  }

  const out = _mapPlace(p, brand);
  try { await store.saveBrandEvidence(cacheKey, 'places', brand, out.website, out, 'OK'); } catch (_) {}
  console.log('[places] brand=' + brand + ' found=1 id=' + (out.place_id ? 'y' : 'n') + ' phone=' + (out.phone ? 'y' : 'n') + ' site=' + (out.website ? 'y' : 'n'));
  return { ok: true, place: out, reason: 'found' };
}

// The original contract, unchanged: the place, or null for any reason at all.
// Every existing caller keeps working; callers that need to know WHY -- which
// means any caller that writes the answer down -- use lookupPlaceResult.
async function lookupPlace(brand, locationHint = '') {
  return (await lookupPlaceResult(brand, locationHint)).place;
}

// Geocode any query to { lat, lng } using the Places API (NEW) searchText. The
// market pool builder's geocodeSchool uses the LEGACY API, which is a separate
// product enablement; if legacy is off, that returns null and the autocomplete
// silently loses its bias. This is the New-API path so bias works off the same
// enablement autocomplete itself needs. Cached 30 days.
async function geocodePlace(query) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const q = String(query || '').trim();
  if (!apiKey || !q) return null;
  const cacheKey = `geo:${q.toLowerCase()} | ${CACHE_V}`;
  try {
    const cached = await store.getBrandEvidence(cacheKey, 'places', CACHE_DAYS);
    if (cached && cached.evidence) {
      const ev = cached.evidence;
      return ev.found === false ? null : ev;
    }
  } catch (_) { /* fall through */ }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const resp = await fetch(PLACES_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.location,places.formattedAddress',
      },
      body: JSON.stringify({ textQuery: q, maxResultCount: 1 }),
    });
    clearTimeout(t);
    if (!resp.ok) { console.warn('[places] geocode http=' + resp.status + ' q="' + q + '"'); return null; }
    const data = await resp.json();
    const p = data && Array.isArray(data.places) && data.places[0];
    const loc = p && p.location;
    if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) {
      try { await store.saveBrandEvidence(cacheKey, 'places', q, null, { found: false }, 'NONE'); } catch (_) {}
      return null;
    }
    const out = { found: true, lat: loc.latitude, lng: loc.longitude, address: p.formattedAddress || null };
    try { await store.saveBrandEvidence(cacheKey, 'places', q, null, out, 'OK'); } catch (_) {}
    return out;
  } catch (e) { console.warn('[places] geocode error=' + e.message); return null; }
}

function _mapSuggestions(data) {
  const sugg = (data && Array.isArray(data.suggestions)) ? data.suggestions : [];
  return sugg.map((s) => {
    const p = s && s.placePrediction;
    if (!p || !p.placeId) return null;
    const sf = p.structuredFormat || {};
    return {
      place_id: p.placeId,
      name: (sf.mainText && sf.mainText.text) || (p.text && p.text.text) || '',
      address: (sf.secondaryText && sf.secondaryText.text) || '',
    };
  }).filter((x) => x && x.name);
}

async function _autocompleteCall(body, apiKey) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(AUTOCOMPLETE_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      body: JSON.stringify(body),
    });
    clearTimeout(t);
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.warn('[places] autocomplete http=' + resp.status + ' ' + txt.slice(0, 200));
      return null;
    }
    return await resp.json();
  } catch (e) { clearTimeout(t); console.warn('[places] autocomplete error=' + e.message); return null; }
}

// Autocomplete for the manual "Add a Business" input.
// locationBias is only a SOFT hint: Google still interleaves far-away matches, which
// is why "Mama Goldbergs" for a Birmingham athlete returned Auburn and Muscle Shoals.
// So the primary request uses locationRestriction, which HARD-DROPS anything outside
// the circle. If that returns nothing (genuinely out-of-market business, or too tight
// a radius) we retry with the soft bias and flag those rows outOfMarket so they sort
// last and are labeled, rather than silently interleaving.
async function autocompletePlaces(input, bias = {}) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const q = String(input || '').trim();
  if (!apiKey || q.length < 3) return [];
  const hasBias = bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lng);
  // Places autocomplete caps a circle at 50km.
  const radius = Math.min(Math.max(Number(bias.radiusM) || 50000, 1), 50000);
  const circle = hasBias ? { center: { latitude: bias.lat, longitude: bias.lng }, radius } : null;

  if (circle) {
    const restricted = await _autocompleteCall({ input: q, locationRestriction: { circle } }, apiKey);
    const rows = _mapSuggestions(restricted);
    console.log(`[places] autocomplete q="${q}" mode=restriction center=${bias.lat.toFixed(4)},${bias.lng.toFixed(4)} radiusM=${radius} results=${rows.length}`);
    if (rows.length) return rows.slice(0, 8);
    // Nothing inside the market: fall back to a soft bias, clearly labeled.
    const biased = await _autocompleteCall({ input: q, locationBias: { circle } }, apiKey);
    const wide = _mapSuggestions(biased).map((r) => ({ ...r, outOfMarket: true }));
    console.log(`[places] autocomplete q="${q}" mode=bias-fallback results=${wide.length} (none inside ${radius}m)`);
    return wide.slice(0, 8);
  }

  const plain = await _autocompleteCall({ input: q }, apiKey);
  const rows = _mapSuggestions(plain);
  console.warn(`[places] autocomplete q="${q}" mode=UNBIASED (no market coords) results=${rows.length}`);
  return rows.slice(0, 8);
}

// Resolve a chosen autocomplete suggestion to full details. Cached 30 days keyed
// on the place_id, which is the stable identity, so repeat adds of the same
// location are free.
async function lookupPlaceById(placeId) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const id = String(placeId || '').trim();
  if (!apiKey || !id) return null;
  const cacheKey = `place_id:${id} | ${CACHE_V}`;
  try {
    const cached = await store.getBrandEvidence(cacheKey, 'places', CACHE_DAYS);
    if (cached && cached.evidence) {
      const ev = cached.evidence;
      return ev.found === false ? null : ev;
    }
  } catch (_) { /* fall through to live lookup */ }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const resp = await fetch(DETAILS_URL + encodeURIComponent(id), {
      method: 'GET',
      signal: ctrl.signal,
      headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': PLACE_FIELDS },
    });
    clearTimeout(t);
    if (!resp.ok) { console.warn('[places] details id=' + id + ' http=' + resp.status); return null; }
    const p = await resp.json();
    if (!p || !p.id) return null;
    const out = _mapPlace(p, null);
    try { await store.saveBrandEvidence(cacheKey, 'places', out.name, out.website, out, 'OK'); } catch (_) {}
    console.log('[places] details id=' + id + ' name="' + (out.name || '') + '" phone=' + (out.phone ? 'y' : 'n') + ' site=' + (out.website ? 'y' : 'n'));
    return out;
  } catch (e) {
    console.warn('[places] details id=' + id + ' error=' + e.message);
    return null;
  }
}

module.exports = { lookupPlace, lookupPlaceResult, autocompletePlaces, lookupPlaceById, geocodePlace };
