'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js           every suite, against the committed baseline
//   node tests/floorloop.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── FIVE, OR A CEILING: THE OUTCOME-DRIVEN FILL ─────────────────────────────
// The nightly fill ran a batch: open slots x 3 candidates, a pass-rate breaker
// after 8, one refill. A market where 1 in 12 businesses was reachable ended
// the night with nothing. Now it runs until the athlete holds five, stopping
// only for the time ceiling, the cost ceiling or an exhausted ladder, and
// every rejection pulls a replacement. Real job, real Scout, real insert; only
// the paid lookups are stubbed.
const Module = require('module');
const originalLoad = Module._load;
// Which businesses "pass": Places says OPERATIONAL for these, CLOSED otherwise.
const stub = { open: new Set(), placesCalls: [], contactCalls: [] };
const placeFor = (b) => (stub.open.has(b)
  ? { businessStatus: 'OPERATIONAL', website: 'https://x.test', phone: '(334) 555-1212', primaryType: 'restaurant' }
  : { businessStatus: 'CLOSED_PERMANENTLY', website: null, phone: null });
Module._load = function (request) {
  const m = originalLoad.apply(this, arguments);
  if (request === '../services/placesLookup') {
    return { ...m,
      lookupPlace: async (b, loc) => { stub.placesCalls.push({ b, loc }); return placeFor(b); },
      lookupPlaceResult: async (b, loc) => { stub.placesCalls.push({ b, loc }); return { ok: true, place: placeFor(b) }; } };
  }
  return m;
};
const store = require(REPO + 'server/store');
const ai = require(REPO + 'server/ai');
const PW = require(REPO + 'server/services/pitchWriter');
ai.webSearchJson = async (prompt) => {
  if (/^Find the official Instagram account of /.test(String(prompt))) return { text: '{"handle":null}', citations: [], searches: 1, outTokens: 5, apiMs: 5 };
  if (/^Search for: .+ (owner|marketing director)\n/.test(String(prompt))) {
    return { text: JSON.stringify({ name: 'Pat Owner', title: 'Owner', confidence: 'high' }), citations: ['https://fl.example/team'], searches: 1, outTokens: 30, apiMs: 10 };
  }
  throw new Error('the real web search must not be reached here');
};
ai.getBrandContacts = async (brand, site, region) => {
  stub.contactCalls.push({ brand, region });
  return { contacts: [{ name: 'Dana Reed', title: 'Owner', phone: '(334) 555-9999', affiliationScope: 'this-location', confidence: 'high', source: 'chamber' }],
    businessPhone: '(334) 555-1212', cached: true, instagram: 'danasshop', instagramScope: 'this-location' };
};
// Discovery scans (the market refill and the widen) find nothing new here.
ai.getDealRecommendations = async () => [];
PW.writePitch = async (ctx) => ({ message: 'Hi Dana,\nTwo feed posts and an appearance at your location.\n\nJohn',
  angle: 'campus traffic', angleKey: 'campus', categoryKey: 'restaurant', ask: '2 posts + appearance',
  _inHometown: ctx && ctx.business && ctx.business.inHometown });
const job = require(REPO + 'server/jobs/outreachQueue');
const Q = require(REPO + 'server/services/outreachQueue');
const AR = require(REPO + 'server/services/athleteRecord');
const SR = require(REPO + 'server/services/schoolResolver');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const AG = 'fl-agent';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM brand_engagement WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM research_claims WHERE athlete_id LIKE 'fl-%'`).catch(() => {});
    await P.query(`DELETE FROM discovery_nightly WHERE athlete_id LIKE 'fl-%'`).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM market_business_seen WHERE brand LIKE 'FL %'`).catch(() => {});
    await P.query(`DELETE FROM service_faults WHERE service = 'nightly-floor' AND reason LIKE 'Fl %'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'John Agent','fl@x.test','x','agent')`, [AG]);
  const seed = async (key, prefix, n) => {
    for (let i = 0; i < n; i++) {
      await P.query(`INSERT INTO market_business_seen (market_key, brand, category) VALUES ($1,$2,'restaurant') ON CONFLICT DO NOTHING`, [key, `${prefix} ${i}`]);
    }
  };
  const fill = async (id, data, extra) => {
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [id, AG, JSON.stringify(data)]);
    const profile = AR.resolveAthlete({ id, data }, { schoolLocation: SR.resolveSchool });
    return job.fillAthlete(P, { agentId: AG, agentFirstName: 'John', athleteId: id, athleteName: data.name, budget: Q.newBudget(100),
      region: profile.market, athleteProfile: profile, athleteRow: data, onProgress: (m) => { if (process.env.FL_DEBUG) console.log('  >> ' + m); }, ...(extra || {}) });
  };

  // ── 1. ONE IN TWELVE: THE OLD NIGHT GAVE UP, THIS ONE REACHES FIVE ────────
  OUT.push('-- a market where 1 in 12 passes --');
  await seed('auburn, al', 'FL Auburn', 72);
  for (let i = 0; i < 72; i += 12) stub.open.add(`FL Auburn ${i}`);   // 6 of 72 pass
  const r1 = await fill('fl-a1', { name: 'Fl Marcus', school: 'Auburn University', sport: 'Football' });
  const L1 = r1.loop || {};
  ok('the athlete reaches five', r1.filled === 5 && L1.held === 5, { filled: r1.filled, loop: L1, note: r1.note });
  ok('  and stopped because five were held, not a breaker', L1.stop === 'floor', L1.stop);
  ok(`  it chewed through ${L1.candidates} candidate(s) to get there, far past the old 15 (5 slots x 3)`, L1.candidates > 15 && L1.candidatesToFloor === L1.candidates, L1);
  ok('  a low pass rate does not move it off a pool that still has businesses: five from the athlete\'s own market', JSON.stringify(L1.rungs) === '["local"]', L1.rungs);
  ok('  and the lane numbers are on the result', L1.byLane && L1.byLane.local && L1.byLane.local.passed >= 5, L1.byLane);
  const rows1 = (await P.query(`SELECT COUNT(*)::int n FROM outreach_queue WHERE athlete_id='fl-a1' AND state='queued'`)).rows[0].n;
  ok('  five cards are on the agent\'s screen', rows1 === 5, rows1);
  ok('  and the channel mix of the five is recorded', Object.values(L1.channels || {}).reduce((a, b) => a + b, 0) === 5 && (L1.channels || {}).dm === 5, L1.channels);

  // ── 2. NOT ENOUGH ANYWHERE: SHIP WHAT THERE IS, ALERT ─────────────────────
  OUT.push('', '-- a market with only three reachable businesses --');
  await seed('blacksburg, va', 'FL Tech', 20);
  for (const i of [0, 7, 13]) stub.open.add(`FL Tech ${i}`);
  const r2 = await fill('fl-a2', { name: 'Fl Messiah', school: 'Virginia Tech', sport: 'Football' });
  const L2 = r2.loop || {};
  ok('three cards shipped, the bar did not move', r2.filled === 3 && L2.held === 3, { filled: r2.filled, loop: L2 });
  ok('  it stopped because the ladder was exhausted, and says so', L2.stop === 'ladder' && r2.stop === 'ladder', L2.stop);
  // The ladder is the athlete's tier's (services/athleteTier): this athlete has
  // no follower count, so a Division I athlete reads as mid -- the social lane
  // straight after their own pool, and never the national lane.
  ok('  every rung of this athlete\'s ladder was tried, in order', (L2.rungs || []).join() === require(REPO + 'server/services/athleteTier').ladderFor(L2.tier).join()
    && L2.tier === 'mid', [L2.tier, L2.rungs]);
  await new Promise((r) => setTimeout(r, 300));
  const alert = (await P.query(`SELECT reason FROM service_faults WHERE service = 'nightly-floor' AND reason LIKE 'Fl Messiah:%' ORDER BY at DESC LIMIT 1`)).rows[0];
  ok('  an alert names the athlete, the count and the rungs', alert && /Fl Messiah: 3 of 5 cards after \d+ candidate/.test(alert.reason) && /rungs tried: local, /.test(alert.reason), alert);

  // ── 3. THE CEILINGS ───────────────────────────────────────────────────────
  OUT.push('', '-- the ceilings, not a candidate count, end the night --');
  await P.query(`DELETE FROM outreach_queue WHERE athlete_id='fl-a1'`);
  const r3 = await fill('fl-a1', { name: 'Fl Marcus', school: 'Auburn University', sport: 'Football' }, { timeCeilingMs: 1 });
  ok('a time ceiling stops it and is logged as the reason', (r3.loop || {}).stop === 'time' && r3.stop === 'time', r3.loop);
  const r3b = await fill('fl-a1', { name: 'Fl Marcus', school: 'Auburn University', sport: 'Football' }, { costCeilingUsd: 0.01 });
  ok('  and so does a cost ceiling', (r3b.loop || {}).stop === 'cost', r3b.loop);
  const J = require('fs').readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the old breakers are gone: no stop on the pass rate or the drawn slate', !/stop = 'rate'/.test(J) && !/stop = 'drawn'/.test(J));
  ok('the ceilings are configurable', /OUTREACH_ATHLETE_TIME_CEILING_MS/.test(require('fs').readFileSync(REPO + 'server/services/outreachQueue.js', 'utf8'))
    && /OUTREACH_ATHLETE_COST_CEILING_USD/.test(require('fs').readFileSync(REPO + 'server/services/outreachQueue.js', 'utf8')));
  ok('the agent\'s nightly cap covers every athlete\'s ceiling', /Math\.max\(CAP_USD, athletes\.length \* Q\.ATHLETE_COST_CEILING_USD\)/.test(J));

  // ── 4. THE HOMETOWN RUNG ──────────────────────────────────────────────────
  OUT.push('', '-- the last rung: the hometown --');
  await seed('harrisburg, pa', 'FL Home', 6);
  for (let i = 0; i < 6; i++) stub.open.add(`FL Home ${i}`);
  stub.placesCalls.length = 0;
  await P.query(`DELETE FROM outreach_queue WHERE athlete_id='fl-a2'`);
  const r4 = await fill('fl-a2', { name: 'Fl Messiah', school: 'Virginia Tech', sport: 'Football', hometown: 'Harrisburg, PA' });
  const L4 = r4.loop || {};
  ok('with the school market thin, the hometown rung fills the rest', r4.filled === 5 && (L4.rungs || []).includes('hometown'), { filled: r4.filled, loop: L4 });
  const homeCalls = stub.placesCalls.filter((c) => /^FL Home/.test(c.b));
  ok('  and a hometown business is looked up in the hometown', homeCalls.length > 0 && homeCalls.every((c) => /Harrisburg/i.test(c.loc)), homeCalls.slice(0, 3));
  const homeRows = (await P.query(`SELECT brand_name FROM outreach_queue WHERE athlete_id='fl-a2' AND state='queued' AND brand_name LIKE 'FL Home%'`)).rows;
  ok('  the cards are there, from the hometown', homeRows.length >= 2, homeRows);
  ok('the writer is told a hometown business is in the hometown', /inHometown: cand\.hometown/.test(J)
    && /This business is in the athlete's HOMETOWN/.test(require('fs').readFileSync(REPO + 'server/services/pitchWriter.js', 'utf8')));

  // ── 5. THE NUMBER ─────────────────────────────────────────────────────────
  OUT.push('', '-- the candidates-to-five number is reported --');
  const FR = require(REPO + 'scripts/floor-report.js');
  const s = FR.summarise([{ run_date: '2026-09-30', agent_id: AG, details: [
    { athleteName: 'A', loop: { ...L1 } }, { athleteName: 'B', loop: { ...L2 } }, { athleteName: 'C', loop: { ...L4 } }] }]);
  const text = FR.format(s, 1);
  ok('floor-report gives the median / p90 candidates to reach five and who fell short', /CANDIDATES TO REACH FIVE: median \d+/.test(text)
    && /SHORT OF FIVE: 1 athlete-night/.test(text) && /BY LANE/.test(text) && /CHANNEL MIX of cards placed: dm \d+/.test(text), text.slice(0, 600));
  ok('the run row carries the loop', /loop: r\.loop \|\| null/.test(J));
  // THE MORNING ALERT names every athlete short of five, zero first as an emergency.
  const MA = require(REPO + 'server/services/morningAlert.js');
  const base = { runDate: '2026-10-01', problems: [], cardsLastNight: 8, agentsWithAthletes: 1, queueEnabled: true,
    builds: { total: 0, failed: 0, failures: [] }, digests: null, overdueSends: { total: 0, reasons: [] }, faults24h: [], universityProblems: [],
    preflight: { night: '2026-10-01', status: 'ok' }, preflightFailures: [], universities: [] };
  const shortRep = { ...base, problemCount: 2, floor: { athletes: 3, hit: 1, short: [
    { agent: 'Greg', athlete: 'Fl Zero', held: 0, floor: 5, candidates: 40, stop: 'ladder', rungs: ['local', 'local-wide', 'social'] },
    { agent: 'Greg', athlete: 'Fl Three', held: 3, floor: 5, candidates: 61, stop: 'cost', rungs: ['local'] }] } };
  const mt = MA.render(shortRep);
  ok('the morning alert lists every athlete short of five, zero as an EMERGENCY, with the count and rungs',
    /2 athlete\(s\) short of five \(1 with ZERO\)/.test(mt.subject) && /EMERGENCY Fl Zero \(Greg\): 0 of 5 after 40 candidate\(s\); stopped by ladder; rungs tried: local, local-wide, social/.test(mt.text)
    && /Fl Three \(Greg\): 3 of 5 after 61/.test(mt.text), mt.text.slice(0, 500));
  const clear = MA.render({ ...base, problemCount: 0, floor: { athletes: 4, hit: 4, short: [] } });
  ok('  and the all-clear says how many reached five', /Five every morning: 4 of 4 athlete\(s\) reached five/.test(clear.text), clear.text.slice(0, 300));
  const MAsrc = require('fs').readFileSync(REPO + 'server/services/morningAlert.js', 'utf8');
  ok('  a short athlete makes the morning a problem, not an all-clear', /out\.problemCount = out\.problems\.length \+ \(b\.failed \? 1 : 0\) \+ out\.floor\.short\.length/.test(MAsrc));
  ok('the loop exits on five, the cost ceiling, the time ceiling or the ladder, and nothing else: no pass rate, no candidate count',
    !/passRateStop/.test(J) && !/MAX_ATTEMPTS_PER_SLOT[^\n]*attempt/.test(J) && /stop = 'time'/.test(J) && /stop = 'cost'/.test(J) && /stop = 'ladder'/.test(J));
  ok('the per-athlete cost ceiling defaults to $2.50 and the time ceiling to 8 minutes', Q.ATHLETE_COST_CEILING_USD === 2.5 && Q.ATHLETE_TIME_CEILING_MS === 480000,
    [Q.ATHLETE_COST_CEILING_USD, Q.ATHLETE_TIME_CEILING_MS]);
  ok('agents run in parallel, and a mid-run Places refresh is shared by the whole run', /OUTREACH_QUEUE_AGENT_CONCURRENCY/.test(J)
    && /placesRefreshed: opts\.placesRefreshed \|\| new Set\(\)/.test(J) && /placesRefreshed: opts\.placesRefreshed \|\| _placesRefreshed/.test(J));
  ok('the scheduled pool build starts at 10 markets a night', require(REPO + 'server/services/marketPools.js').MAX_MARKETS === 10);
  const IDX = require('fs').readFileSync(REPO + 'server/index.js', 'utf8');
  ok('/admin/scan-rejects shows the floor per run: lanes, who hit it, rungs, candidates to five',
    /<h2>The floor of five<\/h2>/.test(IDX) && /FR\.summarise\(runs\)/.test(IDX) && /Candidates to reach five/.test(IDX) && /Short of five/.test(IDX));
  OUT.push(`   (in this fixture: ${L1.candidatesToFloor} candidates to reach five at 1 in 12)`);

  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
