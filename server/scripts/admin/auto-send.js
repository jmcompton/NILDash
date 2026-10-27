'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/auto-send
// Done-for-you sending (services/autoSend): who has it on, what each morning
// approved and actually sent, and the one-time invite.
//   /api/admin/scripts/auto-send?text=1
//   /api/admin/scripts/auto-send?text=1&invite=1          dry run: who would get the invite, and the email
//   /api/admin/scripts/auto-send?text=1&invite=1&send=1   send it (once per agent, ever)
const def = {
  file: 'scripts/auto-send.js',
  args: (q) => [].concat(q.invite === '1' ? ['--invite'] : [], q.invite === '1' && q.send === '1' ? ['--send'] : []),
};

module.exports = { name: 'auto-send', file: def.file, args: def.args };
