'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/morning-alert
// What this morning's alert says (services/morningAlert), printed and NOT
// sent. ?send=1 sends it now, whatever the hour, if nothing has gone today.
//   /api/admin/scripts/morning-alert?text=1
const def = { file: 'scripts/morning-alert.js', args: (q) => (q.send === '1' ? ['--send'] : []) };

module.exports = { name: 'morning-alert', file: def.file, args: def.args };
