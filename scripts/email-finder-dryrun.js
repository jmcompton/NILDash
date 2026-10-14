'use strict';
// THE EMAIL FINDER, RE-RUN OVER THE LAST N NIGHTS' DM AND CALL CARDS
// (services/emailFinderDryRun). No card is changed and nothing is sent.
// It spends Hunter verifications and searches (logged as 'finder-dryrun').
//
//   node scripts/email-finder-dryrun.js [--days 7] [--limit 50] [--max-verify 900]
//   /api/admin/scripts/email-finder-dryrun?text=1&days=7
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : null; };
async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const D = require(ROOT + 'server/services/emailFinderDryRun.js');
  const out = await D.run(store.pool, {
    days: Math.max(1, Math.min(30, parseInt(arg('days'), 10) || 7)),
    limit: parseInt(arg('limit'), 10) || 0,
    maxVerify: parseInt(arg('max-verify'), 10) || 900,
    concurrency: 4,
  });
  console.log(D.format(out));
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
