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
// The search lane is the code that produced the run-to-run variance, and the
// instruction was: thread sport through, change nothing else. This proves it by
// rendering every football prompt from BOTH versions of programMap.js -- the one at
// HEAD and the one on disk -- and comparing them character for character.
//
// _lead, SYS, JSON_TAIL and CONTACT_TAIL are module-private, so they are extracted
// from source by brace matching and evaluated, the same way the other suites read
// shipped functions rather than reimplementing them.
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '\n       ' + got : ''}`); } else console.log('  PASS ' + n); };

// Render a module's football prompts by requiring it with ai stubbed and reaching
// the private strings through a tiny eval of the module in its own context.
function prompts(modPath) {
  const src = fs.readFileSync(modPath, 'utf8');
  const Module = require('module');
  const m = new Module(modPath, null);
  m.filename = modPath;
  m.paths = Module._nodeModulePaths(require('path').dirname(modPath));
  const aiPath = require.resolve(require('path').dirname(modPath) + '/../ai.js');
  require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
    runSourceWaves: async () => ({ results: [] }), webSearchJson: async () => ({ text: '' }),
    withTimeout: (p) => p, oneShot: async () => '', MODEL_FAST: 'fast' } };
  // Append an export of the private strings, then compile.
  const extra = `
;module.exports.__prompts = (function () {
  const lanes = ['athletics_directory','contacts','collective','press','linkedin','news'];
  const out = { SYS: (typeof SYS === 'string' ? SYS : null),
                JSON_TAIL: (typeof JSON_TAIL === 'string' ? JSON_TAIL : null),
                CONTACT_TAIL: (typeof CONTACT_TAIL === 'string' ? CONTACT_TAIL : null),
                leads: {} };
  for (const l of lanes) out.leads[l] = _lead(l, 'Alabama');
  return out;
})();`;
  m._compile(src + extra, modPath);
  return m.exports.__prompts;
}

const cur = prompts(REPO + 'server/services/programMap.js');
const base = prompts('/tmp/base/server/services/programMap.js');

console.log('-- the football search-lane prompts are unchanged --');
ok('SYS identical', cur.SYS === base.SYS, cur.SYS === base.SYS ? undefined : `now:  ${cur.SYS}\n       was:  ${base.SYS}`);
ok('JSON_TAIL identical', cur.JSON_TAIL === base.JSON_TAIL,
  cur.JSON_TAIL === base.JSON_TAIL ? undefined : firstDiff(base.JSON_TAIL, cur.JSON_TAIL));
ok('CONTACT_TAIL identical', cur.CONTACT_TAIL === base.CONTACT_TAIL,
  cur.CONTACT_TAIL === base.CONTACT_TAIL ? undefined : firstDiff(base.CONTACT_TAIL, cur.CONTACT_TAIL));
for (const lane of Object.keys(base.leads)) {
  ok(`_lead(${lane}) identical`, cur.leads[lane] === base.leads[lane],
    cur.leads[lane] === base.leads[lane] ? undefined : firstDiff(base.leads[lane], cur.leads[lane]));
}

function firstDiff(a, b) {
  a = String(a); b = String(b);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `diverges at char ${i}:\n       was:  ...${a.slice(Math.max(0, i - 30), i + 70)}\n       now:  ...${b.slice(Math.max(0, i - 30), i + 70)}`;
}

console.log('\n-- and the BASKETBALL prompts really are different, not football relabelled --');
const pm = require(REPO + 'server/services/programMap.js');
const src = fs.readFileSync(REPO + 'server/services/programMap.js', 'utf8');
ok('SYS_FOR exists and takes a sport', /function SYS_FOR\(sportArg\)/.test(src));
ok('JSON_TAIL_FOR exists', /function JSON_TAIL_FOR\(sportArg\)/.test(src));
ok('_lead takes a sport', /function _lead\(source, school, sportArg\)/.test(src));
ok('_runSource threads it into the prompt AND the system message',
  /_lead\(source, school, scanSport\)/.test(src) && /SYS_FOR\(scanSport\)/.test(src));
ok('the sport gate compares against the SCANNED sport, not the literal football',
  /sport !== scanSport/.test(src) && !/sport !== 'football'/.test(src));

console.log('\nfailures: ' + f);
process.exit(f ? 1 : 0);
