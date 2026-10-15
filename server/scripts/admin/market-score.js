'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/market-score
// Each athlete's Market Score, tier and what drove it (services/marketScore).
// Read-only unless save=1 (stores the scores) or search=1 (also runs the
// week's news search, a web search per athlete whose last one is over a week old).
//   /api/admin/scripts/market-score?text=1[&agent=<email or id>][&athlete=<id>][&limit=N][&save=1][&search=1]
const def = {
  file: 'scripts/market-score.js',
  args: (q) => {
    const out = [];
    if (q.agent) out.push('--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120));
    if (q.athlete) out.push('--athlete', String(q.athlete).replace(/[^a-z0-9_-]/gi, '').slice(0, 80));
    const n = parseInt(q.limit, 10);
    if (n >= 1 && n <= 2000) out.push('--limit', String(n));
    if (q.save === '1') out.push('--save');
    if (q.search === '1') out.push('--search');
    return out;
  },
};

module.exports = { name: 'market-score', file: def.file, args: def.args };
