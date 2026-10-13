'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/demo-stats
// Visits to the public /demo page, by referrer, screens, what visitors did
// (Deal Scan, pitch opened/approved, Book a call) and median time on page.
// Read-only; no arguments.
//   /api/admin/scripts/demo-stats?text=1
const def = { file: 'scripts/demo-stats.js', args: () => [] };

module.exports = { name: 'demo-stats', file: def.file, args: def.args };
