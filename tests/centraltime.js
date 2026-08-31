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
// Lift the Central-time helpers straight from server/jobs/outreachQueue.js by
// brace-matching, so this tests the ACTUAL shipped code, not a re-transcription.
const fs = require('fs');
const src = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');

function extract(name) {
  const start = src.indexOf('function ' + name);
  if (start < 0) throw new Error('not found: ' + name);
  let depth = 0, i = src.indexOf('{', start);
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const CENTRAL_TZ = 'America/Chicago';
const WINDOW_START_HOUR = 1, WINDOW_END_HOUR = 5;
const code = extract('centralParts') + '\n' + extract('today') + '\n' + extract('nightlyWindowOpen');
eval(code);

let OUT = [], FAIL = 0;
function ok(n, c, got) { if (c) OUT.push('PASS ' + n); else { FAIL++; OUT.push('FAIL ' + n + (got !== undefined ? '  got=' + JSON.stringify(got) : '')); } }

// July (CDT, UTC-5): 2026-07-15 06:30 UTC = 01:30 Central -> window open
const cdtOpen = Date.parse('2026-07-15T06:30:00Z');
ok('CDT 1:30am Central is inside the window', nightlyWindowOpen(cdtOpen) === true);
ok('CDT today() returns the Central calendar date', today(cdtOpen) === '2026-07-15', today(cdtOpen));

// July, just before window (00:59 Central = 05:59 UTC)
ok('CDT 12:59am Central is NOT inside the window', nightlyWindowOpen(Date.parse('2026-07-15T05:59:00Z')) === false);
// July, just after window (05:00 Central = 10:00 UTC)
ok('CDT 5:00am Central is NOT inside the window (end exclusive)', nightlyWindowOpen(Date.parse('2026-07-15T10:00:00Z')) === false);
// July, midday -- definitely not in window
ok('CDT 2pm Central is NOT inside the window', nightlyWindowOpen(Date.parse('2026-07-15T19:00:00Z')) === false);

// January (CST, UTC-6): 2026-01-15 07:30 UTC = 01:30 Central -> window open
const cstOpen = Date.parse('2026-01-15T07:30:00Z');
ok('CST 1:30am Central is inside the window (DST-aware)', nightlyWindowOpen(cstOpen) === true);
ok('CST today() returns the Central calendar date', today(cstOpen) === '2026-01-15', today(cstOpen));

// The UTC-day-vs-Central-day case the fix targets: 11:30pm Central on Jan 15
// (CST) is 05:30 UTC on Jan 16 -- a naive new Date().toISOString().slice(0,10)
// would have said "2026-01-16" even though it is still Jan 15 night in Central.
const lateCentral = Date.parse('2026-01-16T05:30:00Z'); // 11:30pm Jan 15 Central
ok('late-night Central stays on the Central calendar day, not the UTC one',
  today(lateCentral) === '2026-01-15', today(lateCentral));

OUT.push(''); OUT.push('failures: ' + FAIL);
console.log(OUT.join('\n'));
process.exit(FAIL ? 1 : 0);
