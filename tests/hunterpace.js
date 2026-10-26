'use strict';
// ── HUNTER, PACED TO THE RESET (HUNTER_PACE_ON) ─────────────────────────────
//
// Hunter ran out of credits on 2026-10-18 and two nights placed no cards.
//   1. The account is read before the night; tonight may use at most
//      (credits left - a 10% reserve) / nights until the reset, counted where
//      a credit is committed.
//   2. The 5:30 email carries "Hunter: X credits left, resets DATE, tonight's
//      allowance Y", a loud warning under 300, and the admin is alerted the
//      moment the period is on track to run out before the reset.
//   3. Credits spent: the night places cards from addresses verified in the
//      last 30 days, and the morning email says so.
//   4. Admin script spend-breakdown; last night's cost and cost per verified
//      email in the 5:30 email.
// Real Postgres (a fresh database), the real job and Scout; Places, the
// ladder, the writer and Hunter's network are stubbed.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('hunterpacetest', { schema: true });
process.env.TZ = process.env.TZ || 'America/Chicago';
for (const k of ['HUNTER_PACE_ON', 'EMAIL_FIVE_ON', 'EMAIL_FINDER_ON', 'EMAIL_FINDER_MORE', 'EMAIL_SMART_PICK', 'MARKET_MIX_ON']) delete process.env[k];
process.env.HUNTER_API_KEY = 'test-key';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
require('./helpers/offlineDns').install();

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request) {
  const m = originalLoad.apply(this, arguments);
  if (request === '../services/placesLookup') {
    const place = (b) => ({ name: b, businessStatus: 'OPERATIONAL', website: null, phone: '(254) 555-1212', primaryType: 'restaurant' });
    return { ...m, lookupPlace: async (b) => place(b), lookupPlaceResult: async (b) => ({ ok: true, place: place(b) }) };
  }
  return m;
};
const fs = require('fs');
const cp = require('child_process');
const store = require(REPO + 'server/store');
const ai = require(REPO + 'server/ai');
const PW = require(REPO + 'server/services/pitchWriter');
const EF = require(REPO + 'server/services/emailFinder');
const HP = require(REPO + 'server/services/hunterPace');
const H = require(REPO + 'server/services/hunterLookup');
const S5 = require(REPO + 'server/services/shortOfFive');
const NC = require(REPO + 'server/services/nightCost');
const { checkDomain } = require(REPO + 'server/services/domainGate');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const on = () => { process.env.HUNTER_PACE_ON = '1'; };
const off = () => { delete process.env.HUNTER_PACE_ON; HP._reset(); };
const DAY = 86400000;
// /v2/account, as Hunter answers it.
const account = ({ credits, searches, verifications, reset = '2026-11-01', plan = 'Starter' }) => async () => ({
  ok: true, status: 200,
  json: async () => ({ data: { plan_name: plan, reset_date: reset, requests: {
    ...(credits ? { credits: { used: credits[0], available: credits[1] } } : {}),
    ...(searches ? { searches: { used: searches[0], available: searches[1] } } : {}),
    ...(verifications ? { verifications: { used: verifications[0], available: verifications[1] } } : {}) } } }),
});

// ── 1. THE ARITHMETIC. Pure. ────────────────────────────────────────────────
function arithmetic() {
  console.log('\n1. TONIGHT\'S ALLOWANCE: (credits left - 10% reserve) / nights until the reset');
  const a = HP.parseAccount({ data: { plan_name: 'Starter', reset_date: '2026-11-01', requests: { credits: { used: 400, available: 2000 } } } });
  ok('the account read: credits left and the reset date', a.ok && a.credits.left === 1600 && a.resetDate === '2026-11-01', a);
  ok('nights until the reset: tonight through Oct 31', HP.nightsUntil('2026-11-01', '2026-10-19') === 13, HP.nightsUntil('2026-11-01', '2026-10-19'));
  ok('the night of the reset itself is never zero nights', HP.nightsUntil('2026-11-01', '2026-11-01') === 1);
  const p = HP.planFor(a, { runDate: '2026-10-19' });
  // reserve = 10% of 2,000 = 200; (1,600 - 200) / 13 = 107.7 -> 107
  ok('allowance = floor((1600 - 200) / 13) = 107', p.pools[0].allowance === 107 && p.pools[0].reserve === 200, p.pools[0]);
  ok('  not low: 1,600 is over 300', !p.warn);
  const low = HP.planFor(HP.parseAccount({ data: { reset_date: '2026-11-01', requests: { credits: { used: 1750, available: 2000 } } } }), { runDate: '2026-10-19' });
  ok('250 left: low (under 300), and the allowance is (250 - 200) / 13 = 3', low.warn && low.pools[0].allowance === 3, low.pools[0]);
  const out = HP.planFor(HP.parseAccount({ data: { reset_date: '2026-11-01', requests: { credits: { used: 1850, available: 2000 } } } }), { runDate: '2026-10-19' });
  ok('150 left, under the reserve: tonight\'s allowance is 0', out.pools[0].allowance === 0, out.pools[0]);
  const split = HP.planFor(HP.parseAccount({ data: { reset_date: '2026-11-01', requests: { searches: { used: 500, available: 2000 }, verifications: { used: 1000, available: 4000 } } } }), { runDate: '2026-10-19' });
  ok('a plan billed in searches and verifications: two pools, each paced', split.pools.length === 2
    && split.pools[0].allowance === Math.floor((1500 - 200) / 13) && split.pools[1].allowance === Math.floor((3000 - 400) / 13), split.pools);
  ok('a credits plan: a search costs 1, a verification 0.5', HP.poolsOf(a)[0].charges.search === 1 && HP.poolsOf(a)[0].charges.verify === 0.5);
  // Run-out projection: 1,400 used by Oct 19 of a period that began Oct 1.
  const fast = HP.parseAccount({ data: { reset_date: '2026-11-01', requests: { credits: { used: 1400, available: 2000 } } } });
  const pr = HP.projection(fast, Date.parse('2026-10-19T12:00:00Z'))[0];
  ok('on track to run out: ~76 a day with 600 left and 12.5 days to go', pr.runsOut && pr.runsOutOn < '2026-11-01', pr);
  const slow = HP.parseAccount({ data: { reset_date: '2026-11-01', requests: { credits: { used: 300, available: 2000 } } } });
  ok('not on track to run out at ~16 a day with 1,700 left', !HP.projection(slow, Date.parse('2026-10-19T12:00:00Z'))[0].runsOut);
}

// ── 2. THE NIGHT ────────────────────────────────────────────────────────────
async function theNight(P) {
  console.log('\n2. THE NIGHT: READ BEFORE IT RUNS, COUNTED WHERE A CREDIT IS COMMITTED');
  off();
  ok('switch off: no night, nothing refused', (await HP.beginNight(P, { runDate: '2026-10-10', fetchImpl: account({ credits: [1999, 2000] }) })) === null && HP.take('search').ok);
  on();
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return account({ credits: [1736, 2000] })(); };   // 264 left: (264-200)/13 = 4
  const alerts = [];
  const n = await HP.beginNight(P, { runDate: '2026-10-19', fetchImpl, now: Date.parse('2026-10-19T06:00:00Z'), send: async (m) => { alerts.push(m); } });
  ok('  264 left with 1,736 used by Oct 19: on track to run out, alerted before the night spends', alerts.length === 1 && /on track to run out/.test(alerts[0].subject), alerts.map((a) => a.subject));
  ok('the account is read before the night', calls.length === 1 && /\/v2\/account/.test(calls[0]), calls);
  ok('  tonight\'s allowance fixed: 4 credits', n && n.plan.pools[0].allowance === 4, n && n.plan);
  const row = (await P.query(`SELECT * FROM hunter_nights WHERE run_date='2026-10-19'`)).rows[0];
  ok('  and recorded for the morning email', row && row.plan && row.plan.pools[0].left === 264, row && row.plan);
  ok('a search: allowed (1 of 4)', HP.take('search').ok);
  ok('two verifications: allowed (2 of 4)', HP.take('verify').ok && HP.take('verify').ok);
  ok('a search: allowed (3 of 4)', HP.take('search').ok);
  ok('  not cache mode yet', !HP.cacheOnly());
  ok('one more verification: allowed (3.5 of 4)', HP.take('verify').ok);
  const refused = HP.take('search');
  ok('a search that would pass 4: refused, saying why', !refused.ok && /tonight's Hunter allowance is spent/.test(refused.why), refused);
  ok('  and the rest of the night is cache mode', HP.cacheOnly());
  ok('a second run the same night keeps the allowance (no second account read)', (await HP.beginNight(P, { runDate: '2026-10-19', fetchImpl })).plan.pools[0].allowance === 4 && calls.length === 1);
  await HP.endNight(P, { check: false });
  await HP.endNight(P, { check: false });
  const after = (await P.query(`SELECT spent, cache_only, cache_why FROM hunter_nights WHERE run_date='2026-10-19'`)).rows[0];
  ok('the night closes with what it spent and that it went to cache mode', after.spent.search === 2 && after.spent.verify === 3 && after.cache_only === true, after);
  ok('  closed: nothing is paced after it', !HP.night() && HP.take('search').ok);

  // A restart mid-night: the night is picked up from the record, spent and all.
  await P.query(`INSERT INTO hunter_nights (run_date, started_at, plan, account) VALUES ('2026-10-20', NOW() - INTERVAL '1 hour', $1::jsonb, '{}'::jsonb)`,
    [JSON.stringify(HP.planFor(HP.parseAccount({ data: { reset_date: '2026-11-01', requests: { credits: { used: 1000, available: 2000 } } } }), { runDate: '2026-10-20' }))]);
  for (let i = 0; i < 3; i++) await P.query(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at) VALUES ($1,'hunter',$1,'{}'::jsonb,'OK',NOW())`, ['hp-r' + i + '.com']);
  await P.query(`INSERT INTO email_verify_credit_log (email, source, local_date) VALUES ('a@hp-r.com','nightly','2026-10-20'), ('b@hp-r.com','nightly','2026-10-20')`);
  const again = await HP.beginNight(P, { runDate: '2026-10-20', fetchImpl: async () => { throw new Error('must not be read again'); } });
  ok('a restart picks the night up from our own records: 3 searches, 2 verifications', again.spent.search === 3 && again.spent.verify === 2, again.spent);
  await HP.endNight(P, { check: false });

  // A plan billed in searches and verifications: no searches left is not cache mode.
  const s = await HP.beginNight(P, { runDate: '2026-10-21', fetchImpl: account({ searches: [1990, 2000], verifications: [100, 4000] }) });
  ok('split plan: searches past the reserve, so no search tonight', s.plan.pools[0].allowance === 0 && !HP.take('search').ok);
  ok('  but verifications still run, so it is not cache mode', HP.take('verify').ok && !HP.cacheOnly());
  await HP.endNight(P, { check: false });

  // Below the reserve from the start: cache mode from the first minute.
  const z = await HP.beginNight(P, { runDate: '2026-10-22', fetchImpl: account({ credits: [1900, 2000] }) });
  ok('100 credits left, under the 200 reserve: cache mode from the start', z.plan.pools[0].allowance === 0 && HP.cacheOnly(), z.plan.pools[0]);
  await HP.endNight(P, { check: false });

  // The account endpoint down: paced on our own counts, and said so.
  const e = await HP.beginNight(P, { runDate: '2026-10-23', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  ok('the account endpoint down: paced on our own counts, marked estimated', e.plan.estimated === true && e.plan.pools.length === 2 && /HTTP 500/.test(e.plan.readError), e.plan);
  await HP.endNight(P, { check: false });
}

// ── 3. HUNTER'S OWN CHOKE POINTS ────────────────────────────────────────────
async function chokePoints(P) {
  console.log('\n3. EVERY HUNTER CALL GOES THROUGH THE ALLOWANCE');
  on();
  await HP.beginNight(P, { runDate: '2026-10-24', fetchImpl: account({ credits: [1784, 2000] }) });   // (216-200)/8 nights = 2
  let searched = 0;
  const hunterOk = async () => { searched++; return { ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ data: { pattern: '{first}', emails: [{ value: 'pat@x.com', type: 'personal', first_name: 'Pat', last_name: 'X' }] } }) }; };
  H._resetBudgetCache();
  const a1 = await H.findDomainEmails('hp-one.com', { fetchImpl: hunterOk });
  const a2 = await H.findDomainEmails('hp-two.com', { fetchImpl: hunterOk });
  const a3 = await H.findDomainEmails('hp-three.com', { fetchImpl: hunterOk });
  ok('Domain Search: two searches tonight, then refused (Hunter not called)', searched === 2 && a1 && a2 && a3 === null, { searched, a1: !!a1, a2: !!a2, a3 });
  let fetched = 0;
  const v = await H.verifyEmail('pat@shop-hp.com', { fetchImpl: async () => { fetched++; return { ok: true, status: 200, json: async () => ({ data: { status: 'valid' } }), headers: { get: () => null } }; } });
  ok('verifyEmail past the allowance: refused, Hunter never called', !v.ok && v.pace === true && v.budget === true && fetched === 0, { v, fetched });
  const deps = EF.liveDeps(P, { business: 'Shop HP', source: 'nightly' });
  const before = (await P.query(`SELECT COUNT(*)::int n FROM email_verify_credit_log`)).rows[0].n;
  const dv = await deps.verify('pat@shop-hp.com');
  const afterN = (await P.query(`SELECT COUNT(*)::int n FROM email_verify_credit_log`)).rows[0].n;
  ok('the finder\'s check: not run, and no credit-log row for a check never made', dv && dv.notRun && afterN === before, { dv, before, afterN });
  await P.query(`INSERT INTO email_verification (email, result, detail, source, status, checked_at) VALUES
    ('fresh@shop-hp.com','valid','seeded','hunter','valid', NOW() - INTERVAL '10 days'),
    ('old@shop-hp.com','valid','seeded','hunter','valid', NOW() - INTERVAL '45 days')`);
  const f1 = await deps.verify('fresh@shop-hp.com');
  const f2 = await deps.verify('old@shop-hp.com');
  ok('cache mode: an address verified 10 days ago passes from the cache', f1 && f1.result === 'valid' && f1.cached, f1);
  ok('  one verified 45 days ago does not (only the last 30 days)', f2 && f2.result !== 'valid', f2);
  await HP.endNight(P, { check: false });

  await HP.beginNight(P, { runDate: '2026-10-25', fetchImpl: account({ credits: [100, 2000] }) });
  const q = await H.verifyEmail('lee@quota-hp.com', { fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ errors: [{ id: 'too_many_requests', details: 'You have reached your monthly quota' }] }), headers: { get: () => null } }) });
  ok('Hunter says the plan is out (a 429 quota): cache mode for the rest of the night', !q.ok && HP.cacheOnly() && /out of credits/.test(HP.night().cacheWhy), { q, why: HP.night() && HP.night().cacheWhy });
  await HP.endNight(P, { check: false });
}

// ── 4. THE ALERT, THE MOMENT IT IS ON TRACK TO RUN OUT ──────────────────────
async function runOutAlert(P) {
  console.log('\n4. THE RUN-OUT ALERT');
  on();
  const sent = [];
  const send = async (m) => { sent.push(m); };
  // 1,900 used by Oct 27: ~71 a day with 100 left and ~4 days to go.
  const fast = HP.parseAccount({ data: { reset_date: '2026-11-01', requests: { credits: { used: 1900, available: 2000 } } } });
  const now = Date.parse('2026-10-27T15:00:00Z');
  const s1 = await HP.alertIfRunningOut(P, fast, { now, send });
  ok('on track to run out before the reset: the admin is alerted', s1.length === 1 && sent.length === 1 && /on track to run out of credits/.test(sent[0].subject), sent[0] && sent[0].subject);
  ok('  saying how much is left, the rate and the day it runs out', /100 left/.test(sent[0].text) && /a day/.test(sent[0].text) && /runs out on 2026-10-\d\d/.test(sent[0].text), sent[0].text);
  await HP.alertIfRunningOut(P, fast, { now: now + 3600000, send });
  ok('  once a day, not every hour', sent.length === 1, sent.length);
  const slow = HP.parseAccount({ data: { reset_date: '2026-11-01', requests: { credits: { used: 200, available: 2000 } } } });
  await HP.alertIfRunningOut(P, slow, { now: now + 2 * DAY, send });
  ok('  and not at all when it is not on track to run out', sent.length === 1);
  const t = await HP.tick(P, { fetchImpl: account({ credits: [1950, 2000] }), now: now + DAY, send });
  ok('the hourly tick reads the account (free) and alerts the same way', Array.isArray(t.alerted) && t.alerted.length === 1 && sent.length === 2, t);
  off();
  ok('switch off: the tick does nothing', (await HP.tick(P, { fetchImpl: account({ credits: [1999, 2000] }) })).skipped);
}

// ── 5. THE CACHE-MODE NIGHT ─────────────────────────────────────────────────
async function cacheNight(P) {
  console.log('\n5. CREDITS SPENT: THE NIGHT PLACES CARDS FROM ADDRESSES VERIFIED IN THE LAST 30 DAYS');
  const slug = (b) => String(b).toLowerCase().replace(/[^a-z0-9]/g, '');
  const KEY = 'waco, tx', AG = 'hp-agent';
  const brands = ['Hp Taco 0', 'Hp Taco 1', 'Hp Taco 2', 'Hp Taco 3', 'Hp Taco 4', 'Hp Taco 5'];
  const CACHED = new Set(['dana.reed@hptaco1.com', 'dana.reed@hptaco3.com']);
  const STALE = 'dana.reed@hptaco5.com';
  ai.webSearchJson = async () => { throw new Error('the real web search must not be reached here'); };
  ai.getBrandContacts = async (brand) => ({ contacts: [{ name: 'Dana Reed', title: 'Owner', phone: null, affiliationScope: 'this-location', confidence: 'high', source: 'chamber' }],
    genericInbox: null, businessPhone: '(254) 555-9999', cached: true, instagram: null, website: `https://${slug(brand)}.com` });
  ai.getDealRecommendations = async () => [];
  PW.writePitch = async () => ({ message: 'Hi Dana,\nTwo feed posts and an appearance at your location.\n\nJohn', angle: 'campus traffic', angleKey: 'campus', categoryKey: 'restaurant', ask: '2 posts' });
  const verifyCalls = [];
  const realLive = EF.liveDeps;
  EF.liveDeps = () => ({
    // Hunter's credits are spent: only what the cache already holds answers.
    verify: async (e) => { verifyCalls.push(e); return CACHED.has(e) ? { result: 'valid', status: 'valid', source: 'hunter', cached: true } : { result: 'unknown', notRun: true, budget: true, detail: 'tonight\'s Hunter allowance is spent' }; },
    peek: async () => new Map(), domainSearch: async () => null, emailFinder: async () => ({ email: null, budget: true }), hunterCached: async () => null,
    resolveDomain: async () => ({ website: null, tried: [] }), checkDomain, siteEmail: async () => null, placeLookup: async () => null, facebookPage: async () => null,
    corporate: (d, b, o) => EF.corporateDomain(d, b, o),
  });
  const job = require(REPO + 'server/jobs/outreachQueue');
  const Q = require(REPO + 'server/services/outreachQueue');
  const AR = require(REPO + 'server/services/athleteRecord');
  const SR = require(REPO + 'server/services/schoolResolver');
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'John Agent','hp@x.test','x','agent')`, [AG]);
  for (const b of brands) await P.query(`INSERT INTO market_business_seen (market_key, brand, category) VALUES ($1,$2,'restaurant') ON CONFLICT DO NOTHING`, [KEY, b]);
  // What another night verified: two of these businesses within 30 days, one 45 days ago.
  for (const [b, e, days] of [['Hp Taco 1', 'dana.reed@hptaco1.com', 5], ['Hp Taco 3', 'dana.reed@hptaco3.com', 12], ['Hp Taco 5', STALE, 45]]) {
    await P.query(`INSERT INTO email_verify_credit_log (business, email, source, local_date, checked_at) VALUES ($1,$2,'nightly','2026-10-01', NOW() - make_interval(days => $3))`, [b, e, days]);
    await P.query(`INSERT INTO email_verification (email, result, detail, source, status, checked_at) VALUES ($1,'valid','seeded','hunter','valid', NOW() - make_interval(days => $2))
                   ON CONFLICT (email) DO UPDATE SET checked_at = EXCLUDED.checked_at`, [e, days]);
  }
  const cached = await HP.cachedBrands(P);
  ok('the businesses with an address verified in the last 30 days', cached.has('hp taco 1') && cached.has('hp taco 3') && !cached.has('hp taco 5') && !cached.has('hp taco 0'), [...cached]);

  const fill = async (id) => {
    const data = { name: 'Hp ' + id, school: 'Baylor University', sport: 'Football' };
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [id, AG, JSON.stringify(data)]);
    const profile = AR.resolveAthlete({ id, data }, { schoolLocation: SR.resolveSchool });
    return job.fillAthlete(P, { agentId: AG, agentFirstName: 'John', athleteId: id, athleteName: data.name, budget: Q.newBudget(100),
      region: profile.market, athleteProfile: profile, athleteRow: data, onProgress: (m) => { if (process.env.HP_DEBUG) console.log('  >> ' + m); } });
  };
  for (const k of ['EMAIL_FIVE_ON', 'EMAIL_FINDER_ON', 'EMAIL_FINDER_MORE']) process.env[k] = '1';
  on();
  await HP.beginNight(P, { runDate: '2026-10-26', fetchImpl: account({ credits: [1990, 2000] }) });
  ok('the night begins in cache mode (10 left, 200 in reserve)', HP.cacheOnly());
  const r = await fill('hp-a1');
  const cards = (await P.query(`SELECT brand_name, channel, email, email_verified FROM outreach_queue WHERE athlete_id='hp-a1' AND state='queued' ORDER BY slot`)).rows;
  ok('cards were placed: the night is not empty', cards.length === 2, cards);
  ok('  only the two businesses with an address verified in the last 30 days', cards.every((c) => ['Hp Taco 1', 'Hp Taco 3'].includes(c.brand_name)) && cards.every((c) => c.email_verified && CACHED.has(c.email)), cards);
  const tried = r.tried || [];
  ok('  every other business skipped at once, saying why', tried.filter((t) => t.stage === 'cache').length >= 3
    && tried.filter((t) => t.stage === 'cache').every((t) => /no address at this business was verified in the last 30 days/.test(t.reason)), tried.map((t) => [t.brand, t.stage, t.result]));
  ok('  the one verified 45 days ago was not used', !cards.some((c) => c.brand_name === 'Hp Taco 5'));
  ok('  nothing set aside to retry later tonight', !(r.deferred || []).length, (r.deferred || []).length);
  ok('  the queued cards are marked as placed from the cache', tried.filter((t) => t.result === 'queued' && t.cache).length === 2);
  ok('  the run record says so: cache mode, why, what it placed', r.loop && r.loop.cache && r.loop.cache.placed === 2 && /allowance/.test(r.loop.cache.why) && r.loop.stop === 'cache', r.loop && { cache: r.loop.cache, stop: r.loop.stop });
  ok('  a cache-mode night never counts toward the three-night pause (it is ours, not the market\'s)', (r.nightFaults || []).some((f) => f.service === 'hunter' && /cache mode/.test(f.reason)), r.nightFaults);
  ok('  only the cached businesses reached a lookup at all', verifyCalls.length > 0 && verifyCalls.every((e) => /@hptaco[13]\.com$/.test(e)), verifyCalls);
  await HP.endNight(P, { check: false });
  // For the morning email.
  await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, filled, details, finished_at) VALUES ($1, '2026-10-26', 2, $2::jsonb, NOW())
                 ON CONFLICT (agent_id, run_date) DO UPDATE SET details = EXCLUDED.details`, [AG, JSON.stringify([{ athleteId: 'hp-a1', athleteName: 'Hp hp-a1', filled: 2, tried, loop: r.loop }])]);

  off();
  const r2 = await fill('hp-a2');
  ok('switch off: no cache mode, the night tries every business as before', !r2.loop.cache && !(r2.tried || []).some((t) => t.stage === 'cache'), (r2.tried || []).map((t) => t.stage));
  for (const k of ['EMAIL_FIVE_ON', 'EMAIL_FINDER_ON', 'EMAIL_FINDER_MORE']) delete process.env[k];
  EF.liveDeps = realLive;
}

// ── 6. THE 5:30 EMAIL ───────────────────────────────────────────────────────
async function morningEmail(P) {
  console.log('\n6. THE 5:30 EMAIL: HUNTER, CACHE MODE, LAST NIGHT\'S COST');
  on();
  // Tonight's record as the night left it.
  const plan = HP.planFor(HP.parseAccount({ data: { reset_date: '2026-11-01', requests: { credits: { used: 1990, available: 2000 } } } }), { runDate: '2026-10-26' });
  ok('a plan with 10 left is the low one', plan.warn);
  // Cost: model calls in the night's window, Places from the run's spend log, verified cards placed.
  await P.query(`INSERT INTO ai_call_ledger (site, model, est_usd, at) VALUES ('writer','m',0.40,'2026-10-26T07:00:00Z'), ('contacts','m',0.35,'2026-10-26T08:00:00Z'), ('writer','m',9.99,'2026-10-24T07:00:00Z')`);
  await P.query(`UPDATE outreach_queue_runs SET details = jsonb_set(details, '{0,spendLog}', '[{"brand":"[places refresh]","lane":"market-refresh","cost":0.32,"placesCalls":10}]'::jsonb) WHERE run_date = '2026-10-26'`);
  await P.query(`UPDATE outreach_queue SET created_at = '2026-10-26T08:30:00Z' WHERE athlete_id = 'hp-a1'`);
  // The night is a fixed date, so a card this test placed "now" (hp-a2's)
  // fell inside it whenever the suite ran between 18:00 UTC on 2026-10-25
  // and 12:00 UTC on 2026-10-26. Only hp-a1's two belong to that night.
  await P.query(`UPDATE outreach_queue SET created_at = '2026-10-20T08:30:00Z' WHERE athlete_id LIKE 'hp-%' AND athlete_id <> 'hp-a1'`);
  const c = await NC.forRunDate(P, '2026-10-26');
  ok('last night\'s cost: model calls in the window ($0.75) + Places (10 x $0.032)', Math.abs(c.ledgerUsd - 0.75) < 1e-6 && Math.abs(c.placesUsd - 0.32) < 1e-6 && Math.abs(c.usd - 1.07) < 1e-6, c);
  ok('  per verified email: $1.07 / 2 cards', c.verified === 2 && Math.abs(c.perVerified - 0.535) < 1e-6, c);

  // Left after the night: 500 at the start, 30 searches and 40 verifications spent (30 + 20 credits).
  const r500 = HP.renderMorning({ plan: HP.planFor(HP.parseAccount({ data: { reset_date: '2026-11-01', requests: { credits: { used: 1500, available: 2000 } } } }), { runDate: '2026-10-19' }),
    spent: { search: 30, verify: 40 }, cache_only: false }, '2026-10-19');
  ok('the line says what is left after the night (500 - 50 = 450) and what it used', /Hunter: 450 credits left, resets 2026-11-01, tonight's allowance 23 \(used 50 tonight/.test(r500.lines[0]) && !r500.warn, r500.lines);
  const r320 = HP.renderMorning({ plan: HP.planFor(HP.parseAccount({ data: { reset_date: '2026-11-01', requests: { credits: { used: 1680, available: 2000 } } } }), { runDate: '2026-10-19' }),
    spent: { search: 25, verify: 0 }, cache_only: false }, '2026-10-19');
  ok('  320 at the start, 25 spent: 295 left, and that is under 300', r320.warn && /HUNTER IS LOW: 295 credits left/.test(r320.lines.join('\n')), r320.lines);
  const report = await S5.collect(P, { now: Date.parse('2026-10-26T11:00:00Z') });
  const msg = S5.render(report);
  ok('the email goes every morning with the switch on', S5.needsEmail(report));
  ok('  "Hunter: X credits left, resets DATE, tonight\'s allowance Y"', /Hunter: 10 credits left, resets 2026-11-01, tonight's allowance 0/.test(msg.text), msg.text.slice(0, 600));
  ok('  a loud warning under 300', /!!! HUNTER IS LOW: 10 credits left, under 300/.test(msg.text) && /^HUNTER LOW\./.test(msg.subject), msg.subject);
  ok('  says the night ran in cache mode, and what it placed', /CACHE MODE last night/.test(msg.text) && /2 cards placed for 1 athlete from addresses already verified in the last 30 days/.test(msg.text), msg.text);
  ok('  last night\'s total cost and cost per verified email', /Last night's cost: \$1\.07/.test(msg.text) && /Cost per verified email: \$0\.54 \(2 email cards/.test(msg.text), msg.text);
  ok('  and the breakdown link (admin script spend-breakdown)', /spend-breakdown\?text=1&date=2026-10-26/.test(msg.text));
  off();
  const plain = await S5.collect(P, { now: Date.parse('2026-10-26T11:00:00Z') });
  ok('switch off: no Hunter line, no cost, as before', !plain.hunter && !plain.cost && !/Hunter:/.test(S5.render(plain).text));
}

// ── 7. ADMIN SCRIPT spend-breakdown ─────────────────────────────────────────
async function spendBreakdown() {
  console.log('\n7. ADMIN SCRIPT spend-breakdown');
  const AS = require(REPO + 'server/services/adminScripts');
  const reg = AS.discover({ strict: true });
  const desc = require(REPO + 'server/scripts/admin/spend-breakdown.js');
  ok('a descriptor of its own in server/scripts/admin', desc.name === 'spend-breakdown' && desc.file === 'scripts/spend-breakdown.js' && fs.existsSync(REPO + desc.file));
  ok('  registered with the admin script runner', !!reg['spend-breakdown'] && reg['spend-breakdown'].file === 'scripts/spend-breakdown.js', Object.keys(reg).length);
  ok('  ?date= passes the run date', JSON.stringify(desc.args({ date: '2026-10-26' })) === '["--date","2026-10-26"]');
  ok('  ?hours= is a bounded number', JSON.stringify(desc.args({ hours: '36' })) === '["--hours","36"]' && JSON.stringify(desc.args({ hours: '9999' })) === '["--hours","336"]');
  ok('  ?agent= cannot carry anything but an address', !/[;\s|&]/.test(desc.args({ agent: 'a@b.com; rm -rf /' })[1]));
  const r = cp.spawnSync(process.execPath, [REPO + 'scripts/spend-breakdown.js', '--date', '2026-10-26'], { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, INIT_WAIT_MS: '1500', NODE_PATH: REPO + 'node_modules' } });
  ok('  it runs against the database and totals the night', r.status === 0 && /TOTAL \(estimated from list prices\): \$0\.750/.test(r.stdout), (r.stdout || '').slice(0, 400) + (r.stderr || '').slice(0, 300));
}

(async () => {
  arithmetic();
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await require(REPO + 'server/services/verifyBudget').ensureTable(P).catch(() => {});
  await HP.ensureTable(P);
  for (const step of [theNight, chokePoints, runOutAlert, cacheNight, morningEmail, spendBreakdown]) {
    try { await step(P); } catch (e) { F++; console.log('  FAIL  ' + step.name + ' threw: ' + (e.stack || e.message).split('\n').slice(0, 5).join(' | ')); }
    HP._reset();
  }
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
