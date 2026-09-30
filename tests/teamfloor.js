'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/teamfloor.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE UNIVERSITY SIDE: FIVE ASKS, OR A CEILING ────────────────────────────
// A team scan wrote one slate of five and stopped: every business refused at
// the ask was a seat lost. It now runs the same loop as the agents' night: a
// refusal pulls a replacement, the pool is re-drawn past what was tried, then
// widened ring by ring from Places, and a short night is an alert.
const store = require(REPO + 'server/store.js');
const TeamScan = require(REPO + 'server/services/teamScan.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };

const UNI = 'univ-tf', TEAM = 'univ-tf:mbb', MK = 'tfville, ca';
const CAMPUS = { lat: 34.1, lng: -117.5 };
const KINDS = [['restaurant', []], ['gym', ['gym']], ['coffee', ['cafe']], ['dealership', ['car_dealer']], ['wellness', ['physiotherapist']], ['retail', ['store']]];
const place = (name, i) => ({ name, place_id: 'tf-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), types: KINDS[i % KINDS.length][1],
  category: KINDS[i % KINDS.length][0], address: '1 Main St, Tfville', lat: 34.1, lng: -117.5, rating: 4.5, user_ratings_total: 200,
  chain: false, market: 'school' });
// Rings: 8 km gives the first list, wider rings add more.
function fakePlaces(byRadius) {
  const calls = [];
  return { calls, buildMarketPoolFromPlaces: async (q, opts) => {
    calls.push(opts && opts.radiusM || 8000);
    const list = byRadius(opts && opts.radiusM || 8000);
    return { ok: true, candidates: list, placesCalls: 3, geocoded: CAMPUS };
  } };
}
// A model that refuses (a named athlete, twice) for the businesses in `refuse`.
function fakeAi(refuse) {
  const calls = [];
  return { calls, oneShot: async (prompt) => {
    calls.push(prompt);
    const item = (prompt.match(/naming the item exactly as "([^"]+)"/) || [])[1];
    const price = (prompt.match(/the price exactly as "([^"]+)"/) || [])[1];
    if ([...refuse].some((b) => prompt.includes(b))) return `SUBJECT: Hi\nBODY:\nOur point guard Jaylen Brooks and the ${item} for ${price}.`;
    return `SUBJECT: A home-court partnership\nBODY:\nYou are a few minutes from our gym and the program would be glad to have you with us this winter. We would like to offer the ${item} for ${price}, which supports the season, travel and equipment for the whole team. Would you have ten minutes for a call next week?`;
  } };
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await TeamScan.ensureTables(P);
  const clean = async () => {
    for (const t of ['university_drafts', 'university_outreach_queue', 'university_brand_engagement', 'university_research_claims']) {
      await P.query(`DELETE FROM ${t} WHERE team_id = $1`, [TEAM]).catch(() => {});
    }
    await P.query(`DELETE FROM university_inventory WHERE university_id = $1`, [UNI]).catch(() => {});
    await P.query(`DELETE FROM university_teams WHERE university_id = $1`, [UNI]).catch(() => {});
    await P.query(`DELETE FROM universities WHERE id = $1`, [UNI]).catch(() => {});
    await P.query(`DELETE FROM university_market_seen WHERE market_key = $1`, [MK]).catch(() => {});
    await P.query(`DELETE FROM service_faults WHERE service = 'nightly-floor' AND reason LIKE 'Tfville%'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO universities (id, name, short_name, location) VALUES ($1,'Tfville College','TFC','1 College Way, Tfville, CA 90000')`, [UNI]);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, market_key) VALUES ($1,$2,'Men''s Basketball','basketball',$3)`, [TEAM, UNI, MK]);
  for (let i = 0; i < 8; i++) {
    await P.query(`INSERT INTO university_inventory (id, university_id, team_id, name, price_cents, status) VALUES ($1,$2,$3,$4,$5,'available')`,
      [`tf-item-${i}`, UNI, TEAM, `Item ${String.fromCharCode(65 + i)} sponsor`, 50000 + i * 25000]);
  }

  // ── 1. REFUSALS ARE REPLACED ──────────────────────────────────────────────
  OUT.push('-- the writer refuses three; the team still gets five --');
  const names = ['Alpha Grill', 'Bravo Fitness', 'Charlie Coffee', 'Delta Motors', 'Echo Therapy', 'Foxtrot Goods', 'Golf Grill', 'Hotel Fitness', 'India Coffee', 'Juliet Motors'];
  const places = fakePlaces(() => names.map(place));
  const refuse = new Set(['Alpha Grill', 'Bravo Fitness', 'Charlie Coffee']);
  const r = await TeamScan.runTeamScan(P, { universityId: UNI, teamId: TEAM, limit: 5, deps: { places, ai: fakeAi(refuse) } });
  ok('five asks written', r.ok && r.drafts.length === 5, [r.error, r.drafts && r.drafts.map((d) => d.brand), r.skipped]);
  ok('  none to a business the writer refused', !r.drafts.some((d) => refuse.has(d.brand)));
  ok(`  it tried ${r.loop && r.loop.candidates} and stopped at the floor`, r.loop && r.loop.stop === 'floor' && r.loop.candidates > 5 && r.loop.candidatesToFloor === r.loop.candidates, r.loop);

  // ── 2. TOO FEW: WIDEN RING BY RING, THEN SHIP WHAT THERE IS AND ALERT ─────
  OUT.push('', '-- a small campus market widens, then stops short and says so --');
  await clean();
  await P.query(`INSERT INTO universities (id, name, short_name, location) VALUES ($1,'Tfville College','TFC','1 College Way, Tfville, CA 90000')`, [UNI]);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, market_key) VALUES ($1,$2,'Men''s Basketball','basketball',$3)`, [TEAM, UNI, MK]);
  for (let i = 0; i < 8; i++) {
    await P.query(`INSERT INTO university_inventory (id, university_id, team_id, name, price_cents, status) VALUES ($1,$2,$3,$4,$5,'available')`,
      [`tf-item-${i}`, UNI, TEAM, `Item ${String.fromCharCode(65 + i)} sponsor`, 50000 + i * 25000]);
  }
  const small = fakePlaces((rad) => (rad >= 16000 ? ['Kilo Grill', 'Lima Fitness', 'Mike Coffee'] : ['Kilo Grill', 'Lima Fitness']).map(place));
  const r2 = await TeamScan.runTeamScan(P, { universityId: UNI, teamId: TEAM, limit: 5, deps: { places: small, ai: fakeAi(new Set()) } });
  ok('the ring widened from Places when the pool ran dry, and found one more', small.calls.length >= 2 && small.calls.includes(16000) && r2.drafts.length === 3,
    { calls: small.calls, drafts: r2.drafts && r2.drafts.map((d) => d.brand), loop: r2.loop });
  ok('  it stopped because the ladder was exhausted, and says which rings it tried', r2.loop && r2.loop.stop === 'ladder'
    && r2.loop.rungs[0] === 'local' && r2.loop.rungs.includes('places-16km'), r2.loop);
  await new Promise((res) => setTimeout(res, 300));
  const alert = (await P.query(`SELECT reason FROM service_faults WHERE service = 'nightly-floor' AND reason LIKE 'Tfville College%' ORDER BY at DESC LIMIT 1`)).rows[0];
  ok('  an alert names the team, the count and the rungs', alert && /Tfville College Men's Basketball: 3 of 5 asks after \d+ candidate/.test(alert.reason) && /rungs tried: local, places-16km/.test(alert.reason), alert);

  // ── 3. THE CEILINGS ───────────────────────────────────────────────────────
  OUT.push('', '-- the ceilings --');
  await P.query(`DELETE FROM university_research_claims WHERE team_id = $1`, [TEAM]);
  const r3 = await TeamScan.runTeamScan(P, { universityId: UNI, teamId: TEAM, limit: 5, deps: { places: fakePlaces(() => names.map(place)), ai: fakeAi(new Set()), timeCeilingMs: 1 } });
  ok('a time ceiling stops the team and is the recorded reason', r3.loop && r3.loop.stop === 'time', r3.loop);
  const r4 = await TeamScan.runTeamScan(P, { universityId: UNI, teamId: TEAM, limit: 5, deps: { places: fakePlaces(() => names.map(place)), ai: fakeAi(new Set()), costCeilingUsd: 0.0001 } });
  ok('  and so does a cost ceiling', r4.loop && r4.loop.stop === 'cost', r4.loop);
  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
