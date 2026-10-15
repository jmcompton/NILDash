'use strict';
// EACH ATHLETE'S MARKET SCORE AND WHAT DROVE IT (services/marketScore).
// Read-only by default: scores each athlete now from what the records hold
// (the news mentions already found, the city population from the 2020
// Census), prints the score, the tier, each part and the reasons, and stores
// nothing. --save stores the scores; --search also runs the week's news
// search for athletes whose last one is over a week old (a web search each).
//
//   node scripts/market-score.js [--agent <email or id>] [--athlete <id>] [--limit N] [--save] [--search]
//   /api/admin/scripts/market-score?text=1[&agent=<email or id>][&athlete=<id>][&limit=N][&save=1][&search=1]
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : null; };
const flag = (k) => process.argv.includes('--' + k);

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const MS = require(ROOT + 'server/services/marketScore.js');
  const pool = store.pool;
  await MS.ensureTables(pool);
  const where = [], params = [];
  const agent = arg('agent');
  if (agent) {
    params.push(agent);
    where.push(`a.agent_id = (SELECT id FROM users WHERE id::text = $${params.length} OR LOWER(email) = LOWER($${params.length}) LIMIT 1)`);
  }
  if (arg('athlete')) { params.push(arg('athlete')); where.push(`a.id = $${params.length}`); }
  const limit = Math.max(1, Math.min(2000, parseInt(arg('limit'), 10) || 500));
  const rows = (await pool.query(
    `SELECT a.id, a.agent_id, a.data, a.instagram_followers, a.tiktok_followers, a.twitter_followers, a.athlete_type, u.email AS agent_email
       FROM athletes a LEFT JOIN users u ON u.id::text = a.agent_id::text
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY u.email NULLS LAST, a.created_at ASC LIMIT ${limit}`, params)).rows;
  const save = flag('save'), search = flag('search');
  console.log(`MARKET SCORE: ${rows.length} athlete(s)${save ? ', stored' : ', not stored (read-only)'}${search ? ', news searched where over a week old' : ''}`);
  console.log(`MARKET_MIX_ON is ${MS.ON() ? 'ON' : 'off'}. Tiers: ${MS.TIERS.map((t) => `${t.label} ${t.min}+`).join(', ')}.`);
  console.log('');
  const byTier = {};
  let lastAgent = null;
  for (const row of rows) {
    if (row.agent_email !== lastAgent) { console.log(`=== ${row.agent_email || row.agent_id} ===`); lastAgent = row.agent_email; }
    try {
      const s = await MS.computeFor(pool, row, { save, search });
      byTier[s.tierLabel] = (byTier[s.tierLabel] || 0) + 1;
      console.log(MS.format(s));
    } catch (e) {
      console.log(`${(row.data && row.data.name) || row.id}: could not score (${e.message})`);
    }
    console.log('');
  }
  console.log('BY TIER: ' + (Object.entries(byTier).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'));
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
