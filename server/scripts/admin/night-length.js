'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/night-length
// The night's length as measured, and as the code now runs it under
// EMAIL_FIVE_ON (athletes side by side, a 15-minute ceiling); and Hunter that
// night (services/nightLength). Read-only.
//   /api/admin/scripts/night-length?text=1[&date=YYYY-MM-DD][&athletes=N][&agents=N]
const def = {
  file: 'scripts/night-length.js',
  args: (q) => {
    const out = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.date || ''))) out.push('--date', String(q.date));
    for (const k of ['athletes', 'agents']) {
      const n = parseInt(q[k], 10);
      if (n >= 1 && n <= 20) out.push('--' + k, String(n));
    }
    return out;
  },
};

module.exports = { name: 'night-length', file: def.file, args: def.args };
