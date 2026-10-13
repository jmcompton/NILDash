'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/preflight
// Every external service the night depends on, called once now; results
// written to service_checks. &alert=1 also emails the failures.
//   /api/admin/scripts/preflight?text=1
const def = { file: 'scripts/preflight.js', args: (q) => (q.alert === '1' ? ['--alert'] : []) };

module.exports = { name: 'preflight', file: def.file, args: def.args };
