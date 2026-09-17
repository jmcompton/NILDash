'use strict';
// Runs from a checkout on any machine against the local test Postgres. The
// two other ends are stand-ins: an HTTP server that answers like DeepSeek's
// chat endpoint (with a tool call on the first searched turn) and one that
// answers like Brave's search API. No real network.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/deepseek.js         just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const http = require('http');

// ── THE FAST TIER ON DEEPSEEK ────────────────────────────────────────────────
//
// Discovery, the contact ladder and the athlete lookup ran on Haiku, every
// one of them a web-search call through Anthropic's server-side tool.
// DeepSeek has no such tool, so the same calls now go: a plain call to its
// chat endpoint, a searched call through the function-calling loop over a
// search provider we bring. The routing is by call site and needs both keys;
// the writer never moves; a DeepSeek failure falls back to Haiku for that
// call; every row on the ledger says who answered.

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const near = (a, b) => Math.abs(a - b) < 1e-6;

// The stand-in DeepSeek. Mode 'ok': with tools on the request and no tool
// result yet, ask for one web_search; otherwise answer with text. Mode
// 'auth': 401 on everything (a non-retriable failure).
const seen = [];
let mode = 'ok';
function fakeDeepseek() {
  return http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
      const j = JSON.parse(body || '{}');
      seen.push({ url: req.url, auth: req.headers.authorization, body: j });
      if (mode === 'auth') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Authentication Fails', type: 'authentication_error' } })); }
      const hasToolResult = (j.messages || []).some((m) => m.role === 'tool');
      const usage = { prompt_tokens: 100, completion_tokens: 30, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80 };
      let message;
      if (Array.isArray(j.tools) && j.tools.length && !hasToolResult) {
        message = { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'Maxie Bakery Auburn AL owner' }) } }] };
      } else {
        const last = (j.messages || []).filter((m) => m.role === 'user').pop();
        const text = hasToolResult
          ? '{"contacts":[{"name":"Jane Maxie","title":"Owner","email":null,"phone":null,"sourceUrl":"https://maxiebakery.com/about"}],"businessPhone":null,"state":"AL"}'
          : `{"echo":${JSON.stringify(String((last && last.content) || '').slice(0, 30))},"temperature":${j.temperature === undefined ? 'null' : j.temperature}}`;
        message = { role: 'assistant', content: text };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', model: j.model, choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage }));
    });
  });
}
const searches = [];
function fakeBrave() {
  return http.createServer((req, res) => {
    searches.push({ url: req.url, token: req.headers['x-subscription-token'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ web: { results: [{ title: 'About Maxie Bakery', url: 'https://maxiebakery.com/about', description: 'Owner Jane Maxie opened the bakery in 2015.' }, { title: 'Chamber', url: 'https://auburnchamber.com/maxie', description: 'Member since 2016.' }] } }));
  });
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

async function main() {
  const ds = fakeDeepseek(), br = fakeBrave();
  const dsPort = await listen(ds), brPort = await listen(br);
  process.env.DEEPSEEK_API_KEY = 'sk-ds-test';
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${dsPort}`;
  process.env.BRAVE_SEARCH_API_KEY = 'brave-test';
  process.env.BRAVE_SEARCH_URL = `http://127.0.0.1:${brPort}/search`;
  delete process.env.AI_FAST_PROVIDER; delete process.env.DEEPSEEK_SITES;

  const store = require(REPO + 'server/store.js');
  const ai = require(REPO + 'server/ai.js');
  const meter = require(REPO + 'server/scanMeter.js');
  const Ledger = require(REPO + 'server/services/aiLedger.js');
  const DS = require(REPO + 'server/services/deepseek.js');
  const WST = require(REPO + 'server/services/webSearchTool.js');
  const AL = require(REPO + 'server/services/athleteLookup.js');
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await P.query(`DELETE FROM ai_call_ledger WHERE agent_id LIKE 'ds-test%'`).catch(() => {});

  // The Anthropic stand-in: whatever reaches it answers with this text.
  let anthropicCalls = 0;
  ai._setClientForTests({ messages: { create: async (req) => { anthropicCalls++; return { model: req.model, content: [{ type: 'text', text: '{"from":"anthropic"}' }], usage: { input_tokens: 50, output_tokens: 10 } }; } } });

  // ── 1. THE ROUTING RULE ──────────────────────────────────────────────────
  OUT.push('-- the routing rule --');
  ok('a routed site with both keys goes to DeepSeek', DS.route('discovery', { needsSearch: true }).provider === 'deepseek');
  ok('  a sub-site counts by its top level', DS.route('contacts.finalname', { needsSearch: true }).provider === 'deepseek' && DS.route('lookup.pro').provider === 'deepseek');
  ok('  the writer is never routed', DS.route('writer').provider === 'anthropic' && /not routed/.test(DS.route('writer').reason));
  // Every fast-tier call is routed now, labelled or not: social discovery,
  // company enrichment, the domain and person email searches, a bio.
  ok('  an unlabelled fast call is routed too', DS.route(undefined).provider === 'deepseek' && DS.route('social.discovery').provider === 'deepseek' && DS.route('enrichment').provider === 'deepseek');
  process.env.AI_FAST_PROVIDER = 'anthropic';
  ok('  AI_FAST_PROVIDER=anthropic is the kill switch', DS.route('discovery').provider === 'anthropic' && /Haiku for everything/.test(DS.describeRouting()));
  delete process.env.AI_FAST_PROVIDER;
  const savedBrave = process.env.BRAVE_SEARCH_API_KEY; delete process.env.BRAVE_SEARCH_API_KEY;
  ok('  a SEARCH call with no search provider stays on Anthropic', DS.route('contacts', { needsSearch: true }).provider === 'anthropic' && /no search provider key/.test(DS.route('contacts', { needsSearch: true }).reason));
  ok('  a plain call on the same site still goes to DeepSeek', DS.route('contacts', { needsSearch: false }).provider === 'deepseek');
  ok('  and the startup line says the searches stay on Haiku', /STAY ON HAIKU/.test(DS.describeRouting()), DS.describeRouting());
  process.env.BRAVE_SEARCH_API_KEY = savedBrave;
  ok('with both keys the startup line names the provider and the sites', /DeepSeek deepseek-v4-flash for every Haiku call \(discovery, instagram, contacts, lookup, social, enrichment and unlabelled\), never the writer, web search through brave at \$0\.005 a query/.test(DS.describeRouting()), DS.describeRouting());
  process.env.DEEPSEEK_SITES = 'contacts';
  ok('DEEPSEEK_SITES narrows the routed sites', DS.route('discovery').provider === 'anthropic' && DS.route('contacts').provider === 'deepseek');
  delete process.env.DEEPSEEK_SITES;

  // ── 2. A PLAIN CALL ──────────────────────────────────────────────────────
  OUT.push('', '-- a plain call: oneShot on the fast model under a routed site --');
  seen.length = 0; anthropicCalls = 0;
  const r1 = await meter.run(() => meter.label({ site: 'discovery', agentId: 'ds-test-ag', athleteId: 'ds-test-ath', brand: '[market refill]' },
    () => ai.oneShot('score these', 'sys', 500, ai.MODEL_FAST)));
  ok('the call reached DeepSeek, not Anthropic', seen.length === 1 && anthropicCalls === 0 && /"from"/.test(r1.result) === false && /echo/.test(r1.result), { seen: seen.length, anthropicCalls, text: r1.result });
  ok('  on the bearer key, the model, the system prompt and max_tokens', seen[0].auth === 'Bearer sk-ds-test' && seen[0].body.model === 'deepseek-v4-flash' && seen[0].body.messages[0].role === 'system' && seen[0].body.messages[0].content === 'sys' && seen[0].body.max_tokens === 500, seen[0].body);
  ok('  the meter counted one model call', r1.meter.aiCalls === 1, r1.meter);
  await Ledger.drain();
  const row1 = (await P.query(`SELECT * FROM ai_call_ledger WHERE agent_id = 'ds-test-ag' AND site = 'discovery' ORDER BY id DESC LIMIT 1`)).rows[0];
  ok('the ledger row says deepseek answered', row1 && row1.provider === 'deepseek' && row1.model === 'deepseek-v4-flash', row1);
  ok('  cache hit tokens are cache reads, the miss is the input', row1 && row1.input_tokens === 80 && row1.cache_read_tokens === 20 && row1.output_tokens === 30, row1);
  const expect1 = (80 * Ledger.DEEPSEEK_PRICE[0] + 30 * Ledger.DEEPSEEK_PRICE[1] + 20 * Ledger.DEEPSEEK_PRICE[2]) / 1e6;
  ok('  priced at the DeepSeek rates', row1 && near(Number(row1.est_usd), Math.round(expect1 * 1e6) / 1e6), row1 && [row1.est_usd, expect1]);
  ok('  and carries the brand and athlete like any other row', row1 && row1.brand === '[market refill]' && row1.athlete_id === 'ds-test-ath');

  seen.length = 0; anthropicCalls = 0;
  await meter.run(() => meter.label({ site: 'writer', agentId: 'ds-test-ag' }, () => ai.oneShot('write', 'sys', 500, ai.MODEL_FAST)));
  ok('the same fast-model call under the WRITER label goes to Anthropic', seen.length === 0 && anthropicCalls === 1);
  seen.length = 0; anthropicCalls = 0;
  await meter.run(() => meter.label({ site: 'discovery', agentId: 'ds-test-ag' }, () => ai.oneShot('write', 'sys', 500, ai.MODEL_GEN)));
  ok('  and a Sonnet call under discovery goes to Anthropic: only the fast tier moves', seen.length === 0 && anthropicCalls === 1);
  seen.length = 0; anthropicCalls = 0;
  await ai.oneShot('bio', 'sys', 100, ai.MODEL_FAST);
  ok('  an unlabelled fast call (a bio from the app) goes to DeepSeek too', seen.length === 1 && anthropicCalls === 0);

  // ── 3. A SEARCHED CALL ───────────────────────────────────────────────────
  OUT.push('', '-- a searched call: the loop, the provider, the citations --');
  seen.length = 0; searches.length = 0; anthropicCalls = 0;
  const r2 = await meter.run(() => meter.label({ site: 'contacts.chamber', agentId: 'ds-test-ag', athleteId: 'ds-test-ath', brand: 'Maxie Bakery' },
    () => ai.webSearchJson('Who owns Maxie Bakery in Auburn, AL? Return JSON.', 'You research a business.')));
  ok('two DeepSeek turns: the tool call, then the answer', seen.length === 2 && anthropicCalls === 0, seen.length);
  ok('  the first turn offered web_search and fetch_page', Array.isArray(seen[0].body.tools) && seen[0].body.tools.map((t) => t.function.name).join(',') === 'web_search,fetch_page');
  ok('  the search went to the provider on its key', searches.length === 1 && searches[0].token === 'brave-test' && /q=Maxie%20Bakery/.test(searches[0].url), searches);
  ok('  the second turn carried the tool result back, with the tools still offered (one search of two used)', seen[1].body.messages.some((m) => m.role === 'tool' && /maxiebakery\.com/.test(m.content)) && Array.isArray(seen[1].body.tools));
  ok('  the answer is the extraction, with the searched URLs as citations', /Jane Maxie/.test(r2.result.text) && r2.result.citations.includes('https://maxiebakery.com/about') && r2.result.citations.includes('https://auburnchamber.com/maxie'), r2.result);
  ok('  searches and output tokens are reported like the Anthropic path', r2.result.searches === 1 && r2.result.outTokens === 60 && r2.result.apiMs >= 0, r2.result);
  ok('  the contact extraction runs at temperature 0', seen[0].body.temperature === 0 && seen[1].body.temperature === 0);
  ok('  the meter counted ONE web search for the call, as the Anthropic path does', r2.meter.webSearches === 1 && r2.meter.aiCalls === 0, r2.meter);
  await Ledger.drain();
  const rows2 = (await P.query(`SELECT site, provider, model, input_tokens, output_tokens, web_searches, est_usd FROM ai_call_ledger WHERE agent_id = 'ds-test-ag' AND site = 'contacts.chamber' ORDER BY id`)).rows;
  ok('the ledger has the two turns and one search row, all deepseek', rows2.length === 3 && rows2.every((r) => r.provider === 'deepseek') && rows2[2].web_searches === 1 && rows2[2].input_tokens === 0, rows2);
  ok('  the search row is priced at the provider rate, not Anthropic\'s', near(Number(rows2[2].est_usd), Ledger.USD_PER_SEARCH.deepseek) && Ledger.USD_PER_SEARCH.deepseek < Ledger.USD_PER_SEARCH.anthropic, rows2[2]);

  seen.length = 0; searches.length = 0; anthropicCalls = 0;
  const r3 = await meter.run(() => meter.label({ site: 'discovery', agentId: 'ds-test-ag' }, () => ai.oneShotWebSearch('find businesses', 'sys', 800, 4, ai.MODEL_FAST)));
  ok('oneShotWebSearch on the fast model under discovery takes the same loop', seen.length === 2 && searches.length === 1 && anthropicCalls === 0 && /Jane Maxie/.test(r3.result));
  seen.length = 0; anthropicCalls = 0;
  await meter.run(() => meter.label({ site: 'discovery', agentId: 'ds-test-ag' }, () => ai.oneShotWebSearch('find businesses', 'sys', 800, 4, ai.MODEL_STANDARD)));
  ok('  but not on another model', seen.length === 0 && anthropicCalls === 1);

  // ── 4. THE ATHLETE LOOKUP ────────────────────────────────────────────────
  OUT.push('', '-- the athlete lookup --');
  seen.length = 0; searches.length = 0;
  const lk = await AL._deepseekStage('lookup.college', 'Search for this college athlete: Test Person', 'You are an athlete data lookup assistant.');
  ok('the college stage runs through the loop and parses the JSON', lk && lk.contacts && seen.length === 2 && searches.length === 1, lk);
  await Ledger.drain();
  const lkRows = (await P.query(`SELECT provider FROM ai_call_ledger WHERE site = 'lookup.college' AND provider = 'deepseek' AND at > NOW() - INTERVAL '1 minute'`)).rows;
  ok('  and its rows say deepseek under lookup.college', lkRows.length >= 2, lkRows.length);
  process.env.AI_FAST_PROVIDER = 'anthropic';
  ok('  undefined (not null) when not routed, so the Haiku call runs', (await AL._deepseekStage('lookup.college', 'p', 's')) === undefined);
  delete process.env.AI_FAST_PROVIDER;
  await P.query(`DELETE FROM ai_call_ledger WHERE site = 'lookup.college' AND provider = 'deepseek' AND at > NOW() - INTERVAL '1 minute'`).catch(() => {});

  // ── 5. THE FALLBACK ──────────────────────────────────────────────────────
  OUT.push('', '-- a DeepSeek failure falls back to Haiku for that call --');
  mode = 'auth'; seen.length = 0; anthropicCalls = 0;
  const r4 = await meter.run(() => meter.label({ site: 'discovery', agentId: 'ds-test-ag' }, () => ai.oneShot('score', 'sys', 500, ai.MODEL_FAST)));
  ok('a 401 from DeepSeek: the call is answered by Anthropic', seen.length === 1 && anthropicCalls === 1 && /anthropic/.test(r4.result), { seen: seen.length, anthropicCalls, text: r4.result });
  seen.length = 0; anthropicCalls = 0;
  const r5 = await meter.run(() => meter.label({ site: 'contacts', agentId: 'ds-test-ag', brand: 'X' }, () => ai.webSearchJson('who owns X', 'sys')));
  ok('  the same for a searched call, with the Anthropic shape back', seen.length === 1 && anthropicCalls === 1 && typeof r5.result.text === 'string' && Array.isArray(r5.result.citations), r5.result);
  // The lookup has no Haiku to fall back to: a DeepSeek failure is null, and
  // the lookup reports it as a note rather than answering from another model.
  ok('  and the lookup stage says null: it reports the failure, it does not fall back', (await AL._deepseekStage('lookup.pro', 'p', 's')) === null);
  mode = 'ok';
  let thrown = null;
  const savedKey = process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_API_KEY; seen.length = 0;
  try { await DS.chat({ messages: [{ role: 'user', content: 'x' }], ledger: false }); } catch (e) { thrown = e; }
  process.env.DEEPSEEK_API_KEY = savedKey;
  ok('chat with no key throws before any request', thrown && /DEEPSEEK_API_KEY not set/.test(thrown.message) && seen.length === 0, thrown && thrown.message);
  ok('usageOf: zeros on a missing block, never NaN', DS.usageOf({}).inputTokens === 0 && DS.usageOf({ usage: { prompt_tokens: 10, completion_tokens: 2 } }).inputTokens === 10);
  ok('htmlToText strips scripts, tags and entities', WST.htmlToText('<html><script>x()</script><p>Owner: <b>Jane</b> &amp; Co</p></html>') === 'Owner: Jane & Co', WST.htmlToText('<html><script>x()</script><p>Owner: <b>Jane</b> &amp; Co</p></html>'));

  // ── 6. THE WIRING ────────────────────────────────────────────────────────
  OUT.push('', '-- the wiring --');
  const src = (p) => fs.readFileSync(REPO + p, 'utf8');
  ok('the ledger has a provider column', /ALTER TABLE ai_call_ledger ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'anthropic'/.test(src('server/store.js')));
  ok('spend-breakdown groups by provider and prints both price tables', /BY PROVIDER/.test(src('scripts/spend-breakdown.js')) && /through the search provider on DeepSeek/.test(src('scripts/spend-breakdown.js')));
  ok('the savings script re-prices the routed Haiku calls', /ESTIMATED SAVING FOR THIS WINDOW/.test(src('scripts/deepseek-savings.js')) && /the writer stays on Sonnet/.test(src('scripts/deepseek-savings.js')));
  ok('the writer is untouched: no deepseek in pitchWriter, MODEL_GEN on both writer sites', !/deepseek/i.test(src('server/services/pitchWriter.js')) && (src('server/jobs/outreachQueue.js').match(/site: 'writer'[\s\S]{0,300}?ai\.oneShot\(p2, sys, mt, ai\.MODEL_GEN\)/g) || []).length === 2);
  ok('oneShot routes only the fast model', /if \(useModel === MODEL_FAST\) \{\s*const rt = DS\.route\(scanMeter\.ctx\(\)\.site, \{ needsSearch: false \}\)/.test(src('server/ai.js')));
  ok('the routing is logged once at startup', /console\.log\('\[ai\] ' \+ DS\.describeRouting\(\)\)/.test(src('server/ai.js')));
  // The lookup is DeepSeek through the search loop and nothing else: no
  // Anthropic client, no Haiku fallback (tests/lookup.js covers the engine).
  ok('the lookup runs on DeepSeek only: no Anthropic SDK, no LOOKUP_MODEL', !/@anthropic-ai\/sdk/.test(src('server/services/athleteLookup.js')) && !/LOOKUP_MODEL/.test(src('server/services/athleteLookup.js')) && /DS\.route\('lookup', \{ needsSearch: true \}\)/.test(src('server/services/athleteLookup.js')));

  await P.query(`DELETE FROM ai_call_ledger WHERE agent_id LIKE 'ds-test%'`).catch(() => {});
  ds.close(); br.close();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
