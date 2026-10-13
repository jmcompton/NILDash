'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/placeholder-audit
// Every unsent draft (cards, email drafts, university asks, mailbox drafts,
// growth templates) checked for a placeholder such as "[athlete_handle]"
// (services/placeholders). Report only; apply removes the lines.
//   /api/admin/scripts/placeholder-audit?text=1   (&apply=1)
const def = { file: 'scripts/placeholder-audit.js', args: (q) => (q.apply === '1' ? ['--apply'] : []) };

module.exports = { name: 'placeholder-audit', file: def.file, args: def.args };
