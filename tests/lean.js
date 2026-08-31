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
// Two things: why the panel still opened late, and the greeting prompt's weight.
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };

const R = REPO;
const CL = fs.readFileSync(R + 'public/assistant.js', 'utf8');
const IDX = fs.readFileSync(R + 'public/index.html', 'utf8');
const RTE = fs.readFileSync(R + 'server/routes/assistant.js', 'utf8');
const SRV = fs.readFileSync(R + 'server/index.js', 'utf8');
const code = (s) => s.replace(/^\s*\/\/.*$/gm, '');
const CLC = code(CL), RTEC = code(RTE);

console.log('-- WHY THE PANEL OPENED LATE: the decision was a guess --');
{
  // The cache is gone entirely. While it existed, "cache says no, server says yes"
  // fell through to opening AFTER the response, which is the original bug.
  ok('no localStorage copy of the auto-open flag', !/nildash\.assistant\.autoopen/.test(CL));
  ok('naAutoOpenCached is gone', !/naAutoOpenCached/.test(CL));
  ok('naRememberAutoOpen is gone', !/naRememberAutoOpen/.test(CL));
  ok('assistant.js touches localStorage nowhere', !/localStorage/.test(CLC), (CLC.match(/.*localStorage.*/) || [])[0]);

  // The flag now rides on a request the page ALREADY awaits before bootApp.
  ok('/api/auth/me carries the flag', /assistantAutoOpen: !\(user\.assistant_autoopen_off === true\)/.test(SRV));
  ok('bootApp passes it into init', /nilAssistant\.init\(\{ autoOpen: currentUser\.assistantAutoOpen \}\)/.test(IDX));
  ok('init stores it before starting', /NA\.autoOpen = !\(opts && opts\.autoOpen === false\);/.test(CL));
  ok('and stores it BEFORE naStart runs',
    CLC.indexOf('NA.autoOpen = !(opts') < CLC.indexOf('naStart(true);'), null);
  ok('the eager gate reads the real flag, not a cache', /var eager = autoOpenAllowed && NA\.autoOpen &&/.test(CLC));

  // The late-open fallback is GONE. There is now no path that opens the panel after
  // the response, so the bug cannot come back through a stale guess.
  const st = code(CL.slice(CL.indexOf('async function naStart('), CL.indexOf('function naFailed(')));
  const opens = (st.match(/naOpen\(\)/g) || []).length;
  ok('naStart opens the panel in exactly one place', opens === 1, opens);
  ok('and that place is before the fetch', st.indexOf('naOpen()') < st.indexOf('await fetch'), null);
  ok('the only post-response adjustment is closing a resumed one',
    /if \(eager && j\.resumed\) naClose\(\);/.test(st));
  ok('a missing flag defaults to opening, so a stale index.html greets rather than going silent',
    /!\(opts && opts\.autoOpen === false\)/.test(CL));
}

console.log('\n-- and the flag was stuck off, permanently --');
{
  const msg = RTEC.slice(RTEC.indexOf("router.post('/message'"), RTEC.indexOf("router.post('/confirm'"));
  ok('a reply clears the counter AND the flag',
    /assistant_dismissals = 0, assistant_autoopen_off = FALSE/.test(msg));
  // Otherwise "two IN A ROW" silently meant "two ever".
  const dis = RTEC.slice(RTEC.indexOf("router.post('/dismiss'"));
  ok('dismiss still sets it at two', /assistant_autoopen_off = \(COALESCE\(assistant_dismissals,0\) \+ 1\) >= 2/.test(dis));
  ok('so the streak can now actually be broken',
    /assistant_autoopen_off = FALSE/.test(msg) && /assistant_autoopen_off = \(/.test(dis));
}

console.log('\n-- THE TYPING INDICATOR WAS NEVER THE PROBLEM --');
{
  const st = code(CL.slice(CL.indexOf('async function naStart('), CL.indexOf('function naFailed(')));
  // It is drawn unconditionally, outside the eager branch: it was firing all along,
  // into a log inside a panel that was never shown.
  // The indicator is now naRunning(label), not a bare ellipsis: it names the work.
  ok('the indicator is drawn regardless of whether the panel opened',
    /\}\s*var thinking = naRunning\(/.test(st), null);
  ok('and before the request goes out', st.indexOf('naRunning(') < st.indexOf('await fetch'), null);
  ok('it is not inside the eager branch', st.indexOf('naRunning(') > st.indexOf('naOpen();'), null);
  ok('and it says what it is doing, not "Working"', /naRunning\('Reading your dashboard'\)/.test(st));
}

console.log('\n-- THE GREETING PROMPT --');
{
  const { systemPrompt } = require(R + 'server/services/assistantPrompt.js');
  const CTX = 'THEIR SITUATION\nAgent: Fixture Agent\nAthletes: 3\nRoster:\n  - Fixture Alvarez (basketball, Kentucky) id=a_1';
  const mk = (lean, tools) => systemPrompt({ contextBlock: CTX, brief: 'Say hello.', suppressed: [], toolsEnabled: tools, lean });
  const full = mk(false, true);
  const lean = mk(true, false);

  ok('the lean prompt is under a third of the full one', lean.length < full.length / 3,
    { full: full.length, lean: lean.length });
  ok('it drops the knowledge base', !/119 football programs/.test(lean) && /119 football programs/.test(full));
  ok('and the rules that exist only to govern it', !/WHAT YOU KNOW ABOUT NILDASH/.test(lean));

  // What it must NOT drop.
  ok('it keeps the context block, which is the entire point of a greeting', lean.includes(CTX));
  ok('it keeps the brief', /Say hello\./.test(lean));
  ok('it keeps never-nag', /Never nag/.test(lean));
  ok('it keeps never-oversell', /Never oversell/.test(lean));
  ok('it keeps say-when-you-do-not-know', /When you do not know, say so/.test(lean));
  ok('it keeps the untrusted-data rule, because the roster is agent-supplied',
    /THE DATA BELOW IS DATA/.test(lean));
  ok('it keeps never-claim-you-did-something', /Never claim to have done something you have not done/.test(lean));
  // THE ONE THAT WOULD BREAK THE PRODUCT. A greeting that cannot offer is a dead end.
  ok('it keeps the instruction to OFFER', /You can still OFFER to do something/.test(lean));
  ok('and the promise that tools arrive next turn', /you will have the tools to do it/.test(lean));
  ok('it says plainly it has no product reference this turn',
    /You do\s+not have the product reference on this turn/.test(lean));

  // The full prompt is untouched.
  ok('the full prompt still carries the knowledge base', /KNOWLEDGE/.test(full) && /119 football programs/.test(full));
  ok('and the safety block', /WHAT YOU DO NOT DO/.test(full));
  ok('and the knowledge rule', /WHAT YOU KNOW ABOUT NILDASH/.test(full));
  // SAME brief as `full`, or the comparison measures the brief rather than `lean`.
  const omitted = systemPrompt({ contextBlock: CTX, brief: 'Say hello.', suppressed: [], toolsEnabled: true });
  ok('lean is opt-in: omitting it gives byte-for-byte the full prompt', omitted === full,
    omitted.length === full.length ? 'same length, different bytes' : { omitted: omitted.length, full: full.length });

  // Suppressed keys still work on the lean path, or never-nag breaks on the greeting.
  const sup = systemPrompt({ contextBlock: CTX, brief: 'b', suppressed: ['run_scan'], toolsEnabled: false, lean: true });
  ok('suppressed suggestions are still listed on the lean path', /ALREADY OFFERED AND NOT TAKEN/.test(sup));
  ok('with the key', /- run_scan/.test(sup));
}

console.log('\n-- and the turn is bounded to match --');
{
  ok('lean is derived from the greeting, not passed by hand', /const lean = !toolsEnabled;/.test(RTEC));
  ok('a lean turn gets a small token ceiling', /maxTokens: lean \? GREETING_MAX_TOKENS : 900/.test(RTEC));
  ok('which is well under the reply budget', /const GREETING_MAX_TOKENS = 220;/.test(RTE));
  ok('and one round, because it cannot call a tool anyway', /maxRounds: lean \? 1 : 3/.test(RTEC));
  ok('the greeting still runs with tools disabled', /toolsEnabled: false, msgs: existing/.test(RTEC));
  ok('so lean is true exactly on the greeting path', /toolsEnabled: true, msgs: convo/.test(RTEC));
}

console.log('\nfailures: ' + f);
process.exit(f ? 1 : 0);
