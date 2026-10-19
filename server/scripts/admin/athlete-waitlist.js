'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/athlete-waitlist
// Everyone who joined the athlete waitlist on the public homepage, newest
// first (services/publicHome). Read only. No arguments.
//   /api/admin/scripts/athlete-waitlist?text=1
const def = { file: 'scripts/athlete-waitlist.js', args: () => [] };

module.exports = { name: 'athlete-waitlist', file: def.file, args: def.args };
