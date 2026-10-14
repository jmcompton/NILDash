'use strict';
// Runs against the local test Postgres. Real job, real Scout, real insert;
// the paid lookups and Hunter are stubbed.
//
//   node tests/emailfive.js
//
// ── FIVE VERIFIED EMAILS PER ATHLETE (EMAIL_FIVE_ON) ────────────────────────
// Only an email card with a verified address for a named person fills a slot.
// A business that cannot get one is dropped and the next one pulled; no slot
// is filled with a DM or a call to make up the five. Chains and lanes that
// cannot produce one are skipped before anything is spent. And a mailbox check
// that could not run is set aside and asked again later the same night
// (EMAIL_FINDER_MORE), up to three tries.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
process.env.FINDER_RETRY_GAP_MS = '1';

const Module = require('module');
const originalLoad = Module._load;
const stub = { contactCalls: [], verify: [], notRunLeft: new Map() };
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
const { checkDomain } = require(REPO + 'server/services/domainGate');
const slug = (b) => String(b).toLowerCase().replace(/[^a-z0-9]/g, '');
ai.webSearchJson = async () => { throw new Error('the real web search must not be reached here'); };
ai.getBrandContacts = async (brand) => {
  stub.contactCalls.push(brand);
  return { contacts: [{ name: 'Dana Reed', title: 'Owner', phone: null, affiliationScope: 'this-location', confidence: 'high', source: 'chamber' }],
    businessPhone: '(254) 555-9999', cached: true, instagram: 'shop_' + slug(brand), instagramScope: 'this-location', website: `https://${slug(brand)}.com` };
};
ai.getDealRecommendations = async () => [];
PW.writePitch = async () => ({ message: 'Hi Dana,\nTwo feed posts and an appearance at your location.\n\nJohn',
  angle: 'campus traffic', angleKey: 'campus', categoryKey: 'restaurant', ask: '2 posts + appearance' });
// Hunter, stubbed: dana.reed@ verifies at the businesses in VALID; a business
// in notRunLeft answers "could not run" that many times first.
const VALID = new Set();
EF.liveDeps = () => ({
  verify: async (e) => {
    stub.verify.push(e);
    const dom = e.split('@')[1];
    const left = stub.notRunLeft.get(dom) || 0;
    if (left > 0) { stub.notRunLeft.set(dom, left - 1); return { result: 'unknown', status: null, notRun: true, source: 'hunter' }; }
    return VALID.has(e) ? { result: 'valid', status: 'valid', source: 'hunter' } : { result: 'invalid', status: 'invalid', source: 'hunter' };
  },
  peek: async () => new Map(), domainSearch: async () => null, emailFinder: async () => ({ email: null }), hunterCached: async () => null,
  resolveDomain: async () => ({ website: null, tried: [] }), checkDomain, siteEmail: async () => null,
  placeLookup: async () => null, facebookPage: async () => null,
  corporate: (d, b, o) => EF.corporateDomain(d, b, o),
});
const job = require(REPO + 'server/jobs/outreachQueue');
const Q = require(REPO + 'server/services/outreachQueue');
const AR = require(REPO + 'server/services/athleteRecord');
const SR = require(REPO + 'server/services/schoolResolver');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 800) : '')); } };
const AG = 'ef5-agent';
const KEY = 'waco, tx';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM research_claims WHERE athlete_id LIKE 'ef5-%'`).catch(() => {});
    await P.query(`DELETE FROM discovery_nightly WHERE athlete_id LIKE 'ef5-%'`).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [KEY]).catch(() => {});
    await P.query(`DELETE FROM service_faults WHERE service = 'nightly-floor' AND reason LIKE 'Ef5 %'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'John Agent','ef5@x.test','x','agent')`, [AG]);
  const seed = async (brands) => {
    await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [KEY]);
    for (const b of brands) await P.query(`INSERT INTO market_business_seen (market_key, brand, category) VALUES ($1,$2,'restaurant') ON CONFLICT DO NOTHING`, [KEY, b]);
  };
  const fill = async (id, extra) => {
    const data = { name: 'Ef5 ' + id, school: 'Baylor University', sport: 'Football' };
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [id, AG, JSON.stringify(data)]);
    const profile = AR.resolveAthlete({ id, data }, { schoolLocation: SR.resolveSchool });
    return job.fillAthlete(P, { agentId: AG, agentFirstName: 'John', athleteId: id, athleteName: data.name, budget: Q.newBudget(100),
      region: profile.market, athleteProfile: profile, athleteRow: data, onProgress: (m) => { if (process.env.EF5_DEBUG) console.log('  >> ' + m); }, ...(extra || {}) });
  };
  const cards = async (id) => (await P.query(`SELECT brand_name, channel, email, email_verified FROM outreach_queue WHERE athlete_id=$1 AND state='queued' ORDER BY slot`, [id])).rows;
  const setFlags = (f) => { for (const k of ['EMAIL_FINDER_ON', 'EMAIL_FINDER_MORE', 'EMAIL_FIVE_ON']) { if (f[k]) process.env[k] = '1'; else delete process.env[k]; } };

  // 12 businesses; dana.reed@ verifies at 5 of them. Two chains in the pool.
  const brands = [];
  for (let i = 0; i < 12; i++) brands.push(`Ef5 Fernbrook ${i}`);
  brands.push('Buckle', "Domino's Pizza");
  for (const i of [1, 3, 6, 8, 11]) VALID.add(`dana.reed@ef5fernbrook${i}.com`);

  // ── 1. EMAIL_FIVE_ON ──────────────────────────────────────────────────────
  OUT.push('-- EMAIL_FIVE_ON: five verified emails --');
  await seed(brands);
  setFlags({ EMAIL_FIVE_ON: 1 });
  stub.contactCalls.length = 0; stub.verify.length = 0;
  const r1 = await fill('ef5-a1');
  const c1 = await cards('ef5-a1');
  ok('the athlete reaches five', r1.filled === 5 && c1.length === 5, { filled: r1.filled, note: r1.note, stop: r1.stop });
  ok('  every one an email card with a verified address for the named person', c1.every((c) => c.channel === 'email' && c.email_verified === true && /^dana\.reed@/.test(c.email)), c1);
  ok('  no slot filled with a DM or a call', !c1.some((c) => c.channel === 'dm' || c.channel === 'call'), c1.map((c) => c.channel));
  const dropped = (r1.tried || []).filter((t) => t.stage === 'email' && t.result === 'rejected');
  ok('  businesses with no verified email were dropped and the next pulled, each with its reason', dropped.length >= 1 && dropped.every((t) => /^no verified email for a named person \(/.test(t.reason)), dropped.map((t) => t.reason).slice(0, 3));
  const chainTried = (r1.tried || []).filter((t) => t.stage === 'selection');
  ok('  the chains in the pool were drawn and skipped at selection', chainTried.length === 2 && chainTried.every((t) => /national chain/.test(t.reason)), { chainTried, tried: (r1.tried || []).map((t) => t.brand) });
  ok('  and nothing was spent on them: no contact lookup for Buckle or Domino\'s', !stub.contactCalls.includes('Buckle') && !stub.contactCalls.includes("Domino's Pizza"), stub.contactCalls);
  ok('  the loop says five were held', (r1.loop || {}).stop === 'floor' && (r1.loop || {}).held === 5, r1.loop);

  // ── 2. THE FINDER ON, FIVE OFF: THE OLD RULE ──────────────────────────────
  OUT.push('', '-- EMAIL_FINDER_ON without EMAIL_FIVE_ON: DM cards still fill slots --');
  setFlags({ EMAIL_FINDER_ON: 1 });
  stub.verify.length = 0;
  const r2 = await fill('ef5-a2');
  const c2 = await cards('ef5-a2');
  ok('five cards, and a business with no verified email is still a DM card', r2.filled === 5 && c2.some((c) => c.channel === 'dm'), c2.map((c) => c.channel));
  ok('  the verified ones are marked', c2.filter((c) => c.channel === 'email').every((c) => c.email_verified), c2);

  // ── 3. EVERYTHING OFF: TONIGHT AS BEFORE ──────────────────────────────────
  OUT.push('', '-- every switch off: merging changes nothing --');
  setFlags({});
  stub.verify.length = 0;
  const r3 = await fill('ef5-a3');
  ok('the finder never runs and no check is spent', stub.verify.length === 0 && r3.filled === 5, { verify: stub.verify.length, filled: r3.filled });
  ok('  and no card is marked verified', (await cards('ef5-a3')).every((c) => c.email_verified === false));

  // ── 4. A CHECK THAT COULD NOT RUN, ASKED AGAIN LATER TONIGHT ──────────────
  OUT.push('', '-- EMAIL_FINDER_MORE: a check that could not run is retried later the same night --');
  await seed(['Ef5 Retrywood', 'Ef5 Nopewood 1', 'Ef5 Nopewood 2']);
  VALID.add('dana.reed@ef5retrywood.com');
  stub.notRunLeft.set('ef5retrywood.com', 1);
  setFlags({ EMAIL_FIVE_ON: 1, EMAIL_FINDER_MORE: 1 });
  const r4 = await fill('ef5-a4');
  const def = (r4.tried || []).filter((t) => t.result === 'deferred');
  ok('first pass: the business is set aside, not dropped and not placed', r4.filled === 0 && r4.deferred.length === 1 && def.length === 1
    && /could not run \(try 1 of 3\); tried again later tonight/.test(def[0].reason), { filled: r4.filled, deferred: (r4.deferred || []).map((c) => c.brand_name), def });
  const r4b = await fill('ef5-a4', { retryCands: r4.deferred, noWiden: true, keepStale: true });
  const c4 = await cards('ef5-a4');
  ok('the retry pass: it verifies, and becomes an email card', r4b.filled === 1 && c4.length === 1 && c4[0].brand_name === 'Ef5 Retrywood' && c4[0].email_verified, { filled: r4b.filled, c4, tried: r4b.tried });
  ok('  the retry pass draws nothing new: its slate is what was set aside', (r4b.tried || []).every((t) => t.brand === 'Ef5 Retrywood'), (r4b.tried || []).map((t) => t.brand));
  // Three times "could not run": the third try decides it.
  await P.query(`DELETE FROM outreach_queue WHERE athlete_id='ef5-a5'`);
  stub.notRunLeft.set('ef5retrywood.com', 10);
  const r5 = await fill('ef5-a5');
  const r5b = await fill('ef5-a5', { retryCands: r5.deferred, noWiden: true, keepStale: true });
  const r5c = await fill('ef5-a5', { retryCands: r5b.deferred, noWiden: true, keepStale: true });
  const last = (r5c.tried || []).find((t) => t.brand === 'Ef5 Retrywood');
  ok('after three tries the business is decided: dropped under the five rule, and said why', r5.deferred.length === 1 && r5b.deferred.length === 1 && r5c.deferred.length === 0
    && last && last.result === 'rejected' && /could not run after 3 tries/.test(last.reason), { last, d: [r5.deferred.length, r5b.deferred.length, r5c.deferred.length] });
  stub.notRunLeft.clear();
  const nr = (await P.query(`SELECT COUNT(*)::int n FROM service_faults WHERE service = 'nightly-floor' AND reason LIKE 'Ef5 ef5-a5:%'`)).rows[0].n;
  ok('  a retry pass does not raise the short-of-five alarm again', nr <= 1, nr);

  // ── 5. THE WIRING ─────────────────────────────────────────────────────────
  OUT.push('', '-- the wiring --');
  const J = require('fs').readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('fillAgent sends set-aside businesses round again after the roster, up to three tries, after a gap',
    /for \(let pass = 2; pass <= VERIFY_TRIES && deferredBy\.size && !dry; pass\+\+\)/.test(J) && /retryCands: cands, noWiden: true, keepStale: true/.test(J) && /const VERIFY_TRIES = 3;/.test(J));
  ok('  a retry is researched again on purpose (its first try claimed it)', /if \(cand\._verifyTry\) \{[\s\S]{0,80}\} else if \(!\(await Claims\.claimResearch/.test(J));
  ok('  and reuses the athlete\'s context from the night\'s pass', /ctxFor\(ath, ctxBy\.get\(athId\), \{ retryCands: cands/.test(J));
  ok('under the five rule the slate is drawn from the local lane only', /localOnly: FINDER\.five\(\)/.test(J)
    && /if \(ctx\.localOnly && subject && subject\.lanes\)/.test(require('fs').readFileSync(REPO + 'server/services/scout.js', 'utf8')));
  ok('  and the national and social rungs are not climbed', /if \(FINDER\.five\(\) && \(name === 'social' \|\| name === 'national'\)\) \{ rung\+\+; continue; \}/.test(J));
  ok('a verified card is recorded as such (email_verified), which the 5:30 list counts', /UPDATE outreach_queue SET email_verified = TRUE WHERE id = \$1/.test(J)
    && /ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE/.test(require('fs').readFileSync(REPO + 'server/store.js', 'utf8')));

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
