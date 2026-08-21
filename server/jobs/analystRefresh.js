#!/usr/bin/env node
'use strict';
// ── THE ANALYST'S NIGHTLY PASS ───────────────────────────────────────────────
//
//   node server/jobs/analystRefresh.js --dry-run   what it would rebuild, writes nothing
//   node server/jobs/analystRefresh.js --run       the real pass
//
// SAFE TO RUN BY DEFAULT, unlike the other two jobs. It spends nothing: no API
// calls, no model calls, no paid lookups. It reads stored fields and writes
// rows. That is why there is no ANALYST_ENABLED gate -- the reason the queue and
// the Closer have one is money and outbound mail, and this has neither.
//
// It does not touch email or outreach. It keeps one kit per athlete current.

const store = require('../store');
const Analyst = require('../services/analyst');

async function runOnce(opts = {}) {
  const pool = store.pool;
  const agents = (await pool.query(
    `SELECT DISTINCT a.agent_id AS id FROM athletes a
      WHERE a.agent_id IS NOT NULL`)).rows;

  const totals = { agents: 0, checked: 0, refreshed: 0, built: 0, skipped: 0, failed: 0, thin: 0 };
  for (const ag of agents) {
    const out = await Analyst.refreshAll(pool, ag.id, opts).catch((e) => {
      console.error(`[analyst] agent=${ag.id} failed: ${e.message}`);
      return null;
    });
    if (!out) continue;
    totals.agents++;
    totals.checked += out.checked;
    totals.refreshed += out.refreshed;
    totals.built += out.built;
    totals.skipped += out.skipped;
    totals.failed += out.failed;
    totals.thin += out.thin.length;
    for (const d of out.details) {
      console.log(`[analyst] ${d.result} ${d.name || d.athleteId}: ${d.why}`);
    }
    // A THIN KIT IS REPORTED, NOT PADDED. The fix is data, and the agent is the
    // only one who can supply it.
    for (const t of out.thin) {
      console.log(`[analyst] thin ${t.name || t.athleteId}: only ${t.have.join(', ')} on file`);
    }
  }
  console.log(`[analyst] agents=${totals.agents} checked=${totals.checked} `
    + `built=${totals.built} refreshed=${totals.refreshed} `
    + `unchanged=${totals.skipped} failed=${totals.failed} thin=${totals.thin}`);
  return totals;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run') || !argv.includes('--run');
  runOnce({ dryRun })
    .then(() => process.exit(0))
    .catch((e) => { console.error('[analyst] pass failed:', e.message); process.exit(1); });
}

module.exports = { runOnce };
