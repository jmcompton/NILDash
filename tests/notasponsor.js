'use strict';
// Runs without a database for the detector; the gates are read from source.
//
//   node tests/run.js             every suite, against the committed baseline
//   node tests/notasponsor.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

// ── ONLY A BUSINESS THAT COULD BUY AN ENDORSEMENT IS A PROSPECT ──────────────
// "On3 NIL Valuation" was queued as a DM to On3's founder. Media, valuation
// sites, recruiting services, NIL platforms and athletic programs are blocked
// everywhere a collective is (services/notASponsor).
const fs = require('fs');
const { execFileSync } = require('child_process');
const N = require(REPO + 'server/services/notASponsor.js');
const C = require(REPO + 'server/services/compliance.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 500) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');
const key = (n, e) => { const r = N.detect(n, e || {}); return r ? r.key : null; };

function main() {
  OUT.push('-- what the national lane served, blocked --');
  const junk = ['On3 NIL Valuation', 'College Football 2026 Cover Star', 'Texas A&M Aggies', 'Oregon Ducks', 'Alabama Crimson Tide',
    '247Sports', 'Rivals', 'Opendorse', 'INFLCR', 'University of Alabama Athletics', 'LSU Athletic Department', 'Fox 5 News',
    'ESPN', 'NCAA', 'Big Ten Network', 'Prep Baseball Report'];
  const missed = junk.filter((n) => key(n) !== 'not-a-sponsor');
  ok(`every one of these is not a sponsor (${junk.length})`, missed.length === 0, missed.map((n) => [n, N.detect(n, {})]));
  ok('collectives are still collectives', key('Penn State Collective') === 'collective' && key('Miami Collective') === 'collective' && key('Yea Alabama') === 'collective');

  OUT.push('', '-- and real sponsors are not --');
  const real = [['Nike'], ['Raising Canes'], ['Chick-fil-A'], ['Liquid I.V.'], ['Buffalo Wild Wings'], ['Gatorade'], ['Celsius'],
    ['Barstool Sports'], ['EA Sports'], ['Panini America'], ['Fanatics'], ['State Farm'], ['Red Bull'], ['Duck Donuts'],
    ['Tigers Den Pizza', { category: 'restaurant' }], ['Good News Cafe'], ['Hawks Barbershop'], ['Crimson Tide Car Wash', { category: 'auto' }],
    ['ESPN Zone Grill', { category: 'restaurant' }], ['Press Coffee'], ['Times Square Pizza'], ['Sullivans Irish Pub'],
    ['College Hunks Hauling Junk'], ['Network Solutions'], ['Mean Green Lawn Care'], ['Lions Club']];
  const wrong = real.filter(([n, e]) => key(n, e));
  ok(`none of these is blocked (${real.length})`, wrong.length === 0, wrong.map(([n, e]) => [n, N.detect(n, e || {})]));
  ok('a media word on a known consumer business is kept', key('Local News Network') === 'not-a-sponsor' && key('Good News Cafe', { category: 'cafe' }) === null);

  OUT.push('', '-- every gate enforces it --');
  const cls = C.classifyBusiness('On3 NIL Valuation', {});
  ok('compliance reports it in its own category, blocked at every age', cls.hits[0] && cls.hits[0].key === 'not-a-sponsor'
    && C.CATEGORY_BY_KEY['not-a-sponsor'].minor === 'block' && C.CATEGORY_BY_KEY['not-a-sponsor'].adult === 'block', cls.hits);
  const Q = require(REPO + 'server/services/outreachQueue.js');
  ok('the nightly card gate refuses it for an adult athlete', (Q.restrictedFor('On3 NIL Valuation', null, { over18: true }) || {}).key === 'not-a-sponsor');
  ok('  and a team', (Q.restrictedFor('Oregon Ducks', null, { over18: true }) || {}).key === 'not-a-sponsor');
  ok('the team scan blocks it', require(REPO + 'server/services/teamScan.js').BLOCKED_KEYS.includes('not-a-sponsor'));
  ok('the national lane filters with it', /require\('\.\/notASponsor'\)[\s\S]{0,80}rows = rows\.filter/.test(read('server/services/scout.js')));
  ok('the Places build, Deal Scan and the market pool writer drop it', /require\('\.\/notASponsor'\)\.detect\(r\.name/.test(read('server/services/placesMarket.js'))
    && /require\('\.\/services\/notASponsor'\)\.detect\(nm/.test(read('server/ai.js'))
    && /const COL = require\('\.\/services\/notASponsor'\)/.test(read('server/store.js')));
  ok('block-audit reports it and purges its pool rows with --apply', /'not-a-sponsor'/.test(read('scripts/block-audit.js'))
    && /NOT A SPONSOR \(media, valuation/.test(read('scripts/block-audit.js')));
  const tracked = execFileSync('git', ['ls-files', 'server/data/notSponsors.json'], { cwd: REPO, encoding: 'utf8' }).trim();
  ok('the named list is tracked by git, so production has it', tracked === 'server/data/notSponsors.json', tracked);
  ok('  and it loads', N.knownNames().includes('on3') && N.knownNames().includes('opendorse'));
}

try { main(); } catch (e) { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }
const pass = OUT.filter((l) => l.startsWith('PASS')).length;
console.log(OUT.join('\n'));
console.log(`\n${pass} passed\nfailures: ${F}`);
process.exit(F ? 1 : 0);
