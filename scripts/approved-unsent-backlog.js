'use strict';
// APPROVED, NEVER SENT, TOO OLD TO SEND: re-decide each one (services/approvedBacklog).
//
//   node scripts/approved-unsent-backlog.js --date 2026-09-23 [--apply] [--agent jabree@belchersportsgroup.com]
//   /api/admin/scripts/approved-unsent-backlog?date=2026-09-23&agent=jabree@belchersportsgroup.com&text=1          dry run
//   /api/admin/scripts/approved-unsent-backlog?date=2026-09-23&agent=jabree@belchersportsgroup.com&apply=1&text=1  do it
//   /api/admin/scripts/approved-unsent-backlog?all=1&text=1          every agent, everything approved 3+ days ago and never sent (dry run)
//   /api/admin/scripts/approved-unsent-backlog?all=1&apply=1&text=1  do it
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
  const days = arg('older-than-days') && arg('older-than-days') !== true ? Math.max(1, parseInt(arg('older-than-days'), 10) || 3) : 3;
  const agent = arg('agent') && arg('agent') !== true ? arg('agent') : null;
  // --all: every agent's approved-and-never-sent rows older than N days (3).
  // Otherwise one date, optionally one agent.
  const out = await B.run(store.pool, { date: arg('all') === true ? null : date, olderThanDays: days, agentEmail: agent, apply: arg('apply') === true });
  const home = agent ? await B.onHome(store.pool, agent) : await B.onHomeAll(store.pool, out);
  console.log(B.format(out, home));
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
