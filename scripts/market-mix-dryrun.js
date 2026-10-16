'use strict';
// THE DEAL MIX, DRY (services/marketScore, services/dealMix): for each
// athlete, the Market Score, the tier, and the five cards the night would
// place under MARKET_MIX_ON, with each card's lane, brand size, contact and
// why the athlete fits the brand. NOTHING IS PLACED OR SENT: the nightly
// fill runs dry (jobs/outreachQueue.fillAthlete, dryRun) under a throwaway
// athlete id, so no card, draft or claim lands on the real athlete, and the
// agent's queued cards are not aged (keepStale). The score is not stored.
//
// IT SPENDS REAL MONEY: the name searches, the mailbox checks (Hunter's
// monthly pool) and the writer, exactly as the night would. Five athletes by
// default; --limit raises it (50 at most). What it spent is printed.
//
//   node scripts/market-mix-dryrun.js [--agent <email or id>] [--athlete <id>] [--limit N] [--search] [--verbose]
//   /api/admin/scripts/market-mix-dryrun?text=1[&agent=<email or id>][&athlete=<id>][&limit=N][&search=1][&verbose=1]
process.env.MARKET_MIX_ON = '1';   // this process only: the preview of the switch
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : null; };
const flag = (k) => process.argv.includes('--' + k);

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const pool = store.pool;
  const MS = require(ROOT + 'server/services/marketScore.js');
  const DM = require(ROOT + 'server/services/dealMix.js');
  const job = require(ROOT + 'server/jobs/outreachQueue.js');
  const Q = require(ROOT + 'server/services/outreachQueue.js');
  const AgentName = require(ROOT + 'server/services/agentName.js');
  const SIG = require(ROOT + 'server/services/signature.js');
  const Ledger = require(ROOT + 'server/services/aiLedger.js');
  const MR = require(ROOT + 'server/services/dealMixReport.js');
  await MS.ensureTables(pool);

  const where = [], params = [];
  if (arg('agent')) {
    params.push(arg('agent'));
    where.push(`a.agent_id = (SELECT id FROM users WHERE id::text = $${params.length} OR LOWER(email) = LOWER($${params.length}) LIMIT 1)`);
  }
  if (arg('athlete')) { params.push(arg('athlete')); where.push(`a.id = $${params.length}`); }
  const limit = Math.max(1, Math.min(50, parseInt(arg('limit'), 10) || 5));
  const rows = (await pool.query(
    `SELECT a.id, a.agent_id, a.data, a.instagram_followers, a.tiktok_followers, a.twitter_followers, a.athlete_type
       FROM athletes a ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.agent_id, a.created_at ASC LIMIT ${limit}`, params)).rows;
  console.log(`MARKET MIX DRY RUN: ${rows.length} athlete(s). Nothing is placed or sent; the score is not stored.`);
  console.log(`Switches in this process: MARKET_MIX_ON on (preview); EMAIL_FIVE_ON ${process.env.EMAIL_FIVE_ON === '1' ? 'on' : 'off'}, `
    + `EMAIL_FINDER_ON ${process.env.EMAIL_FINDER_ON === '1' ? 'on' : 'off'}, EMAIL_SMART_PICK ${process.env.EMAIL_SMART_PICK === '1' ? 'on' : 'off'}.`);
  console.log('');

  const agents = new Map();
  const totals = { athletes: 0, cards: 0, byLane: { local: 0, social: 0, national: 0 }, seats: { local: 0, social: 0, national: 0 }, usd: 0, byTier: {},
    backfilled: 0, backfilledBy: {} };
  for (const row of rows) {
    const name = (row.data && row.data.name) || row.id;
    let agent = agents.get(row.agent_id);
    if (!agent) { agent = (await pool.query(`SELECT * FROM users WHERE id::text = $1::text`, [row.agent_id])).rows[0] || null; agents.set(row.agent_id, agent); }
    const score = await MS.computeFor(pool, row, { save: false, search: flag('search') });
    const dryId = 'mixdry:' + crypto.randomBytes(6).toString('hex');
    const cards = [];
    let r = null, err = null;
    const t0 = Date.now();
    try {
      const lcx = await job.localContextFor({ id: row.id, name, data: row.data });
      r = await job.fillAthlete(pool, {
        agentId: row.agent_id, athleteId: dryId, athleteName: name, runDate: new Date().toISOString().slice(0, 10),
        athleteProfile: lcx.profile, agentFirstName: agent ? AgentName.pitchSignOffName(agent) : null, athleteRow: row.data,
        budget: Q.newBudget(Q.ATHLETE_COST_CEILING_USD, undefined, { rosterSize: 1 }),
        region: lcx.region, regionFault: lcx.fault || null, dryRun: true, keepStale: true, maxSlots: Q.SLOTS_PER_ATHLETE,
        signature: agent ? SIG.signatureOf(agent) : { has: false, hasLink: false, text: '', url: '' },
        marketScore: score,
        onCard: (c) => { cards.push(c); },
        onProgress: flag('verbose') ? (m) => console.log('    > ' + m) : () => {},
      });
    } catch (e) { err = e; }
    await Ledger.drain().catch(() => {});
    const spend = (await pool.query(`SELECT COALESCE(SUM(est_usd), 0)::float AS usd, COUNT(*)::int AS calls, COALESCE(SUM(web_searches), 0)::int AS searches
                                       FROM ai_call_ledger WHERE athlete_id = $1`, [dryId]).catch(() => ({ rows: [{ usd: 0, calls: 0, searches: 0 }] }))).rows[0];
    // The throwaway id's night claims, so nothing of it is left behind.
    await pool.query(`DELETE FROM research_claims WHERE athlete_id = $1`, [dryId]).catch(() => {});
    await pool.query(`DELETE FROM discovery_nightly WHERE athlete_id = $1`, [dryId]).catch(() => {});
    console.log(MR.formatAthlete({ name, score, cards, result: r, error: err, spend, ms: Date.now() - t0 }));
    console.log('');
    totals.athletes++;
    totals.cards += cards.length;
    totals.usd += Number(spend.usd) || 0;
    totals.byTier[score.tierLabel] = (totals.byTier[score.tierLabel] || 0) + 1;
    for (const c of cards) totals.byLane[DM.laneOf(c)]++;
    for (const b of ((r && r.loop && r.loop.mix && r.loop.mix.backfilled) || [])) {
      totals.backfilled++;
      totals.backfilledBy[b.seat] = (totals.backfilledBy[b.seat] || 0) + 1;
    }
    const seats = DM.mixFor(score.tier);
    for (const l of DM.LANES) totals.seats[l] += seats[l];
  }
  console.log(MR.formatTotals(totals));
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
