'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/purge-outage-negatives
// Negative cache rows written during an outage window, per lane; &apply=1
// deletes them so the next lookup asks again (services/ourFault).
//   /api/admin/scripts/purge-outage-negatives?since=2026-09-16&text=1
const def = { file: 'scripts/purge-outage-negatives.js', args: (q) => {
  const d = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : null);
  if (!d(q.since)) { const e = new Error('since=YYYY-MM-DD is required'); e.status = 400; throw e; }
  return ['--since', d(q.since)].concat(d(q.until) ? ['--until', d(q.until)] : [], q.apply === '1' ? ['--apply'] : []);
} };

module.exports = { name: 'purge-outage-negatives', file: def.file, args: def.args };
