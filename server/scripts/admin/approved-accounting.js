'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/approved-accounting
// Every email approved and unsent when the release queue shipped, by
// business, with what became of it: sent, held, deduped, stopped, waiting.
// Read-only. before= overrides the cutoff (default: the queue's first act).
//   /api/admin/scripts/approved-accounting?text=1
const def = { file: 'scripts/approved-accounting.js', args: (q) => (q.before && !isNaN(Date.parse(q.before)) ? ['--before=' + new Date(q.before).toISOString()] : []) };

module.exports = { name: 'approved-accounting', file: def.file, args: def.args };
