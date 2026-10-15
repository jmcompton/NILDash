'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/market-mix-dryrun
// For each athlete: the Market Score, the tier, and the five cards the night
// would place under MARKET_MIX_ON (services/marketScore, services/dealMix).
// Places nothing, sends nothing, stores nothing. It spends real money (name
// searches, mailbox checks, the writer): five athletes by default, 50 at most.
//   /api/admin/scripts/market-mix-dryrun?text=1[&agent=<email or id>][&athlete=<id>][&limit=N][&search=1][&verbose=1]
const def = {
  file: 'scripts/market-mix-dryrun.js',
  args: (q) => {
    const out = [];
    if (q.agent) out.push('--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120));
    if (q.athlete) out.push('--athlete', String(q.athlete).replace(/[^a-z0-9_-]/gi, '').slice(0, 80));
    const n = parseInt(q.limit, 10);
    if (n >= 1 && n <= 50) out.push('--limit', String(n));
    if (q.search === '1') out.push('--search');
    if (q.verbose === '1') out.push('--verbose');
    return out;
  },
};

module.exports = { name: 'market-mix-dryrun', file: def.file, args: def.args };
