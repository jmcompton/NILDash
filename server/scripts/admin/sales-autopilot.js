'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/sales-autopilot
// The sales autopilot (services/salesAutopilot) in numbers, for any date range.
//   /api/admin/scripts/sales-autopilot?text=1                       the last 7 days
//   /api/admin/scripts/sales-autopilot?text=1&days=30
//   /api/admin/scripts/sales-autopilot?text=1&from=YYYY-MM-DD&to=YYYY-MM-DD
//   /api/admin/scripts/sales-autopilot?text=1&dry=1     find and draft now, send nothing, show day 1
//   /api/admin/scripts/sales-autopilot?text=1&plan=1    the next sending day's plan
//   /api/admin/scripts/sales-autopilot?text=1&resume=1  turn it back on after a hard stop
const d = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : null);
const def = {
  file: 'scripts/sales-autopilot.js',
  args: (q) => {
    if ((q.from && !d(q.from)) || (q.to && !d(q.to))) { const e = new Error('from and to are dates: YYYY-MM-DD'); e.status = 400; throw e; }
    return [].concat(
      q.resume === '1' ? ['--resume'] : [],
      q.dry === '1' ? ['--dry'] : [],
      q.plan === '1' ? ['--plan'] : [],
      q.samples === '1' ? ['--samples'] : [],
      d(q.from) ? ['--from', d(q.from)] : [],
      d(q.to) ? ['--to', d(q.to)] : [],
      q.days ? ['--days', String(Math.max(1, Math.min(366, parseInt(q.days, 10) || 7)))] : []);
  },
};

module.exports = { name: 'sales-autopilot', file: def.file, args: def.args };
