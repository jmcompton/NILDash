'use strict';
// ── EVERY COLLEGE IN THE COUNTRY, BY ITS FULL NAME ──────────────────────────
//
// The resolver's own lists (shipped map, curated D1-D3/NAIA, aliases) are
// strongest on D1 and thin past it, and a school they did not carry went to a
// Places lookup that could land in the wrong town: "St. Joseph's University"
// (Philadelphia) came back San Jose, and "Saint Joseph's University" was
// fuzzy-matched to the University of Saint Joseph in West Hartford (Nov 2026).
//
// data/usColleges is the Department of Education's directory of every active,
// degree-granting two- and four-year college: about 4,100 schools with their
// city and state. find() answers only on a FULL-NAME match (official name or a
// listed alias, punctuation, "St."/"Saint" and campus suffixes aside), and
// only when every match is in one town, narrowed by a state the agent typed.
// Two towns is not an answer: the resolver's ambiguity path asks the agent.
// No network, no cost, synchronous.

const RAW = require('../data/usColleges');

const FOLD = { st: 'saint', ste: 'sainte', mt: 'mount', ft: 'fort', univ: 'university', u: 'university', coll: 'college', cc: 'community college' };

function key(s) {
  let t = String(s || '').toLowerCase()
    .replace(/[’'`.]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/^the /, '');
  t = t.split(' ').map((w) => FOLD[w] || w).join(' ');
  return t;
}

// "Ohio University-Main Campus" is "Ohio University"; "University of
// Pittsburgh-Pittsburgh Campus" is "University of Pittsburgh". A branch
// campus named for another town ("Ohio University-Chillicothe Campus") is
// not the bare name.
function baseName(name, city) {
  const m = String(name).match(/^(.*?)\s*-\s*(main campus|([a-z .]+) campus)$/i);
  if (m) {
    if (/^main campus$/i.test(m[2])) return m[1];
    return key(m[3]) === key(city) ? m[1] : null;
  }
  // "Rutgers University-New Brunswick", "Kent State University at Kent": the
  // campus in the school's own town is the bare name too.
  const t = String(name).match(/^(.*?)(?:\s*-\s*|\s+at\s+)([A-Za-z .']+)$/);
  if (t && key(t[2]) === key(city)) return t[1];
  return null;
}
// The flagship, in tiers: a campus officially named "Main Campus", then one
// named "<its own town> Campus" ("University of Pittsburgh-Pittsburgh
// Campus"). Branches are usually "<system>-<town>" with no "Campus".
const MAIN_TIERS = [
  (r) => /-\s*main campus$/i.test(r.name),
  (r) => { const m = r.name.match(/-\s*([a-z .]+) campus$/i); return !!(m && key(m[1]) === key(r.city)); },
];

let INDEX = null;
function index() {
  if (INDEX) return INDEX;
  INDEX = new Map();
  const add = (k, row) => {
    if (!k) return;
    if (!INDEX.has(k)) INDEX.set(k, []);
    const list = INDEX.get(k);
    if (!list.includes(row)) list.push(row);
  };
  for (const r of RAW) {
    // Town spelled the way the rest of the app spells it ("St. Louis", not
    // the directory's "Saint Louis"), so a school found here lands in the
    // same market key as one from the curated lists.
    const city = String(r[1]).replace(/^Saint /, 'St. ').replace(/\bSte /, 'Ste. ');
    const row = { name: r[0], city, state: r[2], lat: r[4], lon: r[5], domain: r[6] || null, level: r[7] };
    add(key(row.name), row);
    const b = baseName(row.name, row.city);
    if (b) add(key(b), row);
    for (const a of r[3] || []) add(key(a), row);
  }
  return INDEX;
}

// raw: what the agent typed (a parenthetical already split off by the caller).
// stateHint: a two-letter state, or null. -> { name, city, state, lat, lon, domain, level } | null
function find(raw, stateHint) {
  const k = key(raw);
  if (!k || k.split(' ').length < 2) return null;     // "Miami", "State": not a full name
  let hits = index().get(k) || [];
  if (!hits.length) return null;
  if (stateHint) hits = hits.filter((h) => h.state === String(stateHint).toUpperCase());
  if (!hits.length) return null;
  let towns = new Set(hits.map((h) => h.city.toLowerCase() + '|' + h.state));
  // The bare name of a system with branch campuses is its main campus, when
  // exactly one hit is ("Ohio University" is Athens, not Chillicothe).
  if (towns.size > 1) {
    for (const tier of MAIN_TIERS) {
      const main = hits.filter(tier);
      if (main.length && new Set(main.map((h) => h.city.toLowerCase() + '|' + h.state)).size === 1) { hits = main; towns = new Set([1]); break; }
    }
  }
  if (towns.size !== 1) return null;
  return hits[0];
}

// Every directory school sharing that full name, one per town: for the
// "which one did you mean" list.
function candidates(raw) {
  const hits = index().get(key(raw)) || [];
  const seen = new Set(), out = [];
  for (const h of hits) { const t = h.city.toLowerCase() + '|' + h.state; if (!seen.has(t)) { seen.add(t); out.push(h); } }
  return out;
}

// Every college's web domain from the directory ("upenn.edu"), and whether a
// host belongs to one: the host itself or a subdomain of it ("med.upenn.edu").
// A .edu that is not a college in the directory (chop.edu, a hospital that
// kept its old .edu) is not one.
let _domains = null;
function domains() {
  if (_domains) return _domains;
  _domains = new Set();
  for (const r of RAW) { const d = String(r[6] || '').toLowerCase().replace(/^www\./, ''); if (d) _domains.add(d); }
  return _domains;
}
function isCollegeDomain(host) {
  let h = String(host || '').toLowerCase().replace(/^www\./, '');
  const set = domains();
  while (h && h.includes('.')) {
    if (set.has(h)) return true;
    h = h.slice(h.indexOf('.') + 1);
  }
  return false;
}

module.exports = { find, candidates, key, count: () => RAW.length, isCollegeDomain };
