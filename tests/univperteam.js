'use strict';
// No database needed.
//
//   node tests/univperteam.js
//
// ── TWO CARDS A TEAM ON THE UNIVERSITY NIGHT ────────────────────────────────
// Cypress, Oct 6: 17 teams x 5 = 85 cards wanted, the $5 cap ran out at 41,
// Flag Football got none. The night now asks two a team (one social seat, one
// local): 34 cards, what $5 sustains. UNIVERSITY_CARDS_PER_TEAM sets 1-5.
const path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.join(__dirname, '..') + path.sep;

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 300) : '')); } };

// Each setting in a fresh process: PER_TEAM is read once, at require.
const perTeam = (val) => {
  const env = { ...process.env };
  delete env.UNIVERSITY_CARDS_PER_TEAM;
  if (val !== undefined) env.UNIVERSITY_CARDS_PER_TEAM = val;
  const r = spawnSync(process.execPath, ['-e',
    `const CN = require(${JSON.stringify(REPO + 'server/services/campusNightly.js')});
     const TS = require(${JSON.stringify(REPO + 'server/services/teamScan.js')});
     console.log(JSON.stringify({ perTeam: CN.PER_TEAM, social: TS.SOCIAL_PER_TEAM }));`], { env, encoding: 'utf8', timeout: 30000 });
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch (_) { return { error: r.stderr }; }
};

const d = perTeam();
ok('the default is two cards a team', d.perTeam === 2, d);
ok('  one of them the social seat, so one local', d.social === 1 && d.perTeam - d.social === 1, d);
ok('  Cypress: 17 teams is 34 cards, 17 social and 17 local', 17 * d.perTeam === 34 && 17 * d.social === 17 && 17 * (d.perTeam - d.social) === 17, d);
ok('the setting can raise it to five', perTeam('5').perTeam === 5);
ok('  never past five', perTeam('9').perTeam === 5);
ok('  never under one', perTeam('0').perTeam === 2 && perTeam('-3').perTeam === 1);
ok('  junk is the default', perTeam('lots').perTeam === 2);

console.log(OUT.join('\n'));
console.log(`\n${OUT.length - F}/${OUT.length} passed`);
process.exit(F ? 1 : 0);
