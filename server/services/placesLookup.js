// Google Places (New) lookup for reliable local-business contact basics:
// phone + website + maps URL. Cached 30 days in brand_evidence_cache (lane
// 'places') so Google is billed at most once per business per month. Any
// failure (no key, network, bad response) returns null so callers fall back
// to the existing web-search behavior.
const store = require('../store');

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = 'places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.googleMapsUri';
const TIMEOUT_MS = 4500;
const CACHE_DAYS = 30;

function _key(brand, loc) {
  const b = String(brand || '').trim();
  const l = String(loc || '').trim();
  return l ? `${b} | ${l}` : b;
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

  const out = {
    found: true,
    phone: p.nationalPhoneNumber || p.internationalPhoneNumber || null,
    website: p.websiteUri || null,
    address: p.formattedAddress || null,
    mapsUrl: p.googleMapsUri || null,
    name: (p.displayName && p.displayName.text) || brand,
  };
  try { await store.saveBrandEvidence(cacheKey, 'places', brand, out.website, out, 'OK'); } catch (_) {}
  console.log('[places] brand=' + brand + ' found=1 phone=' + (out.phone ? 'y' : 'n') + ' site=' + (out.website ? 'y' : 'n'));
  return out;
}

module.exports = { lookupPlace };
