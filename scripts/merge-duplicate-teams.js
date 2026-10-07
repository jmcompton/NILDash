'use strict';
// A university's duplicate teams merged into one (services/teamMerge): the
// athletes, the cards and every row naming the duplicate move to the kept
// team, then the duplicate is deleted. Dry run unless --apply. Sends nothing.
//
//   node scripts/merge-duplicate-teams.js --university univ-cypress [--apply]
//   /api/admin/scripts/merge-duplicate-teams?university=univ-cypress&text=1            dry run
//   /api/admin/scripts/merge-duplicate-teams?university=univ-cypress&apply=1&text=1    do it
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : null; };
async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const M = require(ROOT + 'server/services/teamMerge.js');
  const out = await M.run(store.pool, String(arg('university') || 'univ-cypress'), { apply: arg('apply') === true });
  console.log(M.format(out));
  process.exit(out.ok ? 0 : 1);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
