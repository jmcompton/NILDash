'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
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

// ── THE PROGRAM LANE, AFTER THE CAP AND THE HANDLE ──────────────────────────
//
// Three claims, all of which the last run got wrong:
//
//   1. ONE program application per athlete. 86 of 155 queued cards were forms,
//      because the national lane never runs out and backfilled every slot the
//      local lane could not fill. The slot the second form would have taken is
//      LEFT EMPTY -- that is the point, and it is asserted, not assumed.
//   2. The handle goes on the program card too, so an agent who fills in a form
//      can also send the DM without going and finding the account themselves.
//   3. A social brand with NO program page is no longer dropped. Its whole
//      presence is its Instagram; with a verified handle it is a DM card, which
//      outranks a form anyway. Without one it is still rejected, and still says
//      why -- the rescue must not become a way to queue an unreachable brand.
//
// The Instagram lookup is stubbed. It is exercised for real in ignamelookup.js;
// what matters HERE is the routing it drives and the money it is charged for.

const Module = require('module');
const originalLoad = Module._load;
const stub = {
  places: () => ({ businessStatus: 'OPERATIONAL', website: 'https://x.com', phone: '(334) 555-1212' }),
  igCalls: [],
  // brand -> handle, or null for "we looked and found nothing"
  handles: {},
};
Module._load = function (request) {
  const m = originalLoad.apply(this, arguments);
  if (request === '../services/placesLookup') {
    return { ...m, lookupPlace: async (b) => stub.places(b) };
  }
  if (request === '../services/instagramLookup') {
    return {
      ...m,
      findInstagram: async (site, opts) => {
        stub.igCalls.push({ site, brand: opts && opts.brand, loc: opts && opts.loc });
        const h = stub.handles[(opts && opts.brand) || ''];
        return h ? { handle: h, scope: 'business', source: 'search' } : null;
      },
    };
  }
  return m;
};

const ROOT = REPO;
const store = require(ROOT + 'server/store');
const ai = require(ROOT + 'server/ai');
const PW = require(ROOT + 'server/services/pitchWriter');

// Nothing in this suite should reach a model or a paid lookup.
ai.getBrandContacts = async () => ({ contacts: [], businessPhone: null, cached: true });
ai.webSearchJson = async () => { throw new Error('the real web search must not be reached here'); };
PW.writePitch = async () => ({ message: 'Two feed posts and a code drop.',
  angle: 'campus traffic', angleKey: 'campus', categoryKey: 'retail', ask: '2 posts' });

const job = require(ROOT + 'server/jobs/outreachQueue');
const Q = require(ROOT + 'server/services/outreachQueue');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};
const AG = 'pcap-agent';
const profileOf = (id, data) => require(ROOT + 'server/services/athleteRecord')
  .resolveAthlete({ id, data },
    { schoolLocation: require(ROOT + 'server/services/schoolResolver').resolveSchool });

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM brand_engagement WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM social_brands WHERE brand LIKE 'PCAP%'`).catch(() => {});
    await P.query(`DELETE FROM deal_comps WHERE source='pcap'`).catch(() => {});
    await P.query(`DELETE FROM market_business_seen WHERE brand LIKE 'PCAP%'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'A','pcap@x.com','x','agent')
                 ON CONFLICT DO NOTHING`, [AG]);

  // ── THE UNIT CLAIMS, BEFORE ANY DATABASE ─────────────────────────────────
  ok('a brand with a program page is a form',
    Q.passesProgramBar({ programUrl: 'https://b.example/athletes' }, null).channel === 'program');
  ok('a brand with only a handle is a DM, not a rejection',
    Q.passesProgramBar({}, { handle: 'ryzesuperfoods' }).ok === true
      && Q.passesProgramBar({}, { handle: 'ryzesuperfoods' }).channel === 'dm',
    Q.passesProgramBar({}, { handle: 'ryzesuperfoods' }));
  ok('a brand with neither is still rejected, and still says why',
    Q.passesProgramBar({}, null).ok === false
      && /no athlete-program page/.test(Q.passesProgramBar({}, null).reason)
      && /Instagram/.test(Q.passesProgramBar({}, null).reason),
    Q.passesProgramBar({}, null));
  ok('the page wins over the handle when a brand has both',
    Q.passesProgramBar({ programUrl: 'https://b.example/a' }, { handle: 'h' }).channel === 'program');
  ok('the cap is one', Q.PROGRAM_SLOT_CAP === 1);
  ok('  and it is reached at one, not after one',
    Q.programCapReached(0) === false && Q.programCapReached(1) === true);

  const card = Q.buildProgramCard(
    { brand_key: 'k', brand_name: 'PCAP Apparel', programUrl: 'https://p.example/athletes' },
    { message: 'm' }, 'Test Athlete', { handle: 'pcapapparel', scope: 'business' });
  ok('THE HANDLE IS ON THE PROGRAM CARD', card.instagram === 'pcapapparel', card);
  ok('  with its scope, so the renderer knows what it is looking at',
    card.instagramScope === 'business', card);
  ok('  and the card is still a form, because the brand has a page',
    card.channel === 'program', card);
  const dmCard = Q.buildProgramCard(
    { brand_key: 'k2', brand_name: 'PCAP Social', programUrl: null },
    { message: 'm' }, 'Test Athlete', { handle: 'pcapsocial', scope: 'business' });
  ok('a page-less brand with a handle builds a DM card',
    dmCard.channel === 'dm' && dmCard.instagram === 'pcapsocial', dmCard);
  ok('  and carries no program url it does not have',
    dmCard.programUrl === null, dmCard);

  // ── THE CAP, THROUGH THE REAL fillAthlete ────────────────────────────────
  // An athlete with no school: the local lane cannot run at all, so every
  // candidate is a program candidate. Before the cap this filled all five slots
  // with forms. It is the exact shape of the 86-of-155 problem.
  // DISTINCT DOMAINS ON PURPOSE. brandIdentity collapses a slate on ANY identity
  // overlap, so five brands sharing pcap.example arrive as ONE candidate -- which
  // would make the "other slots left empty" assertion pass without the cap doing
  // anything at all.
  for (let i = 0; i < 5; i++) {
    await P.query(`INSERT INTO social_brands
        (brand, category, website, sports, tier_min, tier_max, deal_structure, proof_url, proof_date, active)
        VALUES ($1,'apparel',$2,ARRAY['all'],0,999999,'cash_code',
                $3,'2026-01-01',true) ON CONFLICT (brand) DO NOTHING`,
      ['PCAP Form ' + i, 'https://pcap' + i + '.example', 'https://pcap' + i + '.example/athletes']);
  }
  const A1 = 'pcap-a1';
  const d1 = { name: 'No School', hometown: 'Knoxville, TN', sport: 'Football', instagram: 18000 };
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
    [A1, AG, JSON.stringify(d1)]);
  stub.handles = {};                       // no handles: every card is a form
  stub.igCalls.length = 0;
  const r1 = await job.fillAthlete(P, {
    agentId: AG, athleteId: A1, athleteName: 'No School', budget: Q.newBudget(job.CAP_USD),
    region: '', athleteProfile: profileOf(A1, d1),
  });
  const rows1 = (await P.query(
    `SELECT slot, brand_name, channel, program_url, instagram FROM outreach_queue
      WHERE athlete_id=$1 AND state='queued' ORDER BY slot`, [A1])).rows;
  ok('AT MOST ONE PROGRAM APPLICATION PER ATHLETE',
    rows1.filter((x) => x.channel === 'program').length <= 1, rows1);
  ok('  and one is placed, so the cap is a cap and not a block',
    rows1.filter((x) => x.channel === 'program').length === 1, rows1);
  ok('  THE OTHER SLOTS ARE LEFT EMPTY, not filled with a second form',
    rows1.length === 1, rows1);
  ok('  the run still reports what it did', r1.filled === 1, r1);
  const capped = (r1.tried || []).filter((t) => /cap of 1 per athlete/.test(t.reason || ''));
  ok('  and every rejected form says the cap is why',
    capped.length >= 1 && capped.every((t) => t.result === 'rejected'), r1.tried);
  ok('  A CAPPED CANDIDATE COSTS NOTHING: no lookup was run for it',
    stub.igCalls.length === 1, stub.igCalls);

  // ── A SECOND NIGHT DOES NOT ADD A SECOND FORM ────────────────────────────
  // The cap counts what the athlete is ALREADY HOLDING, not just what this run
  // placed. Counting only the run would let five nights build five forms.
  stub.igCalls.length = 0;
  const r1b = await job.fillAthlete(P, {
    agentId: AG, athleteId: A1, athleteName: 'No School', budget: Q.newBudget(job.CAP_USD),
    region: '', athleteProfile: profileOf(A1, d1),
  });
  const rows1b = (await P.query(
    `SELECT channel FROM outreach_queue WHERE athlete_id=$1 AND state='queued'`, [A1])).rows;
  ok('THE NEXT NIGHT DOES NOT STACK A SECOND FORM ON THE FIRST',
    rows1b.filter((x) => x.channel === 'program').length === 1, rows1b);
  ok('  and it spends nothing finding that out', stub.igCalls.length === 0, stub.igCalls);
  ok('  reporting a filled count of zero rather than an error', r1b.filled === 0, r1b);

  // ── THE RESCUE: A BRAND WITH NO PROGRAM PAGE ─────────────────────────────
  // WHICH LANE THESE ACTUALLY COME FROM. Not the social index -- social_brands
  // .proof_url is NOT NULL, so every indexed brand has a page by construction.
  // They come from the NATIONAL lane: a brand with logged NIL deals and no row in
  // the index, which programFacts({}) leaves with programUrl AND website null.
  // That is exactly the set the name-and-city Instagram search exists for, and
  // exactly the set this branch used to reject by name and drop.
  await P.query(`DELETE FROM social_brands WHERE brand LIKE 'PCAP%'`);
  for (const b of ['PCAP Social', 'PCAP Handleless']) {
    for (let i = 0; i < 2; i++) {
      await P.query(`INSERT INTO deal_comps (id, sport, school, brand, deal_value, source)
                     VALUES ($1,'Football','Auburn University',$2,4000,'pcap')`,
        [990200 + (b === 'PCAP Social' ? 0 : 10) + i, b]);
    }
  }
  const A2 = 'pcap-a2';
  const d2 = { name: 'Rescue Case', hometown: 'Knoxville, TN', sport: 'Football', instagram: 22000 };
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
    [A2, AG, JSON.stringify(d2)]);
  stub.handles = { 'PCAP Social': 'pcapsocial' };   // one has an account, one does not
  stub.igCalls.length = 0;
  const r2 = await job.fillAthlete(P, {
    agentId: AG, athleteId: A2, athleteName: 'Rescue Case', budget: Q.newBudget(job.CAP_USD),
    region: '', athleteProfile: profileOf(A2, d2),
  });
  const rows2 = (await P.query(
    `SELECT brand_name, channel, program_url, instagram, instagram_scope FROM outreach_queue
      WHERE athlete_id=$1 AND state='queued'`, [A2])).rows;
  const social = rows2.find((x) => x.brand_name === 'PCAP Social');
  ok('A SOCIAL BRAND WITH NO PROGRAM PAGE IS NO LONGER DROPPED', !!social, rows2);
  ok('  it is a DM card, not a form', social && social.channel === 'dm', social);
  ok('  carrying the handle the search found',
    social && social.instagram === 'pcapsocial', social);
  ok('  scoped, so the DM is not sent to a fan account',
    social && social.instagram_scope === 'business', social);
  ok('  and it holds no program url, because there is no page',
    social && !social.program_url, social);
  ok('  A DM CARD IS NOT CHARGED AGAINST THE PROGRAM CAP',
    rows2.filter((x) => x.channel === 'program').length === 0, rows2);
  const dropped = (r2.tried || []).find((t) => t.brand === 'PCAP Handleless');
  ok('THE BRAND WITH NO PAGE AND NO ACCOUNT IS STILL REJECTED',
    dropped && dropped.result === 'rejected', dropped);
  ok('  and the reason names both things we looked for',
    dropped && /no athlete-program page/.test(dropped.reason)
      && /Instagram/.test(dropped.reason), dropped);

  // ── THE MONEY ────────────────────────────────────────────────────────────
  // This lane used to spend nothing, which is exactly why it produced nothing
  // but forms. It spends now, so it is metered now -- an unmetered lane is how
  // 1200 verification credits disappeared in a night.
  ok('the handle lookup is charged, not free',
    Array.isArray(r2.spendLog) && r2.spendLog.length > 0, r2.spendLog);
  ok('  and every charge names the lane it came from',
    (r2.spendLog || []).every((s) => !!s.lane), r2.spendLog);

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
