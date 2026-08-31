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
// The blank page, the duplicate sentence, the dead lane argument, the late panel,
// and the serial queries. Each tested by the mechanism that failed.
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };

const R = REPO;
const IDX = fs.readFileSync(R + 'public/index.html', 'utf8');
const CL = fs.readFileSync(R + 'public/assistant.js', 'utf8');
const ACT = fs.readFileSync(R + 'server/services/assistantActions.js', 'utf8');
const RTE = fs.readFileSync(R + 'server/routes/assistant.js', 'utf8');
const CTX = fs.readFileSync(R + 'server/services/assistantContext.js', 'utf8');
// Comments stripped before asserting on CODE. Every one of these files now carries a
// comment quoting the old broken string, and a naive search finds the comment.
const code = (s) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const IDXC = code(IDX), CLC = code(CL), ACTC = code(ACT), RTEC = code(RTE);

console.log('-- 1. THE BLANK PAGE: showView was given an id that does not exist --');
{
  // The ground truth, read from the document rather than assumed.
  const ids = new Set([...IDX.matchAll(/id="view-([a-z-]+)"/g)].map((m) => m[1]));
  ok('view-deals exists', ids.has('deals'));
  ok('view-deal-scan does NOT exist, which is the whole bug', !ids.has('deal-scan'));

  // EVERY showView call in both files must name a real view.
  const calls = [...IDXC.matchAll(/showView\('([a-z-]+)'/g), ...CLC.matchAll(/showView\('([a-z-]+)'/g)]
    .map((m) => m[1]);
  ok('there are showView calls to check', calls.length > 5, calls.length);
  const bad = [...new Set(calls)].filter((c) => !ids.has(c));
  ok('every showView target resolves to a real view', bad.length === 0, bad);

  // And specifically: no live code still says deal-scan.
  ok('no deal-scan target left in index.html', !/showView\('deal-scan'/.test(IDXC));
  ok('no deal-scan target left in assistant.js', !/showView\('deal-scan'/.test(CLC));

  // THE DYNAMIC CASE. open_tab reaches showView(d.tab) with a value from the model,
  // so no literal-string check can cover it -- and its enum shipped 'dashboard',
  // 'athletes' and 'deal-scan', none of which are views. Every one of them blanked
  // the page exactly like the scan hook did.
  const enums = [...ACT.matchAll(/enum: \[([^\]]+)\]/g)].map((m) => m[1]);
  const tabEnum = enums.find((e) => /'programs'/.test(e) && /'settings'/.test(e));
  ok('open_tab declares an enum of tabs', !!tabEnum, enums.length);
  const tabs = (tabEnum || '').match(/'([a-z-]+)'/g).map((x) => x.replace(/'/g, ''));
  const badTabs = tabs.filter((t) => !ids.has(t));
  ok('every tab the model can name is a real view', badTabs.length === 0, badTabs);
  ok('and the runtime check allows exactly the same set',
    tabs.every((t) => new RegExp("'" + t + "'").test(ACTC.slice(ACTC.indexOf('const allowed ='), ACTC.indexOf('const allowed =') + 200))),
    tabs);
  ok('each one has a spoken name, so it does not say "Opening deals"',
    tabs.every((t) => new RegExp("'?" + t + "'?:").test(ACT.slice(ACT.indexOf('const TAB_LABELS'), ACT.indexOf('const TAB_LABELS') + 400))), tabs);

  // showView deactivates before it looks up, so a bad id is not a no-op: it blanks
  // the page AND throws. Demonstrated against the shipped function body.
  const sv = IDX.slice(IDX.indexOf('async function showView(id, btn)'));
  const body = sv.slice(0, sv.indexOf('\n}'));
  ok('it removes active from every view first',
    body.indexOf(".forEach(v => v.classList.remove('active'))") < body.indexOf("getElementById('view-' + id)"), null);
  ok('and dereferences the lookup with no null guard, so a bad id throws',
    /getElementById\('view-' \+ id\)\.classList\.add/.test(body));
}

console.log('\n-- the assistant hook awaits showView instead of dropping the rejection --');
{
  const hook = IDX.slice(IDX.indexOf('window.nilRunDealScanFor'), IDX.indexOf('function runDealRefresh'));
  ok('showView is awaited', /await showView\('deals', null\)/.test(hook));
  ok('inside a catch, so a render failure cannot stop the scan', /catch \(e\) \{ console\.error/.test(hook));
  ok('and _dsRunScan still runs after it', hook.indexOf('await showView') < hook.indexOf('_dsRunScan(false)'), null);
}

console.log('\n-- 2. ONE SENTENCE, NOT TWO --');
{
  ok('the client no longer narrates the scan', !/naSay\('assistant', 'Running it now\.'\)/.test(CLC));
  const blk = CLC.slice(CLC.indexOf("d.kind === 'run_deal_scan'"), CLC.indexOf("d.kind === 'lookup_program'"));
  const says = (blk.match(/naSay\(/g) || []).length;
  ok('exactly one naSay left in that branch, the no-hook fallback', says === 1, says);
  ok('and it is the fallback, not the success path',
    /nilRunDealScanFor\(d\.athleteId\);\s*\} else \{/.test(blk.replace(/\s+/g, ' ')) || /else \{[\s\S]*naSay/.test(blk));
  // The server still tells the MODEL, which is the one voice that should speak.
  ok('the server keeps say(), so the model still knows it happened',
    /say: \(\) => 'Running the scan now/.test(ACT));
  ok('and it reaches the model as a tool-result note', /note: res\.say \|\| 'done'/.test(RTEC));
}

console.log('\n-- 3. LANE IS GONE, because nothing read it --');
{
  const scan = ACTC.slice(ACTC.indexOf('run_deal_scan: {'), ACTC.indexOf('open_tab: {'));
  ok('no lane property in the tool schema', !/lane:/.test(scan), (scan.match(/.*lane.*/) || [])[0]);
  ok('check() no longer computes a lane', !/lane/.test(scan));
  ok('the directive carries only the athlete', /directive: \(args\) => \(\{ kind: 'run_deal_scan', athleteId: args\.athleteId \}\)/.test(ACT));
  ok('the client hook takes one argument', /window\.nilRunDealScanFor = async function \(athleteId\)/.test(IDX));
  ok('and calls it with one', /nilRunDealScanFor\(d\.athleteId\)/.test(CLC) && !/nilRunDealScanFor\(d\.athleteId, d\.lane\)/.test(CLC));
  ok('no d.lane left anywhere in the client', !/d\.lane/.test(CLC));
  // The reason it was dead: _dsRunScan reads opts.deepen and nothing else.
  const ds = IDX.slice(IDX.indexOf('async function _dsRunScan(isRefresh, opts)'));
  const dsBody = ds.slice(0, ds.indexOf('\nfunction runDealScan'));
  ok('_dsRunScan reads opts.deepen', /opts && opts\.deepen/.test(dsBody));
  ok('and never reads opts.lane, which is why passing one did nothing',
    !/opts\.lane/.test(dsBody), (dsBody.match(/.*opts\.lane.*/) || [])[0]);
  ok('a plain scan runs every lane', /var lanes = isDeepen \? \['local'\] : DS_LANES/.test(dsBody));
}

console.log('\n-- 4. THE PANEL OPENS BEFORE THE GREETING, NOT AFTER --');
{
  const st = CL.slice(CL.indexOf('async function naStart('), CL.indexOf('function naFailed('));
  const stc = code(st);
  ok('naOpen is called before the fetch', stc.indexOf('naOpen();') < stc.indexOf('await fetch'), null);
  ok('a typing indicator is drawn before the fetch',
    stc.indexOf('naRunning(') < stc.indexOf('await fetch') && stc.indexOf('naRunning(') !== -1, null);
  ok('the indicator is removed when the greeting lands',
    /if \(log\) log\.innerHTML = '';/.test(stc) || /thinking\.remove\(\)/.test(stc));
  // Was a cached guess; now the server's real answer, read from /api/auth/me before
  // the greeting request. lean.js owns the detail.
  ok('the eager open is gated on the real server decision', /var eager = autoOpenAllowed && NA\.autoOpen &&/.test(stc));
  ok('and on the once-per-browser-session flag', /!sessionStorage\.getItem\(NA_SESSION_KEY\)/.test(stc));
  ok('a resumed conversation is closed again', /if \(eager && j\.resumed\) naClose\(\)/.test(stc));
  ok('with naClose, NOT naDismiss: the agent did not close it',
    !/naDismiss\(\)/.test(stc));
  ok('nothing is cached, so nothing can go stale', !/localStorage/.test(stc));
  ok('401 undoes the optimistic open completely', /sessionStorage\.removeItem\(NA_SESSION_KEY\)/.test(stc));
  ok('401 also drops the indicator', /if \(thinking\) thinking\.remove\(\);/.test(stc));
  ok('greeted is STILL only set after a successful parse',
    stc.indexOf('var j = await r.json();') < stc.indexOf('NA.greeted = true;'), null);

  // The localStorage cache this block exercised is DELETED. The flag now rides on
  // /api/auth/me, so there is no cached copy to go stale and no helper to test.
  // lean.js covers the replacement end to end.
}

console.log('\n-- 5. THE QUERIES RUN AT ONCE, AND THE SPLIT IS LOGGED --');
{
  const sess = RTEC.slice(RTEC.indexOf("router.post('/session'"), RTEC.indexOf("router.post('/message'"));
  ok('/session awaits its three reads together', /const \[session, ctx, u\] = await Promise\.all\(\[/.test(sess));
  ok('loadSession is inside the group', /Promise\.all\(\[[\s\S]{0,400}loadSession\(agentId/.test(sess));
  ok('readContext is inside the group', /Promise\.all\(\[[\s\S]{0,400}ctxSvc\.readContext\(agentId, principal\)/.test(sess));
  ok('the dismissals read is inside the group', /Promise\.all\(\[[\s\S]{0,600}assistant_autoopen_off/.test(sess));
  // The one that legitimately cannot be parallel.
  ok('history stays after, because it needs the session id',
    sess.indexOf('Promise.all') < sess.indexOf('await history(session.id)'), null);

  ok('history is read ONCE per request now', (sess.match(/await history\(/g) || []).length === 1,
    (sess.match(/await history\(/g) || []).length);
  ok('and handed to runTurn instead of re-queried', /msgs: existing/.test(sess));
  // The contract tightened after this suite was written: runTurn no longer takes a
  // userText, and no longer falls back to reading history itself. msgs IS the
  // conversation, and both routes read it. turns.js owns the detail.
  ok('runTurn takes the conversation and nothing else',
    /async function runTurn\(\{ agentId, principal, session, ctx, state, toolsEnabled, msgs \}\)/.test(RTE));
  ok('and copies rather than mutating the caller\'s array',
    /const convo = \(msgs \|\| \[\]\)\.slice\(\)/.test(RTEC));
  ok('runTurn never reads history itself, so there is one source of truth',
    !/await history\(/.test(RTEC.slice(RTEC.indexOf('async function runTurn'), RTEC.indexOf("router.post('/session'"))));

  ok('the timing line names db, ctx, history, model and total',
    /TIMING \/session[\s\S]{0,200}db=\$\{tDb\}ms[\s\S]{0,60}ctx=\$\{ctx\._ms\}ms[\s\S]{0,120}history=\$\{tHist\}ms[\s\S]{0,60}model=\$\{tModel\}ms/.test(RTE));
  ok('model time is measured around runTurn only',
    RTEC.indexOf('const tM = Date.now();') < RTEC.indexOf('const turn = await runTurn'), null);

  const msg = RTEC.slice(RTEC.indexOf("router.post('/message'"), RTEC.indexOf("router.post('/confirm'"));
  ok('/message parallelises the same way', /const \[session, ctx\] = await Promise\.all\(\[/.test(msg));
  ok('/message logs its split too', /TIMING \/message/.test(RTE));
  ok('the user message is still recorded BEFORE the turn reads it back',
    msg.indexOf("await record(session.id, agentId, 'user', text)") < msg.indexOf('await runTurn'), null);

  ok('readContext runs its two queries together', /const \[q, rr\] = await Promise\.all\(\[/.test(CTX));
  ok('and reports its own duration', /_ms: Date\.now\(\) - t0/.test(CTX));
  ok('the roster read STILL goes through data->>, the empty-greeting fix',
    /data->>'name'\s+AS name/.test(CTX) && /data->>'school'\s+AS school/.test(CTX));
  // _ms must not reach the model or the browser.
  ok('the response picks four named keys, so _ms cannot leak',
    /context: \{ athletes: ctx\.athletes, scans: ctx\.scans, sent: ctx\.sent, gmailConnected: ctx\.gmailConnected \}/.test(RTE));
  ok('and contextBlock names its fields rather than dumping ctx',
    !/JSON\.stringify\(ctx\)/.test(CTX));
}

console.log('\nfailures: ' + f);
process.exit(f ? 1 : 0);
