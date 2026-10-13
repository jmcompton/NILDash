'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/real-outcomes
// Reply rate by lane and size band, with or without signing evidence: is a
// national brand a lead or a fantasy, measured. Read-only.
//   /api/admin/scripts/lane-band-report?days=42&text=1
// Every business contacted or beyond, by agent, with what happened next;
// every reply, decline and logged deal anywhere. Read-only.
const def = { file: 'scripts/real-outcomes.js', args: () => [] };

module.exports = { name: 'real-outcomes', file: def.file, args: def.args };
