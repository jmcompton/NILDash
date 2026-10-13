'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/brief
// ── ONE MORNING BRIEF, NOW, ON DEMAND ───────────────────────────────────
// The briefs run themselves at 5:30, 5:45, 6:00 and 6:15 Central. This is
// how you find out whether one WORKS without waiting until tomorrow
// morning to discover that a key is missing.
//
//   /api/admin/scripts/brief?which=prospecting&noEmail=1&text=1
//   /api/admin/scripts/brief?which=news-watch&text=1          (mails it)
//
// It goes through run-slot.js --brief, the same entry point Railway's cron
// uses, so a brief that works here works there. noEmail=1 archives the
// brief without sending it, and dry=1 (prospecting) counts without spending
// a model call. `which` is checked against the four names rather than
// interpolated: this builds a command line.
const def = {
  file: 'tools/briefs/run-slot.js',
  args: (q) => {
    const names = ['follow-ups', 'news-watch', 'prospecting', 'strategy-watch'];
    const which = String(q.which || q.brief || '').trim();
    if (!names.includes(which)) {
      const e = new Error(`which must be one of ${names.join(', ')} — e.g. /api/admin/scripts/brief?which=news-watch&noEmail=1&text=1`);
      e.status = 400;
      throw e;
    }
    // dry=1 becomes --brief-dry, which run-slot forwards to the brief as
    // its own --dry. run-slot's --dry means something else entirely (name
    // the slot, run nothing) and must not be reachable from here.
    return ['--brief', which].concat(q.noEmail ? ['--no-email'] : [], q.dry ? ['--brief-dry'] : [], q.debug ? ['--debug'] : []);
  },
};

module.exports = { name: 'brief', file: def.file, args: def.args };
