'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js          every suite, against the committed baseline
//   node tests/deals.js        just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── THE DEAL IS LOGGED, AND THE BUSINESS CARRIES WHAT IT HAS DONE ──────────
//
// Part 1. One button wherever a pitch lives: two optional questions, then the
// deal moves to the EXISTING Closed stage through services/pipeline, lands in
// the EXISTING deal_outcomes table the fit model reads, and marks the EXISTING
// brand_engagement ledger closed. No second deal store, and an agent can take
// it back.
//
// Part 2. That ledger is what earns a business its flag, across every agent:
// NIL-active once a deal has been logged with it, Responded once someone
// there wrote back. Matched by Google Place ID, then by root domain, NEVER by
// name -- there are four Mellow Mushrooms in one state. The badge says the
// business has done NIL and nothing else: no agent, no athlete, no value, no
// contact.

const store = require(REPO + 'server/store.js');
const DL = require(REPO + 'server/services/dealLog.js');
const BF = require(REPO + 'server/services/brandFlags.js');
const PIPE = require(REPO + 'server/services/pipeline.js');
const MB = require(REPO + 'server/services/myBrands.js');
const { ACTIONS } = require(REPO + 'server/services/assistantActions.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');

const A1 = 'dl-agent-one', A2 = 'dl-agent-two';
const ATH1 = 'dl-ath-1', ATH2 = 'dl-ath-2';
// One business, two agents: the same Google Place ID is what makes it the same
// business. RAMA is local with a place id; MERCH is national with a domain.
const PLACE = 'place:ChIJdl-rama-jamas';
const DOMAIN = 'dom:merchco.com';

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await DL.ensureTable(P);
  const clean = async () => {
    for (const a of [A1, A2]) {
      await P.query(`DELETE FROM deal_outcomes WHERE agent_id = $1`, [a]).catch(() => {});
      await P.query(`DELETE FROM outreach_logs WHERE agent_id = $1`, [a]).catch(() => {});
      await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [a]).catch(() => {});
      await P.query(`DELETE FROM brand_engagement WHERE agent_id = $1`, [a]).catch(() => {});
      await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [a]).catch(() => {});
      await P.query(`DELETE FROM users WHERE id = $1`, [a]).catch(() => {});
    }
    for (const t of [ATH1, ATH2]) {
      await P.query(`DELETE FROM athlete_self_deals WHERE athlete_id = $1`, [t]).catch(() => {});
      await P.query(`DELETE FROM brand_engagement WHERE athlete_id = $1`, [t]).catch(() => {});
    }
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'Agent One','dl1@x.com','x','agent'), ($2,'Agent Two','dl2@x.com','x','agent')`, [A1, A2]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
    [ATH1, A1, JSON.stringify({ name: 'Kaleb Carter', school: 'University of Alabama', sport: 'football', schoolTier: 'p4-top10', instagram: 12000 })]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
    [ATH2, A2, JSON.stringify({ name: 'Other Athlete', school: 'Auburn University', sport: 'baseball' })]);

  // ════ PART 1: DEAL LOGGING ════════════════════════════════════════════
  OUT.push('-- part 1: the deal is signed --');
  const logged = await DL.logDeal(P, { agentId: A1, athleteId: ATH1, brandName: "Rama Jama's", brandKey: PLACE, value: 500, deliverable: 'two Instagram posts' });
  ok('a deal logs and comes back with what was recorded', logged.ok === true && logged.brand === "Rama Jama's" && logged.value === 500 && logged.deliverable === 'two Instagram posts', logged);

  const dealRow = (await P.query(`SELECT * FROM athlete_self_deals WHERE athlete_id = $1`, [ATH1])).rows[0];
  ok('  the Pipeline row is on the EXISTING Closed stage, through services/pipeline', dealRow && PIPE.normalizeStage(dealRow.stage) === 'Closed' && PIPE.STAGES.includes('Closed'), dealRow && dealRow.stage);
  ok('  and the stage history says when and why', dealRow && Array.isArray(dealRow.stage_history) && dealRow.stage_history.some((h) => /Deal signed/.test(h.note || '')), dealRow && dealRow.stage_history);
  const outcome = (await P.query(`SELECT * FROM deal_outcomes WHERE agent_id = $1`, [A1])).rows[0];
  ok('  the EXISTING deal_outcomes table carries the brand, athlete, agent, date, value and deliverable',
    outcome && outcome.brand === "Rama Jama's" && outcome.athlete_id === ATH1 && outcome.agent_id === A1
    && Number(outcome.deal_value) === 500 && outcome.deliverable === 'two Instagram posts' && !!outcome.closed_at, outcome);
  ok('  with the athlete facts the fit model learns from', outcome && outcome.school === 'University of Alabama' && outcome.school_tier === 'p4-top10' && outcome.sport === 'football' && outcome.follower_band === '5k-25k', outcome);
  ok('  and the business identity, so a flag can cross agents', outcome && outcome.brand_key === PLACE, outcome && outcome.brand_key);
  const ledger = (await P.query(`SELECT * FROM brand_engagement WHERE athlete_id = $1`, [ATH1])).rows[0];
  ok('  the EXISTING brand ledger is marked closed', ledger && ledger.state === 'closed', ledger);

  // Both answers optional.
  const bare = await DL.logDeal(P, { agentId: A1, athleteId: ATH1, brandName: 'Bare Bones Barbers', brandKey: 'place:dl-bare' });
  ok('both questions can be skipped: a deal with no value and no deliverable still logs', bare.ok === true && bare.value === null && bare.deliverable === null, bare);
  const bareRow = (await P.query(`SELECT deal_value, deliverable FROM deal_outcomes WHERE id = $1`, [bare.id])).rows[0];
  ok('  and a skipped value is NULL, never 0 -- deal_outcomes is averaged', bareRow && bareRow.deal_value === null, bareRow);
  const junk = await DL.logDeal(P, { agentId: A1, athleteId: ATH1, brandName: 'Junk Value Co', value: 'about five hundred-ish' });
  ok('  a value that is not a number is dropped rather than stored wrong', junk.ok === true && junk.value === null, junk);

  // Ownership.
  const notMine = await DL.logDeal(P, { agentId: A2, athleteId: ATH1, brandName: 'Someone Elses Deal' });
  ok('a deal cannot be logged against another agent\'s athlete', notMine.ok === false && /not on your roster/.test(notMine.error), notMine);
  const noBrand = await DL.logDeal(P, { agentId: A1, athleteId: ATH1, brandName: '  ' });
  ok('  and a deal with no business is refused in plain words', noBrand.ok === false && /Which business/.test(noBrand.error), noBrand);

  // Undo.
  OUT.push('', '-- part 1: undo --');
  const notYours = await DL.undoDeal(P, { agentId: A2, id: logged.id });
  ok('nobody undoes another agent\'s deal', notYours.ok === false && /not one of yours/.test(notYours.error), notYours);
  const undone = await DL.undoDeal(P, { agentId: A1, id: logged.id });
  ok('an agent can undo a deal logged by mistake', undone.ok === true && undone.brand === "Rama Jama's", undone);
  ok('  the outcome row is REMOVED, not left in an average', (await P.query(`SELECT COUNT(*)::int n FROM deal_outcomes WHERE id = $1`, [logged.id])).rows[0].n === 0);
  const backRow = (await P.query(`SELECT stage FROM athlete_self_deals WHERE athlete_id = $1 AND brand_name = $2`, [ATH1, "Rama Jama's"])).rows[0];
  ok('  the Pipeline row comes off Closed', backRow && PIPE.normalizeStage(backRow.stage) !== 'Closed', backRow);
  const backLedger = (await P.query(`SELECT state FROM brand_engagement WHERE athlete_id = $1 AND brand_name = $2`, [ATH1, "Rama Jama's"])).rows[0];
  ok('  and the ledger goes back to contacted, because that business never replied', backLedger && backLedger.state === 'contacted', backLedger);
  const twice = await DL.undoDeal(P, { agentId: A1, id: logged.id });
  ok('  undoing twice says so rather than pretending', twice.ok === false && /already undone|not one of yours/.test(twice.error), twice);

  // A business that DID reply goes back to responded, not further.
  await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,status,sent_to_email,replied_at)
                 VALUES ('dl-log-1',$1,$2,'Replier Cafe','Hi','replied','x@r.example',NOW())`, [A1, ATH1]);
  const repl = await DL.logDeal(P, { agentId: A1, athleteId: ATH1, brandName: 'Replier Cafe', value: 250 });
  await DL.undoDeal(P, { agentId: A1, id: repl.id });
  const replLedger = (await P.query(`SELECT state FROM brand_engagement WHERE athlete_id = $1 AND brand_name = 'Replier Cafe'`, [ATH1])).rows[0];
  ok('undo never goes back further than the truth: a business that replied stays responded', replLedger && replLedger.state === 'responded', replLedger);

  // The counter, admin only.
  OUT.push('', '-- part 1: the counter --');
  const c = await DL.counts(P);
  ok('the counter totals deals, value and this month', c.deals >= 2 && c.totalValue >= 0 && c.dealsThisMonth >= 2, c);
  ok('  and says how many had no value, so the total is not read as the whole book', c.unpriced >= 1 && c.priced + c.unpriced === c.deals, c);
  const idx = src('server/index.js');
  ok('the counter is admin only and nothing public reads it', /app\.get\('\/api\/admin\/deal-counter', requireAuth/.test(idx) && /_inboundAdminOk\(user\)/.test(idx.slice(idx.indexOf("'/api/admin/deal-counter'"), idx.indexOf("'/api/admin/deal-counter'") + 400)));
  ok('  and the admin page shows it', /loadDealCounter\(\)/.test(src('public/admin.html')) && /deals logged/.test(src('public/admin.html')));

  // The assistant.
  OUT.push('', '-- part 1: "Kaleb signed with Rama Jama\'s for $500" --');
  ok('the assistant has a log_deal tool with both answers optional', !!ACTIONS.log_deal && ACTIONS.log_deal.input.required.join(',') === 'athlete,brand' && !!ACTIONS.log_deal.input.properties.value && !!ACTIONS.log_deal.input.properties.deliverable);
  const chk = ACTIONS.log_deal.check({ athlete: 'Kaleb', brand: "Rama Jama's", value: 500 });
  ok('  it reads the athlete, the business and the value out of the sentence', chk.args && chk.args.athlete === 'Kaleb' && chk.args.brand === "Rama Jama's" && chk.args.value === 500, chk);
  ok('  a nonsense value is dropped rather than stored', ACTIONS.log_deal.check({ athlete: 'K', brand: 'B', value: -5 }).args.value === undefined);
  ok('  and it asks who signed when the athlete is missing', /Which athlete/.test(ACTIONS.log_deal.check({ brand: 'B' }).error || ''));
  const ran = await ACTIONS.log_deal.run({ athlete: 'Kaleb Carter', brand: "Rama Jama's", value: 500 }, { agentId: A1 });
  ok('  it logs the deal and confirms in words', ran.data.logged === true && /Logged: Kaleb Carter signed with Rama Jama's for \$500/.test(ran.say), ran.say);
  ok('  and offers the way back', /undo/i.test(ran.say), ran.say);
  const missing = await ACTIONS.log_deal.run({ athlete: 'Nobody Here', brand: 'X' }, { agentId: A1 });
  ok('  an athlete not on the roster is a question, not a wrong deal', missing.data.logged === false && /could not find Nobody Here/.test(missing.say), missing.say);
  const undoRan = await ACTIONS.undo_deal.run({ brand: "Rama Jama's" }, { agentId: A1 });
  ok('  and the chat can undo the last one too', undoRan.data.undone === true, undoRan);

  // The button, in the three places.
  const html = src('public/index.html');
  ok('the Deal signed button is on a sent pitch, a My Brands row and a Pipeline card', (html.match(/dealButtonHtml\(/g) || []).length >= 3 && /dealSignedOpen\(/.test(src('public/pipeline.js')));
  ok('  it asks two optional questions in one small form', /Both answers are optional\. Skip either one\./.test(html) && /deal-form-value/.test(html) && /deal-form-what/.test(html));
  ok('  and the undo is offered where the deal was logged', /function dealUndo\(/.test(html) && /Deal signed \\u2713 Undo|Deal signed ✓ Undo/.test(html));

  // ════ PART 2: NIL-ACTIVE BRAND FLAGS ══════════════════════════════════
  OUT.push('', '-- part 2: what the business has done --');
  ok('a Place ID is a cross-agent identity, and it comes first', BF.crossAgentKeys({ place_id: 'ChIJabc', website: 'https://x.com' })[0] === 'place:ChIJabc');
  ok('  a root domain is the fallback', JSON.stringify(BF.crossAgentKeys({ website: 'https://www.merchco.com/shop' })) === '["dom:merchco.com"]');
  ok('  A NAME IS NEVER AN IDENTITY: two Mellow Mushrooms are not one business',
    BF.crossAgentKeys({ brand_name: 'Mellow Mushroom', brand_key: 'name:mellow-mushroom' }).length === 0
    && BF.crossAgentKeys({ brand_key: 'localname:rama-jamas-tuscaloosa-al' }).length === 0, BF.crossAgentKeys({ brand_name: 'Mellow Mushroom', brand_key: 'name:mellow-mushroom' }));
  ok('  and a business with neither carries no flag at all', BF.crossAgentKeys({ brand_name: 'Corner Shop' }).length === 0);

  // Agent One signs a deal with the place-keyed business and gets a reply
  // from the domain-keyed one.
  const shared = await DL.logDeal(P, { agentId: A1, athleteId: ATH1, brandName: "Rama Jama's", brandKey: PLACE, value: 1500, deliverable: 'an appearance day' });
  ok('agent one logs a deal with the shared business', shared.ok === true, shared);
  await store.markBrandResponded(ATH1, { agentId: A1, brandKey: DOMAIN, brandName: 'MerchCo', source: 'reply' });

  const flags = await BF.flagsFor(P, [
    { brand_name: "Rama Jama's", place_id: 'ChIJdl-rama-jamas' },
    { brand_name: 'MerchCo', website: 'https://merchco.com' },
    { brand_name: 'Never Heard Of', place_id: 'place:dl-nobody' },
    { brand_name: "Rama Jama's" },
  ]);
  ok('a business a deal was logged with is NIL-active', flags[0].nilActive === true && flags[0].responded === true, flags[0]);
  ok('  one that only replied is Responded, not NIL-active', flags[1].responded === true && flags[1].nilActive === false, flags[1]);
  ok('  one that has done neither carries nothing', flags[2].nilActive === false && flags[2].responded === false, flags[2]);
  ok('  AND THE SAME NAME WITH NO PLACE ID CARRIES NOTHING: the name is not the business', flags[3].nilActive === false && flags[3].responded === false, flags[3]);
  ok('the badge is the stronger of the two, in words', BF.badgeFor(flags[0]).label === 'NIL-active' && BF.badgeFor(flags[1]).label === 'Responded to athletes' && BF.badgeFor(flags[2]) === null);
  ok('  a NIL-active business outranks one that replied, which outranks the rest', BF.rankBonus(flags[0]) > BF.rankBonus(flags[1]) && BF.rankBonus(flags[1]) > BF.rankBonus(flags[2]));

  // ── THE PRIVACY TEST ──────────────────────────────────────────────────
  OUT.push('', '-- part 2: agent two sees the badge and nothing else --');
  // Agent Two has never touched this business. Give them a card for it, with
  // the same Place ID, and render their My Brands page.
  await P.query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, why, channel, state, identity_key)
     VALUES ($1,$2,1,$3,'Rama Jama''s','a diner by the stadium','dm','queued',$3)`, [A2, ATH2, PLACE]);
  const page = await MB.pageFor(P, A2, {});
  const row = page.rows.find((r) => /Rama/.test(r.brand));
  ok('agent two sees the badge on a business they have never worked', !!row && row.flags && row.flags.nilActive === true, row && row.flags);
  const dump = JSON.stringify(page);
  ok('  and NOTHING of agent one travels with it: not the agent', dump.indexOf(A1) === -1, dump.slice(0, 200));
  ok('  not the athlete who signed', dump.indexOf('Kaleb') === -1 && dump.indexOf(ATH1) === -1);
  ok('  not the deal value', dump.indexOf('1500') === -1 && dump.indexOf('an appearance day') === -1);
  ok('  not a contact anyone else found', dump.indexOf('x@r.example') === -1);
  ok('  the flag really is two booleans and nothing more', !!row && JSON.stringify(Object.keys(row.flags).sort()) === '["nilActive","responded"]', row && row.flags);
  ok('  and the same page shows agent two their OWN athlete, so the page is not simply empty', page.rows.length > 0 && page.rows.every((r) => r.athleteId === ATH2), page.rows.map((r) => r.athleteId));

  // Ranking, and the admin count.
  OUT.push('', '-- part 2: ranking and the count --');
  const scout = src('server/services/scout.js');
  ok('the nightly slate ranks a NIL-active business higher when it fits the market', /BF\.flagsFrom\(flagIndex, c\)/.test(scout) && /fit \+= BF\.rankBonus\(nilFlags\)/.test(scout));
  ok('  as a nudge on top of fit, never an override', /nudge, not an override/i.test(scout) && /BF\.rankBonus/.test(scout));
  const counts = await BF.counts(P);
  ok('the admin count reports each level', counts.nilActive >= 1 && counts.responded >= counts.nilActive && counts.respondedOnly === counts.responded - counts.nilActive, counts);
  ok('  and says how many businesses can never carry a flag, which is the ceiling on coverage', typeof counts.noIdentity === 'number', counts);
  ok('the admin page shows the flag counts', /loadBrandFlags\(\)/.test(src('public/admin.html')) && /NIL-active/.test(src('public/admin.html')));
  ok('Deal Scan results carry the badge, attached last and alone', /o\.nilFlags = f/.test(idx) && /nilFlags/.test(html));
  ok('My Brands carries it too', /nilBadgeHtml\(r\.flags\)/.test(html) && /attachFlags\(pool, pageRows\)/.test(src('server/services/myBrands.js')));

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await store.pool.end().catch(() => {});
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('deals: FAILED', e); process.exit(1); });
