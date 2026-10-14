'use strict';
// THE 5:30 LIST (services/shortOfFive): athletes holding fewer than five
// verified-email cards, and why. Printed, not sent, unless --send.
//
//   node scripts/short-of-five.js [--send]
//   /api/admin/scripts/short-of-five?text=1[&send=1]
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const S5 = require(ROOT + 'server/services/shortOfFive.js');
  if (process.argv.includes('--send')) {
    const r = await S5.runOnce(store.pool, { force: true });
    console.log(r.msg ? r.msg.text : '', '\n\n' + (r.status || r.skipped));
  } else {
    const r = await S5.collect(store.pool);
    console.log(S5.render(r).text);
    if (!r.fiveOn) console.log('\n(EMAIL_FIVE_ON is not set: the 5:30 email is not sent on this deployment.)');
  }
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
