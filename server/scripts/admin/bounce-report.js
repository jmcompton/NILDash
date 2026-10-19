'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/bounce-report
// Per agent, the last N days of sends (30 by default) split by path (card / by
// hand) and by the address's verification at send time, with the bounces in
// each (services/bounceReport). Read only.
//   /api/admin/scripts/bounce-report?text=1[&days=N][&agent=<email or id>]
const def = {
  file: 'scripts/bounce-report.js',
  args: (q) => [...(q.days ? ['--days', String(Math.max(1, Math.min(365, parseInt(q.days, 10) || 30)))] : []),
    ...(q.agent ? ['--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120)] : [])],
};

module.exports = { name: 'bounce-report', file: def.file, args: def.args };
