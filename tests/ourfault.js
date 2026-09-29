'use strict';
// Runs against the local test Postgres. No network: every provider is a stub.
//
//   node tests/run.js           every suite, against the committed baseline
//   node tests/ourfault.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE RULE (services/ourFault) ────────────────────────────────────────────
// A failure on our side is never recorded as a fact about their market, is
// never cached, and never counts toward a pause. This suite covers the CACHE
// half: no negative is kept unless it was confirmed.
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const OF = require(REPO + 'server/services/ourFault.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 400) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const rowFor = async (lane, key) => (await P.query(
    `SELECT outcome FROM brand_evidence_cache WHERE lane = $1 AND brand_key = $2`, [lane, String(key).toLowerCase()])).rows[0] || null;
  const clean = () => P.query(`DELETE FROM brand_evidence_cache WHERE brand_key LIKE 'oftest%' OR brand LIKE 'OFTest%'`).catch(() => {});
  await clean();

  // ── 1. THE GATE ───────────────────────────────────────────────────────────
  OUT.push('-- the cache gate --');
  const C = OF.cacheable;
  ok('an error outcome is never cacheable', ['ERROR', 'TIMEOUT', 'HTTP_429', 'HTTP_401', 'HTTP_ERR', 'NO_KEY', 'RATE_LIMITED'].every((o) => !C(o, {}, { confirmed: true }).ok));
  ok('  nor evidence carrying an OurFault', !C('OK', OF.fault('x', 'y'), { confirmed: true }).ok);
  ok('an unconfirmed negative is refused', !C('NONE', {}).ok && !C('NO_EVIDENCE', {}).ok && !C('OK', { found: false }).ok && !C('unknown', {}).ok);
  ok('  a confirmed negative is kept', C('NONE', {}, { confirmed: true }).ok && C('OK', { found: false }, { confirmed: true }).ok);
  ok('  a positive needs no confirmation', C('OK', { found: true }).ok && C('FORM', {}).ok && C('open-program', {}).ok);
  await store.saveBrandEvidence('oftest-a', 'contacts', 'OFTest A', null, { contacts: [] }, 'NONE');
  await store.saveBrandEvidence('oftest-b', 'contacts', 'OFTest B', null, { contacts: [] }, 'NONE', { confirmed: true });
  await store.saveBrandEvidence('oftest-c', 'hunter', 'OFTest C', null, { found: false }, 'HTTP_429', { confirmed: true });
  ok('saveBrandEvidence enforces it: unconfirmed NONE not written, confirmed NONE written, HTTP_429 never',
    !(await rowFor('contacts', 'oftest-a')) && (await rowFor('contacts', 'oftest-b')) && !(await rowFor('hunter', 'oftest-c')));

  // ── 2. EVERY NEGATIVE WRITE SAYS WHETHER IT WAS CONFIRMED ─────────────────
  // The rule for new code: a saveBrandEvidence call that can write a negative
  // must pass { confirmed }. Found by reading every call in server/.
  OUT.push('', '-- every negative write is confirmed or refused --');
  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = _tp.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js')) files.push(p);
  } })(REPO + 'server');
  const bad = [];
  for (const f of files) {
    const src = strip(fs.readFileSync(f, 'utf8'));
    let i = 0;
    while ((i = src.indexOf('saveBrandEvidence(', i)) !== -1) {
      if (/function\s+$/.test(src.slice(Math.max(0, i - 20), i))) { i++; continue; }
      let depth = 0, j = i + 'saveBrandEvidence'.length;
      for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; }
      const call = src.slice(i, j + 1);
      const negative = /'NONE'|'NO_EVIDENCE'|found:\s*false|programState|OUTCOME\.NONE|, outcome\b|, oc\b/.test(call);
      if (negative && !/confirmed/.test(call)) bad.push(f.replace(REPO, '') + ': ' + call.replace(/\s+/g, ' ').slice(0, 120));
      i = j;
    }
  }
  ok('no call can write a negative without saying whether it was confirmed', bad.length === 0, bad);

  // ── 3. THE SEARCH LAYER THROWS INSTEAD OF "FOUND NOTHING" ─────────────────
  OUT.push('', '-- search failures are thrown, not summarised --');
  const DS = require(REPO + 'server/services/deepseek.js');
  const WST = require(REPO + 'server/services/webSearchTool.js');
  const realChat = DS.chat;
  DS.chat = async () => ({ text: '', toolCalls: [{ id: 't1', function: { name: 'web_search', arguments: '{"query":"owner of X"}' } }],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, ms: 1 });
  let thrown = null;
  try {
    await WST.searchLoop({ prompt: 'x', provider: { name: 'serper', search: async () => { throw new Error('HTTP 403: {"message":"Unauthorized"}'); } }, ledger: false });
  } catch (e) { thrown = e; }
  DS.chat = realChat;
  ok('a search provider 403 throws an OurFault carrying the provider\'s words', OF.isOurFault(thrown)
    && thrown.service === 'search:serper' && /HTTP 403/.test(thrown.message), thrown && thrown.message);
  const ai = require(REPO + 'server/ai.js');
  const errBlock = { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' } };
  const okBlock = { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://x.test' }] };
  const capBlock = { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } };
  const wf = ai._webSearchFault([errBlock, { type: 'text', text: '[]' }], 'test');
  ok('an Anthropic web search error inside a 200 is an OurFault', OF.isOurFault(wf) && /too_many_requests/.test(wf.message), wf && wf.message);
  ok('  a successful search is not, and neither is our own max_uses cap', ai._webSearchFault([okBlock]) === null && ai._webSearchFault([okBlock, capBlock]) === null);
  const AIsrc = strip(read('server/ai.js'));
  ok('  both Anthropic search paths check it', (AIsrc.match(/_webSearchFault\((msg\.content|blocks), '/g) || []).length === 2);

  // ── 4. EACH LOOKUP KEEPS ONLY CONFIRMED NEGATIVES ─────────────────────────
  OUT.push('', '-- each lookup --');
  const ONS = require(REPO + 'server/services/ownerNameSearch.js');
  let onsErr = null;
  try { await ONS.findOwnerName({ brand: 'OFTest Diner', city: 'Cypress', search: async () => { throw new Error('search:serper: HTTP 429'); } }); }
  catch (e) { onsErr = e; }
  ok('owner name: every search failing throws (never "no name found")', OF.isOurFault(onsErr), onsErr && onsErr.message);
  const onsNone = await ONS.findOwnerName({ brand: 'OFTest Diner', city: 'Cypress', search: async () => ({ text: '{}' }) });
  ok('  searches that answered with nobody return null, a real miss', onsNone === null);

  const IG = require(REPO + 'server/services/instagramLookup.js');
  await IG.findInstagram(null, { brand: 'OFTest Bakery', loc: 'Cypress, CA', webSearch: async () => { throw new Error('HTTP 500'); } });
  let igRows = (await P.query(`SELECT outcome FROM brand_evidence_cache WHERE lane = 'instagram' AND brand = 'OFTest Bakery'`)).rows;
  ok('instagram: a failed search caches nothing', igRows.length === 0, igRows);
  await IG.findInstagram(null, { brand: 'OFTest Bakery', loc: 'Cypress, CA', webSearch: async () => ({ text: '{"handle":null}', citations: [] }) });
  igRows = (await P.query(`SELECT outcome FROM brand_evidence_cache WHERE lane = 'instagram' AND brand = 'OFTest Bakery'`)).rows;
  ok('  a search that answered "no handle" is a confirmed negative, kept', igRows.length === 1 && igRows[0].outcome === 'NONE', igRows);
  const IGsrc = strip(read('server/services/instagramLookup.js'));
  ok('  and a site we could not fetch leaves the negative unconfirmed', /const confirmed = !siteFailed && !!canSearch;/.test(IGsrc));

  const SE = strip(read('server/services/siteEmail.js'));
  ok('site email: only fetched-empty is a confirmed negative (fetch-failed, js-rendered are not)', /\{ confirmed: out\.outcomeKind === 'fetched-empty' \}/.test(SE));

  // Hunter: a 429 is a fault, not "no match"; nothing cached; the breaker stops the hammering.
  const H = require(REPO + 'server/services/hunterLookup.js');
  const realFetch = global.fetch;
  process.env.HUNTER_API_KEY = 'test-hunter-key';
  let hCalls = 0;
  global.fetch = async () => { hCalls++; return { ok: false, status: 429, json: async () => ({ errors: [{ details: 'You have reached your monthly quota' }] }) }; };
  const h1 = await H.findDomainEmails('oftest-shop.test', { withPattern: true, force: true });
  const h2 = await H.findDomainEmails('oftest-other.test', { withPattern: true, force: true });
  const h3 = await H.findDomainEmails('oftest-third.test', { force: true });
  global.fetch = realFetch;
  delete process.env.HUNTER_API_KEY;
  ok('hunter: a 429 comes back as a fault with Hunter\'s words, not "no match"', h1 && h1.fault && h1.fault.outcome === 'HTTP_429'
    && /monthly quota/.test(h1.fault.reason), h1);
  ok('  nothing about the domain is cached', !(await rowFor('hunter', 'oftest-shop.test')));
  ok('  the breaker stops the next call reaching Hunter at all', hCalls === 1 && h2 && h2.fault && h3 === null, { hCalls, h2 });

  const CT = strip(read('server/ai.js'));
  ok('contacts: a NONE is confirmed only when no source errored or timed out', /\{ confirmed: !anyError && !anyTimeout \}/.test(CT));
  ok('  and getBrandContacts returns the outcome to the nightly run', /outcome: res\.outcome \|\| null \}/.test(CT));
  ok('school location: a failed lookup is not cached as unknown, and the scan says so', /return \{ city: 'Unknown City', state: 'Unknown State', known: false, fault: /.test(CT)
    && /if \(loc\.fault\) throw require\('\.\/services\/ourFault'\)\.fault\('school-location'/.test(CT));

  // ── 5. THE PURGE ──────────────────────────────────────────────────────────
  OUT.push('', '-- the purge for rows already poisoned --');
  await P.query(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at) VALUES
    ('oftest-p1', 'contacts', 'OFTest P1', '{}', 'NONE', '2031-01-02'),
    ('oftest-p2', 'contacts', 'OFTest P2', '{"contacts":[{"name":"A"}]}', 'OK', '2031-01-02'),
    ('oftest-p3', 'instagram', 'OFTest P3', '{"found":false}', 'NONE', '2031-01-02'),
    ('oftest-p4', 'contacts', 'OFTest P4', '{}', 'NONE', '2030-12-01')
    ON CONFLICT (brand_key, lane) DO UPDATE SET outcome = EXCLUDED.outcome, refreshed_at = EXCLUDED.refreshed_at, evidence = EXCLUDED.evidence`);
  const { spawnSync } = require('child_process');
  const env = { ...process.env, INIT_WAIT_MS: '3000' };
  const dry = spawnSync(process.execPath, [REPO + 'scripts/purge-outage-negatives.js', '--since', '2031-01-01', '--until', '2031-01-05'], { encoding: 'utf8', env, timeout: 60000 });
  ok('dry run counts the window\'s negatives and deletes nothing', /2 row\(s\) would be deleted/.test(dry.stdout) && !!(await rowFor('contacts', 'oftest-p1')), dry.stdout + dry.stderr);
  const app = spawnSync(process.execPath, [REPO + 'scripts/purge-outage-negatives.js', '--since', '2031-01-01', '--until', '2031-01-05', '--apply'], { encoding: 'utf8', env, timeout: 60000 });
  ok('--apply deletes only negatives inside the window', /Deleted 2 negative/.test(app.stdout)
    && !(await rowFor('contacts', 'oftest-p1')) && !(await rowFor('instagram', 'oftest-p3'))
    && !!(await rowFor('contacts', 'oftest-p2')) && !!(await rowFor('contacts', 'oftest-p4')), app.stdout + app.stderr);

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await P.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('ourfault: FAILED', e); process.exit(1); });
