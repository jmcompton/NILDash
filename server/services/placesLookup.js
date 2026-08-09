// Google Places (New) lookup for reliable local-business contact basics:
// phone + website + maps URL. Cached 30 days in brand_evidence_cache (lane
// 'places') so Google is billed at most once per business per month. Any
// failure (no key, network, bad response) returns null so callers fall back
// to the existing web-search behavior.
const store = require('../store');

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

function _key(brand, loc) {
  const b = String(brand || '').trim();
  const l = String(loc || '').trim();
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

async function lookupPlace(brand, locationHint = '') {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey || !brand || !String(brand).trim()) return null;

  const cacheKey = _key(brand, locationHint);
  try {
    const cached = await store.getBrandEvidence(cacheKey, 'places', CACHE_DAYS);
    if (cached && cached.evidence) {
      const ev = cached.evidence;
      return ev.found === false ? null : ev;
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
    if (!resp.ok) { console.warn('[places] brand=' + brand + ' http=' + resp.status); return null; }
    data = await resp.json();
  } catch (e) {
    console.warn('[places] brand=' + brand + ' error=' + e.message);
    return null;
  }

  const p = data && Array.isArray(data.places) && data.places[0];
  if (!p) {
    try { await store.saveBrandEvidence(cacheKey, 'places', brand, null, { found: false }, 'NONE'); } catch (_) {}
    console.log('[places] brand=' + brand + ' found=0');
    return null;
  }

  const out = _mapPlace(p, brand);
  try { await store.saveBrandEvidence(cacheKey, 'places', brand, out.website, out, 'OK'); } catch (_) {}
  console.log('[places] brand=' + brand + ' found=1 id=' + (out.place_id ? 'y' : 'n') + ' phone=' + (out.phone ? 'y' : 'n') + ' site=' + (out.website ? 'y' : 'n'));
  return out;
}

// Autocomplete for the manual "Add a Business" input, biased to the athlete's
// market so the same brand name in three towns returns three distinct place_ids.
// bias = { lat, lng, radiusM }. Returns [{ place_id, name, address }]. Never
// throws: an empty array degrades the input to "no suggestions".
async function autocompletePlaces(input, bias = {}) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const q = String(input || '').trim();
  if (!apiKey || q.length < 3) return [];
  const body = { input: q };
  if (bias && Number.isFinite(bias.lat) && Number.isFinite(bias.lng)) {
    body.locationBias = {
      circle: {
        center: { latitude: bias.lat, longitude: bias.lng },
        radius: Math.min(Math.max(Number(bias.radiusM) || 40000, 1), 50000),
      },
    };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const resp = await fetch(AUTOCOMPLETE_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      body: JSON.stringify(body),
    });
    clearTimeout(t);
    if (!resp.ok) { console.warn('[places] autocomplete http=' + resp.status); return []; }
    const data = await resp.json();
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
    }).filter((x) => x && x.name).slice(0, 8);
  } catch (e) {
    console.warn('[places] autocomplete error=' + e.message);
    return [];
  }
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

module.exports = { lookupPlace, autocompletePlaces, lookupPlaceById };
