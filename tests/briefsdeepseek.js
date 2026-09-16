'use strict';
// No database, no network: a local HTTP server stands in for DeepSeek's chat
// endpoint and another for Serper's search API. HOME is a scratch directory.
//
//   node tests/run.js                every suite, against the committed baseline
//   node tests/briefsdeepseek.js     just this one
const _tp = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const REPO = _tp.join(__dirname, '..') + _tp.sep;

// ── THE BRIEFS CALL DEEPSEEK DIRECTLY ────────────────────────────────────────
//
// The four morning briefs spawned `claude -p`. They now make one HTTPS call
// per question to DeepSeek on deepseekApiKey from config.json (the
// environment second, a clear failure third), and a searched call is the
// function-calling loop over the search provider whose key is set.

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

const seen = [];
function fakeDeepseek() {
  return http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
      const j = JSON.parse(body || '{}');
      seen.push({ auth: req.headers.authorization, body: j });
      if (req.headers.authorization !== 'Bearer sk-ds-config' && req.headers.authorization !== 'Bearer sk-ds-env') {
        res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Authentication Fails' } }));
      }
      const hasToolResult = (j.messages || []).some((m) => m.role === 'tool');
      const last = (j.messages || []).filter((m) => m.role === 'user').pop();
      const asks = String((last && last.content) || '');
      let message;
      if (Array.isArray(j.tools) && !hasToolResult) message = { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'NIL platform news' }) } }] };
      else if (/single word OK/.test(asks)) message = { role: 'assistant', content: 'OK' };
      else if (hasToolResult) message = { role: 'assistant', content: '[{"title":"Opendorse raises","url":"https://example.com/news/1","source":"Sportico","published":"2026-09-15","line":"Opendorse raised a round."}]' };
      else message = { role: 'assistant', content: '[{"i":0,"about":"a demo","promised":"a deck"}]' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: j.model, choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 40, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 200 } }));
    });
  });
}
const searched = [];
function fakeSerper() {
  return http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
      searched.push({ key: req.headers['x-api-key'], body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ organic: [{ title: 'Opendorse raises', link: 'https://example.com/news/1', snippet: 'Opendorse raised a round.' }] }));
    });
  });
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

async function main() {
  const ds = fakeDeepseek(), sp = fakeSerper();
  const dsPort = await listen(ds), spPort = await listen(sp);
  const home = fs.mkdtempSync(_tp.join(os.tmpdir(), 'bd-test-'));
  const root = _tp.join(home, 'nildash-briefs');
  fs.mkdirSync(_tp.join(root, 'inbox'), { recursive: true });
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.BRIEFS_HOME = '';
  for (const k of ['DEEPSEEK_API_KEY', 'BRIEFS_DEEPSEEK_API_KEY', 'BRAVE_SEARCH_API_KEY', 'SERPER_API_KEY', 'TAVILY_API_KEY', 'SEARCH_PROVIDER']) delete process.env[k];
  process.env.SERPER_SEARCH_URL = `http://127.0.0.1:${spPort}/search`;
  const CONFIG = _tp.join(root, 'config.json');
  const base = { to: 'me@x.com', resendApiKey: 're_x', myAddresses: ['me@x.com'], deepseekBaseUrl: `http://127.0.0.1:${dsPort}` };
  const writeConfig = (o) => fs.writeFileSync(CONFIG, JSON.stringify(Object.assign({}, base, o || {})));
  const L = require(REPO + 'tools/briefs/lib.js');

  // ── 1. WHERE THE KEY COMES FROM ──────────────────────────────────────────
  OUT.push('-- where the key comes from --');
  writeConfig({});
  let threw = null;
  try { await L.askModel('hi', { cfg: L.loadConfig(), tools: [] }); } catch (e) { threw = e; }
  ok('no key anywhere: a clear error naming both places, no request made', threw && /No DeepSeek API key/.test(threw.message) && threw.message.includes(CONFIG) && /DEEPSEEK_API_KEY/.test(threw.message) && seen.length === 0, threw && threw.message);
  process.env.DEEPSEEK_API_KEY = 'sk-ds-env';
  const fromEnv = L.resolveDeepseekKey(L.loadConfig());
  ok('environment only: the environment key', fromEnv.key === 'sk-ds-env' && fromEnv.source === 'environment');
  writeConfig({ deepseekApiKey: 'sk-ds-config' });
  const fromCfg = L.resolveDeepseekKey(L.loadConfig());
  ok('both set: config.json wins', fromCfg.key === 'sk-ds-config' && fromCfg.source === 'config.json' && fromCfg.masked === 'sk-ds-c…nfig', fromCfg);
  writeConfig({ deepseekApiKey: '   ' });
  ok('a blank config value falls through to the environment', L.resolveDeepseekKey(L.loadConfig()).source === 'environment');
  delete process.env.DEEPSEEK_API_KEY;

  // ── 2. A PLAIN CALL ──────────────────────────────────────────────────────
  OUT.push('', '-- a plain call --');
  writeConfig({ deepseekApiKey: 'sk-ds-config' });
  seen.length = 0;
  const r1 = await L.askModel('Summarise these threads. Return ONLY the JSON array.', { cfg: L.loadConfig(), label: 'follow-ups', maxTurns: 2, tools: [] });
  ok('one request to the configured endpoint on the config key', seen.length === 1 && seen[0].auth === 'Bearer sk-ds-config' && seen[0].body.model === 'deepseek-v4-flash', seen[0]);
  ok('  no tools on a plain call', seen[0].body.tools === undefined);
  ok('  text, the first JSON value, the usage and an estimate come back', Array.isArray(r1.json) && r1.json[0].about === 'a demo' && r1.usage.inputTokens === 200 && r1.usage.outputTokens === 40 && r1.costUsd > 0 && r1.numTurns === 1 && r1.searches === 0 && r1.keySource === 'config.json', r1);
  writeConfig({ deepseekApiKey: 'sk-ds-config', deepseekModel: 'deepseek-other' });
  seen.length = 0;
  await L.askModel('x', { cfg: L.loadConfig(), tools: [], model: 'haiku' });
  ok('  an old tier name ("haiku") means the configured model', seen[0].body.model === 'deepseek-other');

  // ── 3. A SEARCHED CALL ───────────────────────────────────────────────────
  OUT.push('', '-- a searched call --');
  writeConfig({ deepseekApiKey: 'sk-ds-config' });
  threw = null; seen.length = 0;
  try { await L.askModel('search news', { cfg: L.loadConfig(), maxTurns: 4, tools: ['WebSearch', 'WebFetch'] }); } catch (e) { threw = e; }
  ok('no search key: the error names the three keys and no request is made', threw && /serperApiKey/.test(threw.message) && /SERPER_API_KEY/.test(threw.message) && seen.length === 0, threw && threw.message);
  writeConfig({ deepseekApiKey: 'sk-ds-config', serperApiKey: 'serper-config' });
  seen.length = 0; searched.length = 0;
  const r2 = await L.askModel('Search the web for news about "NIL platform". Return ONLY a JSON array.', { cfg: L.loadConfig(), label: 'news:NIL platform', maxTurns: 4, tools: ['WebSearch', 'WebFetch'] });
  ok('the loop: a tool call, the search through the provider on the config key, the answer', seen.length === 2 && searched.length === 1 && searched[0].key === 'serper-config' && searched[0].body.q === 'NIL platform news', { seen: seen.length, searched });
  ok('  the answer carries the items, the search count and the provider', Array.isArray(r2.json) && r2.json[0].url === 'https://example.com/news/1' && r2.searches === 1 && r2.searchProvider === 'serper' && r2.numTurns === 2, r2);
  ok('  maxTurns is the search cap in the system prompt', /at most 4 searches/.test(seen[0].body.messages[0].content));
  delete process.env.SERPER_API_KEY;

  // ── 4. THE AUDIT LINE AND THE FOOTER ─────────────────────────────────────
  OUT.push('', '-- the audit line and the footer --');
  writeConfig({ deepseekApiKey: 'sk-ds-config', serperApiKey: 'serper-config' });
  const a = L.modelAudit(L.loadConfig());
  ok('the audit line names the model, the masked key, its source and the search door', /^model: DeepSeek deepseek-v4-flash on API key sk-ds-c…nfig from config\.json; web search via serper$/.test(a.line), a.line);
  ok('  never the key', !a.line.includes('sk-ds-config'));
  delete process.env.SERPER_API_KEY;
  writeConfig({});
  ok('  with no key it says so, and names the search keys to set', /^model: NO DEEPSEEK API KEY/.test(L.modelAudit(L.loadConfig()).line) && /web search via NONE \(set braveSearchApiKey/.test(L.modelAudit(L.loadConfig()).line), L.modelAudit(L.loadConfig()).line);
  const foot = L.footer('news-watch', [r1, r2], a);
  ok('the footer sums tokens, searches and the estimate', /DeepSeek calls: 2 \(deepseek-v4-flash\); turns: 1, 2; tokens in\/out: 600\/120; searches: 1; est \$0\.\d{4}/.test(foot), foot);
  ok('  and says none when there were none', /DeepSeek calls: none/.test(L.footer('x', [], a)));
  ok('  a stub call without usage still renders', /DeepSeek calls: 1/.test(L.footer('x', [{ text: 'x', numTurns: 2 }], a)));

  // ── 5. --api-test ────────────────────────────────────────────────────────
  OUT.push('', '-- --api-test --');
  writeConfig({ deepseekApiKey: 'sk-ds-config', serperApiKey: 'serper-config' });
  // Asynchronous, so the fake servers in THIS process can answer the child.
  const run = (args) => new Promise((resolve) => {
    const c = spawn(process.execPath, [REPO + 'tools/briefs/lib.js', ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, BRIEFS_HOME: '', SERPER_API_KEY: '' } });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => { c.kill('SIGKILL'); }, 60000);
    c.on('close', () => { clearTimeout(t); resolve(out); });
  });
  const t1 = await run(['--api-test', '--search']);
  ok('--api-test passes on the fake, naming the source and never the key', /RESULT: PASS\. DeepSeek answers from here on the API key from config\.json\./.test(t1) && !/sk-ds-config/.test(t1), t1);
  ok('  --search runs one searched call and names the provider', /RESULT: PASS\. Web search works through serper\./.test(t1), t1);
  writeConfig({ deepseekApiKey: 'sk-ds-wrong-key-0000' });
  const t2 = await run(['--api-test']);
  ok('  a refused key says so', /RESULT: FAILED: DeepSeek HTTP 401/.test(t2) && /refused the key/.test(t2), t2);
  writeConfig({});
  ok('  no key says which to set', /RESULT: FAILED: No DeepSeek API key/.test(await run(['--api-test'])));

  // ── 6. THE WIRING ────────────────────────────────────────────────────────
  OUT.push('', '-- the wiring --');
  const src = (f) => fs.readFileSync(REPO + 'tools/briefs/' + f, 'utf8');
  for (const f of ['follow-ups.js', 'news-watch.js', 'prospecting.js']) ok(`${f} calls askModel and never claudeP`, /L\.askModel\(/.test(src(f)) && !/L\.claudeP\(/.test(src(f)) && /L\.modelAudit\(\)/.test(src(f)));
  ok('strategy-watch defaults to askModel, keeps the test seam, drops the haiku tier', /opts\.ask \|\| opts\.claudeP \|\| L\.askModel/.test(src('strategy-watch.js')) && /const MODEL = null/.test(src('strategy-watch.js')));
  ok('ENV_MAP carries the BRIEFS_ DeepSeek key and the search keys', L.ENV_MAP.BRIEFS_DEEPSEEK_API_KEY === 'deepseekApiKey' && L.ENV_MAP.SERPER_API_KEY === 'serperApiKey' && L.ENV_MAP.BRAVE_SEARCH_API_KEY === 'braveSearchApiKey');
  ok('  DEEPSEEK_API_KEY itself is the environment fallback, not a config field', L.ENV_MAP.DEEPSEEK_API_KEY === undefined && L.configFromEnv({ DEEPSEEK_API_KEY: 'a', BRIEFS_DEEPSEEK_API_KEY: 'b' }).deepseekApiKey === 'b');
  const ex = JSON.parse(src('config.example.json'));
  ok('the example config shows the fields with placeholders', /^sk-PASTE/.test(ex.deepseekApiKey) && ex.deepseekModel === 'deepseek-v4-flash' && 'serperApiKey' in ex && 'braveSearchApiKey' in ex);
  ok('the Dockerfile no longer installs the CLI', !/claude-code/.test(src('Dockerfile')) && /DEEPSEEK_API_KEY/.test(src('Dockerfile')));
  ok('the README documents the key order, the search keys and --api-test', /deepseekApiKey.*first.*environment.*second/i.test(src('README.md').replace(/\n/g, ' ')) && /--api-test --search/.test(src('README.md')) && /No DeepSeek API key/.test(src('README.md')));
  const realKey = /sk-[A-Za-z0-9]{32,}/;
  ok('no file in tools/briefs holds a real-looking key', ['lib.js', 'README.md', 'config.example.json', 'crontab.example', 'Dockerfile'].every((f) => !realKey.test(src(f))));

  ds.close(); sp.close();
  fs.rmSync(home, { recursive: true, force: true });
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
