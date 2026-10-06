'use strict';
// THE FREE STEPS ACROSS A UNIVERSITY'S NAMED PEOPLE (services/campusReach):
// the website on file for an email, the Instagram handle it links to; then the
// latest night's cards brought up to date (email where there is one now, a DM
// wherever there is a handle). Nothing is sent.
//
//   node scripts/campus-reach.js --university univ-cypress [--apply]
//   /api/admin/scripts/campus-reach?university=univ-cypress&text=1            dry run
//   /api/admin/scripts/campus-reach?university=univ-cypress&apply=1&text=1    do it
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : null; };
async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const R = require(ROOT + 'server/services/campusReach.js');
  const out = await R.run(store.pool, String(arg('university') || 'univ-cypress'), { apply: arg('apply') === true });
  console.log(R.format(out));
  process.exit(out.ok ? 0 : 1);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
