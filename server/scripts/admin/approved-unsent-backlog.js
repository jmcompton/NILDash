'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/approved-unsent-backlog
// Approved emails that never sent and are too old to send: each re-decided
// once (a fresh unapproved draft, a call card, or a DM card) and the old row
// closed. Dry run unless apply=1. Never sends or approves anything.
const def = { file: 'scripts/approved-unsent-backlog.js', args: (q) => {
  const a = [];
  if (q.date) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(q.date))) throw Object.assign(new Error('date must be YYYY-MM-DD'), { status: 400 }); a.push('--date', String(q.date)); }
  if (q.agent) a.push('--agent', String(q.agent).slice(0, 200));
  if (q.all === '1') a.push('--all');
  if (q.days) a.push('--older-than-days', String(Math.max(1, Math.min(60, parseInt(q.days, 10) || 3))));
  if (q.apply === '1') a.push('--apply');
  return a;
} };

module.exports = { name: 'approved-unsent-backlog', file: def.file, args: def.args };
