'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/lane-band-report
const def = { file: 'scripts/lane-band-report.js', args: (q) => ['--days', String(Math.max(1, Math.min(365, parseInt(q.days, 10) || 42)))] };

module.exports = { name: 'lane-band-report', file: def.file, args: def.args };
