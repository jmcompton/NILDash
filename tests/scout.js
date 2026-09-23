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
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// The Scout: one mixed slate across three lanes, the sponsorship boost, the
// exhaustion fix, and a named reason for every empty athlete.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const S = require(ROOT + 'server/services/scout.js');
const AR = require(ROOT + 'server/services/athleteRecord.js');
const R = require(ROOT + 'server/services/schoolResolver.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'sc-agent';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const wipe = async () => {
    for (const t of ['outreach_queue', 'brand_engagement', 'deals', 'deal_comps', 'athletes']) {
      await P.query(`DELETE FROM ${t} WHERE ${t === 'deal_comps' ? "school='Auburn University'" : t === 'athletes' ? 'agent_id=$1' : 'agent_id=$1'}`,
        t === 'deal_comps' ? [] : [AG]).catch(() => {});
    }
    await P.query(`DELETE FROM market_business_seen WHERE brand LIKE 'Passed Over %'`).catch(() => {});
  };
  await wipe();

  const ATH = AR.resolveAthlete({ id: 'sc-a1', data: { name: 'Test Athlete', school: 'Auburn University',
    sport: 'Football', instagram: 20000 } }, { schoolLocation: R.resolveSchool });
  ok('the athlete has a market', ATH.hasLocalMarket && /Auburn/.test(ATH.market), ATH.market);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3::jsonb)`,
    [ATH.id, AG, JSON.stringify({ name: 'Test Athlete', school: 'Auburn University' })]);

  // ── EMPTY IS NEVER SILENT ────────────────────────────────────────────────
  // Every lane bare, so the reason has to come from the local lane being spent.
  const bareStore = { getSocialBrandPool: async () => [], getTopNilComps: async () => [] };
  let sl = await S.assembleSlate(P, { agentId: AG, athlete: ATH, store: bareStore, limit: 5 });
  ok('an empty market gives a NAMED reason', sl.picks.length === 0 && !!sl.emptyReason, sl);
  // The pool was just wiped, so there is NO row under this athlete's key. That
  // is not a market that has been worked out; it is a pool that is not there.
  // The two used to share one word, "exhausted", and Jeremiah Wilkinson's 241
  // unseen businesses were reported as worked out because his rows sat under
  // another key. Different problem, different sentence.
  ok('  a key with no pool rows is no-pool-for-key, not a bare zero', sl.emptyReason === S.EMPTY.NO_POOL_FOR_KEY, sl.emptyReason);
  // And a market that really IS spent -- rows exist under the key, every one
  // already worked for this athlete -- still says so.
  await P.query(`INSERT INTO market_business_seen (market_key, brand, first_seen_at, last_seen_at)
                 VALUES ($1,'Passed Over Worked',NOW(),NOW()) ON CONFLICT DO NOTHING`, [ATH.marketKey]);
  await P.query(`INSERT INTO brand_engagement (agent_id,athlete_id,brand_key,brand_name,state)
                 VALUES ($1,$2,'passedoverworked','Passed Over Worked','contacted') ON CONFLICT DO NOTHING`, [AG, ATH.id]);
  const spent = await S.assembleSlate(P, { agentId: AG, athlete: ATH, store: bareStore, limit: 5 });
  ok('  a key whose every row is already worked is market-exhausted', spent.emptyReason === S.EMPTY.MARKET_EXHAUSTED, spent.emptyReason);
  ok('  and the slate records the rows it found under the key', spent.lanes && spent.lanes.local.rows === 0 && spent.lanes.local.marketKey === ATH.marketKey, spent.lanes);
  await P.query(`DELETE FROM brand_engagement WHERE brand_name='Passed Over Worked'`).catch(() => {});
  await P.query(`DELETE FROM market_business_seen WHERE brand='Passed Over Worked'`).catch(() => {});
  sl = await S.assembleSlate(P, { agentId: AG, athlete: ATH, store: bareStore, limit: 5 });
  // The wiped-pool case: the text has to name the fix, not describe a market
  // that was never looked at as worked out.
  ok('  with text an agent can act on', /run scripts\/migrate-market-pool-key\.js/.test(sl.emptyText), sl.emptyText);
  ok('  and the spent-market text still says worked', /already been worked/.test(spent.emptyText), spent.emptyText);

  const NOMKT = AR.resolveAthlete({ id: 'sc-a2', data: { name: 'No Market', school: 'Nowhere Tech' } },
    { schoolLocation: R.resolveSchool });
  sl = await S.assembleSlate(P, { agentId: AG, athlete: NOMKT, store: bareStore, limit: 5 });
  ok('an unresolvable school is a DIFFERENT reason', sl.emptyReason === S.EMPTY.NO_MARKET, sl.emptyReason);
  ok('  and says so', /no town to work in/.test(sl.emptyText), sl.emptyText);

  // ── THE POOL THAT WAS NEVER READ ─────────────────────────────────────────
  // Businesses the market scan discovered and passed over. Nothing used to
  // touch these, which is why a market went quiet and stayed quiet.
  for (let i = 0; i < 8; i++) {
    await P.query(`INSERT INTO market_business_seen (market_key, brand, first_seen_at, last_seen_at)
                   VALUES ($1,$2,NOW(),NOW()) ON CONFLICT DO NOTHING`, [ATH.marketKey, 'Passed Over ' + i]);
  }
  sl = await S.assembleSlate(P, { agentId: AG, athlete: ATH, store, limit: 5 });
  ok('the passed-over pool IS now a source', sl.picks.length > 0, sl.emptyText);
  ok('  they come from the market pool', sl.picks.some((p) => p.pool === 'market-pool'), sl.picks.map((p) => p.pool));
  ok('  and every market-pool result is tagged local lane',
    sl.picks.filter((p) => p.pool === 'market-pool').every((p) => p.lane === 'local'),
    sl.picks.map((p) => p.pool + ':' + p.lane));
  ok('  capped at the slate limit', sl.picks.length <= 5, sl.picks.length);

  // Already-queued businesses are not offered again.
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state)
                 VALUES ($1,$2,1,'k1','Passed Over 0','dm','queued')`, [AG, ATH.id]);
  sl = await S.assembleSlate(P, { agentId: AG, athlete: ATH, store, limit: 5 });
  ok('a business already queued is not offered again',
    !sl.picks.some((p) => p.brand_name === 'Passed Over 0'), sl.picks.map((p) => p.brand_name));

  // ── THE SPONSORSHIP SIGNAL, AND WHAT EACH SOURCE IS WORTH ────────────────
  // A scraped comp and a business that answered us are not the same evidence.
  // nilCompJob.js searches the news for disclosed deals over $1,000, so
  // deal_comps is mostly collectives and national brands -- useful for the
  // national lane, and NOT grounds for telling a local owner they already
  // sponsor the school.
  await P.query(`INSERT INTO deal_comps (id, sport, school, brand, deal_value, source)
                 VALUES (990001,'Football','Auburn University','Passed Over 3',5000,'test')`);
  const sig = await S.schoolSponsorSignals(P, 'Auburn University', { agentId: AG });
  ok('a scraped deal at this school is found', sig.has('passed over 3'), [...sig.keys()]);
  ok('  but it is labelled a REPORT, not a sponsorship',
    sig.get('passed over 3').kind === 'reported-deal-at-school', sig.get('passed over 3'));
  ok('  and worded that way', /publicly reported an NIL deal with an athlete at Auburn/
    .test(sig.get('passed over 3').detail), sig.get('passed over 3').detail);

  sl = await S.assembleSlate(P, { agentId: AG, athlete: ATH, store, limit: 5 });
  const scraped = sl.picks.find((p) => p.brand_name === 'Passed Over 3');
  ok('A NEWS REPORT DOES NOT BOOST A LOCAL BUSINESS',
    !scraped || !scraped.sponsorSignal, scraped);
  ok('  so it does not jump the queue on national press evidence',
    sl.picks[0].brand_name !== 'Passed Over 3', sl.picks.map((p) => p.brand_name));

  // What DOES boost a local business: one that actually answered us for another
  // athlete at this school. This is the signal the insight was about.
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('sc-sib',$1,$2::jsonb)
                 ON CONFLICT (id) DO NOTHING`,
    [AG, JSON.stringify({ name: 'Sibling', school: 'Auburn University' })]);
  await P.query(`INSERT INTO brand_engagement (agent_id,athlete_id,brand_key,brand_name,state)
                 VALUES ($1,'sc-sib','sib1','Passed Over 4','responded')
                 ON CONFLICT DO NOTHING`, [AG]);
  const sigR = await S.schoolSponsorSignals(P, 'Auburn University', { agentId: AG });
  ok('a business that ANSWERED us at this school is a signal',
    sigR.get('passed over 4') && sigR.get('passed over 4').kind === 'replied-at-school',
    sigR.get('passed over 4'));

  sl = await S.assembleSlate(P, { agentId: AG, athlete: ATH, store, limit: 5 });
  const boosted = sl.picks.find((p) => p.brand_name === 'Passed Over 4');
  ok('THE BUSINESS THAT ANSWERED US RANKS FIRST',
    sl.picks[0].brand_name === 'Passed Over 4', sl.picks.map((p) => p.brand_name));
  ok('  carrying the signal so the card can say why', boosted && boosted.sponsorSignal, boosted);
  ok('  and the slate reports how many were boosted', sl.boosted === 1,
    sl.picks.filter((p) => p.sponsorSignal).map((p) => p.brand_name + ' <- ' + p.sponsorSignal.kind));

  // ONE BUSINESS, ONE SLOT. The same brand can reach the slate down two lanes
  // at once -- local market pool AND national index. Two pitches to the same
  // owner in one night is the failure this guards.
  const names = sl.picks.map((p) => p.brand_name);
  ok('  a brand arriving down two lanes is pitched ONCE',
    names.length === new Set(names.map((n) => n.toLowerCase())).size, names);

  // Our own closed deal at the school is also a signal.
  await P.query(`INSERT INTO deals (id, agent_id, athlete_id, data) VALUES
    ('sc-d1',$1,$2,'{"stage":"Closed","brand":"Passed Over 5"}'::jsonb)`, [AG, ATH.id]);
  const sig2 = await S.schoolSponsorSignals(P, 'Auburn University', { agentId: AG });
  ok('our own closed deal counts too', sig2.has('passed over 5'), [...sig2.keys()]);
  ok('  and outranks a mere reply', S.SIGNAL_WEIGHT['agent-closed-at-school'] > S.SIGNAL_WEIGHT['replied-at-school']);
  ok('a deal at ANOTHER school is not a signal here',
    (await S.schoolSponsorSignals(P, 'Clemson University', { agentId: AG })).size === 0);

  // ── THE MIXED SLATE ──────────────────────────────────────────────────────
  // A social pool with no geography: it must reach the slate for an athlete
  // whose local market is bare.
  const fakeStore = {
    getSocialBrandPool: async () => ([
      { brand: 'Gymshark', brandKey: 'gymshark', fitScore: 90, whyFits: 'Quarterly drops' },
      { brand: 'Nocco', brandKey: 'nocco', fitScore: 80, whyFits: 'Affiliate' },
      { brand: 'Alani Nu', brandKey: 'alani', fitScore: 75, whyFits: 'Code' },
      { brand: 'Celsius', brandKey: 'celsius', fitScore: 70, whyFits: 'Code' },
    ]),
    getTopNilComps: async () => ([{ brand: 'Red Bull', brandKey: 'redbull', why: 'signs athletes' }]),
  };
  const BARE = AR.resolveAthlete({ id: 'sc-a3', data: { name: 'Bare Market', school: 'Auburn University' } },
    { schoolLocation: R.resolveSchool });
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3::jsonb)`,
    [BARE.id, AG, JSON.stringify({ name: 'Bare Market', school: 'Auburn University' })]);
  // Queue every local business so the local lane is genuinely spent for them.
  for (let i = 0; i < 8; i++) {
    await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state)
                   VALUES ($1,$2,$3,$4,$5,'dm','sent')`, [AG, BARE.id, i + 1, 'bk' + i, 'Passed Over ' + i]);
  }
  sl = await S.assembleSlate(P, { agentId: AG, athlete: BARE, store: fakeStore, limit: 5 });
  ok('WHEN LOCAL IS EXHAUSTED THE ATHLETE IS NOT EMPTY', sl.picks.length > 0, sl.emptyText);
  ok('  because social and national still have something',
    sl.picks.every((p) => p.lane === 'social' || p.lane === 'national'), sl.picks.map((p) => p.lane));
  ok('  and the lane is a property of each result', sl.picks.every((p) => !!p.lane));

  // A mixed slate when both lanes have stock.
  sl = await S.assembleSlate(P, { agentId: AG, athlete: ATH, store: fakeStore, limit: 5 });
  const lanes = Object.keys(sl.laneCounts);
  ok('the slate MIXES lanes rather than running one', lanes.length > 1, sl.laneCounts);
  ok('  no lane takes the whole slate', Object.values(sl.laneCounts).every((n2) => n2 <= 5), sl.laneCounts);
  ok('  the soft cap keeps room for the others', (sl.laneCounts.local || 0) <= S.LANE_SOFT_CAP + 2, sl.laneCounts);
  ok('  five is a ceiling', sl.picks.length <= 5, sl.picks.length);

  // ── GEOGRAPHY: local binds, the others do not ────────────────────────────
  const noMktButSocial = await S.assembleSlate(P, { agentId: AG, athlete: NOMKT, store: fakeStore, limit: 5 });
  ok('an athlete with NO market still gets social and national', noMktButSocial.picks.length > 0, noMktButSocial);
  ok('  and gets NO local results at all',
    !noMktButSocial.picks.some((p) => p.lane === 'local'), noMktButSocial.picks.map((p) => p.lane));
  ok('  which is the geography rule: local binds, social and DTC do not', true);

  // ── THE LANE DECIDES THE ROUTE ───────────────────────────────────────────
  // A national brand must never reach a Places lookup: that is the local lane,
  // and pointed at a national brand it resolves to whatever storefront happens
  // to be nearby. So the program page travels WITH the candidate.
  await P.query(`INSERT INTO social_brands
      (brand, category, website, sports, tier_min, tier_max, deal_structure, proof_url, proof_date, active)
      VALUES ('Scoutcorp','apparel','https://scoutcorp.example',ARRAY['all'],0,999999,'cash_code',
              'https://scoutcorp.example/athletes','2026-01-01',true)
      ON CONFLICT (brand) DO NOTHING`);
  const compStore = {
    getSocialBrandPool: async () => [],
    getTopNilComps: async () => ([
      { brand: 'Scoutcorp', brandKey: 'scoutcorp', count: 4 },
      { brand: 'Nowhere Brand', brandKey: 'nowhere', count: 9 },
    ]),
  };
  const nat = await S.nationalCandidates(P, { limit: 5, store: compStore });
  const inIndex = nat.find((c) => c.brand_name === 'Scoutcorp');
  const notInIndex = nat.find((c) => c.brand_name === 'Nowhere Brand');
  ok('a national brand carries its program page, not a place',
    inIndex && inIndex.programUrl === 'https://scoutcorp.example/athletes', inIndex);
  ok('  and its lane says so', inIndex && inIndex.lane === 'national', inIndex && inIndex.lane);
  ok('a proven spender with NO program page still comes through',
    !!notInIndex, nat.map((c) => c.brand_name));
  ok('  carrying programUrl null, so the reason can be recorded',
    notInIndex && notInIndex.programUrl === null, notInIndex);

  const Q = require(ROOT + 'server/services/outreachQueue.js');
  ok('  and the bar rejects it BY NAME rather than queueing it',
    Q.passesProgramBar(notInIndex).ok === false
      && /no athlete-program page/.test(Q.passesProgramBar(notInIndex).reason),
    Q.passesProgramBar(notInIndex));
  ok('  while the indexed one passes', Q.passesProgramBar(inIndex).ok === true);

  const pcard = Q.buildProgramCard(inIndex, { message: 'Two feed posts and a store visit.', angle: 'a', ask: 'x' }, 'Test Athlete');
  ok('the program card is channel program, not dm or call', pcard.channel === 'program', pcard.channel);
  ok('  it carries the page the agent actually opens', pcard.programUrl === 'https://scoutcorp.example/athletes', pcard);
  ok('  it invents NO contact name or phone',
    pcard.contactName === null && pcard.phone === null && pcard.instagram === null, pcard);
  ok('  and it still carries the written pitch', /Two feed posts/.test(pcard.dmText), pcard.dmText);
  await P.query(`DELETE FROM social_brands WHERE brand='Scoutcorp'`).catch(() => {});

  // ── A CANDIDATE THAT CANNOT SUCCEED DOES NOT GET A SLOT ───────────────────
  // Jeremiah Wilkinson: twelve attempts, all social or national, nine rejected
  // per attempt as "already holding 1 program application, which is the cap".
  // The cap was known before the slate was built and was applied after -- so
  // program-only brands spent the athlete's attempts on a rejection that was
  // certain, and the local lane (241 businesses) never got a turn.
  {
    // nationalCandidates takes programUrl from the social_brands INDEX row that
    // matches the comp by name -- never from the comp itself. That is exactly how
    // Jeremiah's nine got theirs, so the fixture indexes the page the same way.
    await P.query(`INSERT INTO social_brands
        (brand, category, website, sports, tier_min, tier_max, deal_structure, proof_url, proof_date, active)
        VALUES ('National With Page','apparel','https://nwp.example',ARRAY['all'],0,999999,'cash_code',
                'https://nwp.example/athletes','2026-01-01',true)
        ON CONFLICT DO NOTHING`).catch(() => {});
    const capStore = {
      getSocialBrandPool: async () => ([
        { brand: 'Program Only Co', brandKey: 'programonlyco', proof_url: 'https://programonly.example/athletes', fitScore: 90 },
        { brand: 'DM Possible Co', brandKey: 'dmpossibleco', fitScore: 80 },   // no page: DM route only
      ]),
      getTopNilComps: async () => ([
        { brand: 'National With Page', brandKey: 'nationalwithpage', website: 'https://nwp.example', why: 'signs athletes' },
        { brand: 'Collective No Page', brandKey: 'collectivenopage', why: 'a collective' },
      ]),
      // A handle search already ran for one of the page-less brands and found
      // nothing; asking again would re-spend for the same answer.
      getBrandEvidence: async (key) => (/collectivenopage/.test(key) ? { evidence: { found: false } } : null),
    };
    const capped = await S.assembleSlate(P, { agentId: AG, athlete: BARE, store: capStore, limit: 5,
      heldPrograms: 1, programCap: 1 });
    const names = (sl) => sl.picks.map((p) => p.brand_name);
    ok('with the program slot held, a program-only brand never enters the slate',
      !names(capped).includes('Program Only Co') && !names(capped).includes('National With Page'), names(capped));
    ok('  a page-less brand with no cached answer still enters (one search is how a DM is found)',
      names(capped).includes('DM Possible Co'), names(capped));
    ok('  a page-less brand whose search already found nothing is dropped',
      !names(capped).includes('Collective No Page'), names(capped));
    ok('  and the drops are counted on the slate',
      capped.dropped && capped.dropped.programCapped === 2 && capped.dropped.noHandleCached === 1, capped.dropped);

    const open = await S.assembleSlate(P, { agentId: AG, athlete: BARE, store: capStore, limit: 5,
      heldPrograms: 0, programCap: 1 });
    ok('with the program slot open, program brands enter as before',
      names(open).includes('Program Only Co') && names(open).includes('National With Page'), names(open));
    ok('  and only the cached no-handle brand is dropped',
      open.dropped && open.dropped.programCapped === 0 && open.dropped.noHandleCached === 1, open.dropped);

    const legacy = await S.assembleSlate(P, { agentId: AG, athlete: BARE, store: capStore, limit: 5 });
    ok('a caller that passes no cap gets the old behaviour', names(legacy).includes('Program Only Co'), names(legacy));
    await P.query(`DELETE FROM social_brands WHERE brand='National With Page'`).catch(() => {});

    // ── WHAT EACH LANE RETURNED IS ON THE SLATE ──────────────────────────────
    ok('the slate says how many rows each lane returned',
      open.lanes && open.lanes.local && typeof open.lanes.local.rows === 'number'
      && open.lanes.social === 2 && open.lanes.national === 1, open.lanes);
    ok('  and which market key the local lane used', open.lanes.local.marketKey === (BARE.marketKey || null), open.lanes.local);
  }

  // ── "EXHAUSTED" IS NOT SAID OF A POOL THAT IS NOT THERE ───────────────────
  // An athlete with a market key and NO rows under it is not a worked-out
  // market; it is a pool filed under a different key. Different fix, different
  // sentence.
  {
    const bare = { getSocialBrandPool: async () => [], getTopNilComps: async () => [] };
    const ghost = Object.assign({}, ATH, { id: 'scout-ghost', marketKey: 'nowhere-at-all, zz', market: 'Nowhere At All, ZZ', hasLocalMarket: true });
    const sl = await S.assembleSlate(P, { agentId: AG, athlete: ghost, store: bare, limit: 5 });
    ok('a market key with no pool rows is reported as no-pool-for-key, not exhausted',
      sl.emptyReason === S.EMPTY.NO_POOL_FOR_KEY, sl.emptyReason);
    ok('  the text names the migration script', /migrate-market-pool-key/.test(sl.emptyText), sl.emptyText);
    ok('  and the slate records zero pool rows under that key',
      sl.lanes && sl.lanes.local.poolRowsUnderKey === 0, sl.lanes);
  }

  await wipe();
  await P.query(`DELETE FROM deal_comps WHERE id=990001`).catch(() => {});
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
