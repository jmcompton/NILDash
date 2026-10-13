'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/university-users-audit
// Who is in the legacy university_users table (the compliance-portal
// accounts behind /api/university/register and /login), flagged test or real.
// Read-only; no password hash is read. Decides whether those routes retire.
//   /api/admin/scripts/university-users-audit?text=1
const def = { file: 'scripts/university-users-audit.js', args: () => [] };

module.exports = { name: 'university-users-audit', file: def.file, args: def.args };
