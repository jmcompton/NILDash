'use strict';
// Runs against the local test Postgres like the other ai.js suites (ai.js
// requires the store), but makes no network call: the SDK client is a stub.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/dashoptin.js        just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
// Never route to DeepSeek here: the point is to drive oneShot's own return.
delete process.env.DEEPSEEK_API_KEY;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE DASH RULE IS A VOICE RULE, NOT A DATA RULE ──────────────────────────
//
// ai.oneShot replaced every em and en dash in every reply with ", ". That is a
// sensible rule for a pitch -- the model leans on em dashes and they read as
// machine-written -- and a destructive one for a roster, a rate range or a
// school name:
//
//   "2024–25"                       -> "2024, 25"
//   "$500–$1,500"                   -> "$500, $1,500"
//   "Texas A&M University–Commerce" -> "Texas A&M University, Commerce"
//
// It is opt-in now. A caller whose output a person reads as writing passes
// { prose: true }; nothing else is touched. And even in prose a dash between
// two digits is a range, so it becomes a hyphen rather than a comma.
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const ai = require(REPO + 'server/ai.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');

const DATA = '{"athletes":[{"name":"Jo Doe","season":"2024–25","school":"Texas A&M University–Commerce","range":"$500–$1,500"}]}';
const PROSE = 'Jo is a sophomore guard — and she posts every game day. The 2024–25 season is her first.';

function stub(text) {
  return { messages: { create: async (req) => ({ model: req.model, content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 10 } }) } };
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));

  OUT.push('-- extraction comes back exactly as the model wrote it --');
  ai._setClientForTests(stub(DATA));
  const raw = await ai.oneShot('extract', 'sys', 100, 'claude-sonnet-4-6');
  ok('WITHOUT THE FLAG, THE REPLY IS UNTOUCHED', raw === DATA, raw);
  const parsed = JSON.parse(raw).athletes[0];
  ok('  a season range survives', parsed.season === '2024–25', parsed.season);
  ok('  a school name with an en dash survives', parsed.school === 'Texas A&M University–Commerce', parsed.school);
  ok('  a money range survives', parsed.range === '$500–$1,500', parsed.range);

  ai._setClientForTests(stub(DATA));
  const raw2 = await ai.oneShotWebSearch('find', 'sys', 100, 2, 'claude-sonnet-4-6');
  ok('oneShotWebSearch is untouched by default too', raw2 === DATA, raw2);

  OUT.push('', '-- prose opts in, and a range is still a range --');
  ai._setClientForTests(stub(PROSE));
  const p = await ai.oneShot('write', 'sys', 100, 'claude-sonnet-4-6', { prose: true });
  ok('WITH { prose: true } THE EM DASH IS GONE', !/[—–]/.test(p), p);
  ok('  replaced by a comma, as before', /guard, and she posts/.test(p), p);
  ok('  BUT A DASH BETWEEN DIGITS BECOMES A HYPHEN, NOT A COMMA', /The 2024-25 season/.test(p), p);
  ok('stripEmDashes is exported, so the checks below are not vacuous', typeof ai.stripEmDashes === 'function');
  ok('a money range in prose keeps both ends joined',
    ai.stripEmDashes('from $500–$1,500 a month') === 'from $500-$1,500 a month', ai.stripEmDashes('from $500–$1,500 a month'));
  ok('  a spaced range too', ai.stripEmDashes('ages 18 – 22') === 'ages 18-22', ai.stripEmDashes('ages 18 – 22'));
  ok('  and a dash between words still becomes a comma', ai.stripEmDashes('fast — and loud') === 'fast, and loud');
  ok('only the literal true opts in, not a truthy string', await (async () => {
    ai._setClientForTests(stub(PROSE));
    return (await ai.oneShot('w', 's', 100, 'claude-sonnet-4-6', { prose: 'yes' })) === PROSE;
  })());

  OUT.push('', '-- the flag survives the fallback to a larger model --');
  let n = 0;
  ai._setClientForTests({ messages: { create: async (req) => {
    n++;
    if (req.model === ai.MODEL_FAST) { const e = new Error('not found'); e.status = 404; throw e; }
    return { model: req.model, content: [{ type: 'text', text: PROSE }], usage: { input_tokens: 1, output_tokens: 1 } };
  } } });
  const fb = await ai.oneShot('w', 's', 100, ai.MODEL_FAST, { prose: true });
  ok('a Haiku 404 steps up to Sonnet and the reply is still treated as prose', n === 2 && !/—/.test(fb), { n, fb });

  // ── WHO OPTS IN ──────────────────────────────────────────────────────────
  // Pinned per call site, so a new extraction call cannot quietly inherit the
  // rule and a prose call cannot quietly lose it.
  OUT.push('', '-- the writer and the other prose callers opt in; extraction never does --');
  const oq = read('server/jobs/outreachQueue.js');
  ok('THE PITCH WRITER OPTS IN, at both of its call sites',
    (oq.match(/ai\.oneShot\(p2, sys, mt, ai\.MODEL_GEN, \{ prose: true \}\)/g) || []).length === 2);
  const idx = read('server/index.js');
  for (const site of ['university.compliance', 'university.recommendations', 'university.roster']) {
    const chunks = idx.split(`site: '${site}' }`).slice(1).map((c) => c.slice(0, 200));
    ok(`${site} does NOT opt in (${chunks.length} call${chunks.length === 1 ? '' : 's'})`,
      chunks.length > 0 && chunks.every((c) => !/prose/.test(c)), chunks);
  }
  for (const f of ['server/services/university/NILDirectorService.js', 'server/services/university/WebExtractionService.js',
    'server/services/contactDiscovery.js', 'server/services/companyEnrichment.js', 'server/services/staffPage.js',
    'server/services/athleteBrandMatch.js', 'server/services/contractExtraction.js', 'server/jobs/socialDiscovery.js']) {
    ok(`${f.split('/').pop()} never opts in`, !/prose: true/.test(read(f)));
  }
  const aiSrc = read('server/ai.js');
  ok('the discovery scorer does not opt in (its business names are matched back)',
    /oneShot\(buildScorePrompt\(candList\), scoreSys, 3500, MODEL_SCORE\);/.test(aiSrc));
  ok('webSearchJson never strips', !/return \{ text: stripEmDashes\(r\.text\)/.test(aiSrc)
    && !/const text = stripEmDashes\(blocks/.test(aiSrc));

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('dashoptin: FAILED', e); process.exit(1); });
