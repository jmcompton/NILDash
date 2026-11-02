'use strict';
// ── GOOGLE PLACES QUESTIONS, ANSWERED BY SERPER (services/serperPlaces) ─────
// Local test Postgres; Serper and Google are stand-ins answering a fake fetch.
//
//   - on when SERPER_API_KEY is set, off with PLACES_PROVIDER=google;
//   - a market build asks Serper, never Google, and builds the same pool:
//     kept to the circle, closed and thin places dropped, the category taken
//     from what the place IS, not what was searched;
//   - a business lookup and the Prospector's IT-company search ask Serper;
//   - a failed Serper call falls back to Google exactly as before.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('serperplacestest', { schema: true });
require('./helpers/offlineDns').install();
process.env.GOOGLE_PLACES_API_KEY = 'google-test-key';
process.env.SERPER_API_KEY = 'serper-test-key';
delete process.env.PLACES_PROVIDER;

const store = require(REPO + 'server/store.js');
const SP = require(REPO + 'server/services/serperPlaces.js');
const PM = require(REPO + 'server/services/placesMarket.js');
const PL = require(REPO + 'server/services/placesLookup.js');
const PR = require(REPO + 'server/services/prospector/places.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 500) : '')); } };

const CENTER = { lat: 33.4646, lng: -86.7906 }; // Samford
const near = (dLat) => CENTER.lat + dLat;
let serperCalls = [], googleCalls = [], serperDown = false;
const serperPlace = (i, extra = {}) => ({ title: `Biz ${i}`, address: `${i} Main St, Homewood, AL`, latitude: near(0.001 * i), longitude: CENTER.lng,
  rating: 4.5, ratingCount: 50, type: 'Mexican restaurant', website: `https://biz${i}.test`, phoneNumber: '(205) 555-0100', cid: String(1000 + i), placeId: `ChIJ${i}`, ...extra });
const serperFetch = async (url, init) => {
  const body = JSON.parse(init.body);
  serperCalls.push({ url, body });
  if (serperDown) return { ok: false, status: 500, json: async () => ({ message: 'down' }) };
  if (/Samford/i.test(body.q)) return { ok: true, status: 200, json: async () => ({ places: [{ title: 'Samford University', latitude: CENTER.lat, longitude: CENTER.lng, type: 'University', placeId: 'ChIJsam' }] }) };
  if (/\/places$/.test(url)) return { ok: true, status: 200, json: async () => ({ places: [serperPlace(1, { title: 'Joe\'s Pizza', type: undefined, category: 'Pizza restaurant' })] }) };
  // A Maps search: schools geocode to the campus; every business type gets the same small market,
  // one place far outside the circle, one with too few reviews.
  return { ok: true, status: 200, json: async () => ({ places: [serperPlace(1), serperPlace(2, { type: 'Race course' }), serperPlace(3, { ratingCount: 2 }), serperPlace(9, { latitude: near(1.5) })] }) };
};
const googleFetch = async (url) => {
  googleCalls.push(url);
  if (/searchText/.test(url)) return { ok: true, status: 200, json: async () => ({ places: [{ id: 'gplace', displayName: { text: 'Google Spot' }, location: { latitude: CENTER.lat, longitude: CENTER.lng }, userRatingCount: 40, types: ['restaurant'], primaryType: 'restaurant', businessStatus: 'OPERATIONAL' }] }) };
  return { ok: true, status: 200, json: async () => ({ places: [] }) };
};

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));

  OUT.push('-- the switch --');
  ok('on with a Serper key', SP.ON() === true);
  process.env.PLACES_PROVIDER = 'google';
  ok('PLACES_PROVIDER=google turns it off', SP.ON() === false);
  delete process.env.PLACES_PROVIDER;
  const k = process.env.SERPER_API_KEY; delete process.env.SERPER_API_KEY;
  ok('no Serper key, off', SP.ON() === false);
  process.env.SERPER_API_KEY = k;

  OUT.push('-- a market build --');
  const r = await PM.buildMarketPoolFromPlaces('Samford University', { fetch: googleFetch, serperFetch, record: false, source: 'test' });
  ok('the build asks Serper and never Google', r.ok && googleCalls.length === 0 && serperCalls.length > 0, { ok: r.ok, reason: r.reason, google: googleCalls.length });
  const nearbyCall = serperCalls.find((c) => c.body.q === 'coffee shop');
  ok('each business type is a Maps search around the campus, in plain words', nearbyCall && /^@33\.4646,-86\.7906,1[23]z$/.test(nearbyCall.body.ll), nearbyCall);
  const names = r.candidates.map((c) => c.name).sort();
  ok('kept to the circle and to places with enough reviews', JSON.stringify(names) === JSON.stringify(['Biz 1', 'Biz 2']), names);
  const b1 = r.candidates.find((c) => c.name === 'Biz 1'), b2 = r.candidates.find((c) => c.name === 'Biz 2');
  ok('the category comes from what the place is', b1.category === 'restaurant' && b2.category !== 'restaurant', [b1.category, b2.category]);
  ok('the pool keeps the place id, address, rating and location', b1.place_id === 'ChIJ1' && /Main St/.test(b1.address) && b1.user_ratings_total === 50 && b1.lat != null);

  OUT.push('-- one business, and the IT-company search --');
  serperCalls = []; googleCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (/serper\.dev/.test(url) ? serperFetch(url, init) : googleFetch(url, init));
  const one = await PL.lookupPlaceResult('Joe\'s Pizza', 'Homewood, AL');
  ok('a business lookup asks Serper and gets the phone and website', one.ok && one.place && one.place.name === 'Joe\'s Pizza' && one.place.website && one.place.phone && googleCalls.length === 0, { one, googleCalls });
  globalThis.fetch = realFetch;
  serperCalls = [];
  const it = await PR.searchText('IT services Hoover AL', { serperFetch, fetchImpl: googleFetch });
  ok('the Prospector search asks Serper', it.ok && it.places.length === 1 && serperCalls.length === 1 && googleCalls.length === 0);

  OUT.push('-- when Serper fails, Google answers --');
  serperDown = true; googleCalls = [];
  const fb = await PM.buildMarketPoolFromPlaces('Samford University 2', { fetch: googleFetch, serperFetch, record: false, source: 'test' });
  ok('a failed Serper call: the build asks Google as before', googleCalls.length > 0 && fb.ok, { calls: googleCalls.length, reason: fb.reason });
  googleCalls = [];
  const it2 = await PR.searchText('IT services Hoover AL', { serperFetch, fetchImpl: googleFetch });
  ok('and the Prospector search too', it2.ok && googleCalls.length === 1);
  serperDown = false;

  OUT.push('-- the shape --');
  const g = SP.toGoogle(serperPlace(5, { priceLevel: '$$' }));
  ok('a Serper place reads like a Google one', g.displayName.text === 'Biz 5' && g.location.latitude && g.userRatingCount === 50 && g.primaryType === 'mexican_restaurant'
    && g.types[0] === 'mexican_restaurant' && g.websiteUri && g.priceLevel === 'PRICE_LEVEL_MODERATE' && g.businessStatus === 'OPERATIONAL');
  ok('no place id: the Maps id stands in', SP.toGoogle({ title: 'X', cid: '42' }).id === 'cid:42');
  ok('the zoom fits the ground asked about', SP.zoomFor(1000) === 16 && SP.zoomFor(8000) === 13 && SP.zoomFor(30000) === 11);

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
