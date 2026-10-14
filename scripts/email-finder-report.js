'use strict';
// WHY DIDN'T THESE CARDS GET AN EMAIL (services/emailFinderReport). Reads only.
//
//   node scripts/email-finder-report.js [--days 7]
//   /api/admin/scripts/email-finder-report?text=1&days=7
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : null; };
async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const R = require(ROOT + 'server/services/emailFinderReport.js');
  const out = await R.gather(store.pool, { days: Math.max(1, Math.min(60, parseInt(arg('days'), 10) || 7)) });
  console.log(R.format(out, await R.hunterAccount()));
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
