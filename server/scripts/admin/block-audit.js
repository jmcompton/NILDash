'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/block-audit
// What the stronger block (name + Google's description) catches in the pools
// already built; with apply=1, marks the university pools and withdraws
// waiting team asks to a blocked business.
//   /api/admin/scripts/block-audit?text=1   (&apply=1)
const def = { file: 'scripts/block-audit.js', args: (q) => (q.apply === '1' ? ['--apply'] : []) };

module.exports = { name: 'block-audit', file: def.file, args: def.args };
