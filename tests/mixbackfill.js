'use strict';
// Runs against the local test Postgres. Real job, real Scout, real insert;
// the paid lookups (Places, the name search, Hunter, the writer) are stubbed.
//
//   node tests/mixbackfill.js
//
// ── AN EMPTY BRAND SEAT NEVER LEAVES THE ATHLETE SHORT (MARKET_MIX_ON) ─────
// When no social or national candidate passes the bar by the end of the
// athlete's pass, the seat is filled from the local lane, under the verified
// named-person email rule (never a DM, a call, a general inbox or an address
// that did not verify, whatever EMAIL_FIVE_ON says). The run row records each
// backfilled seat and why; the dry run and the 5:30 short-of-five email show
// it. MARKET_MIX_ON off: unchanged.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request) {
  const m = originalLoad.apply(this, arguments);
  if (request === '../services/placesLookup') {
    const place = (b) => ({ name: b, businessStatus: 'OPERATIONAL', website: null, phone: '(806) 555-1212', primaryType: 'restaurant' });
    return { ...m, lookupPlace: async (b) => place(b), lookupPlaceResult: async (b) => ({ ok: true, place: place(b) }) };
  }
  return m;
};
const store = require(REPO + 'server/store');
const ai = require(REPO + 'server/ai');
const PW = require(REPO + 'server/services/pitchWriter');
const EF = require(REPO + 'server/services/emailFinder');
const ONS = require(REPO + 'server/services/ownerNameSearch');
const { checkDomain } = require(REPO + 'server/services/domainGate');
const slug = (b) => String(b).toLowerCase().replace(/[^a-z0-9]/g, '');

const calls = { verify: [] };
ai.webSearchJson = async () => { throw new Error('the real web search must not be reached here'); };
ai.getDealRecommendations = async () => [];
ai.getBrandContacts = async (brand) => ({ contacts: [{ name: 'Dana Reed', title: 'Owner', phone: null, affiliationScope: 'this-location', confidence: 'high', source: 'chamber' }],
  businessPhone: '(806) 555-9999', cached: true, instagram: 'shop_' + slug(brand), instagramScope: 'this-location', website: `https://${slug(brand)}.com` });
const PEOPLE = {
  'Bf Giant Cola': ['Jamie Cole', 'Director of Sports Marketing'],
  'Bf Mid Fuel': ['Morgan Diaz', 'Head of Influencer Marketing'],
  'Bf Velocity Wear': ['Jordan Miles', 'Director of Athlete Partnerships'],
  'Bf Founder Snacks': ['Pat Lee', 'Founder & CEO'],
  'Bf Catchall Gear': ['Sam Fox', 'Partnerships Manager'],
};
ONS.findOwnerName = async ({ brand }) => {
  const p = PEOPLE[brand];
  return p ? { name: p[0], title: p[1], query: 'partnerships', sourceUrl: `https://${slug(brand)}.com/team` } : null;
};
PW.writePitch = async (ctx) => {
  const b = ctx.business || {};
  const ev = Array.isArray(b.evidence) ? b.evidence : [];
  return { message: `Hi ${b.greetFirstName || 'there'},\nA pitch for ${b.name}.\n\nJohn`, angle: 'fit', angleKey: 'fit', categoryKey: 'brand', ask: '2 posts',
    evidence: ev, evidenceUsed: ev.length ? 1 : 0 };
};
const VALID = new Set(), CATCHALL = new Set();
EF.liveDeps = () => ({
  verify: async (e) => {
    calls.verify.push(e);
    if (CATCHALL.has(e)) return { result: 'unknown', status: 'accept_all', source: 'hunter' };
    return VALID.has(e) ? { result: 'valid', status: 'valid', source: 'hunter' } : { result: 'invalid', status: 'invalid', source: 'hunter' };
  },
  peek: async () => new Map(), domainSearch: async () => null, hunterCached: async () => null,
  emailFinder: async (first, last, domain) => ({ email: `${first}.${last}@${domain}`.toLowerCase() }),
  resolveDomain: async (brand) => ({ website: brand === 'Bf Velocity Wear' ? 'https://bfvelocitywear.com' : null, tried: [] }), checkDomain, siteEmail: async () => null,
  placeLookup: async () => null, facebookPage: async () => null,
  corporate: (d, b, o) => EF.corporateDomain(d, b, o),
});

const job = require(REPO + 'server/jobs/outreachQueue');
const Q = require(REPO + 'server/services/outreachQueue');
const AR = require(REPO + 'server/services/athleteRecord');
const SR = require(REPO + 'server/services/schoolResolver');
const MR = require(REPO + 'server/services/dealMixReport');
const SOF = require(REPO + 'server/services/shortOfFive');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const AG = 'mbf-agent';
const WACO = 'waco, tx', LUB = 'lubbock, tx';

const SOCIAL_OK = [
  { brand: 'Bf Giant Cola', brand_size: 'national', website: 'https://bfgiantcola.com', proof_url: 'https://bfgiantcola.com/athletes', sports: ['all'], tier_min: 1000, tier_max: 500000 },
  { brand: 'Bf Mid Fuel', brand_size: null, website: 'https://bfmidfuel.com', proof_url: 'https://bfmidfuel.com', sports: ['all'], tier_min: 0, tier_max: 0, tier_stated: false },
];
const SOCIAL_BAD = [
  { brand: 'Bf Founder Snacks', brand_size: 'small', website: 'https://bffoundersnacks.com', proof_url: 'https://bffoundersnacks.com', sports: ['football'], tier_min: 1000, tier_max: 50000 },
  { brand: 'Bf Catchall Gear', brand_size: 'small', website: 'https://bfcatchallgear.com', proof_url: 'https://bfcatchallgear.com', sports: ['football'], tier_min: 1000, tier_max: 50000 },
];
let SOCIAL = SOCIAL_OK, NATIONAL = [];

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const brandNames = SOCIAL_OK.concat(SOCIAL_BAD).map((s) => s.brand).concat(['Bf Velocity Wear']);
  const clean = async () => {
    await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM research_claims WHERE athlete_id LIKE 'mbf-%'`).catch(() => {});
    await P.query(`DELETE FROM discovery_nightly WHERE athlete_id LIKE 'mbf-%'`).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM market_business_seen WHERE market_key = ANY($1::text[])`, [[WACO, LUB]]).catch(() => {});
    await P.query(`DELETE FROM social_brands WHERE brand = ANY($1::text[])`, [brandNames]).catch(() => {});
    await P.query(`DELETE FROM deal_comps WHERE brand = ANY($1::text[])`, [brandNames]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'John Agent','mbf@x.test','x','agent')`, [AG]);
  for (const s of SOCIAL_OK.concat(SOCIAL_BAD)) {
    await P.query(`INSERT INTO social_brands (brand, category, website, sports, tier_min, tier_max, deal_structure, proof_url, proof_date, tier_stated, brand_size, active)
                   VALUES ($1,'snacks',$2,$3,$4,$5,'affiliate',$6,CURRENT_DATE - 30,$7,$8,true)`,
    [s.brand, s.website, s.sports, s.tier_min, s.tier_max, s.proof_url, s.tier_stated !== false, s.brand_size]);
  }
  const deals = async (brand, n) => { for (let i = 0; i < n; i++) await P.query(`INSERT INTO deal_comps (brand, athlete_name, sport, school, followers, source) VALUES ($1,$2,'Football','Baylor University',100000,'https://www.on3.com/nil/bf')`, [brand, `${brand} Athlete ${i}`]); };
  await deals('Bf Velocity Wear', 25); await deals('Bf Mid Fuel', 5);
  // Waco: ten local businesses whose owner's address verifies.
  for (let i = 0; i < 10; i++) {
    await P.query(`INSERT INTO market_business_seen (market_key, brand, category) VALUES ($1,$2,'restaurant') ON CONFLICT DO NOTHING`, [WACO, `Bf Waco Cafe ${i}`]);
    VALID.add(`dana.reed@bfwacocafe${i}.com`);
  }
  // Lubbock: four whose address does NOT verify, drawn first (marketing
  // evidence ranks them up), then two that do.
  for (let i = 0; i < 4; i++) await P.query(`INSERT INTO market_business_seen (market_key, brand, category, has_evidence) VALUES ($1,$2,'restaurant',true) ON CONFLICT DO NOTHING`, [LUB, `Bf Nope Grill ${i}`]);
  for (let i = 0; i < 2; i++) {
    await P.query(`INSERT INTO market_business_seen (market_key, brand, category) VALUES ($1,$2,'restaurant') ON CONFLICT DO NOTHING`, [LUB, `Bf Good Grill ${i}`]);
    VALID.add(`dana.reed@bfgoodgrill${i}.com`);
  }
  CATCHALL.add('dana.reed@bfnopegrill3.com');
  VALID.add('morgan.diaz@bfmidfuel.com');

  store.getSocialBrandPool = async () => SOCIAL.map((s) => ({ ...s, lane: 'social' }));
  store.getTopNilComps = async () => NATIONAL.map((b) => ({ brand: b, count: 0, deals: [] }));

  const setFlags = (f) => { for (const k of ['EMAIL_FINDER_ON', 'EMAIL_FIVE_ON', 'MARKET_MIX_ON']) { if (f[k]) process.env[k] = '1'; else delete process.env[k]; } };
  const fill = async (id, tier, school, extra, dataExtra) => {
    const data = { name: 'Mbf ' + id, school, sport: 'Football', instagram: 150000, ...(dataExtra || {}) };
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [id, AG, JSON.stringify(data)]);
    const profile = AR.resolveAthlete({ id, data }, { schoolLocation: SR.resolveSchool });
    return job.fillAthlete(P, { agentId: AG, agentFirstName: 'John', athleteId: id, athleteName: data.name, budget: Q.newBudget(100),
      region: profile.market, athleteProfile: profile, athleteRow: data,
      marketScore: tier ? { tier, score: { local_star: 20, rising: 45, regional: 60, national: 85 }[tier], confidence: 0.7 } : undefined,
      onProgress: (m) => { if (process.env.MBF_DEBUG) console.log('  >> ' + m); }, ...(extra || {}) });
  };
  const cards = async (id) => (await P.query(`SELECT brand_name, lane, channel, email, email_verified, contact_name, backfill_for, market_tier
                                                FROM outreach_queue WHERE athlete_id=$1 AND state='queued' ORDER BY slot`, [id])).rows;
  const lanes = (cs) => cs.reduce((m, c) => { const l = c.lane === 'social' || c.lane === 'national' ? c.lane : 'local'; m[l] = (m[l] || 0) + 1; return m; }, {});

  // ── 1. NATIONAL TIER, ZERO QUALIFYING NATIONAL BRANDS ────────────────────
  OUT.push('-- National tier, zero qualifying national brands: still five --');
  setFlags({ EMAIL_FIVE_ON: 1, MARKET_MIX_ON: 1 });
  NATIONAL = ['Bf Velocity Wear', 'Nike'];          // Velocity's contact will not verify; Nike is an incumbent
  const r1 = await fill('mbf-nat', 'national', 'Baylor University');
  const c1 = await cards('mbf-nat');
  const l1 = lanes(c1);
  ok('five cards: two social and three local, no national', r1.filled === 5 && c1.length === 5 && l1.social === 2 && l1.local === 3 && !l1.national,
    { filled: r1.filled, lanes: l1, mix: r1.loop && r1.loop.mix, note: r1.note });
  const bf1 = c1.filter((c) => c.backfill_for === 'national');
  ok('  two of the local cards filled the national seats, and say so on the row', bf1.length === 2, c1.map((c) => [c.brand_name, c.backfill_for]));
  ok('  every backfilled card is a verified named person\'s email', bf1.every((c) => c.channel === 'email' && c.email_verified === true && c.contact_name === 'Dana Reed' && /^dana\.reed@/.test(c.email)), bf1);
  const m1 = (r1.loop && r1.loop.mix) || {};
  ok('the run row records each backfilled seat, the card that filled it, and why',
    Array.isArray(m1.backfilled) && m1.backfilled.length === 2 && m1.backfilled.every((b) => b.seat === 'national' && /^Bf Waco Cafe/.test(b.brand) && b.email && b.contact === 'Dana Reed')
    && m1.backfilled[0].why === 'no national brand passed the bar: 2 considered (1 household incumbent, 1 no verified address for the named contact)'
    && m1.backfillUnfilled === 0 && m1.short.length === 0 && m1.seats.national === 2, m1);
  const NAT_TRY = (r1.tried || []).filter((t) => t.brand === 'Bf Velocity Wear');
  ok('  the national brand was tried first, under the same bar as before', NAT_TRY.length === 1 && /no verified address for Jordan Miles/.test(NAT_TRY[0].reason), NAT_TRY);

  // No national candidate at all.
  NATIONAL = [];
  const r1b = await fill('mbf-nat0', 'national', 'Baylor University');
  const m1b = (r1b.loop && r1b.loop.mix) || {};
  ok('no national brand even on the slate: still five, and the why says there was no candidate',
    r1b.filled === 5 && m1b.backfilled.length === 2 && m1b.backfilled.every((b) => b.why === 'no national brand was a candidate for a National'), m1b);

  // ── 2. A SOCIAL SEAT, TOO ─────────────────────────────────────────────────
  OUT.push('', '-- Rising, no social brand passes: the social seats are backfilled --');
  SOCIAL = SOCIAL_BAD;
  const r2 = await fill('mbf-rising', 'rising', 'Baylor University', null, { instagram: 8000 });
  const c2 = await cards('mbf-rising');
  ok('five local cards, two of them in the social seats', r2.filled === 5 && c2.every((c) => c.lane === 'local') && c2.filter((c) => c.backfill_for === 'social').length === 2, c2);
  ok('  why: the founder is not a partnerships contact, the catch-all proves nothing',
    ((r2.loop.mix.backfilled || [])[0] || {}).why === 'no social brand passed the bar: 2 considered (1 contact not a partnerships or marketing lead, 1 no verified address for the named contact)',
    r2.loop.mix.backfilled);
  SOCIAL = SOCIAL_OK;

  // ── 3. NEVER AN UNVERIFIED ADDRESS ────────────────────────────────────────
  OUT.push('', '-- a backfill never places an unverified address, even with EMAIL_FIVE_ON off --');
  setFlags({ MARKET_MIX_ON: 1 });
  calls.verify.length = 0;
  const r3 = await fill('mbf-unv', 'national', 'Texas Tech University');
  const c3 = await cards('mbf-unv');
  const bf3 = c3.filter((c) => c.backfill_for);
  ok('the backfilled seats took only the two businesses whose owner\'s address verified',
    bf3.length === 2 && bf3.every((c) => /^Bf Good Grill/.test(c.brand_name) && c.channel === 'email' && c.email_verified === true), c3);
  const rej3 = (r3.tried || []).filter((t) => t.stage === 'backfill');
  ok('  the ones that did not verify were checked and dropped, each with the rule as its reason',
    rej3.length >= 3 && rej3.every((t) => /^Bf Nope Grill/.test(t.brand) && /takes only a verified named person's email/.test(t.reason)), rej3.map((t) => `${t.brand}: ${t.reason}`));
  ok('  a catch-all guess is not verified for this either', rej3.some((t) => t.brand === 'Bf Nope Grill 3') || !calls.verify.includes('dana.reed@bfnopegrill3.com'),
    rej3.map((t) => t.brand));
  ok('  no card anywhere carries an address that did not verify', !c3.some((c) => c.channel === 'email' && !c.email_verified), c3);
  ok('  the athlete\'s own local seat follows the night\'s rules as before (EMAIL_FIVE_ON off: a DM is allowed there)',
    c3.filter((c) => c.lane === 'local' && !c.backfill_for).length === 1, c3);
  // Not enough verified businesses: the seat stays empty rather than take one.
  for (const v of ['dana.reed@bfgoodgrill1.com']) VALID.delete(v);
  const r3b = await fill('mbf-unv2', 'national', 'Texas Tech University');
  const c3b = await cards('mbf-unv2');
  ok('one verified business left for two backfill seats: one filled, one left empty and said so, nothing unverified placed',
    c3b.filter((c) => c.backfill_for).length <= 1 && c3b.filter((c) => c.backfill_for).every((c) => c.email_verified)
    && r3b.loop.mix.backfillUnfilled >= 1 && r3b.loop.mix.short.some((x) => /^national .* \(backfill from local found nothing for it either\)$/.test(x)), { cards: c3b, mix: r3b.loop.mix });
  VALID.add('dana.reed@bfgoodgrill1.com');

  // ── 4. MARKET_MIX_ON OFF: UNCHANGED ───────────────────────────────────────
  OUT.push('', '-- MARKET_MIX_ON off: unchanged --');
  setFlags({ EMAIL_FIVE_ON: 1 });
  const r4 = await fill('mbf-off5', null, 'Baylor University');
  const c4 = await cards('mbf-off5');
  ok('EMAIL_FIVE_ON alone: five verified local emails, no mix, no backfill', r4.filled === 5 && c4.every((c) => c.lane === 'local' && c.email_verified && !c.backfill_for && !c.market_tier)
    && r4.loop.mix === undefined && !(r4.tried || []).some((t) => t.stage === 'backfill' || t.stage === 'mix-seat'), { cards: c4, mix: r4.loop && r4.loop.mix });
  setFlags({});
  const r4b = await fill('mbf-off', null, 'Texas Tech University');
  const c4b = await cards('mbf-off');
  ok('every switch off: five cards as before, DMs allowed, the unverified grills included, nothing backfilled',
    r4b.filled === 5 && c4b.some((c) => c.channel === 'dm') && c4b.some((c) => /^Bf Nope Grill/.test(c.brand_name)) && !c4b.some((c) => c.backfill_for)
    && r4b.loop.mix === undefined && !(r4b.tried || []).some((t) => t.stage === 'backfill'), c4b.map((c) => `${c.brand_name}:${c.channel}`));
  const J = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('  in the code: the backfill is only reachable under the mix', /if \(!added\.length && _mix && backfillMix\(\)\)/.test(J)
    && /function backfillMix\(\) \{\s*if \(!_mix \|\| _mix\.backfill\.done\) return false;/.test(J)
    && /let _mixBackfill = false;\s*if \(_mix && cand\.lane\) \{/.test(J));

  // ── 5. THE DRY RUN SHOWS IT ───────────────────────────────────────────────
  OUT.push('', '-- the market-mix-dryrun output --');
  setFlags({ EMAIL_FIVE_ON: 1, MARKET_MIX_ON: 1 });
  NATIONAL = ['Bf Velocity Wear'];
  // Giant Cola has had its two program applications tonight: its named
  // contact's verified address now, so the social seats fill.
  VALID.add('jamie.cole@bfgiantcola.com');
  const dry = [];
  const r5 = await fill('mbf-dry', 'national', 'Baylor University', { dryRun: true, keepStale: true, onCard: (c) => dry.push(c) });
  const txt = MR.formatAthlete({ name: 'Mbf Dry', score: { score: 85, tier: 'national', tierLabel: 'National', confidence: 0.7, reasons: [], missing: [] },
    cards: dry, result: r5, spend: { usd: 0, calls: 0, searches: 0 }, ms: 1000 });
  ok('five cards handed back, two in the national seats, none written', dry.length === 5 && dry.filter((c) => c.mixBackfill && c.mixBackfill.seat === 'national').length === 2
    && (await cards('mbf-dry')).length === 0, dry.map((c) => [c.brandName, c.mixBackfill]));
  ok('  the printout tags each backfilled card and lists each seat with why', (txt.match(/\[local, national seat\]/g) || []).length === 2
    && /Backfilled from the local lane \(2 seats\):/.test(txt) && /national seat -> Bf Waco Cafe \d, Dana Reed <dana\.reed@bfwacocafe\d\.com>, verified\. Why: no national brand passed the bar/.test(txt), txt);
  const tot = MR.formatTotals({ athletes: 1, cards: 5, byLane: { local: 3, social: 2, national: 0 }, seats: { local: 1, social: 2, national: 2 }, usd: 0, byTier: { National: 1 }, backfilled: 2, backfilledBy: { national: 2 } });
  ok('  and the totals count them', /Brand seats backfilled from the local lane: 2 \(2 national\)/.test(tot), tot);

  // ── 6. THE 5:30 SHORT-OF-FIVE EMAIL SHOWS IT ──────────────────────────────
  OUT.push('', '-- the 5:30am short-of-five email --');
  const OQ = require(REPO + 'server/jobs/outreachQueue');
  const day = OQ.today();
  const det = [r1, r2].map((r, i) => ({ athleteId: ['mbf-nat', 'mbf-rising'][i], athleteName: ['Mbf mbf-nat', 'Mbf mbf-rising'][i], filled: r.filled, loop: r.loop, tried: r.tried }));
  await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, filled, details, finished_at) VALUES ($1, $2, 10, $3, NOW())
                 ON CONFLICT (agent_id, run_date) DO UPDATE SET details = EXCLUDED.details, finished_at = NOW()`, [AG, day, JSON.stringify(det)]);
  const rep = await SOF.collect(P, {});
  const mine = rep.backfills.filter((b) => /^Mbf /.test(b.athlete));
  ok('collected: each backfilled seat, by athlete', mine.length === 4 && mine.filter((b) => b.seat === 'national').length === 2 && mine.filter((b) => b.seat === 'social').length === 2, mine);
  ok('  under MARKET_MIX_ON the official program card counts toward the five (the national athlete is not short)',
    !rep.short.some((s) => s.athleteId === 'mbf-nat'), rep.short.filter((s) => /^mbf-/.test(s.athleteId)));
  const msg = SOF.render({ ...rep, short: rep.short.filter((s) => /^mbf-/.test(s.athleteId)), backfills: mine });
  ok('  the email lists them, with the card that filled each seat and why', /SEATS BACKFILLED FROM THE LOCAL LANE \(MARKET_MIX_ON\): 4/.test(msg.text)
    && /Mbf mbf-nat: the national seat -> Bf Waco Cafe \d, Dana Reed <dana\.reed@bfwacocafe\d\.com> \(verified email\)\. Why: no national brand passed the bar/.test(msg.text)
    && /Mbf mbf-rising: the social seat -> /.test(msg.text) && /4 brand seats backfilled from local/.test(msg.subject), msg);
  let sent = null;
  await P.query(`DELETE FROM short_five_alerts WHERE alert_date = $1`, [day]).catch(() => {});
  const run = await SOF.runOnce(P, { force: true, send: async (m) => { sent = m; } });
  ok('  the email goes out with the backfilled seats in it', run.status === 'sent' && sent && /SEATS BACKFILLED FROM THE LOCAL LANE/.test(sent.text),
    { status: run.status, skipped: run.skipped });
  ok('  and a morning with nobody short but a seat backfilled still sends it; nothing at all stays quiet',
    SOF.needsEmail({ short: [], backfills: [mine[0]] }) === true && SOF.needsEmail({ short: [], backfills: [] }) === false && SOF.needsEmail({ short: [{}] }) === true);
  await P.query(`DELETE FROM short_five_alerts WHERE alert_date = $1`, [day]).catch(() => {});
  setFlags({ EMAIL_FIVE_ON: 1 });
  const rep2 = await SOF.collect(P, {});
  ok('  MARKET_MIX_ON off: the count is verified emails only, as before', rep2.mixOn === false
    && /under 5 verified emails|has 5 verified emails/.test(SOF.render({ ...rep2, backfills: [] }).subject));

  setFlags({});
  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass}/${pass + F} passed`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
