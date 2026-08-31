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
// Three defects that between them produced an empty assistant panel. Each is tested
// by the mechanism that failed, not by "does it look right now".
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };

const AI = fs.readFileSync(REPO + 'server/ai.js', 'utf8');
const CTX = fs.readFileSync(REPO + 'server/services/assistantContext.js', 'utf8');
const STORE = fs.readFileSync(REPO + 'server/store.js', 'utf8');
const CL = fs.readFileSync(REPO + 'public/assistant.js', 'utf8');
const IDX = fs.readFileSync(REPO + 'public/index.html', 'utf8');

console.log('-- DEFECT 1: athletes has no name/sport/school COLUMNS --');
{
  // The whole athletes table, from the CREATE plus every ADD COLUMN.
  const create = STORE.slice(STORE.indexOf('CREATE TABLE IF NOT EXISTS athletes ('));
  const cols = new Set(create.slice(0, create.indexOf(');')).split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
  for (const m of STORE.matchAll(/ALTER TABLE athletes ADD COLUMN IF NOT EXISTS (\w+)/g)) cols.add(m[1]);
  ok('name is NOT a column', !cols.has('name'), [...cols].slice(0, 6));
  ok('sport is NOT a column', !cols.has('sport'));
  ok('school is NOT a column', !cols.has('school'));
  ok('data IS the column they live in', cols.has('data'));

  // Every athletes SELECT in the assistant must read through data->> or select only
  // real columns. This is the check that would have caught it.
  // Comments stripped and the window bounded: the first version matched across the
  // whole multi-line query and picked up the COMMENT that explains this very rule.
  const CTX_CODE = CTX.replace(/^\s*\/\/.*$/gm, '');
  const selects = [...CTX_CODE.matchAll(/SELECT([^;]{0,400}?)FROM athletes/g)].map((m) => m[1]);
  ok('the assistant issues at least one athletes SELECT', selects.length > 0, selects.length);
  for (const sel of selects) {
    const bare = sel.replace(/data->>'[a-z_]+'\s*AS\s*\w+/g, '')
      .split(',').map((x) => x.trim()).filter(Boolean)
      .filter((x) => /^(name|sport|school)\b/.test(x));
    ok('no bare name/sport/school in: ' + sel.replace(/\s+/g, ' ').trim().slice(0, 46), bare.length === 0, bare);
  }
  ok('the roster query reads data->>\'name\'', /data->>'name'\s+AS name/.test(CTX));
  ok('and data->>\'sport\'', /data->>'sport'\s+AS sport/.test(CTX));
  ok('and data->>\'school\'', /data->>'school'\s+AS school/.test(CTX));
}

console.log('\n-- DEFECT 2: two functions called withTimeout, the last one winning --');
{
  const decls = (AI.match(/^function withTimeout\(/gm) || []).length;
  ok('exactly ONE withTimeout declaration now', decls === 1, decls);
  ok('and the hard cap has its own name', /^function withDeadline\(/m.test(AI));
  ok('both are exported', /withTimeout,/.test(AI) && /withDeadline,/.test(AI));

  // The semantics, demonstrated rather than asserted about.
  const lift = (name) => {
    const start = AI.indexOf('function ' + name + '(');
    let d = 0, i = AI.indexOf('{', start);
    for (; i < AI.length; i++) { if (AI[i] === '{') d++; else if (AI[i] === '}') { d--; if (!d) break; } }
    return AI.slice(start, i + 1);
  };
  const mod = new Function(lift('withDeadline') + '\n' + lift('withTimeout')
    + '\n return { withDeadline, withTimeout };')();

  return (async () => {
    const boom = () => Promise.reject(new Error('api exploded'));
    const soft = await mod.withTimeout(boom(), 50, 'a label');
    ok('SOFT: an error resolves to the third argument', soft === 'a label', soft);
    let hard = null;
    try { await mod.withDeadline(boom(), 50, 'a label'); } catch (e) { hard = e.message; }
    ok('HARD: an error propagates instead', hard === 'api exploded', hard);
    let slow = null;
    try { await mod.withDeadline(new Promise(() => {}), 40, 'the thing'); } catch (e) { slow = e.message; }
    ok('HARD: a stall rejects with the label in the message', /timeout after 40ms: the thing/.test(slow || ''), slow);
    const slowSoft = await mod.withTimeout(new Promise(() => {}), 40, 'fallback');
    ok('SOFT: a stall resolves to the fallback', slowSoft === 'fallback', slowSoft);

    console.log('\n-- and every caller passing a LABEL now uses the hard one --');
    const callers = ['server/jobs/programMapPilot.js', 'server/services/staffPage.js',
      'server/services/draftPrewarm.js', 'server/services/programMap.js'];
    for (const p of callers) {
      const src = fs.readFileSync(REPO + p, 'utf8');
      ok(p.split('/').pop() + ' uses withDeadline', /ai\.withDeadline\(/.test(src));
      ok('  and no longer calls ai.withTimeout with a label',
        !/ai\.withTimeout\(/.test(src), (src.match(/.{0,40}ai\.withTimeout\(.{0,40}/) || [])[0]);
    }
    ok('toolLoop uses the hard cap, so an API error is not turned into a string',
      /const msg = await withDeadline\(/.test(AI));
    // The two genuine fallback callers must NOT have moved.
    ok('the two real fallback callers still use the soft one',
      (AI.match(/await withTimeout\(oneShotWebSearch/g) || []).length === 2,
      (AI.match(/await withTimeout\(oneShotWebSearch/g) || []).length);

    console.log('\n-- DEFECT 3: a failed greeting was silent and permanent --');
    ok('greeted is no longer set before the request', !/if \(NA\.greeted\) return;\s*\n\s*NA\.greeted = true;/.test(CL));
    ok('it is set only after a successful parse',
      CL.indexOf('var j = await r.json();') < CL.indexOf('NA.greeted = true;'), null);
    ok('a non-OK response is SHOWN, not swallowed', /naFailed\(\(e1 && e1\.error\)/.test(CL));
    ok('a thrown fetch is shown too', /catch \(e\) \{[\s\S]{0,120}naFailed\('Could not reach/.test(CL));
    ok('an EMPTY but successful greeting is shown as a bug, not as a blank panel',
      /had nothing to say. That is a bug worth reporting/.test(CL));
    ok('the failure offers a retry', /class="na-btn na-ghost na-retry"/.test(CL));
    ok('and retry actually re-requests, because greeted is still false',
      /naStart\(false\);\s*\n\s*\}\);/.test(CL));
    ok('an in-flight guard stops two greetings racing', /NA\.greeting/.test(CL));
    // Read the 401 BLOCK by brace matching rather than by a fixed character window.
    // The window was 220 chars and the block outgrew it the moment the eager-open
    // undo was added, so the test failed on a behaviour that had not changed.
    {
      const at = CL.indexOf('if (r.status === 401) {');
      let d = 0, i = CL.indexOf('{', at);
      for (; i < CL.length; i++) { if (CL[i] === '{') d++; else if (CL[i] === '}') { d--; if (!d) break; } }
      const blk = CL.slice(at, i + 1).replace(/^\s*\/\/.*$/gm, '');
      ok('401 returns without saying anything', /return;/.test(blk) && !/naSay\(|naFailed\(/.test(blk));
      ok('and never marks the greeting as done, so it stays retryable',
        !/NA\.greeted = true/.test(blk));
    }

    console.log('\n-- the bubble no longer mounts on the logged-out page --');
    ok('assistant.js does not self-mount', !/DOMContentLoaded', naInit/.test(CL));
    ok('index.html mounts it from bootApp', /window\.nilAssistant\.init\(\{ autoOpen:/.test(IDX));
    ok('and bootApp only runs after auth', /if \(r\.ok\) \{ currentUser = await r\.json\(\); bootApp\(\); return; \}/.test(IDX));
    ok('the mount is inside bootApp, not beside it',
      IDX.indexOf('async function bootApp') < IDX.indexOf('window.nilAssistant.init('), null);

    // LAYOUT IS NOW A DOCKED SIDEBAR, and its geometry is asserted in a real browser
    // by uitest.html, which can measure it. These are the source-level invariants only.
    console.log('\n-- LAYOUT: the tab is the only control --');
    ok('the floating bubble is gone', !/na-bubble/.test(CL));
    ok('the tab replaced it', /id="na-tab"/.test(CL));
    ok('there is no X close control anywhere', !/&times;|aria-label="Close the assistant"/.test(CL)
      || /aria-label', open \? 'Close the NILDash assistant'/.test(CL));
    ok('open and close are one class on body', /document\.body\.classList\.add\('na-open'\)/.test(CL)
      && /document\.body\.classList\.remove\('na-open'\)/.test(CL));
    ok('the panel is docked full height, not a floating box', /height:100vh/.test(CL));
    ok('and 380 wide', /var NA_W = 380;/.test(CL));
    ok('the header identifies it by name', /NILDash assistant<\/div>/.test(CL));
    ok('and says what it is for', /Ask about the product, or tell me what to do/.test(CL));

    console.log('\nfailures: ' + f);
    process.exit(f ? 1 : 0);
  })();
}
