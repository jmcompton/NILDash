'use strict';
// ── DEEPSEEK: THE FAST TIER'S OTHER PROVIDER ─────────────────────────────────
//
// The nightly pipeline's cheap tier (discovery, the contact ladder, the
// athlete lookup) ran on Haiku. This is the same job on DeepSeek's
// OpenAI-compatible endpoint, over plain fetch: no SDK, no new dependency.
//
// WHAT DEEPSEEK DOES NOT HAVE. Anthropic runs web searches server-side inside
// one call (the web_search tool). DeepSeek's API has no such tool, and every
// one of the three targets is a web-search call: discovery searches a market
// for businesses, the ladder searches a business for its owner, the lookup
// searches a roster for the athlete. So a search call on DeepSeek is a
// function-calling loop (services/webSearchTool) over a search provider we
// bring ourselves: Brave, Serper or Tavily, whichever key is set.
//
// THE ROUTING RULE, in one place (route):
//   AI_FAST_PROVIDER=anthropic   the kill switch: everything stays on Haiku
//   no DEEPSEEK_API_KEY          Haiku
//   the writer site              Haiku (the writer is Sonnet and never comes
//                                here; a fast call under its label stays put)
//   DEEPSEEK_SITES set and the call's site not in it   Haiku (a narrowing
//                                for a bad night; unset, EVERY Haiku call is
//                                routed, labelled or not: social discovery,
//                                company enrichment, the domain and person
//                                email searches, a bio from the app, all of
//                                them)
//   a search call with no search provider key   Haiku, because a search call
//   without a search is a call that invents businesses.
//   otherwise                    DeepSeek
// describeRouting() prints the decision once at startup so a night on the
// wrong provider is a log line, not a surprise on the ledger.
//
// USAGE. DeepSeek reports prompt_tokens (cache hit + miss), completion_tokens,
// prompt_cache_hit_tokens and prompt_cache_miss_tokens. They are normalised to
// the ledger's shape: input = cache miss, cache read = cache hit.

const Ledger = require('./aiLedger');

const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const PROVIDER = 'deepseek';
// Kept for the callers that list the routed sites; with DEEPSEEK_SITES unset
// the routing is every fast-tier call, and this is what the startup line
// names as the known ones.
const DEFAULT_SITES = ['discovery', 'instagram', 'contacts', 'lookup', 'social', 'enrichment'];
const NEVER_ROUTED = ['writer'];

function apiKey() { return String(process.env.DEEPSEEK_API_KEY || '').trim(); }
function model() { return String(process.env.DEEPSEEK_MODEL || '').trim() || DEFAULT_MODEL; }
function baseUrl() { return String(process.env.DEEPSEEK_BASE_URL || '').trim().replace(/\/+$/, '') || DEFAULT_BASE_URL; }
function killSwitch() { return String(process.env.AI_FAST_PROVIDER || '').trim().toLowerCase() === 'anthropic'; }
// The narrowing, when set. null means every fast-tier call.
function sites() {
  const raw = String(process.env.DEEPSEEK_SITES || '').trim();
  if (!raw) return null;
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function configured() { return !killSwitch() && !!apiKey(); }

// route(site, { needsSearch }) -> { provider: 'deepseek'|'anthropic', reason }
function route(site, opts = {}) {
  if (killSwitch()) return { provider: 'anthropic', reason: 'AI_FAST_PROVIDER=anthropic' };
  if (!apiKey()) return { provider: 'anthropic', reason: 'DEEPSEEK_API_KEY unset' };
  const top = String(site || '').split('.')[0].toLowerCase();
  if (NEVER_ROUTED.includes(top)) return { provider: 'anthropic', reason: `site "${site}" is not routed (the writer stays on Anthropic)` };
  const narrow = sites();
  if (narrow && !narrow.includes(top)) return { provider: 'anthropic', reason: `site "${site || 'unlabelled'}" is not routed (DEEPSEEK_SITES=${narrow.join(',')})` };
  if (opts.needsSearch) {
    const WST = require('./webSearchTool');
    if (!WST.provider()) return { provider: 'anthropic', reason: 'a web-search call, and no search provider key is set (BRAVE_SEARCH_API_KEY, SERPER_API_KEY or TAVILY_API_KEY)' };
  }
  return { provider: PROVIDER, reason: 'routed' };
}

function describeRouting() {
  if (killSwitch()) return 'fast tier: Haiku for everything (AI_FAST_PROVIDER=anthropic)';
  if (!apiKey()) return 'fast tier: Haiku for everything (DEEPSEEK_API_KEY unset)';
  const WST = require('./webSearchTool');
  const sp = WST.provider();
  const narrow = sites();
  const s = narrow ? narrow.join(', ') : `every Haiku call (${DEFAULT_SITES.join(', ')} and unlabelled), never the writer`;
  if (!sp) return `fast tier: DeepSeek ${model()} for plain calls on ${s}; web-search calls STAY ON HAIKU because no search provider key is set (SERPER_API_KEY, BRAVE_SEARCH_API_KEY or TAVILY_API_KEY). Discovery, the contact ladder and the athlete lookup are web-search calls.`;
  return `fast tier: DeepSeek ${model()} for ${s}, web search through ${sp.name} at $${WST.usdPerQuery()} a query; Sonnet and Opus calls stay on Anthropic`;
}

// One chat completion. Returns { text, toolCalls, usage, model, ms, raw }.
//   opts: { system, messages, maxTokens, temperature, tools, jsonMode,
//           timeoutMs, apiKey, baseUrl, model, ledger: { ctx, site } | false }
// Retries 429 and 5xx three times with backoff. Throws with .status on failure.
async function chat(opts = {}) {
  const key = opts.apiKey || apiKey();
  if (!key) { const e = new Error('DEEPSEEK_API_KEY not set'); e.status = 401; throw e; }
  const url = (opts.baseUrl ? String(opts.baseUrl).replace(/\/+$/, '') : baseUrl()) + '/chat/completions';
  const useModel = opts.model || model();
  const messages = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of (opts.messages || [])) messages.push(m);
  const body = { model: useModel, messages, max_tokens: opts.maxTokens || 2000, stream: false };
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (opts.tools && opts.tools.length) { body.tools = opts.tools; body.tool_choice = opts.toolChoice || 'auto'; }
  if (opts.jsonMode) body.response_format = { type: 'json_object' };
  const timeoutMs = Number(opts.timeoutMs) || Number(process.env.DEEPSEEK_TIMEOUT_MS) || 120000;

  const delays = [2000, 5000, 10000];
  let lastErr = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const t0 = Date.now();
    const ac = new AbortController();
    const killer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch (_) { j = null; }
      if (!r.ok) {
        const e = new Error(`DeepSeek HTTP ${r.status}: ${(j && j.error && (j.error.message || j.error.type)) || text.slice(0, 200)}`);
        e.status = r.status; throw e;
      }
      const choice = j && Array.isArray(j.choices) && j.choices[0];
      const msg = (choice && choice.message) || {};
      const usage = usageOf(j);
      const out = {
        text: typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content.map((c) => c && c.text || '').join('') : ''),
        toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
        message: msg,
        finishReason: choice && choice.finish_reason,
        usage, model: (j && j.model) || useModel, ms: Date.now() - t0, raw: j,
      };
      if (opts.ledger !== false) {
        Ledger.recordUsage({ provider: PROVIDER, model: out.model, usage, ms: out.ms, ctx: (opts.ledger && opts.ledger.ctx) || undefined });
      }
      return out;
    } catch (e) {
      lastErr = e;
      const status = e.status || 0;
      const retriable = status === 429 || status >= 500 || e.name === 'AbortError' || /fetch failed|ECONNRESET|ETIMEDOUT/.test(String(e.message));
      if (retriable && attempt < delays.length) {
        console.warn(`[deepseek] ${e.name === 'AbortError' ? 'timeout' : e.message} -- retrying in ${delays[attempt] / 1000}s (attempt ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      if (e.name === 'AbortError') { const t = new Error(`DeepSeek timed out after ${timeoutMs}ms`); t.status = 0; throw t; }
      throw e;
    } finally {
      clearTimeout(killer);
    }
  }
  throw lastErr;
}

// OpenAI-format usage -> the ledger's fields. Zero, never undefined.
function usageOf(j) {
  const u = (j && j.usage) || {};
  const prompt = Number(u.prompt_tokens) || 0;
  const hit = Number(u.prompt_cache_hit_tokens) || 0;
  const miss = u.prompt_cache_miss_tokens !== undefined ? (Number(u.prompt_cache_miss_tokens) || 0) : Math.max(0, prompt - hit);
  return {
    inputTokens: miss,
    outputTokens: Number(u.completion_tokens) || 0,
    cacheReadTokens: hit,
    cacheWriteTokens: 0,
    webSearches: 0,
  };
}

module.exports = { chat, usageOf, route, configured, describeRouting, apiKey, model, baseUrl, sites, PROVIDER, DEFAULT_MODEL, DEFAULT_BASE_URL, DEFAULT_SITES, NEVER_ROUTED };
