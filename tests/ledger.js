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
// THE LEDGER LEARNS FROM WHAT CAME BACK.
//
// 'responded' and 'closed' were never written by anything. Three readers asked
// for them -- retirement, the Scout's school-sponsor signal, and the Writer's
// learnedAngles -- and all three got nothing back, for every business, forever.
// This asserts the writes exist, that state only moves forward, and that the
// three readers now see something.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const S = require(ROOT + 'server/services/scout.js');
const PW = require(ROOT + 'server/services/pitchWriter.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'lg-agent', ATH = 'lg-ath1';

const stateOf = async (P, brand) => {
  const r = await P.query(`SELECT state, outcome FROM brand_engagement
                            WHERE athlete_id=$1 AND LOWER(brand_name)=LOWER($2)`, [ATH, brand]);
  return r.rows[0] || null;
};

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    for (const t of ['outreach_queue', 'brand_engagement', 'deals']) {
      await P.query(`DELETE FROM ${t} WHERE agent_id=$1`, [AG]).catch(() => {});
    }
    await P.query(`DELETE FROM athletes WHERE id=$1`, [ATH]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM deal_comps WHERE source IN ('agent-close','lgtest')`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'A','lg@x.com','x','agent')
                 ON CONFLICT DO NOTHING`, [AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
    [ATH, AG, JSON.stringify({ name: 'Ledger Athlete', school: 'Auburn University', sport: 'Football' })]);

  // ── THE WRITE THAT DID NOT EXIST ─────────────────────────────────────────
  await P.query(`INSERT INTO brand_engagement (agent_id,athlete_id,brand_key,brand_name,state,last_shown_at)
                 VALUES ($1,$2,'bk1','Reply Cafe','contacted',NOW())`, [AG, ATH]);
  await store.markBrandResponded(ATH, { agentId: AG, brandName: 'Reply Cafe' });
  ok('a reply advances the ledger to responded', (await stateOf(P, 'Reply Cafe')).state === 'responded',
    await stateOf(P, 'Reply Cafe'));

  // ── STATE ONLY EVER MOVES FORWARD ────────────────────────────────────────
  await store.markBrandClosed(ATH, { agentId: AG, brandName: 'Reply Cafe' });
  ok('a close advances it further', (await stateOf(P, 'Reply Cafe')).state === 'closed');
  await store.markBrandResponded(ATH, { agentId: AG, brandName: 'Reply Cafe' });
  ok('  A LATE REPLY DOES NOT DEMOTE A CLOSED DEAL',
    (await stateOf(P, 'Reply Cafe')).state === 'closed', await stateOf(P, 'Reply Cafe'));
  await store.advanceBrandEngagement(ATH, { state: 'contacted', brandName: 'Reply Cafe' });
  ok('  nor does a later contact', (await stateOf(P, 'Reply Cafe')).state === 'closed');
  ok('  re-ticking the same state is a no-op, not an error',
    (await store.markBrandClosed(ATH, { brandName: 'Reply Cafe' })) === true);

  // A brand we wrote off that then answers IS answered.
  await P.query(`INSERT INTO brand_engagement (agent_id,athlete_id,brand_key,brand_name,state)
                 VALUES ($1,$2,'bk2','Written Off','dead')`, [AG, ATH]);
  await store.markBrandResponded(ATH, { agentId: AG, brandName: 'Written Off' });
  ok('a dead brand that answers is responded, not dead',
    (await stateOf(P, 'Written Off')).state === 'responded', await stateOf(P, 'Written Off'));

  // ── A CLOSE ON A BRAND NO SCAN EVER SHOWED ───────────────────────────────
  ok('no ledger row exists for a brand we never scanned', (await stateOf(P, 'Never Scanned')) === null);
  await store.markBrandClosed(ATH, { agentId: AG, brandName: 'Never Scanned' });
  const ins = await stateOf(P, 'Never Scanned');
  ok('  a close INSERTS one rather than dropping the fact', ins && ins.state === 'closed', ins);

  // ── SAVEDEAL IS THE CHOKE POINT ──────────────────────────────────────────
  await store.saveDeal('lg-d1', { athleteId: ATH, agentId: AG, brand: 'Closed Via SaveDeal',
    stage: 'Closed', value: 2500 });
  ok('saveDeal on a Closed stage writes the ledger',
    (await stateOf(P, 'Closed Via SaveDeal')) && (await stateOf(P, 'Closed Via SaveDeal')).state === 'closed',
    await stateOf(P, 'Closed Via SaveDeal'));
  await store.saveDeal('lg-d2', { athleteId: ATH, agentId: AG, brand: 'Still Talking',
    stage: 'Negotiating', value: 1000 });
  ok('  and an OPEN deal does not', (await stateOf(P, 'Still Talking')) === null);

  // ── SOURCE 3 NOW ACCUMULATES ─────────────────────────────────────────────
  const sig = await S.schoolSponsorSignals(P, 'Auburn University');
  ok('THE SCOUT SIGNAL FINALLY SEES SOMETHING', sig.size > 0, [...sig.keys()]);
  ok('  the replied-at-school signal is real now', !!sig.get('reply cafe'), [...sig.keys()]);
  ok('  and it is worded as what it is',
    /closed a deal with another Auburn University athlete/.test(sig.get('reply cafe').detail),
    sig.get('reply cafe'));

  // ── SAVECOMP FEEDS SOURCE 1 ──────────────────────────────────────────────
  await store.saveComp({ brand: 'Comp Brand', type: 'ig-post', value: 3000 },
    { sport: 'Football', schoolTier: 'p4-mid', school: 'Auburn University', instagram: 20000, year: 'junior' });
  const comp = (await P.query(
    `SELECT school, brand, source FROM deal_comps WHERE brand='Comp Brand'`)).rows[0];
  ok('saveComp now writes the SCHOOL', comp && comp.school === 'Auburn University', comp);
  ok('  and the BRAND', comp && comp.brand === 'Comp Brand', comp);
  ok('  tagged as our own close, not a news scrape', comp && comp.source === 'agent-close', comp);

  // OUR OWN CLOSE IS NOT LAUNDERED INTO "the market says so".
  const sig2 = await S.schoolSponsorSignals(P, 'Auburn University');
  ok('an agent-close comp is NOT counted as a public report',
    !sig2.get('comp brand') || sig2.get('comp brand').kind !== 'reported-deal-at-school',
    sig2.get('comp brand'));

  // ── THE NEWS SCRAPE IS LABELLED FOR WHAT IT IS ───────────────────────────
  await P.query(`INSERT INTO deal_comps (id,sport,school,brand,deal_value,source)
                 VALUES (990201,'Football','Auburn University','Scraped Collective',50000,'lgtest')`);
  const sig3 = await S.schoolSponsorSignals(P, 'Auburn University');
  const rep = sig3.get('scraped collective');
  ok('a scraped deal is a REPORT, not a sponsorship claim',
    rep && rep.kind === 'reported-deal-at-school', rep);
  ok('  worded as publicly reported', /publicly reported/.test(rep.detail), rep.detail);
  ok('  and it ranks BELOW a business that actually answered us',
    S.SIGNAL_WEIGHT['reported-deal-at-school'] < S.SIGNAL_WEIGHT['replied-at-school'], S.SIGNAL_WEIGHT);
  ok('  which ranks below a deal we closed ourselves',
    S.SIGNAL_WEIGHT['replied-at-school'] < S.SIGNAL_WEIGHT['agent-closed-at-school'], S.SIGNAL_WEIGHT);

  // ── LEARNEDANGLES CAN NOW SEE A REPLY ────────────────────────────────────
  // The queue is what learnedAngles counts, and a manually-ticked reply never
  // reached it: the outcome endpoint set `outcome` and nothing else.
  for (let i = 0; i < 14; i++) {
    await P.query(
      `INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,
                                   sent_at,angle_key,category_key,replied_at)
       VALUES ($1,$2,$3,$4,$5,'dm','sent',NOW(),$6,'retail',$7)`,
      [AG, ATH, i + 1, 'ak' + i, 'Angle Co ' + i, i < 7 ? 'campus-traffic' : 'game-day',
       i < 4 ? new Date() : null]);
  }
  const learned = await PW.learnedAngles(P, 'retail');
  ok('learnedAngles reads replies off the queue', learned.length > 0, learned);
  ok('  and ranks the angle that actually got answered first',
    learned[0] && learned[0].angle === 'campus-traffic', learned);

  await clean();
  await P.query(`DELETE FROM deal_comps WHERE id=990201`).catch(() => {});
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
