'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/school-problems
// Athletes the local lane cannot place, across every agent (services/
// localLaneCheck). &apply=1 applies the fixes the record itself determines (a
// pro team typed as the school -> pro with that team's city); everything
// else is listed for the agent, who sees it on Home.
//   /api/admin/scripts/school-problems?text=1
const def = { file: 'scripts/school-problems.js', args: (q) => (q.apply === '1' ? ['--apply'] : []) };

module.exports = { name: 'school-problems', file: def.file, args: def.args };
