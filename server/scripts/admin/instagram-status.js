'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/instagram-status
// Every athlete's Instagram: connected or why not, scopes, last sync and
// error, followers, local share. Read only.
//   /api/admin/scripts/instagram-status?text=1            (&agent=<email>)
const def = {
  file: 'scripts/instagram-status.js',
  args: (q) => (q.agent ? ['--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120)] : []),
};

module.exports = { name: 'instagram-status', file: def.file, args: def.args };
