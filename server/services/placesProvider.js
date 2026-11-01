'use strict';
// ── WHO ANSWERS A PLACES QUESTION, AND WHAT IT COST ─────────────────────────
//
// Every Places request in the app (market pool builds, business lookups, the
// prospector, geocodes, "Add a Business" autocomplete) goes through placesFetch
// below instead of calling places.googleapis.com directly.
//
// WHY. Google billed $222 on Nov 1 2026 for October's Places usage. Google's
// Text and Nearby Search with phone/website/rating fields run about $0.035 a
// request; Serper's Maps search returns the same businesses (Google Maps data,
// same place ids, phone, website, rating, lat/lng) for 3 credits, about $0.003.
//
// HOW. placesFetch speaks Google's Places (New) API: callers send the same
// request and parse the same JSON they always did. Underneath:
//
//   1. Serper Maps first, when SERPER_API_KEY is set (PLACES_PROVIDER=google
//      forces Google). The request is translated to Serper and the answer is
//      translated back into the Places (New) shape.
//   2. Google only as the fallback (Serper down or out of credits, or a
//      details lookup Serper cannot answer), and only while this month's
//      Google spend is under GOOGLE_PLACES_MONTHLY_CAP_USD (default $25).
//   3. Over the cap, a 429 RESOURCE_EXHAUSTED answer, which every caller
//      already treats as "we could not ask" and never caches as a fact.
//
// Every call, either provider, is written to places_usage by the hour, which
// is what the nightly cost line and the cap read.

const SERPER_MAPS_URL = () => String(process.env.SERPER_MAPS_URL || 'https://google.serper.dev/maps');
const SERPER_CREDITS_PER_MAPS = () => Number(process.env.SERPER_MAPS_CREDITS) || 3;
const SERPER_USD_PER_CREDIT = () => {
  const v = parseFloat(process.env.SEARCH_USD_SERPER);
  return Number.isFinite(v) ? v : 0.001;
};
// Google Places (New) list prices per request, for the field tiers we ask for
// (phone, website, rating are Enterprise). Slightly high rather than low.
const GOOGLE_USD = { searchText: 0.035, searchNearby: 0.035, autocomplete: 0.00283, details: 0.02, other: 0.035 };
const monthlyCapUsd = () => {
  const v = parseFloat(process.env.GOOGLE_PLACES_MONTHLY_CAP_USD);
  return Number.isFinite(v) && v >= 0 ? v : 25;
};

function serperKey() { return String(process.env.SERPER_API_KEY || '').trim(); }
function googleKey() { return String(process.env.GOOGLE_PLACES_API_KEY || '').trim(); }
// What a caller checks before asking: something that can answer. The Google
// key when there is one (it goes in the X-Goog-Api-Key header the callers
// already send); otherwise 'serper' when Serper can answer; '' when nothing can.
function apiKey() { return googleKey() || (provider() === 'serper' ? 'serper' : ''); }

// 'serper' or 'google': who answers first.
function provider() {
  const forced = String(process.env.PLACES_PROVIDER || '').trim().toLowerCase();
  if (forced === 'google') return 'google';
  if (forced === 'serper') return serperKey() ? 'serper' : 'google';
  return serperKey() ? 'serper' : 'google';
}

// What one Places request costs on the meter, for the provider answering first.
function usdPerRequest() {
  return provider() === 'serper'
    ? Math.round(SERPER_CREDITS_PER_MAPS() * SERPER_USD_PER_CREDIT() * 100000) / 100000
    : GOOGLE_USD.searchNearby;
}

// ── THE USAGE TABLE ─────────────────────────────────────────────────────────
let _tableReady = null;
function _pool() { try { return require('../store').pool; } catch (_) { return null; } }
async function ensureTable(pool) {
  pool = pool || _pool();
  if (!pool) return false;
  if (!_tableReady) {
    _tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS places_usage (
        hour      TIMESTAMPTZ NOT NULL,
        provider  TEXT NOT NULL,
        kind      TEXT NOT NULL,
        calls     INT NOT NULL DEFAULT 0,
        usd       NUMERIC(12,5) NOT NULL DEFAULT 0,
        PRIMARY KEY (hour, provider, kind)
      )`).then(() => true).catch((e) => { _tableReady = null; console.error('[places] places_usage table:', e.message); return false; });
  }
  return _tableReady;
}

// This month's Google spend, in this process: last read from the table, plus
// what this process has spent since. Re-read every 5 minutes so several
// processes share one cap.
const _google = { month: null, dbUsd: 0, localUsd: 0, readAt: 0 };
function _monthKey(d = new Date()) { return d.toISOString().slice(0, 7); }
async function googleMonthUsd(opts = {}) {
  const m = _monthKey();
  if (_google.month !== m) { _google.month = m; _google.dbUsd = 0; _google.localUsd = 0; _google.readAt = 0; }
  if (opts.fresh || Date.now() - _google.readAt > 5 * 60000) {
    const pool = opts.pool || _pool();
    if (pool && await ensureTable(pool)) {
      try {
        const r = await pool.query(`SELECT COALESCE(SUM(usd),0)::float AS usd FROM places_usage
          WHERE provider = 'google' AND hour >= date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`);
        _google.dbUsd = Number(r.rows[0].usd) || 0;
        _google.localUsd = 0;
        _google.readAt = Date.now();
      } catch (e) { console.error('[places] could not read places_usage:', e.message); }
    }
  }
  return _google.dbUsd + _google.localUsd;
}

async function record(providerName, kind, usd, opts = {}) {
  if (providerName === 'google') _google.localUsd += usd;
  const pool = opts.pool || _pool();
  if (!pool || !(await ensureTable(pool))) return;
  try {
    await pool.query(
      `INSERT INTO places_usage (hour, provider, kind, calls, usd) VALUES (date_trunc('hour', NOW()), $1, $2, 1, $3)
       ON CONFLICT (hour, provider, kind) DO UPDATE SET calls = places_usage.calls + 1, usd = places_usage.usd + EXCLUDED.usd`,
      [providerName, kind, usd]);
  } catch (e) { console.error('[places] could not record usage:', e.message); }
}

// Calls and dollars in a time window, by provider. null when the table has
// nothing in it (a window from before this table existed).
async function usageBetween(pool, from, to) {
  if (!(await ensureTable(pool))) return null;
  const r = await pool.query(
    `SELECT provider, SUM(calls)::int AS calls, SUM(usd)::float AS usd FROM places_usage
      WHERE hour >= date_trunc('hour', $1::timestamptz) AND hour < $2 GROUP BY provider`, [from, to]);
  if (!r.rows.length) return null;
  const out = { calls: 0, usd: 0, byProvider: {} };
  for (const row of r.rows) {
    out.calls += row.calls; out.usd += Number(row.usd) || 0;
    out.byProvider[row.provider] = { calls: row.calls, usd: Math.round((Number(row.usd) || 0) * 1000) / 1000 };
  }
  out.usd = Math.round(out.usd * 1000) / 1000;
  return out;
}

// ── TRANSLATION ─────────────────────────────────────────────────────────────
// Which Google endpoint a URL is.
function kindOf(url, method) {
  const u = String(url);
  if (/places:searchText/.test(u)) return 'searchText';
  if (/places:searchNearby/.test(u)) return 'searchNearby';
  if (/places:autocomplete/.test(u)) return 'autocomplete';
  if (/\/v1\/places\/[^/:?]+/.test(u) && String(method || 'GET').toUpperCase() === 'GET') return 'details';
  return 'other';
}

// A Google place type, as words a Maps search understands.
const TYPE_WORDS = {
  meal_takeaway: 'takeout restaurant', hair_care: 'hair salon', beauty_salon: 'beauty salon', car_dealer: 'car dealership',
  car_repair: 'auto repair shop', home_goods_store: 'home goods store', real_estate_agency: 'real estate agency',
  insurance_agency: 'insurance agency', veterinary_care: 'veterinarian', physiotherapist: 'physical therapy clinic',
  sporting_goods_store: 'sporting goods store', cafe: 'coffee shop',
};
function typeWords(t) { return TYPE_WORDS[t] || String(t || '').replace(/_/g, ' '); }

function slug(s) { return String(s || '').trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }

const PRICE_ENUM = [null, 'PRICE_LEVEL_INEXPENSIVE', 'PRICE_LEVEL_MODERATE', 'PRICE_LEVEL_EXPENSIVE', 'PRICE_LEVEL_VERY_EXPENSIVE'];
function priceLevelOf(v) {
  const n = (String(v || '').match(/\$/g) || []).length;
  return n >= 1 && n <= 4 ? PRICE_ENUM[n] : undefined;
}

// Zoom for a circle of this radius, so the map search looks at about that much ground.
function zoomFor(radiusM) {
  const r = Number(radiusM) || 8000;
  if (r <= 1500) return 15;
  if (r <= 3000) return 14;
  if (r <= 8000) return 13;
  if (r <= 16000) return 12;
  if (r <= 32000) return 11;
  return 10;
}

function distanceM(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// One Serper Maps place -> one Places (New) place resource.
function toGooglePlace(s, searchedType) {
  const placeId = s.placeId || (s.cid ? 'cid:' + s.cid : null);
  const label = s.type || (Array.isArray(s.types) && s.types[0]) || null;
  const types = [];
  const add = (t) => { const k = slug(t); if (k && !types.includes(k)) types.push(k); };
  if (searchedType) add(searchedType);
  if (label) add(label);
  for (const t of (Array.isArray(s.types) ? s.types : [])) add(t);
  const p = {
    id: placeId,
    displayName: { text: s.title || '', languageCode: 'en' },
    formattedAddress: s.address || undefined,
    shortFormattedAddress: s.address || undefined,
    types,
    primaryType: label ? slug(label) : (searchedType || undefined),
    primaryTypeDisplayName: label ? { text: label, languageCode: 'en' } : undefined,
    rating: s.rating != null ? Number(s.rating) : undefined,
    userRatingCount: s.ratingCount != null ? Number(s.ratingCount) : undefined,
    websiteUri: s.website || undefined,
    nationalPhoneNumber: s.phoneNumber || undefined,
    internationalPhoneNumber: s.phoneNumber || undefined,
    googleMapsUri: s.placeId ? `https://www.google.com/maps/place/?q=place_id:${s.placeId}` : (s.cid ? `https://maps.google.com/?cid=${s.cid}` : undefined),
    priceLevel: priceLevelOf(s.priceLevel),
  };
  if (Number.isFinite(Number(s.latitude)) && Number.isFinite(Number(s.longitude))) {
    p.location = { latitude: Number(s.latitude), longitude: Number(s.longitude) };
  }
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  return p;
}

// Recently seen places by id, so a details lookup right after an autocomplete
// or a search is answered without another paid call.
const _seen = new Map();
const SEEN_MAX = 5000;
function _remember(places) {
  for (const p of places) {
    if (!p || !p.id) continue;
    _seen.delete(p.id); _seen.set(p.id, p);
    if (_seen.size > SEEN_MAX) _seen.delete(_seen.keys().next().value);
  }
}

function _json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function _capResponse(spent, cap) {
  return _json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED',
    message: `NILDash monthly Google Places cap reached ($${spent.toFixed(2)} of $${cap.toFixed(2)} this month). Raise GOOGLE_PLACES_MONTHLY_CAP_USD to allow more.` } });
}

// One Serper Maps request. -> { ok, places } or { ok: false, status, message }
async function serperMaps({ q, center, zoom, page }, init = {}, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const body = { q: String(q || '').trim() };
  if (center) body.ll = `@${center.lat},${center.lng},${zoom || 13}z`;
  if (page && page > 1) body.page = page;
  const usd = Math.round(SERPER_CREDITS_PER_MAPS() * SERPER_USD_PER_CREDIT() * 100000) / 100000;
  try {
    const resp = await fetchImpl(SERPER_MAPS_URL(), {
      method: 'POST', signal: init.signal,
      headers: { 'content-type': 'application/json', 'X-API-KEY': serperKey() },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    record('serper', deps.kind || 'maps', usd, deps);
    if (!resp.ok) {
      const e = { status: resp.status, message: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
      try { require('./ourFault').providerError('serper', e, 'placesProvider'); } catch (_) {}
      return { ok: false, status: resp.status, message: e.message };
    }
    let j = {}; try { j = JSON.parse(text); } catch (_) { return { ok: false, status: 502, message: 'Serper answered with something that is not JSON' }; }
    // A 200 with no places list is not "nothing there": callers cache a
    // confirmed empty answer for 30 days, so an answer we cannot read is a
    // failure, and Google (under the cap) gets the question instead.
    if (!j || !Array.isArray(j.places)) return { ok: false, status: 502, message: 'Serper answered without a places list' };
    return { ok: true, places: j.places };
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;   // the caller's own timeout: same as a Google timeout
    return { ok: false, status: 0, message: 'Serper request failed: ' + (e && e.message) };
  }
}

// Google request -> Serper answer in Google's shape, or null when Serper could
// not answer (the caller then falls back to Google, under the cap).
async function viaSerper(kind, url, init, deps) {
  let req = {};
  try { req = init && init.body ? JSON.parse(init.body) : {}; } catch (_) { req = {}; }
  const d = { ...deps, kind };

  if (kind === 'details') {
    const id = decodeURIComponent(String(url).split('/v1/places/')[1] || '').split(/[?:]/)[0];
    const hit = _seen.get(id);
    return hit ? _json(200, hit) : null;
  }

  if (kind === 'searchNearby') {
    const c = req.locationRestriction && req.locationRestriction.circle;
    if (!c || !c.center) return null;
    const center = { lat: c.center.latitude, lng: c.center.longitude };
    const type = Array.isArray(req.includedTypes) && req.includedTypes[0];
    const r = await serperMaps({ q: typeWords(type || 'business'), center, zoom: zoomFor(c.radius) }, init, d);
    if (!r.ok) return null;
    const max = Number(req.maxResultCount) || 20;
    const places = r.places.map((s) => toGooglePlace(s, type))
      .filter((p) => !p.location || distanceM(center, { lat: p.location.latitude, lng: p.location.longitude }) <= Number(c.radius || 8000))
      .slice(0, max);
    _remember(places);
    return _json(200, { places });
  }

  if (kind === 'searchText') {
    const max = Number(req.pageSize || req.maxResultCount) || 20;
    let center = null, zoom = null, inside = () => true;
    const rect = req.locationRestriction && req.locationRestriction.rectangle;
    const bias = req.locationBias && req.locationBias.circle;
    if (rect && rect.low && rect.high) {
      center = { lat: (rect.low.latitude + rect.high.latitude) / 2, lng: (rect.low.longitude + rect.high.longitude) / 2 };
      const halfM = distanceM(center, { lat: rect.high.latitude, lng: center.lng });
      zoom = zoomFor(halfM);
      inside = (p) => !p.location || (p.location.latitude >= rect.low.latitude && p.location.latitude <= rect.high.latitude
        && p.location.longitude >= rect.low.longitude && p.location.longitude <= rect.high.longitude);
    } else if (bias && bias.center) {
      center = { lat: bias.center.latitude, lng: bias.center.longitude }; zoom = zoomFor(bias.radius);
    }
    const r = await serperMaps({ q: req.textQuery, center, zoom }, init, d);
    if (!r.ok) return null;
    const places = r.places.map((s) => toGooglePlace(s, null)).filter(inside).slice(0, max);
    _remember(places);
    return _json(200, { places });
  }

  if (kind === 'autocomplete') {
    const circle = (req.locationRestriction && req.locationRestriction.circle) || (req.locationBias && req.locationBias.circle) || null;
    const restricted = !!(req.locationRestriction && req.locationRestriction.circle);
    const center = circle && circle.center ? { lat: circle.center.latitude, lng: circle.center.longitude } : null;
    const r = await serperMaps({ q: req.input, center, zoom: center ? zoomFor(circle.radius) : null }, init, d);
    if (!r.ok) return null;
    let places = r.places.map((s) => toGooglePlace(s, null)).filter((p) => p.id);
    if (restricted && center) places = places.filter((p) => !p.location || distanceM(center, { lat: p.location.latitude, lng: p.location.longitude }) <= Number(circle.radius || 50000));
    _remember(places);
    return _json(200, { suggestions: places.map((p) => ({ placePrediction: {
      placeId: p.id, text: { text: [p.displayName.text, p.formattedAddress].filter(Boolean).join(', ') },
      structuredFormat: { mainText: { text: p.displayName.text }, secondaryText: { text: p.formattedAddress || '' } },
    } })) });
  }
  return null;
}

// Google itself, under the monthly cap.
async function viaGoogle(kind, url, init, deps) {
  const cap = monthlyCapUsd();
  const spent = await googleMonthUsd(deps);
  const price = GOOGLE_USD[kind] || GOOGLE_USD.other;
  if (spent + price > cap) {
    console.error(`[places] Google Places blocked: $${spent.toFixed(2)} spent this month, cap $${cap.toFixed(2)} (${kind})`);
    return _capResponse(spent, cap);
  }
  const fetchImpl = deps.fetch || globalThis.fetch;
  // The real Google key, whatever the caller put in the header.
  const headers = { ...((init && init.headers) || {}) };
  if (googleKey()) headers['X-Goog-Api-Key'] = googleKey();
  const resp = await fetchImpl(url, { ...init, headers });
  record('google', kind, price, deps);
  return resp;
}

// fetch(url, init) for places.googleapis.com, answered by Serper or Google.
// deps: { fetch, pool } for tests.
async function placesFetch(url, init = {}, deps = {}) {
  const kind = kindOf(url, init.method);
  if (provider() === 'serper') {
    const r = await viaSerper(kind, url, init, deps);
    if (r) return r;
    if (!googleKey()) return _json(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'Serper could not answer this Places request and GOOGLE_PLACES_API_KEY is not set' } });
  }
  return viaGoogle(kind, url, init, deps);
}

module.exports = { placesFetch, provider, apiKey, usdPerRequest, usageBetween, googleMonthUsd, record, ensureTable, monthlyCapUsd,
  toGooglePlace, typeWords, zoomFor, kindOf, serperMaps, GOOGLE_USD,
  _reset() { _google.month = null; _google.dbUsd = 0; _google.localUsd = 0; _google.readAt = 0; _seen.clear(); _tableReady = null; } };
