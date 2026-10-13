'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/evidence-before-after
// Real cards written twice by the live writer, without and with the
// marketing-activity evidence, side by side. Writes nothing; spends two
// writer calls a card (labelled writer.beforeafter in the ledger).
//   /api/admin/scripts/evidence-before-after?text=1
//   /api/admin/scripts/evidence-before-after?n=5&agent=<agent id>&text=1
const def = {
  file: 'scripts/evidence-before-after.js',
  args: (q) => [].concat(
    q.n ? ['--n', String(Math.min(Math.max(parseInt(q.n, 10) || 3, 1), 10))] : [],
    q.agent ? ['--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120)] : []),
};

module.exports = { name: 'evidence-before-after', file: def.file, args: def.args };
