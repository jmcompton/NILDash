'use strict';
// ── WEB SEARCH FOR A MODEL THAT HAS NONE ─────────────────────────────────────
//
// Anthropic's web_search tool runs the searches inside the call and hands the
// model the pages. DeepSeek has no such tool, so this is the same thing done
// by hand: the model is given two functions, web_search(query) and
// fetch_page(url), and a loop runs them until it answers or runs out of
// searches. The result has the SAME shape _contactWebSearchRaw returns
// ({ text, citations, searches, outTokens, apiMs }) so the contact ladder,
// the owner-name search, discovery and the athlete lookup read it unchanged.
//
// THE SEARCH ITSELF is a provider we bring: Brave (BRAVE_SEARCH_API_KEY),
// Serper (SERPER_API_KEY) or Tavily (TAVILY_API_KEY), the first one with a
// key. Each is one HTTPS request returning titles, URLs and snippets. The
// URLs the searches returned are the citations, which is what Anthropic's
// result blocks gave us. fetch_page is ours: the page, tags stripped, capped.
//
// SEARCH_USD_PER_QUERY prices a search on the ledger (default $0.005, Brave's
// list price; Anthropic's is $0.01).

const DS = require('./deepseek');

const FETCH_CAP_CHARS = parseInt(process.env.SEARCH_FETCH_CAP_CHARS, 10) || 6000;
const RESULTS_PER_SEARCH = parseInt(process.env.SEARCH_RESULTS_N, 10) || 6;

function usdPerQuery() { const sp = provider(); return require('./aiLedger').searchUsd(sp ? sp.name : null); }

async function _getJson(url, init, timeoutMs) {
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), timeoutMs || 10000);
  try {
    const r = await fetch(url, Object.assign({ signal: ac.signal }, init || {}));
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 160)}`);
    return JSON.parse(text);
  } finally { clearTimeout(killer); }
}

// Each provider: search(query, n) -> [{ title, url, snippet }]
const PROVIDERS = {
  brave: {
    name: 'brave',
    key: () => String(process.env.BRAVE_SEARCH_API_KEY || '').trim(),
    async search(query, n) {
      const base = String(process.env.BRAVE_SEARCH_URL || 'https://api.search.brave.com/res/v1/web/search').replace(/\/+$/, '');
      const j = await _getJson(`${base}?q=${encodeURIComponent(query)}&count=${n}`, { headers: { accept: 'application/json', 'X-Subscription-Token': this.key() } });
      const rs = (j && j.web && Array.isArray(j.web.results)) ? j.web.results : [];
      return rs.map((r) => ({ title: r.title || '', url: r.url || '', snippet: r.description || '' }));
    },
  },
  serper: {
    name: 'serper',
    key: () => String(process.env.SERPER_API_KEY || '').trim(),
    async search(query, n) {
      const base = String(process.env.SERPER_SEARCH_URL || 'https://google.serper.dev/search');
      const j = await _getJson(base, { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-KEY': this.key() }, body: JSON.stringify({ q: query, num: n }) });
      const rs = (j && Array.isArray(j.organic)) ? j.organic : [];
      return rs.map((r) => ({ title: r.title || '', url: r.link || '', snippet: r.snippet || '' }));
    },
  },
  tavily: {
    name: 'tavily',
    key: () => String(process.env.TAVILY_API_KEY || '').trim(),
    async search(query, n) {
      const base = String(process.env.TAVILY_SEARCH_URL || 'https://api.tavily.com/search');
      const j = await _getJson(base, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.key() }, body: JSON.stringify({ query, max_results: n }) });
      const rs = (j && Array.isArray(j.results)) ? j.results : [];
      return rs.map((r) => ({ title: r.title || '', url: r.url || '', snippet: r.content || '' }));
    },
  },
};

// The search provider: Serper when its key is set ($1 a thousand, the
// cheapest of the three), then Brave, then Tavily. SEARCH_PROVIDER forces one.
const PREFERENCE = ['serper', 'brave', 'tavily'];
function provider() {
  const forced = String(process.env.SEARCH_PROVIDER || '').trim().toLowerCase();
  if (forced) { const p = PROVIDERS[forced]; return p && p.key() ? p : null; }
  for (const name of PREFERENCE) { const p = PROVIDERS[name]; if (p && p.key()) return p; }
  return null;
}

// A page as text: scripts, styles and tags out, whitespace folded, capped.
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
async function fetchPage(url, cap) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, text: 'not an http(s) URL' };
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(u, { signal: ac.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; NILDash/1.0)', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' } });
    const ct = String(r.headers.get('content-type') || '');
    if (!/text\/|html|xml|json/.test(ct)) return { ok: false, text: `not a text page (${ct || 'unknown type'})` };
    const body = await r.text();
    const text = /html|xml/.test(ct) ? htmlToText(body) : body;
    return { ok: r.ok, status: r.status, text: text.slice(0, cap || FETCH_CAP_CHARS) };
  } catch (e) {
    return { ok: false, text: `fetch failed: ${e.name === 'AbortError' ? 'timeout' : e.message}` };
  } finally { clearTimeout(killer); }
}

const TOOLS = [
  { type: 'function', function: { name: 'web_search', description: 'Search the web. Returns titles, URLs and snippets of the top results.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'the search query' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'fetch_page', description: 'Fetch one web page (from a search result) and return its text, so facts can be read off the page itself.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'the page URL' } }, required: ['url'] } } },
];

// searchLoop({ prompt, system, maxSearches, maxFetches, maxTokens,
//              temperature, model, ctx, timeoutMs, apiKey, baseUrl, provider })
//   -> { text, citations, searches, fetches, outTokens, apiMs, usage, rounds }
// Every chat turn writes a ledger row (through DS.chat) carrying ctx, and the
// searches go on one row of their own at the end, priced at the provider's
// rate. The scan meter is NOT bumped here: the caller in ai.js bumps it once
// per call, exactly as the Anthropic path does, so the nightly budget and
// the flat estimate see the same counts whichever provider answered.
async function searchLoop(o = {}) {
  const sp = o.provider || provider();
  if (!sp) { const e = new Error('no web search provider: set BRAVE_SEARCH_API_KEY, SERPER_API_KEY or TAVILY_API_KEY'); e.status = 0; throw e; }
  const maxSearches = Math.max(1, Number(o.maxSearches) || 3);
  const maxFetches = Math.max(0, Number(o.maxFetches) || maxSearches);
  const maxRounds = maxSearches + maxFetches + 1;
  const deadline = Date.now() + (Number(o.timeoutMs) || 120000);
  const sys = (o.system || 'You are a precise research assistant.')
    + `\n\nYou have web_search and fetch_page. Search first (at most ${maxSearches} search${maxSearches === 1 ? '' : 'es'}), fetch a page when the snippet is not enough (at most ${maxFetches}), then answer from what the pages say. Never state a fact the results did not contain. When you have no searches left, answer with what you have.`;
  const convo = [{ role: 'user', content: o.prompt }];
  const citations = [];
  const seenUrls = new Set();
  const cite = (u) => { const s = String(u || '').trim(); if (/^https?:\/\//i.test(s) && !seenUrls.has(s)) { seenUrls.add(s); citations.push(s); } };
  let searches = 0, fetches = 0, outTokens = 0, apiMs = 0, rounds = 0;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 };
  let text = '';
  // Every search result the loop saw, kept for a caller that checks the
  // model's answer against what the source actually said (services/schoolFind
  // accepts a town only when a result names the school, the city and the
  // state). Titles, URLs and snippets only.
  const results = [];

  for (let round = 0; round < maxRounds; round++) {
    rounds++;
    const toolsLeft = searches < maxSearches || fetches < maxFetches;
    const last = !toolsLeft || round === maxRounds - 1 || Date.now() > deadline - 15000;
    const r = await DS.chat({
      system: sys, messages: convo, maxTokens: o.maxTokens || 1200,
      temperature: o.temperature, model: o.model, apiKey: o.apiKey, baseUrl: o.baseUrl,
      tools: last ? undefined : TOOLS,
      timeoutMs: Math.max(10000, deadline - Date.now()),
      ledger: o.ledger === false ? false : { ctx: o.ctx },
    });
    outTokens += r.usage.outputTokens; apiMs += r.ms;
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens']) usage[k] += r.usage[k];
    text = r.text || text;
    if (!r.toolCalls.length) break;

    convo.push({ role: 'assistant', content: r.text || '', tool_calls: r.toolCalls });
    for (const tc of r.toolCalls) {
      const fn = (tc.function && tc.function.name) || '';
      let args = {}; try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (_) { args = {}; }
      let result;
      if (fn === 'web_search') {
        if (searches >= maxSearches) result = { error: 'no searches left; answer from what you have' };
        else {
          searches++;
          try {
            const rs = await sp.search(String(args.query || ''), RESULTS_PER_SEARCH);
            for (const x of rs) { cite(x.url); results.push({ query: String(args.query || ''), title: x.title || '', url: x.url || '', snippet: x.snippet || '' }); }
            result = { results: rs };
          } catch (e) { result = { error: 'search failed: ' + e.message }; }
        }
      } else if (fn === 'fetch_page') {
        if (fetches >= maxFetches) result = { error: 'no fetches left; answer from what you have' };
        else { fetches++; const pg = await fetchPage(args.url); if (pg.ok) cite(args.url); result = { url: args.url, ok: pg.ok, text: pg.text }; }
      } else result = { error: `unknown tool ${fn}` };
      convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  usage.webSearches = searches;
  // The searches, priced once: an extra zero-token row would double-count
  // nothing but reads oddly, so they ride on a row of their own only when the
  // loop ran any. Ledger.recordUsage prices them at the provider's search rate.
  if (searches && o.ledger !== false) {
    require('./aiLedger').recordUsage({ provider: DS.PROVIDER, model: o.model || DS.model(), usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: searches }, ms: 0, ctx: o.ctx, searchProvider: sp.name });
  }
  return { text, citations, searches, fetches, outTokens, apiMs, usage, rounds, results };
}

module.exports = { searchLoop, provider, fetchPage, htmlToText, usdPerQuery, TOOLS, PROVIDERS, PREFERENCE };
