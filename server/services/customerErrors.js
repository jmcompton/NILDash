'use strict';
// ── CUSTOMERS NEVER SEE A VENDOR'S ERROR ────────────────────────────────────
//
// Jamond Dubose, adding a client, read:
//   "web search failed: DeepSeek HTTP 402: Insufficient Balance (request_id: ...)"
// A customer never sees a vendor name, an HTTP status or a request id. They
// see plain words and a way to try again; the detail is logged here, where the
// admin can read it ([customer-error] lines), and a payment or key failure has
// already been recorded by the provider's client (services/ourFault).
//
// ONE CHOKE POINT. Mounted on every /api JSON response (not /api/admin):
// the fields that carry errors and notes to the screen are scanned, and any
// string that looks like a provider's error is replaced. Code that passes
// e.message to the client by habit -- there are hundreds of
// `res.status(500).json({ error: e.message })` -- is covered without being
// found one by one. A one-sentence string is replaced whole; in longer text
// (an assistant reply) only the offending sentence is.

const PLAIN = "Something on our side didn't respond. Please try again in a minute.";

// Vendor names that are never anything else, and the ones that are ordinary
// words or names (Hunter, Brave, Claude, Google) only when they read as a
// provider: followed by an API word.
const VENDOR = [
  /\b(?:deepseek|anthropic|serper|tavily|openai|resend|stripe api)\b/i,
  /\b(?:hunter(?:\.io)?|brave(?: search)?|claude|google(?: places| maps)?|places api|gemini)\s*(?:api\b|http\b|error\b|returned\b|rejected\b|refused\b|rate[- ]limit|says\b|:)/i,
  /\bHTTP\s?\d{3}\b/i,
  /\b(?:status|status code)\s*[:=]?\s*(?:4\d\d|5\d\d)\b/i,
  /\brequest[_ -]?id\b/i,
  /\bapi[_ -]?key\b/i,
  /\b(?:insufficient[_ ]balance|credit balance is too low|not enough credits|quota exceeded|resource[_ ]exhausted|rate[_ ]limit(?:ed)?|invalid[_ ]?api|unauthori[sz]ed)\b/i,
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up)\b/i,
  /\b(?:invalid_request_error|authentication_error|permission_error|overloaded_error|api_error)\b/i,
  /places\.googleapis|api\.deepseek|api\.anthropic|google\.serper/i,
  // Model output that is not an answer: tool-call markup, and our own parser's
  // words about it. Customers never see model internals either.
  /<\|DSML\|>|<[|｜]tool[▁_ ]?call|<\/?tool_call>|<\|(?:tool_calls?|invoke|function)/i,
  /\b(?:could not be read|was not JSON|not JSON|unreadable answer|parse(?:d)? (?:error|failure)|JSON\.parse|Unexpected token)\b/i,
  /\b(?:ANTHROPIC|DEEPSEEK|SERPER|HUNTER|GOOGLE_PLACES|TAVILY|BRAVE_SEARCH|RESEND)_API_KEY\b/,
];
const looksVendor = (s) => typeof s === 'string' && VENDOR.some((re) => re.test(s));

// The fields that reach a customer as an error, a note or a reason.
const KEYS = new Set(['error', 'errors', 'message', 'msg', 'note', 'notes', 'skipped', 'warning', 'warnings',
  'reason', 'why', 'detail', 'details', 'emptyText', 'error_message', 'errorMessage', 'reply', 'trace', 'statusText']);

function scrubString(s, log) {
  if (!looksVendor(s)) return s;
  log(s);
  // One sentence: replaced whole. More (an assistant reply): only the
  // sentences that leak, so the rest of the answer survives.
  const parts = s.split(/(?<=[.!?])\s+(?=[A-Z"'(])/);
  if (parts.length < 2) return PLAIN;
  let replaced = false;
  const out = parts.map((p) => {
    if (!looksVendor(p)) return p;
    if (replaced) return '';
    replaced = true; return PLAIN;
  }).filter(Boolean).join(' ');
  return out;
}

function scrubValue(v, log, depth) {
  if (typeof v === 'string') return scrubString(v, log);
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, log, depth + 1));
  if (v && typeof v === 'object' && depth < 6) return scrubObject(v, log, depth + 1);
  return v;
}
function scrubObject(o, log, depth) {
  if (!o || typeof o !== 'object' || depth > 8) return o;
  if (Array.isArray(o)) return o.map((x) => (x && typeof x === 'object' ? scrubObject(x, log, depth + 1) : x));
  let copy = null;
  for (const k of Object.keys(o)) {
    const v = o[k];
    let nv = v;
    if (KEYS.has(k)) nv = scrubValue(v, log, depth);
    else if (v && typeof v === 'object') nv = scrubObject(v, log, depth + 1);
    if (nv !== v) { if (!copy) copy = { ...o }; copy[k] = nv; }
  }
  return copy || o;
}

// body -> the body a customer may see. ctx: { path, userId } for the log line.
function scrub(body, ctx = {}) {
  if (!body || typeof body !== 'object') return body;
  const seen = [];
  const out = scrubObject(body, (s) => seen.push(s), 0);
  for (const s of seen) console.error(`[customer-error] ${ctx.method || ''} ${ctx.path || '?'}${ctx.userId ? ' user=' + ctx.userId : ''}: ${String(s).slice(0, 600)}`);
  return out;
}

// Express: every /api JSON response except the admin's own pages.
function middleware(req, res, next) {
  const p = req.path || '';
  if (!p.startsWith('/api/') || p.startsWith('/api/admin')) return next();
  const json = res.json.bind(res);
  res.json = (body) => json(scrub(body, { path: p, method: req.method, userId: req.session && req.session.userId }));
  next();
}

module.exports = { scrub, scrubString, looksVendor, middleware, PLAIN, KEYS };
