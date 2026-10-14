'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/email-finder-dryrun
// Re-runs the email finder over the last N nights' DM and call cards (default
// 7), before and after. No card changes, no sends. Spends Hunter credits.
//   /api/admin/scripts/email-finder-dryrun?text=1&days=7[&limit=50][&maxVerify=900]
const def = {
  file: 'scripts/email-finder-dryrun.js',
  args: (q) => {
    const a = ['--days', String(Math.max(1, Math.min(30, parseInt(q.days, 10) || 7)))];
    const lim = parseInt(q.limit, 10);
    if (lim > 0) a.push('--limit', String(Math.min(500, lim)));
    const mv = parseInt(q.maxVerify, 10);
    if (mv > 0) a.push('--max-verify', String(Math.min(3000, mv)));
    return a;
  },
};

module.exports = { name: 'email-finder-dryrun', file: def.file, args: def.args };
