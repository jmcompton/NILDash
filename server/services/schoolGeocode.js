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
//
// ── WHY BENTLEY CAME BACK "NO TOWN FOUND" AND STAYED THAT WAY ───────────────
//
// Three defects, and the third is what made the first two permanent.
//
//   1. A FAILED LOOKUP WAS CACHED AS A FACT. lookupPlace returns null four ways
//      -- no API key, an HTTP error, a timeout, and Places genuinely having no
//      such place -- and NEVER THROWS. The try/catch below was written to keep a
//      network blip off the blocklist and could not fire, because there was no
//      exception to catch. Every failure fell into the branch that writes
//      { found: false }. One 4.5-second timeout on one night was enough to
//      record a real campus as "not a school".
//
//   2. THE NEGATIVE TTL WAS DEAD CODE. NEGATIVE_CACHE_DAYS existed, was
//      exported, and was named in this comment -- and nothing read it. Negatives
//      were read back through the 180-day positive window, so "a typo might get
//      corrected in a fortnight" was really six months.
//
//   3. NOTHING CHECKED THAT WE FOUND A SCHOOL. The query is the bare name with
//      no location hint and no type restriction, and the first result was taken
//      on trust. "Bentley University" competes with a car marque; a dealership
//      would have been accepted silently and that town pitched as the athlete's
//      market. Places labels a campus (university/school/college); a result
//      carrying types that contain no education type is now refused by name.
//
// THE RULE THIS FILE NOW KEEPS: only an ANSWER is written down. "We could not
// ask" is never cached, in any lane, for any duration.

const CACHE_LANE = 'schoolgeo';
const CACHE_DAYS = 180;        // a campus does not move
const NEGATIVE_CACHE_DAYS = 14; // but a typo might get corrected

// What Places calls a campus. Checked only when the result actually carries
// types: an empty array is missing evidence, not evidence of absence, and
// refusing on it would reject every school whose row predates the types field.
const SCHOOL_TYPES = new Set([
  'university', 'college', 'school', 'primary_school', 'secondary_school',
  'community_college', 'education',
]);

function looksLikeSchool(place) {
  const types = place && Array.isArray(place.types) ? place.types : [];
  const primary = place && place.primaryType ? [place.primaryType] : [];
  const all = types.concat(primary);
  if (!all.length) return true;                      // nothing to judge on
  return all.some((t) => SCHOOL_TYPES.has(String(t)));
}

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

// A negative is only trusted for NEGATIVE_CACHE_DAYS, and the only way to apply
// two windows to one row is to read it through the longer one and check the age
// here. getBrandEvidence hands back refreshed_at for exactly this.
function _negativeIsStale(row) {
  const at = row && row.refreshed_at ? new Date(row.refreshed_at).getTime() : NaN;
  if (!Number.isFinite(at)) return true;   // unreadable timestamp: do not trust it
  return (Date.now() - at) > NEGATIVE_CACHE_DAYS * 86400000;
}

// deps: { lookupPlaceResult, lookupPlace, store } -- injected so this module
// needs no network and no database to be tested.
//
// lookupPlaceResult is PREFERRED because it distinguishes "there is no such
// place" from "we could not ask", and only the first of those may be written
// down. A caller that supplies the bare lookupPlace still works, but cannot tell
// the two apart -- so in that mode NOTHING negative is ever cached. Erring
// towards one wasted lookup a night beats blocklisting a real campus.
async function geocodeSchool(school, deps = {}) {
  if (!usable(school)) return null;
  const key = _key(school);
  if (!key) return null;
  const store = deps.store;
  const ask = deps.lookupPlaceResult
    || (typeof deps.lookupPlace === 'function'
      // No way to tell an outage from an absence, so every answer is reported as
      // unverifiable and the negative-cache branch below is never reached.
      ? async (q) => ({ ok: false, place: await deps.lookupPlace(q, ''), reason: 'unknown' })
      : null);

  const saveNegative = async (why) => {
    if (!store || typeof store.saveBrandEvidence !== 'function') return;
    try {
      await store.saveBrandEvidence(key, CACHE_LANE, String(school).trim(), null,
        { found: false, why: why || null, at: new Date().toISOString() }, 'NONE');
    } catch (_) {}
  };

  if (store && typeof store.getBrandEvidence === 'function') {
    try {
      const hit = await store.getBrandEvidence(key, CACHE_LANE, CACHE_DAYS);
      if (hit && hit.evidence) {
        const ev = hit.evidence;
        if (ev.found === false) {
          // EXPIRES IN A FORTNIGHT, NOT SIX MONTHS. This read used the 180-day
          // positive window, so a name recorded as "not a school" -- for any
          // reason, including our own timeout -- was held until the following
          // spring. A stale negative falls through to a fresh lookup.
          if (!_negativeIsStale(hit)) return null;
          console.log('[schoolGeocode] "' + school + '" negative is stale, re-checking');
        } else if (ev.city && ev.state) {
          return { city: ev.city, state: ev.state, market: ev.city + ', ' + ev.state,
            source: 'cache' };
        }
      }
    } catch (_) { /* a cache miss is not a failure */ }
  }

  if (!ask) return null;
  let res;
  try {
    res = await ask(String(school).trim(), '');
  } catch (e) {
    // Kept for a deps implementation that does throw. The real one does not,
    // which is the whole reason ok/reason exists.
    console.warn('[schoolGeocode] "' + school + '" lookup threw: ' + e.message);
    return null;
  }
  res = res || { ok: false, place: null, reason: 'no-result' };

  // ── WE COULD NOT ASK: REMEMBER NOTHING ──────────────────────────────────────
  // No API key, an HTTP error, a timeout. None of these is evidence about the
  // school, and writing any of them down is what removed Bentley for six months.
  if (!res.ok) {
    console.warn('[schoolGeocode] "' + school + '" -> lookup unavailable ('
      + (res.reason || 'unknown') + '); NOT cached, will retry');
    return null;
  }

  const place = res.place;
  if (!place) {
    await saveNegative('places-has-no-such-place');
    console.log('[schoolGeocode] "' + school + '" -> Places has no such place');
    return null;
  }

  // ── WE FOUND SOMETHING. IS IT A SCHOOL? ────────────────────────────────────
  // The query is a bare name with no location hint and no type restriction, and
  // the first result was previously taken on trust. "Bentley University" shares
  // a name with a car marque; accepting a dealership would have put an athlete's
  // whole local lane in whichever town that showroom is in, with nothing on the
  // page to say so.
  if (!looksLikeSchool(place)) {
    await saveNegative('resolved-to-a-non-school');
    console.log('[schoolGeocode] "' + school + '" -> resolved to "'
      + (place.name || '?') + '" which is not a school ('
      + (place.types || []).join('/') + ')');
    return null;
  }

  const addr = place.address || place.formattedAddress || place.formatted_address;
  const cs = cityStateFromAddress(addr);
  if (!cs) {
    // A place with an address we cannot parse IS an answer about this name --
    // a foreign campus, a PO box, an address with no state. Cached, but only
    // for the negative window.
    await saveNegative(addr ? 'address-not-parseable' : 'place-has-no-address');
    console.log('[schoolGeocode] "' + school + '" -> no town in address '
      + JSON.stringify(addr || null));
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
  geocodeSchool, cityStateFromAddress, usable, looksLikeSchool,
  CACHE_LANE, CACHE_DAYS, NEGATIVE_CACHE_DAYS, NOT_A_SCHOOL, SCHOOL_TYPES,
};
