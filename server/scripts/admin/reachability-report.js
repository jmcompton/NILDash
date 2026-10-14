'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/reachability-report
// Which business types and signals turn into a verified named-person email,
// from our own history (services/reachability). Recomputed weekly.
//   /api/admin/scripts/reachability-report?text=1[&recompute=1][&days=90]
const def = {
  file: 'scripts/reachability-report.js',
  args: (q) => {
    const a = [];
    if (q.recompute === '1') a.push('--recompute');
    const d = parseInt(q.days, 10);
    if (d > 0) a.push('--days', String(Math.max(7, Math.min(365, d))));
    return a;
  },
};

module.exports = { name: 'reachability-report', file: def.file, args: def.args };
