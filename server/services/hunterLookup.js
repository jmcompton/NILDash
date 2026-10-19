'use strict';
// ── Hunter.io Domain Search ──────────────────────────────────────────────────
//
// Given a business domain, return the addresses Hunter holds for it, and the
// domain's address PATTERN ("{first}.{last}") when Hunter knows it. This module
// never guesses; building an address from the pattern is services/emailPattern,
// and what it builds is marked Tier 2 (services/emailTier), never 'found'.
//
// RESTORED after fbf5865 removed it. Two things are different this time, and
// both are the reason the removal happened:
//
// 1. EVERY CALL IS LOGGED, INCLUDING FAILURES. The old code did
//        if (r.httpFail) return null;      // no row
//        if (r.err)      return null;      // no row
//    so a 401, a 429, a timeout and a call that never happened all left the
//    identical trace: nothing. That is exactly why "was Hunter rate-limited or
//    does it not have these businesses" could not be answered from the data.
//    Now every outcome writes a row carrying the HTTP status.
//
// 2. WHAT COMES BACK IS NOT A PUBLISHED ADDRESS. Callers must tag it
//    emailKind:'hunter', never 'published'. The greeting guard refuses to greet
//    by first name on anything but a published address, which is the guard that
//    was missing when this was removed.
//
// Cost: Hunter bills one credit per domain-search request. The caller decides
// when to spend one; this module never retries a rate limit into a second.
const store = require('../store');
// TONIGHT'S ALLOWANCE (services/hunterPace, HUNTER_PACE_ON): counted where a
// credit is committed, in the same synchronous step as the monthly ceiling.
const HP = require('./hunterPace');

const SEARCH_URL = 'https://api.hunter.io/v2/domain-search';
const TIMEOUT_MS = parseInt(process.env.HUNTER_TIMEOUT_MS, 10) || 8000;
// EMAIL FINDER WAITS ON THE BUSINESS'S MAIL SERVER. Its answer carries a
// verification Hunter runs in the same request, so it is as slow as the
// Verifier (VERIFY_TIMEOUT_MS, ~20s at Hunter), not as quick as a Domain
// Search. It was cut off at the 8s search timeout: on the first night with
// EMAIL_FIVE_ON, 163 finder calls were aborted by OUR timer ("TIMEOUT: email
// finder: This operation was aborted") -- not a single 403 or 429 from Hunter --
// and every one set its business aside for a retry the time limit then ended.
const FINDER_TIMEOUT_MS = parseInt(process.env.HUNTER_FINDER_TIMEOUT_MS, 10) || 30000;

// ── THE PACE: EVERY CALL TO HUNTER GOES THROUGH _call ──────────────────────
// Hunter allows 15 requests a second and 500 a minute for Domain Search and
// Email Finder (fewer for the Verifier), and answers "too fast" with a 403 --
// not only a 429. Athletes now run side by side (jobs/outreachQueue), so the
// pace is held here for every endpoint at once, well under all of them: at
// most PACE.inflight calls open, PACE.perSec starts a second, PACE.perMin a
// minute. A call waits its turn rather than being refused.
const PACE = {
  inflight: parseInt(process.env.HUNTER_MAX_INFLIGHT, 10) || 8,
  perSec: parseInt(process.env.HUNTER_MAX_PER_SEC, 10) || 8,
  perMin: parseInt(process.env.HUNTER_MAX_PER_MIN, 10) || 250,
};
// "Too fast" (a 429, or a 403 whose body says rate limit): wait and ask again,
// honouring Retry-After, else BACKOFF_MS, 2x, 4x with jitter; BACKOFF_TRIES in
// all. Still too fast after that is recorded as RATE_LIMITED, as before.
const BACKOFF_MS = parseInt(process.env.HUNTER_BACKOFF_MS, 10) || 2000;
const BACKOFF_TRIES = 3;
const CACHE_DAYS = parseInt(process.env.HUNTER_CACHE_DAYS, 10) || 30;
// A recorded failure is NOT served as a result -- a 429 today must not mean this
// domain is written off for a month. It does suppress re-calling for a short
// while, so a failing key cannot be hammered once per scan.
const LIMIT = 5;
const LANE = 'hunter';

// ── Monthly credit budget ────────────────────────────────────────────────────
// The plan is 2,000 credits a month and there is no soft landing: past the
// ceiling Hunter returns 429 for everything, including the lookups that would
// have mattered. Wiring this into the live scan path multiplies the call rate by
// roughly the card count, so a cap is not optional.
//
// Default 1,800 leaves 200 in reserve, which is what a manual backfill or a
// debugging session costs. Set HUNTER_MONTHLY_BUDGET to change it.
const MONTHLY_BUDGET = parseInt(process.env.HUNTER_MONTHLY_BUDGET, 10) || 1800;
// ── TWO POOLS, NOT ONE ──────────────────────────────────────────────────────
// The plan bills SEARCHES (Domain Search and Email Finder: 2,000 a month) and
// VERIFICATIONS (the mailbox check: 4,000 a month) separately. Counting both
// against the 1,800 search ceiling meant that verifying the cards we send
// would starve the lookups that find the addresses -- so every email card
// could not be verified without breaking the ladder. Each pool now has its own
// ceiling, each with a 10% reserve for manual runs.
//   HUNTER_MONTHLY_BUDGET          searches, default 1,800 of 2,000
//   HUNTER_MONTHLY_VERIFY_BUDGET   verifications, default 3,600 of 4,000
const VERIFY_MONTHLY_BUDGET = parseInt(process.env.HUNTER_MONTHLY_VERIFY_BUDGET, 10) || 3600;
// Both Hunter search products write a row per credit spent: Domain Search to
// lane 'hunter' (by domain), Email Finder to lane 'hunterfinder' (by name and
// domain). The search ceiling counts both.
const SEARCH_LANES = ['hunter', 'hunterfinder'];
// A COUNT per lookup would be silly on the scan path; 60s of staleness cannot
// overshoot by more than the concurrency.
let _budgetCache = { at: 0, used: 0 };
const BUDGET_TTL_MS = 60000;
// Credits reserved since the last DB read, for requests whose rows are not
// written yet. Kept SEPARATE from the DB count: a refresh replaces the count and
// the reservations together, so a reservation can never be clobbered by a read
// that was already in flight when it was made. (That clobbering is exactly what
// let 12 concurrent lookups spend 9 credits against a cap of 5.)
let _reserved = 0;
// One DB read at a time. Twelve callers arriving together used to fire twelve
// identical COUNTs, each resolving with the same pre-burst number.
let _inflight = null;

// Every row EXCEPT NO_KEY represents a request that reached Hunter, so every row
// except NO_KEY cost a credit. Cache hits never write a row, so they never count.
async function creditsThisMonth(force) {
  if (force || Date.now() - _budgetCache.at >= BUDGET_TTL_MS) {
    if (!_inflight) {
      _inflight = (async () => {
        try {
          const r = await store.pool.query(
            `SELECT COUNT(*)::int AS n FROM brand_evidence_cache
              WHERE lane = ANY($1::text[]) AND outcome <> 'NO_KEY'
                AND refreshed_at >= date_trunc('month', NOW())`, [SEARCH_LANES]);
          _budgetCache = { at: Date.now(), used: r.rows[0].n };
        } catch (e) {
          console.error('[hunter] budget read failed: ' + e.message);
          // Fail SAFE: an unreadable budget must not read as "plenty left".
          _budgetCache = { at: Date.now(), used: MONTHLY_BUDGET };
        }
        // The count now includes every row written before it ran, so the
        // reservations it supersedes are cleared with it. Requests still in
        // flight at this instant are undercounted until their rows land -- at
        // most the concurrency limit, which the reserve absorbs.
        _reserved = 0;
        _inflight = null;
      })();
    }
    await _inflight;
  }
  // Evaluated at RESUME, so each caller in a burst sees the reservations made by
  // the callers ahead of it.
  return _budgetCache.used + _reserved;
}

// ── THE OTHER CONSUMER ──────────────────────────────────────────────────────
//
// creditsThisMonth counts lane 'hunter' rows, which are Domain Search and only
// Domain Search. Mailbox VERIFICATION draws on the same Hunter plan and writes
// no such row, so this ceiling was blind to it: verifyEmail called budgetStatus
// before every check, and that check's own spend never moved the number it was
// checking. The account could empty while the guard reported plenty left, and
// the first sign was Hunter returning 429 to the lookups that mattered.
//
// email_verify_credit_log is the counter for that consumer -- one row per credit
// committed, written before the call goes out.
let _verifyCache = { at: 0, used: 0 };

async function verifyCreditsThisMonth(force) {
  if (force || Date.now() - _verifyCache.at >= BUDGET_TTL_MS) {
    try {
      const r = await store.pool.query(
        `SELECT COUNT(*)::int AS n FROM email_verify_credit_log
          WHERE checked_at >= date_trunc('month', NOW())`);
      _verifyCache = { at: Date.now(), used: r.rows[0].n };
    } catch (e) {
      console.error('[hunter] verification credit read failed: ' + e.message);
      // ZERO, AND THIS ONE IS NOT THE SAME MISTAKE. When the log is unreadable,
      // verifyBudget.accountStatus returns `unknown` and the limiter refuses to
      // spend, so no verification is happening -- zero is the accurate figure
      // for that state, not an optimistic guess. Blocking the LADDER because
      // verification's counter broke would take down the thing that finds
      // addresses in the first place.
      _verifyCache = { at: Date.now(), used: 0 };
    }
  }
  return _verifyCache.used;
}

// Both consumers, against one plan. This is what every ceiling check reads.
async function accountUsedThisMonth(force) {
  const [ladder, verify] = await Promise.all([
    creditsThisMonth(force), verifyCreditsThisMonth(force),
  ]);
  return { ladder, verify, used: ladder + verify };
}

// ── READ AND RESERVE IN ONE SYNCHRONOUS STEP ────────────────────────────────
//
// The gate below this used to read:
//
//   const acct = await accountUsedThisMonth();
//   if (acct.used >= MONTHLY_BUDGET) return null;
//   _reserved++;
//
// with a comment asserting "the await below may yield, but nothing runs between
// it resolving and the ++". That was true when the await was creditsThisMonth()
// on its own. It stopped being true the day the second consumer was added:
// accountUsedThisMonth is a Promise.all of two async reads, and creditsThisMonth
// BAKES `_reserved` INTO ITS RETURN VALUE. That number then travels through
// Promise.all's resolution, this wrapper's return, and the caller's await --
// three microtask hops, during which every other caller in the burst resumes,
// passes the same gate on the same stale snapshot, and reserves.
//
// Twelve concurrent lookups spent 7 and 10 credits against a cap of 5, about
// one run in five. The suite has caught this shape twice before (6 credits,
// then 9) and each fix narrowed the window without closing it, because each
// kept carrying the counter across an await.
//
// THE FIX IS TO STOP CARRYING IT. The DB refreshes are awaited first and their
// return values deliberately discarded -- a snapshot is the thing that goes
// stale. The live counters are then read in the SAME synchronous step as the
// increment, so between the comparison and the ++ there is no yield point at
// all, which on a single-threaded runtime is what atomic means.
//
// A reservation that never becomes a request (the fetch throws before leaving
// the machine) is still reconciled down by the next DB read. Over-reserving is
// the safe direction; over-spending is not.
async function reserveCredit(force) {
  // Awaited for their SIDE EFFECT -- refreshing _budgetCache and _verifyCache --
  // not for what they return.
  await Promise.all([creditsThisMonth(force), verifyCreditsThisMonth(force)]);
  // ── NO await, NO yield, FROM HERE TO THE ++ ──────────────────────────────
  // SEARCHES ONLY. Verifications are their own pool (VERIFY_MONTHLY_BUDGET);
  // they are reported alongside, never subtracted from this one.
  const ladder = _budgetCache.used;
  const verify = _verifyCache.used;
  const used = ladder + _reserved;
  if (used >= MONTHLY_BUDGET) return { ok: false, used, ladder, verify };
  // Tonight's allowance (HUNTER_PACE_ON): still no await before the ++.
  const pace = HP.take('search');
  if (!pace.ok) return { ok: false, used, ladder, verify, pace: pace.why };
  _reserved++;
  return { ok: true, used, ladder, verify };
}

// used / budget / remaining are SEARCHES. verifyUsed / verifyBudget /
// verifyRemaining are the verification pool.
async function budgetStatus() {
  const a = await accountUsedThisMonth(true);
  return { used: a.ladder, ladderUsed: a.ladder, verifyUsed: a.verify,
    budget: MONTHLY_BUDGET, remaining: Math.max(0, MONTHLY_BUDGET - a.ladder),
    verifyBudget: VERIFY_MONTHLY_BUDGET, verifyRemaining: Math.max(0, VERIFY_MONTHLY_BUDGET - a.verify) };
}

// Outcomes written to brand_evidence_cache.outcome. OK and NONE are answers;
// everything else is a failure and says which.
const OUTCOME = {
  OK: 'OK',                 // HTTP 200, at least one address
  NONE: 'NONE',             // HTTP 200, zero addresses -- a real coverage miss
  UNAUTHORIZED: 'HTTP_401', // bad or missing key
  RATE_LIMITED: 'HTTP_429', // out of credits or too fast
  HTTP_ERROR: 'HTTP_ERR',   // any other non-2xx, status recorded in evidence
  TIMEOUT: 'TIMEOUT',
  ERROR: 'ERROR',           // network/parse
  NO_KEY: 'NO_KEY',         // never called: HUNTER_API_KEY is not set
};
const ANSWERED = new Set([OUTCOME.OK, OUTCOME.NONE]);

// "TOO FAST" IS NOT "OUT OF CREDITS". Hunter answers too many requests a
// second with a 403 (also its answer to a bad key: only the body tells them
// apart), and a spent plan with a 429 ("You have reached your monthly
// quota"). Waiting helps the first and never the second, so only an answer
// that says rate limit -- or carries Retry-After -- and says nothing about a
// quota, credits, a plan or usage is backed off. A 429 otherwise stops Hunter
// for BREAKER_MIN, as it always has; a 403 otherwise is a dead key.
function _said(json) {
  const e = json && Array.isArray(json.errors) && json.errors[0];
  return [e && e.id, e && e.details, e && e.code].filter(Boolean).join(' ');
}
function _isRateLimit(status, json, retryAfter) {
  if (status !== 403 && status !== 429) return false;
  const said = _said(json);
  if (/quota|credit|plan|monthly|usage|subscription/i.test(said)) return false;
  return !!retryAfter || /rate[_ ]?limit|too[_ ]many|requests? (per|a) (second|minute)|slow down/i.test(said);
}
function _outcomeForStatus(status, json) {
  if (status === 429 || _isRateLimit(status, json)) return OUTCOME.RATE_LIMITED;
  if (status === 401 || status === 403) return OUTCOME.UNAUTHORIZED;
  return OUTCOME.HTTP_ERROR;
}

// ── THE GATE ───────────────────────────────────────────────────────────────
// The clock the gate reads and waits on. The real one, always, except when a
// test hands it a virtual clock (_setClock) so the pace can be checked to the
// millisecond: the same code, on a clock no scheduler can jitter.
const REAL_CLOCK = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
let _clock = REAL_CLOCK;
function _setClock(c) { _clock = c || REAL_CLOCK; }
const _pace = { open: 0, starts: [] };
const _sleep = (ms) => _clock.sleep(ms);
async function _slot() {
  for (;;) {
    const now = _clock.now();
    while (_pace.starts.length && now - _pace.starts[0] >= 60000) _pace.starts.shift();
    const inLastSec = _pace.starts.filter((t) => now - t < 1000);
    if (_pace.open < PACE.inflight && inLastSec.length < PACE.perSec && _pace.starts.length < PACE.perMin) {
      _pace.open++; _pace.starts.push(now); return;
    }
    let wait = 25;
    if (_pace.starts.length >= PACE.perMin) wait = Math.max(wait, 60000 - (now - _pace.starts[0]));
    else if (inLastSec.length >= PACE.perSec) wait = Math.max(wait, 1000 - (now - inLastSec[0]));
    await _sleep(wait);
  }
}

// ── EVERY CALL, LOGGED WITH HOW LONG IT TOOK ───────────────────────────────
// hunter_call_log: endpoint, milliseconds, outcome, HTTP status, retries. The
// evidence the timeout question needed and did not have; scripts/night-length
// prints its spread. Best-effort and never awaited by the caller.
let _logReady = null;
const _recent = [];   // the last few hundred, in memory, for tests and the report
function _logCall(row) {
  _recent.push({ ...row, at: Date.now() });
  if (_recent.length > 500) _recent.shift();
  if (process.env.HUNTER_CALL_LOG === '0') return;
  const pool = store.pool;
  if (!_logReady) {
    _logReady = pool.query(`CREATE TABLE IF NOT EXISTS hunter_call_log (
        id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), endpoint TEXT NOT NULL,
        ms INTEGER, outcome TEXT, status INTEGER, retries INTEGER NOT NULL DEFAULT 0)`)
      .then(() => pool.query(`CREATE INDEX IF NOT EXISTS hunter_call_log_at ON hunter_call_log (at)`))
      .then(() => pool.query(`DELETE FROM hunter_call_log WHERE at < NOW() - INTERVAL '45 days'`))
      .catch((e) => { _logReady = null; console.error('[hunter] call log table: ' + e.message); });
  }
  _logReady && _logReady.then(() => pool.query(`INSERT INTO hunter_call_log (endpoint, ms, outcome, status, retries) VALUES ($1,$2,$3,$4,$5)`,
    [row.endpoint, row.ms, row.outcome, row.status || null, row.retries || 0])).catch(() => {});
}

// One request: waits its turn at the gate, cut off at the endpoint's own
// timeout (the body read included), backed off when Hunter says "too fast".
// -> { status, ok, json, ms, retries }  json: the parsed body, or undefined if
// unreadable. Throws { timedOut, ms } when nothing came back in time.
async function _call(endpoint, url, { timeoutMs, fetchImpl } = {}) {
  let retries = 0;
  for (;;) {
    await _slot();
    const ctrl = new AbortController();
    const t0 = _clock.now();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp, json;
    try {
      resp = await (fetchImpl || fetch)(url, { signal: ctrl.signal });
      try { json = await resp.json(); } catch (_) { json = undefined; }
    } catch (e) {
      clearTimeout(timer);
      _pace.open--;
      const ms = _clock.now() - t0;
      const timedOut = !!(e && (e.name === 'AbortError' || /abort/i.test(e.message || '')));
      _logCall({ endpoint, ms, outcome: timedOut ? OUTCOME.TIMEOUT : OUTCOME.ERROR, status: null, retries });
      const err = new Error(timedOut ? `no answer within ${Math.round(timeoutMs / 1000)}s (aborted after ${ms}ms)` : (e && e.message) || String(e));
      err.timedOut = timedOut; err.ms = ms;
      throw err;
    }
    clearTimeout(timer);
    _pace.open--;
    const ms = _clock.now() - t0;
    const raHeader = resp.headers && resp.headers.get ? resp.headers.get('retry-after') : null;
    if (_isRateLimit(resp.status, json, raHeader) && retries < BACKOFF_TRIES) {
      retries++;
      const ra = parseInt(raHeader, 10);
      const wait = Number.isFinite(ra) && ra >= 0 ? Math.min(ra * 1000, 30000) : Math.round(BACKOFF_MS * Math.pow(2, retries - 1) * (1 + Math.random() * 0.25));
      _logCall({ endpoint, ms, outcome: 'BACKOFF', status: resp.status, retries });
      console.warn(`[hunter] ${endpoint}: too fast (HTTP ${resp.status}); waiting ${wait}ms, try ${retries + 1} of ${BACKOFF_TRIES + 1}`);
      await _sleep(wait);
      continue;
    }
    _logCall({ endpoint, ms, outcome: resp.ok ? OUTCOME.OK : _outcomeForStatus(resp.status, json), status: resp.status, retries });
    // OUT OF CREDITS, as Hunter says it (not "too fast"): the rest of the
    // night places cards from cached addresses (services/hunterPace).
    if ((resp.status === 429 || resp.status === 403) && !_isRateLimit(resp.status, json, raHeader)
      && (resp.status === 429 || /quota|credit|plan|monthly|usage|subscription/i.test(_said(json)))) {
      HP.markExhausted(`Hunter answered HTTP ${resp.status}${_said(json) ? ': ' + _said(json) : ''} (out of credits)`);
    }
    return { status: resp.status, ok: resp.ok, json, ms, retries };
  }
}

// ── A FAILURE IS OURS, NOT THE DOMAIN'S (services/ourFault) ─────────────────
// These used to be written to the cache and served back for six hours as
// "no surname match". Now a failure is recorded as a fault, never cached, and
// returned to the deep path as { fault } so the ladder says "Hunter failed".
// The breaker stops a dead key or an exhausted plan being called for every
// business in the night: it skips Hunter for BREAKER_MIN and says why.
const BREAKER_MIN = parseInt(process.env.HUNTER_BREAKER_MINUTES, 10) || 15;
let _breaker = null;   // { until, outcome, reason }
function _fault(domain, outcome, reason) {
  const OF = require('./ourFault');
  OF.record('hunter', `${outcome}: ${reason}`, '@' + domain);
  if (outcome === OUTCOME.UNAUTHORIZED || outcome === OUTCOME.RATE_LIMITED || outcome === OUTCOME.NO_KEY) {
    _breaker = { until: Date.now() + BREAKER_MIN * 60000, outcome, reason };
  }
  return { found: false, emails: [], fault: { service: 'hunter', outcome, reason: String(reason || outcome) } };
}
// null for the old callers, { fault } for the deep path that asks for more.
const _failOut = (f, opts) => ((opts && opts.withPattern) ? f : null);

async function _record(domain, outcome, evidence) {
  try {
    await store.saveBrandEvidence(domain, LANE, domain, null,
      { ...evidence, outcome, at: new Date().toISOString() }, outcome,
      // Only OK and NONE reach here now, and both are answers Hunter gave.
      { confirmed: true });
    // NOT incremented here. The credit was reserved at the budget gate before the
    // request went out; counting it again on the way back would double-charge.
  } catch (e) {
    console.error('[hunter] cache write failed @' + domain + ': ' + e.message);
  }
}

// opts: { force, withPattern } -- force skips the cache read (not the write).
// withPattern: a domain with NO listed addresses but a known pattern returns
// { found:false, emails:[], pattern } instead of null, so the owner's address
// can still be built. Off by default: every older caller reads null as "nothing".
async function findDomainEmails(domain, opts = {}) {
  const key = String(domain || '').trim().toLowerCase();
  if (!key) return null;

  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) {
    // RECORDED, not silent. "The key was never set" used to be indistinguishable
    // from "we never looked", which is the ambiguity this whole rewrite exists
    // to remove.
    console.warn('[hunter] @' + key + ' skipped: HUNTER_API_KEY is not set');
    return _failOut(_fault(key, OUTCOME.NO_KEY, 'HUNTER_API_KEY is not set'), opts);
  }
  if (_breaker && Date.now() < _breaker.until) {
    console.warn(`[hunter] @${key} skipped: ${_breaker.outcome} earlier (${_breaker.reason}); retrying after ${new Date(_breaker.until).toISOString()}`);
    return _failOut({ found: false, emails: [], fault: { service: 'hunter', outcome: _breaker.outcome, reason: _breaker.reason } }, opts);
  }

  if (!opts.force) {
    try {
      const cached = await store.getBrandEvidence(key, LANE, CACHE_DAYS);
      if (cached && cached.evidence) {
        const ev = cached.evidence;
        const oc = cached.outcome || (ev.found ? OUTCOME.OK : OUTCOME.NONE);
        if (ANSWERED.has(oc)) {
          // A real answer, still fresh. Free.
          if (ev.found === false) return (opts.withPattern && ev.pattern) ? { found: false, emails: [], pattern: ev.pattern, cached: true } : null;
          return { ...ev, cached: true };
        }
        // A failure row written before the rule: not an answer, ignored.
      }
    } catch (_) { /* a cache problem must never block the call */ }
  }

  // Budget check goes AFTER the cache read, so a domain we already know about is
  // still served when the budget is spent -- the cap limits new spend, not access
  // to what has already been paid for. No row is written for a budget skip: not
  // spending a credit is a fact about us, not about the domain, and writing it
  // would occupy the cache key that the real answer needs later.
  //
  // CHECK AND RESERVE IN ONE TICK, which reserveCredit is what finally makes
  // true -- the comparison and the increment happen in one synchronous step
  // with no await between them. See the note on that function for why the two
  // earlier attempts at this narrowed the window without closing it.
  //
  // BOTH CONSUMERS. Domain Search and mailbox verification bill the same plan,
  // so a ceiling that counted only Domain Search was not a ceiling on the plan.
  const acct = await reserveCredit();
  if (!acct.ok) {
    console.warn(acct.pace ? `[hunter] @${key} SKIPPED: ${acct.pace}`
      : `[hunter] @${key} SKIPPED: monthly budget spent (${acct.used}/${MONTHLY_BUDGET}`
      + ` — ${acct.ladder} domain searches, ${acct.verify} verifications)`);
    return null;
  }

  const params = new URLSearchParams({ domain: key, limit: String(LIMIT), api_key: apiKey });
  let resp;
  try {
    resp = await _call('domain-search', SEARCH_URL + '?' + params.toString(), { timeoutMs: TIMEOUT_MS, fetchImpl: opts.fetchImpl });
  } catch (e) {
    const oc = e.timedOut ? OUTCOME.TIMEOUT : OUTCOME.ERROR;
    console.warn(`[hunter] @${key} ${oc.toLowerCase()} after ${e.ms}ms: ${e.message}`);
    // NOT retried. A call that already blew the cap will blow it again, and a
    // second attempt is a second credit for the same nothing. ("Too fast" is
    // the one exception, and _call has already waited and asked again.)
    return _failOut(_fault(key, oc, e.message), opts);
  }
  const ms = resp.ms;

  if (!resp.ok) {
    const oc = _outcomeForStatus(resp.status, resp.json);
    const j = resp.json;
    const detail = (j && j.errors && j.errors[0] && j.errors[0].details) || null;
    console.warn(`[hunter] @${key} http=${resp.status} ${oc} ms=${ms}${detail ? ' detail=' + detail : ''}`);
    require('./ourFault').providerError('hunter', { status: resp.status, message: detail || ('HTTP ' + resp.status) }, 'hunterLookup.search');
    return _failOut(_fault(key, oc, detail || ('HTTP ' + resp.status)), opts);
  }

  const json = resp.json;
  if (json === undefined) {
    console.warn(`[hunter] @${key} unreadable body`);
    return _failOut(_fault(key, OUTCOME.ERROR, 'unreadable body'), opts);
  }

  const d = json && json.data;
  const raw = (d && Array.isArray(d.emails)) ? d.emails : [];
  const emails = raw.map((e) => ({
    email: e.value || null,
    type: e.type || null,
    confidence: typeof e.confidence === 'number' ? e.confidence : 0,
    firstName: e.first_name || null,
    lastName: e.last_name || null,
    position: e.position || null,
    // WHERE HUNTER SAW IT. Hunter lists the pages it found each address on;
    // the first is kept so the card can say where the address was stated.
    sourceUrl: (Array.isArray(e.sources) && e.sources[0] && e.sources[0].uri) || null,
  })).filter((e) => e.email);
  // How this domain spells its people's addresses. Was discarded.
  const pattern = (d && typeof d.pattern === 'string' && d.pattern.trim()) ? d.pattern.trim() : null;
  // The organisation's headcount band ("1-10", "11-50"...), when Hunter has
  // one: the size signal services/reachability learns from.
  const headcount = (d && typeof d.headcount === 'string' && d.headcount.trim()) ? d.headcount.trim() : null;

  if (!emails.length) {
    console.log(`[hunter] @${key} found=0${pattern ? ' pattern=' + pattern : ''} ms=${ms}`);
    await _record(key, OUTCOME.NONE, { found: false, status: 200, ms, pattern, headcount });
    return (opts.withPattern && pattern) ? { found: false, emails: [], pattern, headcount, status: 200, ms } : null;
  }

  const p = emails.filter((e) => e.type === 'personal').length;
  console.log(`[hunter] @${key} found=${emails.length} personal=${p} generic=${emails.length - p} ms=${ms}`);
  const out = { found: true, emails, pattern, headcount, status: 200, ms };
  await _record(key, OUTCOME.OK, out);
  return out;
}

// ── THE VERIFIER ────────────────────────────────────────────────────────────
// A DIFFERENT ENDPOINT ON THE SAME ACCOUNT. Domain Search asks "who works here";
// this asks "does this one mailbox accept mail". It lives here rather than in a
// second vendor so it inherits the key, the monthly budget and the failure
// vocabulary this file already owns -- a second vendor for one field is a second
// bill, a second outage and a second thing to reason about.
//
// The per-address CACHE is not here: emailVerify owns it, keyed by address
// rather than by domain, because a verification is a fact about a mailbox.
//
// Returns { ok, status, why }. ok:false means the CALL failed and the caller
// must treat it as unknown -- never as a bad address. Spending is refused
// rather than overrun when the monthly budget is gone, for the same reason the
// search path refuses: a run that quietly costs money is the problem this
// budget exists to prevent.
const VERIFY_URL = 'https://api.hunter.io/v2/email-verifier';
// A mailbox check waits on the business's own mail server, which can take far
// longer than a search: Hunter allows it about 20 seconds. Cut off at the
// search timeout, a slow server read as "could not check", and the card lost
// its email for our impatience.
const VERIFY_TIMEOUT_MS = parseInt(process.env.HUNTER_VERIFY_TIMEOUT_MS, 10) || 22000;

async function verifyEmail(email, opts = {}) {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return { ok: false, why: 'no Hunter key configured' };
  const addr = String(email || '').trim().toLowerCase();
  if (!addr) return { ok: false, why: 'no address' };

  const b = await budgetStatus().catch(() => null);
  if (b && b.verifyRemaining <= 0) {
    console.warn(`[hunter-verify] refused: monthly verification budget spent (${b.verifyUsed}/${b.verifyBudget})`);
    require('./ourFault').record('hunter', `verification budget spent (${b.verifyUsed}/${b.verifyBudget})`, '@' + addr.split('@')[1]);
    return { ok: false, why: `this month's Hunter verification budget is spent (${b.verifyUsed}/${b.verifyBudget})`, budget: true };
  }
  // Tonight's allowance (HUNTER_PACE_ON), checked and counted in one step.
  const pace = HP.take('verify');
  if (!pace.ok) return { ok: false, why: pace.why, budget: true, pace: true };

  const url = `${VERIFY_URL}?email=${encodeURIComponent(addr)}&api_key=${encodeURIComponent(key)}`;
  try {
    const resp = await _call('verifier', url, { timeoutMs: VERIFY_TIMEOUT_MS, fetchImpl: opts.fetchImpl });
    // 202: Hunter is still waiting on the mail server. Not a verdict; asked
    // again next time (not cached, not a fault).
    if (resp.status === 202) {
      console.warn(`[hunter-verify] ${addr}: still verifying (202)`);
      return { ok: false, why: 'Hunter is still verifying this address' };
    }
    if (!resp.ok) {
      const rate = resp.status === 429 || _isRateLimit(resp.status, resp.json);
      const why = rate ? 'Hunter rate limited or out of credits'
        : resp.status === 401 || resp.status === 403 ? 'Hunter rejected the key'
          : `Hunter returned HTTP ${resp.status}`;
      console.warn(`[hunter-verify] ${addr}: ${why}`);
      require('./ourFault').providerError('hunter', { status: resp.status, message: why }, 'hunterLookup.verify');
      return { ok: false, why };
    }
    const j = resp.json;
    const d = (j && j.data) || {};
    const status = d.status;
    console.log(`[hunter-verify] ${addr} -> ${status || 'no status'}${d.result ? ' (' + d.result + ')' : ''}`);
    // `result` (deliverable / undeliverable / risky) is what tells a webmail
    // address that Hunter could check apart from one it could not.
    return { ok: true, status: status || null, result: d.result || null, score: d.score || null,
      acceptAll: d.accept_all === true };
  } catch (e) {
    const why = (e && e.timedOut) ? `Hunter timed out (${e.message})` : `Hunter call failed: ${e.message}`;
    console.warn(`[hunter-verify] ${addr}: ${why}`);
    return { ok: false, why };
  }
}

// ── EMAIL FINDER: ONE NAMED PERSON AT ONE DOMAIN ────────────────────────────
// Domain Search lists who Hunter has seen at a domain. Email Finder asks for one
// person by name: Hunter combines the domain's pattern with every source it has
// for that name and returns its best address, with a score. A search credit,
// reserved the same way Domain Search reserves one, and cached 30 days by name
// and domain (lane 'hunterfinder') so the same owner costs one credit a month
// however many athletes reach the business.
//
// What comes back is a CANDIDATE, never a finding: the caller verifies it
// before it can be an email card (services/emailFinder).
//   -> { email, score, sources, acceptAll, cached } | { email: null, ... } | { fault }
const FINDER_URL = 'https://api.hunter.io/v2/email-finder';
const FINDER_LANE = 'hunterfinder';

// ONE QUESTION IN FLIGHT PER PERSON. Athletes run side by side, and two of
// them can reach the same owner in the same minute; the second waits for the
// first's answer instead of paying Hunter a second time for it.
const _finderInflight = new Map();
async function findEmail(firstName, lastName, domain, opts = {}) {
  const first = String(firstName || '').trim();
  const last = String(lastName || '').trim();
  const dom = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!first || !last || !dom) return { email: null, why: 'needs a first name, a last name and a domain' };
  const key = `${first.toLowerCase()} ${last.toLowerCase()} @ ${dom}`;
  if (_finderInflight.has(key)) return _finderInflight.get(key);
  const p = _findEmail(first, last, dom, key, opts);
  _finderInflight.set(key, p);
  try { return await p; } finally { _finderInflight.delete(key); }
}

async function _findEmail(first, last, dom, key, opts) {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return { email: null, fault: { service: 'hunter', outcome: OUTCOME.NO_KEY, reason: 'HUNTER_API_KEY is not set' } };
  if (_breaker && Date.now() < _breaker.until) {
    return { email: null, fault: { service: 'hunter', outcome: _breaker.outcome, reason: _breaker.reason } };
  }
  if (!opts.force) {
    try {
      const c = await store.getBrandEvidence(key, FINDER_LANE, CACHE_DAYS);
      if (c && c.evidence && ANSWERED.has(c.outcome)) return { ...c.evidence, cached: true };
    } catch (_) { /* a cache problem never blocks the call */ }
  }
  const acct = await reserveCredit();
  if (!acct.ok) {
    // Tonight's allowance is a plan, not a fault: no fault row for it.
    if (acct.pace) { console.warn(`[hunter-finder] ${key} SKIPPED: ${acct.pace}`); return { email: null, budget: true, pace: true, why: acct.pace }; }
    console.warn(`[hunter-finder] ${key} SKIPPED: monthly search budget spent (${acct.used}/${MONTHLY_BUDGET})`);
    require('./ourFault').record('hunter', `search budget spent (${acct.used}/${MONTHLY_BUDGET})`, '@' + dom);
    return { email: null, budget: true, why: `this month's Hunter search budget is spent (${acct.used}/${MONTHLY_BUDGET})` };
  }
  const params = new URLSearchParams({ domain: dom, first_name: first, last_name: last, api_key: apiKey });
  let resp;
  try {
    resp = await _call('email-finder', FINDER_URL + '?' + params.toString(), { timeoutMs: FINDER_TIMEOUT_MS, fetchImpl: opts.fetchImpl });
  } catch (e) {
    const oc = e.timedOut ? OUTCOME.TIMEOUT : OUTCOME.ERROR;
    return { email: null, ..._fault(dom, oc, 'email finder: ' + e.message) };
  }
  if (!resp.ok) {
    // 404 is Hunter's "no address for this person", an answer, not a fault.
    if (resp.status === 404) {
      const ev = { email: null, score: null, sources: 0, acceptAll: null, status: 404 };
      await _recordFinder(key, OUTCOME.NONE, ev);
      return ev;
    }
    const oc = _outcomeForStatus(resp.status, resp.json);
    const jj = resp.json;
    const detail = (jj && jj.errors && jj.errors[0] && jj.errors[0].details) || null;
    require('./ourFault').providerError('hunter', { status: resp.status, message: detail || ('HTTP ' + resp.status) }, 'hunterLookup.findEmail');
    return { email: null, ..._fault(dom, oc, 'email finder: ' + (detail || ('HTTP ' + resp.status))) };
  }
  const j = resp.json;
  if (j === undefined) return { email: null, ..._fault(dom, OUTCOME.ERROR, 'email finder: unreadable body') };
  const d = (j && j.data) || {};
  const ev = { email: d.email ? String(d.email).toLowerCase() : null, score: typeof d.score === 'number' ? d.score : null,
    sources: Array.isArray(d.sources) ? d.sources.length : 0,
    sourceUrl: (Array.isArray(d.sources) && d.sources[0] && d.sources[0].uri) || null,
    acceptAll: d.accept_all === true ? true : (d.accept_all === false ? false : null),
    hunterStatus: (d.verification && d.verification.status) || null, status: 200 };
  console.log(`[hunter-finder] ${key} -> ${ev.email || 'none'}${ev.score != null ? ' score=' + ev.score : ''}`);
  await _recordFinder(key, ev.email ? OUTCOME.OK : OUTCOME.NONE, ev);
  return ev;
}

async function _recordFinder(key, outcome, evidence) {
  try {
    await store.saveBrandEvidence(key, FINDER_LANE, key, null, { ...evidence, outcome, at: new Date().toISOString() }, outcome, { confirmed: true });
  } catch (e) { console.error('[hunter-finder] cache write failed ' + key + ': ' + e.message); }
}

module.exports = {
  findDomainEmails, findEmail, FINDER_URL, FINDER_LANE, SEARCH_LANES, VERIFY_MONTHLY_BUDGET,
  verifyEmail, VERIFY_URL, OUTCOME, ANSWERED, LANE, CACHE_DAYS,
  creditsThisMonth, verifyCreditsThisMonth, accountUsedThisMonth, budgetStatus, MONTHLY_BUDGET,
  _resetBudgetCache: () => { _budgetCache = { at: 0, used: 0 }; _reserved = 0; _inflight = null; },
  _resetBreaker: () => { _breaker = null; }, BREAKER_MIN,
  _call, _setClock, _isRateLimit, _outcomeForStatus, PACE, FINDER_TIMEOUT_MS, TIMEOUT_MS, VERIFY_TIMEOUT_MS, BACKOFF_TRIES,
  _recentCalls: () => _recent.slice(), _pace: () => ({ open: _pace.open, lastMinute: _pace.starts.length }),
};
