'use strict';
// WHERE THE BOUNCES COME FROM (services/bounceReport): per agent, every email
// sent in the last N days (30 by default), split by path (a morning card, or
// by hand) and by what was known about the address as it left (valid,
// catch-all, invalid, unverified, none), with the bounces in each. Read only.
//
//   node scripts/bounce-report.js [--days N] [--agent <email or id>]
//   /api/admin/scripts/bounce-report?text=1[&days=N][&agent=<email or id>]
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : null; };
async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const BR = require(ROOT + 'server/services/bounceReport.js');
  let agentId = null;
  if (arg('agent')) {
    const u = (await store.pool.query(`SELECT id FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`, [arg('agent')])).rows[0];
    if (!u) { console.log(`No agent ${arg('agent')}.`); process.exit(1); }
    agentId = u.id;
  }
  const rep = await BR.run(store.pool, { days: arg('days'), agentId });
  console.log(BR.format(rep, { days: rep.days }));
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
