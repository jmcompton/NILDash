'use strict';
// HOW AN UNVERIFIED EMAIL CARD WAS PLACED (services/unverifiedCards): for one
// night, every email card the nightly queue placed and every email draft
// written that day outside a card, with the path its address came from and
// whether it was a named person's valid address. Read only.
//
//   node scripts/unverified-cards.js [--date YYYY-MM-DD] [--agent <email or id>]
//   /api/admin/scripts/unverified-cards?text=1[&date=YYYY-MM-DD][&agent=<email or id>]
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : null; };
async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const UC = require(ROOT + 'server/services/unverifiedCards.js');
  let agentId = null;
  if (arg('agent')) {
    const u = (await store.pool.query(`SELECT id FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`, [arg('agent')])).rows[0];
    if (!u) { console.log(`No agent ${arg('agent')}.`); process.exit(1); }
    agentId = u.id;
  }
  console.log(UC.format(await UC.run(store.pool, { date: arg('date'), agentId })));
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
