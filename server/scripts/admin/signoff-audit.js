'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/signoff-audit
// Every sent email and DM signed with a stand-in name ("JohnMark", "Your
// Agent", "NIL Agent", "Agent", an email local part), who received it, the
// drafts still waiting with one, and the agents who now get no cards until
// they add a name. Read-only; no arguments.
//   /api/admin/scripts/signoff-audit?text=1
const def = { file: 'scripts/signoff-audit.js', args: () => [] };

module.exports = { name: 'signoff-audit', file: def.file, args: def.args };
