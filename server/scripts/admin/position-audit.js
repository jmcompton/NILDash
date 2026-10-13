'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/position-audit
// How many athletes the writer's position check refused, and who still holds
// a position the old check could refuse. Read-only; there is no apply.
//   /api/admin/scripts/position-audit?text=1
const def = { file: 'scripts/position-audit.js', args: () => [] };

module.exports = { name: 'position-audit', file: def.file, args: def.args };
