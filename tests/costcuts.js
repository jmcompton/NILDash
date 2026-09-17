'use strict';
// Runs from a checkout on any machine against the local test Postgres. No
// network: the routing is decided from env keys that point nowhere, the
// claims are rows in the test database, the writer block is a string.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/costcuts.js         just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── THE NIGHT, CHEAPER ───────────────────────────────────────────────────────
//
// 1. Every Haiku call is on DeepSeek, with Serper for the searches: social
//    discovery, company enrichment, the domain and person email searches,
//    labelled or not. The writer never moves.
// 2. A Serper search is priced at $0.001; the DeepSeek rates are named.
// 3. A discovery scan runs at most five times per athlete per night, and a
//    business is researched for an athlete at most once per night.
// 4. The writer is told which athlete fields are blank, and never to mention
//    them, so the fact-check stops sending it back.

// Keys that point nowhere: enough for the routing rule, never called.
process.env.DEEPSEEK_API_KEY = 'sk-ds-test';
process.env.SERPER_API_KEY = 'serper-test';
process.env.BRAVE_SEARCH_API_KEY = 'brave-test';
delete process.env.SEARCH_PROVIDER; delete process.env.DEEPSEEK_SITES; delete process.env.AI_FAST_PROVIDER;

const store = require(REPO + 'server/store.js');
const DS = require(REPO + 'server/services/deepseek.js');
const WST = require(REPO + 'server/services/webSearchTool.js');
const Ledger = require(REPO + 'server/services/aiLedger.js');
const Claims = require(REPO + 'server/services/nightlyClaims.js');
const PW = require(REPO + 'server/services/pitchWriter.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;
const near = (a, b) => Math.abs(a - b) < 1e-9;
const src = (p) => fs.readFileSync(REPO + p, 'utf8');

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));

  // ── 1. EVERY HAIKU CALL ON DEEPSEEK ──────────────────────────────────────
  OUT.push('-- every Haiku call is routed; the writer is not --');
  for (const site of ['social.discovery', 'enrichment', 'contacts.domain', 'contacts.personemail', 'discovery', 'lookup.college', undefined, 'anything-new']) {
    ok(`${site || 'unlabelled'} -> DeepSeek`, DS.route(site, { needsSearch: true }).provider === 'deepseek', DS.route(site, { needsSearch: true }));
  }
  ok('the writer stays on Anthropic, and says so', DS.route('writer').provider === 'anthropic' && /the writer stays on Anthropic/.test(DS.route('writer').reason) && DS.NEVER_ROUTED.includes('writer'));
  process.env.DEEPSEEK_SITES = 'contacts';
  ok('DEEPSEEK_SITES still narrows for a bad night', DS.route('enrichment').provider === 'anthropic' && DS.route('contacts').provider === 'deepseek' && DS.sites().join() === 'contacts');
  delete process.env.DEEPSEEK_SITES;
  ok('  and unset means every fast-tier call', DS.sites() === null);
  ok('the startup line says so', /every Haiku call \(discovery, instagram, contacts, lookup, social, enrichment and unlabelled\), never the writer/.test(DS.describeRouting()) && /web search through serper at \$0\.001 a query/.test(DS.describeRouting()), DS.describeRouting());
  ok('social discovery is labelled and runs on the fast model', /scanMeter\.label\(\{ site: 'social\.discovery', brand: '\[' \+ q \+ '\]' \},\s*\(\) => ai\.oneShotWebSearch\(_searchPrompt\(q, MAX_PER_QUERY\), SEARCH_SYSTEM, 2500, 4, ai\.MODEL_FAST\)\)/.test(src('server/jobs/socialDiscovery.js')));
  ok('company enrichment is labelled, both the search and the fallback', /scanMeter\.label\(\{ site: 'enrichment', brand: brandName \}, fn\)/.test(src('server/services/companyEnrichment.js')) && /labelled\(\(\) => oneShotWebSearch\(researchPrompt, researchSystem, 2500, 3, MODEL_FAST\)\)/.test(src('server/services/companyEnrichment.js')) && /labelled\(\(\) => oneShot\(prompt, system, 2000, MODEL_FAST\)\)/.test(src('server/services/companyEnrichment.js')));
  ok('the domain and person email searches ride the contacts search, which is routed', /webSearch: _contactWebSearchRaw/.test(src('server/ai.js')) && /const rt = DS\.route\(scanMeter\.ctx\(\)\.site, \{ needsSearch: true \}\);\s*if \(rt\.provider === 'deepseek'\) \{\s*scanMeter\.bumpWeb\(\);\s*try \{\s*const r = await WST\.searchLoop\(\{ prompt, system: sys, temperature: 0/.test(src('server/ai.js')));
  ok('the pitch writer was not touched: no deepseek, Sonnet on both writer sites', !/deepseek/i.test(src('server/services/pitchWriter.js')) && (src('server/jobs/outreachQueue.js').match(/site: 'writer'[\s\S]{0,300}?ai\.oneShot\(p2, sys, mt, ai\.MODEL_GEN\)/g) || []).length === 2);

  // ── 2. SERPER, AND WHAT A SEARCH COSTS ───────────────────────────────────
  OUT.push('', '-- Serper first; a Serper search is $0.001 --');
  ok('Serper is preferred over Brave when both keys are set', WST.provider().name === 'serper' && WST.PREFERENCE.join() === 'serper,brave,tavily');
  delete process.env.SERPER_API_KEY;
  ok('  Brave when Serper has no key', WST.provider().name === 'brave' && near(WST.usdPerQuery(), 0.005));
  process.env.SERPER_API_KEY = 'serper-test';
  ok('a Serper search is priced at $0.001, Brave $0.005, Tavily $0.008, Anthropic $0.01', near(Ledger.searchUsd('serper'), 0.001) && near(Ledger.searchUsd('brave'), 0.005) && near(Ledger.searchUsd('tavily'), 0.008) && near(Ledger.searchUsd('anthropic'), 0.01) && near(Ledger.USD_PER_SEARCH.serper, 0.001));
  ok('  the DeepSeek search rate is the active provider\'s (Serper now)', near(Ledger.USD_PER_SEARCH.deepseek, 0.001) && near(WST.usdPerQuery(), 0.001));
  const u = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 3 };
  ok('a searches row on DeepSeek prices three searches at $0.003; the same three on Anthropic $0.03', near(Ledger.estimateUsd('deepseek-v4-flash', u, 'deepseek', 'serper'), 0.003) && near(Ledger.estimateUsd('claude-haiku-4-5', u, 'anthropic'), 0.03));
  ok('  a row that names Brave is priced at Brave', near(Ledger.estimateUsd('deepseek-v4-flash', u, 'deepseek', 'brave'), 0.015));
  ok('the search loop passes the provider that ran the searches to the ledger', /recordUsage\(\{ provider: DS\.PROVIDER, model: o\.model \|\| DS\.model\(\), usage: \{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: searches \}, ms: 0, ctx: o\.ctx, searchProvider: sp\.name \}\)/.test(src('server/services/webSearchTool.js')) && /estimateUsd\(model, usage, provider, info && info\.searchProvider\)/.test(src('server/services/aiLedger.js')));
  ok('the DeepSeek token rates are named and env-overridable, and the breakdown prints them', Array.isArray(Ledger.DEEPSEEK_PRICE) && Ledger.DEEPSEEK_PRICE.length === 3 && /DEEPSEEK_PRICE_IN/.test(src('server/services/aiLedger.js')) && /in \(cache miss\), \$\$\{Ledger\.DEEPSEEK_PRICE\[2\]\} in \(cache hit\), \$\$\{Ledger\.DEEPSEEK_PRICE\[1\]\} out/.test(src('scripts/spend-breakdown.js')) && /Serper \$\{usd\(Ledger\.SEARCH_RATES\.serper\)\}/.test(src('scripts/spend-breakdown.js')));

  // ── 3. THE LOOP STOPS ────────────────────────────────────────────────────
  OUT.push('', '-- five discovery scans per athlete per night; one research per business --');
  const ATH = 'cc-ath-1', NIGHT = '2026-09-17';
  await P().query(`DELETE FROM discovery_nightly WHERE athlete_id LIKE 'cc-ath-%'`).catch(() => {});
  await P().query(`DELETE FROM research_claims WHERE athlete_id LIKE 'cc-ath-%'`).catch(() => {});
  const claims = [];
  for (let i = 0; i < 7; i++) claims.push(await Claims.claimDiscovery(P(), ATH, 'market refill', NIGHT));
  ok('the cap is five', Claims.MAX_DISCOVERY_PER_ATHLETE_NIGHT === 5);
  ok('five market refills are allowed, the sixth and seventh are refused', claims.slice(0, 5).every((c) => c.ok) && !claims[5].ok && !claims[6].ok && claims[6].n === 7, claims.map((c) => [c.ok, c.n]));
  ok('  widen is counted on its own', (await Claims.claimDiscovery(P(), ATH, 'widen', NIGHT)).ok === true);
  ok('  another night starts at zero', (await Claims.claimDiscovery(P(), ATH, 'market refill', '2026-09-18')).n === 1);
  ok('  another athlete too', (await Claims.claimDiscovery(P(), 'cc-ath-2', 'market refill', NIGHT)).n === 1);
  ok('a business is researched once for an athlete tonight', (await Claims.claimResearch(P(), ATH, 'Maxie Bakery', NIGHT)) === true && (await Claims.claimResearch(P(), ATH, 'maxie  bakery', NIGHT)) === false);
  ok('  the same business for another athlete, or tomorrow, is researched', (await Claims.claimResearch(P(), 'cc-ath-2', 'Maxie Bakery', NIGHT)) === true && (await Claims.claimResearch(P(), ATH, 'Maxie Bakery', '2026-09-18')) === true);
  const job = src('server/jobs/outreachQueue.js');
  ok('the job claims a discovery scan before it runs and stops at the cap', /const claim = await Claims\.claimDiscovery\(pool, athleteId, label, ctx\.runDate \|\| today\(\)\);\s*if \(!claim\.ok\) \{[\s\S]*?return null;/.test(job) && job.indexOf('Claims.claimDiscovery(pool, athleteId, label') < job.indexOf("scanMeter.label({ site: 'discovery'"));
  ok('  and claims the research before the lookup on both lanes', (job.match(/if \(!\(await Claims\.claimResearch\(pool, athleteId, cand\.brand_name, ctx\.runDate \|\| today\(\)\)\)\) \{/g) || []).length === 2 && job.indexOf('Claims.claimResearch(pool, athleteId, cand.brand_name') < job.indexOf("say(`looking up ${cand.brand_name}…`)"));
  ok('  the night\'s date reaches the fill from both entry points', (job.match(/athleteName: ath\.name, runDate,/g) || []).length === 2);
  ok('the claims live in their own service, so the queue service stays SQL-free', !/INSERT INTO|UPDATE |DELETE FROM/.test(src('server/services/outreachQueue.js')) && /INSERT INTO discovery_nightly/.test(src('server/services/nightlyClaims.js')));
  ok('the tables exist', /CREATE TABLE IF NOT EXISTS discovery_nightly/.test(src('server/store.js')) && /CREATE TABLE IF NOT EXISTS research_claims/.test(src('server/store.js')));
  ok('the market refill is still once per market per run, and the widen once per athlete, inside the cap', /!refilledMarkets\.has\(profile\.marketKey\)/.test(job) && /!widenedTonight && !ctx\.noWiden/.test(job));

  // ── 4. THE WRITER IS TOLD WHAT IS BLANK ──────────────────────────────────
  OUT.push('', '-- the writer: only the fields we hold, and told which are blank --');
  const full = PW.describeAthlete({ name: 'Ann Lee', sport: 'softball', position: 'SS', year: 'Junior', school: 'Auburn', hometown: 'Hoover, AL' });
  ok('with everything on file: sport, position, class year and hometown are handed over', /Plays: Junior shortstop softball at Auburn/.test(full) && /class year: say "Junior" or nothing/.test(full) && /From: Hoover, AL/.test(full) && !/not on file/.test(full), full);
  const bare = PW.describeAthlete({ name: 'Ann Lee', school: 'Auburn' });
  ok('with nothing on file: each blank is named as blank, with the instruction', /no position on file: do not name, guess or imply one/.test(bare) && /no sport on file: do not name one/.test(bare) && /no class year on file: do not call them a freshman, sophomore, junior, senior or graduate/.test(bare) && /From: not on file\. Do not say where they are from/.test(bare), bare);
  const some = PW.describeAthlete({ name: 'Ann Lee', sport: 'softball', school: 'Auburn' });
  ok('  a held sport is named and the rest are blank', /Plays: softball at Auburn/.test(some) && /sport: say "softball"/.test(some) && /no position on file/.test(some) && /no class year on file/.test(some) && /From: not on file/.test(some), some);
  ok('  no school and nothing else still says so', /Plays: nothing on file/.test(PW.describeAthlete({ name: 'X' })));
  const pro = PW.describeAthlete({ name: 'Bo Nix', athleteType: 'pro', team: 'Denver Broncos', position: 'QB', sport: 'football' });
  ok('a pro is never told about a class year, and a blank hometown is still named', !/class year on file/.test(pro) && /From: not on file/.test(pro) && /Never call them a student-athlete/.test(pro), pro);
  ok('the shared rules say a "not on file" line means never mention the field', /A LINE THAT SAYS "not on file" IS AN INSTRUCTION, NOT A GAP\. Never mention that field at all/.test(src('server/services/pitchWriter.js')));
  ok('the fact-check still refuses each invented field (the retry that this cuts)', PW.verifyAthleteFacts('Ann Lee is a junior shortstop from Hoover.', { name: 'Ann Lee', school: 'Auburn' }).ok === false);
  ok('spend-breakdown reports the retry rate against the 10% target', /WRITER RETRIES: \$\{retried\} of \$\{pitches\} pitch\(es\) written twice/.test(src('scripts/spend-breakdown.js')) && /target under 10%/.test(src('scripts/spend-breakdown.js')));

  await P().query(`DELETE FROM discovery_nightly WHERE athlete_id LIKE 'cc-ath-%'`).catch(() => {});
  await P().query(`DELETE FROM research_claims WHERE athlete_id LIKE 'cc-ath-%'`).catch(() => {});
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
