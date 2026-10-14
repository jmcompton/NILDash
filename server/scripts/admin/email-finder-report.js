'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/email-finder-report
// Every DM and call card of the last N nights (default 7), and why it did not
// get an email, counted by reason; Hunter credits this month against the plan.
//   /api/admin/scripts/email-finder-report?text=1&days=7
const def = { file: 'scripts/email-finder-report.js', args: (q) => ['--days', String(Math.max(1, Math.min(60, parseInt(q.days, 10) || 7)))] };

module.exports = { name: 'email-finder-report', file: def.file, args: def.args };
