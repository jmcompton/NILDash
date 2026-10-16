'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/unverified-cards
// For one night: every email card and email draft written, the path its
// address came from, and whether it was a named person's valid address
// (services/unverifiedCards). Read only.
//   /api/admin/scripts/unverified-cards?text=1[&date=YYYY-MM-DD][&agent=<email or id>]
const def = {
  file: 'scripts/unverified-cards.js',
  args: (q) => [...(/^\d{4}-\d{2}-\d{2}$/.test(String(q.date || '')) ? ['--date', String(q.date)] : []),
    ...(q.agent ? ['--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120)] : [])],
};

module.exports = { name: 'unverified-cards', file: def.file, args: def.args };
