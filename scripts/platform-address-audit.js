'use strict';
// PLATFORM ADDRESSES ON LIVE CARDS (services/platformAddressAudit): every live
// card whose email is at a platform's own domain (ce@squareup.com on a Square
// business's card), by agent. READ-ONLY: nothing changes unless --apply, which
// stops each one with the reason on the card and turns its card into the call
// or DM instead. Never an email that was sent.
//
//   node scripts/platform-address-audit.js [--apply] [--agent <email or id>]
//   /api/admin/scripts/platform-address-audit?text=1[&apply=1][&agent=<email or id>]
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const PA = require(ROOT + 'server/services/platformAddressAudit.js');
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
