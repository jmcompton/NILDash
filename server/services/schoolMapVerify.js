'use strict';
// ── IS THE TOWN ON FILE WHERE PLACES PUTS THE CAMPUS ────────────────────────
//
// services/schoolsDivisions was written from memory of the D2, D3 and NAIA
// membership lists, because the build box reaches neither ncaa.org nor
// naia.org nor any geocoder. A wrong town there sends an athlete's whole
// local lane to the wrong town, silently. So the list is CHECKED, entry by
// entry, against Places (services/schoolGeocode, which caches in
// brand_evidence_cache), and the entries whose geocoded town disagrees are
// printed for a human to correct by hand. Nothing here writes to the list or
// to any athlete.
//
// Two callers, one job:
//   scripts/audit-schools.js --verify-map      from a machine with the key
//   GET /api/admin/verify-school-map           on Railway, where the key lives
//
// THE QUERY IS THE NAME AND THE STATE, NOT THE TOWN. Asking Places for
// "Adams State University, Alamosa, CO" would find some school in Alamosa and
// confirm whatever we wrote. The state is kept because a bare name is shared
// by twins ("Bethel University") and because the state is the part of the
// entry least likely to be wrong.

const { SCHOOLS } = require('./schoolsDivisions');

// One entry and one geocode answer -> a verdict. Pure.
//   agree         same town (case, punctuation and Saint/St ignored)
//   disagree      Places puts the campus in another town: the line to check
//   unverifiable  no answer (no key, an outage, a non-school hit): claims nothing
function verifyEntry(name, loc, geo) {
  const town = (s) => String(s || '').toLowerCase().replace(/\bsaint\b/g, 'st').replace(/\bmount\b/g, 'mt').replace(/[^a-z0-9]+/g, ' ').trim();
  const onFile = `${loc.city}, ${loc.state}`;
  if (!geo || !geo.city) return { name, onFile, geocoded: null, verdict: 'unverifiable' };
  const geocoded = `${geo.city}, ${geo.state}`;
  const same = town(geo.city) === town(loc.city) && String(geo.state || '').toUpperCase() === String(loc.state || '').toUpperCase();
  return { name, onFile, geocoded, verdict: same ? 'agree' : 'disagree' };
}

// The bare name, without the "(Tennessee)" the resolver uses to tell twins
// apart: Places wants the name on the sign.
function bareName(name) { return String(name || '').replace(/\s*\([^)]*\)\s*$/, ''); }

// opts: { state, limit, concurrency, geocode(query) -> {city,state}|null, onProgress(done,total) }
// Returns { total, agree, disagree, unverifiable, mismatches: [verdicts], unverified: [names], keyPresent }
async function verifySchoolMap(opts = {}) {
  const onlyState = String(opts.state || '').toUpperCase();
  const limit = parseInt(opts.limit, 10) || 0;
  let entries = Object.entries(SCHOOLS).filter(([, loc]) => !onlyState || loc.state === onlyState);
  if (limit) entries = entries.slice(0, limit);
  const geocode = opts.geocode || defaultGeocode;
  const conc = Math.max(1, Math.min(8, opts.concurrency || 4));
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < entries.length) {
      const [name, loc] = entries[i++];
      let geo = null;
      try { geo = await geocode(`${bareName(name)}, ${loc.state}`); } catch (_) { geo = null; }
      out.push(verifyEntry(name, loc, geo));
      if (typeof opts.onProgress === 'function') { try { opts.onProgress(out.length, entries.length); } catch (_) {} }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  const n = { agree: 0, disagree: 0, unverifiable: 0 };
  for (const v of out) n[v.verdict]++;
  const byName = (a, b) => a.name.localeCompare(b.name);
  return {
    total: out.length, ...n,
    keyPresent: !!(process.env.GOOGLE_PLACES_API_KEY || '').trim(),
    mismatches: out.filter((v) => v.verdict === 'disagree').sort(byName),
    unverified: out.filter((v) => v.verdict === 'unverifiable').map((v) => v.name).sort(),
  };
}

// The real geocode: services/schoolGeocode over the real Places lookup, cached.
async function defaultGeocode(query) {
  const { geocodeSchool } = require('./schoolGeocode');
  const { lookupPlaceResult } = require('./placesLookup');
  const store = require('../store');
  return geocodeSchool(query, { lookupPlaceResult, store });
}

// The lines a human reads: one per mismatch, on file beside what Places said.
function formatReport(r) {
  const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n);
  const lines = [];
  lines.push(`${r.total} entries: ${r.agree} agree, ${r.disagree} disagree, ${r.unverifiable} unverifiable${r.keyPresent ? '' : ' (GOOGLE_PLACES_API_KEY is not set: nothing was checked)'}`);
  if (r.mismatches.length) {
    lines.push('', `  ${pad('school', 56)} ${pad('on file', 26)} Places says`);
    for (const v of r.mismatches) lines.push(`  ${pad(v.name, 56)} ${pad(v.onFile, 26)} ${v.geocoded}`);
    lines.push('', 'Check each line and correct services/schoolsDivisions.js by hand; nothing is changed here.');
  } else if (r.agree) lines.push('Every verifiable entry agrees with Places.');
  if (r.unverified.length) lines.push('', `Unverifiable (${r.unverified.length}): ${r.unverified.join('; ')}`);
  return lines.join('\n');
}

module.exports = { verifySchoolMap, verifyEntry, bareName, formatReport };
