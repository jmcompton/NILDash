'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/restore-false-stops
// Every email the send gate stopped as "not their address" (stop-unverified,
// or the gate at send) whose address now passes the corrected name rule
// (services/nameMatch: initials, nicknames) with a valid verification in the
// last 30 days, by agent (services/restoreFalseStops). DRY RUN unless
// apply=1, which puts each back as a draft on Home for the agent to approve.
// agent=<email or id> limits it to one agent.
//   /api/admin/scripts/restore-false-stops?text=1[&apply=1][&agent=<email or id>]
const def = {
  file: 'scripts/restore-false-stops.js',
  args: (q) => [...(q.apply === '1' ? ['--apply'] : []),
    ...(q.agent ? ['--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120)] : [])],
};

module.exports = { name: 'restore-false-stops', file: def.file, args: def.args };
