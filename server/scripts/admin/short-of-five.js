'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/short-of-five
// Athletes holding fewer than five verified-email cards this morning, and why
// (services/shortOfFive). Printed, not sent, unless send=1.
//   /api/admin/scripts/short-of-five?text=1[&send=1]
const def = { file: 'scripts/short-of-five.js', args: (q) => (q.send === '1' ? ['--send'] : []) };

module.exports = { name: 'short-of-five', file: def.file, args: def.args };
