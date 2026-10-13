'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/send-status
// Whether approved emails are actually leaving: the CAN-SPAM address,
// emails sending now and held (with each hold's reason), and how many the
// release queue sent in the last hour and day versus were sent by hand.
// Read-only; no arguments.
//   /api/admin/scripts/send-status?text=1
const def = { file: 'scripts/send-status.js', args: () => [] };

module.exports = { name: 'send-status', file: def.file, args: def.args };
