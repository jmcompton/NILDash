'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/spend-breakdown
// What a night's model calls cost, by call site, athlete and agent, from
// ai_call_ledger; the nightly run rows' own estimate beside it; repeat calls.
// Report only (scripts/spend-breakdown.js).
//   /api/admin/scripts/spend-breakdown?text=1                  the last 24 hours
//   /api/admin/scripts/spend-breakdown?text=1&date=YYYY-MM-DD  that run date
//   /api/admin/scripts/spend-breakdown?text=1&hours=36
//   /api/admin/scripts/spend-breakdown?text=1&agent=<agent email>
const def = {
  file: 'scripts/spend-breakdown.js',
  args: (q) => {
    const out = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.date || ''))) out.push('--date', String(q.date));
    else if (q.hours) out.push('--hours', String(Math.max(1, Math.min(24 * 14, parseFloat(q.hours) || 24))));
    if (q.agent) out.push('--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120));
    return out;
  },
};

module.exports = { name: 'spend-breakdown', file: def.file, args: def.args };
