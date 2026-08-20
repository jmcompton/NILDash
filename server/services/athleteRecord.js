'use strict';
// ── ONE ATHLETE RECORD ───────────────────────────────────────────────────────
//
// The Scout and the Writer read the same resolved profile, and every field is
// either PRESENT or EXPLICITLY ABSENT. There are no defaults here, no guesses,
// and no filling a blank with something plausible.
//
// That last rule is the whole point. A missing hometown used to be a blank that
// something downstream would helpfully fill -- the school's city, the market
// region, whatever was nearby -- and the result was a pitch that told a real
// business an athlete grew up somewhere they have never been. `null` means we do
// not know, it travels as null, and the Writer's fact guard refuses to let the
// copy mention anything that arrived as null.
//
// resolveAthlete() therefore returns a record where a field is a value or null,
// plus `missing` naming the nulls, so a caller can say "no market for this
// athlete" instead of inventing one.

const { canonicalRegion } = require('./regionKey');

// "Auburn, AL 36832, USA" -> { city: 'Auburn', state: 'AL' }
// "Fayetteville, AR"      -> { city: 'Fayetteville', state: 'AR' }
// Returns nulls rather than partial guesses.
function cityStateFrom(text) {
  const s = String(text || '').trim();
  if (!s) return { city: null, state: null };
  const parts = s.replace(/,?\s*(USA|United States)\s*$/i, '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return { city: null, state: null };
  const last = parts[parts.length - 1];
  // "AL 36832" or "AL"
  const m = last.match(/^([A-Za-z]{2})\b(?:\s+\d{5}(?:-\d{4})?)?$/);
  if (m && parts.length >= 2) {
    return { city: parts[parts.length - 2] || null, state: m[1].toUpperCase() };
  }
  // No state token: a bare city is still a city, but say so honestly.
  return { city: parts.length === 1 ? parts[0] : parts[parts.length - 1], state: null };
}

const _int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; };
const _str = (v) => { const s = (v === null || v === undefined) ? '' : String(v).trim(); return s || null; };
const _handle = (v) => {
  const s = _str(v);
  if (!s) return null;
  // A follower COUNT is not a handle. data.instagram holds the count in this
  // schema, so a bare number here is not an @name and must not become one.
  if (/^\d[\d,]*$/.test(s)) return null;
  return s.replace(/^@+/, '').replace(/^https?:\/\/(www\.)?(instagram|tiktok)\.com\//i, '').replace(/\/+$/, '') || null;
};

// row: an athletes row. opts.schoolLocation: an injected lookup
// (ai.lookupSchoolLocation) so this module never imports ai.js.
function resolveAthlete(row, opts = {}) {
  const d = (row && (row.data || row)) || {};
  const name = _str(row && row.name) || _str(d.name);
  const school = _str(row && row.school) || _str(d.school);
  const hometown = _str(row && row.hometown) || _str(d.hometown);

  // THE MARKET. The school's city is the local lane's anchor, and it is resolved
  // ONLY from a real lookup. An unresolved school yields null, which is a market
  // this athlete does not have rather than one to substitute.
  let schoolCity = null, schoolState = null, marketSource = null;
  if (school && typeof opts.schoolLocation === 'function') {
    let loc = null;
    try { loc = opts.schoolLocation(school); } catch (_) { loc = null; }
    if (loc && loc.city) { schoolCity = _str(loc.city); schoolState = _str(loc.state); marketSource = 'school-lookup'; }
  }
  // A school string that already carries its own city ("Auburn, AL") is a fact
  // we hold, not a guess.
  if (!schoolCity && school && /,/.test(school)) {
    const cs = cityStateFrom(school);
    if (cs.city) { schoolCity = cs.city; schoolState = cs.state; marketSource = 'school-string'; }
  }

  const rec = {
    id: (row && row.id) || null,
    name,
    sport: _str(d.sport),
    position: _str(d.position),
    year: _str(d.year),
    school,
    schoolCity, schoolState, marketSource,
    hometown,
    hometownCity: hometown ? cityStateFrom(hometown).city : null,
    hometownState: hometown ? cityStateFrom(hometown).state : null,
    instagramHandle: _handle(d.instagramHandle || d.instagram_handle || (row && row.instagram_handle)),
    tiktokHandle: _handle(d.tiktokHandle || d.tiktok_handle || (row && row.tiktok_handle)),
    // Counts, not handles. Null when we hold none -- never 0, because 0 reads as
    // "an athlete with no audience" and null reads as "we have not measured".
    instagram: _int(d.instagram) || _int(row && row.instagram_followers),
    tiktok: _int(d.tiktok) || _int(row && row.tiktok_followers),
    stats: _str(d.stats),
    tags: Array.isArray(d.tags) ? d.tags.filter((x) => typeof x === 'string' && x.trim()) : [],
    productWants: _str(d.productWants),
    notes: _str(d.notes),
  };
  rec.reach = (rec.instagram || 0) + (rec.tiktok || 0) || null;
  rec.missing = Object.keys(rec).filter((k) =>
    k !== 'missing' && k !== 'tags' && k !== 'marketSource' && (rec[k] === null || rec[k] === undefined));
  // Does the local lane have a market to work in at all?
  rec.hasLocalMarket = !!rec.schoolCity;
  rec.market = rec.schoolCity ? (rec.schoolCity + (rec.schoolState ? ', ' + rec.schoolState : '')) : null;
  rec.marketKey = rec.market ? canonicalRegion(rec.market) : null;
  return rec;
}

module.exports = { resolveAthlete, cityStateFrom };
