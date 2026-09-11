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
  // ── COLLEGE OR PRO ─────────────────────────────────────────────────────────
  // A pro has no school. Their local market is the city they play in and their
  // "program" is a team, so the two fields that replace the school are read
  // here and the market below is anchored on the city instead. Everything
  // downstream reads `market`/`marketKey`/`hasLocalMarket` and never asks how
  // the market was found, so the pro branch is confined to this function.
  const athleteType = (_str(row && row.athlete_type) === 'pro' || _str(d.athleteType) === 'pro') ? 'pro' : 'college';
  const isPro = athleteType === 'pro';
  const school = isPro ? null : (_str(row && row.school) || _str(d.school));
  const city = isPro ? (_str(row && row.city) || _str(d.city)) : null;
  const team = isPro ? (_str(row && row.team) || _str(d.team)) : null;
  const hometown = _str(row && row.hometown) || _str(d.hometown);

  // THE MARKET. The school's city is the local lane's anchor, and it is resolved
  // ONLY from a real lookup. An unresolved school yields null, which is a market
  // this athlete does not have rather than one to substitute.
  let schoolCity = null, schoolState = null, marketSource = null, schoolMatched = null;
  // A pro's city is typed by the agent as "Denver, CO" and is the market as
  // given. A bare "Denver" is still a town the local lane can work in; the
  // missing state is reported below as `stateNote`, never guessed.
  if (isPro && city) {
    const cs = cityStateFrom(city);
    if (cs.city) { schoolCity = cs.city; schoolState = cs.state; marketSource = 'pro-city'; }
  }
  if (school && typeof opts.schoolLocation === 'function') {
    let loc = null;
    try { loc = opts.schoolLocation(school); } catch (_) { loc = null; }
    if (loc && loc.city) {
      schoolCity = _str(loc.city); schoolState = _str(loc.state);
      // The resolver reports HOW it matched, which is worth keeping: a fuzzy
      // match on a misspelling is right far more often than not, but it is the
      // one an agent should be able to eyeball.
      marketSource = _str(loc.method) || 'school-lookup';
      schoolMatched = _str(loc.matched) || null;
    }
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
    // A pro has no class year. One left over from a college record must not
    // reach the writer, which would call a 31-year-old a "junior".
    year: isPro ? null : _str(d.year),
    athleteType,
    school,
    city, team,
    schoolCity, schoolState, marketSource, schoolMatched,
    hometown,
    hometownCity: hometown ? cityStateFrom(hometown).city : null,
    hometownState: hometown ? cityStateFrom(hometown).state : null,
    instagramHandle: _handle(d.instagramHandle || d.instagram_handle || (row && row.instagram_handle)),
    tiktokHandle: _handle(d.tiktokHandle || d.tiktok_handle || (row && row.tiktok_handle)),
    // Counts, not handles. Null when we hold none -- never 0, because 0 reads as
    // "an athlete with no audience" and null reads as "we have not measured".
    instagram: _int(d.instagram) || _int(row && row.instagram_followers),
    tiktok: _int(d.tiktok) || _int(row && row.tiktok_followers),
    // WHEN THOSE COUNTS WERE MEASURED, AND BY WHOM. This record is what the
    // Writer and the queue job see, and it is built from a fixed field list --
    // so a field missing here is a field that does not exist as far as they are
    // concerned. Without these two the Writer reads every athlete as having an
    // undated follower count forever, including athletes who had just entered
    // their own numbers minutes earlier, and quietly stops citing reach for
    // everyone. See services/reachProvenance.
    reachSource: _str(d.reachSource),
    reachAsOf: _str(d.reachAsOf),
    stats: _str(d.stats),
    tags: Array.isArray(d.tags) ? d.tags.filter((x) => typeof x === 'string' && x.trim()) : [],
    productWants: _str(d.productWants),
    notes: _str(d.notes),
  };
  rec.reach = (rec.instagram || 0) + (rec.tiktok || 0) || null;
  // The fields that do not apply to this athlete's type are absent by
  // construction, not missing: a pro has no school, a college athlete no team.
  const notApplicable = isPro ? new Set(['school', 'year', 'schoolMatched']) : new Set(['city', 'team']);
  rec.missing = Object.keys(rec).filter((k) =>
    k !== 'missing' && k !== 'tags' && k !== 'marketSource' && !notApplicable.has(k)
      && (rec[k] === null || rec[k] === undefined));
  // Does the local lane have a market to work in at all?
  rec.hasLocalMarket = !!rec.schoolCity;
  // SURFACED, NOT SWALLOWED. A school we could not match is a data problem the
  // agent can fix in ten seconds, but only if something tells them. The local
  // lane producing nothing looks identical to a quiet night otherwise.
  rec.schoolUnmatched = !!(rec.school && !rec.schoolCity);
  rec.localLaneNote = isPro
    ? (!rec.city ? 'No city on file for this pro, so the local lane has no town to work in.' : null)
    : rec.schoolUnmatched
      ? `We could not match "${rec.school}" to a school we know, so the local lane has no town to work in. Correct the school on this athlete and it will start.`
      : (!rec.school ? 'No school on file, so the local lane has no town to work in.' : null);
  rec.market = rec.schoolCity ? (rec.schoolCity + (rec.schoolState ? ', ' + rec.schoolState : '')) : null;
  rec.marketKey = rec.market ? canonicalRegion(rec.market) : null;
  // ── THE STATE, OR A NOTE SAYING THERE IS NONE ─────────────────────────────
  // The compliance gate keys state category rules on this. It used to be
  // derived from the school alone, and an athlete whose school did not resolve
  // to a state got NO state rules, silently. Now the athlete carries either a
  // state code or an explicit note that they have none -- and the gate turns
  // that note into a block rather than a quiet pass (see compliance.evaluate).
  rec.stateCode = rec.schoolState || null;
  rec.stateNote = rec.stateCode ? null
    : isPro
      ? (rec.city
        ? `"${rec.city}" has no state. Enter the city as "City, ST" so state rules can run.`
        : 'No city on file, so no state rules can run.')
      : (rec.school
        ? `"${rec.school}" did not resolve to a state, so no state rules can run. Enter the school as "School, ST" or correct its name.`
        : 'No school on file, so no state rules can run.');
  return rec;
}

module.exports = { resolveAthlete, cityStateFrom };
