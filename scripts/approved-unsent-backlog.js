'use strict';
// APPROVED, NEVER SENT, TOO OLD TO SEND: re-decide each one (services/approvedBacklog).
//
//   node scripts/approved-unsent-backlog.js --date 2026-09-23 [--apply] [--agent jabree@belchersportsgroup.com]
//   /api/admin/scripts/approved-unsent-backlog?date=2026-09-23&agent=jabree@belchersportsgroup.com&text=1          dry run
//   /api/admin/scripts/approved-unsent-backlog?date=2026-09-23&agent=jabree@belchersportsgroup.com&apply=1&text=1  do it
//
// Nothing is ever sent or approved by this. A found address becomes a fresh,
// unapproved draft dated today; a phone a call card; a handle a DM card. The
// old rows are closed so the morning alert stops reporting them.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : null; };

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const B = require(ROOT + 'server/services/approvedBacklog.js');
  const date = arg('date') && arg('date') !== true ? arg('date') : null;
  const out = await B.run(store.pool, { date, olderThanDays: date ? null : 7, apply: arg('apply') === true });
  const agent = arg('agent') && arg('agent') !== true ? arg('agent') : null;
  const home = agent ? await B.onHome(store.pool, agent) : null;
  console.log(B.format(out, home));
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
