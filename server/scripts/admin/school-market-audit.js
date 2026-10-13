'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/school-market-audit
const def = { file: 'scripts/school-market-audit.js', args: (q) => [].concat(q.verify === '1' ? ['--verify'] : [], q.verify === '1' && q.apply === '1' ? ['--apply'] : []) };

module.exports = { name: 'school-market-audit', file: def.file, args: def.args };
