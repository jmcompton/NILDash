'use strict';
// Runs from a checkout on any machine: repo-relative paths, overridable Postgres
// settings, and a startup wait the runner can shorten once the schema is up.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/slateshape.js       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── WHAT THE FIVE LOOK LIKE, NOT JUST HOW THEY SCORED ───────────────────────
//
// Three things the slate had no opinion about, and the shape of the morning was
// the worse for each:
//
//   NOTHING WENT DOWN. Every rule was additive -- fit, proximity, the school
//   signal, NIL-active. An agent could skip nine coffee shops and be handed a
//   tenth, because the only memory was "has this athlete been offered this
//   exact business" and a skip did not even write that.
//
//   FIVE CARDS COULD BE ONE PITCH. The only shape rule was three per LANE, and
//   three restaurants, a coffee shop and a bar is five local cards inside that
//   cap. The agent writes the same message five times.
//
//   EVIDENCE WAS A NUDGE. "Sponsors the high school team" was worth a few
//   points against a base of fifty, so a business that has never spent a dollar
//   on marketing could out-rank one that has on an unrelated margin.
//
// The fixtures below are built so each rule is the ONLY thing that could have
// produced the outcome: same lane, same pool, fit ordered by fitHint, and one
// variable moved at a time.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const S = require(ROOT + 'server/services/scout.js');
const BC = require(ROOT + 'server/services/businessCategory.js');
const Closer = require(ROOT + 'server/services/closer.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

const AG = 'sh-agent', ATH = 'sh-ath', ATH2 = 'sh-ath2';
const MK = 'shapetown, al';
const names = (sl) => sl.picks.map((p) => p.brand_name);

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const wipe = async () => {
    for (const t of ['card_skips', 'outreach_queue', 'outreach_logs', 'brand_engagement', 'deals', 'athletes']) {
      await P.query(`DELETE FROM ${t} WHERE agent_id = $1`, [AG]).catch(() => {});
    }
    await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [MK]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  };
  await wipe();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'Shape','sh@x.com','x','agent')`, [AG]);
  for (const id of [ATH, ATH2]) {
    await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3::jsonb)`,
      [id, AG, JSON.stringify({ name: 'Shape Athlete', school: 'Shapetown University' })]);
  }

  // The market pool, with the category and the evidence the scan knew. Ordered
  // so the "best" five by name are all one category, which is the monoculture
  // the diversity rule exists to break.
  const pool = [
    ['Shape Diner', 'restaurant', true], ['Shape Grill', 'restaurant', true],
    ['Shape Kitchen', 'restaurant', true], ['Shape Cantina', 'restaurant', true],
    ['Shape Taqueria', 'restaurant', true],
    ['Shape Barbers', 'salon', true], ['Shape Fitness', 'gym', true],
    ['Shape Motors', 'dealership', true], ['Shape Roasters', 'coffee', true],
  ];
  for (const [brand, cat, ev] of pool) {
    await P.query(
      `INSERT INTO market_business_seen (market_key, brand, category, has_evidence)
       VALUES ($1,$2,$3,$4) ON CONFLICT (market_key, brand) DO UPDATE
         SET category = EXCLUDED.category, has_evidence = EXCLUDED.has_evidence`,
      [MK, brand, cat, ev]);
  }
  const A = (over) => Object.assign({ id: ATH, school: 'Shapetown University',
    hasLocalMarket: true, marketKey: MK, market: 'Shapetown, AL' }, over || {});

  // ── 1. THE CATEGORY IS READ FROM THE POOL, NOT GUESSED ──────────────────
  OUT.push('-- the pool carries what the scan knew --');
  const lc = await S.localCandidates(P, { agentId: AG, athlete: A(), limit: 9 });
  ok('every market-pool row carries its category', lc.rows.every((r) => !!r.category), lc.rows.map((r) => r.category));
  ok('  and its evidence flag', lc.rows.every((r) => r.has_evidence === true), lc.rows.map((r) => r.has_evidence));
  ok('the normaliser agrees with the stored value', BC.normalise('Coffee Shop') === 'coffee'
    && BC.normalise('meal_takeaway') === 'restaurant' && BC.normalise('hair_care') === 'salon');
  ok('AN UNKNOWN CATEGORY IS NULL, never a bucket', BC.normalise('Rama Jama\'s') === null
    && BC.categoryOf({ brand_name: 'Nothing Obvious LLC' }).category === null);

  // ── 2. FIVE CARDS, THREE KINDS ──────────────────────────────────────────
  //
  // THE RESTAURANTS HAVE TO ACTUALLY WIN, or this proves nothing. Every
  // market-pool row scores the same 56, and a tie is broken by the pool's own
  // ORDER BY last_seen_at DESC -- so the restaurants are made the most recently
  // seen and take the whole top of the ranking. Only the spread rule can break
  // that up, which is the claim being tested.
  //
  // NOT via the 'shown' pool, which would have been the obvious lever: those
  // rows come from brand_engagement, which has no category column at all, so a
  // shown candidate's category can only ever be inferred from its name. That is
  // a real gap and it is asserted further down rather than papered over here.
  OUT.push('', '-- the five cover at least three kinds of business --');
  for (const [i, b] of ['Shape Diner', 'Shape Grill', 'Shape Kitchen', 'Shape Cantina', 'Shape Taqueria'].entries()) {
    await P.query(`UPDATE market_business_seen SET last_seen_at = NOW() - ($3 || ' seconds')::interval
                    WHERE market_key = $1 AND brand = $2`, [MK, b, String(i)]);
  }
  await P.query(`UPDATE market_business_seen SET last_seen_at = NOW() - INTERVAL '1 day'
                  WHERE market_key = $1 AND category <> 'restaurant'`, [MK]);
  const rankOnly = await S.assembleSlate(P, { agentId: AG, athlete: A(), store, limit: 5, explain: true });
  const topFive = (rankOnly.considered || []).slice(0, 5);
  ok('on rank alone the top five ARE all restaurants',
    topFive.length === 5 && topFive.every((c) => c.category === 'restaurant'),
    topFive.map((c) => c.brand + ':' + c.category + ':' + c.fit));
  let sl = rankOnly;
  ok('five picks', sl.picks.length === 5, names(sl));
  ok('THEY ARE NOT ALL RESTAURANTS', sl.shape.categories >= S.MIN_CATEGORIES,
    { categories: sl.shape.categories, list: sl.shape.categoryList, picks: names(sl) });
  ok('  the best restaurant still keeps its seat', names(sl).includes(topFive[0].brand), names(sl));
  ok('  and the slate says how many seats the spread rule placed',
    sl.shape.spreadPicks >= 2, sl.shape);
  ok('  and the slate reports the spread it achieved', Array.isArray(sl.shape.categoryList)
    && sl.shape.categoryList.length === sl.shape.categories, sl.shape);
  ok('  the top-ranked candidate still gets a seat', sl.picks.length > 0, names(sl));
  ok('  no duplicate businesses', new Set(names(sl)).size === names(sl).length, names(sl));

  // A market with only one kind of business cannot be made diverse, and must
  // not be padded to look as though it was.
  await P.query(`DELETE FROM market_business_seen WHERE market_key = $1 AND category <> 'restaurant'`, [MK]);
  const thinMkt = await S.assembleSlate(P, { agentId: AG, athlete: A({ id: ATH2 }), store, limit: 5 });
  ok('a single-category market is reported, not padded',
    thinMkt.shape.categories === 1 && /only 1 distinct category/.test(thinMkt.shape.spreadShortfall || ''),
    thinMkt.shape);
  ok('  and it still fills the slate', thinMkt.picks.length === 5, names(thinMkt));
  for (const [brand, cat, ev] of pool) {
    await P.query(`INSERT INTO market_business_seen (market_key, brand, category, has_evidence)
                   VALUES ($1,$2,$3,$4) ON CONFLICT (market_key, brand) DO UPDATE
                     SET category = EXCLUDED.category, has_evidence = EXCLUDED.has_evidence`,
      [MK, brand, cat, ev]);
  }

  // ── 3. THE SOCIAL SEAT ──────────────────────────────────────────────────
  OUT.push('', '-- one social brand when the following justifies it --');
  const socialStore = Object.assign(Object.create(store), {
    getSocialBrandPool: async () => ([{ brand: 'Shape Social Co', brandKey: 'dom:shapesocial.example',
      fitScore: 1, whyFits: 'runs a programme', proof_url: 'https://shapesocial.example/athletes',
      website: 'https://shapesocial.example', category: 'apparel' }]),
    getTopNilComps: async () => [],
  });
  // Deliberately fitScore 1: bottom of the ranking. Without a reserved seat a
  // deep local market buries it, which is exactly what used to happen.
  const big = await S.assembleSlate(P, { agentId: AG, athlete: A({ instagram: 20000, tiktok: 5000 }), store: socialStore, limit: 5 });
  ok('an athlete over the reach floor gets a social card',
    names(big).includes('Shape Social Co'), { picks: names(big), shape: big.shape });
  ok('  even though it ranks last on fit', big.shape.socialSeat === 'Shape Social Co', big.shape);
  ok('  and the reach that qualified them is recorded', big.shape.reach === 25000 && big.shape.socialEligible === true, big.shape);

  const small = await S.assembleSlate(P, { agentId: AG, athlete: A({ id: ATH2, instagram: 400, tiktok: 100 }), store: socialStore, limit: 5 });
  ok('AN ATHLETE UNDER THE FLOOR DOES NOT, so the slot goes to a local business',
    small.shape.socialEligible === false, { reach: small.shape.reach, floor: S.SOCIAL_MIN_REACH });
  ok('  the floor is the one the index bands against', S.SOCIAL_MIN_REACH === 5000, S.SOCIAL_MIN_REACH);
  ok('  reach is instagram + tiktok, the same figure the social pool uses',
    small.shape.reach === 500, small.shape.reach);

  // ── 4. EVIDENCE IS A SORT KEY, NOT A BONUS ──────────────────────────────
  OUT.push('', '-- a thin candidate only fills a slot nothing better was left for --');
  await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [MK]);
  // Two evidenced, three thin. The thin ones are given the BETTER fit hints via
  // the shown pool's +4, so only the sort key can put them last.
  for (const [brand, cat, ev] of [['Ev One', 'coffee', true], ['Ev Two', 'gym', true],
    ['Thin One', 'salon', false], ['Thin Two', 'retail', false], ['Thin Three', 'bar', false]]) {
    await P.query(`INSERT INTO market_business_seen (market_key, brand, category, has_evidence)
                   VALUES ($1,$2,$3,$4) ON CONFLICT (market_key, brand) DO UPDATE
                     SET category = EXCLUDED.category, has_evidence = EXCLUDED.has_evidence`,
      [MK, brand, cat, ev]);
  }
  sl = await S.assembleSlate(P, { agentId: AG, athlete: A(), store, limit: 5 });
  const order = names(sl);
  ok('EVERY EVIDENCED CANDIDATE COMES BEFORE EVERY THIN ONE',
    order.indexOf('Ev One') < order.indexOf('Thin One')
    && order.indexOf('Ev Two') < order.indexOf('Thin One'), order);
  ok('  the thin ones are marked as such', sl.picks.filter((p) => p.thin).length === 3,
    sl.picks.map((p) => p.brand_name + ':' + p.thin));
  ok('  and the evidenced ones are not', sl.picks.filter((p) => p.brand_name.startsWith('Ev')).every((p) => !p.thin));
  ok('  the slate counts them so the morning report can say so', sl.shape.thin === 3, sl.shape);
  ok('the thin note says it filled a slot rather than that it is a good fit',
    /nothing stronger was left/.test(S.THIN_NOTE) && /thin candidate/.test(S.THIN_NOTE), S.THIN_NOTE);

  // UNKNOWN IS NOT THIN. A row written before has_evidence existed carries NULL.
  await P.query(`UPDATE market_business_seen SET has_evidence = NULL WHERE market_key = $1 AND brand = 'Thin One'`, [MK]);
  sl = await S.assembleSlate(P, { agentId: AG, athlete: A(), store, limit: 5 });
  const unk = sl.picks.find((p) => p.brand_name === 'Thin One');
  ok('a candidate we never checked is NOT called thin', unk && unk.thin === false, unk && { thin: unk.thin, evidenced: unk.evidenced });
  ok('  it ranks with the evidenced ones rather than being punished for a missing column',
    names(sl).indexOf('Thin One') < names(sl).indexOf('Thin Two'), names(sl));
  await P.query(`UPDATE market_business_seen SET has_evidence = false WHERE market_key = $1 AND brand = 'Thin One'`, [MK]);

  // ── 5. A SKIP IS RECORDED, AND IT IS READ BACK ──────────────────────────
  OUT.push('', '-- skip history --');
  await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [MK]);
  for (const [brand, cat] of [['Skip Cafe A', 'coffee'], ['Skip Cafe B', 'coffee'], ['Skip Cafe C', 'coffee'],
    ['Keep Gym', 'gym'], ['Keep Salon', 'salon'], ['Keep Motors', 'dealership']]) {
    await P.query(`INSERT INTO market_business_seen (market_key, brand, category, has_evidence)
                   VALUES ($1,$2,$3,true) ON CONFLICT (market_key, brand) DO UPDATE SET category = EXCLUDED.category`,
      [MK, brand, cat]);
  }
  const before = await S.assembleSlate(P, { agentId: AG, athlete: A(), store, limit: 6 });
  ok('before any skip, a cafe is on the slate', names(before).includes('Skip Cafe A'), names(before));

  // skipDraft is the ONE path both the dashboard and the email take, so the
  // recording is exercised through it rather than by inserting a row.
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status)
                 VALUES ('sh-log-1',$1,$2,'Skip Cafe A','Hi','<p>x</p>','draft')`, [AG, ATH]);
  // THE IDENTITY IS THE REAL ONE, not a made-up string. A market-pool business
  // has no brand_key, so brandIdentity mints "name:<name>@<market>" for it and
  // that is what insertCard writes; a fixture that invents a different shape
  // would record a skip that could never match a candidate again.
  const BI = require(ROOT + 'server/services/brandIdentity.js');
  const cafeAId = BI.identitiesOf({ brand_name: 'Skip Cafe A' }, { market: MK })[0].key;
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state,
                   identity_key, business_category, lane, outreach_log_id)
                 VALUES ($1,$2,1,'k-cafe-a','Skip Cafe A','dm','queued',$3,'coffee','local','sh-log-1')`, [AG, ATH, cafeAId]);
  const sk = await Closer.skipDraft(P, AG, 'sh-log-1');
  ok('skipDraft still reports the skip', sk.ok === true && sk.skipped === true, sk);
  const rec = (await P.query(`SELECT * FROM card_skips WHERE agent_id = $1 ORDER BY id DESC LIMIT 1`, [AG])).rows[0];
  ok('THE SKIP IS RECORDED, which nothing used to do', !!rec, rec);
  ok('  with the business identity the card was written under',
    rec && rec.identity_key === cafeAId, { got: rec && rec.identity_key, want: cafeAId });
  ok('  the category', rec && rec.category === 'coffee', rec);
  ok('  the athlete', rec && rec.athlete_id === ATH, rec);
  ok('  and the agent', rec && rec.agent_id === AG, rec);

  // ── THE QUEUE ROW GOES, SO ONLY THE SKIP CAN DO THE EXCLUDING ──────────
  // localCandidates already drops any brand with an outreach_queue row for this
  // athlete, in ANY state -- including the 'skipped' one skipDraft just wrote.
  // Leaving it in place would make this assertion pass whether card_skips
  // worked or not, which is not a test of anything. Removed, so the ONLY thing
  // that can keep Skip Cafe A off the slate is the skip record itself.
  await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1 AND brand_name = 'Skip Cafe A'`, [AG]);
  const after = await S.assembleSlate(P, { agentId: AG, athlete: A(), store, limit: 6 });
  ok('THE EXACT BUSINESS NEVER COMES BACK for this athlete, on the skip alone',
    !names(after).includes('Skip Cafe A'), names(after));
  ok('  and it is matched on identity, not on the display name',
    (await store.loadSkipSignals(AG, ATH)).identities.has(cafeAId), cafeAId);
  const catPen = after.picks.find((p) => p.brand_name === 'Skip Cafe B');
  ok('  and the CATEGORY is penalised for this athlete',
    catPen && catPen.skipPenalty.athlete === S.SKIP_ATHLETE_PER, catPen && catPen.skipPenalty);
  ok('  the penalty is the weight this file publishes', S.SKIP_ATHLETE_PER === 8 && S.SKIP_ATHLETE_MAX === 16,
    [S.SKIP_ATHLETE_PER, S.SKIP_ATHLETE_MAX]);

  // Three skips of a kind is a preference, and it is capped there.
  for (const [i, brand] of [['2', 'Skip Cafe B'], ['3', 'Skip Cafe C'], ['4', 'Extra Cafe']]) {
    await P.query(`INSERT INTO card_skips (agent_id, athlete_id, identity_key, brand_name, category, lane)
                   VALUES ($1,$2,$3,$4,'coffee','local')`, [AG, ATH, 'localname:x' + i, brand]);
  }
  await P.query(`INSERT INTO market_business_seen (market_key, brand, category, has_evidence)
                 VALUES ($1,'Fresh Cafe','coffee',true) ON CONFLICT DO NOTHING`, [MK]);
  const capped = await S.assembleSlate(P, { agentId: AG, athlete: A(), store, limit: 6 });
  const fc = capped.picks.find((p) => p.brand_name === 'Fresh Cafe');
  ok('FOUR SKIPS DO NOT COMPOUND PAST THE CAP',
    fc && fc.skipPenalty.athlete === S.SKIP_ATHLETE_MAX, fc && fc.skipPenalty);
  ok('  so the category is discouraged, not banned', !!fc, names(capped));
  ok('  a gym is ranked above a cafe now', names(capped).indexOf('Keep Gym') < names(capped).indexOf('Fresh Cafe'), names(capped));

  // ── 6. THE AGENT-WIDE PENALTY IS SMALLER, AND IT DECAYS ─────────────────
  OUT.push('', '-- the roster-wide half is smaller and fades --');
  const sig = await store.loadSkipSignals(AG, ATH);
  ok('the agent-wide tally is decayed, not counted', (sig.agentCats.get('coffee') || 0) > 3.9
    && (sig.agentCats.get('coffee') || 0) <= 4.0001, sig.agentCats.get('coffee'));
  // Age four of them by three half-lives: each should now be worth an eighth.
  await P.query(`UPDATE card_skips SET skipped_at = NOW() - INTERVAL '63 days' WHERE agent_id = $1`, [AG]);
  const aged = await store.loadSkipSignals(AG, ATH);
  ok('A SKIP THREE HALF-LIVES OLD IS WORTH AN EIGHTH',
    Math.abs((aged.agentCats.get('coffee') || 0) - 0.5) < 0.05, aged.agentCats.get('coffee'));
  ok('  so one bad week cannot kill a category forever',
    (aged.agentCats.get('coffee') || 0) * S.SKIP_AGENT_PER < 2, (aged.agentCats.get('coffee') || 0) * S.SKIP_AGENT_PER);
  ok('  the athlete-level tally does NOT decay, because it is a preference',
    aged.athleteCats.get('coffee') === 4, aged.athleteCats.get('coffee'));
  ok('  and the roster-wide weight is the smaller of the two',
    S.SKIP_AGENT_PER < S.SKIP_ATHLETE_PER && S.SKIP_AGENT_MAX < S.SKIP_ATHLETE_MAX,
    [S.SKIP_AGENT_PER, S.SKIP_AGENT_MAX]);

  // A SKIP BY ANOTHER AGENT IS NOT MY SIGNAL. Same rule as the sponsor signals.
  await P.query(`INSERT INTO card_skips (agent_id, athlete_id, identity_key, brand_name, category)
                 VALUES ('sh-other','sh-other-ath','localname:other','Other Cafe','coffee')`);
  const mineOnly = await store.loadSkipSignals(AG, ATH);
  ok('another agent\'s skips are not read into mine',
    Math.abs((mineOnly.agentCats.get('coffee') || 0) - (aged.agentCats.get('coffee') || 0)) < 0.01,
    [mineOnly.agentCats.get('coffee'), aged.agentCats.get('coffee')]);
  await P.query(`DELETE FROM card_skips WHERE agent_id = 'sh-other'`);

  // ── 7. A STRONG BUSINESS STILL CLEARS A PENALISED CATEGORY ──────────────
  // The point of a recoverable penalty: the agent is saying "not this kind,
  // usually", not "never".
  OUT.push('', '-- the penalty is recoverable, on purpose --');
  await P.query(`INSERT INTO deals (id, agent_id, athlete_id, data) VALUES
    ('sh-d1',$1,$2,'{"stage":"Closed","brand":"Fresh Cafe"}'::jsonb)
    ON CONFLICT (id) DO NOTHING`, [AG, ATH]);
  const rescued = await S.assembleSlate(P, { agentId: AG, athlete: A(), store, limit: 6 });
  const fc2 = rescued.picks.find((p) => p.brand_name === 'Fresh Cafe');
  // THE FLOOR IS SET BY WHAT HAS TO CLEAR IT. Asserted as the invariant rather
  // than as an ordering, because an ordering depends on whatever else is in the
  // fixture and this is a rule about the weights themselves: our two strongest
  // facts about a SPECIFIC business must both out-weigh a dislike of its KIND.
  ok('THE CAP IS CLEARABLE BY OUR STRONGEST EVIDENCE ABOUT THE BUSINESS',
    S.SKIP_ATHLETE_MAX < S.SIGNAL_WEIGHT['agent-closed-at-school'],
    { cap: S.SKIP_ATHLETE_MAX, closed: S.SIGNAL_WEIGHT['agent-closed-at-school'] });
  ok('  and by a logged NIL deal', S.SKIP_ATHLETE_MAX < 30, S.SKIP_ATHLETE_MAX);
  ok('  but NOT by a publicly reported one, which is only press',
    S.SKIP_ATHLETE_MAX > S.SIGNAL_WEIGHT['reported-deal-at-school'],
    [S.SKIP_ATHLETE_MAX, S.SIGNAL_WEIGHT['reported-deal-at-school']]);
  ok('a business the agent closed at this school carries its signal past the penalty',
    fc2 && fc2.sponsorSignal && fc2.sponsorSignal.kind === 'agent-closed-at-school',
    fc2 && { signal: fc2.sponsorSignal, fit: fc2.fit, pen: fc2.skipPenalty });
  ok('  and it outranks the cafes with no signal and the same penalty',
    names(rescued).indexOf('Fresh Cafe') < names(rescued).indexOf('Skip Cafe B'), names(rescued));
  ok('  by exactly the signal, net of the identical category penalty',
    (() => {
      const plain = rescued.picks.find((p) => p.brand_name === 'Skip Cafe B');
      return fc2 && plain && Math.abs((fc2.fit - plain.fit) - S.SIGNAL_WEIGHT['agent-closed-at-school']) < 0.01;
    })(), rescued.picks.map((p) => p.brand_name + ':' + p.fit));

  // ── 8. THE CARD ITSELF SAYS IT IS THIN ──────────────────────────────────
  // Marking a candidate thin in the ranker is half a feature: the agent is the
  // one deciding whether to spend a morning on it, so the whole path from the
  // column to the rendered line is pinned. A ranking flag that never reaches
  // the card is a flag nobody acts on.
  OUT.push('', '-- the thin marking reaches the agent --');
  const fs2 = require('fs');
  const act = fs2.readFileSync(ROOT + 'server/services/actionable.js', 'utf8');
  const hq = fs2.readFileSync(ROOT + 'server/services/homeQueue.js', 'utf8');
  const html = fs2.readFileSync(ROOT + 'public/index.html', 'utf8');
  const job = fs2.readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the job writes it to the row', /business_category, thin, thin_note\)/.test(job)
    && /card\.thin === true/.test(job), null);
  ok('the card query selects it', /q\.business_category, q\.thin, q\.thin_note/.test(act));
  ok('  the card shape carries it', /thin: r\.thin === true/.test(act));
  ok('  Home passes it to the page', /thin: c\.thin === true/.test(hq));
  ok('  and the page renders the note', /c\.thin && c\.thinNote/.test(html));
  ok('A NON-THIN CARD CARRIES NO NOTE, so the marking means something',
    /thinNote: r\.thin === true \? \(r\.thin_note \|\| null\) : null/.test(act)
    && /thinNote: c\.thin === true \? \(c\.thinNote \|\| null\) : null/.test(hq));

  await wipe();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await P.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}

main().catch((e) => { console.error('slateshape: FAILED', e); process.exit(1); });
