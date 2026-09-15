'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/aicost.js         just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── "BREAK DOWN LAST NIGHT'S API SPEND BY CALL SITE" ─────────────────────────
//
// It could not be done. The meter counted calls and priced them at a flat
// rate, and no row anywhere said which model answered, how many tokens it
// read and wrote, or which call site asked. The console knows dollars by
// model; the run row knows lookups by lane; neither knows the writer at all.
//
// Now every call through the entry points in ai.js writes one ledger row --
// site, model, tokens, searches, agent, athlete, brand, an estimate from
// list prices -- and the site comes from a label the caller put on the meter.
// This suite drives the entry points with a stub SDK client and reads the
// rows back.

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const ai = require(REPO + 'server/ai.js');
const meter = require(REPO + 'server/scanMeter.js');
const Ledger = require(REPO + 'server/services/aiLedger.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;
const src = (p) => fs.readFileSync(REPO + p, 'utf8');
const near = (a, b) => Math.abs(a - b) < 1e-6;

// A stub SDK client: answers every create() with a fixed usage block.
function stubClient(usage, blocks) {
  return { messages: { create: async (req) => ({
    model: req.model,
    content: blocks || [{ type: 'text', text: '{"ok":true}' }],
    usage,
  }) } };
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  await P().query(`DELETE FROM ai_call_ledger WHERE agent_id LIKE 'ledger-test%' OR site LIKE 'ledger-test%'`);

  // ── 1. THE LABEL ─────────────────────────────────────────────────────────
  OUT.push('-- the meter carries who is asking, and counters stay on the root --');
  ok('outside any label the context is empty', JSON.stringify(meter.ctx()) === '{}', meter.ctx());
  const r1 = await meter.run(async () => {
    return meter.label({ site: 'contacts', agentId: 'ag', athleteId: 'ath', brand: 'Maxie' }, async () => {
      meter.bumpWeb();
      const inner = await meter.label({ site: 'contacts.chamber' }, async () => { meter.bumpWeb(); meter.bumpAi(); return meter.ctx(); });
      return { outer: meter.ctx(), inner, seenHere: meter.current().webSearches };
    });
  });
  ok('a label attaches site, agent, athlete and brand', r1.result.outer.site === 'contacts' && r1.result.outer.agentId === 'ag' && r1.result.outer.brand === 'Maxie', r1.result.outer);
  ok('  a nested label overrides the site and inherits the rest', r1.result.inner.site === 'contacts.chamber' && r1.result.inner.athleteId === 'ath', r1.result.inner);
  ok('  BUMPS INSIDE LABELS LAND ON THE ROOT METER', r1.meter.webSearches === 2 && r1.meter.aiCalls === 1, r1.meter);
  ok('  and are readable from inside the label', r1.result.seenHere === 2, r1.result.seenHere);

  // ── 2. THE PRICE ─────────────────────────────────────────────────────────
  OUT.push('', '-- the estimate is arithmetic on list prices, and says when it cannot price --');
  const u = { inputTokens: 2500, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 };
  ok('a Sonnet pitch-sized call prices at $0.0135', near(Ledger.estimateUsd('claude-sonnet-4-6', u), 0.0135), Ledger.estimateUsd('claude-sonnet-4-6', u));
  ok('  the same call on Haiku prices at $0.0045', near(Ledger.estimateUsd('claude-haiku-4-5-20251001', u), 0.0045), Ledger.estimateUsd('claude-haiku-4-5-20251001', u));
  ok('  two web searches add $0.02', near(Ledger.estimateUsd('claude-haiku-4-5-20251001', { ...u, webSearches: 2 }), 0.0245));
  ok('  an unknown model is null, never zero', Ledger.estimateUsd('claude-mystery-9', u) === null);
  const usage = Ledger.usageOf({ usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 3 } }, content: [] });
  ok('usage reads the web-search count from server_tool_use', usage.webSearches === 3 && usage.inputTokens === 10, usage);
  ok('  and from the result blocks when the header is absent',
    Ledger.usageOf({ usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'web_search_tool_result' }, { type: 'web_search_tool_result' }] }).webSearches === 2);
  ok('  a missing usage block is zeros, not NaN', Ledger.usageOf({}).inputTokens === 0 && Ledger.estimateUsd('claude-haiku-4-5', Ledger.usageOf({})) === 0);

  // ── 3. THE ROWS ──────────────────────────────────────────────────────────
  OUT.push('', '-- every entry point writes a row that says who asked --');
  ai._setClientForTests(stubClient({ input_tokens: 2500, output_tokens: 400 }));
  await meter.label({ site: 'ledger-test.writer', agentId: 'ledger-test-ag', athleteId: 'ledger-test-ath', brand: 'Maxie Pizza' },
    () => ai.oneShot('write', 'sys', 900, 'claude-sonnet-4-6'));
  ai._setClientForTests(stubClient({ input_tokens: 1200, output_tokens: 300, server_tool_use: { web_search_requests: 2 } },
    [{ type: 'web_search_tool_result' }, { type: 'web_search_tool_result' }, { type: 'text', text: '{"contacts":[]}' }]));
  await meter.label({ site: 'ledger-test.contacts', agentId: 'ledger-test-ag', athleteId: 'ledger-test-ath', brand: 'Maxie Pizza' },
    () => ai.oneShotWebSearch('find', 'sys', 900, 2, 'claude-haiku-4-5-20251001'));
  await meter.label({ site: 'ledger-test.contacts.chamber', agentId: 'ledger-test-ag', athleteId: 'ledger-test-ath', brand: 'Maxie Pizza' },
    () => ai.webSearchJson('find', 'sys'));
  ai._setClientForTests(stubClient({ input_tokens: 100, output_tokens: 10 }));
  await ai.oneShot('unlabelled call', 'sys', 100, 'claude-sonnet-4-6');
  await Ledger.drain();
  const rows = (await P().query(
    `SELECT site, model, agent_id, athlete_id, brand, input_tokens, output_tokens, web_searches, est_usd::float AS est_usd
       FROM ai_call_ledger WHERE agent_id = 'ledger-test-ag' ORDER BY id`)).rows;
  ok('three labelled calls wrote three rows', rows.length === 3, rows.length);
  const w = rows[0], c = rows[1], ch = rows[2];
  ok('the writer row carries site, model, tokens, agent, athlete and brand',
    w && w.site === 'ledger-test.writer' && /sonnet-4-6/.test(w.model) && w.input_tokens === 2500 && w.output_tokens === 400
    && w.agent_id === 'ledger-test-ag' && w.athlete_id === 'ledger-test-ath' && w.brand === 'Maxie Pizza', w);
  ok('  priced at Sonnet rates', w && near(w.est_usd, 0.0135), w && w.est_usd);
  ok('the web-search row counts the searches it ran and prices them', c && c.web_searches === 2 && near(c.est_usd, 0.0012 + 0.0015 + 0.02), c);
  ok('  on the model that was asked for, not the default', c && /haiku/.test(c.model), c && c.model);
  ok('the raw contact search (the ladder\'s own entry point) is on the ledger too, under its source label',
    ch && ch.site === 'ledger-test.contacts.chamber' && /haiku/.test(ch.model) && ch.web_searches === 2, ch);
  const unl = (await P().query(`SELECT site, agent_id FROM ai_call_ledger WHERE site = 'unlabelled' ORDER BY id DESC LIMIT 1`)).rows[0];
  ok('a call with no label is still written, as "unlabelled" with no agent', unl && unl.agent_id === null, unl);
  await P().query(`DELETE FROM ai_call_ledger WHERE site = 'unlabelled' AND agent_id IS NULL AND input_tokens = 100`);

  // A failing ledger must not fail the call.
  Ledger.usePool(() => ({ query: async () => { throw new Error('ledger db on fire'); } }));
  ai._setClientForTests(stubClient({ input_tokens: 1, output_tokens: 1 }));
  let text = null, threw = null;
  try { text = await meter.label({ site: 'ledger-test.fail' }, () => ai.oneShot('x', 'y', 10, 'claude-sonnet-4-6')); } catch (e) { threw = e.message; }
  await Ledger.drain();
  ok('A LEDGER WRITE THAT FAILS NEVER FAILS THE CALL', threw === null && /ok/.test(text), { threw, text });
  Ledger.usePool(() => P());

  // ── 4. THE CALL SITES ARE LABELLED ───────────────────────────────────────
  OUT.push('', '-- the nightly job labels every site it spends on --');
  const job = src('server/jobs/outreachQueue.js');
  for (const site of ['discovery', 'instagram', 'contacts', 'writer']) {
    const n = (job.match(new RegExp(`site: '${site}', agentId, athleteId, brand`, 'g')) || []).length;
    ok(`  '${site}' is labelled with agent, athlete and brand` + (site === 'writer' ? ' at both writer sites' : ''), site === 'writer' ? n === 2 : n === 1, n);
  }
  const aiSrc = src('server/ai.js');
  ok('each contact source runs under its own sub-label', /scanMeter\.label\(\{ site: _parentSite \+ '\.' \+ src \}, \(\) => runOneRaw\(src\)\)/.test(aiSrc));
  ok('  and the Instagram lookup inside the ladder is labelled as the ladder\'s', /site: \(scanMeter\.ctx\(\)\.site \|\| 'contacts'\) \+ '\.instagram'/.test(aiSrc));
  ok('the Deal Scan click path is labelled by lane', /site: 'dealscan\.' \+ validLane, agentId: req\.session\.userId, athleteId/.test(src('server/index.js')));
  ok('the four entry points record: oneShot, the tool loop, oneShotWebSearch, the raw contact search', (aiSrc.match(/Ledger\.record\(msg, /g) || []).length === 4);
  const sc = src('scripts/spend-breakdown.js');
  ok('the breakdown reads the ledger per site, agent and athlete', /BY CALL SITE/.test(sc) && /BY AGENT/.test(sc) && /PER AGENT, PER ATHLETE, PER SITE/.test(sc));
  ok('  prints the prices it assumed', /Prices assumed/.test(sc) && /Ledger\.PRICES/.test(sc));
  ok('  falls back to the run rows and says the writer is missing from them', /writer NOT included/.test(sc) && /outreach_queue_runs/.test(sc));
  ok('  tells the three run-row entry shapes apart the way the job writes them', /x\.lane === 'discovery'/.test(sc) && /x\.lane && x\.lane !== 'discovery'/.test(sc) && /!x\.lane/.test(sc));
  ok('  lists repeats of the same site, brand and athlete', /SAME SITE, SAME BRAND, SAME ATHLETE/.test(sc));
  ok('  connects through server/store and starts with exit code 1', /require\('\.\.\/server\/store'\)/.test(sc) && /process\.exitCode = 1/.test(sc));
  ok('the table is created at init', /CREATE TABLE IF NOT EXISTS ai_call_ledger/.test(src('server/store.js')));

  // ── 5. EXTRACTION RUNS ON THE FAST MODEL; THE WRITER DOES NOT ─────────────
  OUT.push('', '-- contact discovery, company enrichment and the lookup are on Haiku; the writer stays on Sonnet --');
  const cd = src('server/services/contactDiscovery.js'), ce = src('server/services/companyEnrichment.js'), al = src('server/services/athleteLookup.js');
  ok('contact discovery: both the search and the fallback are on MODEL_FAST', /oneShotWebSearch\(prompt, system, 3000, 4, MODEL_FAST\)/.test(cd) && /oneShot\(prompt, system, 2500, MODEL_FAST\)/.test(cd) && !/sonnet/.test(cd));
  ok('company enrichment: both on MODEL_FAST', /oneShotWebSearch\(researchPrompt, researchSystem, 2500, 3, MODEL_FAST\)/.test(ce) && /oneShot\(prompt, system, 2000, MODEL_FAST\)/.test(ce) && !/sonnet/.test(ce));
  ok('the athlete lookup: both stages on the Haiku default, overridable by env', /const LOOKUP_MODEL = process\.env\.LOOKUP_MODEL \|\| 'claude-haiku-4-5-20251001';/.test(al) && (al.match(/model: LOOKUP_MODEL,\s*max_tokens/g) || []).length === 2 && !/model: 'claude-sonnet/.test(al));
  ok('  and its direct client calls are on the ledger too', /site: 'lookup\.college'/.test(al) && /site: 'lookup\.pro'/.test(al));
  const jobSrc = src('server/jobs/outreachQueue.js');
  ok('THE WRITER IS UNTOUCHED: still MODEL_GEN at both sites', (jobSrc.match(/ai\.oneShot\(p2, sys, mt, ai\.MODEL_GEN\)/g) || []).length === 2 && /const MODEL_GEN = MODEL_BALANCED;/.test(aiSrc) && /const MODEL_BALANCED = 'claude-sonnet-4-6';/.test(aiSrc));

  // ── 6. THE WRITER RETRY IS COUNTED ───────────────────────────────────────
  OUT.push('', '-- a lint refusal is recorded, so how often the second call fires is a count --');
  const PW = require(REPO + 'server/services/pitchWriter.js');
  const calls = [];
  const bad = '{"angle":"a","angleKey":"a","ask":"b","confidence":"strong","message":"I hope this finds you well. Pat Surtain, cornerback for the Denver Broncos, posts training. Would you like to learn more?\\n\\nChad"}';
  const good = '{"angle":"a","angleKey":"a","ask":"b","confidence":"strong","message":"Pat Surtain, cornerback for the Denver Broncos, is looking at partners in Denver this season. He posts training and game days. He is building out his endorsement partnerships for this year. Would you like to learn more about this endorsement opportunity with Pat?\\n\\nChad"}';
  const athlete = { name: 'Pat Surtain', athleteType: 'pro', position: 'Cornerback', sport: 'football', team: 'Denver Broncos', city: 'Denver, CO' };
  const biz = { name: 'Mile High Coffee', category: 'coffee' };
  const p1 = await PW.writePitch({ athlete, business: biz, agentFirstName: 'Chad', channel: 'email' },
    { oneShot: async () => { calls.push(1); return calls.length === 1 ? bad : good; } });
  ok('a first draft that fails the lint is retried once', calls.length === 2 && p1.skipped === false, { calls: calls.length, p1 });
  ok('  and the result SAYS it was retried, with the first problems', p1.retried === true && Array.isArray(p1.firstProblems) && p1.firstProblems.length > 0, p1.firstProblems);
  calls.length = 0;
  const p2 = await PW.writePitch({ athlete, business: biz, agentFirstName: 'Chad', channel: 'email' }, { oneShot: async () => { calls.push(1); return good; } });
  ok('a clean first draft is one call and says retried: false', calls.length === 1 && p2.retried === false && p2.firstProblems === null, { calls: calls.length, p2 });
  calls.length = 0;
  const p3 = await PW.writePitch({ athlete, business: biz, agentFirstName: 'Chad', channel: 'email' }, { oneShot: async () => { calls.push(1); return bad; } });
  ok('a draft refused twice is skipped, after exactly two calls, and says so', calls.length === 2 && p3.skipped === true && p3.retried === true && /could not write it in voice/.test(p3.reason), { calls: calls.length, p3 });
  ok('the job records the flag on every attempt that reached the writer (four attempt sites, plus the slot-taken record)', (jobSrc.match(/writerRetried/g) || []).length === 5);
  ok('  and the breakdown counts it, with the lower bound for nights before the flag', /writer retries: /.test(src('scripts/spend-breakdown.js')) && /refused twice, which is the lower bound/.test(src('scripts/spend-breakdown.js')));

  await P().query(`DELETE FROM ai_call_ledger WHERE agent_id LIKE 'ledger-test%' OR site LIKE 'ledger-test%'`);
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
