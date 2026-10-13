'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/follow-up-plan
// Every first email in the lookback and what the follow-up pass will do
// with it: due, waiting on the agent, or stopped and why. Read-only.
const def = { file: 'scripts/follow-up-plan.js', args: () => [] };

module.exports = { name: 'follow-up-plan', file: def.file, args: def.args };
