'use strict';
// Runs from a checkout on any machine: no database, no network, no key.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/directcalls.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';

// ── EVERY MODEL CALL LANDS IN THE COST LEDGER ───────────────────────────────
//
// Eight calls built their own Anthropic client and called messages.create
// directly, skipping ai.oneShot -- which is where the ledger row is written.
// Four of them were Opus. None appeared in spend-breakdown, so the spend the
// ledger reported was a floor, not a total.
//
// Six are plain text in, text out, and now go through ai.oneShot under a site
// label, on the same model and token limit as before. Two cannot:
//
//   contractExtraction.extractText   sends the PDF itself as a document block;
//                                    oneShot sends text only
//   nilCompJob                       uses Anthropic's server-side web_search
//                                    tool; oneShotWebSearch would move it to
//                                    DeepSeek + Serper, a change of provider
//
// Those two record their own ledger row from the response.
const fs = require('fs');
const Module = require('module');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');

function walk(d, out = []) {
  for (const f of fs.readdirSync(REPO + d)) {
    const p = d + '/' + f;
    if (/node_modules/.test(p)) continue;
    const st = fs.statSync(REPO + p);
    if (st.isDirectory()) walk(p, out); else if (f.endsWith('.js')) out.push(p);
  }
  return out;
}

(async () => {
  // ── 1. THE ONLY DIRECT CALLS LEFT ARE THE TWO THAT RECORD THEMSELVES ────
  OUT.push('-- no model call bypasses the ledger --');
  const direct = [];
  for (const f of walk('server')) {
    if (f === 'server/ai.js') continue;          // oneShot and friends live here
    read(f).split('\n').forEach((l, i) => {
      if (/messages\.create\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)) direct.push(f + ':' + (i + 1));
    });
  }
  const files = [...new Set(direct.map((d) => d.split(':')[0]))].sort();
  ok('EXACTLY TWO FILES STILL CALL messages.create DIRECTLY', JSON.stringify(files)
    === JSON.stringify(['server/nilCompJob.js', 'server/services/contractExtraction.js']), direct);
  const ce = read('server/services/contractExtraction.js');
  ok('  the PDF call records its own ledger row, labelled',
    /require\('\.\/aiLedger'\)\.record\(resp, \{ model: 'claude-opus-4-8', ms: Date\.now\(\) - _t0, site: 'contract\.pdf' \}\)/.test(ce));
  const nc = read('server/nilCompJob.js');
  ok('  the comp scrape records its own ledger row, labelled',
    /Ledger\.record\(response,\s*\{ model: 'claude-haiku-4-5-20251001', ms: Date\.now\(\) - _t0, site: 'nilcomps' \}\)/.test(nc));
  ok('  and stays on Anthropic\'s web_search tool rather than being moved to another provider',
    /type: 'web_search_20250305'/.test(nc)
    && !/oneShotWebSearch\(/.test(nc.replace(/^\s*\/\/.*$/gm, '')));

  // ── 2. THE COMP JOB ACTUALLY WRITES THE ROW ─────────────────────────────
  // It runs as its own process and never loads ai.js, which is the only place
  // the ledger was given a pool -- so its rows queued and were dropped at exit.
  OUT.push('', '-- the standalone job flushes before it exits --');
  ok('the job hands the ledger its pool', /Ledger\.usePool\(pool\);/.test(nc));
  const beforeExit = nc.slice(0, nc.indexOf('process.exit(0)'));
  ok('  and drains it before a clean exit', /await Ledger\.drain\(\);\s*process\.exit\(0\)/.test(nc), beforeExit.slice(-160));
  ok('  and before a failed one', /await Ledger\.drain\(\)\.catch\(\(\) => \{\}\);\s*process\.exit\(1\)/.test(nc));

  // ── 3. THE SIX GO THROUGH ai.oneShot ON THE SAME MODEL ──────────────────
  OUT.push('', '-- the six text calls route through oneShot, model unchanged --');
  const idx = read('server/index.js');
  const cases = [
    ['university.compliance', "userPrompt, systemPrompt, 1024, 'claude-sonnet-4-6'", idx],
    ['university.recommendations', "userPrompt, systemPrompt, 1500, 'claude-sonnet-4-6'", idx],
    ['university.roster', "systemPrompt, 4096, 'claude-sonnet-4-6'", idx],
    ['university.roster', "prompt, null, 4096, 'claude-opus-4-8'", idx],
    ['university.insights', "prompt, null, 2048, 'claude-opus-4-8'", read('server/services/university/NILDirectorService.js')],
    ['university.webextract', "prompt, null, 4096, 'claude-opus-4-8'", read('server/services/university/WebExtractionService.js')],
  ];
  for (const [site, args, text] of cases) {
    const re = new RegExp(`site: '${site.replace('.', '\\.')}' \\},[\\s\\S]{0,120}?oneShot\\([^)]*${args.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    ok(`${site}: oneShot(${args})`, re.test(text));
  }
  ok('no dead Anthropic client is left behind in index.js', !/new Anthropic\(\)/.test(idx));

  // ── 4. BEHAVIOUR, NOT JUST SOURCE: the label reaches the ledger ─────────
  // WebExtractionService is driven for real with ai.oneShot stubbed. The stub
  // reads the meter context at call time -- the same thing Ledger.record reads
  // inside the real oneShot -- so this proves the row would carry the site.
  OUT.push('', '-- the call runs labelled, on the model it always used --');
  const aiPath = require.resolve(REPO + 'server/ai.js');
  const meter = require(REPO + 'server/scanMeter.js');
  const seen = [];
  require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
    getClient: () => ({}),
    oneShot: async (prompt, system, maxTokens, model) => {
      seen.push({ site: (meter.ctx() || {}).site, model, maxTokens, system });
      return '{"athletes":[{"name":"Jo Doe","sport":"football"}],"note":null}';
    },
  } };
  // extractAthletesWithClaude is private; reach it the way the other suites
  // reach module-private functions, by compiling the module with an export.
  const src = read('server/services/university/WebExtractionService.js');
  const m = new Module(REPO + 'server/services/university/WebExtractionService.js', null);
  m.filename = REPO + 'server/services/university/WebExtractionService.js';
  m.paths = Module._nodeModulePaths(_tp.dirname(m.filename));
  m._compile(src + '\nmodule.exports.__x = extractAthletesWithClaude;', m.filename);
  const res = await m.exports.__x('x'.repeat(200) + ' roster page text', { school: 'Test U', sport: 'football' });
  ok('the extraction still returns what the model said', Array.isArray(res.athletes) && res.athletes.length === 1, res);
  ok('THE CALL CARRIES ITS SITE LABEL', seen[0] && seen[0].site === 'university.webextract', seen[0]);
  ok('  on the same model and token limit as before', seen[0] && seen[0].model === 'claude-opus-4-8' && seen[0].maxTokens === 4096, seen[0]);

  // ── 5. THE LEDGER PRICES WHAT THE TWO EXPLICIT RECORDS HAND IT ─────────
  OUT.push('', '-- an explicitly recorded response is priced, searches included --');
  const L = require(REPO + 'server/services/aiLedger.js');
  const row = L.record({ model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: '[]' }],
    usage: { input_tokens: 1000, output_tokens: 500, server_tool_use: { web_search_requests: 2 } } },
  { model: 'claude-haiku-4-5-20251001', ms: 10, site: 'nilcomps' });
  ok('the row is filed under its site', row && row.site === 'nilcomps', row && row.site);
  ok('  with the searches Anthropic ran', row && row.webSearches === 2, row && row.webSearches);
  ok('  and a price that includes them', row && row.estUsd > 0.02, row && row.estUsd);
  const pdf = L.record({ model: 'claude-opus-4-8', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 20000, output_tokens: 3000 } },
    { model: 'claude-opus-4-8', ms: 10, site: 'contract.pdf' });
  ok('a PDF scan is priced at Opus rates', pdf && pdf.site === 'contract.pdf' && pdf.estUsd > 0.1, pdf && pdf.estUsd);

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('directcalls: FAILED', e); process.exit(1); });
