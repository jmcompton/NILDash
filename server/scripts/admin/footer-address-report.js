'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/footer-address-report
// Who has sent outreach with the global postal address in the footer, by
// agent, since the footer began. Read only.
const def = { file: 'scripts/footer-address-report.js', args: () => [] };

module.exports = { name: 'footer-address-report', file: def.file, args: def.args };
