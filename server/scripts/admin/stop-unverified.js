'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/stop-unverified
// Every queued, approved-unsent or scheduled follow-up email whose address is
// not a named person's with a valid verification in the last 30 days, by
// agent (services/stopUnverified). DRY RUN unless apply=1, which stops them
// and offers the call or DM instead. agent=<email or id> limits it to one agent.
//   /api/admin/scripts/stop-unverified?text=1[&apply=1][&agent=<email or id>]
const def = {
  file: 'scripts/stop-unverified.js',
  args: (q) => [...(q.apply === '1' ? ['--apply'] : []),
    ...(q.agent ? ['--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120)] : [])],
};

module.exports = { name: 'stop-unverified', file: def.file, args: def.args };
