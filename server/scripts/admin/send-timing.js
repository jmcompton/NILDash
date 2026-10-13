'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/send-timing
// One agent's sends: which path each took (Approve or the editor's Send),
// the click, approval, claim and send times with the gaps, failures, and any
// business that got more than one email from the account. Read-only.
//   /api/admin/scripts/send-timing?agent=jdubose@truepathmgmt.org&days=7&text=1
const def = { file: 'scripts/send-timing.js', args: (q) => {
  if (!q.agent) { const e = new Error('agent=<email or id> is required'); e.status = 400; throw e; }
  return ['--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120), '--days', String(Math.max(1, Math.min(60, parseInt(q.days, 10) || 7)))];
} };

module.exports = { name: 'send-timing', file: def.file, args: def.args };
