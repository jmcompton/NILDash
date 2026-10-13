'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/contact-mismatch-audit
// Every athlete's school, the market it resolves to, and the markets their
// cards were actually built in: anyone pitched to another town's businesses
// (the Columbia University -> Columbia, Missouri bug). Free by default;
// verify=1 locates each named school with Places; apply=1 saves corrections.
//   /api/admin/scripts/school-market-audit?text=1   (&verify=1, &apply=1)
// Cards whose email does not carry the named person's name (the Greg
// Neichter / austin.mitchell@ stitch): on screens now, approved, and sent in
// the last 30 days. Read-only.
//   /api/admin/scripts/contact-mismatch-audit?text=1
const def = { file: 'scripts/contact-mismatch-audit.js', args: (q) => (q.apply === '1' ? ['--apply'] : []) };

module.exports = { name: 'contact-mismatch-audit', file: def.file, args: def.args };
