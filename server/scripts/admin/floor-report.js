'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/floor-report
// The floor of five: how many candidates each athlete took to reach five,
// who stopped short and why, pass rate by lane, rungs fired
// (jobs/outreachQueue loop metrics on the run row).
//   /api/admin/scripts/floor-report?text=1&days=1
const def = { file: 'scripts/floor-report.js', args: (q) => ['--days', String(Math.max(1, Math.min(60, parseInt(q.days, 10) || 7)))] };

module.exports = { name: 'floor-report', file: def.file, args: def.args };
