'use strict';
// FREE THE HELD SLOTS (services/freeHeldSlots): retire every queued DM, call
// and unverified email card, so the five slots open for verified emails.
// Never a card the agent approved, sent or marked done, or one with a reply.
// Counts per agent and athlete: retired, kept and why. DRY RUN unless --apply.
//
//   node scripts/free-held-slots.js [--apply] [--agent <id>]
//   /api/admin/scripts/free-held-slots?text=1[&apply=1][&agent=<id>]
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const FH = require(ROOT + 'server/services/freeHeldSlots.js');
  const i = process.argv.indexOf('--agent');
  const who = i > -1 ? String(process.argv[i + 1] || '').trim() : '';
  let agentId = null;
  if (who) {
    const u = (await store.pool.query(`SELECT id FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`, [who])).rows[0];
    if (!u) { console.log(`No agent ${who}. Nothing done.`); process.exit(1); }
    agentId = u.id;
  }
  const r = await FH.run(store.pool, { apply: process.argv.includes('--apply'), agentId });
  console.log(FH.format(r));
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
