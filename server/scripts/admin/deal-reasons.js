'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/deal-reasons
// Why businesses declined and why signed deals worked, as agents recorded them
// (services/crm, CRM_ON): each reason counted by business type and by offer
// amount, with the "Other" notes. Read only.
//   /api/admin/scripts/deal-reasons?text=1[&days=N][&agent=<email or id>]
const def = {
  file: 'scripts/deal-reasons.js',
  args: (q) => [...(q.days ? ['--days', String(Math.max(1, Math.min(3650, parseInt(q.days, 10) || 30)))] : []),
    ...(q.agent ? ['--agent', String(q.agent).replace(/[^a-z0-9@._+-]/gi, '').slice(0, 120)] : [])],
};

module.exports = { name: 'deal-reasons', file: def.file, args: def.args };
