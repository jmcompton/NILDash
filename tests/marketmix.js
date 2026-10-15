'use strict';
// Runs against the local test Postgres. Real job, real Scout, real insert;
// the paid lookups (Places, the name search, Hunter, the writer) are stubbed.
//
//   node tests/marketmix.js
//
// ── THE DEAL MIX, END TO END (MARKET_MIX_ON) ───────────────────────────────
// With EMAIL_FIVE_ON on (tonight's production setting), the tier splits the
// five slots: Local Star 4 local + 1 small social; Rising 3 local + 2 social;
// National 1 local + 2 social + 2 national. A social or national card is an
// official application page or a named partnerships / marketing contact's
// verified address, and the pitch states a researched reason the athlete
// fits. Off: the redraw stays local only (localOnly: FINDER.five()).
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
    const place = (b) => ({ name: b, businessStatus: 'OPERATIONAL', website: null, phone: '(254) 555-1212', primaryType: 'restaurant' });
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

// ── THE STUBS ───────────────────────────────────────────────────────────────
const calls = { names: [], writer: [], social: 0, national: 0, verify: [] };
ai.webSearchJson = async () => { throw new Error('the real web search must not be reached here'); };
ai.getDealRecommendations = async () => [];
ai.getBrandContacts = async (brand) => ({ contacts: [{ name: 'Dana Reed', title: 'Owner', phone: null, affiliationScope: 'this-location', confidence: 'high', source: 'chamber' }],
  businessPhone: '(254) 555-9999', cached: true, instagram: 'shop_' + slug(brand), instagramScope: 'this-location', website: `https://${slug(brand)}.com` });
// The brand's named contact, by brand (ownerNameSearch, large mode).
const PEOPLE = {
  'Mx Glow Bars': ['Riley Stone', 'Influencer Marketing Manager'],
  'Mx Peak Hydrate': ['Casey Lane', 'Partnerships Manager'],
  'Mx Giant Cola': ['Jamie Cole', 'Director of Sports Marketing'],
  'Mx Founder Snacks': ['Pat Lee', 'Founder & CEO'],
  'Mx Catchall Gear': ['Sam Fox', 'Partnerships Manager'],
  'Mx Nofit Labs': ['Drew Hall', 'Marketing Manager'],
  'Mx Silent Co': ['Alex Kim', 'Marketing Director'],
  'Mx Mid Fuel': ['Morgan Diaz', 'Head of Influencer Marketing'],
  'Mx Velocity Wear': ['Jordan Miles', 'Director of Athlete Partnerships'],
  'Mx Stride Co': ['Taylor Brooks', 'Brand Partnerships Lead'],
};
ONS.findOwnerName = async ({ brand }) => {
  calls.names.push(brand);
  const p = PEOPLE[brand];
  return p ? { name: p[0], title: p[1], query: 'partnerships', sourceUrl: `https://${slug(brand)}.com/team` } : null;
};
// The writer, stubbed: it states the first fit line, except for a brand it
// writes filler for.
const NOFIT = new Set(['Mx Silent Co']);
PW.writePitch = async (ctx) => {
  const b = ctx.business || {};
  calls.writer.push(b.name);
  const ev = Array.isArray(b.evidence) ? b.evidence : [];
  return { message: `Hi ${b.greetFirstName || 'there'},\nA pitch for ${b.name}.\n\nJohn`, angle: 'fit', angleKey: 'fit', categoryKey: 'brand', ask: '2 posts',
    evidence: ev, evidenceUsed: ev.length && !NOFIT.has(b.name) ? 1 : 0 };
};
// Hunter, stubbed.
const VALID = new Set(), CATCHALL = new Set();
const SITES = { 'Mx Velocity Wear': 'https://mxvelocitywear.com' };
EF.liveDeps = () => ({
  verify: async (e) => {
    calls.verify.push(e);
    if (CATCHALL.has(e)) return { result: 'unknown', status: 'accept_all', source: 'hunter' };
    return VALID.has(e) ? { result: 'valid', status: 'valid', source: 'hunter' } : { result: 'invalid', status: 'invalid', source: 'hunter' };
  },
  peek: async () => new Map(), domainSearch: async () => null, hunterCached: async () => null,
  emailFinder: async (first, last, domain) => ({ email: `${first}.${last}@${domain}`.toLowerCase() }),
  resolveDomain: async (brand) => ({ website: SITES[brand] || null, tried: [] }), checkDomain, siteEmail: async () => null,
  placeLookup: async () => null, facebookPage: async () => null,
  corporate: (d, b, o) => EF.corporateDomain(d, b, o),
});

const job = require(REPO + 'server/jobs/outreachQueue');
const Q = require(REPO + 'server/services/outreachQueue');
const AR = require(REPO + 'server/services/athleteRecord');
const SR = require(REPO + 'server/services/schoolResolver');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const AG = 'mxm-agent';
const KEY = 'waco, tx';

// The social index rows (the slate reads them through the store), in the
// order the index returns them.
const SOCIAL = [
  { brand: 'Mx Giant Cola', brand_size: 'national', website: 'https://mxgiantcola.com', proof_url: 'https://mxgiantcola.com/athletes', sports: ['all'], tier_min: 1000, tier_max: 500000 },
  { brand: 'Mx Nofit Labs', brand_size: 'small', website: 'https://mxnofitlabs.com', proof_url: 'https://mxnofitlabs.com', sports: ['all'], tier_min: 0, tier_max: 0, tier_stated: false },
  { brand: 'Mx Founder Snacks', brand_size: 'small', website: 'https://mxfoundersnacks.com', proof_url: 'https://mxfoundersnacks.com', sports: ['football'], tier_min: 1000, tier_max: 50000 },
  { brand: 'Mx Catchall Gear', brand_size: 'small', website: 'https://mxcatchallgear.com', proof_url: 'https://mxcatchallgear.com', sports: ['football'], tier_min: 1000, tier_max: 50000 },
  { brand: 'Mx Silent Co', brand_size: 'small', website: 'https://mxsilentco.com', proof_url: 'https://mxsilentco.com', sports: ['football'], tier_min: 1000, tier_max: 50000 },
  { brand: 'Mx Glow Bars', brand_size: 'small', website: 'https://mxglowbars.com', proof_url: 'https://mxglowbars.com/pages/athlete-ambassadors', sports: ['football'], tier_min: 1000, tier_max: 50000 },
  { brand: 'Mx Peak Hydrate', brand_size: 'small', website: 'https://mxpeakhydrate.com', proof_url: 'https://mxpeakhydrate.com', sports: ['football'], tier_min: 1000, tier_max: 50000 },
  { brand: 'Mx Mid Fuel', brand_size: null, website: 'https://mxmidfuel.com', proof_url: 'https://mxmidfuel.com', sports: ['all'], tier_min: 0, tier_max: 0, tier_stated: false },
];
const NATIONAL = ['Mx Velocity Wear', 'Mx Stride Co', 'Nike'];

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const brandNames = SOCIAL.map((s) => s.brand).concat(NATIONAL.filter((b) => b !== 'Nike'));
  const clean = async () => {
    await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM research_claims WHERE athlete_id LIKE 'mxm-%'`).catch(() => {});
    await P.query(`DELETE FROM discovery_nightly WHERE athlete_id LIKE 'mxm-%'`).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athlete_market_scores WHERE athlete_id LIKE 'mxm-%'`).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [KEY]).catch(() => {});
    await P.query(`DELETE FROM social_brands WHERE brand = ANY($1::text[])`, [brandNames]).catch(() => {});
    await P.query(`DELETE FROM deal_comps WHERE brand = ANY($1::text[])`, [brandNames]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'John Agent','mxm@x.test','x','agent')`, [AG]);
  // The index rows, for the signing evidence and the fit research.
  for (const s of SOCIAL) {
    await P.query(`INSERT INTO social_brands (brand, category, website, sports, tier_min, tier_max, deal_structure, proof_url, proof_date, tier_stated, brand_size, active)
                   VALUES ($1,'snacks',$2,$3,$4,$5,'affiliate',$6,CURRENT_DATE - 30,$7,$8,true)`,
    [s.brand, s.website, s.sports, s.tier_min, s.tier_max, s.proof_url, s.tier_stated !== false, s.brand_size]);
  }
  await P.query(`INSERT INTO social_brands (brand, category, website, sports, tier_min, tier_max, deal_structure, proof_url, proof_date, tier_stated, brand_size, active)
                 VALUES ('Mx Stride Co','apparel','https://mxstrideco.com',ARRAY['all'],1000,500000,'cash','https://mxstrideco.com/pages/ambassador-program',CURRENT_DATE - 20,true,NULL,true)`);
  // Logged deals: Velocity 25 (national size), Stride 8 and Mid Fuel 5 (mid).
  const deals = async (brand, n) => { for (let i = 0; i < n; i++) await P.query(`INSERT INTO deal_comps (brand, athlete_name, sport, school, followers, source) VALUES ($1,$2,'Football','Baylor University',100000,'https://www.on3.com/nil/mx')`, [brand, `${brand} Athlete ${i}`]); };
  await deals('Mx Velocity Wear', 25); await deals('Mx Stride Co', 8); await deals('Mx Mid Fuel', 5);
  // The local pool, and who verifies.
  for (let i = 0; i < 10; i++) {
    await P.query(`INSERT INTO market_business_seen (market_key, brand, category) VALUES ($1,$2,'restaurant') ON CONFLICT DO NOTHING`, [KEY, `Mx Waco Cafe ${i}`]);
    VALID.add(`dana.reed@mxwacocafe${i}.com`);
  }
  await P.query(`INSERT INTO market_business_seen (market_key, brand, category) VALUES ($1,'Chick-fil-A','restaurant') ON CONFLICT DO NOTHING`, [KEY]);
  for (const v of ['casey.lane@mxpeakhydrate.com', 'alex.kim@mxsilentco.com', 'morgan.diaz@mxmidfuel.com', 'jordan.miles@mxvelocitywear.com', 'taylor.brooks@mxstrideco.com', 'pat.lee@mxfoundersnacks.com']) VALID.add(v);
  CATCHALL.add('sam.fox@mxcatchallgear.com');

  store.getSocialBrandPool = async () => { calls.social++; return SOCIAL.map((s) => ({ ...s, lane: 'social' })); };
  store.getTopNilComps = async () => { calls.national++; return NATIONAL.map((b) => ({ brand: b, count: 0, deals: [] })); };

  const setFlags = (f) => { for (const k of ['EMAIL_FINDER_ON', 'EMAIL_FIVE_ON', 'MARKET_MIX_ON']) { if (f[k]) process.env[k] = '1'; else delete process.env[k]; } };
  const fill = async (id, tier, extra, dataExtra) => {
    const data = { name: 'Mxm ' + id, school: 'Baylor University', sport: 'Football', ...(dataExtra || {}) };
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [id, AG, JSON.stringify(data)]);
    const profile = AR.resolveAthlete({ id, data }, { schoolLocation: SR.resolveSchool });
    return job.fillAthlete(P, { agentId: AG, agentFirstName: 'John', athleteId: id, athleteName: data.name, budget: Q.newBudget(100),
      region: profile.market, athleteProfile: profile, athleteRow: data,
      marketScore: tier ? { tier, score: { local_star: 20, rising: 45, regional: 60, national: 85 }[tier], confidence: 0.7 } : undefined,
      onProgress: (m) => { if (process.env.MXM_DEBUG) console.log('  >> ' + m); }, ...(extra || {}) });
  };
  const cards = async (id) => (await P.query(`SELECT brand_name, lane, channel, email, email_verified, program_url, contact_name, contact_title, market_tier, brand_size, fit_reasons, why
                                                FROM outreach_queue WHERE athlete_id=$1 AND state='queued' ORDER BY slot`, [id])).rows;
  const byLane = (cs) => cs.reduce((m, c) => { const l = c.lane === 'social' || c.lane === 'national' ? c.lane : 'local'; m[l] = (m[l] || 0) + 1; return m; }, {});
  const reasonFor = (r, brand) => ((r.tried || []).find((t) => t.brand === brand && t.result !== 'queued') || {}).reason || null;

  // ── 1. OFF: TONIGHT AS BEFORE ─────────────────────────────────────────────
  OUT.push('-- MARKET_MIX_ON off, EMAIL_FIVE_ON on: local only, as before --');
  setFlags({ EMAIL_FIVE_ON: 1 });
  calls.social = 0; calls.national = 0;
  const r0 = await fill('mxm-off');
  const c0 = await cards('mxm-off');
  ok('five verified local emails, the social and national pools never drawn', r0.filled === 5 && c0.every((c) => c.lane === 'local' && c.email_verified)
    && calls.social === 0 && calls.national === 0, { filled: r0.filled, lanes: c0.map((c) => c.lane), social: calls.social, national: calls.national });
  ok('  no mix fields on the cards and none on the run row', c0.every((c) => c.market_tier === null && c.fit_reasons === null) && r0.loop && r0.loop.mix === undefined);

  // ── 2. RISING: 3 LOCAL, 2 SOCIAL ──────────────────────────────────────────
  OUT.push('', '-- MARKET_MIX_ON, Rising: 3 local + 2 social (small to mid) --');
  setFlags({ EMAIL_FIVE_ON: 1, MARKET_MIX_ON: 1 });
  calls.names.length = 0; calls.writer.length = 0; calls.national = 0;
  const r1 = await fill('mxm-rising', 'rising', null, { instagram: 8000 });
  const c1 = await cards('mxm-rising');
  const l1 = byLane(c1);
  ok('five cards: three local, two social, no national', r1.filled === 5 && l1.local === 3 && l1.social === 2 && !l1.national, { filled: r1.filled, lanes: l1, note: r1.note, mix: r1.loop && r1.loop.mix });
  ok('  the national pool is never drawn for a Rising athlete', calls.national === 0);
  const glow = c1.find((c) => c.brand_name === 'Mx Glow Bars');
  ok('an official ambassador page on the brand\'s own domain: a program card', glow && glow.channel === 'program' && glow.program_url === 'https://mxglowbars.com/pages/athlete-ambassadors', glow);
  const peak = c1.find((c) => c.brand_name === 'Mx Peak Hydrate');
  ok('no official page (its index page is the home page): the named partnerships contact\'s verified address', peak && peak.channel === 'email' && peak.email === 'casey.lane@mxpeakhydrate.com'
    && peak.email_verified === true && peak.contact_name === 'Casey Lane' && peak.contact_title === 'Partnerships Manager', peak);
  ok('the national-size brand is refused for a Rising athlete before anything is spent', !calls.names.includes('Mx Giant Cola') && !c1.some((c) => c.brand_name === 'Mx Giant Cola'), calls.names);
  ok('a brand with no researched reason the athlete fits is refused before any search or writing',
    !calls.names.includes('Mx Nofit Labs') && !calls.writer.includes('Mx Nofit Labs') && /no researched reason this athlete fits Mx Nofit Labs/.test(reasonFor(r1, 'Mx Nofit Labs') || ''), reasonFor(r1, 'Mx Nofit Labs'));
  ok('a founder / CEO is not a partnerships contact: refused, no address looked for', /Founder & CEO.*not a partnerships, influencer or marketing contact/.test(reasonFor(r1, 'Mx Founder Snacks') || '')
    && !calls.verify.some((e) => /mxfoundersnacks/.test(e)), reasonFor(r1, 'Mx Founder Snacks'));
  ok('a catch-all domain proves nothing: no guessed address', /no verified address for Sam Fox/.test(reasonFor(r1, 'Mx Catchall Gear') || '') && !c1.some((c) => c.brand_name === 'Mx Catchall Gear'), reasonFor(r1, 'Mx Catchall Gear'));
  ok('a pitch that says nothing about why the athlete fits the brand is refused (no filler)', /does not say why this athlete fits/.test(reasonFor(r1, 'Mx Silent Co') || ''), reasonFor(r1, 'Mx Silent Co'));
  ok('every brand card says why the athlete fits, from research, and records its tier and size',
    [glow, peak].every((c) => c && /^Why they fit: /.test(c.why) && Array.isArray(c.fit_reasons) && c.fit_reasons.some((x) => /^(Audience|Past campaign|Sport|Region):/.test(x))
      && c.market_tier === 'rising' && c.brand_size === 'small'), [glow, peak]);
  ok('  local cards carry their fit too (the town)', c1.filter((c) => c.lane === 'local').every((c) => Array.isArray(c.fit_reasons) && /^Region: in /.test(c.fit_reasons[0]) && c.market_tier === 'rising'), c1.filter((c) => c.lane === 'local'));
  ok('no DM and no call card anywhere', !c1.some((c) => c.channel === 'dm' || c.channel === 'call'), c1.map((c) => c.channel));
  ok('the run row carries the mix', r1.loop && r1.loop.mix && r1.loop.mix.tier === 'rising' && r1.loop.mix.placed.local === 3 && r1.loop.mix.placed.social === 2 && r1.loop.mix.short.length === 0, r1.loop && r1.loop.mix);

  // ── 3. LOCAL STAR: 4 LOCAL, 1 SMALL SOCIAL ────────────────────────────────
  OUT.push('', '-- Local Star: 4 local + 1 small social brand, never a national brand --');
  calls.names.length = 0; calls.national = 0;
  const r2 = await fill('mxm-star', 'local_star', null, { instagram: 8000 });
  const c2 = await cards('mxm-star');
  const l2 = byLane(c2);
  ok('four local and one social', r2.filled === 5 && l2.local === 4 && l2.social === 1 && !l2.national, { lanes: l2, mix: r2.loop && r2.loop.mix });
  ok('  the social one is a small brand', c2.filter((c) => c.lane === 'social').every((c) => c.brand_size === 'small'), c2.filter((c) => c.lane === 'social'));
  ok('  no national brand anywhere: not the national-size social brand, not the chain in the local pool',
    !c2.some((c) => c.brand_name === 'Mx Giant Cola' || c.brand_name === 'Chick-fil-A') && !calls.names.includes('Mx Giant Cola') && calls.national === 0, c2.map((c) => c.brand_name));

  // ── 4. NATIONAL: 1 LOCAL, 2 SOCIAL, 2 NATIONAL ────────────────────────────
  OUT.push('', '-- National: 1 local + 2 social + 2 national, mid to national brands --');
  calls.names.length = 0; calls.verify.length = 0;
  const r3 = await fill('mxm-national', 'national', null, { instagram: 150000, engagement: 4 });
  const c3 = await cards('mxm-national');
  const l3 = byLane(c3);
  ok('one local, two social, two national', r3.filled === 5 && l3.local === 1 && l3.social === 2 && l3.national === 2, { lanes: l3, mix: r3.loop && r3.loop.mix, cards: c3.map((c) => `${c.lane}:${c.brand_name}:${c.channel}`) });
  ok('  small social brands are not pitched to a National athlete', !c3.some((c) => ['Mx Glow Bars', 'Mx Peak Hydrate'].includes(c.brand_name)), c3.map((c) => c.brand_name));
  const cola = c3.find((c) => c.brand_name === 'Mx Giant Cola');
  ok('  the national-size social brand by its official athlete page', cola && cola.channel === 'program' && cola.brand_size === 'national', cola);
  const vel = c3.find((c) => c.brand_name === 'Mx Velocity Wear');
  ok('  a national brand with no website on file: its domain found and confirmed, its partnerships lead\'s address verified',
    vel && vel.channel === 'email' && vel.email === 'jordan.miles@mxvelocitywear.com' && vel.email_verified && vel.brand_size === 'national', vel);
  const stride = c3.find((c) => c.brand_name === 'Mx Stride Co');
  ok('  a second official page when the athlete\'s one program slot is taken: the named contact\'s verified email instead',
    stride && stride.channel === 'email' && stride.email === 'taylor.brooks@mxstrideco.com' && stride.brand_size === 'mid', stride);
  ok('  Nike is never pitched', !c3.some((c) => /nike/i.test(c.brand_name)) && !calls.names.includes('Nike'));
  ok('  the national cards say why the athlete fits: a past campaign', [vel, stride].every((c) => c && c.fit_reasons.some((x) => /^Past campaign: signed/.test(x))), [vel && vel.fit_reasons, stride && stride.fit_reasons]);

  // ── 5. A LANE THAT CANNOT FILL STAYS EMPTY ────────────────────────────────
  OUT.push('', '-- a lane nobody passes the bar for is not backfilled --');
  // Neither national contact's address verifies tonight, and Stride's index
  // page is its home page (no official application page).
  for (const e of ['jordan.miles@mxvelocitywear.com', 'taylor.brooks@mxstrideco.com']) VALID.delete(e);
  await P.query(`UPDATE social_brands SET proof_url = 'https://mxstrideco.com' WHERE brand = 'Mx Stride Co'`);
  const r4 = await fill('mxm-short', 'regional', null, { instagram: 150000 });
  const c4 = await cards('mxm-short');
  const l4 = byLane(c4);
  ok('Regional with no verified national contact: 2 local + 2 social, the national seat left empty and said so, not backfilled from local',
    l4.local === 2 && l4.social === 2 && !l4.national && r4.loop && r4.loop.mix && r4.loop.mix.short.includes('national 0 of 1'), { lanes: l4, mix: r4.loop && r4.loop.mix });
  ok('  each national brand turned down with its reason', /no verified address for Jordan Miles/.test(reasonFor(r4, 'Mx Velocity Wear') || '') && /no verified address for Taylor Brooks/.test(reasonFor(r4, 'Mx Stride Co') || ''),
    [reasonFor(r4, 'Mx Velocity Wear'), reasonFor(r4, 'Mx Stride Co')]);
  for (const e of ['jordan.miles@mxvelocitywear.com', 'taylor.brooks@mxstrideco.com']) VALID.add(e);
  await P.query(`UPDATE social_brands SET proof_url = 'https://mxstrideco.com/pages/ambassador-program' WHERE brand = 'Mx Stride Co'`);

  // ── 6. HELD CARDS COUNT AGAINST THEIR LANE ────────────────────────────────
  OUT.push('', '-- held cards count against their lane --');
  const r5 = await fill('mxm-rising', 'rising', null, { instagram: 8000 });
  ok('a Rising athlete holding 3 local + 2 social verified cards gets nothing new', r5.filled === 0 && /slots already hold/.test(r5.note || ''), { filled: r5.filled, note: r5.note });

  // ── 7. THE DRY RUN PLACES NOTHING ─────────────────────────────────────────
  OUT.push('', '-- dry: the cards it would place, nothing placed --');
  // Glow Bars has had its two program applications from this roster tonight
  // (Q.PROGRAM_BRAND_NIGHTLY_MAX): its named contact's verified address now.
  VALID.add('riley.stone@mxglowbars.com');
  const dryCards = [];
  const r6 = await fill('mxm-dry', 'rising', { dryRun: true, keepStale: true, onCard: (c) => dryCards.push(c) }, { instagram: 8000 });
  const c6 = await cards('mxm-dry');
  ok('five cards handed back in the rising mix, none written', r6.filled === 5 && dryCards.length === 5 && c6.length === 0
    && dryCards.filter((c) => c.lane === 'social').length === 2, { filled: r6.filled, dry: dryCards.map((c) => `${c.lane}:${c.brandName}:${c.channel}`), written: c6.length });
  const glowDry = dryCards.find((c) => c.brandName === 'Mx Glow Bars');
  ok('  a brand past its nightly program applications goes to its named contact\'s verified address instead',
    glowDry && glowDry.channel === 'email' && glowDry.email === 'riley.stone@mxglowbars.com' && glowDry.emailVerified === true, glowDry && { channel: glowDry.channel, email: glowDry.email });
  ok('  each with its tier, size and fit reasons', dryCards.every((c) => c.mixTier === 'rising' && c.brandSize && Array.isArray(c.fitReasons) && c.fitReasons.length), dryCards.map((c) => [c.mixTier, c.brandSize, c.fitReasons]));
  const drafts = (await P.query(`SELECT COUNT(*)::int n FROM outreach_logs WHERE athlete_id = 'mxm-dry'`)).rows[0].n;
  ok('  and no draft', drafts === 0);

  // ── 8. THE WIRING ─────────────────────────────────────────────────────────
  OUT.push('', '-- the wiring --');
  const J = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('off: the slate and the redraw stay local only under EMAIL_FIVE_ON', (J.match(/localOnly: FINDER\.five\(\) && !_mix/g) || []).length === 2);
  ok('  and the social and national rungs are still skipped under FIVE when the mix is off', /else if \(FINDER\.five\(\) && \(name === 'social' \|\| name === 'national'\)\) \{ rung\+\+; continue; \}/.test(J));
  ok('the writer is not touched: the mix hands it facts, the writer model and file are as they were',
    !/MARKET_MIX|dealMix|fitReasons/.test(fs.readFileSync(REPO + 'server/services/pitchWriter.js', 'utf8')) && /ai\.oneShot\(p2, sys, mt, ai\.MODEL_GEN, \{ prose: true \}\)/.test(J));
  ok('the columns a mix card records exist at boot', /ADD COLUMN IF NOT EXISTS market_tier TEXT/.test(fs.readFileSync(REPO + 'server/store.js', 'utf8'))
    && /ADD COLUMN IF NOT EXISTS fit_reasons JSONB/.test(fs.readFileSync(REPO + 'server/store.js', 'utf8')));

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
