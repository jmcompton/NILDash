'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/slate-before-after
// The same night's candidates ranked under the old rules and the new ones,
// side by side, for one athlete or an agent's first few. Read-only: it builds
// a slate and prints it, places nothing and spends nothing.
//   /api/admin/scripts/slate-before-after?athlete=ath_amari&text=1
//   /api/admin/scripts/slate-before-after?agent=cs@9091sportsagency.com&max=3&text=1
const def = {
  file: 'scripts/slate-before-after.js',
  args: (q) => [].concat(
    q.athlete ? ['--athlete', String(q.athlete).replace(/[^a-z0-9 ._'-]/gi, '').slice(0, 120)] : [],
    q.agent ? ['--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120)] : [],
    q.max ? ['--max', String(parseInt(q.max, 10) || 5)] : [],
    q.limit ? ['--limit', String(parseInt(q.limit, 10) || 5)] : []),
};

module.exports = { name: 'slate-before-after', file: def.file, args: def.args };
