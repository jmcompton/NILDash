'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/signed-why
// For one agent, every record that makes a business read "signed" anywhere
// (Home, My Brands, the Pipeline) and where each came from, so a signed card
// nobody signed can be traced. Read only.
//   /api/admin/scripts/signed-why?text=1&agent=<email or id>[&athlete=<name>][&brand=<part of the name>]
const clean = (v, n) => String(v).replace(/[^a-z0-9@._+' -]/gi, '').slice(0, n);
const def = {
  file: 'scripts/signed-why.js',
  args: (q) => [...(q.agent ? ['--agent', clean(q.agent, 120)] : []),
    ...(q.athlete ? ['--athlete', clean(q.athlete, 80)] : []),
    ...(q.brand ? ['--brand', clean(q.brand, 80)] : [])],
};

module.exports = { name: 'signed-why', file: def.file, args: def.args };
