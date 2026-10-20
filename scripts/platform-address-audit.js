'use strict';
// LIVE CARDS AT A PLATFORM'S ADDRESS (services/platformAudit): every email
// that could still leave, and every card still on Home, whose address is on a
// platform's domain (ce@squareup.com and the like), by agent. PRINTED FIRST:
// nothing changes unless --apply, which stops each email (its card becomes the
// call or DM instead) and takes the address off each card, with the reason.
// Never anything sent, replied to or marked done.
//
//   node scripts/platform-address-audit.js [--apply] [--agent <email or id>]
//   /api/admin/scripts/platform-address-audit?text=1[&apply=1][&agent=<email or id>]
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const PA = require(ROOT + 'server/services/platformAudit.js');
  const i = process.argv.indexOf('--agent');
  const who = i > -1 ? String(process.argv[i + 1] || '').trim() : '';
  let agentId = null;
  if (who) {
    const u = (await store.pool.query(`SELECT id FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`, [who])).rows[0];
    if (!u) { console.log(`No agent ${who}. Nothing done.`); process.exit(1); }
    agentId = u.id;
  }
  const r = await PA.run(store.pool, { apply: process.argv.includes('--apply'), agentId });
  console.log(PA.format(r));
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
