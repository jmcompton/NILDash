'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/market-pools
// Every athlete market's pool: how many distinct markets, how many have zero
// usable rows, and (with apply) build the due ones from Places
// (services/marketPools).
//   /api/admin/scripts/market-pools?text=1   (&apply=1, &all=1 lifts the per-run limits)
const def = { file: 'scripts/market-pools.js', args: (q) => [...(q.apply === '1' ? ['--apply'] : []), ...(q.all === '1' ? ['--all'] : [])] };

module.exports = { name: 'market-pools', file: def.file, args: def.args };
