'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/providerfaults.js   just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── A VENDOR WE HAVE NOT PAID IS OUR FAULT, THE LOUDEST, AND NEVER SHOWN ────
// 2026-10-03: DeepSeek refused every call with 402 Insufficient Balance; the
// status page was green (the nightly check passed at 05:31 UTC, the money ran
// out later); the 402s were recorded nowhere; and a customer read
// "DeepSeek HTTP 402: Insufficient Balance (request_id: ...)" in Add Client.
//   1. ourFault.classify: 402 / "credit balance is too low" / Google billing
//      -> billing; 401/403 -> auth; 429 -> quota.
//   2. Every paid provider's client records it where it happens (DeepSeek,
//      Anthropic, the search providers), with its kind, and a payment failure
//      emails the admin at once, once per window.
//   3. The preflight reads DeepSeek's balance: unavailable or under the floor
//      is red, as billing.
//   4. The status page: a live payment failure newer than the last check turns
//      the service red and puts a PAYMENT FAILURE banner first.
//   5. Customers: every /api error naming a vendor, an HTTP code or a request
//      id is replaced with plain words (logged); the lookup offers Try again.
//   6. The school hint describes the value in the field or nothing.
const fs = require('fs');
const net = require('net');
const http = require('http');
const { execSync } = require('child_process');
const store = require(REPO + 'server/store.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const realFetch = global.fetch;
const fakeResp = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body });

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const OF = require(REPO + 'server/services/ourFault.js');
  const since = new Date(Date.now() - 1000);
  const rows = async (svc) => (await P.query(`SELECT service, kind, reason FROM service_faults WHERE service = $1 AND at >= $2 ORDER BY at DESC`, [svc, since])).rows;
  const tick = () => new Promise((r) => setTimeout(r, 150));
  await P.query(`DELETE FROM service_fault_alerts`).catch(() => {});

  // ── 1. CLASSIFY ─────────────────────────────────────────────────────────
  OUT.push('-- what counts as a payment, key or quota failure --');
  ok('402 Insufficient Balance (DeepSeek): billing', OF.classify(402, 'DeepSeek HTTP 402: Insufficient Balance') === 'billing');
  ok('Anthropic\'s "credit balance is too low" is a 400, and still billing', OF.classify(400, 'Your credit balance is too low to access the Anthropic API') === 'billing');
  ok('Serper "Not enough credits", Google "Billing must be enabled", Tavily 432: billing',
    OF.classify(400, 'Not enough credits') === 'billing' && OF.classify(403, 'Billing must be enabled on this project') === 'billing' && OF.classify(432, 'plan') === 'billing');
  ok('401 and a plain 403: auth; 429: quota; 500 and 404: not this kind', OF.classify(401, 'x') === 'auth' && OF.classify(403, 'API key not valid') === 'auth'
    && OF.classify(429, 'x') === 'quota' && OF.classify(500, 'oops') === null && OF.classify(404, 'not found') === null);
  ok('the status is read off the error or its message ("HTTP 402: ...")', OF.statusOf({ status: 402 }) === 402 && OF.statusOf(new Error('Error: HTTP 429: slow down')) === 429);

  // ── 2. RECORDED WHERE IT HAPPENS ────────────────────────────────────────
  OUT.push('', '-- recorded by the provider\'s own client --');
  process.env.DEEPSEEK_API_KEY = 'test-key';
  global.fetch = async () => fakeResp(402, { error: { message: 'Insufficient Balance', type: 'unknown_error' } });
  let dsErr = null;
  try { await require(REPO + 'server/services/deepseek.js').chat({ messages: [{ role: 'user', content: 'x' }], maxTokens: 1, ledger: false }); } catch (e) { dsErr = e; }
  await tick();
  const ds = await rows('deepseek');
  ok('DeepSeek 402: the call still fails, and service_faults has it as billing', dsErr && dsErr.status === 402 && ds[0] && ds[0].kind === 'billing' && /PAYMENT FAILURE/.test(ds[0].reason), ds[0]);
  ok('  the error is tagged for the caller (providerKind)', dsErr && dsErr.providerKind === 'billing');

  const ai = require(REPO + 'server/ai.js');
  const fakeClient = { messages: { create: () => Promise.reject(Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), { status: 400 })) } };
  ai.guardAnthropic(fakeClient, 'test');
  let anErr = null; try { await fakeClient.messages.create({}); } catch (e) { anErr = e; }
  await tick();
  const an = await rows('anthropic');
  ok('Anthropic "credit balance is too low": the guard records it as billing and rethrows', anErr && an[0] && an[0].kind === 'billing', an[0]);
  const IDX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('  every Anthropic client in the server is guarded',
    /client = guardAnthropic\(new Anthropic\(/.test(fs.readFileSync(REPO + 'server/ai.js', 'utf8'))
    && /guardAnthropic\(new Anthropic\(/.test(fs.readFileSync(REPO + 'server/services/contractExtraction.js', 'utf8'))
    && /guardAnthropic\(new Anthropic\(/.test(fs.readFileSync(REPO + 'server/nilCompJob.js', 'utf8'))
    && !/new Anthropic\(\{ apiKey: process\.env\.ANTHROPIC_API_KEY \}\)(?!\), 'index)/.test(IDX.replace(/require\('\.\/ai'\)\.guardAnthropic\(new Anthropic\(\{ apiKey: process\.env\.ANTHROPIC_API_KEY \}\), 'index\.js'\)/g, '')));

  process.env.SERPER_API_KEY = 'test-serper';
  global.fetch = async () => fakeResp(400, { message: 'Not enough credits', statusCode: 400 });
  const WST = require(REPO + 'server/services/webSearchTool.js');
  let srErr = null; try { await WST.PROVIDERS.serper.search('x', 1); } catch (e) { srErr = e; }
  await tick();
  const sr = await rows('serper');
  ok('Serper out of credits: recorded as billing under serper', srErr && sr[0] && sr[0].kind === 'billing', sr[0] || String(srErr));
  const src = (f) => fs.readFileSync(REPO + f, 'utf8');
  ok('  Hunter and Google Places report through the same rule',
    /providerError\('hunter'/.test(src('server/services/hunterLookup.js')) && (src('server/services/placesLookup.js').match(/providerError\('google-places'/g) || []).length >= 4
    && /providerError\('google-places'/.test(src('server/services/placesMarket.js')));

  // The admin hears at once: one email per provider and kind per 3 hours.
  OUT.push('', '-- the admin hears at once --');
  await P.query(`DELETE FROM service_fault_alerts WHERE service = 'pf-test'`).catch(() => {});
  const sent = [];
  const makeResend = () => ({ emails: { send: async (m) => { sent.push(m); return { id: 'x' }; } } });
  const envBefore = { to: process.env.ADMIN_ALERT_EMAIL, rk: process.env.RESEND_API_KEY };
  process.env.ADMIN_ALERT_EMAIL = 'admin@x.test'; process.env.RESEND_API_KEY = 're_test';
  const a1 = await OF.alertNow('pf-test', 'billing', 'PAYMENT FAILURE: HTTP 402: Insufficient Balance', 'test', { makeResend });
  const a2 = await OF.alertNow('pf-test', 'billing', 'again', 'test', { makeResend });
  ok('a payment failure emails the admin at once, subject first: PAYMENT FAILURE',
    a1.sent && sent.length === 1 && /PAYMENT FAILURE: pf-test/.test(sent[0].subject) && sent[0].to === 'admin@x.test', { a1, subject: sent[0] && sent[0].subject });
  ok('  and not again within the window (once per provider and kind)', !a2.sent && sent.length === 1, a2);
  process.env.ADMIN_ALERT_EMAIL = ''; delete process.env.ADMIN_ALERT_EMAIL;
  const saveAdmin = process.env.ADMIN_EMAIL; delete process.env.ADMIN_EMAIL;
  await P.query(`DELETE FROM service_fault_alerts WHERE service = 'pf-test2'`).catch(() => {});
  const a3 = await OF.alertNow('pf-test2', 'billing', 'x', 'test', { makeResend });
  ok('  with no ADMIN_ALERT_EMAIL it says so in the log and the result, not silently', !a3.sent && a3.why === 'no destination', a3);
  if (envBefore.to !== undefined) process.env.ADMIN_ALERT_EMAIL = envBefore.to;
  if (saveAdmin !== undefined) process.env.ADMIN_EMAIL = saveAdmin;
  if (envBefore.rk !== undefined) process.env.RESEND_API_KEY = envBefore.rk; else delete process.env.RESEND_API_KEY;

  // ── 3. THE PREFLIGHT READS THE BALANCE ──────────────────────────────────
  OUT.push('', '-- the preflight checks we can pay, not only that it answers --');
  const PF = require(REPO + 'server/services/preflight.js');
  const dsStub = { apiKey: () => 'k', model: () => 'deepseek-chat', chat: async () => ({ text: '' }) };
  const bal = (body) => PF.checks({ pool: P, ds: dsStub, fetch: async () => fakeResp(200, body) }).deepseek().then(() => null, (e) => e);
  const low = await bal({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1.20' }] });
  ok(`a balance under the floor ($${PF.DEEPSEEK_MIN_BALANCE}) is red, as billing, before it runs out`, low && /below the 5\.00 floor/.test(low.message) && OF.classify(low.status, low.message) === 'billing', low && low.message);
  const off = await bal({ is_available: false, balance_infos: [] });
  ok('  is_available:false is red, as billing', off && OF.classify(off.status, off.message) === 'billing', off && off.message);
  const fine = await PF.checks({ pool: P, ds: dsStub, fetch: async () => fakeResp(200, { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '110.00' }] }) }).deepseek();
  ok('  a healthy balance is green and says how much', /balance USD 110\.00/.test(fine), fine);
  const run = await PF.runAll(P, { deps: { ds: dsStub, fetch: async (u) => (/balance/.test(u) ? fakeResp(200, { is_available: false }) : fakeResp(402, { error: { message: 'x' } })),
    ai: { MODEL_FAST: 'm', getClient: () => ({ messages: { create: async () => { throw Object.assign(new Error('Your credit balance is too low'), { status: 400 }); } } }) },
    wst: { provider: () => ({ name: 'serper', search: async () => { throw Object.assign(new Error('HTTP 402: Not enough credits'), { status: 402 }); } }) },
    gmail: {}, outlook: {}, emailStore: {} } });
  const by = Object.fromEntries(run.results.map((r) => [r.service, r]));
  ok('runAll: DeepSeek, Anthropic and web search all red, each tagged billing',
    !by.deepseek.ok && by.deepseek.detail.kind === 'billing' && !by.anthropic.ok && by.anthropic.detail.kind === 'billing' && !by['web-search'].ok && by['web-search'].detail.kind === 'billing',
    { ds: by.deepseek, an: by.anthropic, ws: by['web-search'] });
  const msg = PF.render(run, Date.now());
  ok('  the preflight email\'s subject leads with PAYMENT FAILURE, and the body lists those first',
    /^NILDash PAYMENT FAILURE: /.test(msg.subject) && /^\*\*\* PAYMENT FAILURE \*\*\* /m.test(msg.text), msg.subject);

  // ── 4. THE STATUS PAGE ──────────────────────────────────────────────────
  OUT.push('', '-- the status page --');
  await P.query(`INSERT INTO service_checks (run_id, service, ok, ms, error) VALUES ('pf_test', 'deepseek', true, 908, NULL)`);
  await P.query(`UPDATE service_checks SET checked_at = NOW() - INTERVAL '6 hours' WHERE run_id = 'pf_test'`);
  await P.query(`INSERT INTO service_faults (service, reason, context, kind) VALUES ('deepseek', 'PAYMENT FAILURE: HTTP 402: DeepSeek HTTP 402: Insufficient Balance', 'athleteLookup', 'billing')`);
  const SP = require(REPO + 'server/services/statusPage.js');
  const st = await SP.collect(P);
  const dsRow = st.services.find((x) => x.service === 'deepseek');
  ok('the morning check passed, a 402 came after: deepseek is RED, kind billing, saying the last check had passed',
    dsRow && dsRow.state === 'failed' && dsRow.kind === 'billing' && /last check had passed/.test(dsRow.error), dsRow);
  const html = SP.renderHtml(st);
  ok('  and the page opens with the PAYMENT FAILURE banner, before everything else', /<div class="pay"><div class="payh">PAYMENT FAILURE: [^<]*deepseek/.test(html) && html.indexOf('class="pay"') < html.indexOf('<h3>External services'));
  await P.query(`DELETE FROM service_checks WHERE run_id = 'pf_test'`);
  ok('the morning alert puts PAYMENT FAILURE first in its subject and body', /bits\.unshift\(`PAYMENT FAILURE: /.test(src('server/services/morningAlert.js')) && /\*\*\* PAYMENT FAILURE/.test(src('server/services/morningAlert.js')));

  // ── 5. CUSTOMERS NEVER SEE IT ───────────────────────────────────────────
  OUT.push('', '-- customers never see a vendor error --');
  global.fetch = realFetch;
  const CE = require(REPO + 'server/services/customerErrors.js');
  const leaked = 'web search failed: DeepSeek HTTP 402: Insufficient Balance (request_id: 36f54446-1111)';
  const s1 = CE.scrub({ found: false, message: leaked, notes: [leaked] });
  ok('Jamond\'s message: replaced with plain words, in message and notes', s1.message === CE.PLAIN && s1.notes[0] === CE.PLAIN && !/DeepSeek|402|request_id/.test(JSON.stringify(s1)));
  ok('  ordinary errors and an athlete named Hunter or Claude are untouched',
    CE.scrub({ error: 'Athlete not found' }).error === 'Athlete not found' && CE.scrub({ error: 'Hunter Smith has no school on file' }).error === 'Hunter Smith has no school on file'
    && CE.scrub({ candidates: [{ name: 'Claude Rivers', notes: 'Claude Rivers plays guard' }] }).candidates[0].notes === 'Claude Rivers plays guard');
  const rep = CE.scrub({ reply: 'I added Maya. The search returned HTTP 429 so her socials are missing. Want her profile?' }).reply;
  ok('  an assistant reply keeps its other sentences; only the leaking one is replaced', /^I added Maya\. Something on our side/.test(rep) && /Want her profile\?$/.test(rep) && !/429/.test(rep), rep);
  ok('  a database error is not shown either', CE.scrub({ error: 'connect ECONNREFUSED 127.0.0.1:5432' }).error === CE.PLAIN);
  // Through Express, on a real port: /api scrubbed and logged, /api/admin not.
  const express = require('express');
  const app = express();
  app.use(CE.middleware);
  app.get('/api/x', (req, res) => res.status(500).json({ error: 'Anthropic HTTP 401: invalid x-api-key' }));
  app.get('/api/admin/x', (req, res) => res.status(500).json({ error: 'Anthropic HTTP 401: invalid x-api-key' }));
  const srv = http.createServer(app).listen(0);
  const port = srv.address().port;
  const logs = []; const ce = console.error; console.error = (...a) => { logs.push(a.join(' ')); };
  const j1 = await (await realFetch(`http://127.0.0.1:${port}/api/x`)).json();
  const j2 = await (await realFetch(`http://127.0.0.1:${port}/api/admin/x`)).json();
  console.error = ce; srv.close();
  ok('every /api JSON response is scrubbed, and the original is logged as [customer-error]', j1.error === CE.PLAIN && logs.some((l) => /\[customer-error\] GET \/api\/x: Anthropic HTTP 401/.test(l)), { j1, logs });
  ok('  /api/admin keeps the provider\'s words (that is where the admin reads them)', /Anthropic HTTP 401/.test(j2.error));
  ok('  mounted before every route, and the two streaming error paths scrub too',
    IDX.indexOf("app.use(require('./services/customerErrors').middleware)") > 0 && IDX.indexOf("app.use(require('./services/customerErrors').middleware)") < IDX.indexOf("app.post('/api/ai/player-lookup'")
    && /customerErrors'\)\.scrub\(\{ error: err\.message \}/.test(IDX) && /customerErrors'\)\.scrub\(\{ error: err\.message \}/.test(src('server/ai.js')));

  // The lookup itself, with the web stage failing exactly as it did.
  const L = require(REPO + 'server/services/athleteLookup.js');
  const clearCache = () => P.query(`DELETE FROM athlete_lookup_cache WHERE cache_key ILIKE '%jamond test%'`).catch(() => {});
  await clearCache();
  global.fetch = async (u) => { throw new Error('offline in the test: ' + u); };
  L._setSearchLoopForTests(async () => { const e = new Error('DeepSeek HTTP 402: Insufficient Balance (request_id: 36f54446-2222)'); e.status = 402; throw e; });
  const lk = await L.resolveAthlete(ai, { name: 'Jamond Test', school: 'Zzyzx Academy', sport: 'Underwater Hockey' }, {});
  L._setSearchLoopForTests(null);
  global.fetch = realFetch;
  ok('the Add Client lookup: plain words and retry:true, with no vendor, code or request id anywhere in the result',
    lk.retry === true && /couldn't finish the search/.test(lk.message || '') && !/DeepSeek|402|request_id|Checked:/i.test(JSON.stringify({ m: lk.message, n: lk.notes, c: lk.candidates })), { message: lk.message, notes: lk.notes, retry: lk.retry });
  ok('  the route sends no trace, and the scrubber knows model markup and parser words',
    /const \{ trace: _trace, \.\.\.forScreen \} = result/.test(IDX) && CE.scrub({ message: 'THE ANSWER COULD NOT BE READ: the answer was not JSON (starts "<|DSML|>calls>")' }).message === CE.PLAIN);
  ok('  the detail is kept for the server (trace), not the screen', (lk.trace || []).some((t) => /DeepSeek HTTP 402/.test(t)) || !lk.trace);
  const H = src('public/index.html');
  ok('  and the screen offers Try again', /data\.retry \? ' <a href="#" onclick="lookupPlayer\(\);return false"/.test(H));

  // ── 5b. TOOL-CALL MARKUP INSTEAD OF AN ANSWER ───────────────────────────
  OUT.push('', '-- an answer written as tool-call markup --');
  const DSML = '<|DSML|>calls> <|DSML|>invoke name="web_search"> <|DSML|>parameter name="q">x';
  const DSm = require(REPO + 'server/services/deepseek.js');
  ok('the detector knows DeepSeek\'s DSML, its older tokens and <tool_call>, and not ordinary JSON',
    DSm.isToolMarkup(DSML) && DSm.isToolMarkup('<｜tool▁calls▁begin｜>') && DSm.isToolMarkup('<tool_call>{}</tool_call>') && !DSm.isToolMarkup('{"athletes":[]}'));
  // A scripted DeepSeek: round 1 asks for a search; every later turn answers
  // with whatever the script says. Serper answers the search.
  process.env.DEEPSEEK_API_KEY = 'test-key'; process.env.SERPER_API_KEY = 'test-serper';
  const script = (answers) => {
    const bodies = []; let turn = 0;
    global.fetch = async (u, init) => {
      if (/serper/.test(u)) return fakeResp(200, { organic: [{ title: 'Roster', link: 'https://example.edu/roster', snippet: 'Jamond Test, guard' }] });
      const b = JSON.parse(init.body); bodies.push(b); turn++;
      if (turn === 1) return fakeResp(200, { model: 'deepseek-v4-flash', choices: [{ message: { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'web_search', arguments: '{"query":"Jamond Test"}' } }] }, finish_reason: 'tool_calls' }], usage: {} });
      return fakeResp(200, { model: 'deepseek-v4-flash', choices: [{ message: { content: answers[Math.min(turn - 2, answers.length - 1)] }, finish_reason: 'stop' }], usage: {} });
    };
    return bodies;
  };
  const WSTm = require(REPO + 'server/services/webSearchTool.js');
  let bodies = script(['{"athletes":[]}']);
  const okRun = await WSTm.searchLoop({ prompt: 'find', maxSearches: 1, maxFetches: 0, ledger: false, provider: WSTm.PROVIDERS.serper });
  const lastBody = bodies[bodies.length - 1];
  ok('the last round keeps the tools defined and forbids them (tool_choice "none"), with a plain "answer now" turn',
    okRun.text === '{"athletes":[]}' && Array.isArray(lastBody.tools) && lastBody.tools.length && lastBody.tool_choice === 'none'
    && /no searches or page fetches left/.test(JSON.stringify(lastBody.messages[lastBody.messages.length - 1])), { tc: lastBody.tool_choice, tools: !!lastBody.tools });
  bodies = script([DSML, '{"athletes":[{"name":"Jamond Test"}]}']);
  const repaired = await WSTm.searchLoop({ prompt: 'find', maxSearches: 1, maxFetches: 0, ledger: false, provider: WSTm.PROVIDERS.serper });
  ok('markup once: one repair turn (tools forbidden) and the real answer comes back', /Jamond Test/.test(repaired.text) && !DSm.isToolMarkup(repaired.text), repaired.text);
  bodies = script([DSML, DSML]);
  let twice = null; try { await WSTm.searchLoop({ prompt: 'find', maxSearches: 1, maxFetches: 0, ledger: false, provider: WSTm.PROVIDERS.serper, ctx: { site: 'lookup.college' } }); } catch (e) { twice = e; }
  await tick();
  const mk = (await rows('deepseek')).find((r) => /tool-call markup/.test(r.reason));
  ok('markup twice: thrown as our fault (so every caller falls back) and recorded, never returned as text',
    twice && OF.isOurFault(twice) && twice.markup && mk, { err: twice && twice.message, mk });
  global.fetch = async () => fakeResp(200, { model: 'deepseek-v4-flash', choices: [{ message: { content: DSML }, finish_reason: 'stop' }], usage: {} });
  let plainErr = null; try { await DSm.chat({ messages: [{ role: 'user', content: 'x' }], ledger: false }); } catch (e) { plainErr = e; }
  ok('a plain DeepSeek call that answers in markup throws (oneShot then falls back to Haiku)', plainErr && plainErr.markup, plainErr && plainErr.message);

  // The lookup, end to end: DeepSeek answers in markup twice; the same lookup
  // runs on Haiku (Anthropic web search) and finds the athlete, cited.
  const AIm = require(REPO + 'server/ai.js');
  const realWSM = AIm.webSearchMessage;
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-anthropic';
  let haikuCalls = 0;
  AIm.webSearchMessage = async () => { haikuCalls++; return {
    stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 },
    content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'Jamond Test' } },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://example.edu/roster', title: 'Roster' }] },
      { type: 'text', text: '{"found":true,"athletes":[{"name":"Jamond Test","school":"Zzyzx Academy","sport":"Underwater Hockey","position":"Guard","sources":{"name":"https://example.edu/roster","school":"https://example.edu/roster","position":"https://example.edu/roster"}}]}' }] }; };
  await clearCache();
  bodies = script([DSML, DSML]);
  const realFetch2 = global.fetch;
  global.fetch = async (u, init) => (/espn|statsapi|nhle|hockeytech/.test(String(u)) ? Promise.reject(new Error('offline')) : realFetch2(u, init));
  const lk2 = await L.resolveAthlete(ai, { name: 'Jamond Test', school: 'Zzyzx Academy', sport: 'Underwater Hockey' }, {});
  AIm.webSearchMessage = realWSM; global.fetch = realFetch;
  ok('the lookup: DeepSeek wrote markup twice, the same lookup ran on Haiku and found the athlete',
    haikuCalls === 1 && lk2.candidates && lk2.candidates.length >= 1 && lk2.candidates[0].name === 'Jamond Test', { haikuCalls, n: (lk2.candidates || []).length, message: lk2.message, notes: lk2.notes });
  ok('  and nothing on the screen carries the markup', !/DSML|invoke name|<\|/.test(JSON.stringify({ m: lk2.message, n: lk2.notes, c: lk2.candidates })));
  ok('  with AI_FAST_PROVIDER=anthropic the lookup searches on Haiku instead of skipping the web',
    /if \(rt\.provider !== 'deepseek' && !_searchLoopOverride && anthropicReady\(\)\)/.test(src('server/services/athleteLookup.js')));
  ok('an answer the lookup could not read is recorded (UNREADABLE ANSWER), not read as "nobody"', /UNREADABLE ANSWER in the athlete lookup/.test(src('server/services/athleteLookup.js')));

  // ── 6. THE SCHOOL HINT ──────────────────────────────────────────────────
  OUT.push('', '-- the school hint --');
  let chromium;
  try { chromium = require(execSync('npm root -g').toString().trim() + '/playwright').chromium; } catch (_) {}
  if (!chromium) ok('playwright is available', false);
  else {
    const start = H.indexOf('    var _schoolFields = {};');
    const end = H.indexOf("    Object.keys(_schoolFields).forEach(function (k) { _guardSchoolHint(_schoolFields[k]); });");
    const block = H.slice(start, end + 100).split('\n').slice(0, -1).join('\n') + "\n    Object.keys(_schoolFields).forEach(function (k) { _guardSchoolHint(_schoolFields[k]); });";
    const b = await chromium.launch();
    const pg = await b.newPage();
    await pg.setContent(`<input id="a_school"><div id="a_school_status"></div><div id="a_school_suggest"></div>
      <input id="ob-athlete-school"><div id="ob-school-status"></div><div id="ob-school-suggest"></div>`);
    await pg.evaluate((code) => {
      window.API_BASE = ''; window.escHtml = (s) => String(s); window.obSchoolOk = null; window.obSchoolMarket = null;
      window.fetch = async () => ({ json: async () => ({ ok: true, status: 'matched', message: 'Local businesses will be found around Tuscaloosa, AL.', market: 'Tuscaloosa, AL' }) });
      (0, eval)(code.replace(/\blet obSchoolMarket[^\n]*\n|\blet obSchoolOk[^\n]*\n/g, ''));
    }, block);
    const hint = () => pg.evaluate(() => document.getElementById('a_school_status').textContent);
    await pg.evaluate(() => { document.getElementById('a_school').value = 'University of Alabama'; return schoolFieldCheck(_schoolFields['a_school'], 'instant'); });
    const h1 = await hint();
    await pg.evaluate(() => { document.getElementById('a_school').value = ''; });   // a reset in code: no event
    const h2 = await hint();
    await pg.evaluate(() => { document.getElementById('a_school').value = 'University of Alabama'; return schoolFieldCheck(_schoolFields['a_school'], 'instant'); });
    await pg.fill('#a_school', 'Univ');                                               // typed over
    const h3 = await hint();
    await b.close();
    ok('a resolved school shows its town', /Tuscaloosa, AL/.test(h1), h1);
    ok('  the field emptied in code (a reset, Add after Edit): the hint goes with it', h2 === '', h2);
    ok('  the field typed over: the old town is gone until the new value resolves', h3 === '', h3);
  }

  await P.query(`DELETE FROM service_faults WHERE at >= $1 AND (service IN ('deepseek','anthropic','serper','pf-test','pf-test2') OR context = 'preflight')`, [since]).catch(() => {});
  await P.query(`DELETE FROM service_checks WHERE checked_at >= $1`, [since]).catch(() => {});
  await P.query(`DELETE FROM service_fault_alerts`).catch(() => {});
  await P.query(`DELETE FROM athlete_lookup_cache WHERE cache_key ILIKE '%jamond test%'`).catch(() => {});
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  global.fetch = realFetch;
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
