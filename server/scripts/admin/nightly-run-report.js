'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/nightly-run-report
// What last night's fill actually did for one agent, athlete by athlete,
// with the reason every untried athlete was skipped.
const def = { file: 'scripts/nightly-run-report.js', args: (q) => [].concat(
  q.agent ? ['--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120)] : [],
  q.nights ? ['--nights', String(parseInt(q.nights, 10) || 4)] : []) };

module.exports = { name: 'nightly-run-report', file: def.file, args: def.args };
