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
// The model saw every agent message twice, and a conversation past MAX_HISTORY would
// have 400ed. Both are properties of the messages array runTurn hands to the API, so
// the SHIPPED runTurn is lifted and its dependencies injected, and the assertions are
// made against the array it actually built. No reimplementation.
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };

const R = REPO;
const RTE = fs.readFileSync(R + 'server/routes/assistant.js', 'utf8');

// Match the PARAMETER LIST first. runTurn's parameters are a destructuring pattern,
// so "the first { after the name" is the argument object, and brace-matching from
// there returns the signature and nothing else.
function lift(name) {
  const start = RTE.indexOf('async function ' + name + '(');
  let p = 0, i = RTE.indexOf('(', start);
  for (; i < RTE.length; i++) { if (RTE[i] === '(') p++; else if (RTE[i] === ')') { p--; if (!p) break; } }
  let d = 0, j = RTE.indexOf('{', i);
  for (; j < RTE.length; j++) { if (RTE[j] === '{') d++; else if (RTE[j] === '}') { d--; if (!d) break; } }
  return RTE.slice(start, j + 1);
}
const SRC = lift('runTurn');
if (!/async function runTurn/.test(SRC) || !/ai\.toolLoop/.test(SRC)) {
  console.log('FIXTURE BROKEN: did not lift runTurn. Aborting.'); process.exit(1);
}

// Read from source, not retyped: the test asserts on the string the app really sends.
const OPENER = (RTE.match(/^const OPENER = '([^']+)';$/m) || [])[1];
if (!OPENER || !/just opened NILDash/.test(OPENER)) {
  console.log('FIXTURE BROKEN: could not read OPENER from source. Aborting.'); process.exit(1);
}

// Every free identifier in runTurn, injected. A miss shows up as a ReferenceError
// rather than a silently-wrong result.
function build(capture) {
  const ctxSvc = {
    STATE_BRIEFS: { returning: { brief: 'b', suggestionKey: null } },
    contextBlock: () => 'CTX',
  };
  const ai = { toolLoop: async (arg) => { capture.arg = arg; return { text: 'reply', exhausted: false }; } };
  const actions = { toolDefs: () => [{ name: 't' }], resolveCall: async () => ({ ok: true, directive: {} }) };
  return new Function('ctxSvc', 'systemPrompt', 'ai', 'actions', 'history', 'MODEL', 'TURN_TIMEOUT_MS', 'OPENER',
    SRC + '\n return runTurn;')(
    ctxSvc, () => 'SYS', ai, actions,
    async () => { throw new Error('history() must NOT be called: the caller passes msgs'); },
    'm', 1000, OPENER);
}
const run = async (msgs) => {
  const cap = {};
  const fn = build(cap);
  await fn({ agentId: 'a1', session: {}, ctx: {}, state: 'returning', toolsEnabled: true, msgs });
  return cap.arg.messages;
};

(async () => {
  console.log('-- EACH TURN ONCE --');
  {
    // What /message produces now: record() wrote the user text, history() read it back.
    const transcript = [
      { role: 'assistant', content: 'greeting' },
      { role: 'user', content: 'run a scan for Fixture Alvarez' },
    ];
    const sent = await run(transcript);
    const typed = sent.filter((m) => m.role === 'user' && !/just opened NILDash/.test(m.content));
    ok('the agent message appears exactly once', typed.length === 1, typed);
    ok('and it is the one they typed', typed[0].content === 'run a scan for Fixture Alvarez', typed[0]);
    ok('the transcript grows by the replayed opener only, so 3 not 4', sent.length === 3, sent);
    ok('no message is a duplicate of its predecessor',
      sent.every((m, i) => i === 0 || !(sent[i - 1].role === m.role && sent[i - 1].content === m.content)), sent);
    // THE POINT OF PREPENDING. An agent replying "yes" to an offer is meaningless if
    // the offer is not in the conversation.
    ok('the greeting the agent is answering is still there',
      sent.some((m) => m.role === 'assistant' && m.content === 'greeting'), sent);
  }
  {
    // THE REGRESSION ITSELF. The old signature pushed userText on top of a transcript
    // that already contained it. Proven by feeding the old shape and showing the
    // current function has no way to produce it.
    ok('runTurn no longer accepts a userText argument', !/userText/.test(SRC), (SRC.match(/.*userText.*/) || [])[0]);
    ok('and nothing pushes a user message onto the transcript',
      !/\.push\(\{ role: 'user', content: userText/.test(RTE));
    // `await runTurn(`, not `runTurn(`: the latter also matches the DECLARATION, and
    // [^}]* stops at the first newline-free run so a multi-line call is truncated.
    const calls = [...RTE.matchAll(/await runTurn\(\{[\s\S]*?\}\)/g)].map((m) => m[0]);
    ok('there are exactly two call sites', calls.length === 2, calls.length);
    ok('both pass msgs', calls.every((c) => /msgs:/.test(c)), calls);
    ok('and neither passes userText', calls.every((c) => !/userText/.test(c)), calls);
  }

  console.log('\n-- THE CONVERSATION STARTS ON A USER TURN, WITHOUT LOSING ONE --');
  {
    // MAX_HISTORY slices the last N of an alternating transcript that OPENS with the
    // assistant's greeting, so the slice begins on an assistant message half the time.
    const sent = await run([
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u2' },
    ]);
    ok('the conversation starts on a user turn, as the API requires', sent[0].role === 'user', sent[0]);
    ok('by prepending rather than dropping', /just opened NILDash/.test(sent[0].content), sent[0]);
    ok('so NOTHING is lost: all four turns survive', sent.length === 5, sent.map((m) => m.content));
    ok('including the leading assistant message', sent[1].content === 'a1', sent.map((m) => m.content));
    ok('the last message is still the newest turn', sent[sent.length - 1].content === 'u2', sent);
    ok('and the roles alternate cleanly from the start',
      sent.every((m, i) => m.role === (i % 2 === 0 ? 'user' : 'assistant')), sent.map((m) => m.role));
  }
  {
    const sent = await run([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
    ok('a window that already starts on a user turn is untouched', sent.length === 2 && sent[0].content === 'u1', sent);
  }
  {
    // Pathological: nothing but assistant messages.
    const sent = await run([{ role: 'assistant', content: 'a1' }, { role: 'assistant', content: 'a2' }]);
    ok('an all-assistant window still opens on a user turn', sent[0].role === 'user', sent[0]);
    ok('and keeps both assistant messages', sent.length === 3, sent.map((m) => m.content));
  }

  console.log('\n-- THE GREETING PATH IS UNCHANGED --');
  {
    const sent = await run([]);
    ok('an empty transcript still gets the opening instruction', sent.length === 1, sent);
    ok('as a user message', sent[0].role === 'user', sent[0]);
    ok('with the same wording as before', /\(The agent has just opened NILDash\./.test(sent[0].content), sent[0]);
  }
  {
    const sent = await run(undefined);
    ok('a missing msgs argument does not throw', sent.length === 1, sent);
  }

  console.log('\n-- THE CALLER\'S ARRAY IS NOT EDITED --');
  {
    const mine = [{ role: 'user', content: 'u1' }];
    const before = JSON.stringify(mine);
    await run(mine);
    ok('runTurn did not mutate what it was given', JSON.stringify(mine) === before, mine);
  }
  {
    const mine = [];
    await run(mine);
    ok('and did not push the opener onto an empty caller array', mine.length === 0, mine);
  }

  console.log('\n-- HISTORY IS READ ONCE, BY THE ROUTE --');
  {
    // build() makes history() throw, so a passing run above already proves runTurn
    // never calls it. This pins the count in the routes.
    ok('runTurn contains no history() call', !/await history\(/.test(SRC), (SRC.match(/.*history\(.*/) || [])[0]);
    const code = RTE.replace(/^\s*\/\/.*$/gm, '');
    const sess = code.slice(code.indexOf("router.post('/session'"), code.indexOf("router.post('/message'"));
    const msg = code.slice(code.indexOf("router.post('/message'"), code.indexOf("router.post('/confirm'"));
    ok('/session reads it once', (sess.match(/await history\(/g) || []).length === 1, (sess.match(/await history\(/g) || []).length);
    ok('/message reads it once', (msg.match(/await history\(/g) || []).length === 1, (msg.match(/await history\(/g) || []).length);
    ok('/message records BEFORE it reads, or the turn would be missing',
      msg.indexOf("await record(session.id, agentId, 'user', text)") < msg.indexOf('await history(session.id)'), null);
    ok('and reads before it calls the model',
      msg.indexOf('await history(session.id)') < msg.indexOf('await runTurn'), null);
    ok('/message now logs history in its timing line too', /TIMING \/message[\s\S]{0,200}history=\$\{tHist\}ms/.test(RTE));
  }

  console.log('\n-- history() ITSELF STILL RETURNS THE FULL TRANSCRIPT FOR DISPLAY --');
  {
    // /session hands its result straight to the browser on a resume. Trimming the
    // leading greeting HERE would have deleted it from the rendered conversation,
    // which is why the trim lives in runTurn instead.
    const h = lift('history');
    ok('history does not reshape the transcript for the API', !/role !== 'user'/.test(h), h);
    ok('the reshaping lives in runTurn', /convo\[0\]\.role !== 'user'/.test(SRC));
    ok('and /session still returns history verbatim to the client', /messages: existing, resumed: true/.test(RTE));
    ok('the replayed opener is one named constant, not two literals',
      (RTE.match(/just opened NILDash/g) || []).length === 1, (RTE.match(/just opened NILDash/g) || []).length);
  }

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})();
