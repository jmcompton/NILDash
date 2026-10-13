'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/lookup-pro-hitrate
const def = { file: 'scripts/lookup-pro-hitrate.js', args: (q) => [].concat(q.league ? ['--league', String(q.league).replace(/[^a-z]/gi, '').slice(0, 10)] : [], q.noTeam ? ['--no-team'] : [], (q.fresh || q.force) ? ['--fresh'] : []) };

module.exports = { name: 'lookup-pro-hitrate', file: def.file, args: def.args };
