'use strict';
// ── GOOGLE PLACES QUESTIONS, ANSWERED BY SERPER (PLACES_PROVIDER) ───────────
//
// Google Places billed $222 in one month: every market build asks about 30
// kinds of business, each up to five times, with the fields Google prices
// highest (rating, review count). Serper, which NILDash already pays for web
// search, runs the same Google Maps search for a small fraction of that.
//
// This file answers a Places (New) request in Places (New)'s own shape, so the
// three callers (placesMarket, placesLookup, prospector/places) and everything
// downstream of them read the answer unchanged:
//
//   searchNearby  { includedTypes: [type], locationRestriction: { circle } }
//                 -> a Maps search for that kind of business around the centre,
//                    kept to the circle
//   searchText    { textQuery, locationRestriction?: { rectangle } }
//                 -> a Maps search for the text, around the rectangle when given
//
// ON when SERPER_API_KEY is set, unless PLACES_PROVIDER=google. A failed Serper
// call is never an answer: the caller asks Google exactly as before.
//
// What the place IS comes from Serper's own type for it ("Mexican restaurant"
// -> primaryType mexican_restaurant), never from the kind we searched for: the
// racetrack-filed-as-restaurant lesson in placesMarket.categoryFor.

const SERPER_MAPS_URL = 'https://google.serper.dev/maps';
const SERPER_PLACES_URL = 'https://google.serper.dev/places';
const TIMEOUT_MS = parseInt(process.env.SERPER_PLACES_TIMEOUT_MS, 10) || 10000;
const MAX = 20;

const key = () => String(process.env.SERPER_API_KEY || '').trim();
function ON() {
  if (String(process.env.PLACES_PROVIDER || '').trim().toLowerCase() === 'google') return false;
  return !!key();
}

// The words a person would type into Maps for each Places type we search.
const TERMS = {
  meal_takeaway: 'takeout restaurant', hair_care: 'hair salon', car_repair: 'auto repair shop',
  real_estate_agency: 'real estate agency', veterinary_care: 'veterinarian', physiotherapist: 'physical therapy',
  home_goods_store: 'home goods store', sporting_goods_store: 'sporting goods store', cafe: 'coffee shop',
  car_dealer: 'car dealership', spa: 'day spa', bar: 'bar', supermarket: 'grocery store',
};
const termFor = (type) => TERMS[type] || String(type || '').replace(/_/g, ' ').trim();

const snake = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const PRICE = { '$': 'PRICE_LEVEL_INEXPENSIVE', '$$': 'PRICE_LEVEL_MODERATE', '$$$': 'PRICE_LEVEL_EXPENSIVE', '$$$$': 'PRICE_LEVEL_VERY_EXPENSIVE' };

// A Serper place, as a Places (New) place resource.
function toGoogle(p) {
  if (!p || !p.title) return null;
  const type = p.type || p.category || null;
  const types = (Array.isArray(p.types) && p.types.length ? p.types : (type ? [type] : [])).map(snake).filter(Boolean);
  const lat = Number(p.latitude), lng = Number(p.longitude);
  const id = p.placeId || (p.cid ? 'cid:' + p.cid : null);
  const price = typeof p.priceLevel === 'string' ? PRICE[p.priceLevel.trim()] : null;
  return {
    id,
    displayName: { text: String(p.title) },
    formattedAddress: p.address || null,
    shortFormattedAddress: p.address || null,
    location: Number.isFinite(lat) && Number.isFinite(lng) ? { latitude: lat, longitude: lng } : null,
    rating: p.rating != null ? Number(p.rating) : null,
    userRatingCount: p.ratingCount != null ? Number(p.ratingCount) : (p.reviews != null ? Number(p.reviews) : 0),
    types,
    primaryType: type ? snake(type) : null,
    primaryTypeDisplayName: type ? { text: String(type) } : null,
    websiteUri: p.website || null,
    nationalPhoneNumber: p.phoneNumber || null,
    googleMapsUri: p.cid ? `https://maps.google.com/?cid=${p.cid}` : null,
    // Serper lists businesses Maps shows; a permanently closed one says so.
    businessStatus: /permanently closed/i.test(String(p.openingHours && JSON.stringify(p.openingHours) || '') + ' ' + String(p.description || ''))
      ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL',
    ...(price ? { priceLevel: price } : {}),
  };
}

function distanceM(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// The Maps zoom that shows about this much ground around the centre.
function zoomFor(radiusM) {
  const r = Number(radiusM) || 5000;
  if (r <= 1200) return 16;
  if (r <= 2500) return 15;
  if (r <= 5000) return 14;
  if (r <= 10000) return 13;
  if (r <= 20000) return 12;
  return 11;
}

async function _call(url, body, opts = {}) {
  const k = key();
  if (!k) return { ok: false, error: 'SERPER_API_KEY is not set' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await (opts.fetch || globalThis.fetch)(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': k },
      body: JSON.stringify(body),
    });
    let j = null;
    try { j = await resp.json(); } catch (_) { j = null; }
    if (!resp.ok || !j) return { ok: false, error: `Serper HTTP ${resp.status}${j && j.message ? ': ' + String(j.message).slice(0, 160) : ''}` };
    return { ok: true, places: (Array.isArray(j.places) ? j.places : []).map(toGoogle).filter(Boolean) };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? `Serper timed out after ${Math.round(TIMEOUT_MS / 1000)}s` : 'Serper call failed: ' + (e && e.message) };
  } finally { clearTimeout(t); }
}

// A Maps search. center + radiusM keep it to that ground; without them the
// query carries its own place ("Joe's Pizza Hoover, AL").
async function search({ query, center = null, radiusM = null, max = MAX }, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, places: [], error: 'no query' };
  const r = center
    ? await _call(SERPER_MAPS_URL, { q, ll: `@${Number(center.lat).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')},${Number(center.lng).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')},${zoomFor(radiusM)}z` }, opts)
    : await _call(SERPER_PLACES_URL, { q }, opts);
  if (!r.ok) return { ok: false, places: [], error: r.error };
  let places = r.places;
  if (center && radiusM) places = places.filter((p) => !p.location || distanceM(center, { lat: p.location.latitude, lng: p.location.longitude }) <= radiusM);
  return { ok: true, places: places.slice(0, Math.max(1, Math.min(MAX, Number(max) || MAX))) };
}

// A Places (New) request (its URL and body), answered by Serper in Places'
// own response shape: { ok: true, body: { places } } or { ok: false, error }.
async function asGoogle(url, body, opts = {}) {
  const u = String(url || ''), b = body || {};
  if (/places:searchNearby/.test(u)) {
    const type = Array.isArray(b.includedTypes) && b.includedTypes[0];
    const c = b.locationRestriction && b.locationRestriction.circle;
    if (!type || !c || !c.center) return { ok: false, error: 'not a request Serper can answer' };
    const r = await search({ query: termFor(type), center: { lat: c.center.latitude, lng: c.center.longitude }, radiusM: c.radius, max: b.maxResultCount || MAX }, opts);
    return r.ok ? { ok: true, body: { places: r.places } } : { ok: false, error: r.error };
  }
  if (/places:searchText/.test(u)) {
    const rect = b.locationRestriction && b.locationRestriction.rectangle;
    let center = null, radiusM = null;
    if (rect && rect.low && rect.high) {
      const lo = { lat: rect.low.latitude, lng: rect.low.longitude }, hi = { lat: rect.high.latitude, lng: rect.high.longitude };
      center = { lat: (lo.lat + hi.lat) / 2, lng: (lo.lng + hi.lng) / 2 };
      radiusM = distanceM(lo, hi) / 2;
    }
    const r = await search({ query: b.textQuery, center, radiusM, max: b.pageSize || b.maxResultCount || MAX }, opts);
    return r.ok ? { ok: true, body: { places: r.places } } : { ok: false, error: r.error };
  }
  return { ok: false, error: 'not a request Serper can answer' };
}

module.exports = { ON, search, asGoogle, toGoogle, termFor, zoomFor, distanceM, SERPER_MAPS_URL, SERPER_PLACES_URL };
