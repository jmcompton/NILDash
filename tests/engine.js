'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js        every suite, against the committed baseline
//   node tests/engine.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
// The Places refresh rung runs only with a key and the schedule on.
process.env.GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || 'test-key';
delete process.env.MARKET_POOL_SCHEDULE;

// ── THE NIGHTLY ENGINE ──────────────────────────────────────────────────────
// The judge reads the athlete first (tier), the social lane is half the
// supply where the tier allows it, another agent's recent contact silently
// ranks a business lower, outcomes move kinds of business up and down, the
// owner finder tries LinkedIn and the social/review owner before giving up --
// and an athlete whose market has ZERO rows in the record reaches five.
// Real job, real Scout, real inserts; only the paid calls are stubbed.
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request) {
  const m = originalLoad.apply(this, arguments);
  if (request === '../services/placesLookup') {
    return { ...m,
      lookupPlace: async () => ({ businessStatus: 'OPERATIONAL', website: 'https://x.test', phone: '(912) 555-1212', primaryType: 'gym' }),
      lookupPlaceResult: async () => ({ ok: true, place: { businessStatus: 'OPERATIONAL', website: 'https://x.test', phone: '(912) 555-1212', primaryType: 'gym' } }) };
  }
  return m;
};
const store = require(REPO + 'server/store');
const ai = require(REPO + 'server/ai');
const PW = require(REPO + 'server/services/pitchWriter');
const PM = require(REPO + 'server/services/placesMarket');
const calls = { places: 0, social: 0, owner: [] };
ai.webSearchJson = async (prompt) => {
  if (/^Find the official Instagram account of /.test(String(prompt))) {
    // A DTC brand has a verified Instagram; a local gym in the fixture does not.
    const sb = String(prompt).match(/EN Social Brand (\d+)/);
    return sb ? { text: JSON.stringify({ handle: 'ensocialbrand' + sb[1], confidence: 'high', verified: true }), citations: ['https://instagram.com/ensocialbrand' + sb[1]], searches: 1, outTokens: 5, apiMs: 5 }
      : { text: '{"handle":null}', citations: [], searches: 1, outTokens: 5, apiMs: 5 };
  }
  const m = String(prompt).match(/^Search for: (.+)\n/);
  // A social / national brand is searched for its partnerships lead, never its
  // founder (services/signingEvidence, ownerNameSearch.LARGE_ORDER): the
  // partnerships search answers with one; the owner search with the founder.
  if (m && /head of partnerships|athlete marketing|marketing director/i.test(m[1]) && /EN Social Brand/.test(m[1])) {
    calls.owner.push(m[1]); return { text: JSON.stringify({ name: 'Sam Ortiz', title: 'Head of Athlete Partnerships', confidence: 'high' }), citations: ['https://x.test/team'], searches: 1 };
  }
  if (m) { calls.owner.push(m[1]); return { text: JSON.stringify({ name: 'Pat Rivera', title: 'Founder', confidence: 'high' }), citations: ['https://x.test/team'], searches: 1 }; }
  throw new Error('the real web search must not be reached here');
};
ai.getBrandContacts = async () => ({ contacts: [{ name: 'Dana Reed', title: 'Owner', phone: '(912) 555-9999', affiliationScope: 'this-location', confidence: 'high', source: 'chamber' }],
  businessPhone: '(912) 555-1212', cached: true, instagram: 'danasshop', instagramScope: 'this-location' });
ai.getDealRecommendations = async () => [];
PW.writePitch = async () => ({ message: 'Hi Dana,\nTwo feed posts and an appearance at your location.\n\nJohn',
  angle: 'campus traffic', angleKey: 'campus', categoryKey: 'gym', ask: '2 posts + appearance' });
// Google Places, for the zero-rows market: twelve real-looking gyms.
PM.buildMarketPoolFromPlaces = async (query, opts) => {
  calls.places++;
  const list = Array.from({ length: 12 }, (_, i) => ({ name: `EN Fresh Gym ${i}`, place_id: 'en-fresh-' + i, types: ['gym'], category: 'gym',
    address: `${i} Main St, Bozeman, MT`, lat: 32.44, lng: -81.77, rating: 4.6, user_ratings_total: 80, chain: false, market: 'school' }));
  return { ok: true, candidates: list, placesCalls: 31 };
};
const job = require(REPO + 'server/jobs/outreachQueue');
const Q = require(REPO + 'server/services/outreachQueue');
const AR = require(REPO + 'server/services/athleteRecord');
const SR = require(REPO + 'server/services/schoolResolver');
const T = require(REPO + 'server/services/athleteTier');
const ES = require(REPO + 'server/services/engineSignals');
const EP = require(REPO + 'server/services/engineProof');
const Scout = require(REPO + 'server/services/scout');
const ONS = require(REPO + 'server/services/ownerNameSearch');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const AG = 'en-agent', AG2 = 'en-other';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    for (const a of [AG, AG2]) {
      await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [a]).catch(() => {});
      await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [a]).catch(() => {});
      await P.query(`DELETE FROM brand_engagement WHERE agent_id=$1`, [a]).catch(() => {});
      await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [a]).catch(() => {});
      await P.query(`DELETE FROM users WHERE id=$1`, [a]).catch(() => {});
    }
    await P.query(`DELETE FROM research_claims WHERE athlete_id LIKE 'en-%'`).catch(() => {});
    await P.query(`DELETE FROM market_business_seen WHERE brand LIKE 'EN %'`).catch(() => {});
    await P.query(`DELETE FROM brand_evidence_cache WHERE brand ILIKE 'EN %' OR brand_key ILIKE '%en social%' OR brand_key ILIKE '%en fresh%'`).catch(() => {});
    await P.query(`DELETE FROM market_pool_schedule WHERE market_key = 'bozeman, mt'`).catch(() => {});
    await P.query(`DELETE FROM service_faults WHERE reason LIKE 'En %'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'John Agent','en@x.test','x','agent'), ($2,'Other Agent','en2@x.test','x','agent')`, [AG, AG2]);

  // ── 1. THE JUDGE READS THE ATHLETE FIRST ──────────────────────────────────
  OUT.push('-- the tier --');
  const juco = T.tierOf({ school: 'Orange Coast Community College', instagram: 800 });
  ok('a JUCO athlete with 800 followers: low, local businesses only', juco.tier === 'low' && juco.lanes.local && !juco.lanes.social && !juco.lanes.national, juco);
  const d2 = T.tierOf({ school: 'Western New Mexico University', instagram: 9000 });
  ok('  a Division II athlete with 9,000 followers is still low (small school)', d2.level === 'small' && d2.tier === 'low', d2);
  ok('  strong engagement lifts a small following one band', T.tierOf({ school: 'Western New Mexico University', instagram: 1500, engagement: 8 }).tier === 'mid');
  const mid = T.tierOf({ school: 'Boise State University', instagram: 12000 });
  ok('a Division I athlete with 12,000: mid, local plus social, no national', mid.tier === 'mid' && mid.lanes.social && !mid.lanes.national && mid.socialSeats === 2, mid);
  ok('a pro, or a large following: high, local plus social plus national', T.tierOf({ athleteType: 'pro' }).tier === 'high'
    && T.tierOf({ school: 'University of Alabama', instagram: 120000 }).lanes.national);
  ok('unknown reach is not zero: a D1 athlete with no count is mid, a small-school one low',
    T.tierOf({ school: 'University of Alabama' }).tier === 'mid' && T.tierOf({ school: 'Western New Mexico University' }).tier === 'low');
  ok('the ladder follows the tier: low never climbs to social or national; mid and high go social straight after their own pool',
    T.ladderFor('low').join() === 'local,local-wide,places-refresh,hometown' && T.ladderFor('mid').join() === 'local,social,local-wide,places-refresh,hometown'
    && T.ladderFor('high').join() === 'local,social,national,local-wide,places-refresh,hometown');
  // ── A JUNIOR COLLEGE IS NEVER READ AS DIVISION I ──
  const cy = T.tierOf({ school: 'Cypress College', instagram: 800 });
  ok('Cypress College is a junior college by the list, though its name does not say so: low, local only', cy.level === 'juco' && cy.tier === 'low' && !cy.lanes.national, cy);
  const cyBig = T.tierOf({ school: 'Cypress College', instagram: 250000 });
  ok('  a junior-college athlete never reaches the national lane, whatever the following', cyBig.tier === 'mid' && !cyBig.lanes.national, cyBig);
  const unk = T.tierOf({ school: 'University of Montana', instagram: 150000 });
  ok('a school on no list is unconfirmed and LOW, whatever the following, and says so', unk.level === 'unconfirmed' && unk.tier === 'low' && /not confirmed/.test(unk.why), unk);
  ok('  an agent confirms it with the athlete\'s division field', T.tierOf({ school: 'University of Montana', instagram: 12000, division: 'D1' }).tier === 'mid'
    && T.tierOf({ school: 'University of Montana', instagram: 12000, division: 'JUCO' }).level === 'juco');
  ok('  FBS schools are confirmed Division I however they are written', T.levelOf({ school: 'Louisville' }) === 'd1' && T.levelOf({ school: 'University of Louisville' }) === 'd1'
    && T.levelOf({ school: 'Boise State University' }) === 'd1');
  ok('  the record carries the division', AR.resolveAthlete({ id: 'x', data: { school: 'University of Montana', division: 'D1' } }, { schoolLocation: SR.resolveSchool }).division === 'D1');
  const subj = Scout.athleteSubject({ school: 'Orange Coast Community College', instagram: 800 }, AG);
  ok('the subject carries the tier and closes the lanes it does not allow', subj.tier === 'low' && subj.lanes.social === false && subj.lanes.national === false);

  // ── 2. HALF THE SUPPLY ────────────────────────────────────────────────────
  OUT.push('', '-- the social lane is half the supply where the tier allows it --');
  await P.query(`INSERT INTO market_business_seen (market_key, brand, category) SELECT 'enslate, ga', 'EN Local ' || g, 'restaurant' FROM generate_series(0, 9) g ON CONFLICT DO NOTHING`);
  // Each social brand has evidence it signs athletes like this one (services/signingEvidence).
  const EVID = require('./_evidence');
  const EN_EV = Array.from({ length: 6 }, (_, i) => `EN Social ${i}`).concat(Array.from({ length: 6 }, (_, i) => `EN Social Brand ${i}`));
  await EVID.seed(P, EN_EV);
  const socialStore = { ...store, getSocialBrandPool: async () => Array.from({ length: 6 }, (_, i) => ({ brand: `EN Social ${i}`, brandKey: `en-social-${i}`, fitScore: 40 })),
    getTopNilComps: async () => [] };
  const slateFor = async (a) => Scout.assembleSlate(P, { agentId: AG, athlete: { id: 'en-s', marketKey: 'enslate, ga', market: 'Enslate, GA', hasLocalMarket: true, ...a }, store: socialStore, limit: 5 });
  const sMid = await slateFor({ school: 'Boise State University', instagram: 12000 });
  const nSocMid = (sMid.picks || []).filter((c) => c.lane === 'social').length;
  ok('a mid-tier athlete: two of the five seats are social, even though local outranks them', nSocMid === 2, (sMid.picks || []).map((c) => [c.brand_name, c.lane, c.fit]));
  const sLow = await slateFor({ school: 'Orange Coast Community College', instagram: 800 });
  ok('  a low-tier athlete: none, and the social lane was never read', !(sLow.picks || []).some((c) => c.lane === 'social') && (sLow.picks || []).length === 5);

  // ── 3. THE SILENT STAGGER ─────────────────────────────────────────────────
  OUT.push('', '-- the silent stagger --');
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('en-o1',$1,'{"name":"En Other"}'::jsonb) ON CONFLICT DO NOTHING`, [AG2]);
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, identity_key, state, sent_at, market_key, business_category)
                 VALUES ($1,'en-o1',1,'place:en-loc-0','EN Local 0','place:en-loc-0','sent',NOW() - INTERVAL '3 days','enslate, ga','restaurant')`, [AG2]);
  const cands = [{ brand_name: 'EN Local 0', place_id: 'en-loc-0' }, { brand_name: 'EN Local 1', place_id: 'en-loc-1' }];
  const st = await ES.staggered(P, { agentId: AG, marketKey: 'enslate, ga', candidates: cands });
  ok('another agent sent to it 3 days ago: staggered for everyone else', st.has(0) && !st.has(1), [...st]);
  ok('  but never for the agent who sent it', (await ES.staggered(P, { agentId: AG2, marketKey: 'enslate, ga', candidates: cands })).size === 0);
  await P.query(`UPDATE outreach_queue SET sent_at = NOW() - INTERVAL '40 days' WHERE agent_id = $1`, [AG2]);
  ok('  and not after 30 days', (await ES.staggered(P, { agentId: AG, marketKey: 'enslate, ga', candidates: cands })).size === 0);
  await P.query(`UPDATE outreach_queue SET sent_at = NOW() - INTERVAL '3 days' WHERE agent_id = $1`, [AG2]);
  const byName = await ES.staggered(P, { agentId: AG, marketKey: 'enslate, ga', candidates: [{ brand_name: 'EN Local 0' }] });
  ok('  a candidate with only a name is matched by name within the same market', byName.has(0));
  ok('  and not in another market', (await ES.staggered(P, { agentId: AG, marketKey: 'elsewhere, ga', candidates: [{ brand_name: 'EN Local 0' }] })).size === 0);
  const sAfter = await slateFor({ school: 'Orange Coast Community College', instagram: 800 });
  const pick0 = (sAfter.picks || []).find((c) => c.brand_name === 'EN Local 0');
  const before0 = (sLow.picks || []).find((c) => c.brand_name === 'EN Local 0');
  ok('on the slate it ranks lower, and nothing on the card says why', (!pick0 || !before0 || pick0.fit < before0.fit)
    && !JSON.stringify(sAfter.picks || []).match(/stagger|other agent|contacted/i), [before0 && before0.fit, pick0 && pick0.fit]);

  // ── 4. LEARNING FROM OUTCOMES ─────────────────────────────────────────────
  OUT.push('', '-- learning from outcomes, aggregate and anonymous --');
  const ins = (cat, n, replied, ageDays) => P.query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, state, sent_at, replied_at, business_category, market_key)
     SELECT $1, 'en-o1', 1, 'en-learn-' || $2 || '-' || g, 'EN Learn ' || $2 || ' ' || g, 'sent', NOW() - make_interval(days => $5),
            CASE WHEN g < $4 THEN NOW() ELSE NULL END, $2, 'enslate, ga' FROM generate_series(0, $3 - 1) g`, [AG2, cat, n, replied, ageDays]);
  await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG2]);
  await ins('gym', 10, 6, 20);        // replies a lot
  await ins('salon', 10, 0, 20);      // silence past 14 days
  await ins('coffee', 3, 3, 20);      // too few to count
  const L = await ES.outcomes(P, { marketKey: 'enslate, ga', candidates: [] });
  ok('a kind of business that replies ranks up', (L.byCategory.get('gym') || 0) > 0, [...L.byCategory]);
  ok('  one that goes silent for 14 days ranks down', (L.byCategory.get('salon') || 0) < 0, [...L.byCategory]);
  ok('  fewer than the minimum sends is not used (it could be read back as one agent)', !L.byCategory.has('coffee'));
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, identity_key, state, updated_at)
                 VALUES ($1,'en-o1',2,'place:en-skip','EN Skip','place:en-skip','skipped',NOW())`, [AG2]);
  const L2 = await ES.outcomes(P, { candidates: [{ brand_name: 'EN Skip', place_id: 'en-skip' }] });
  ok('a business another agent skipped ranks lower for everyone', ES.adjustmentFor({ brand_name: 'EN Skip', place_id: 'en-skip' }, 0, { learned: L2 }) < 0);
  await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG2]);

  // ── 5. THE OWNER FINDER, TWO MORE DOORS ───────────────────────────────────
  OUT.push('', '-- the owner finder --');
  const tries = [];
  const none = await ONS.findOwnerName({ brand: 'EN Shop', city: 'Bozeman, MT', search: async (p) => { tries.push(p.split('\n')[0]); return { text: '{"name": null}' }; } });
  ok('before a business is dropped: owner, marketing director, LinkedIn, then the Instagram bio / Google review owner',
    none === null && tries.length === 4 && /owner$/.test(tries[0]) && /marketing director/.test(tries[1]) && /site:linkedin\.com/.test(tries[2]) && /instagram/.test(tries[3]), tries);
  const li = await ONS.findOwnerName({ brand: 'EN Shop', city: 'Bozeman', search: async (p) => (/linkedin/.test(p) ? { text: '{"name":"Lee Park","title":"Founder"}' } : { text: '{}' }) });
  ok('  a name from LinkedIn is used, with its title', li && li.name === 'Lee Park' && li.query === 'linkedin' && li.title === 'Founder', li);

  // ── 6. THE FUNNEL ─────────────────────────────────────────────────────────
  OUT.push('', '-- the per-role funnel --');
  const f = EP.funnel([{ result: 'skipped' }, { result: 'prescreen_skip' }, { result: 'rejected', reason: 'restricted' }, { result: 'rejected', stage: 'owner' },
    { result: 'no_name' }, { result: 'error' }, { result: 'no_angle' }, { result: 'queued' }, { result: 'queued' }]);
  ok('considered 8 > judge 6 > owner finder 3 > writer 2; hit rate 3 of 5', f.considered === 8 && f.clearedJudge === 6 && f.clearedOwner === 3
    && f.clearedWriter === 2 && Math.abs(f.contactHitRate - 3 / 5) < 1e-9 && f.rejected.ourFaults === 1, f);

  // ── 7. ZERO ROWS IN THE RECORD: THE WHOLE TEST ────────────────────────────
  OUT.push('', '-- an athlete whose market has ZERO rows in the record --');
  const fill = async (id, data) => {
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [id, AG, JSON.stringify(data)]);
    const profile = AR.resolveAthlete({ id, data }, { schoolLocation: SR.resolveSchool });
    return { profile, r: await job.fillAthlete(P, { agentId: AG, agentFirstName: 'John', athleteId: id, athleteName: data.name, budget: Q.newBudget(100),
      region: profile.market, athleteProfile: profile, athleteRow: data, onProgress: (m) => { if (process.env.EN_DEBUG) console.log('  >> ' + m); } }) };
  };
  const probe = AR.resolveAthlete({ id: 'x', data: { school: 'Montana State University' } }, { schoolLocation: SR.resolveSchool });
  await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [probe.marketKey]);
  const zeroBefore = (await P.query(`SELECT COUNT(*)::int n FROM market_business_seen WHERE market_key = $1`, [probe.marketKey])).rows[0].n;
  ok(`the market (${probe.marketKey}) starts with zero rows`, zeroBefore === 0 && !!probe.marketKey, probe.marketKey);
  const z = await fill('en-z1', { name: 'En Zero', school: 'Montana State University', division: 'D1', sport: 'Football', instagram: 800 });
  const ZL = z.r.loop || {};
  ok('a low-tier athlete starting from nothing reaches five', z.r.filled === 5 && ZL.held === 5, { filled: z.r.filled, loop: ZL, note: z.r.note });
  ok('  by going to look: Google was searched and the record now holds the market', calls.places > 0
    && (await P.query(`SELECT COUNT(*)::int n FROM market_business_seen WHERE market_key = $1`, [probe.marketKey])).rows[0].n >= 5, calls.places);
  ok('  its rungs never touched the social or national lane (tier low)', (ZL.rungs || []).includes('places-refresh') && !(ZL.rungs || []).some((x) => x === 'social' || x === 'national'), ZL.rungs);
  ok('  the run reports its tier and ladder', ZL.tier === 'low' && (ZL.ladder || []).join() === T.ladderFor('low').join(), [ZL.tier, ZL.ladder]);
  const zf = EP.funnel(z.r.tried);
  ok('  the funnel from its own record: five cleared the writer, none were our faults', zf.clearedWriter === 5 && zf.rejected.ourFaults === 0, zf);
  const tm = EP.timing(z.r.tried);
  const placed = (z.r.tried || []).filter((t) => t.result === 'queued');
  ok('  every candidate carries where its time went, by stage, and the proof adds it up',
    placed.length === 5 && placed.every((t) => t.ms && typeof t.ms.total === 'number' && 'contacts' in t.ms && 'writer' in t.ms)
    && tm.candidates >= 5 && tm.byStage.some((x) => x.stage === 'contacts') && tm.byStage.some((x) => x.stage === 'writer'), { tm, ms: placed[0] && placed[0].ms });
  const mk = (await P.query(`SELECT COUNT(*)::int n FROM outreach_queue WHERE athlete_id = 'en-z1' AND state = 'queued' AND market_key = $1`, [probe.marketKey])).rows[0].n;
  ok('  every card carries the market it was found in', mk === 5, mk);

  // A mid-tier athlete from zero: the social lane is half the supply.
  await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [probe.marketKey]);
  await P.query(`DELETE FROM market_pool_schedule WHERE market_key = $1`, [probe.marketKey]).catch(() => {});
  const realSocial = store.getSocialBrandPool;
  store.getSocialBrandPool = async () => Array.from({ length: 6 }, (_, i) => ({ brand: `EN Social Brand ${i}`, brandKey: `en-sb-${i}`, fitScore: 40 }));
  const z2 = await fill('en-z2', { name: 'En Zero Two', school: 'Montana State University', division: 'D1', sport: 'Football', instagram: 12000 });
  store.getSocialBrandPool = realSocial;
  const lanes2 = (await P.query(`SELECT lane, COUNT(*)::int n FROM outreach_queue WHERE athlete_id = 'en-z2' AND state = 'queued' GROUP BY 1`)).rows;
  const soc2 = (lanes2.find((x) => x.lane === 'social') || {}).n || 0;
  ok('a mid-tier athlete from zero reaches five, with the social lane carrying its half', z2.r.filled === 5 && soc2 >= 2, { filled: z2.r.filled, lanes2, rungs: (z2.r.loop || {}).rungs });

  // THE EVIDENCE BAR EMPTIES THE SOCIAL LANE: the athlete still reaches five.
  // Bar on, and every social brand on offer has no evidence of signing anyone
  // (no deal, no program): the lane is refused whole, at the slate and at the
  // social rung, and local fills every seat. Stricter brands never mean four cards.
  await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [probe.marketKey]);
  await P.query(`DELETE FROM market_pool_schedule WHERE market_key = $1`, [probe.marketKey]).catch(() => {});
  const _bar = process.env.SIGNING_EVIDENCE_BAR;
  process.env.SIGNING_EVIDENCE_BAR = '1';
  store.getSocialBrandPool = async () => Array.from({ length: 6 }, (_, i) => ({ brand: `EN Unproven ${i}`, brandKey: `en-unp-${i}`, fitScore: 90 }));
  let z3;
  try { z3 = await fill('en-z3', { name: 'En Zero Three', school: 'Montana State University', division: 'D1', sport: 'Football', instagram: 12000 }); }
  finally { store.getSocialBrandPool = realSocial; if (_bar === undefined) delete process.env.SIGNING_EVIDENCE_BAR; else process.env.SIGNING_EVIDENCE_BAR = _bar; }
  const lanes3 = (await P.query(`SELECT lane, COUNT(*)::int n FROM outreach_queue WHERE athlete_id = 'en-z3' AND state = 'queued' GROUP BY 1`)).rows;
  const loc3 = (lanes3.find((x) => x.lane === 'local') || {}).n || 0;
  ok('EVIDENCE BAR ON, SOCIAL LANE EMPTIED: the athlete still reaches five, all from local', z3.r.filled === 5 && loc3 === 5 && !lanes3.some((x) => x.lane === 'social'),
    { filled: z3.r.filled, lanes3, rungs: (z3.r.loop || {}).rungs, note: z3.r.note });

  // ── 8. THE PROOF HARNESS ──────────────────────────────────────────────────
  OUT.push('', '-- the proof harness --');
  const pk = await EP.pick(P);
  ok('it picks a rich market, a thin one and a zero-row one when they exist', pk && typeof pk.eligible === 'number' && 'zero' in pk && 'rich' in pk && 'thin' in pk);
  ok('  and never a subject that already holds five: it would test nothing', [pk.rich, pk.thin, pk.zero].filter(Boolean).every((c) => c.held < 5)
    && ![pk.rich, pk.thin, pk.zero].filter(Boolean).some((c) => c.id === 'en-z1'), pk);
  const text = EP.formatReport({ id: 'proof_x', done: true, missing: [], results: [{ role: 'ZERO rows in the record', ok: true, name: 'En Zero', market: 'Bozeman, MT',
    tier: 'low', tierWhy: '800 followers', held: 5, placed: 5, reachedFive: true, recordRowsBefore: 0, recordRowsAfter: 12, funnel: zf, costUsd: 0.4, seconds: 30,
    rungs: ZL.rungs, stop: 'floor', split: { local: 5 }, cards: [] }] });
  ok('the report says, per subject: five or short, candidates by role, hit rate, cost, time, split',
    /FIVE: holds 5 of 5/.test(text) && /considered \d+ > judge \d+ > owner finder \d+ > writer 5/.test(text) && /contact hit rate/.test(text)
    && /cost \$0\.40, 30s/.test(text) && /split: local 5/.test(text) && /record rows for the market: 0 before, 12 after/.test(text), text);
  // The zero test refuses a market that is not empty, before spending.
  const heldBeforeRefusal = (await P.query(`SELECT COUNT(*)::int n FROM outreach_queue WHERE athlete_id = 'en-z1'`)).rows[0].n;
  const notZero = await EP.runAthlete(P, 'en-z1', { expectZero: true });
  ok('the zero-row subject is refused, unrun, when its market (by the run\'s own key) is not empty', notZero.ok === false && notZero.notZero === true
    && /NOT A ZERO-ROW TEST/.test(notZero.error) && notZero.recordRowsBefore > 0
    && (await P.query(`SELECT COUNT(*)::int n FROM outreach_queue WHERE athlete_id = 'en-z1'`)).rows[0].n === heldBeforeRefusal, notZero);
  const kept = (await P.query(`SELECT COUNT(*)::int n FROM outreach_queue WHERE athlete_id = 'en-z1' AND state = 'queued'`)).rows[0].n;
  await EP.runAthlete(P, 'en-z1', { fresh: true });
  ok('fresh=1 alone never expires an agent\'s queued cards', (await P.query(`SELECT COUNT(*)::int n FROM outreach_queue WHERE athlete_id = 'en-z1' AND state = 'expired'`)).rows[0].n === 0 && kept === 5);
  const IDX = require('fs').readFileSync(REPO + 'server/index.js', 'utf8');
  ok('admin can pick, start and read a proof', /app\.get\('\/api\/admin\/engine\/prove\/pick', requireAuth, requireCampusAdmin/.test(IDX)
    && /app\.post\('\/api\/admin\/engine\/prove', requireAuth, requireCampusAdmin/.test(IDX) && /app\.get\('\/api\/admin\/engine\/prove\/:id', requireAuth, requireCampusAdmin/.test(IDX));

  // ── 9. THE WRITER'S POSITION CHECK, AND THE ALARM ────────────────────────
  OUT.push('', '-- a compound position, and one refusal on every business --');
  const realPW = require(REPO + 'server/services/pitchWriter');
  const jk = { name: "J'Kai'a Graves", position: 'Infielder / Shortstop', sport: 'Softball' };
  ok('"shortstop" for a stored "Infielder / Shortstop" is true, not a false claim',
    realPW.verifyAthleteFacts("J'Kai'a, a shortstop at the school, would love to work with you.", jk).problems.length === 0);
  ok('  so is "infielder"', realPW.verifyAthleteFacts("J'Kai'a, an infielder, would love to work with you.", jk).problems.length === 0);
  ok('  "pitcher" is still refused', realPW.verifyAthleteFacts("J'Kai'a, a pitcher, would love to work with you.", jk).problems.length === 1);
  ok('  every part counts: WR/KR, "Guard, Forward", "Pitcher and Outfielder"',
    realPW.verifyAthleteFacts('Sam, a kick returner, would love to.', { position: 'WR/KR', sport: 'Football' }).problems.length === 0
    && realPW.verifyAthleteFacts('Sam, a forward, would love to.', { position: 'Guard, Forward', sport: 'Basketball' }).problems.length === 0
    && realPW.verifyAthleteFacts('Sam, an outfielder, would love to.', { position: 'Pitcher and Outfielder', sport: 'Baseball' }).problems.length === 0);
  // Every business refused for one identical reason: an alarm, not a quiet zero.
  await P.query(`DELETE FROM market_business_seen WHERE market_key = 'auburn, al' AND brand LIKE 'EN Refuse%'`);
  await P.query(`INSERT INTO market_business_seen (market_key, brand, category) SELECT 'auburn, al', 'EN Refuse ' || g, 'gym' FROM generate_series(0, 5) g ON CONFLICT DO NOTHING`);
  const savedWrite = PW.writePitch;
  PW.writePitch = async () => ({ skipped: true, reason: 'could not write it in voice: says "shortstop" but the stored position is "Infielder / Shortstop"' });
  await P.query(`DELETE FROM service_faults WHERE service = 'writer-refusal' AND reason LIKE 'En Refused%'`).catch(() => {});
  const rf = await fill('en-r1', { name: 'En Refused', school: 'Auburn University', sport: 'Softball', position: 'Infielder / Shortstop', instagram: 800 });
  PW.writePitch = savedWrite;
  await new Promise((r) => setTimeout(r, 300));
  const alarm = (await P.query(`SELECT reason FROM service_faults WHERE service = 'writer-refusal' AND reason LIKE 'En Refused%' ORDER BY at DESC LIMIT 1`).catch(() => ({ rows: [] }))).rows[0];
  ok('the writer refusing every business for one reason raises an alarm naming the athlete and the reason',
    rf.r.filled === 0 && (rf.r.loop || {}).writerRefusedAll && alarm && /refused every business/.test(alarm.reason) && /stored position is/.test(alarm.reason), { loop: rf.r.loop, alarm });
  await P.query(`DELETE FROM market_business_seen WHERE brand LIKE 'EN Refuse%'`);
  // Two candidates, both refused alike, zero cards: the same alarm, no minimum.
  await P.query(`INSERT INTO market_business_seen (market_key, brand, category) SELECT 'auburn, al', 'EN Refuse Two ' || g, 'gym' FROM generate_series(0, 1) g ON CONFLICT DO NOTHING`);
  PW.writePitch = async () => ({ skipped: true, reason: 'could not write it in voice: says "guard" but the stored position is "Guard / Point Guard"' });
  ai.getDealRecommendations = async () => [];
  const savedBuild = PM.buildMarketPoolFromPlaces;
  PM.buildMarketPoolFromPlaces = async () => ({ ok: true, candidates: [], placesCalls: 1 });
  await P.query(`DELETE FROM market_business_seen WHERE market_key = 'auburn, al' AND brand NOT LIKE 'EN Refuse Two%'`);
  const rf2 = await fill('en-r2', { name: 'En Refused Two', school: 'Auburn University', sport: 'Basketball', position: 'Guard / Point Guard', instagram: 800 });
  PW.writePitch = savedWrite; PM.buildMarketPoolFromPlaces = savedBuild;
  await new Promise((r) => setTimeout(r, 300));
  const alarm2 = (await P.query(`SELECT reason FROM service_faults WHERE service = 'writer-refusal' AND reason LIKE 'En Refused Two%' ORDER BY at DESC LIMIT 1`).catch(() => ({ rows: [] }))).rows[0];
  ok('  and with only two candidates, both refused alike and zero cards, it fires too', rf2.r.filled === 0 && alarm2 && /\(2\)/.test(alarm2.reason), { tried: (rf2.r.tried || []).map((t) => t.result), alarm2 });
  await P.query(`DELETE FROM market_business_seen WHERE brand LIKE 'EN Refuse%'`);

  // ── 9b. THE PRODUCTION CASES (position-audit, section 1) ────────────────
  // The stored positions the audit found refused, against the full name a
  // writer uses. Each must pass both directions: the stored abbreviation
  // against the word, and the word stored against the abbreviation.
  const PROD = [
    ['Messiah Mickens', 'RB', 'Football', 'running back'], ['Legend Lyons', 'RB', 'Football', 'running back'],
    ['Jamal Hailey', 'RB', 'Football', 'running back'], ['Brayden Latham', 'RB', 'Football', 'running back'],
    ['Xavier Ford', 'RB', 'Football', 'running back'],
    ['A Receiver', 'WR', 'Football', 'wide receiver'], ['A Corner', 'CB', 'Football', 'cornerback'],
    ['A Safety', 'DB', 'Football', 'defensive back'], ['A First Baseman', '1B', 'Baseball', 'first baseman'],
    ['A Righty', 'RHP', 'Baseball', 'right-handed pitcher'], ['A Righty Two', 'RHP', 'Baseball', 'pitcher'],
    ['A Linebacker', 'linebacker', 'Football', 'linebacker'], ['A Guard', 'Guard', 'Basketball', 'guard'],
    ['Amber Bretton', 'Pitcher', 'Softball', 'pitcher'], ['A Tackle', 'Offensive Line (Left Tackle)', 'Football', 'left tackle'],
    ['A Lineman', 'Offensive Line (Left Tackle)', 'Football', 'offensive lineman'], ['An OL', 'OL', 'Football', 'offensive lineman'],
    ['An Edge', 'EDGE', 'Football', 'edge rusher'], ["J'Kai'a Graves", 'Infielder / Shortstop', 'Softball', 'shortstop'],
  ];
  const prodFails = [];
  for (const [who, stored, sport, word] of PROD) {
    const first = who.split(' ')[0];
    const fwd = realPW.verifyAthleteFacts(`${first}, a ${word} at the school, would love to work with you this season.`, { name: who, position: stored, sport }).problems;
    if (fwd.length) prodFails.push([who, stored, word, fwd[0]]);
  }
  ok(`every production case passes: ${PROD.length} stored positions against the word the writer used`, prodFails.length === 0, prodFails);
  const BACK = [['running back', 'RB'], ['cornerback', 'CB'], ['first baseman', '1B'], ['right-handed pitcher', 'RHP'], ['defensive back', 'DB'],
    ['wide receiver', 'WR'], ['offensive lineman', 'OL'], ['edge rusher', 'EDGE']];
  const backFails = BACK.filter(([stored, word]) => realPW.verifyAthleteFacts(`Sam, a ${word} at the school, would love to work with you.`,
    { name: 'Sam Lee', position: stored, sport: /baseman|pitcher/.test(stored) ? 'Baseball' : 'Football' }).problems.length);
  ok('  and the other direction: a stored full name against the abbreviation', backFails.length === 0, backFails);
  ok('  a claim MORE specific than the record is still refused: "point guard" for a stored "Guard"',
    realPW.verifyAthleteFacts('Sam, a point guard at the school, would love to work with you.', { name: 'Sam Lee', position: 'Guard', sport: 'Basketball' }).problems.length === 1);

  // ── 10. THE POSITION AUDIT ───────────────────────────────────────────────
  OUT.push('', '-- position-audit --');
  const PA = require(REPO + 'scripts/position-audit.js');
  await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, details) VALUES ($1, '2026-09-20', $2::jsonb), ($1, '2026-09-21', $3::jsonb)
                 ON CONFLICT (agent_id, run_date) DO UPDATE SET details = EXCLUDED.details`, [AG,
    JSON.stringify([{ athleteId: 'en-pa', athleteName: 'En Audit', tried: [
      { brand: 'A', result: 'no_angle', reason: 'could not write it in voice: says "shortstop" but the stored position is "Infielder / Shortstop"' },
      { brand: 'B', result: 'no_angle', reason: 'could not write it in voice: says "shortstop" but the stored position is "Infielder / Shortstop"' },
      { brand: 'C', result: 'queued', reason: null, writerFirstProblems: ['says "shortstop" but the stored position is "Infielder / Shortstop"'] }] }]),
    JSON.stringify([{ athleteId: 'en-pa', athleteName: 'En Audit', tried: [
      { brand: 'D', result: 'no_angle', reason: 'could not write it in voice: says "shortstop" but the stored position is "Infielder / Shortstop"' }] }])]);
  const ms = (await PA.measured(P)).find((a) => a.athleteId === 'en-pa');
  const pair = ms && [...ms.pairs.values()][0];
  ok('section 1 prints the real strings: the word the writer used and what was stored, with counts and dates',
    pair && pair.said === 'shortstop' && pair.stored === 'Infielder / Shortstop' && pair.refused === 3 && pair.rewritten === 1 && pair.first === '2026-09-20' && pair.last === '2026-09-21', pair);
  ok('section 1 counts every business refused for the position, by athlete, with nights and the stored position',
    ms && ms.refused === 3 && ms.retried === 1 && ms.nights.size === 2 && ms.stored === 'Infielder / Shortstop', ms && { ...ms, nights: [...ms.nights] });
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('en-pa', $1, '{"name":"En Audit","sport":"Softball","position":"Infielder / Shortstop"}'::jsonb),
                 ('en-pb', $1, '{"name":"En Same","sport":"Football","position":"QB / Quarterback"}'::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [AG]);
  const ex = await PA.exposed(P);
  const exA = ex.find((r) => r.id === 'en-pa'), exB = ex.find((r) => r.id === 'en-pb');
  ok('section 2: a position with parts in different groups COULD FAIL, naming the word that was refused; one group is safe',
    exA && exA.couldFail && exA.refusedWords.join() === 'Shortstop' && exB && !exB.couldFail, { exA, exB });
  const IDXp = require('fs').readFileSync(REPO + 'server/index.js', 'utf8');
  ok('it runs at /api/admin/scripts/position-audit, read-only (no apply)', /'position-audit': \{ file: 'scripts\/position-audit\.js', args: \(\) => \[\] \}/.test(IDXp)
    && !/--apply/.test(require('fs').readFileSync(REPO + 'scripts/position-audit.js', 'utf8').replace(/there is no --apply/g, '')));
  await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id = $1`, [AG]);

  // ── 11. NEVER TARGETS, AND NEVER THE WRONG PERSON ────────────────────────
  OUT.push('', '-- never targets, and the marketing or partnerships decision maker or nobody --');
  const NS = require(REPO + 'server/services/notASponsor');
  const kinds = ['Texas Tech', 'Alabama', 'Players Era', 'Big 12 Conference', 'SEC', 'NIL Store', 'Learfield', 'Maui Invitational'].map((n) => [n, (NS.detect(n) || {}).kind || null]);
  ok('a university by its bare name, a conference, an event company, an NIL marketplace, a rights holder: never targets', kinds.every(([, k]) => !!k), kinds);
  ok('  Nike, a gym and a barber named for the SEC are still businesses', !NS.detect('Nike') && !NS.detect('Chuze Fitness') && !NS.detect('SEC Barbers', { category: 'salon', primaryType: 'barber_shop' }));
  const C = require(REPO + 'server/services/compliance');
  ok('  and every gate enforces it: compliance reports Texas Tech as not-a-sponsor', C.classifyBusiness('Texas Tech').hits.some((h) => h.key === 'not-a-sponsor'));
  ok('titles: emeritus, a board chair, a school president, retired -- never', !!ONS.titleProblem('Chairman Emeritus and co-founder') && !!ONS.titleProblem('17th President of Texas Tech University')
    && !!ONS.titleProblem('Chairman of the Board') && !!ONS.titleProblem('Retired owner') && !ONS.titleProblem('Owner'));
  ok('  at a large brand the CEO, president, founder or owner is refused; the partnerships or marketing lead is accepted',
    !!ONS.titleProblem('CEO', { large: true }) && !!ONS.titleProblem('Owner', { large: true }) && !!ONS.titleProblem('Co-founder', { large: true })
    && !ONS.titleProblem('Head of Athlete Partnerships', { large: true }) && !ONS.titleProblem('Director of Influencer Marketing', { large: true }));
  // Jasper Johnson's night, replayed: a national brand's search names its
  // chairman emeritus first. (Nike itself is now refused outright as a household
  // incumbent -- services/signingEvidence -- so the contact rule is shown on a
  // national brand that is not one.)
  const realComps = store.getTopNilComps, realSocial2 = store.getSocialBrandPool, realWS = ai.webSearchJson;
  store.getTopNilComps = async () => [{ brand: 'Nike', brandKey: 'nike', why: 'signs athletes' }, { brand: 'EN Natl Apparel', brandKey: 'ennatlapparel', why: 'signs athletes' }, { brand: 'Texas Tech', brandKey: 'texastech', why: 'NIL program' }];
  store.getSocialBrandPool = async () => [];
  const asked = [];
  ai.webSearchJson = async (prompt) => {
    if (/^Find the official Instagram account of "EN Natl Apparel"/.test(String(prompt))) return { text: '{"handle":"ennatlapparel","confidence":"high"}', citations: ['https://instagram.com/ennatlapparel'], searches: 1 };
    if (/^Find the official Instagram account of /.test(String(prompt))) return { text: '{"handle":null}', citations: [], searches: 1 };
    const m = String(prompt).match(/^Search for: (.+)\n/);
    if (m) {
      asked.push(m[1]);
      if (/^EN Natl Apparel /.test(m[1]) && /partnerships/.test(m[1])) return { text: JSON.stringify({ name: 'Phil Knight', title: 'Chairman Emeritus and co-founder', confidence: 'high' }), citations: [], searches: 1 };
      if (/^EN Natl Apparel /.test(m[1]) && /marketing director/.test(m[1])) return { text: JSON.stringify({ name: 'Marcus Hill', title: 'Director of Athlete Marketing', confidence: 'high' }), citations: [], searches: 1 };
      return { text: JSON.stringify({ name: 'Pat Rivera', title: 'Owner', confidence: 'high' }), citations: [], searches: 1 };
    }
    throw new Error('the real web search must not be reached here');
  };
  await P.query(`DELETE FROM brand_evidence_cache WHERE brand ILIKE 'nike' OR brand ILIKE 'en natl apparel' OR brand ILIKE 'texas tech'`).catch(() => {});
  const jj = await fill('en-jj', { name: 'En Jasper', school: 'Auburn University', sport: 'Basketball', instagram: 150000 });
  store.getTopNilComps = realComps; store.getSocialBrandPool = realSocial2; ai.webSearchJson = realWS;
  const jjCards = (await P.query(`SELECT brand_name, contact_name, contact_title FROM outreach_queue WHERE athlete_id = 'en-jj' AND state = 'queued'`)).rows;
  const natl = jjCards.find((c) => c.brand_name === 'EN Natl Apparel');
  ok('a national brand: its Chairman Emeritus is refused, the Director of Athlete Marketing is the contact', natl && natl.contact_name === 'Marcus Hill', { jjCards, asked: asked.filter((q) => /^EN Natl/.test(q)) });
  ok('  a large brand is never searched for its owner or founder', !asked.some((q) => /^EN Natl Apparel .*owner/.test(q) && !/partnerships/.test(q)), asked.filter((q) => /^EN Natl/.test(q)));
  ok('NIKE never reaches a card, or a contact search: a household incumbent, refused on every path', !jjCards.some((c) => c.brand_name === 'Nike') && !asked.some((q) => /^Nike /.test(q)), { jjCards, asked: asked.filter((q) => /^Nike/.test(q)) });
  ok('  and Texas Tech never reached a card, or a search', !jjCards.some((c) => /Texas Tech/.test(c.brand_name)) && !asked.some((q) => /^Texas Tech/.test(q)), jjCards);

  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  await require('./_evidence').clear(store.pool, Array.from({ length: 6 }, (_, i) => `EN Social ${i}`).concat(Array.from({ length: 6 }, (_, i) => `EN Social Brand ${i}`)));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
