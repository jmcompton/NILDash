'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/fix-draft-sender
// Unsent drafts signed with the login email instead of the sending mailbox;
// apply=1 rewrites that one generated signature line.
//   /api/admin/scripts/fix-draft-sender?text=1   (&apply=1)
const def = { file: 'scripts/fix-draft-sender.js', args: (q) => (q.apply === '1' ? ['--apply'] : []) };

module.exports = { name: 'fix-draft-sender', file: def.file, args: def.args };
