'use strict';
// UNDO THE STOPS THE OLD NAME RULE GOT WRONG (services/restoreFalseStops):
// every email the send gate stopped as "not their address" whose address now
// passes the corrected rule (services/nameMatch: initials, nicknames) and has
// a valid verification in the last 30 days, by agent. PRINTED FIRST: nothing
// changes unless --apply, which puts each one back as a draft on Home for the
// agent to approve, with its card back as the email card.
//
//   node scripts/restore-false-stops.js [--apply] [--agent <email or id>]
//   /api/admin/scripts/restore-false-stops?text=1[&apply=1][&agent=<email or id>]
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const RF = require(ROOT + 'server/services/restoreFalseStops.js');
  const i = process.argv.indexOf('--agent');
  const who = i > -1 ? String(process.argv[i + 1] || '').trim() : '';
  let agentId = null;
  if (who) {
    const u = (await store.pool.query(`SELECT id FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`, [who])).rows[0];
    if (!u) { console.log(`No agent ${who}. Nothing done.`); process.exit(1); }
    agentId = u.id;
  }
  const r = await RF.run(store.pool, { apply: process.argv.includes('--apply'), agentId });
  console.log(RF.format(r));
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
