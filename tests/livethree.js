'use strict';
// Runs from a checkout on any machine: repo-relative paths, overridable
// Postgres settings, and a startup wait the runner can shorten once the schema
// has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THREE BUGS FROM THE RUN AFTER 80ef319 ───────────────────────────────────
//
// 1. STILL ZERO EMAIL CARDS. Traced: the ladder and channelFor are NOT the
//    drop. Every shape an address can arrive in routes to email. The address
//    never reached the ladder, and the step that lost it was recorded in an
//    object the job discarded. That is now on the run row.
// 2. THE WIDENED POOL STILL DID NOT REACH THE SLATE. A brand carrying a
//    lane-NULL ledger row was excluded from the market pool for HAVING a ledger
//    row and from the shown pool for having no lane. It fell through both.
// 3. NATIONAL BRANDS IN THE LOCAL LANE, and a domain matched on "town".

const fs = require('fs');
const ROOT = REPO;
const CL = require(ROOT + 'server/services/contactLadder');
const Q = require(ROOT + 'server/services/outreachQueue');
const DG = require(ROOT + 'server/services/domainGate');
const Scout = require(ROOT + 'server/services/scout');
const AR = require(ROOT + 'server/services/athleteRecord');
const { resolveSchool } = require(ROOT + 'server/services/schoolResolver');
const store = require(ROOT + 'server/store');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  console.log('\n-- 1. THE SIX ADDRESSES: WHERE THEY ARE *NOT* DROPPED --');
  {
    // The six from the run, each placed in every field a contacts lookup can
    // return it in. THE POINT OF THIS BLOCK IS THE NEGATIVE RESULT: none of
    // these is dropped by the ladder or by channelFor, so the drop is upstream.
    const base = { brand: 'X', businessPhone: '2055551212', website: 'https://x.com', contacts: [] };
    const placements = [
      ['step 1 — named person on the site', (e) => ({ siteEmail: { email: e, type: 'personal' } })],
      ['step 4 — general inbox on the site', (e) => ({ siteEmail: { email: e, type: 'role' } })],
      ['step 4 — genericInbox', (e) => ({ genericInbox: e })],
      ['personalInbox', (e) => ({ personalInbox: e })],
      ['on a named contact', (e) => ({ contacts: [{ name: 'A B', title: 'Owner', email: e, emailSource: 'published' }] })],
    ];
    const six = ['flatpennies2022@gmail.com', 'smcc_va@yahoo.com', 'mrsfoxsteahouse@gmail.com',
      'a.yautosales2023@gmail.com', 'info@liquid-iv.com', 'admin@stixnstonesmarketplace.com'];
    let routed = 0, total = 0;
    for (const email of six) {
      for (const [, mk] of placements) {
        total++;
        const l = CL.buildContactLadder(Object.assign({}, base, mk(email)), { brand: 'X' });
        if (Q.channelFor(l, { instagram: null }) === 'email') routed++;
      }
    }
    ok('EVERY ONE OF THE SIX ROUTES TO EMAIL FROM EVERY FIELD', routed === total,
      { routed, total });
    ok('  including a free-mail address, which is not a reason to refuse',
      Q.channelFor(CL.buildContactLadder(
        Object.assign({}, base, { genericInbox: 'flatpennies2022@gmail.com' }), { brand: 'X' }),
      { instagram: null }) === 'email');
    ok('  and a cross-domain one, which is labelled rather than dropped',
      /Different domain/.test(JSON.stringify(CL.buildContactLadder(
        Object.assign({}, base, { siteEmail: { email: 'mrsfoxsteahouse@gmail.com', type: 'personal' } }),
        { brand: 'X' }))), null);

    // So the drop is upstream, and the step that lost it is recorded in
    // addressLadder -- which the job discarded. It is on the run row now.
    const job = fs.readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
    ok('THE ADDRESS LADDER IS RECORDED PER CANDIDATE',
      /const _al = out\.addressLadder \|\| null;/.test(job), null);
    ok('  with each rung: ran, hit, or skipped',
      /s\.hit \? 'HIT' : \(s\.ran \? 'miss' : 'skipped'\)/.test(job), null);
    ok('  and what the ladder actually held, which is channelFor\'s only input',
      /ladderEmails: _emailRows\.map/.test(job), null);
    ok('  A REFUSED KIND IS A DIFFERENT ANSWER FROM NO ADDRESS',
      /refusedKinds:/.test(job), null);
    ok('  and a dropped website, which silences steps 1 and 4 at the source',
      /websiteDropped: out\.websiteDropped/.test(job), null);
    ok('  written into tried[], so it reaches outreach_queue_runs.details',
      (job.match(/risk: pre\.risk, why: _why/g) || []).length === 2, null);
    ok('  and said in the log line too', /channel=\$\{channel\}/.test(job), null);
  }

  console.log('\n-- 2. THE BRAND THAT FELL THROUGH BOTH LOCAL POOLS --');
  {
    const AG = 'l3-agent', ATH = 'l3-ath';
    const profile = AR.resolveAthlete({ id: ATH, school: 'Virginia Tech' },
      { schoolLocation: resolveSchool });
    profile.id = ATH;
    ok('a mapped school has a market key', profile.marketKey === 'blacksburg, va', profile.marketKey);

    for (const t of ['outreach_queue', 'athletes']) {
      await P.query(`DELETE FROM ${t} WHERE agent_id = $1`, [AG]).catch(() => {});
    }
    await P.query(`DELETE FROM brand_engagement WHERE athlete_id = $1`, [ATH]);
    await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [profile.marketKey]);
    await P.query(`DELETE FROM users WHERE id = $1`, [AG]);
    await P.query(
      `INSERT INTO users (id,name,email,password,role) VALUES ($1,'L3','l3@x.example','x','agent')`, [AG]);
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
      [ATH, AG, JSON.stringify({ name: 'Messiah Mickens', school: 'Virginia Tech' })]);

    const brands = ['Gillies', 'Cabo Fish Taco', 'Bull and Bones', 'Sharkeys', 'Rivermill',
      'PK s', 'Souvlaki', 'Benny Marzanos', 'The Cellar', 'Zeppolis'];
    await store.markMarketNewcomers(profile.marketKey, brands);
    const inPool = (await P.query(
      `SELECT COUNT(*)::int AS n FROM market_business_seen WHERE market_key = $1`,
      [profile.marketKey])).rows[0].n;
    ok('ten widened businesses are in the pool', inPool === 10, inPool);

    // THE EXACT SHAPE OF THE RUN. A Deal Scan showed these brands and did not
    // stamp a lane, which is what leaves lane NULL.
    for (const b of brands) {
      await P.query(
        `INSERT INTO brand_engagement (agent_id,athlete_id,brand_key,brand_name,lane,state,
            shown_count,first_shown_at,last_shown_at)
         VALUES ($1,$2,$3,$4,NULL,'shown',1,NOW(),NOW()) ON CONFLICT DO NOTHING`,
        [AG, ATH, b.toLowerCase().replace(/[^a-z0-9]+/g, ''), b]);
    }
    const s1 = await Scout.assembleSlate(P, { agentId: AG, athlete: profile, store, limit: 15 });
    ok('A LANE-NULL LEDGER ROW NO LONGER HIDES THE BUSINESS',
      (s1.laneCounts.local || 0) === 10, s1.laneCounts);

    // And a brand actually worked stays out -- the relaxation must not become
    // "offer everything again".
    await P.query(
      `UPDATE brand_engagement SET state = 'contacted' WHERE athlete_id = $1 AND brand_name = 'Gillies'`,
      [ATH]);
    const s2 = await Scout.assembleSlate(P, { agentId: AG, athlete: profile, store, limit: 15 });
    ok('  a CONTACTED brand is still excluded',
      (s2.laneCounts.local || 0) === 9 && !s2.picks.some((p) => p.brand_name === 'Gillies'),
      s2.laneCounts);
    for (const st of ['replied', 'closed', 'retired']) {
      await P.query(
        `UPDATE brand_engagement SET state = $2 WHERE athlete_id = $1 AND brand_name = 'Gillies'`,
        [ATH, st]);
      const s = await Scout.assembleSlate(P, { agentId: AG, athlete: profile, store, limit: 15 });
      ok(`  and a "${st}" one`, !s.picks.some((p) => p.brand_name === 'Gillies'));
    }
    // A queued card still blocks it, by the other clause.
    await P.query(
      `UPDATE brand_engagement SET state = 'shown' WHERE athlete_id = $1 AND brand_name = 'Gillies'`,
      [ATH]);
    await P.query(
      `INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,state,channel)
       VALUES ($1,$2,1,'gillies','Gillies','queued','call')`, [AG, ATH]);
    const s3 = await Scout.assembleSlate(P, { agentId: AG, athlete: profile, store, limit: 15 });
    ok('  and a QUEUED card still blocks it', !s3.picks.some((p) => p.brand_name === 'Gillies'),
      s3.picks.map((p) => p.brand_name));

    console.log('\n-- 3a. A NATIONAL BRAND IS NOT IN A TOWN --');
    // The contamination that is already in the table: a social scan filed
    // national brands under the athlete's town key.
    await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]);
    await P.query(`DELETE FROM brand_engagement WHERE athlete_id = $1`, [ATH]);
    const nat = ['Nike', 'Liquid I.V.', 'Barstool Sports'];
    // EVERY NOT NULL COLUMN, and NOT swallowed. The first version of this seed
    // used .catch(() => {}) and the insert failed on social_brands.category --
    // so the guard looked broken when it was the fixture that never loaded.
    for (const b of nat) {
      await P.query(
        `INSERT INTO social_brands
           (brand, category, sports, tier_min, tier_max, deal_structure, proof_url, proof_date, active)
         VALUES ($1,'supplement','{football}',0,100000000,'product','https://x.test/p',
                 CURRENT_DATE, true)
         ON CONFLICT DO NOTHING`, [b]);
    }
    const seeded = (await P.query(
      `SELECT COUNT(*)::int AS n FROM social_brands WHERE brand = ANY($1::text[])`, [nat])).rows[0].n;
    ok('the national-brand index is seeded for this test', seeded === 3, seeded);
    await store.markMarketNewcomers(profile.marketKey, nat);
    const s4 = await Scout.assembleSlate(P, { agentId: AG, athlete: profile, store, limit: 20 });
    const localNames = s4.picks.filter((p) => p.lane === 'local').map((p) => p.brand_name);
    ok('NIKE, LIQUID I.V. AND BARSTOOL ARE NOT IN THE LOCAL LANE',
      !nat.some((b) => localNames.includes(b)), localNames);
    ok('  and the real local businesses still are', localNames.length >= 9, localNames.length);

    const idx = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
    ok('the Deal Scan only records a market pool for the LOCAL lane',
      /if \(validLane !== 'local'\) throw \{ _skip: true \};/.test(idx), null);
    ok('  and a social scan is a clean skip, not a logged error',
      /if \(!e \|\| !e\._skip\) console\.error\('\[dealScan\] newcomers:'/.test(idx), null);
    const sc = fs.readFileSync(ROOT + 'server/services/scout.js', 'utf8');
    ok('  while the READ side stays guarded, because the old rows are still there',
      /NOT EXISTS \(SELECT 1 FROM social_brands sb/.test(sc), null);

    for (const t of ['outreach_queue', 'athletes']) {
      await P.query(`DELETE FROM ${t} WHERE agent_id = $1`, [AG]).catch(() => {});
    }
    await P.query(`DELETE FROM brand_engagement WHERE athlete_id = $1`, [ATH]);
    await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [profile.marketKey]);
    await P.query(`DELETE FROM social_brands WHERE brand = ANY($1::text[])`, [nat]);
    await P.query(`DELETE FROM users WHERE id = $1`, [AG]);
  }

  console.log('\n-- 3b. "town" IS NOT A NAME --');
  {
    // K Town Fitness reduces to ONE distinctive token: "K" is a single letter
    // and "Fitness" names the trade. A bare substring test then accepts every
    // domain in the county with "town" in it -- and the card was built with
    // another business's owner and their email on it.
    const cases = [
      ['K Town Fitness', 'https://downtownac.com', false, 'the reported bug'],
      ['K Town Fitness', 'https://midtowntavern.com', false, 'a different tavern'],
      ['K Town Fitness', 'https://hometownpizza.com', false, 'a pizza place'],
      ['K Town Fitness', 'https://ktownfitness.com', true, 'their OWN domain'],
      ['Downtown Athletic Club', 'https://downtownac.com', true, 'whose domain it really is'],
      ['Midtown Tavern', 'https://themidtowntavern.com', true, 'a leading "the"'],
      ['Town Square Deli', 'https://townsquaredeli.com', true, 'leads with the place word'],
      ['Park Place Diner', 'https://parkplacediner.com', true, 'park, with its neighbour'],
      ['Park Place Diner', 'https://centralparkny.com', false, 'park, on its own'],
    ];
    for (const [b, d, want, why] of cases) {
      const r = DG.checkDomain(b, d);
      ok(`  ${want ? 'accept' : 'REJECT'} ${d.replace('https://', '')} for "${b}" — ${why}`,
        r.ok === want, { ok: r.ok, code: r.code, matchedOn: r.matchedOn });
    }
    ok('THE REFUSAL IS NAMED, so it is not confused with "the name is absent"',
      DG.checkDomain('K Town Fitness', 'https://downtownac.com').code === 'place-word-only',
      DG.checkDomain('K Town Fitness', 'https://downtownac.com').code);
    ok('  and the code is registered', DG.CODES.indexOf('place-word-only') !== -1, DG.CODES);
    ok('  the reason says why a place word cannot confirm a business',
      /place word shared by many businesses/.test(
        DG.checkDomain('K Town Fitness', 'https://downtownac.com').reason), null);

    // THE RULES THAT MUST NOT HAVE BEEN LOOSENED OR TIGHTENED BY ACCIDENT.
    for (const [b, d, want] of [
      ['Trevs Sports Bar', 'https://trevssportsbar.com', true],
      ['Gillies', 'https://gillies.com', true],
      ['Cabo Fish Taco', 'https://cabofishtaco.com', true],
      ['Onyx Coffee Lab', 'https://daysolcoffeelab.co', false],
      ['Post Office Pies', 'https://davenportspizza.com', false],
      ['Homewood Cycle & Fitness', 'https://cahabacycles.com', false],
      ['Square Deal Auto', 'https://square.site', false],
    ]) {
      ok(`  unchanged: ${b} -> ${d.replace('https://', '')}`,
        DG.checkDomain(b, d).ok === want, DG.checkDomain(b, d));
    }
  }

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
