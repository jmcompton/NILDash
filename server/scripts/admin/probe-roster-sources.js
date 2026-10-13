'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/probe-roster-sources
const def = { file: 'scripts/probe-roster-sources.js', args: (q) => (q.only ? ['--only', String(q.only).replace(/[^a-z0-9-]/gi, '').slice(0, 20)] : []) };

module.exports = { name: 'probe-roster-sources', file: def.file, args: def.args };
