'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/campus-reach
const def = { file: 'scripts/campus-reach.js', args: (q) => {
  const u = String(q.university || 'univ-cypress');
  if (!/^[a-z0-9_-]{1,80}$/i.test(u)) throw Object.assign(new Error('bad university id'), { status: 400 });
  return ['--university', u].concat(q.apply === '1' ? ['--apply'] : []);
} };

module.exports = { name: 'campus-reach', file: def.file, args: def.args };
