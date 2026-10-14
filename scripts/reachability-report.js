'use strict';
// WHICH BUSINESSES TURN INTO A VERIFIED EMAIL (services/reachability): each
// business type and each signal, scored from our own history.
//
//   node scripts/reachability-report.js [--recompute] [--days 90]
//   /api/admin/scripts/reachability-report?text=1[&recompute=1][&days=90]
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : null; };
async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const R = require(ROOT + 'server/services/reachability.js');
  const model = process.argv.includes('--recompute')
    ? await R.recompute(store.pool, { days: Math.max(7, Math.min(365, parseInt(arg('days'), 10) || R.WINDOW_DAYS)) })
    : await R.latest(store.pool);
  console.log(R.format(model));
  if (!process.argv.includes('--recompute')) console.log('\n(The latest weekly model. recompute=1 builds a fresh one now.)');
  console.log(`\nEMAIL_SMART_PICK is ${process.env.EMAIL_SMART_PICK === '1' ? 'ON' : 'off'} on this deployment.`);
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
