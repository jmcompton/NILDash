'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/platform-address-audit
// Every live card whose email is on a platform's domain (ce@squareup.com and
// the like), by agent (services/platformAudit). READ ONLY unless apply=1,
// which stops those emails, offers the call or DM instead, and takes the
// address off the cards. agent=<email or id> limits it to one agent.
//   /api/admin/scripts/platform-address-audit?text=1[&apply=1][&agent=<email or id>]
const def = {
  file: 'scripts/platform-address-audit.js',
  args: (q) => [...(q.apply === '1' ? ['--apply'] : []),
    ...(q.agent ? ['--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120)] : [])],
};

module.exports = { name: 'platform-address-audit', file: def.file, args: def.args };
