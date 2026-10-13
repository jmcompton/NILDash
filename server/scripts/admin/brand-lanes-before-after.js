'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/brand-lanes-before-after
// The national and social lanes for one athlete (or an agent's first few),
// before and after the signing-evidence bar, with each brand's evidence,
// band, and why each refused one was refused. Read-only, no spend.
//   /api/admin/scripts/brand-lanes-before-after?athlete=<id or name>&text=1   (&agent=<email>&max=3)
const def = { file: 'scripts/brand-lanes-before-after.js', args: (q) => [].concat(
  q.athlete ? ['--athlete', String(q.athlete).replace(/[^a-z0-9 ._'-]/gi, '').slice(0, 120)] : [],
  q.agent ? ['--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120)] : [],
  q.max ? ['--max', String(parseInt(q.max, 10) || 3)] : []) };

module.exports = { name: 'brand-lanes-before-after', file: def.file, args: def.args };
