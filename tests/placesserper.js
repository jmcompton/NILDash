'use strict';
// Runs against the local test Postgres. No network: Serper and Google are fixtures.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/placesserper.js     just this one
//
// ── PLACES ON SERPER FIRST, GOOGLE UNDER A MONTHLY CAP ──────────────────────
// Google billed $222 on Nov 1 2026 for October's Places calls. Every Places
// request now goes through services/placesProvider: Serper Maps answers in
// Google's own shape, Google is the fallback, and Google stops at the cap.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

const { freshDb } = require('./helpers/freshDb');
const DB = freshDb('placesserper_t');
process.env.PGDATABASE = DB;
const { Pool } = require('pg');
const P = new Pool({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, database: DB });

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 400) : '')); } };

const PP = require(REPO + 'server/services/placesProvider.js');

const CENTER = { lat: 33.8285, lng: -118.0247 };
// Serper Maps fixture: `n` places around the centre, one far away.
function serperPlaces(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ position: i + 1, title: `${prefix} ${i}`, address: `${100 + i} Main St, Cypress, CA`,
      latitude: CENTER.lat + i * 0.001, longitude: CENTER.lng, rating: 4.5, ratingCount: 30 + i,
      type: 'Mexican restaurant', types: ['Mexican restaurant', 'Restaurant'], website: `https://${prefix.toLowerCase()}${i}.com/`,
      phoneNumber: '(714) 555-01' + String(i).padStart(2, '0'), placeId: `ChIJ${prefix}${i}`, cid: String(1000 + i), priceLevel: '$$' });
  }
  out.push({ title: 'Far Away Diner', address: 'Las Vegas, NV', latitude: 36.17, longitude: -115.14, type: 'Diner', placeId: 'ChIJfar' });
  return out;
}

function harness({ serperStatus = 200, googleStatus = 200 } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (/serper\.dev\/maps/.test(u)) {
      const body = JSON.parse(init.body);
      if (serperStatus !== 200) return new Response(JSON.stringify({ message: 'Not enough credits' }), { status: serperStatus });
      return new Response(JSON.stringify({ places: serperPlaces(5, body.q.split(' ')[0]), credits: 3 }), { status: 200 });
    }
    if (/places\.googleapis\.com/.test(u)) {
      if (googleStatus !== 200) return new Response(JSON.stringify({ error: { status: 'X', message: 'google says no' } }), { status: googleStatus });
      return new Response(JSON.stringify({ places: [{ id: 'g1', displayName: { text: 'From Google' }, location: { latitude: CENTER.lat, longitude: CENTER.lng } }] }), { status: 200 });
    }
    throw new Error('unexpected url ' + u);
  };
  return { calls, deps: { fetch, pool: P } };
}
const settle = () => new Promise((r) => setTimeout(r, 150));

async function main() {
  // The app's own startup work finishes first, so ending its pool is quiet.
  await require(REPO + 'server/store.js').ready;
  await P.query('DROP TABLE IF EXISTS places_usage');
  PP._reset();

  // ── 1. WHO ANSWERS ────────────────────────────────────────────────────────
  delete process.env.PLACES_PROVIDER;
  process.env.SERPER_API_KEY = 'sk-test';
  process.env.GOOGLE_PLACES_API_KEY = 'g-test';
  ok('Serper answers first when its key is set', PP.provider() === 'serper');
  process.env.PLACES_PROVIDER = 'google';
  ok('PLACES_PROVIDER=google forces Google', PP.provider() === 'google');
  delete process.env.PLACES_PROVIDER;
  delete process.env.SERPER_API_KEY;
  ok('no Serper key: Google', PP.provider() === 'google');
  process.env.SERPER_API_KEY = 'sk-test';
  ok('a Serper request is priced at 3 credits ($0.003), not Google\'s $0.032', Math.abs(PP.usdPerRequest() - 0.003) < 1e-9, PP.usdPerRequest());
  delete process.env.GOOGLE_PLACES_API_KEY;
  ok('apiKey(): Serper alone is enough to ask', PP.apiKey() === 'serper');
  process.env.GOOGLE_PLACES_API_KEY = 'g-test';

  // ── 2. NEARBY SEARCH, ANSWERED BY SERPER IN GOOGLE'S SHAPE ────────────────
  let h = harness();
  let r = await PP.placesFetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST', headers: { 'X-Goog-Api-Key': 'g-test' },
    body: JSON.stringify({ includedTypes: ['restaurant'], maxResultCount: 20, locationRestriction: { circle: { center: { latitude: CENTER.lat, longitude: CENTER.lng }, radius: 8000 } } }),
  }, h.deps);
  let j = await r.json();
  const sent = JSON.parse(h.calls[0].init.body);
  ok('nearby went to Serper Maps, not Google', h.calls.length === 1 && /serper\.dev\/maps/.test(h.calls[0].url), h.calls.map((c) => c.url));
  ok('  with the Serper key, never the Google key', h.calls[0].init.headers['X-API-KEY'] === 'sk-test' && !h.calls[0].init.headers['X-Goog-Api-Key']);
  ok('  searching the type as words at the centre (zoom 13 for 8 km)', sent.q === 'restaurant' && sent.ll === `@${CENTER.lat},${CENTER.lng},13z`, sent);
  ok('  the far-away result is dropped (outside the circle)', r.ok && j.places.length === 5 && !j.places.some((p) => p.id === 'ChIJfar'), j.places.map((p) => p.id));
  const p0 = j.places[0];
  ok('  Google shape: id, name, address, location', p0.id === 'ChIJrestaurant0' && p0.displayName.text === 'restaurant 0' && p0.formattedAddress && p0.location && Number.isFinite(p0.location.latitude), p0);
  ok('  types carry the searched type, then Serper\'s, as slugs', p0.types[0] === 'restaurant' && p0.types.includes('mexican_restaurant'), p0.types);
  ok('  primaryType and its display name', p0.primaryType === 'mexican_restaurant' && p0.primaryTypeDisplayName.text === 'Mexican restaurant', p0);
  ok('  rating, review count, website, phone, price level', p0.rating === 4.5 && p0.userRatingCount === 30 && p0.websiteUri && p0.nationalPhoneNumber && p0.priceLevel === 'PRICE_LEVEL_MODERATE', p0);
  ok('  a maps link built from the place id', /place_id:ChIJ/.test(p0.googleMapsUri), p0.googleMapsUri);

  // The market pool keeps working on it unchanged.
  const PM = require(REPO + 'server/services/placesMarket.js');
  const legacy = PM._legacyShape(p0);
  const cand = PM.toCandidate(legacy, 'restaurant');
  ok('placesMarket reads a Serper place: kept, categorised a restaurant', !cand.drop && cand.category === 'restaurant' && cand.place_id === p0.id && cand.user_ratings_total === 30, cand);

  // ── 3. TEXT SEARCH, WITH AND WITHOUT A RECTANGLE ──────────────────────────
  h = harness();
  r = await PP.placesFetch('https://places.googleapis.com/v1/places:searchText', { method: 'POST', body: JSON.stringify({ textQuery: 'Taqueria Cypress CA', maxResultCount: 1 }) }, h.deps);
  j = await r.json();
  ok('text search: one result, as asked; no ll without a location', j.places.length === 1 && !JSON.parse(h.calls[0].init.body).ll, j);
  h = harness();
  r = await PP.placesFetch('https://places.googleapis.com/v1/places:searchText', { method: 'POST', body: JSON.stringify({ textQuery: 'dentist', pageSize: 20,
    locationRestriction: { rectangle: { low: { latitude: CENTER.lat - 0.05, longitude: CENTER.lng - 0.05 }, high: { latitude: CENTER.lat + 0.05, longitude: CENTER.lng + 0.05 } } } }) }, h.deps);
  j = await r.json();
  ok('text search in a rectangle: only places inside it', j.places.length === 5 && JSON.parse(h.calls[0].init.body).ll, j.places.map((p) => p.id));

  // ── 4. AUTOCOMPLETE, THEN DETAILS FROM WHAT IT SAW ────────────────────────
  h = harness();
  r = await PP.placesFetch('https://places.googleapis.com/v1/places:autocomplete', { method: 'POST',
    body: JSON.stringify({ input: 'Mama', locationRestriction: { circle: { center: { latitude: CENTER.lat, longitude: CENTER.lng }, radius: 50000 } } }) }, h.deps);
  j = await r.json();
  const s0 = j.suggestions && j.suggestions[0] && j.suggestions[0].placePrediction;
  ok('autocomplete: suggestions in Google\'s shape, out-of-market dropped', s0 && s0.placeId && s0.structuredFormat.mainText.text && j.suggestions.length === 5, j);
  h = harness();
  r = await PP.placesFetch('https://places.googleapis.com/v1/places/' + encodeURIComponent(s0.placeId), { method: 'GET' }, h.deps);
  j = await r.json();
  ok('details for a place autocomplete just showed: no paid call at all', h.calls.length === 0 && j.id === s0.placeId && j.websiteUri, { calls: h.calls.length, j });
  h = harness();
  r = await PP.placesFetch('https://places.googleapis.com/v1/places/ChIJneverseen', { method: 'GET' }, h.deps);
  ok('details for a place never seen: Google, under the cap', h.calls.length === 1 && /googleapis/.test(h.calls[0].url) && r.ok);
  ok('  carrying the REAL Google key, whatever the caller sent', h.calls[0].init.headers['X-Goog-Api-Key'] === 'g-test');

  // ── 5. SERPER DOWN: GOOGLE CATCHES IT ─────────────────────────────────────
  h = harness({ serperStatus: 400 });
  r = await PP.placesFetch('https://places.googleapis.com/v1/places:searchText', { method: 'POST', body: JSON.stringify({ textQuery: 'x' }) }, h.deps);
  j = await r.json();
  ok('Serper out of credits: the same request goes to Google', h.calls.length === 2 && /googleapis/.test(h.calls[1].url) && j.places[0].id === 'g1', h.calls.map((c) => c.url));
  delete process.env.GOOGLE_PLACES_API_KEY;
  h = harness({ serperStatus: 400 });
  r = await PP.placesFetch('https://places.googleapis.com/v1/places:searchText', { method: 'POST', body: JSON.stringify({ textQuery: 'x' }) }, h.deps);
  ok('Serper down and no Google key: a 503 (we could not ask), never an empty answer', r.status === 503 && h.calls.length === 1, r.status);
  process.env.GOOGLE_PLACES_API_KEY = 'g-test';

  // ── 6. EVERY CALL IS WRITTEN DOWN ─────────────────────────────────────────
  await settle();
  const u = await P.query(`SELECT provider, kind, SUM(calls)::int AS calls, SUM(usd)::float AS usd FROM places_usage GROUP BY 1,2 ORDER BY 1,2`);
  const row = (pv, k) => u.rows.find((x) => x.provider === pv && x.kind === k) || { calls: 0, usd: 0 };
  ok('places_usage: Serper calls counted at $0.003 each', row('serper', 'searchNearby').calls === 1 && row('serper', 'searchText').calls === 4
    && Math.abs(row('serper', 'searchText').usd - 0.012) < 1e-6, u.rows);
  ok('places_usage: Google calls counted at Google\'s price', row('google', 'details').calls === 1 && row('google', 'searchText').calls === 1
    && Math.abs(row('google', 'searchText').usd - 0.035) < 1e-6, u.rows);

  // ── 7. THE CAP ────────────────────────────────────────────────────────────
  process.env.PLACES_PROVIDER = 'google';
  process.env.GOOGLE_PLACES_MONTHLY_CAP_USD = '25';
  await P.query(`INSERT INTO places_usage (hour, provider, kind, calls, usd) VALUES (date_trunc('hour', NOW()) - interval '1 hour', 'google', 'searchNearby', 700, 24.98)`);
  PP._reset();
  h = harness();
  r = await PP.placesFetch('https://places.googleapis.com/v1/places:searchNearby', { method: 'POST', body: '{}' }, h.deps);
  j = await r.json();
  ok('over the monthly cap: Google is NOT called', h.calls.length === 0, h.calls.length);
  ok('  a 429 RESOURCE_EXHAUSTED naming the cap, which callers never cache', r.status === 429 && j.error.status === 'RESOURCE_EXHAUSTED' && /cap/.test(j.error.message), j);
  process.env.GOOGLE_PLACES_MONTHLY_CAP_USD = '100';
  PP._reset();
  h = harness();
  r = await PP.placesFetch('https://places.googleapis.com/v1/places:searchNearby', { method: 'POST', body: '{}' }, h.deps);
  ok('raise the cap and Google answers again', h.calls.length === 1 && r.ok);
  await P.query(`INSERT INTO places_usage (hour, provider, kind, calls, usd) VALUES ('2026-01-15T10:00:00Z', 'google', 'searchNearby', 9999, 999)`);
  process.env.GOOGLE_PLACES_MONTHLY_CAP_USD = '25';
  await P.query(`DELETE FROM places_usage WHERE hour > '2026-02-01'`);
  PP._reset();
  h = harness();
  r = await PP.placesFetch('https://places.googleapis.com/v1/places:searchNearby', { method: 'POST', body: '{}' }, h.deps);
  ok('a past month\'s spend does not count against this month', h.calls.length === 1 && r.ok);
  delete process.env.PLACES_PROVIDER;
  delete process.env.GOOGLE_PLACES_MONTHLY_CAP_USD;

  // ── 8. THE NIGHTLY COST LINE COUNTS EVERY CALL ────────────────────────────
  const NC = require(REPO + 'server/services/nightCost.js');
  await P.query(`DELETE FROM places_usage`);
  await P.query(`INSERT INTO places_usage (hour, provider, kind, calls, usd) VALUES
    ('2026-10-26T02:00:00Z', 'serper', 'searchText', 120, 0.36),
    ('2026-10-26T03:00:00Z', 'google', 'details', 3, 0.06),
    ('2026-10-24T03:00:00Z', 'google', 'searchNearby', 500, 17.5)`);
  const pooled = { query: (sql, args) => (/places_usage/.test(sql) ? P.query(sql, args) : Promise.resolve({ rows: /COUNT\(\*\)::int AS n/.test(sql) ? [{ n: 0 }] : /est_usd/.test(sql) ? [{ usd: 0, calls: 0, unpriced: 0 }] : [] })) };
  const c = await NC.forRunDate(pooled, '2026-10-26');
  ok('cost line: every Places call in the night, both providers, at their own prices', c.placesCalls === 123 && Math.abs(c.placesUsd - 0.42) < 1e-6, c);
  const line = NC.render(c)[0];
  ok('  and it says which provider answered', /Places lookups \$0\.42 for 123 calls \(Google 3, Serper 120\)/.test(line), line);
  const older = await NC.forRunDate(pooled, '2026-09-01');
  ok('a night from before the table: falls back to the spend log (0 here), no crash', older.placesCalls === 0 && older.placesByProvider === null, older);

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  try { await require(REPO + 'server/store.js').pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('placesserper: FAILED', e); process.exit(1); });
