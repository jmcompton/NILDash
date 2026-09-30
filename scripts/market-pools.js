'use strict';
// ── EVERY ATHLETE MARKET, AND WHETHER IT HAS A POOL ─────────────────────────
//
// Lists every distinct athlete market (resolved the way the nightly job
// resolves it), how many usable businesses each holds in market_business_seen,
// and which are due a build. Report only by default: nothing is spent.
//
//   node scripts/market-pools.js                 report: markets, zero-row count, what is due
//   node scripts/market-pools.js --apply         build the due markets, within the per-run limits
//   node scripts/market-pools.js --apply --all   the backfill: every due market, no market limit
//   /api/admin/scripts/market-pools?text=1       (&apply=1, &all=1)
//
// The nightly schedule (server/index.js) runs the --apply form once a night.
// Spends Places requests: roughly 30 to 150 a market per ring.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const MP = require(ROOT + 'server/services/marketPools.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const apply = process.argv.includes('--apply');
  const all = process.argv.includes('--all');
  console.log(`MARKET POOLS  ${new Date().toISOString()}  ${apply ? (all ? 'APPLY (backfill, no market limit)' : 'APPLY') : 'report only (add --apply to build)'}\n`);
  const res = await MP.run(store.pool, { apply, ...(all ? { maxMarkets: Infinity, maxCalls: parseInt(process.env.MARKET_POOL_BACKFILL_MAX_CALLS, 10) || 20000 } : {}) });
  console.log(MP.formatReport(res));
}

main().catch((e) => { console.error('market-pools failed:', e && e.stack || e); process.exitCode = 1; })
  .finally(async () => { try { await store.pool.end(); } catch (_) {} });
