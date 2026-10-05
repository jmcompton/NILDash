'use strict';
// Runs against the local test Postgres. No network.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/dealoutcome.js    just this one
//
// ── A DEAL IS AN OUTCOME, AND IT IS MARKED ON THE CARD ─────────────────────
// The ledger had shown / contacted / retired / responded and nothing anyone
// could see for "signed". The state existed ('closed', services/dealLog) and
// its button lived on My Brands and the Pipeline, not on Home, and Home
// dropped a sent card after its day. So:
//   every card sent in the last 90 days stays on Home with what came of it
//   one tap: They replied / Not interested / Deal signed (the deal form)
//   a deal from the card closes the card, the ledger (with which deal and how
//     much), the Pipeline and deal_outcomes; Undo takes all of it back
//   real-outcomes lists every one of them, by agent
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const DL = require(REPO + 'server/services/dealLog.js');
const HQ = require(REPO + 'server/services/homeQueue.js');
const OQ = require(REPO + 'server/services/outreachQueue.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const AG = 'do-agent', ATH = 'do-ath';

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await DL.ensureTable(P);
  const clean = async () => {
    await P.query(`DELETE FROM deal_outcomes WHERE agent_id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM brand_engagement WHERE athlete_id = $1`, [ATH]).catch(() => {});
    await P.query(`DELETE FROM athlete_self_deals WHERE athlete_id = $1`, [ATH]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE id = $1`, [ATH]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id, name, email, role, password) VALUES ($1, 'Dee Outcome', 'dee@agency.example', 'agent', 'x')`, [AG]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1, $2, '{"name":"Do Athlete","school":"Auburn University","over18":"true"}'::jsonb)`, [ATH, AG]);
  const card = async (slot, brand, key, daysAgo) => (await P.query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, state, channel, sent_via, sent_at, contact_name, lane)
     VALUES ($1,$2,$3,$4,$5,'sent','email','email', NOW() - make_interval(days => $6), 'Pat Owner', 'local') RETURNING id`,
    [AG, ATH, slot, key, brand, daysAgo])).rows[0].id;
  const c1 = await card(1, 'DO Bakery', 'place:do-bakery', 3);
  const c2 = await card(2, 'DO Gym', 'place:do-gym', 10);
  const c3 = await card(3, 'DO Old Shop', 'place:do-old', 120);
  for (const [k, b] of [['place:do-bakery', 'DO Bakery'], ['place:do-gym', 'DO Gym']]) {
    await P.query(`INSERT INTO brand_engagement (agent_id, athlete_id, brand_key, brand_name, lane, state, contacted_at, contacted_via)
                   VALUES ($1,$2,$3,$4,'local','contacted',NOW(),'email')`, [AG, ATH, k, b]);
  }

  // ── 1. THE CARD STAYS ON HOME ────────────────────────────────────────────
  OUT.push('-- sent cards stay on Home, with what came of them --');
  let home = await HQ.buildHome(P, AG, { athleteId: ATH });
  const sentIds = (home.sent || []).map((s) => s.id);
  ok('every card sent in the last 90 days is listed for the athlete, newest first', sentIds.join() === [c1, c2].join(), home.sent);
  ok('  a card sent 120 days ago is not', !sentIds.includes(c3));
  ok('  each starts as waiting', (home.sent || []).every((s) => s.outcome === 'waiting'));
  ok('the outcomes a card takes: replied, declined (not interested), closed (deal signed), no reply', ['replied', 'declined', 'closed', 'no_reply'].every((o) => OQ.OUTCOMES.includes(o)));

  // ── 2. DEAL SIGNED, FROM THE CARD ────────────────────────────────────────
  OUT.push('', '-- deal signed, from the card --');
  const out = await DL.logDeal(P, { agentId: AG, queueId: c1, value: '750', deliverable: 'two posts and an appearance' });
  ok('the deal logs from the card alone (athlete, business and key come off the card)', out.ok && out.brand === 'DO Bakery' && out.athleteId === ATH, out);
  const cr = (await P.query(`SELECT outcome, replied_at FROM outreach_queue WHERE id = $1`, [c1])).rows[0];
  ok('  the card is marked closed, and replied (a signed deal was answered)', cr.outcome === 'closed' && !!cr.replied_at, cr);
  const be = (await P.query(`SELECT state, deal_outcome_id, deal_value, deal_signed_at FROM brand_engagement WHERE athlete_id = $1 AND brand_key = 'place:do-bakery'`, [ATH])).rows[0];
  ok('  brand_engagement says closed, with WHICH deal, how much and when', be.state === 'closed' && Number(be.deal_outcome_id) === Number(out.id) && Number(be.deal_value) === 750 && !!be.deal_signed_at, be);
  const pipe = (await P.query(`SELECT stage FROM athlete_self_deals WHERE athlete_id = $1 AND brand_name = 'DO Bakery'`, [ATH])).rows[0];
  ok('  the Pipeline moves to Closed', pipe && pipe.stage === 'Closed', pipe);
  home = await HQ.buildHome(P, AG, { athleteId: ATH });
  const row = (home.sent || []).find((s) => s.id === c1);
  ok('  Home shows it signed, with the value and the deal to undo', row && row.outcome === 'signed' && row.dealValue === 750 && Number(row.dealId) === Number(out.id), row);
  ok('another agent cannot log a deal on this card', !(await DL.logDeal(P, { agentId: 'someone-else', queueId: c1 })).ok);

  // ── 3. UNDO ──────────────────────────────────────────────────────────────
  OUT.push('', '-- undo --');
  const un = await DL.undoDeal(P, { agentId: AG, id: out.id });
  const cu = (await P.query(`SELECT outcome FROM outreach_queue WHERE id = $1`, [c1])).rows[0];
  const bu = (await P.query(`SELECT state, deal_outcome_id, deal_value FROM brand_engagement WHERE athlete_id = $1 AND brand_key = 'place:do-bakery'`, [ATH])).rows[0];
  ok('undo: the card goes back to replied, the ledger drops the deal', un.ok && cu.outcome === 'replied' && bu.state !== 'closed' && bu.deal_outcome_id === null && bu.deal_value === null, { un, cu, bu });
  home = await HQ.buildHome(P, AG, { athleteId: ATH });
  ok('  and Home shows Replied', ((home.sent || []).find((s) => s.id === c1) || {}).outcome === 'replied');

  // ── 4. THE ENDPOINT AND THE PAGE ─────────────────────────────────────────
  OUT.push('', '-- the endpoint and the page --');
  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('"not interested" is a reply in the ledger (responded) with declined as its outcome, and moves no Pipeline row',
    /outcome === 'declined'\) \{[\s\S]{0,600}state: 'responded'[\s\S]{0,200}outcome: 'declined'/.test(idx));
  ok('  /api/deals/log passes the card through', /queueId: b\.queueId \|\| null/.test(idx));
  const page = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('Home renders the sent list with They replied, Not interested and Deal signed', /html \+= hqSentHtml\(d\);/.test(page)
    && />They replied</.test(page) && />Not interested</.test(page) && /hqSentDeal\(/.test(page) && /dealSignedOpen\(HQ\.selected, r\.business, r\.brandKey, id\)/.test(page));
  ok('  the deal form sends the card id', /queueId: DEALFORM\.dataset\.queueId \|\| null/.test(page));

  // ── 5. THE REPORT ────────────────────────────────────────────────────────
  OUT.push('', '-- every real outcome --');
  await DL.logDeal(P, { agentId: AG, queueId: c2, value: null });
  const { spawnSync } = require('child_process');
  const rep = spawnSync(process.execPath, [REPO + 'scripts/real-outcomes.js'], { env: { ...process.env, INIT_WAIT_MS: '3000' }, encoding: 'utf8', timeout: 120000 });
  const txt = rep.stdout || '';
  ok('real-outcomes runs and has every section', rep.status === 0 && /0\. THE LEDGER/.test(txt) && /1\. EVERY BUSINESS CONTACTED/.test(txt) && /2\. REPLIES AND OUTCOMES OUTSIDE/.test(txt) && /3\. PIPELINE/.test(txt) && /4\. EVERY LOGGED DEAL/.test(txt), txt.slice(0, 600) + (rep.stderr || ''));
  ok('  names the agent and the athlete, and the timeline after contact', /Dee Outcome <dee@agency\.example>/.test(txt) && /Do Athlete \(Auburn University\)\s+->\s+DO Gym/.test(txt) && /DEAL LOGGED \(no value\)/.test(txt), txt.slice(0, 3000));
  ok('  and the one-line list: the gym a DEAL, the bakery a REPLY', /DEAL\s+\S+\s+DO Gym for Do Athlete/.test(txt) && /REPLY\s+\S+\s+DO Bakery for Do Athlete/.test(txt), txt.slice(-800));
  ok('  registered as an admin script', /'real-outcomes': \{ file: 'scripts\/real-outcomes\.js'/.test(idx));

  await clean();
  OUT.push('', 'failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
})().catch((e) => { OUT.push('FAIL threw: ' + (e && e.stack)); console.log(OUT.join('\n')); process.exit(1); });
