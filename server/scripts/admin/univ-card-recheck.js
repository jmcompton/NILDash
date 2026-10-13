'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/univ-card-recheck
// Which of a university's unworked cards today's rules would drop (a
// chain or hotel brand) or strip of their contact (a junior or
// non-marketing title). Read only.
const def = {
  file: 'scripts/univ-card-recheck.js',
  args: (q) => {
    const u = String(q.university || 'univ-cypress');
    if (!/^[a-z0-9_-]{1,80}$/i.test(u)) throw Object.assign(new Error('bad university id'), { status: 400 });
    return ['--university', u];
  },
};

module.exports = { name: 'univ-card-recheck', file: def.file, args: def.args };
