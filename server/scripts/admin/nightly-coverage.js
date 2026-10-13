'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/nightly-coverage
// Every athlete, every night of the last week (?days=N): ran the loop, or
// exactly which rule kept them out (agent dormant/skipped, no run row, run
// unfinished, not reached, paused, slots full, no school ...). ?athlete=
// narrows to names containing it. Read-only.
//   /api/admin/scripts/nightly-coverage?text=1
const def = { file: 'scripts/nightly-coverage.js', args: (q) => [
  ...(q.days ? ['--days', String(parseInt(q.days, 10) || 7)] : []),
  ...(q.athlete ? ['--athlete', String(q.athlete).slice(0, 80)] : []) ] };

module.exports = { name: 'nightly-coverage', file: def.file, args: def.args };
