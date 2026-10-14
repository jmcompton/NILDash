'use strict';
// THE ONBOARDING FUNNEL (services/onboardingFunnel): per agent and in total,
// when each of the eight steps first happened. Read-only.
//
//   node scripts/onboarding-funnel.js [--agent <email or id>]
//   /api/admin/scripts/onboarding-funnel?text=1[&agent=<email or id>]
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const OF = require(ROOT + 'server/services/onboardingFunnel.js');
  const i = process.argv.indexOf('--agent');
  const who = i > -1 ? String(process.argv[i + 1] || '').trim() : '';
  let agentId = null;
  if (who) {
    const u = (await store.pool.query(`SELECT id FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`, [who])).rows[0];
    if (!u) { console.log(`No agent ${who}.`); process.exit(1); }
    agentId = u.id;
  }
  console.log(OF.format(await OF.run(store.pool, { agentId })));
  process.exit(0);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
