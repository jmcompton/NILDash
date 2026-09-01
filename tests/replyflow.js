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
// THE TWO LIVE PATHS A REPLY CAN ARRIVE DOWN, end to end.
//   1. markReplied  -- the Resend inbound webhook and the manual email tick
//   2. the queue card outcome button -- a DM or a call the agent ticks
// Plus the widen guard, which has to hold across two processes.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const Deepen = require(ROOT + 'server/services/marketDeepen.js');
const fs = require('fs');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'rf-agent', ATH = 'rf-ath1';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    for (const t of ['outreach_queue', 'brand_engagement', 'outreach_logs', 'deals']) {
      await P.query(`DELETE FROM ${t} WHERE agent_id=$1`, [AG]).catch(() => {});
    }
    await P.query(`DELETE FROM athletes WHERE id=$1`, [ATH]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM market_deepen_log WHERE market_key LIKE 'rf-%'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'A','rf@x.com','x','agent')
                 ON CONFLICT DO NOTHING`, [AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
    [ATH, AG, JSON.stringify({ name: 'Reply Athlete', school: 'Auburn University' })]);

  const stateOf = async (brand) => (await P.query(
    `SELECT state FROM brand_engagement WHERE athlete_id=$1 AND LOWER(brand_name)=LOWER($2)`,
    [ATH, brand])).rows[0] || null;

  // ── PATH 1: markReplied, the email path ──────────────────────────────────
  const fu = require(ROOT + 'server/services/followUpAutomation.js');
  await P.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, brand_key, subject, status, sent_at)
     VALUES ('rf-l1',$1,$2,'Email Cafe','ek1','Hi','sent',NOW())`, [AG, ATH]);
  await P.query(`INSERT INTO brand_engagement (agent_id,athlete_id,brand_key,brand_name,state)
                 VALUES ($1,$2,'ek1','Email Cafe','contacted')`, [AG, ATH]);
  await P.query(`INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,sent_at)
                 VALUES ($1,$2,1,'ek1','Email Cafe','dm','sent',NOW())`, [AG, ATH]);
  await fu.markReplied('rf-l1');
  ok('an inbound email reply advances the ledger', (await stateOf('Email Cafe')) && (await stateOf('Email Cafe')).state === 'responded',
    await stateOf('Email Cafe'));
  const q1 = (await P.query(`SELECT replied_at FROM outreach_queue WHERE brand_key='ek1'`)).rows[0];
  ok('  and still stamps the queue card for learnedAngles', !!q1.replied_at, q1);

  // ── PATH 2: the outcome endpoint, lifted from index.js and run for real ──
  const SRC = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
  const start = SRC.indexOf("app.post('/api/agent/outreach-queue/:id/outcome'");
  const end = SRC.indexOf("app.post('/api/agent/brand-instagram'");
  ok('the outcome endpoint is where we think it is', start > 0 && end > start, [start, end]);
  const body = SRC.slice(SRC.indexOf('{', SRC.indexOf('async (req, res) =>', start)) , end);

  // Run the handler body against the real database.
  const OQ = require(ROOT + 'server/services/outreachQueue.js');
  await P.query(`INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,sent_at,angle_key,category_key)
                 VALUES ($1,$2,2,'dk1','DM Diner','dm','sent',NOW(),'campus','retail') RETURNING id`, [AG, ATH]);
  await P.query(`INSERT INTO brand_engagement (agent_id,athlete_id,brand_key,brand_name,state)
                 VALUES ($1,$2,'dk1','DM Diner','contacted')`, [AG, ATH]);
  const cardId = (await P.query(`SELECT id FROM outreach_queue WHERE brand_key='dk1'`)).rows[0].id;

  const handler = new Function('store', 'OQ', 'req', 'res',
    'return (async (req,res)=>' + body.slice(0, body.lastIndexOf('}') + 1) + ')(req,res);');
  let sent = null;
  const res = { json: (v) => { sent = v; return res; }, status: () => res };
  await handler(store, OQ, { params: { id: cardId }, session: { userId: AG }, body: { outcome: 'replied' } }, res);
  ok('ticking REPLIED on a DM card advances the ledger',
    (await stateOf('DM Diner')) && (await stateOf('DM Diner')).state === 'responded', await stateOf('DM Diner'));
  const q2 = (await P.query(`SELECT replied_at, outcome FROM outreach_queue WHERE id=$1`, [cardId])).rows[0];
  ok('  AND stamps replied_at, which is what learnedAngles counts', !!q2.replied_at, q2);
  ok('  keeping the outcome column too', q2.outcome === 'replied', q2);

  await handler(store, OQ, { params: { id: cardId }, session: { userId: AG }, body: { outcome: 'closed' } }, res);
  ok('ticking CLOSED moves it to closed', (await stateOf('DM Diner')).state === 'closed', await stateOf('DM Diner'));

  // no_reply must not pretend to be a reply
  await P.query(`INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,sent_at)
                 VALUES ($1,$2,3,'nk1','No Answer Co','dm','sent',NOW())`, [AG, ATH]);
  const nid = (await P.query(`SELECT id FROM outreach_queue WHERE brand_key='nk1'`)).rows[0].id;
  await handler(store, OQ, { params: { id: nid }, session: { userId: AG }, body: { outcome: 'no_reply' } }, res);
  const q3 = (await P.query(`SELECT replied_at FROM outreach_queue WHERE id=$1`, [nid])).rows[0];
  ok('no_reply does NOT stamp replied_at', !q3.replied_at, q3);

  // ── THE WIDEN GUARD, SHARED ACROSS PROCESSES ─────────────────────────────
  await Deepen.ensureTable(P);
  const g1 = await Deepen.canDeepen(P, 'rf-Test University');
  ok('a market never widened can be widened', g1.ok === true, g1);
  ok('the first claim succeeds', (await Deepen.claimDeepen(P, 'rf-Test University', { source: 'nightly' })) === true);
  ok('  THE SECOND CLAIM DOES NOT — one pass per market per day',
    (await Deepen.claimDeepen(P, 'rf-Test University', { source: 'dealscan' })) === false);
  const g2 = await Deepen.canDeepen(P, 'rf-Test University');
  // The claim is per athlete per market now -- one athlete at a school no longer
  // blocks the rest of the roster. With no athleteId this is the market-wide row,
  // which is still one pass per window, and still says so.
  ok('  and the guard says why in words',
    g2.ok === false && /one pass per market per 24h/.test(g2.reason), g2);
  ok('  athletes at the SAME school share the market key',
    Deepen.marketKey('rf-Test University') === Deepen.marketKey('  RF-TEST   University  '),
    [Deepen.marketKey('rf-Test University'), Deepen.marketKey('  RF-TEST   University  ')]);
  ok('a DIFFERENT market is unaffected',
    (await Deepen.claimDeepen(P, 'rf-Other College', { source: 'nightly' })) === true);
  ok('no school means no widen', (await Deepen.canDeepen(P, '')).ok === false);

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
