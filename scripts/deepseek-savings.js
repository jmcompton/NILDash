#!/usr/bin/env node
'use strict';
// ── WHAT A NIGHT ON DEEPSEEK SAVES, FROM LAST NIGHT'S TOKEN COUNTS ──────────
//
//   node scripts/deepseek-savings.js                       last 24 hours
//   node scripts/deepseek-savings.js --date 2026-09-16     that run date (6pm the evening before to noon, UTC)
//   node scripts/deepseek-savings.js --hours 36
//
// Report only. Writes nothing.
//
// Reads the ledger rows in the window and re-prices every Haiku call on a
// ROUTED site (services/deepseek.sites: discovery, instagram, contacts,
// lookup by default) at DeepSeek's rates, with each web search at the search
// provider's rate instead of Anthropic's. The writer (Sonnet) is shown for
// context and is never re-priced: it does not move. Rows already on DeepSeek
// are shown at what they cost.
//
// THE RATES ARE ASSUMPTIONS and are printed: DEEPSEEK_PRICE_IN / _OUT /
// _CACHE_HIT and SEARCH_USD_PER_QUERY (see services/aiLedger). Tokens are
// re-priced one for one; DeepSeek's tokenizer differs from Anthropic's, so
// the real count will differ by some percent either way.

const store = require('../server/store');
const Ledger = require('../server/services/aiLedger');
const DS = require('../server/services/deepseek');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;

process.exitCode = 1;
let settled = false;
process.on('beforeExit', () => { if (!settled) { console.log('deepseek-savings: main() never settled. Exiting 1.'); process.exit(1); } });
function fail(where, e) { const m = `deepseek-savings: FAILED (${where}): ${e && e.message ? e.message : e}`; console.log(m); console.error(m); settled = true; process.exit(1); }
function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; }
const usd = (n) => '$' + (Number(n) || 0).toFixed(3);
const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n);
const pct = (a, b) => (b > 0 ? Math.round(100 * a / b) + '%' : 'n/a');

function window_() {
  const date = arg('date', null);
  if (date) {
    const d = new Date(date + 'T12:00:00Z');
    if (isNaN(d.getTime())) return fail('args', new Error('--date must be YYYY-MM-DD'));
    return { from: new Date(d.getTime() - 18 * 3600000), to: d, label: 'run date ' + date };
  }
  const hours = parseFloat(arg('hours', '24')) || 24;
  return { from: new Date(Date.now() - hours * 3600000), to: new Date(), label: 'last ' + hours + ' hours' };
}

// One row, re-priced at DeepSeek's rates: tokens at its input/output/cache
// prices, searches at the search provider's price.
function onDeepseek(r) {
  return Ledger.estimateUsd(DS.model(), {
    inputTokens: r.input_tokens, outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: 0, webSearches: r.web_searches,
  }, 'deepseek');
}

async function main() {
  const w = window_();
  console.log(`deepseek-savings: window ${w.label} (${w.from.toISOString()} .. ${w.to.toISOString()})`);
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  let rows;
  try {
    rows = (await P.query(
      `SELECT site, model, COALESCE(provider, 'anthropic') AS provider, input_tokens, output_tokens, cache_read_tokens, web_searches, est_usd
         FROM ai_call_ledger WHERE at >= $1 AND at < $2`, [w.from, w.to])).rows;
  } catch (e) {
    if (/provider does not exist/.test(e.message)) {
      rows = (await P.query(`SELECT site, model, 'anthropic' AS provider, input_tokens, output_tokens, cache_read_tokens, web_searches, est_usd
                               FROM ai_call_ledger WHERE at >= $1 AND at < $2`, [w.from, w.to]).catch((e2) => fail('ledger', e2))).rows;
    } else return fail('ledger', e);
  }
  console.log(`deepseek-savings: ${rows.length} ledger row(s) in the window.`);
  if (!rows.length) { console.log('Nothing to price. Run it after a nightly fill, or widen the window with --hours.'); settled = true; await P.end().catch(() => {}); process.exit(0); }

  const [inP, outP, hitP] = Ledger.DEEPSEEK_PRICE;
  console.log(`\nRates assumed: Haiku $${Ledger.PRICES['claude-haiku-4-5'][0]}/$${Ledger.PRICES['claude-haiku-4-5'][1]} per M in/out, search ${usd(Ledger.USD_PER_SEARCH.anthropic)}; `
    + `DeepSeek (${DS.model()}) $${inP}/$${outP} per M in/out, cache hit $${hitP}, search ${usd(Ledger.USD_PER_SEARCH.deepseek)} through the provider.`);
  console.log('Set DEEPSEEK_PRICE_IN, DEEPSEEK_PRICE_OUT, DEEPSEEK_PRICE_CACHE_HIT and SEARCH_USD_PER_QUERY to change them; the defaults are not verified V4.1 Flash rates.');

  const routed = DS.sites();
  const isRouted = (site) => routed.includes(String(site || '').split('.')[0].toLowerCase());
  const isHaiku = (m) => Ledger.priceKey(m) === 'claude-haiku-4-5';

  // ── THE HAIKU CALLS THAT WOULD MOVE ──────────────────────────────────────
  const move = rows.filter((r) => r.provider === 'anthropic' && isHaiku(r.model) && isRouted(r.site));
  const by = new Map();
  for (const r of move) {
    const k = r.site.split('.')[0];
    const g = by.get(k) || { calls: 0, inTok: 0, cacheTok: 0, outTok: 0, searches: 0, haiku: 0, deepseek: 0 };
    g.calls++; g.inTok += r.input_tokens; g.cacheTok += r.cache_read_tokens; g.outTok += r.output_tokens; g.searches += r.web_searches;
    g.haiku += Number(r.est_usd) || 0; g.deepseek += onDeepseek(r) || 0;
    by.set(k, g);
  }
  console.log(`\nHAIKU CALLS ON THE ROUTED SITES (${routed.join(', ')}): what they cost, what they would cost on DeepSeek`);
  console.log(`  ${pad('site', 12)} ${pad('calls', 6)} ${pad('searches', 9)} ${pad('tokens in', 11)} ${pad('tokens out', 11)} ${pad('Haiku', 9)} ${pad('DeepSeek', 9)} ${pad('saving', 9)}`);
  const tot = { calls: 0, searches: 0, inTok: 0, outTok: 0, haiku: 0, deepseek: 0 };
  for (const [k, g] of [...by.entries()].sort((a, b) => b[1].haiku - a[1].haiku)) {
    console.log(`  ${pad(k, 12)} ${pad(g.calls, 6)} ${pad(g.searches, 9)} ${pad(g.inTok, 11)} ${pad(g.outTok, 11)} ${pad(usd(g.haiku), 9)} ${pad(usd(g.deepseek), 9)} ${pad(usd(g.haiku - g.deepseek), 9)}`);
    tot.calls += g.calls; tot.searches += g.searches; tot.inTok += g.inTok; tot.outTok += g.outTok; tot.haiku += g.haiku; tot.deepseek += g.deepseek;
  }
  if (!move.length) console.log('  none: no Haiku call on a routed site in the window.');
  else {
    console.log(`  ${pad('TOTAL', 12)} ${pad(tot.calls, 6)} ${pad(tot.searches, 9)} ${pad(tot.inTok, 11)} ${pad(tot.outTok, 11)} ${pad(usd(tot.haiku), 9)} ${pad(usd(tot.deepseek), 9)} ${pad(usd(tot.haiku - tot.deepseek), 9)}`);
    const tokOnly = { haiku: (tot.inTok * 1 + tot.outTok * 5) / 1e6, deepseek: (tot.inTok * inP + tot.outTok * outP) / 1e6 };
    console.log(`\n  Of that, tokens alone: Haiku ${usd(tokOnly.haiku)} -> DeepSeek ${usd(tokOnly.deepseek)} (${pct(tokOnly.haiku - tokOnly.deepseek, tokOnly.haiku)} less).`);
    console.log(`  Searches alone: ${tot.searches} x ${usd(Ledger.USD_PER_SEARCH.anthropic)} = ${usd(tot.searches * Ledger.USD_PER_SEARCH.anthropic)} on Anthropic -> ${tot.searches} x ${usd(Ledger.USD_PER_SEARCH.deepseek)} = ${usd(tot.searches * Ledger.USD_PER_SEARCH.deepseek)} through the search provider.`);
    console.log(`  ESTIMATED SAVING FOR THIS WINDOW: ${usd(tot.haiku - tot.deepseek)} of ${usd(tot.haiku)} (${pct(tot.haiku - tot.deepseek, tot.haiku)}).`);
  }

  // ── WHAT DOES NOT MOVE, AND WHAT ALREADY MOVED ───────────────────────────
  const writer = rows.filter((r) => r.provider === 'anthropic' && /^writer/.test(r.site));
  const writerUsd = writer.reduce((n, r) => n + (Number(r.est_usd) || 0), 0);
  const otherAnthropic = rows.filter((r) => r.provider === 'anthropic' && !move.includes(r) && !writer.includes(r));
  const otherUsd = otherAnthropic.reduce((n, r) => n + (Number(r.est_usd) || 0), 0);
  const already = rows.filter((r) => r.provider === 'deepseek');
  const alreadyUsd = already.reduce((n, r) => n + (Number(r.est_usd) || 0), 0);
  const total = rows.reduce((n, r) => n + (Number(r.est_usd) || 0), 0);
  console.log(`\nUNCHANGED: the writer stays on Sonnet: ${writer.length} call(s), ${usd(writerUsd)}.`);
  console.log(`UNCHANGED: other Anthropic calls (not a routed site, or not Haiku): ${otherAnthropic.length} call(s), ${usd(otherUsd)}.`);
  if (already.length) console.log(`ALREADY ON DEEPSEEK in this window: ${already.length} call(s), ${usd(alreadyUsd)}.`);
  console.log(`\nWINDOW TOTAL ${usd(total)} -> ${usd(total - (tot.haiku - tot.deepseek))} with the routed Haiku calls on DeepSeek (${pct(tot.haiku - tot.deepseek, total)} of the total).`);
  console.log('\nDone.\n');
  settled = true;
  await P.end().catch(() => {});
  process.exit(0);
}
main().catch((e) => fail('main', e));
