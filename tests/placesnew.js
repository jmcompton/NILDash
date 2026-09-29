'use strict';
// Runs against the local test Postgres. No network: Google is a fixture.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/placesnew.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE MARKET BUILD ON PLACES API (NEW), AND IT IS NEVER SILENT AGAIN ──────
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const PM = require(REPO + 'server/services/placesMarket.js');
const MA = require(REPO + 'server/services/morningAlert.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 400) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');

const CENTER = { latitude: 33.8285, longitude: -118.0247 };
// A fake Places API (New). `fail` maps an includedType (or 'geocode') to an
// error; restaurants come back full (20) at the centre so the tiling runs.
function fakeGoogle({ fail = {}, empty = false } = {}) {
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const place = (id, name, lat, lng, extra) => ({ id, displayName: { text: name, languageCode: 'en' },
    formattedAddress: `${id} Main St, Cypress, CA 90630, USA`, shortFormattedAddress: `${id} Main St, Cypress`,
    types: ['restaurant', 'food', 'point_of_interest'], location: { latitude: lat, longitude: lng },
    rating: 4.5, userRatingCount: 120, businessStatus: 'OPERATIONAL', priceLevel: 'PRICE_LEVEL_MODERATE', ...extra });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: init.method, headers: init.headers, body });
    const denied = (why) => res(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: why } });
    if (/searchText$/.test(url)) {
      if (fail.geocode) return denied(fail.geocode);
      return res(200, { places: [{ id: 'campus', location: CENTER, formattedAddress: '9200 Valley View St' }] });
    }
    const type = body.includedTypes[0];
    if (fail[type]) return fail[type] === 400
      ? res(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: `Unsupported types: ${type}.` } }) : denied(fail[type]);
    if (fail.all) return denied(fail.all);
    if (empty) return res(200, {});
    const c = body.locationRestriction.circle;
    const atCenter = Math.abs(c.center.latitude - CENTER.latitude) < 1e-9;
    if (type === 'restaurant') {
      if (atCenter) return res(200, { places: Array.from({ length: 20 }, (_, i) => place(`r${i}`, `Diner ${i}`, 33.829 + i * 1e-4, -118.025)) });
      // Each tile: two new places (one inside the circle, one 30 km away) and one repeat.
      const k = calls.length;
      return res(200, { places: [place(`t${k}`, `Tile Cafe ${k}`, c.center.latitude, c.center.longitude),
        place(`far${k}`, `Far Away Grill ${k}`, 34.1, -118.3), place('r0', 'Diner 0', 33.829, -118.025)] });
    }
    return res(200, { places: [place(`${type}-1`, `${type} one`, 33.83, -118.03, { types: [type] }),
      place(`${type}-thin`, `${type} thin`, 33.83, -118.03, { types: [type], userRatingCount: 3 })] });
  };
  return { fetch, calls };
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const KEY = 'test-key-not-real';
  process.env.GOOGLE_PLACES_API_KEY = KEY;
  const Q = (tag) => `placesnew-${tag}-${Date.now()}`;
  const clean = () => P.query(`DELETE FROM places_market_builds WHERE query LIKE 'placesnew-%'`).catch(() => {});
  await clean();

  // ── 1. NO LEGACY ENDPOINT IS LEFT ─────────────────────────────────────────
  OUT.push('-- the New API only --');
  const PMsrc = strip(read('server/services/placesMarket.js'));
  ok('placesMarket calls no legacy endpoint', !/maps\.googleapis\.com\/maps\/api/.test(PMsrc) && !/next_page_token|pagetoken/.test(PMsrc));
  const legacyAnywhere = [];
  (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = _tp.join(d, f.name);
    if (f.isDirectory()) { if (f.name !== 'node_modules') walk(p); }
    else if (f.name.endsWith('.js') && /maps\.googleapis\.com\/maps\/api\/(place|geocode)/.test(strip(fs.readFileSync(p, 'utf8')))) legacyAnywhere.push(p.replace(REPO, ''));
  } })(REPO + 'server');
  ok('  and nothing in server/ does', legacyAnywhere.length === 0, legacyAnywhere);

  // ── 2. THE GEOCODE ────────────────────────────────────────────────────────
  OUT.push('', '-- geocode (searchText) --');
  let g = fakeGoogle();
  const geo = await PM.geocodeSchool(Q('geo') + ' Cypress College', KEY, { fetch: g.fetch });
  const c0 = g.calls[0];
  ok('POST to places:searchText with the key and a field mask in headers', c0 && c0.method === 'POST' && /places:searchText$/.test(c0.url)
    && c0.headers['X-Goog-Api-Key'] === KEY && /places\.location/.test(c0.headers['X-Goog-FieldMask']), c0 && c0.headers);
  ok('  returns { coords, calls } as before', geo.coords && geo.coords.lat === CENTER.latitude && geo.coords.lng === CENTER.longitude && geo.calls === 1, geo);
  g = fakeGoogle({ fail: { geocode: 'Places API (New) has not been used in project 123' } });
  const q2 = Q('geofail');
  const gf = await PM.geocodeSchool(q2, KEY, { fetch: g.fetch });
  ok('a denied geocode carries Google\'s reason', !gf.coords && /PERMISSION_DENIED: Places API \(New\) has not been used/.test(gf.error), gf);
  const gf2 = await PM.geocodeSchool(q2, KEY, { fetch: fakeGoogle().fetch });
  ok('  and is not cached: the next call asks again and succeeds', gf2.coords && gf2.calls === 1, gf2);
  ok('server/index.js still imports geocodeSchool from placesMarket', /require\('\.\/services\/placesMarket'\)/.test(read('server/index.js')) && typeof PM.geocodeSchool === 'function');

  // ── 3. THE BUILD ──────────────────────────────────────────────────────────
  OUT.push('', '-- the build (searchNearby) --');
  g = fakeGoogle();
  const qb = Q('build');
  const r = await PM.buildMarketPoolFromPlaces(qb, { fetch: g.fetch, source: 'test' });
  const nearby = g.calls.filter((c) => /searchNearby$/.test(c.url));
  const n0 = nearby[0];
  ok('one POST to places:searchNearby per business type, with a circle and at most 20',
    nearby.filter((c) => c.body.locationRestriction.circle.radius === PM.RADIUS_M).length === PM.NEARBY_TYPES.length
    && n0.body.maxResultCount === 20 && n0.headers['X-Goog-Api-Key'] === KEY && n0.headers['X-Goog-FieldMask'] === PM.NEARBY_MASK, n0 && n0.body);
  const tiles = nearby.filter((c) => c.body.includedTypes[0] === 'restaurant' && c.body.locationRestriction.circle.radius !== PM.RADIUS_M);
  ok('a type that came back full (20) is asked again over four sub-circles', tiles.length === 4, tiles.length);
  ok('  and only that type', nearby.length === PM.NEARBY_TYPES.length + 4, nearby.length);
  const names = r.candidates.map((c) => c.name);
  ok('the tiles add places, drop the ones outside the circle and never repeat one',
    names.filter((n) => /^Tile Cafe/.test(n)).length === 4 && !names.some((n) => /^Far Away/.test(n))
    && names.filter((n) => n === 'Diner 0').length === 1, names.filter((n) => /Tile|Far|Diner 0$/.test(n)));
  const d0 = r.candidates.find((c) => c.name === 'Diner 0');
  ok('a New-API place is mapped to the shape every caller expects', d0 && d0.place_id === 'r0' && d0.address === 'r0 Main St, Cypress'
    && d0.lat === 33.829 && d0.lng === -118.025 && d0.rating === 4.5 && d0.user_ratings_total === 120 && d0.price_level === 2
    && d0.business_status === 'OPERATIONAL' && d0.category === 'restaurant' && d0.market === 'school' && d0.evidence === null
    && Array.isArray(d0.types), d0);
  ok('  the review filter still drops thin listings', !names.some((n) => / thin$/.test(n)));
  ok('  pool size and calls are reported', r.ok && r.candidates.length === 20 + 4 + (PM.NEARBY_TYPES.length - 1) && r.placesCalls === 1 + PM.NEARBY_TYPES.length + 4,
    [r.candidates.length, r.placesCalls]);
  const row = (await P.query(`SELECT * FROM places_market_builds WHERE query = $1`, [qb])).rows[0];
  ok('every build is written to places_market_builds', row && row.ok === true && row.pool_size === r.candidates.length
    && row.places_calls === r.placesCalls && row.saturated_types === 1 && row.source === 'test', row);

  // ── 4. FAILURE IS LOUD ────────────────────────────────────────────────────
  OUT.push('', '-- a failed build is loud --');
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => { errs.push(a.join(' ')); };
  const qf = Q('denied');
  let fr;
  try { fr = await PM.buildMarketPoolFromPlaces(qf, { fetch: fakeGoogle({ fail: { geocode: "You're calling a legacy API, which is not enabled for your project" } }).fetch }); }
  finally { console.error = origErr; }
  ok('a denied build returns ok:false with Google\'s words in the reason', !fr.ok && /geocode_failed: PERMISSION_DENIED: You're calling a legacy API/.test(fr.reason), fr.reason);
  ok('  logs an ERROR naming the market and what it means', errs.some((e) => e.includes('MARKET BUILD FAILED') && e.includes(qf) && /web search only/.test(e)), errs);
  const frow = (await P.query(`SELECT * FROM places_market_builds WHERE query = $1`, [qf])).rows[0];
  ok('  and is recorded as failed', frow && frow.ok === false && /PERMISSION_DENIED/.test(frow.reason), frow);
  const qa = Q('alltypes');
  console.error = () => {};
  const fa = await PM.buildMarketPoolFromPlaces(qa, { fetch: fakeGoogle({ fail: { all: 'API key not valid' } }).fetch }).finally(() => { console.error = origErr; });
  ok('every nearby call failing is a failure, not an empty market', !fa.ok && fa.reason === `nearby_failed on ${PM.NEARBY_TYPES.length} of ${PM.NEARBY_TYPES.length} types: restaurant: PERMISSION_DENIED: API key not valid`, fa.reason);
  const qp = Q('partial');
  console.error = () => {};
  const fp = await PM.buildMarketPoolFromPlaces(qp, { fetch: fakeGoogle({ fail: { physiotherapist: 400 } }).fetch }).finally(() => { console.error = origErr; });
  const prow = (await P.query(`SELECT * FROM places_market_builds WHERE query = $1`, [qp])).rows[0];
  ok('one type failing still builds, and the partial failure is recorded', fp.ok && fp.candidates.length > 20 && prow.failed_calls === 1
    && /physiotherapist: INVALID_ARGUMENT/.test(prow.reason), [fp.ok, prow && prow.reason]);
  const qe = Q('empty');
  const fe = await PM.buildMarketPoolFromPlaces(qe, { fetch: fakeGoogle({ empty: true }).fetch });
  ok('a market Google answers with no places is ok and empty, not a failure', fe.ok && fe.candidates.length === 0);
  delete process.env.GOOGLE_PLACES_API_KEY;
  console.error = () => {};
  const fk = await PM.buildMarketPoolFromPlaces(Q('nokey'), {}).finally(() => { console.error = origErr; });
  process.env.GOOGLE_PLACES_API_KEY = KEY;
  ok('no key is a recorded failure too', !fk.ok && /^no_api_key/.test(fk.reason));
  const AI = strip(read('server/ai.js'));
  ok('the Deal Scan fallback logs a failed build as an error, not a warning',
    /if \(!pr\.ok\) console\.error\(`\[dealScan\] PLACES MARKET BUILD FAILED/.test(AI) && !/Places returned nothing/.test(AI));

  // ── 5. THE MORNING ALERT ──────────────────────────────────────────────────
  OUT.push('', '-- the morning alert --');
  const AP = MA.agentProblem;
  ok('no cards with open slots is a problem', AP({ athletes: 3, queueEnabled: true, run: { filled: 0, finished_at: new Date(), details: [{ athleteName: 'A', open: 2, note: 'x' }] } }).kind === 'zero-cards');
  ok('  every slot already full is not', AP({ athletes: 3, queueEnabled: true, run: { filled: 0, finished_at: new Date(), details: [{ athleteName: 'A', open: 0 }] } }) === null);
  ok('  cards placed is not', AP({ athletes: 3, queueEnabled: true, run: { filled: 2, finished_at: new Date(), details: [] } }) === null);
  ok('  skipped by design (inactive) is not', AP({ athletes: 3, queueEnabled: true, run: { filled: 0, note: 'skipped: last login 20 days ago', finished_at: new Date() } }) === null);
  ok('  the run never ran for them is', AP({ athletes: 3, queueEnabled: true, run: null }).kind === 'no-run');
  ok('  the run never finished is', AP({ athletes: 3, queueEnabled: true, run: { filled: 0, finished_at: null } }).kind === 'unfinished');
  ok('  no agent name is', AP({ athletes: 3, queueEnabled: true, run: { filled: 0, finished_at: new Date(), note: require(REPO + 'server/services/agentName.js').NO_AGENT_NAME_REASON } }).kind === 'no-name');
  ok('  an agent with no athletes is not', AP({ athletes: 0, queueEnabled: true, run: null }) === null);
  // 6am Central on a fixed day, so the run row and the alert row are ours alone.
  const NOW = Date.parse('2031-03-04T12:00:00Z');
  const DAY = '2031-03-04';
  ok('the window opens after the nightly run and closes at noon Central', MA.windowOpen(NOW)
    && !MA.windowOpen(Date.parse('2031-03-04T08:00:00Z')) && !MA.windowOpen(Date.parse('2031-03-04T19:00:00Z')));
  const AG = 'placesnew-agent';
  await P.query(`DELETE FROM admin_alerts WHERE alert_date = $1`, [DAY]);
  await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM users WHERE id = $1`, [AG]);
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1, 'Alert Agent', 'placesnew-agent@alert.test', 'x', 'agent')`, [AG]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('placesnew-ath', $1, '{"name":"Maya Torres","school":"Cypress College"}')`, [AG]);
  await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, filled, note, details, finished_at)
                 VALUES ($1, $2, 0, NULL, $3, NOW())`,
    [AG, DAY, JSON.stringify([{ athleteId: 'placesnew-ath', athleteName: 'Maya Torres', filled: 0, open: 3, emptyReason: 'no-pool-for-key' }])]);
  const report = await MA.collect(P, { now: NOW });
  const mine = report.problems.find((p) => /placesnew-agent@alert\.test/.test(p.agent));
  ok('collect finds the agent with athletes and no cards', mine && mine.kind === 'zero-cards' && /Maya Torres: no-pool-for-key/.test(mine.athletes[0]), mine);
  ok('  and the failed market builds of the last 24 hours, with the reason', report.builds.failed >= 2
    && report.builds.failures.some((f) => /PERMISSION_DENIED/.test(f.reason)), report.builds);
  const sent = [];
  const r1 = await MA.runOnce(P, { now: NOW, send: async (m) => { sent.push(m); } });
  ok('it sends one email naming both', r1.status === 'sent' && sent.length === 1 && /got no cards/.test(sent[0].subject)
    && /Places market build\(s\) failed/.test(sent[0].subject) && /Alert Agent <placesnew-agent@alert\.test>/.test(sent[0].text)
    && /PERMISSION_DENIED/.test(sent[0].text), r1.status);
  const r2 = await MA.runOnce(P, { now: NOW + 15 * 60000, send: async (m) => { sent.push(m); } });
  ok('  and only once that day', r2.skipped === 'already sent' && sent.length === 1, r2.skipped);
  const DAY2 = '2031-03-05', NOW2 = Date.parse('2031-03-05T12:00:00Z');
  await P.query(`DELETE FROM admin_alerts WHERE alert_date = $1`, [DAY2]);
  const f1 = await MA.runOnce(P, { now: NOW2, send: async () => { throw new Error('resend down'); } });
  const f2 = await MA.runOnce(P, { now: NOW2 + 900000, send: async (m) => { sent.push(m); } });
  const arow = (await P.query(`SELECT status, attempts FROM admin_alerts WHERE alert_date = $1`, [DAY2])).rows[0];
  ok('a failed send is retried on the next tick', f1.status === 'failed' && f2.status === 'sent' && arow.status === 'sent' && arow.attempts === 2, [f1.status, f2.status, arow]);
  const outside = await MA.runOnce(P, { now: Date.parse('2031-03-06T20:00:00Z'), send: async (m) => { sent.push(m); } });
  ok('outside the morning window it does nothing', /outside/.test(outside.skipped));
  const rendered = MA.render(report);
  ok('the alert email says how many cards and new businesses, for context', /card\(s\) placed last night/.test(rendered.text) && /New businesses discovered/.test(rendered.text));
  const IDX = read('server/index.js');
  ok('the server schedules it, and it is not behind the queue flag', /MA\.runOnce\(store\.pool\)/.test(IDX) && /Not gated on OUTREACH_QUEUE_ENABLED/.test(IDX));
  ok('  it goes to ADMIN_ALERT_EMAIL, else ADMIN_EMAIL', /ADMIN_ALERT_EMAIL \|\| process\.env\.ADMIN_EMAIL/.test(read('server/services/morningAlert.js')));
  ok('the admin runner has morning-alert and places-rebuild', /'morning-alert': \{ file: 'scripts\/morning-alert\.js'/.test(IDX) && /'places-rebuild': \{ file: 'scripts\/places-rebuild\.js'/.test(IDX));
  ok('the nightly run report opens with discovery health', /DISCOVERY \(all agents\)/.test(read('scripts/nightly-run-report.js')) && /PLACES DISCOVERY FAILING/.test(read('scripts/nightly-run-report.js')));

  // The all-clear: a morning with nothing wrong still sends one line.
  const DAY3 = '2031-03-07', NOW3 = Date.parse('2031-03-07T12:00:00Z');
  await P.query(`DELETE FROM admin_alerts WHERE alert_date = $1`, [DAY3]);
  const clearSent = [];
  const cr = await MA.runOnce(P, { now: NOW3, send: async (m) => { clearSent.push(m); } });
  // Other suites may leave agents or failures behind; only the shape is asserted
  // when this database is not clean.
  if (!cr.report.problemCount) {
    ok('a morning with nothing wrong sends the all-clear', cr.status === 'sent' && clearSent.length === 1
      && /^NILDash all clear 2031-03-07: /.test(clearSent[0].subject) && /If one does not arrive, the alert itself is broken/.test(clearSent[0].text), clearSent[0] && clearSent[0].subject);
  } else {
    ok('a morning with problems sends the alert instead', cr.status === 'sent' && /^NILDash alert /.test(clearSent[0].subject));
  }
  const clearMsg = MA.render({ runDate: DAY3, problemCount: 0, problems: [], cardsLastNight: 41, agentsWithAthletes: 7,
    skippedByDesign: 1, queueEnabled: true, builds: { total: 12, failed: 0, pooled: 900, failures: [] }, newBusinesses24h: 311 });
  ok('  the all-clear line carries the numbers', clearMsg.subject === 'NILDash all clear 2031-03-07: 41 card(s) last night, 12 market build(s) and none failed, 311 new business(es)', clearMsg.subject);
  await P.query(`DELETE FROM admin_alerts WHERE alert_date = $1`, [DAY3]);

  // ── 6. ONE ROW PER KEY BEFORE EVERY BATCHED UPSERT ────────────────────────
  OUT.push('', '-- duplicate names never break a batch --');
  const BD = require(REPO + 'server/services/batchDedupe.js');
  const dd = BD.dedupeBy([{ n: 'A', v: 1 }, { n: 'B', v: 1 }, { n: 'A', v: 3 }], (r) => r.n, (a, b) => a.v > b.v);
  ok('dedupeBy keeps the better row, not the first, and reports the collision', dd.rows.length === 2
    && dd.rows.find((r) => r.n === 'A').v === 3 && dd.collisions.length === 1 && dd.collisions[0].dropped.v === 1, dd);
  const MK = 'placesnew-town, zz';
  await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [MK]);
  const twins = [
    { name: 'Twin Burger', market: 'school', category: 'restaurant', evidence: null, address: '1 First St' },
    { name: 'Twin Burger', market: 'school', category: 'restaurant', evidence: 'Sponsors Cypress High football', address: '9 Ninth St' },
    { name: 'Solo Gym', market: 'school', category: 'gym', evidence: null },
  ];
  const rec = await store.recordMarketPool(twins, { schoolMarket: 'Placesnew-town, ZZ' });
  const rows = (await P.query(`SELECT brand, has_evidence, evidence FROM market_business_seen WHERE market_key = $1 ORDER BY brand`, [rec.schoolKey])).rows;
  ok('market_business_seen: two places with one name write one row, no error', !rec.error && rows.length === 2, [rec.error, rows]);
  ok('  and the row with evidence is the one kept', rows.find((r) => r.brand === 'Twin Burger').evidence === 'Sponsors Cypress High football'
    && rec.collisions.length === 1 && rec.collisions[0].dropped.address === '1 First St', [rows, rec.collisions]);
  const again = await store.markMarketNewcomers(rec.schoolKey, ['Solo Gym', 'Solo Gym', 'Twin Burger']);
  ok('  markMarketNewcomers with a repeated name writes without error', !again.error, again.error);
  const rej = await store.markMarketNewcomers(rec.schoolKey, ['Local Gym (independent)', 'Local Gym (independent)']);
  ok('  and so does a repeated rejected placeholder', !rej.error);
  await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [rec.schoolKey]);
  await P.query(`DELETE FROM market_business_rejected WHERE market_key = $1`, [rec.schoolKey]).catch(() => {});

  const TS = require(REPO + 'server/services/teamScan.js');
  await TS.ensureTables(P);
  const UK = 'placesnew-campus, zz';
  await P.query(`DELETE FROM university_market_seen WHERE market_key = $1`, [UK]);
  const cand = (id, name, lat, reviews) => ({ name, place_id: id, types: ['cafe'], category: 'coffee', address: id + ' Main St',
    lat, lng: -118.025, rating: 4.6, user_ratings_total: reviews, chain: false, market: 'school' });
  const fakePlaces = { buildMarketPoolFromPlaces: async () => ({ ok: true, placesCalls: 1, geocoded: { lat: 33.8285, lng: -118.0247 },
    candidates: [cand('far', 'Twin Coffee', 33.86, 40), cand('near', 'Twin Coffee', 33.829, 900), cand('solo', 'Solo Tea', 33.83, 50)] }) };
  let dres, derr = null;
  try { dres = await TS.discover(P, { university: { location: 'x' }, marketKey: UK, places: fakePlaces }); } catch (e) { derr = e.message; }
  const urows = (await P.query(`SELECT brand, place_id FROM university_market_seen WHERE market_key = $1 ORDER BY brand`, [UK])).rows;
  ok('university_market_seen: two places with one name no longer fail the whole write', !derr && urows.length === 2, [derr, urows]);
  ok('  the better fit is kept, and the collision is reported with both places', urows.find((r) => r.brand === 'Twin Coffee').place_id === 'near'
    && dres.duplicates.length === 1 && dres.duplicates[0].dropped.place_id === 'far', dres && dres.duplicates);
  await P.query(`DELETE FROM university_market_seen WHERE market_key = $1`, [UK]);

  await P.query(`DELETE FROM admin_alerts WHERE alert_date IN ($1, $2)`, [DAY, DAY2]);
  await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM users WHERE id = $1`, [AG]);
  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await P.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('placesnew: FAILED', e); process.exit(1); });
