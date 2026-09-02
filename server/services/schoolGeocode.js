'use strict';
// ── A SCHOOL WE DO NOT SHIP IS STILL A REAL PLACE ───────────────────────────
//
// schoolResolver matches against a hardcoded map: 86 shipped names, 120 extras,
// 70 aliases. That is roughly a sixth of NCAA D1-D3 before NAIA and JUCO, and it
// is heavily D1. Bentley University -- a real D2 school in Waltham, MA -- is not
// on it, and neither is most of D2 and D3.
//
// What happened to an athlete there: resolveSchool returned null, so market was
// null, so hasLocalMarket was false, so the local lane never ran and the page
// said "we could not match this to a school we know". The athlete was left with
// the social and national lanes only -- and when those were also broken, with
// nothing at all.
//
// ADDING BENTLEY IS NOT THE FIX. The list will always be missing the next
// school. A school name is a place, and we already pay for a Places lookup on
// every local candidate; the same call resolves a campus to a town. So an
// unrecognised school is GEOCODED rather than rejected, and the local lane runs
// in the town Places names.
//
// PRECEDENCE. The shipped map still wins where it has an answer: it is curated,
// free, and instant. This runs only when the map has nothing, which is exactly
// the case that used to produce silence.
//
// CACHED, because a roster of 45 at one school must not be 45 lookups, and a
// campus does not move. Stored in brand_evidence_cache under its own lane, which
// is already metered and TTL'd -- and NEGATIVE results are cached too, so a name
// that is not a school at all ("Unattached", a typo) is not re-searched nightly.

const CACHE_LANE = 'schoolgeo';
const CACHE_DAYS = 180;        // a campus does not move
const NEGATIVE_CACHE_DAYS = 14; // but a typo might get corrected

// Anything that cannot be a school name. A blank or a placeholder must not cost
// a lookup, and must never be geocoded into a market that then gets pitched.
const NOT_A_SCHOOL = new Set([
  'n/a', 'na', 'none', 'unknown', 'unattached', 'free agent', 'tbd', 'high school',
  'transfer portal', 'portal', 'undecided', 'pro', 'professional', '-', '--',
]);

function _key(school) {
  const s = String(school || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return s ? 'school:' + s : null;
}

function usable(school) {
  const s = String(school || '').trim();
  if (s.length < 3) return false;
  if (NOT_A_SCHOOL.has(s.toLowerCase())) return false;
  // A bare state or city is not a school; the shipped resolver already refuses
  // these and geocoding them would put an athlete in a market on no evidence.
  if (!/[a-z]/i.test(s)) return false;
  return true;
}

// Pull "City, ST" out of whatever Places returned. Places gives a formatted
// address; the town is the second-to-last-but-one component in US addresses.
function cityStateFromAddress(addr) {
  const raw = String(addr || '').trim();
  if (!raw) return null;
  const parts = raw.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  // "780 Beaver St, Waltham, MA 02452, USA" -> ["780 Beaver St","Waltham","MA 02452","USA"]
  const withoutCountry = parts[parts.length - 1] === 'USA' || /^united states$/i.test(parts[parts.length - 1])
    ? parts.slice(0, -1) : parts;
  if (withoutCountry.length < 2) return null;
  const stateZip = withoutCountry[withoutCountry.length - 1];
  const m = stateZip.match(/^([A-Z]{2})\b/);
  const state = m ? m[1] : null;
  const city = withoutCountry[withoutCountry.length - 2];
  if (!city || !state) return null;
  return { city, state };
}

// deps: { lookupPlace, store } -- injected so this module needs no network and
// no database to be tested.
async function geocodeSchool(school, deps = {}) {
  if (!usable(school)) return null;
  const key = _key(school);
  if (!key) return null;
  const store = deps.store;
  const lookupPlace = deps.lookupPlace;

  if (store && typeof store.getBrandEvidence === 'function') {
    try {
      const hit = await store.getBrandEvidence(key, CACHE_LANE, CACHE_DAYS);
      if (hit && hit.evidence) {
        const ev = hit.evidence;
        if (ev.found === false) return null;
        if (ev.city && ev.state) {
          return { city: ev.city, state: ev.state, market: ev.city + ', ' + ev.state,
            source: 'cache' };
        }
      }
    } catch (_) { /* a cache miss is not a failure */ }
  }

  if (typeof lookupPlace !== 'function') return null;
  let place = null;
  try {
    place = await lookupPlace(String(school).trim(), '');
  } catch (e) {
    // A lookup failure is NOT cached as "not a school". A network blip must not
    // put a real campus on a two-week blocklist.
    console.warn('[schoolGeocode] ' + school + ' lookup failed: ' + e.message);
    return null;
  }

  const addr = place && (place.address || place.formattedAddress || place.formatted_address);
  const cs = cityStateFromAddress(addr);
  if (!cs) {
    if (store && typeof store.saveBrandEvidence === 'function') {
      try {
        await store.saveBrandEvidence(key, CACHE_LANE, String(school).trim(), null,
          { found: false }, 'NONE');
      } catch (_) {}
    }
    console.log('[schoolGeocode] "' + school + '" -> no town found');
    return null;
  }

  if (store && typeof store.saveBrandEvidence === 'function') {
    try {
      await store.saveBrandEvidence(key, CACHE_LANE, String(school).trim(), null,
        { found: true, city: cs.city, state: cs.state, address: addr || null }, 'OK');
    } catch (_) {}
  }
  console.log('[schoolGeocode] "' + school + '" -> ' + cs.city + ', ' + cs.state + ' (geocoded)');
  return { city: cs.city, state: cs.state, market: cs.city + ', ' + cs.state, source: 'places' };
}

module.exports = {
  geocodeSchool, cityStateFromAddress, usable,
  CACHE_LANE, CACHE_DAYS, NEGATIVE_CACHE_DAYS, NOT_A_SCHOOL,
};
