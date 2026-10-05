'use strict';
// ── A SCHOOL'S MARKET, CHECKED AGAINST WHERE THE SCHOOL ACTUALLY IS ─────────
//
// The resolver turns a school name into a town from a shipped map and a list
// of names. "Columbia University" matched "Columbia College" (Missouri), so a
// New York school's market was mid-Missouri, and every business, phone number
// and pitch that followed was 573. A name is not a location.
//
// So before a market is used for a named school, both are located with Places
// (placesLookup.geocodePlace, cached 30 days): the school by its name, the
// market by "City, ST". If they are more than MAX_KM apart, the market is
// wrong, and the town in the school's own address replaces it. The correction
// is saved (school_market_overrides) and read synchronously by the resolver's
// callers (overrideFor), so every path -- the nightly, the on-demand fill, the
// cold agent's demo, the profile on the page -- gets the same answer.
//
// Only a SPECIFIC name is checked: one that says what kind of institution it is
// ("... University", "College of ..."). A bare "Miami" or "Columbia" is
// ambiguous by nature; the curated answer for it stands and is not "corrected"
// to whichever Columbia Places happens to rank first.
const MAX_KM = 60;

const _overrides = new Map();     // school key -> { city, state, market, km }
let _loaded = false;

function keyOf(school) { return String(school || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

function specific(school) {
  try { return require('./schoolResolver').kindsOf(school).size > 0; } catch (_) { return false; }
}

function km(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS school_market_overrides (
    school_key TEXT PRIMARY KEY, school TEXT NOT NULL, was_market TEXT, market TEXT NOT NULL,
    city TEXT NOT NULL, state TEXT NOT NULL, km NUMERIC, school_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

// Read once at boot (and at the start of each nightly run), so the resolver's
// synchronous callers see every correction.
async function load(pool) {
  try {
    await ensureTable(pool);
    const rows = (await pool.query(`SELECT school_key, city, state, market, km FROM school_market_overrides`)).rows;
    _overrides.clear();
    for (const r of rows) _overrides.set(r.school_key, { city: r.city, state: r.state, market: r.market, km: Number(r.km) });
    _loaded = true;
    return rows.length;
  } catch (e) {
    console.error('[schoolMarketCheck] load:', e.message);
    return 0;
  }
}

// { city, state } for a corrected school, or null. Synchronous.
function overrideFor(school) {
  const o = _overrides.get(keyOf(school));
  return o ? { city: o.city, state: o.state } : null;
}

// Where the school is versus where its market is. Never throws.
//   { checked: false, why }                 could not locate one of them
//   { checked: true, ok: true, km }         within MAX_KM
//   { checked: true, ok: false, km, market, city, state, schoolAddress }
async function verify(school, market, deps = {}) {
  if (!school || !market) return { checked: false, why: 'nothing to check' };
  if (!specific(school)) return { checked: false, why: 'not a specific institution name' };
  const geo = deps.geocodePlace || require('./placesLookup').geocodePlace;
  let s, m;
  try { s = await geo(String(school).trim()); } catch (_) { s = null; }
  if (!s || !Number.isFinite(s.lat)) return { checked: false, why: `could not locate ${school}` };
  try { m = await geo(String(market).trim()); } catch (_) { m = null; }
  if (!m || !Number.isFinite(m.lat)) return { checked: false, why: `could not locate ${market}` };
  const d = Math.round(km(s, m));
  if (d <= MAX_KM) return { checked: true, ok: true, km: d };
  const cs = require('./schoolGeocode').cityStateFromAddress(s.address);
  if (!cs) return { checked: true, ok: false, km: d, market: null, schoolAddress: s.address || null };
  return { checked: true, ok: false, km: d, city: cs.city, state: cs.state, market: `${cs.city}, ${cs.state}`, schoolAddress: s.address || null };
}

async function saveOverride(pool, school, wasMarket, v) {
  if (!v || !v.market) return false;
  await ensureTable(pool);
  await pool.query(
    `INSERT INTO school_market_overrides (school_key, school, was_market, market, city, state, km, school_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (school_key) DO UPDATE SET was_market = EXCLUDED.was_market, market = EXCLUDED.market, city = EXCLUDED.city,
       state = EXCLUDED.state, km = EXCLUDED.km, school_address = EXCLUDED.school_address, created_at = NOW()`,
    [keyOf(school), String(school).trim(), wasMarket || null, v.market, v.city, v.state, v.km, v.schoolAddress || null]);
  _overrides.set(keyOf(school), { city: v.city, state: v.state, market: v.market, km: v.km });
  return true;
}

// Check one school's market and correct it if it is wrong. Returns the
// verify() answer plus `corrected: true` when an override was written.
async function checkAndCorrect(pool, school, market, deps = {}) {
  const v = await verify(school, market, deps);
  if (v.checked && !v.ok && v.market) {
    await saveOverride(pool, school, market, v);
    console.warn(`[schoolMarketCheck] "${school}" resolved to ${market}, ${v.km} km from the school; corrected to ${v.market}`);
    try { require('./ourFault').record('school-market', `"${school}" resolved to ${market}, ${v.km} km from the school (${v.schoolAddress || '?'}); corrected to ${v.market}`, 'schoolMarketCheck'); } catch (_) {}
    return { ...v, corrected: true };
  }
  return v;
}

function _resetForTests() { _overrides.clear(); _loaded = false; }

module.exports = { verify, checkAndCorrect, saveOverride, overrideFor, load, ensureTable, specific, km, keyOf, MAX_KM, _resetForTests, loaded: () => _loaded };
