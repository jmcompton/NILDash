'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/auto-send
// Done-for-you sending (services/autoSend): who has it on, what each morning
// approved and actually sent, and the one-time invite.
//   /api/admin/scripts/auto-send?text=1
//   /api/admin/scripts/auto-send?text=1&invite=1          dry run: who would get the invite, and the email
//   /api/admin/scripts/auto-send?text=1&invite=1&send=1   send it (once per agent, ever; ready agents only)
//   ...&exclude=a@x.com,b@y.com                            never these
const def = {
  file: 'scripts/auto-send.js',
  args: (q) => {
    const ex = String(q.exclude || '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@,]+@[^\s@,]+\.[a-z]{2,}$/.test(e));
    return [].concat(q.invite === '1' ? ['--invite'] : [], q.invite === '1' && q.send === '1' ? ['--send'] : [],
      q.invite === '1' && ex.length ? ['--exclude', ex.join(',')] : []);
  },
};

module.exports = { name: 'auto-send', file: def.file, args: def.args };
