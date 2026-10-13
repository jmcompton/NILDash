'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/mybrands-cleanup
// What My Brands is still showing that it should not: placeholder business
// names, and owner fields holding a sentence instead of a person. Reports by
// default and changes nothing; the flags are what make it write.
const def = {
  file: 'scripts/mybrands-cleanup.js',
  args: (q) => [].concat(q.fixOwners ? ['--fix-owners'] : [], q.deletePlaceholders ? ['--delete-placeholders'] : []),
};

module.exports = { name: 'mybrands-cleanup', file: def.file, args: def.args };
