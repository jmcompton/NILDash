'use strict';
// Admin script descriptor (services/adminScripts): GET /api/admin/scripts/places-rebuild
// Rebuild the Places pool for markets and print how many businesses each
// returned (services/placesMarket, the New API). Writes the market cache and
// market_business_seen for an agent market, university_market_seen for a campus.
//   /api/admin/scripts/places-rebuild?market=Auburn%20University&campus=univ-cypress&text=1
const def = { file: 'scripts/places-rebuild.js', args: (q) => [].concat(
  q.market ? ['--market', String(q.market).replace(/[^a-z0-9 ,.'&-]/gi, '').slice(0, 120)] : [],
  q.campus ? ['--campus', String(q.campus).replace(/[^a-z0-9:_-]/gi, '').slice(0, 60)] : [],
  q.write === '0' ? ['--no-write'] : []) };

module.exports = { name: 'places-rebuild', file: def.file, args: def.args };
