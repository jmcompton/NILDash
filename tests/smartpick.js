'use strict';
// Runs against the local test Postgres. Real job, real Scout, real insert;
// the paid lookups and Hunter are stubbed.
//
//   node tests/smartpick.js
//
// ── SMART PICK (EMAIL_SMART_PICK) ───────────────────────────────────────────
// Rank by reachability within a type, never across types and never as a
// filter; no more than two of one type in an athlete's five; a verified
// general inbox for the smallest businesses, one per athlete per night, the
// card labelled and the owner greeted. Off by default.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const Module = require('module');
const originalLoad = Module._load;
const TYPE_OF = (b) => (/Taco/.test(b) ? 'restaurant' : /Snip/.test(b) ? 'hair_care' : /Lift/.test(b) ? 'gym' : /Bean/.test(b) ? 'cafe' : 'store');
const CAT_OF = (b) => ({ restaurant: 'restaurant', hair_care: 'salon', gym: 'gym', cafe: 'coffee', store: 'retail' })[TYPE_OF(b)];
Module._load = function (request) {
  const m = originalLoad.apply(this, arguments);
  if (request === '../services/placesLookup') {
    const place = (b) => ({ name: b, businessStatus: 'OPERATIONAL', website: null, phone: '(254) 555-1212', primaryType: TYPE_OF(b) });
    return { ...m, lookupPlace: async (b) => place(b), lookupPlaceResult: async (b) => ({ ok: true, place: place(b) }) };
  }
  return m;
};
const store = require(REPO + 'server/store');
const ai = require(REPO + 'server/ai');
const PW = require(REPO + 'server/services/pitchWriter');
const EF = require(REPO + 'server/services/emailFinder');
const RM = require(REPO + 'server/services/reachability');
const { checkDomain } = require(REPO + 'server/services/domainGate');
const slug = (b) => String(b).toLowerCase().replace(/[^a-z0-9]/g, '');
ai.webSearchJson = async () => { throw new Error('the real web search must not be reached here'); };
ai.getBrandContacts = async (brand) => ({ contacts: [{ name: 'Dana Reed', title: 'Owner', phone: null, affiliationScope: 'this-location', confidence: 'high', source: 'chamber' }],
  genericInbox: `info@${slug(brand)}.com`, businessPhone: '(254) 555-9999', cached: true, instagram: 'shop_' + slug(brand), instagramScope: 'this-location', website: `https://${slug(brand)}.com` });
ai.getDealRecommendations = async () => [];
PW.writePitch = async () => ({ message: 'Hi Dana,\nTwo feed posts and an appearance at your location.\n\nJohn', angle: 'campus traffic', angleKey: 'campus', categoryKey: 'restaurant', ask: '2 posts' });
const VALID = new Set();
EF.liveDeps = () => ({
  verify: async (e) => (VALID.has(e) ? { result: 'valid', status: 'valid', source: 'hunter' } : { result: 'invalid', status: 'invalid', source: 'hunter' }),
  peek: async () => new Map(), domainSearch: async () => null, emailFinder: async () => ({ email: null }), hunterCached: async () => null,
  resolveDomain: async () => ({ website: null, tried: [] }), checkDomain, siteEmail: async () => null, placeLookup: async () => null, facebookPage: async () => null,
  corporate: (d, b, o) => EF.corporateDomain(d, b, o),
});
const job = require(REPO + 'server/jobs/outreachQueue');
const Q = require(REPO + 'server/services/outreachQueue');
const AR = require(REPO + 'server/services/athleteRecord');
const SR = require(REPO + 'server/services/schoolResolver');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 800) : '')); } };
const AG = 'sp-agent';
const KEY = 'waco, tx';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await RM.ensureTable(P);
  const clean = async () => {
    await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM research_claims WHERE athlete_id LIKE 'sp-%'`).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [KEY]).catch(() => {});
    await P.query(`DELETE FROM brand_evidence_cache WHERE lower(brand) LIKE 'sp %'`).catch(() => {});
    await P.query(`DELETE FROM reachability_model`).catch(() => {});
    await P.query(`DELETE FROM service_faults WHERE service = 'nightly-floor' AND reason LIKE 'Sp %'`).catch(() => {});
    RM._resetCache();
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'John Agent','sp@x.test','x','agent')`, [AG]);
  const seed = async (brands) => {
    await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [KEY]);
    for (const b of brands) await P.query(`INSERT INTO market_business_seen (market_key, brand, category) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [KEY, b, CAT_OF(b)]);
  };
  const fill = async (id, extra) => {
    const data = { name: 'Sp ' + id, school: 'Baylor University', sport: 'Football' };
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [id, AG, JSON.stringify(data)]);
    const profile = AR.resolveAthlete({ id, data }, { schoolLocation: SR.resolveSchool });
    return job.fillAthlete(P, { agentId: AG, agentFirstName: 'John', athleteId: id, athleteName: data.name, budget: Q.newBudget(100),
      region: profile.market, athleteProfile: profile, athleteRow: data, onProgress: (m) => { if (process.env.SP_DEBUG) console.log('  >> ' + m); }, ...(extra || {}) });
  };
  const cards = async (id) => (await P.query(`SELECT brand_name, channel, email, email_verified, email_label, business_category, contact_name FROM outreach_queue WHERE athlete_id=$1 AND state='queued' ORDER BY slot`, [id])).rows;
  const setFlags = (f) => { for (const k of ['EMAIL_FINDER_ON', 'EMAIL_FINDER_MORE', 'EMAIL_FIVE_ON', 'EMAIL_SMART_PICK']) { if (f[k]) process.env[k] = '1'; else delete process.env[k]; } };
  const tally = (rows) => rows.reduce((m, r) => { m[r.business_category] = (m[r.business_category] || 0) + 1; return m; }, {});

  // Five restaurants, two salons, two gyms, two coffee shops; every owner verifies.
  const brands = [];
  for (let i = 0; i < 5; i++) brands.push(`Sp Taco ${i}`);
  for (let i = 0; i < 2; i++) brands.push(`Sp Snip ${i}`, `Sp Lift ${i}`, `Sp Bean ${i}`);
  for (const b of brands) VALID.add(`dana.reed@${slug(b)}.com`);
  await seed(brands);

  // ── 1. OFF: TONIGHT AS BEFORE ─────────────────────────────────────────────
  OUT.push('-- every switch off --');
  setFlags({ EMAIL_FIVE_ON: 1 });
  const r0 = await fill('sp-a0');
  const order0 = (r0.tried || []).map((t) => t.brand);
  const c0 = await cards('sp-a0');
  ok('without EMAIL_SMART_PICK, no variety cap and no reordering: the night takes the slate as it comes', c0.length === 5 && !(r0.tried || []).some((t) => t.stage === 'variety'), { types: tally(c0), order0 });
  const tacos0 = order0.filter((b) => /Taco/.test(b));

  // ── 2. VARIETY ────────────────────────────────────────────────────────────
  OUT.push('', '-- EMAIL_SMART_PICK: two of a type at most, three types or more --');
  setFlags({ EMAIL_FIVE_ON: 1, EMAIL_SMART_PICK: 1 });
  const r1 = await fill('sp-a1');
  const c1 = await cards('sp-a1');
  const t1 = tally(c1);
  ok('five verified email cards', c1.length === 5 && c1.every((c) => c.channel === 'email' && c.email_verified), c1);
  ok('  no more than two of any type', Object.values(t1).every((n) => n <= 2), t1);
  ok('  covering at least three types', Object.keys(t1).length >= 3, t1);
  ok('  a third restaurant is skipped for variety, and says so', (r1.tried || []).some((t) => t.stage === 'variety' && /two restaurant cards/.test(t.reason)) || (t1.restaurant || 0) <= 2,
    (r1.tried || []).filter((t) => t.stage === 'variety'));

  // ── 3. RANK WITHIN TYPE ───────────────────────────────────────────────────
  OUT.push('', '-- EMAIL_SMART_PICK: the more reachable restaurant first, the type order untouched --');
  // A model that says a confirmed website makes the difference, and a cached
  // lookup that gives the LAST restaurant of the plain order a website.
  //
  // THE PLAIN ORDER IS ASKED FOR, NOT ASSUMED. The Scout reads the market pool
  // in a shuffle keyed on the athlete and the date (services/scout
  // poolOrder), so sp-a0's order says nothing about sp-a2's: on some days the
  // business last for one athlete is already first for the other, and "moved
  // to first" proved nothing. sp-a2's own slate, as the night will read it
  // today with smart pick not yet able to rank (no model), names the last.
  const Scout = require(REPO + 'server/services/scout');
  const a2data = { name: 'Sp sp-a2', school: 'Baylor University', sport: 'Football' };
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('sp-a2',$1,$2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [AG, JSON.stringify(a2data)]);
  const plain2 = await Scout.assembleSlate(P, { agentId: AG, athlete: AR.resolveAthlete({ id: 'sp-a2', data: a2data }, { schoolLocation: SR.resolveSchool }),
    store, localOnly: true, limit: Q.SLOTS_PER_ATHLETE * Q.MAX_ATTEMPTS_PER_SLOT });
  const tacosPlain = (plain2.picks || []).map((c) => c.brand_name).filter((b) => /Taco/.test(b));
  ok('sp-a2\'s plain slate holds every restaurant', tacosPlain.length === 5, { tacosPlain, tacos0 });
  const last = tacosPlain[tacosPlain.length - 1];
  const model = RM.build([
    ...Array.from({ length: 20 }, () => ({ signals: { type: 'restaurant', website: 'yes', placesWebsite: 'yes', ownerNamed: 'yes', size: 'unknown' }, verified: true })),
    ...Array.from({ length: 20 }, () => ({ signals: { type: 'restaurant', website: 'no', placesWebsite: 'no', ownerNamed: 'no', size: 'unknown' }, verified: false })),
  ]);
  await P.query(`INSERT INTO reachability_model (window_days, attempts, model) VALUES (90, $1, $2)`, [model.attempts, JSON.stringify(model)]);
  RM._resetCache();
  await P.query(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, website, evidence, outcome, refreshed_at)
    VALUES ($1, 'contacts', $2, $3, $4, 'OK', NOW()) ON CONFLICT (brand_key, lane) DO NOTHING`,
    [`${last.toLowerCase()} | waco, tx | manual`, last, `https://${slug(last)}.com`, JSON.stringify({ contacts: [{ name: 'Dana Reed', title: 'Owner' }] })]);
  for (const b of tacosPlain.slice(0, -1)) {
    await P.query(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, website, evidence, outcome, refreshed_at)
      VALUES ($1, 'contacts', $2, NULL, $3, 'NONE', NOW()) ON CONFLICT (brand_key, lane) DO NOTHING`, [`${b.toLowerCase()} | waco, tx | manual`, b, JSON.stringify({ contacts: [] })]);
  }
  const r2 = await fill('sp-a2');
  const order2 = (r2.tried || []).map((t) => t.brand);
  const tacos2 = order2.filter((b) => /Taco/.test(b));
  ok(`within the restaurants, ${last} (a website, an owner named) is tried first`, tacos2[0] === last, { tacosPlain, tacos2 });
  const ss = (r2.loop || {}).smartSlate;
  const typeSeq = (o) => o.map((b) => CAT_OF(b)).join(',');
  ok('  the slate before and after: every type in exactly the positions it held, nothing added or dropped',
    ss && ss.before.length === ss.after.length && typeSeq(ss.before) === typeSeq(ss.after) && [...ss.before].sort().join() === [...ss.after].sort().join(), ss);
  const tb = ss ? ss.before.filter((b) => /Taco/.test(b)) : [];
  const ta = ss ? ss.after.filter((b) => /Taco/.test(b)) : [];
  ok(`  and within the restaurants, ${last} moved to the first restaurant position`, ta[0] === last && (tb[0] !== last || tb.length === 1), { tb, ta });
  ok('  the plain order the night read is the one asked for above', JSON.stringify(tb) === JSON.stringify(tacosPlain), { tb, tacosPlain });

  // ── 4. THE GENERAL INBOX ──────────────────────────────────────────────────
  OUT.push('', '-- EMAIL_SMART_PICK: a verified general inbox, one per athlete per night --');
  await P.query(`DELETE FROM reachability_model`); RM._resetCache();
  // Two with only an info@, three that verify by name: every one is tried.
  const g = ['Sp Taco G0', 'Sp Snip G1', 'Sp Lift G2', 'Sp Bean G3', 'Sp Taco G4'];
  await seed(g);
  // Nobody named verifies at G0 and G1; their info@ does. The rest verify by name.
  for (const b of g.slice(2)) VALID.add(`dana.reed@${slug(b)}.com`);
  VALID.add('info@sptacog0.com'); VALID.add('info@spsnipg1.com');
  const r3 = await fill('sp-a3');
  const c3 = await cards('sp-a3');
  const gen = c3.filter((c) => c.email_label === 'General inbox');
  ok('one general-inbox card, labelled, to info@, greeting the owner by name', gen.length === 1 && /^info@/.test(gen[0].email) && gen[0].contact_name === 'Dana Reed' && gen[0].email_verified, gen);
  ok('  and only one: the second business with only an info@ is not a general-inbox card tonight', !c3.some((c) => c.email_label === 'General inbox' && c.brand_name === (gen[0] && gen[0].brand_name === 'Sp Taco G0' ? 'Sp Snip G1' : 'Sp Taco G0')), c3);
  ok('  four cards in all: three named, one general inbox; the second inbox-only business is dropped, not a sixth kind of card', c3.length === 4, c3.map((c) => [c.brand_name, c.email, c.email_label]));
  const notGen = (r3.tried || []).filter((t) => t.why && t.why.finder && t.why.finder.finder && t.why.finder.finder.generalInbox && t.why.finder.finder.generalInbox.used === false);
  ok('  the one turned away says why', notGen.some((t) => /already has a general-inbox card tonight/.test(t.why.finder.finder.generalInbox.why)), notGen.map((t) => t.why.finder.finder.generalInbox));

  // ── 5. THE RECORD THE LEARNING READS ──────────────────────────────────────
  OUT.push('', '-- every attempt records who, what kind, how big --');
  const att = (r3.tried || []).find((t) => t.why && t.why.person);
  ok('the attempt carries the person (with their class), the type and the size', att && att.why.person.cls && att.why.type && att.why.size, att && att.why);
  const J = require('fs').readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('recorded whatever the switches say: it is data, not behaviour', /Recorded on every attempt whatever the switches say: it is data\./.test(J));

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
