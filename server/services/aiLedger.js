'use strict';
// ── ONE ROW PER MODEL CALL ───────────────────────────────────────────────────
//
// "Break down last night's spend by call site" could not be answered: the
// meter counted calls and priced them flat ($0.003 a model call, $0.01 a
// search), and nothing anywhere recorded which model answered or how many
// tokens it read and wrote. The console shows dollars by model; the code
// knew calls by lane; neither knew calls by site, athlete and agent.
//
// This writes one row per call from the three entry points in ai.js (oneShot,
// oneShotWebSearch, _contactWebSearchRaw) plus the tool loop, with:
//   site        what asked -- 'writer', 'contacts.chamber', 'instagram',
//               'discovery', 'dealscan' -- from the meter's context (scanMeter.label)
//   model, tokens in/out, cache read/write tokens, web searches actually run
//   agent_id, athlete_id, brand   from the same context
//   est_usd     priced from the model's list price and the search price
//
// It never throws and never blocks a call: a ledger write that fails is logged
// once a minute and the call's result is returned exactly as before. The
// price table is the estimate's assumption and is printed by the breakdown
// script so a number is never read without the rate behind it.

const PRICES = {
  // USD per million tokens: [input, output]. Cache reads bill at a tenth of
  // input, cache writes at a quarter over. Web search is per request.
  'claude-haiku-4-5': [1, 5],
  'claude-sonnet-4-6': [3, 15],
  'claude-sonnet-4-5': [3, 15],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-opus-4-1': [15, 75],
};
const USD_PER_WEB_SEARCH = 0.01;

function priceKey(model) {
  const m = String(model || '').toLowerCase();
  const k = Object.keys(PRICES).find((p) => m.startsWith(p));
  return k || null;
}

// Extracted from an SDK response. Zero, never undefined, so arithmetic on
// the ledger never turns into NaN.
function usageOf(msg) {
  const u = (msg && msg.usage) || {};
  const blocks = Array.isArray(msg && msg.content) ? msg.content : [];
  const st = u.server_tool_use || {};
  const searches = Number(st.web_search_requests)
    || blocks.filter((b) => b && b.type === 'web_search_tool_result').length || 0;
  return {
    inputTokens: Number(u.input_tokens) || 0,
    outputTokens: Number(u.output_tokens) || 0,
    cacheReadTokens: Number(u.cache_read_input_tokens) || 0,
    cacheWriteTokens: Number(u.cache_creation_input_tokens) || 0,
    webSearches: searches,
  };
}

function estimateUsd(model, usage) {
  const k = priceKey(model);
  if (!k) return null;   // an unpriced model is reported as unknown, not as free
  const [inP, outP] = PRICES[k];
  const usd = (usage.inputTokens * inP + usage.outputTokens * outP
    + usage.cacheReadTokens * inP * 0.1 + usage.cacheWriteTokens * inP * 1.25) / 1e6
    + usage.webSearches * USD_PER_WEB_SEARCH;
  return Math.round(usd * 1e6) / 1e6;
}

let _pool = null;
let _lastErrAt = 0;
let _queue = [];
let _flushing = false;

// A pool, or a function returning one, so the ledger can be wired at require
// time before the store has finished connecting.
function usePool(pool) { _pool = pool; }
function _poolNow() { return typeof _pool === 'function' ? _pool() : _pool; }

async function _flush() {
  const pool = _poolNow();
  if (_flushing || !pool || !_queue.length) return;
  _flushing = true;
  const batch = _queue.splice(0, 200);
  try {
    const cols = ['site', 'model', 'agent_id', 'athlete_id', 'brand', 'input_tokens', 'output_tokens',
      'cache_read_tokens', 'cache_write_tokens', 'web_searches', 'est_usd', 'ms', 'caller'];
    const values = [];
    const params = [];
    batch.forEach((r, i) => {
      const base = i * cols.length;
      values.push('(' + cols.map((_, j) => '$' + (base + j + 1)).join(',') + ')');
      params.push(r.site, r.model, r.agentId, r.athleteId, r.brand, r.inputTokens, r.outputTokens,
        r.cacheReadTokens, r.cacheWriteTokens, r.webSearches, r.estUsd, r.ms, r.caller || null);
    });
    await pool.query(`INSERT INTO ai_call_ledger (${cols.join(',')}) VALUES ${values.join(',')}`, params);
  } catch (e) {
    if (Date.now() - _lastErrAt > 60000) {
      _lastErrAt = Date.now();
      console.error('[ai-ledger] write failed (' + batch.length + ' row(s) dropped): ' + e.message);
    }
  } finally {
    _flushing = false;
    if (_queue.length) setImmediate(_flush);
  }
}

// WHO CALLED, when nobody labelled the call. "unlabelled" was the second
// biggest line on the breakdown two nights running, and the row said nothing
// about where it came from. Now an unlabelled row carries the first stack
// frame outside the AI plumbing -- "services/draftPrewarm.js:304" -- so the
// site can be named from the ledger instead of guessed from the code.
const _PLUMBING = /[\\/](ai|aiLedger|scanMeter)\.js|node:internal|node_modules[\\/]/;
function callerOf() {
  try {
    const lines = String(new Error().stack || '').split('\n').slice(1);
    for (const l of lines) {
      const m = l.match(/\(?([^()\s]+\.js):(\d+):\d+\)?\s*$/);
      if (!m || _PLUMBING.test(m[1])) continue;
      const file = m[1].replace(/^.*[\\/]server[\\/]/, '').replace(/^.*[\\/]scripts[\\/]/, 'scripts/');
      return `${file}:${m[2]}`.slice(0, 160);
    }
  } catch (_) { /* a stack we cannot read is not worth a failed row */ }
  return null;
}

// record(msg, { model, ms, ctx }) -> the row it queued (for tests), or null.
// ctx is the meter context: { site, agentId, athleteId, brand }.
function record(msg, info) {
  try {
    const usage = usageOf(msg);
    const ctx = (info && info.ctx) || {};
    const site = String(ctx.site || info.site || 'unlabelled').slice(0, 60);
    const row = {
      site,
      caller: site === 'unlabelled' ? callerOf() : null,
      model: String((info && info.model) || (msg && msg.model) || 'unknown').slice(0, 80),
      agentId: ctx.agentId ? String(ctx.agentId).slice(0, 120) : null,
      athleteId: ctx.athleteId ? String(ctx.athleteId).slice(0, 120) : null,
      brand: ctx.brand ? String(ctx.brand).slice(0, 200) : null,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
      webSearches: usage.webSearches,
      estUsd: estimateUsd((info && info.model) || (msg && msg.model), usage),
      ms: Number(info && info.ms) || null,
    };
    _queue.push(row);
    setImmediate(_flush);
    return row;
  } catch (e) {
    return null;
  }
}

// For tests and for a clean shutdown: wait for the queue to drain.
async function drain() {
  for (let i = 0; i < 50 && (_queue.length || _flushing); i++) {
    await _flush();
    await new Promise((r) => setTimeout(r, 10));
  }
}

module.exports = { callerOf, record, usageOf, estimateUsd, priceKey, usePool, drain, PRICES, USD_PER_WEB_SEARCH };
