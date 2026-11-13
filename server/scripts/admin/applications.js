'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/applications
// Every queued program card with its finished application (services/applyPacket),
// as Home's "Ready to apply" shows it. Read only.
//   /api/admin/scripts/applications?text=1            (&agent=<email>&limit=N&closebad=1)
const def = {
  file: 'scripts/applications.js',
  args: (q) => [
    ...(q.agent ? ['--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120)] : []),
    ...(q.limit ? ['--limit', String(parseInt(q.limit, 10) || 50)] : []),
    ...(q.closebad === '1' ? ['--close-bad'] : []),
  ],
};

module.exports = { name: 'applications', file: def.file, args: def.args };
