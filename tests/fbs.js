'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// The FBS list and its merge into programMap.
const path = require('path');
const AI = path.resolve(REPO + 'server/ai.js');
require.cache[AI] = { id: AI, filename: AI, loaded: true, exports: { oneShot: async () => '', MODEL_FAST: 'x', webSearchJson: async () => ({ text: '{}' }) } };
const { FBS_SCHOOLS } = require(REPO + 'server/data/fbsSchools.js');
const pm = require(REPO + 'server/services/programMap.js');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}

console.log('-- the list itself --');
const keys = Object.keys(FBS_SCHOOLS);
ok('has 125 entries (135 with the 10 pilot)', keys.length === 125, keys.length);
ok('every domain is well formed',
  keys.every((k) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(FBS_SCHOOLS[k])), 
  keys.filter((k) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(FBS_SCHOOLS[k])));
ok('no domain has a scheme or a path',
  keys.every((k) => !/[/:]/.test(FBS_SCHOOLS[k])), null);
const dom = {};
for (const k of keys) (dom[FBS_SCHOOLS[k]] = dom[FBS_SCHOOLS[k]] || []).push(k);
ok('no two schools share a domain',
  Object.values(dom).every((v) => v.length === 1),
  Object.entries(dom).filter(([, v]) => v.length > 1));

console.log('-- the merge never overwrites a pilot school --');
ok('all 10 pilot schools survive', pm.PILOT_SCHOOLS.length === 10, pm.PILOT_SCHOOLS.length);
for (const s of pm.PILOT_SCHOOLS) {
  ok(`${s} keeps its pilot config (team name intact)`,
    !!pm.SCHOOLS[s].edu, pm.SCHOOLS[s]);
}
ok('Alabama still points at rolltide.com',
  pm.SCHOOLS['Alabama'].athletics === 'rolltide.com', pm.SCHOOLS['Alabama']);
ok('Alabama keeps its verified hand-set URL',
  pm.VERIFIED_STAFF_URLS['Alabama'] === 'https://rolltide.com/sports/football/coaches',
  pm.VERIFIED_STAFF_URLS['Alabama']);

console.log('-- ALL_SCHOOLS --');
ok('is 135 schools', pm.ALL_SCHOOLS.length === 135, pm.ALL_SCHOOLS.length);
ok('contains every pilot school', pm.PILOT_SCHOOLS.every((s) => pm.ALL_SCHOOLS.includes(s)), null);
ok('contains every FBS school', keys.every((s) => pm.ALL_SCHOOLS.includes(s)), null);
ok('is sorted', pm.ALL_SCHOOLS.join('|') === [...pm.ALL_SCHOOLS].sort().join('|'), null);
ok('has no duplicates', new Set(pm.ALL_SCHOOLS).size === pm.ALL_SCHOOLS.length, null);
ok('every school has an athletics domain the sweep can use',
  pm.ALL_SCHOOLS.every((s) => pm.SCHOOLS[s] && pm.SCHOOLS[s].athletics), 
  pm.ALL_SCHOOLS.filter((s) => !(pm.SCHOOLS[s] && pm.SCHOOLS[s].athletics)));

console.log('-- the pilot list is unchanged, so existing commands still mean what they meant --');
ok('PILOT_SCHOOLS is still just the 10 SEC programs',
  pm.PILOT_SCHOOLS.join(',') === 'Alabama,Auburn,Georgia,Tennessee,Ole Miss,LSU,Texas A&M,Florida,South Carolina,Missouri',
  pm.PILOT_SCHOOLS);

console.log('');
console.log('failures: ' + fails);
process.exit(fails ? 1 : 0);
