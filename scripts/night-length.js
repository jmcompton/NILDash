'use strict';
// HOW LONG THE NIGHT TAKES, BEFORE AND AFTER (services/nightLength): the
// measured night, and the same athletes scheduled the way the code now runs
// them under EMAIL_FIVE_ON. Read-only.
//
//   node scripts/night-length.js [--date YYYY-MM-DD] [--athletes N] [--agents N]
//   /api/admin/scripts/night-length?text=1[&date=YYYY-MM-DD][&athletes=N][&agents=N]
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : null; };
async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const NL = require(ROOT + 'server/services/nightLength.js');
  const r = await NL.run(store.pool, {
    runDate: arg('date') || null,
    athleteConc: parseInt(arg('athletes'), 10) || parseInt(process.env.OUTREACH_ATHLETE_CONCURRENCY, 10) || 3,
    agentConc: parseInt(arg('agents'), 10) || parseInt(process.env.OUTREACH_QUEUE_AGENT_CONCURRENCY, 10) || 4,
    oldCeilingMs: parseInt(process.env.OUTREACH_ATHLETE_TIME_CEILING_MS, 10) || 8 * 60000,
    newCeilingMs: parseInt(process.env.OUTREACH_FIVE_TIME_CEILING_MS, 10) || 15 * 60000,
  });
  console.log(NL.format(r));
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
