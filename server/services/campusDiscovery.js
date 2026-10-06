'use strict';
// ── THE NIGHT FINDS NEW GROUND, A LITTLE AT A TIME ──────────────────────────
//
// The university night used to open with a full Places sweep of the campus
// (30 types x up to 5 calls, $0.96 to $4.80) every night: the same ground,
// bought again. That was removed, and the night then only spent: 88 named
// contacts, 85 cards, 4 left. This puts discovery back, incrementally.
//
// THE GROUND IS A GRID. Squares of CELL_KM around the campus, out to the drive
// distance (campusBuild.DRIVE_KM), in three bands (inside 8 km, 8-16, 16+).
// A SEARCH is one square and one thing to look for:
//   a business type   (searchNearby, the kinds most likely to sponsor first)
//   a search term     (searchText: "sports medicine", "batting cages"...)
// Every search is written to university_discovery_cells before the next, keyed
// by the square and what was asked, and is NEVER asked again. A square that
// comes back full (20, Google's ceiling: there is more there) is split into
// four half-size squares for that same type, so dense ground is searched
// deeper and thin ground is never searched twice.
//
// THE ORDER: the inner band first; within it, the kinds of business most
// likely to do an athlete deal (campusQuality priorities); a type whose last
// three searches in a band found nothing new goes to the back of the line.
// Then the next band. Dentists are never searched for: Cypress has too many.
//
// ONE SEARCH IS ONE PLACES REQUEST ($0.032). run() stops before a search the
// budget cannot cover.

const CELL_KM = parseFloat(process.env.CAMPUS_DISCOVERY_CELL_KM) || 4;
const MIN_CELL_KM = 1;
const BANDS_KM = [8, 16];
// [type, priority] -- Places (New) Table A types. Highest first.
const TYPES = [
  ['physiotherapist', 10], ['chiropractor', 10], ['gym', 10], ['fitness_center', 10], ['sporting_goods_store', 9],
  ['cafe', 9], ['coffee_shop', 9], ['juice_shop', 9], ['restaurant', 9], ['meal_takeaway', 9],
  ['clothing_store', 9], ['shoe_store', 9], ['barber_shop', 8], ['hair_salon', 8], ['beauty_salon', 8],
  ['car_dealer', 8], ['car_repair', 8], ['car_wash', 8], ['bakery', 7], ['ice_cream_shop', 7],
  ['bowling_alley', 7], ['florist', 7], ['pet_store', 7], ['insurance_agency', 5], ['real_estate_agency', 5],
];
// Words that find what no type does. One searchText each per square.
const TERMS = [
  ['sports medicine', 10], ['physical therapy', 10], ['batting cages', 9], ['martial arts', 9], ['boxing gym', 9],
  ['smoothie', 9], ['boba tea', 9], ['taqueria', 9], ['pizza', 9], ['burgers', 9],
  ['screen printing', 8], ['trophies and awards', 8], ['tire shop', 8], ['auto detailing', 8],
];
const STALE_AFTER = 3;   // searches in a row with nothing new: to the back of the line

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS university_discovery_cells (
    market_key TEXT NOT NULL, cell_key TEXT NOT NULL, kind TEXT NOT NULL, what TEXT NOT NULL,
    band INTEGER NOT NULL, lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL, size_km REAL NOT NULL,
    ok BOOLEAN NOT NULL, error TEXT, returned INTEGER NOT NULL DEFAULT 0, kept INTEGER NOT NULL DEFAULT 0,
    new_businesses INTEGER NOT NULL DEFAULT 0, new_usable INTEGER NOT NULL DEFAULT 0, saturated BOOLEAN NOT NULL DEFAULT FALSE,
    places_calls INTEGER NOT NULL DEFAULT 1, night DATE, searched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (market_key, cell_key))`);
}

function offset(c, northM, eastM) {
  return { lat: c.lat + northM / 111320, lng: c.lng + eastM / (111320 * Math.cos((c.lat * Math.PI) / 180)) };
}
function distKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bandOf(km) { let b = 0; while (b < BANDS_KM.length && km >= BANDS_KM[b]) b++; return b; }

// The square's key: its grid position and size, not floating coordinates, so
// the same square is the same key on every night.
function squareKey(i, j, sizeKm) { return `${sizeKm}km:${i},${j}`; }

// Every top-level square inside the drive distance, nearest first.
function squares(center, driveKm) {
  const n = Math.ceil(driveKm / CELL_KM);
  const out = [];
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const c = offset(center, i * CELL_KM * 1000, j * CELL_KM * 1000);
    const km = distKm(center, c);
    if (km - CELL_KM * 0.71 > driveKm) continue;
    out.push({ key: squareKey(i, j, CELL_KM), i, j, sizeKm: CELL_KM, center: c, km, band: bandOf(km) });
  }
  return out.sort((a, b) => a.km - b.km);
}

// The four quarter squares of a full one.
function children(sq, center) {
  const half = sq.sizeKm / 2;
  if (half < MIN_CELL_KM) return [];
  return [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([di, dj]) => {
    const c = offset(sq.center, di * half * 500, dj * half * 500);
    const km = distKm(center, c);
    return { key: `${sq.key}/${di > 0 ? 'n' : 's'}${dj > 0 ? 'e' : 'w'}`, sizeKm: half, center: c, km, band: bandOf(km) };
  });
}

function searchKey(kind, what, sq) { return `${kind}:${what}@${sq.key}`; }

// THE FRONTIER: every search not yet made, in the order the night makes them.
// done: Map cell_key -> row. Returns [{ kind, what, priority, sq, key }].
function frontier(center, driveKm, done) {
  const top = squares(center, driveKm);
  const out = [];
  const consider = (kind, what, priority, sq) => {
    const key = searchKey(kind, what, sq);
    const row = done.get(key);
    if (!row) { out.push({ kind, what, priority, sq, key }); return; }
    // Searched. Full: its four quarters, searched the same way.
    if (row.saturated) for (const ch of children(sq, center)) consider(kind, what, priority, ch);
  };
  for (const sq of top) {
    for (const [t, p] of TYPES) consider('type', t, p, sq);
    for (const [t, p] of TERMS) consider('term', t, p, sq);
  }
  // A type or term whose last STALE_AFTER searches in a band found nothing new.
  const recent = new Map();
  for (const r of [...done.values()].sort((a, b) => new Date(b.searched_at) - new Date(a.searched_at))) {
    const k = `${r.kind}:${r.what}:${r.band}`;
    const list = recent.get(k) || [];
    if (list.length < STALE_AFTER) { list.push(r); recent.set(k, list); }
  }
  const stale = (s) => {
    const list = recent.get(`${s.kind}:${s.what}:${s.sq.band}`) || [];
    return list.length >= STALE_AFTER && list.every((r) => !r.new_usable);
  };
  return out.map((s) => ({ ...s, stale: stale(s) }))
    .sort((a, b) => (a.sq.band - b.sq.band) || ((a.stale ? 1 : 0) - (b.stale ? 1 : 0)) || (b.priority - a.priority)
      || (a.sq.km - b.sq.km) || a.key.localeCompare(b.key));
}

// The campus centre: stored by create-university (universities.lat/lng), or
// geocoded once here and stored. Returns { center, calls }.
async function campusCenter(pool, uni, places) {
  const row = (await pool.query(`SELECT * FROM universities WHERE id = $1`, [uni.id])).rows[0] || {};
  if (row.lat != null && row.lng != null) return { center: { lat: Number(row.lat), lng: Number(row.lng) }, calls: 0 };
  const P = places || require('./placesMarket');
  const apiKey = (process.env.GOOGLE_PLACES_API_KEY || '').trim();
  if (!P.geocodeSchool || (!apiKey && !places)) return { center: null, calls: 0, error: 'no campus centre and no Places key to find it' };
  const g = await P.geocodeSchool(uni.location, apiKey);
  if (!g.coords) return { center: null, calls: g.calls || 0, error: g.error || 'geocode failed' };
  await pool.query(`ALTER TABLE universities ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`).catch(() => {});
  await pool.query(`ALTER TABLE universities ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`).catch(() => {});
  await pool.query(`UPDATE universities SET lat = $2, lng = $3 WHERE id = $1`, [uni.id, g.coords.lat, g.coords.lng]).catch(() => {});
  return { center: g.coords, calls: g.calls || 1 };
}

async function searched(pool, marketKey) {
  await ensureTable(pool);
  const rows = (await pool.query(`SELECT * FROM university_discovery_cells WHERE market_key = $1`, [marketKey])).rows;
  return new Map(rows.map((r) => [r.cell_key, r]));
}

// ── RUN: as many new searches as the budget covers ──────────────────────────
// opts: { budgetUsd, maxCalls, night, places (tests: { nearbyCell, textCell, geocodeSchool }) }
// Returns { ok, calls, usd, searches, newBusinesses, newUsable, saturated, errors, left (searches not yet made) }.
async function run(pool, uni, opts = {}) {
  const Q = require('./outreachQueue');
  const TS = require('./teamScan');
  const P = opts.places || require('./placesMarket');
  const per = Q.USD_PER_PLACES_REQUEST;
  const budget = Number(opts.budgetUsd) || 0;
  const maxCalls = Number(opts.maxCalls) > 0 ? Number(opts.maxCalls) : Infinity;
  const out = { ok: true, calls: 0, usd: 0, searches: [], newBusinesses: 0, newUsable: 0, saturated: 0, errors: [], left: null };
  if (budget < per) { out.stoppedFor = 'budget'; return out; }
  const cc = await campusCenter(pool, uni, opts.places);
  out.calls += cc.calls;
  if (!cc.center) return { ...out, ok: false, error: cc.error, usd: Math.round(out.calls * per * 1000) / 1000 };
  const driveKm = require('./campusBuild').DRIVE_KM;
  let done = await searched(pool, uni.marketKey);
  let queue = frontier(cc.center, driveKm, done);
  while (queue.length) {
    if ((out.calls + 1) * per > budget + 1e-9) { out.stoppedFor = 'budget'; break; }
    if (out.searches.length >= maxCalls) { out.stoppedFor = 'calls'; break; }
    const s = queue.shift();
    const radiusM = Math.round(s.sq.sizeKm * 1000 * 0.71);   // the circle round the square
    const r = s.kind === 'type'
      ? await P.nearbyCell({ center: s.sq.center, radiusM, type: s.what })
      : await P.textCell({ center: s.sq.center, radiusM: Math.round(s.sq.sizeKm * 500), term: s.what });
    if (!r.calls && !r.ok) { out.ok = false; out.error = r.error; break; }   // no key: nothing was spent
    out.calls += r.calls || 1;
    // WRITTEN DOWN FIRST: the search is paid for, so it is recorded before
    // anything else can fail, and is never asked again whatever happens next.
    const night = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.night || '')) ? opts.night : null;
    await pool.query(
      `INSERT INTO university_discovery_cells (market_key, cell_key, kind, what, band, lat, lng, size_km, ok, error, returned, saturated, places_calls, night)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (market_key, cell_key) DO NOTHING`,
      [uni.marketKey, s.key, s.kind, s.what, s.sq.band, s.sq.center.lat, s.sq.center.lng, s.sq.sizeKm, !!r.ok, r.error || null,
        (r.results || []).length, !!r.saturated, r.calls || 1, night]);
    let st = { inserted: [], kept: 0 };
    let kept = [];
    if (r.ok) {
      try {
        const PM = require('./placesMarket');
        kept = (r.results || []).map((x) => PM.toCandidate(x, s.kind === 'type' ? s.what : null)).filter((c) => !c.drop)
          // The circle is round the square; a place outside the drive distance is not this campus's.
          .filter((c) => c.lat == null || distKm(cc.center, { lat: c.lat, lng: c.lng }) <= driveKm);
        st = await TS.storeCandidates(pool, uni.marketKey, cc.center, kept);
      } catch (e) { out.errors.push(`${s.key}: storing: ${e.message}`); }
    } else out.errors.push(`${s.key}: ${r.error}`);
    const newUsable = st.inserted.filter((x) => !x.blocked).length;
    await pool.query(`UPDATE university_discovery_cells SET kept = $3, new_businesses = $4, new_usable = $5 WHERE market_key = $1 AND cell_key = $2`,
      [uni.marketKey, s.key, kept.length, st.inserted.length, newUsable]).catch(() => {});
    out.searches.push({ key: s.key, kind: s.kind, what: s.what, band: s.sq.band, returned: (r.results || []).length, newBusinesses: st.inserted.length, newUsable, saturated: !!r.saturated, ok: !!r.ok });
    out.newBusinesses += st.inserted.length; out.newUsable += newUsable;
    if (r.saturated) out.saturated++;
    // A full square adds its quarters; a dead streak moves a type back. Re-plan.
    if (r.saturated || !newUsable) { done = await searched(pool, uni.marketKey); queue = frontier(cc.center, driveKm, done); }
  }
  out.usd = Math.round(out.calls * per * 1000) / 1000;
  out.left = queue.length;
  return out;
}

// What has been searched, and what is left (for status). Spends nothing.
async function coverage(pool, uni) {
  await ensureTable(pool);
  const r = (await pool.query(`SELECT COUNT(*)::int AS searches, COALESCE(SUM(places_calls),0)::int AS calls, COALESCE(SUM(new_businesses),0)::int AS found,
                                      COALESCE(SUM(new_usable),0)::int AS usable, COUNT(DISTINCT night)::int AS nights,
                                      COALESCE(SUM(new_usable) FILTER (WHERE searched_at > NOW() - INTERVAL '7 days'),0)::int AS usable7,
                                      COUNT(*) FILTER (WHERE searched_at > NOW() - INTERVAL '7 days')::int AS searches7
                                 FROM university_discovery_cells WHERE market_key = $1`, [uni.marketKey])).rows[0];
  const row = (await pool.query(`SELECT * FROM universities WHERE id = $1`, [uni.id])).rows[0] || {};
  let left = null;
  if (row.lat != null) left = frontier({ lat: Number(row.lat), lng: Number(row.lng) }, require('./campusBuild').DRIVE_KM, await searched(pool, uni.marketKey)).length;
  return { ...r, left, perSearchUsable: r.searches ? Math.round((r.usable / r.searches) * 100) / 100 : null };
}

module.exports = { run, coverage, frontier, squares, children, searched, campusCenter, ensureTable, TYPES, TERMS, CELL_KM, BANDS_KM, STALE_AFTER };
