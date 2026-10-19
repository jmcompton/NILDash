'use strict';
// WHO JOINED THE ATHLETE WAITLIST on the public homepage (services/publicHome,
// HOME_V2_ON). Newest first, with when and from where. Read only.
//
//   node scripts/athlete-waitlist.js
//   /api/admin/scripts/athlete-waitlist?text=1
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const rows = await require(ROOT + 'server/services/publicHome.js').waitlist(store.pool);
  console.log(`ATHLETE WAITLIST: ${rows.length}`);
  for (const r of rows) console.log(`  ${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}  ${r.email}${r.source ? '  (' + r.source + ')' : ''}`);
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
