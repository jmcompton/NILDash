'use strict';
// ── DEAL REASONS ────────────────────────────────────────────────────────────
//
// Why businesses declined, and why the deals that closed worked, as agents
// recorded them in the CRM (services/crm, CRM_ON): each reason counted by
// business type and by the offer on the table (services/dealReasons).
// Read-only.
//
//   node scripts/deal-reasons.js [--days N] [--agent <email or id>]
//   /api/admin/scripts/deal-reasons?text=1[&days=N][&agent=<email or id>]
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const DR = require(ROOT + 'server/services/dealReasons.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : null; };

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  let agentId = null;
  if (arg('agent')) {
    const u = (await store.pool.query(`SELECT id FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`, [arg('agent')])).rows[0];
    if (!u) { console.log(`No agent matches "${arg('agent')}".`); return; }
    agentId = String(u.id);
  }
  const days = arg('days') ? Math.max(1, Math.min(3650, parseInt(arg('days'), 10) || 0)) : null;
  console.log(DR.render(await DR.gather(store.pool, { days, agentId })));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
