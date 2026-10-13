'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/team-scan
// One university team's sponsor scan (services/teamScan): Places around the
// campus, the slate with fit scores, and each ask written, left awaiting
// approval. Never sends. University tables only.
//   /api/admin/scripts/team-scan?university=univ-cypress&team=mbb&text=1
//   add &write=0 to print the slate without writing asks
const def = { file: 'scripts/team-scan.js', args: (q) => {
  if (!q.university || !q.team) { const e = new Error('university and team are required, e.g. ?university=univ-cypress&team=mbb'); e.status = 400; throw e; }
  return ['--university', String(q.university).replace(/[^a-z0-9:_-]/gi, '').slice(0, 60),
    '--team', String(q.team).replace(/[^a-z0-9:_-]/gi, '').slice(0, 80)].concat(
    q.limit ? ['--limit', String(parseInt(q.limit, 10) || 5)] : [],
    q.write === '0' ? ['--no-write'] : [], q.discover === '0' ? ['--no-discover'] : []);
} };

module.exports = { name: 'team-scan', file: def.file, args: def.args };
