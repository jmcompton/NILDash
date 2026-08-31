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
// The Minnesota hang: one school must never be able to block a 135-school run.
const fs = require('fs');
const path = require('path');
const AI_SRC = fs.readFileSync(REPO + 'server/ai.js', 'utf8');
const JOB_SRC = fs.readFileSync(REPO + 'server/jobs/programMapPilot.js', 'utf8');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}

// Pull the REAL hard cap out of ai.js rather than reimplementing it: a copy
// would pass its own tests while the shipped one stayed broken.
function grab(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('not found: ' + name);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced');
}
// It is withDeadline now. There used to be TWO functions called withTimeout and
// the soft one shadowed the hard one, so the name had to become unambiguous.
const withTimeout = new Function(grab(AI_SRC, 'withDeadline') + '; return withDeadline;')();

const hang = () => new Promise(() => {});          // never settles, like the SDK did
const slow = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

(async () => {
  console.log('-- withDeadline, the hard cap --');
  const t0 = Date.now();
  let err = null;
  try { await withTimeout(hang(), 200, 'a hung call'); } catch (e) { err = e; }
  const took = Date.now() - t0;
  ok('a promise that never settles still rejects', !!err, err);
  ok('it rejects at roughly the cap, not later', took >= 190 && took < 900, took);
  ok('the message names the cap and the operation',
    /timeout after 200ms: a hung call/.test(err.message), err.message);

  ok('a fast promise passes its value through',
    (await withTimeout(slow(10, 'value'), 500, 'x')) === 'value', null);
  ok('an underlying rejection is preserved, not masked as a timeout',
    await withTimeout(Promise.reject(new Error('real failure')), 500, 'x')
      .then(() => 'resolved', (e) => e.message) === 'real failure', null);

  // A leaked timer keeps the event loop alive; in a 135-school run that is 135
  // handles hanging around after the work is done.
  console.log('-- the timer is cleared on success --');
  const before = process._getActiveHandles ? process._getActiveHandles().length : 0;
  await withTimeout(slow(5, 1), 60000, 'long cap');
  await slow(20);
  const after = process._getActiveHandles ? process._getActiveHandles().length : 0;
  ok('no timer left running after an early resolve', after <= before, { before, after });

  console.log('-- discoverStaffUrl is capped and returns instead of hanging --');
  // Stub ai.js: a webSearchJson that never settles, plus the REAL withTimeout.
  const AI_PATH = path.resolve(REPO + 'server/ai.js');
  require.cache[AI_PATH] = {
    id: AI_PATH, filename: AI_PATH, loaded: true,
    exports: { withTimeout, withDeadline: withTimeout, webSearchJson: () => hang(), oneShot: () => hang(), MODEL_FAST: 'x' },
  };
  const pm = require(REPO + 'server/services/programMap.js');
  const store = {
    getProgramSource: async () => null,
    saveProgramSourceUrl: async () => true,
    saveProgramStaffSnapshot: async () => {},
    saveProgramContact: async () => {},
  };

  ok('the cap is 30 seconds as specified', /const DISCOVER_TIMEOUT_MS = 30000/.test(
    fs.readFileSync(REPO + 'server/services/programMap.js', 'utf8')), null);

  // Prove it returns rather than hangs, without waiting the real 30s: race the call
  // against a shorter watchdog. If discoverStaffUrl were uncapped the watchdog wins.
  const t1 = Date.now();
  const raced = await Promise.race([
    pm.discoverStaffUrl('Minnesota', store).then((r) => ({ kind: 'returned', r })),
    slow(35000, { kind: 'still hanging' }),
  ]);
  ok('it RETURNED rather than hanging forever', raced.kind === 'returned', raced);
  ok('it returned null rather than throwing', raced.r && raced.r.staffUrl === null, raced.r);
  ok('it reports that it timed out', raced.r && raced.r.timedOut === true, raced.r);
  ok('it took about the cap, not longer', Date.now() - t1 < 34000, Date.now() - t1);

  console.log('-- the job wraps each school in a backstop --');
  ok('SCHOOL_CAP_MS is defined', /const SCHOOL_CAP_MS = \d+/.test(JOB_SRC), null);
  ok('loadFootballStaff is wrapped in the hard cap',
    /ai\.withDeadline\(\s*\n?\s*programMap\.loadFootballStaff/.test(JOB_SRC), null);
  ok('a timeout is caught and the loop CONTINUES',
    /isTimeout[\s\S]{0,400}?continue;/.test(JOB_SRC), null);
  ok('timed-out schools are collected for the summary', /timedOut\.push\(school\)/.test(JOB_SRC), null);
  ok('and printed at the end', /TIMED OUT \(\$\{timedOut\.length\}\)/.test(JOB_SRC), null);

  console.log('-- the model extraction fallback is capped too --');
  const SP = fs.readFileSync(REPO + 'server/services/staffPage.js', 'utf8');
  ok('MODEL_EXTRACT_TIMEOUT_MS defined', /const MODEL_EXTRACT_TIMEOUT_MS = \d+/.test(SP), null);
  ok('oneShot is wrapped', /ai\.withDeadline\([\s\S]{0,80}MODEL_EXTRACT_TIMEOUT_MS/.test(SP), null);
  ok('it still works when ai has no hard cap (older callers)',
    /ai\.withDeadline\s*\n?\s*\?/.test(SP), null);

  console.log('-- the page fetch cap must cover the BODY, not just the headers --');
  ok('fetchStaffPage uses an AbortController', /new AbortController\(\)/.test(SP), null);
  ok('with a 12s default', /FETCH_TIMEOUT_MS = 12000/.test(SP), null);
  ok('and aborts on the resolved cap', /setTimeout\(\(\) => ctrl\.abort\(\), timeoutMs\)/.test(SP), null);
  ok('callers can request a tighter cap', /async function fetchStaffPage\(url, opts = \{\}\)/.test(SP), null);
  {
    // THE ACTUAL BUG, asserted structurally rather than by name. The first version
    // cleared the timer the moment the headers arrived and then read the body with
    // nothing bounding it, so a server that answered 200 and then trickled forever
    // hung: California, and Minnesota before it. The timer must still be live when
    // the body is read.
    const fn = SP.slice(SP.indexOf('async function fetchStaffPage'), SP.indexOf('function _decode'));
    const bodyRead = Math.min(...['resp.body', 'reader.read()', 'resp.text()']
      .map((k) => { const i = fn.indexOf(k); return i === -1 ? Infinity : i; }));
    const clears = [];
    for (let i = fn.indexOf('clearTimeout(t)'); i !== -1; i = fn.indexOf('clearTimeout(t)', i + 1)) clears.push(i);
    const clearsBeforeBody = clears.filter((i) => i < bodyRead);
    // The only clearTimeout allowed before the body read is the !resp.ok early return,
    // which never reads a body at all.
    const okOnly = clearsBeforeBody.every((i) => {
      const before = fn.slice(Math.max(0, i - 200), i);
      return /if \(!resp\.ok\)/.test(before);
    });
    ok('the abort timer is still live when the body is read', okOnly,
      `${clearsBeforeBody.length} clearTimeout(s) before the body read`);
    ok('the body is STREAMED so the byte cap is a real cap', /getReader\(\)/.test(fn), null);
    ok('and the read stops at MAX_HTML_BYTES rather than buffering everything',
      /bytes >= MAX_HTML_BYTES/.test(fn), null);
  }

  console.log('-- the SWEEP has the same wall-clock backstop the fetch has --');
  const PM = fs.readFileSync(REPO + 'server/services/programMap.js', 'utf8');
  ok('a per-school cap exists', /SWEEP_SCHOOL_CAP_MS = 90000/.test(PM), null);
  ok('a per-candidate cap exists', /SWEEP_CANDIDATE_MS = 12000/.test(PM), null);
  ok('the sweep computes a deadline', /const deadline = Date\.now\(\) \+ capMs;/.test(PM), null);
  ok('and checks it before every candidate', /const left = deadline - Date\.now\(\);/.test(PM), null);
  ok('each candidate fetch is given the smaller of the two budgets',
    /timeoutMs: Math\.min\(SWEEP_CANDIDATE_MS, left\)/.test(PM), null);
  ok('untried candidates are recorded as skipped, not as misses',
    /status: 'skipped'/.test(PM), null);
  ok('the CLI wraps each sweep in an absolute backstop too',
    /ai\.withDeadline\(\s*\n?\s*programMap\.sweepStaffUrl/.test(JOB_SRC), null);

  console.log('-- --resume --');
  ok('the flag exists', /args\.includes\('--resume'\)/.test(JOB_SRC), null);
  ok('it looks at the last 24 hours', /NOW\(\) - INTERVAL '24 hours'/.test(JOB_SRC), null);
  ok('it groups by school and uses MAX(updated_at)',
    /GROUP BY school[\s\S]{0,80}HAVING MAX\(updated_at\)/.test(JOB_SRC), null);
  ok('it prints skipping N and fetching M in the required shape',
    /skipping \$\{skippedFresh\} school\(s\) fetched in the last 24h, fetching \$\{targets\.length\}/.test(JOB_SRC),
    null);
  ok('it stops cleanly when nothing is left', /nothing left to fetch/.test(JOB_SRC), null);

  console.log('-- the coverage summary --');
  // The bar is the SPORT's minKeyRoles now (football 3, basketball 2), not a
  // hardcoded 3. Holding a ten-person basketball staff to football's bar would
  // report a real page as a failure.
  ok('counts schools against the sport bar', /key_contacts >= bar/.test(JOB_SRC), null);
  ok('the bar comes from the sport table', /const bar = programMap\.minKeyRolesFor\(sport\);/.test(JOB_SRC), null);
  ok('counts schools with a key contact that has an email', /key_with_email >= 1/.test(JOB_SRC), null);
  ok('lists schools with zero key contacts', /ZERO KEY CONTACTS/.test(JOB_SRC), null);
  ok('reads from the DB so --resume skips are still counted',
    /FROM program_staff WHERE status = 'current' AND sport = \$1 GROUP BY school/.test(JOB_SRC), null);
  // Coverage must be per sport. A school with a full football staff and no
  // basketball rows has to read as zero coverage on a basketball run.
  ok('coverage is scoped to the sport being run', /GROUP BY school[\s\S]{0,12}, \[sport\]\)/.test(JOB_SRC), null);
  ok('measures against the full known list, not just what was fetched this run',
    /const all = programMap\.ALL_SCHOOLS;/.test(JOB_SRC), null);
  ok('distinguishes no-records from no-role-matched',
    /no records at all[\s\S]{0,80}records exist but no role matched/.test(JOB_SRC), null);

  console.log('');
  console.log('failures: ' + fails);
  process.exit(fails ? 1 : 0);
})();
