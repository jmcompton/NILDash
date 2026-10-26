'use strict';
// No database, no network. Local HTTP servers stand in for DeepSeek, the
// search provider and Anthropic; mail is sent nowhere (--no-email).
//
//   node tests/run.js                every suite, against the committed baseline
//   node tests/prospectresearch.js   just this one
const _tp = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const REPO = _tp.join(__dirname, '..') + _tp.sep;

// ── "20 RESEARCH FAILED, 0 DRAFTED", EVERY NIGHT ─────────────────────────────
//
// Every research call in the Prospects brief is a DeepSeek search loop. In
// DeepSeek's thinking mode an assistant turn that called tools must be sent
// back with its reasoning_content, or the next round is refused with a 400.
// The loop dropped it, and the brief has no fallback, so every person failed
// at the second round. The stand-in below refuses exactly that.
//
// Fixed twice over: the loop sends the reasoning back, and a searched call
// DeepSeek cannot finish is asked of Anthropic's web search (as the app does).

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

const CSV = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Ann,Lee,https://www.linkedin.com/in/annlee,,Ridge Sports Agency,NIL Agent,12 Sep 2026
Eve,Sun,https://www.linkedin.com/in/evesun,,State University,Athletic Department Compliance,07 Sep 2026
Kim,Cho,https://www.linkedin.com/in/kimcho,,Cho Sports Management,Founder,03 Sep 2026
`;
const ANSWER = (name) => ({ summary: `${name} works in college sports.`, location: 'Dallas, TX', usBased: true, usSportsMarket: true, hook: 'NIL clients', opener: `${name.split(' ')[0]}, I build NILDash. Would a look help?` });

// MODE: 'thinking' refuses a tool round whose assistant turn lost its
// reasoning_content; 'broken' refuses every round after the first.
let MODE = 'thinking';
const seen = { ds: [], anthropic: 0 };
let PORTS = null;
function startFakes() {
  const ds = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
      const j = JSON.parse(body || '{}');
      seen.ds.push(j);
      const msgs = j.messages || [];
      const user = msgs.filter((m) => m.role === 'user')[0];
      const name = (String((user && user.content) || '').match(/PERSON: ([^,]+),/) || [])[1] || '';
      const toolTurns = msgs.filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length);
      const refuse = (msg) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: msg, type: 'invalid_request_error' } })); };
      if (toolTurns.length && MODE === 'broken') return refuse('The request could not be completed.');
      if (toolTurns.some((m) => !m.reasoning_content)) return refuse('Missing reasoning_content in an assistant message that called tools');
      const message = !toolTurns.length && Array.isArray(j.tools)
        ? { role: 'assistant', content: '', reasoning_content: `I should search for ${name}.`, tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: name + ' sports' }) } }] }
        : { role: 'assistant', content: JSON.stringify(ANSWER(name)), reasoning_content: 'The results answer it.' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: j.model, choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 60 } }));
    });
  });
  const sp = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ organic: [{ title: 'Profile', link: 'https://example.com/p', snippet: 'A profile.' }] })); });
  // Anthropic's Messages API, as the SDK calls it: POST /v1/messages.
  const an = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
      seen.anthropic++;
      const j = JSON.parse(body || '{}');
      const user = (j.messages || [])[0];
      const name = (String((user && user.content) || '').match(/PERSON: ([^,]+),/) || [])[1] || '';
      const okTool = Array.isArray(j.tools) && j.tools[0] && j.tools[0].type === 'web_search_20250305';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: j.model, stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: name } },
          { type: 'text', text: okTool ? JSON.stringify(ANSWER(name)) : 'no web_search tool was sent' }],
        usage: { input_tokens: 500, output_tokens: 80 } }));
    });
  });
  return Promise.all([ds, sp, an].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)))))
    .then(([a, b, c]) => { PORTS = { ds: a.address().port, sp: b.address().port, an: c.address().port, close: () => { a.close(); b.close(); c.close(); } }; });
}

function setup(extra) {
  const home = fs.mkdtempSync(_tp.join(os.tmpdir(), 'pr-test-'));
  const root = _tp.join(home, 'nildash-briefs');
  fs.mkdirSync(_tp.join(root, 'inbox'), { recursive: true });
  fs.writeFileSync(_tp.join(root, 'config.json'), JSON.stringify(Object.assign({
    to: 'me@x.com', resendApiKey: 're_test', deepseekApiKey: 'sk-ds-test-0000000000', deepseekBaseUrl: `http://127.0.0.1:${PORTS.ds}`, serperApiKey: 'serper-test',
    myAddresses: ['me@x.com'], aboutMe: 'me', prospectKeywords: ['agent', 'compliance', 'founder'], anthropicApiKey: '',
  }, extra || {})));
  fs.writeFileSync(_tp.join(root, 'Connections.csv'), CSV);
  return { home, root };
}
function run(home, args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [REPO + 'tools/briefs/prospecting.js', ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, BRIEFS_HOME: '', BRIEFS_MAIL_SOURCES: '',
      SERPER_SEARCH_URL: `http://127.0.0.1:${PORTS.sp}/search`, DEEPSEEK_API_KEY: '', SERPER_API_KEY: '', BRAVE_SEARCH_API_KEY: '', TAVILY_API_KEY: '',
      ANTHROPIC_API_KEY: '', BRIEFS_ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: '', BRIEFS_ANTHROPIC_BASE_URL: '', DATABASE_URL: '' } });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => { c.kill('SIGKILL'); }, 120000);
    c.on('close', () => { clearTimeout(t); resolve(out); });
  });
}
const briefOf = (root) => { const f = fs.readdirSync(root).find((x) => /prospecting\.md$/.test(x)); return f ? fs.readFileSync(_tp.join(root, f), 'utf8') : ''; };
const lines = (out) => out.split('\n').filter((l) => /drafted|FAILED|failed|Anthropic/.test(l));

async function main() {
  await startFakes();

  // ── 1. THINKING MODE: THE REASONING GOES BACK, EVERYONE IS DRAFTED ──────
  OUT.push('-- DeepSeek in thinking mode --');
  MODE = 'thinking'; seen.ds.length = 0;
  const a = setup();
  const outA = await run(a.home, ['--no-email']);
  const briefA = briefOf(a.root);
  ok('three researched, three drafted, none failed', /drafted 3, filtered 0/.test(outA) && !/research failed/.test(outA), lines(outA));
  ok('  the brief heads "3 drafted, 0 filtered"', /^# Prospects: 3 drafted, 0 filtered$/m.test(briefA), briefA.split('\n')[0]);
  const second = seen.ds.filter((j) => (j.messages || []).some((m) => m.role === 'tool'));
  ok('  each second round carried the model\'s reasoning back with its tool call',
    second.length === 3 && second.every((j) => j.messages.some((m) => m.role === 'assistant' && m.tool_calls && m.reasoning_content === `I should search for ${(String(j.messages.find((x) => x.role === 'user').content).match(/PERSON: ([^,]+),/) || [])[1]}.`)),
    second.map((j) => j.messages.filter((m) => m.role === 'assistant').map((m) => m.reasoning_content || null)));
  ok('  the openers are in the brief', /## Ann Lee/.test(briefA) && /## Eve Sun/.test(briefA) && /## Kim Cho/.test(briefA));
  ok('  no Anthropic call was needed', seen.anthropic === 0);

  // ── 2. DEEPSEEK CANNOT FINISH: ANTHROPIC ANSWERS, AS IN THE APP ─────────
  OUT.push('', '-- DeepSeek refuses; Anthropic answers --');
  MODE = 'broken'; seen.anthropic = 0;
  const b = setup({ anthropicApiKey: 'sk-ant-test-0000000000', anthropicBaseUrl: `http://127.0.0.1:${PORTS.an}` });
  const outB = await run(b.home, ['--no-email']);
  const briefB = briefOf(b.root);
  ok('three drafted through the fallback', /drafted 3, filtered 0/.test(outB) && seen.anthropic === 3, { lines: lines(outB), anthropic: seen.anthropic });
  ok('  each is logged with the DeepSeek error and who answered', (outB.match(/DeepSeek failed \(DeepSeek HTTP 400: The request could not be completed\.\); answered by Anthropic/g) || []).length === 3, lines(outB));
  ok('  the brief warns once, with the first DeepSeek error', /3 research call\(s\) were answered by Anthropic because DeepSeek could not finish them\. The first DeepSeek error: DeepSeek HTTP 400: The request could not be completed\./.test(briefB));
  ok('  the footer names the model that answered', /claude-haiku-4-5-20251001/.test(briefB));

  // ── 3. NO ANTHROPIC KEY: STILL FAILED, STILL RETRIED, NEVER INVENTED ────
  OUT.push('', '-- no fallback key --');
  seen.anthropic = 0;
  const c = setup();
  const outC = await run(c.home, ['--no-email']);
  const briefC = briefOf(c.root);
  ok('without an Anthropic key the call fails as before, with DeepSeek\'s words', /drafted 0, filtered 3 \(3 research failed\)/.test(outC) && seen.anthropic === 0, lines(outC));
  ok('  and the people are retried next run', /research failed: DeepSeek HTTP 400: The request could not be completed\..*\(will be retried next run\)/.test(briefC));

  // ── 4. THE LOOP ITSELF ───────────────────────────────────────────────────
  OUT.push('', '-- webSearchTool.searchLoop --');
  MODE = 'thinking'; seen.ds.length = 0;
  process.env.SERPER_SEARCH_URL = `http://127.0.0.1:${PORTS.sp}/search`;
  const WST = require(REPO + 'server/services/webSearchTool.js');
  const sp = WST.PROVIDERS.serper; const key = sp.key; sp.key = () => 'serper-test';
  const r = await WST.searchLoop({ prompt: 'PERSON: Lou Park, x', maxSearches: 2, apiKey: 'sk-ds', baseUrl: `http://127.0.0.1:${PORTS.ds}`, ledger: false, provider: sp })
    .catch((e) => ({ searches: 0, text: 'THREW: ' + e.message }));
  sp.key = key;
  ok('a thinking-mode search finishes: one search, then the answer', r.searches === 1 && /Lou Park works in college sports/.test(r.text), { searches: r.searches, text: String(r.text).slice(0, 80) });
  ok('  the second request carried reasoning_content on the assistant tool turn',
    seen.ds.length === 2 && seen.ds[1].messages.some((m) => m.role === 'assistant' && m.reasoning_content === 'I should search for Lou Park.'));
  const src = fs.readFileSync(REPO + 'server/services/webSearchTool.js', 'utf8');
  ok('  only a non-empty reasoning string is sent back', /if \(typeof reasoning === 'string' && reasoning\) turn\.reasoning_content = reasoning;/.test(src));

  PORTS.close();
  console.log(OUT.join('\n'));
  console.log(`\n${OUT.filter((l) => l.startsWith('PASS')).length}/${OUT.filter((l) => /^(PASS|FAIL)/.test(l)).length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
