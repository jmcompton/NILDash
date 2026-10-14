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

const SEARCH_URL = 'https://api.hunter.io/v2/domain-search';
const TIMEOUT_MS = parseInt(process.env.HUNTER_TIMEOUT_MS, 10) || 8000;
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

function _outcomeForStatus(status) {
  if (status === 401 || status === 403) return OUTCOME.UNAUTHORIZED;
  if (status === 429) return OUTCOME.RATE_LIMITED;
  return OUTCOME.HTTP_ERROR;
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
    console.warn(`[hunter] @${key} SKIPPED: monthly budget spent (${acct.used}/${MONTHLY_BUDGET}`
      + ` — ${acct.ladder} domain searches, ${acct.verify} verifications)`);
    return null;
  }

  const params = new URLSearchParams({ domain: key, limit: String(LIMIT), api_key: apiKey });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(SEARCH_URL + '?' + params.toString(), { signal: ctrl.signal });
  } catch (e) {
    clearTimeout(t);
    const timedOut = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
    const oc = timedOut ? OUTCOME.TIMEOUT : OUTCOME.ERROR;
    const ms = Date.now() - t0;
    console.warn(`[hunter] @${key} ${oc.toLowerCase()} after ${ms}ms: ${e.message}`);
    // NOT retried. A call that already blew the cap will blow it again, and a
    // second attempt is a second credit for the same nothing.
    return _failOut(_fault(key, oc, e.message), opts);
  }
  clearTimeout(t);
  const ms = Date.now() - t0;

  if (!resp.ok) {
    const oc = _outcomeForStatus(resp.status);
    let detail = null;
    try { const j = await resp.json(); detail = j && j.errors && j.errors[0] && j.errors[0].details; } catch (_) {}
    console.warn(`[hunter] @${key} http=${resp.status} ${oc} ms=${ms}${detail ? ' detail=' + detail : ''}`);
    require('./ourFault').providerError('hunter', { status: resp.status, message: detail || ('HTTP ' + resp.status) }, 'hunterLookup.search');
    return _failOut(_fault(key, oc, detail || ('HTTP ' + resp.status)), opts);
  }

  let json;
  try { json = await resp.json(); }
  catch (e) {
    console.warn(`[hunter] @${key} unreadable body: ${e.message}`);
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

  if (!emails.length) {
    console.log(`[hunter] @${key} found=0${pattern ? ' pattern=' + pattern : ''} ms=${ms}`);
    await _record(key, OUTCOME.NONE, { found: false, status: 200, ms, pattern });
    return (opts.withPattern && pattern) ? { found: false, emails: [], pattern, status: 200, ms } : null;
  }

  const p = emails.filter((e) => e.type === 'personal').length;
  console.log(`[hunter] @${key} found=${emails.length} personal=${p} generic=${emails.length - p} ms=${ms}`);
  const out = { found: true, emails, pattern, status: 200, ms };
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

async function verifyEmail(email) {
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

  const url = `${VERIFY_URL}?email=${encodeURIComponent(addr)}&api_key=${encodeURIComponent(key)}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT_MS);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    // 202: Hunter is still waiting on the mail server. Not a verdict; asked
    // again next time (not cached, not a fault).
    if (resp.status === 202) {
      console.warn(`[hunter-verify] ${addr}: still verifying (202)`);
      return { ok: false, why: 'Hunter is still verifying this address' };
    }
    if (!resp.ok) {
      const why = resp.status === 401 || resp.status === 403 ? 'Hunter rejected the key'
        : resp.status === 429 ? 'Hunter rate limited or out of credits'
          : `Hunter returned HTTP ${resp.status}`;
      console.warn(`[hunter-verify] ${addr}: ${why}`);
      require('./ourFault').providerError('hunter', { status: resp.status, message: why }, 'hunterLookup.verify');
      return { ok: false, why };
    }
    const j = await resp.json();
    const d = (j && j.data) || {};
    const status = d.status;
    console.log(`[hunter-verify] ${addr} -> ${status || 'no status'}${d.result ? ' (' + d.result + ')' : ''}`);
    // `result` (deliverable / undeliverable / risky) is what tells a webmail
    // address that Hunter could check apart from one it could not.
    return { ok: true, status: status || null, result: d.result || null, score: d.score || null,
      acceptAll: d.accept_all === true };
  } catch (e) {
    const why = (e && e.name === 'AbortError') ? 'Hunter timed out' : `Hunter call failed: ${e.message}`;
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

async function findEmail(firstName, lastName, domain, opts = {}) {
  const first = String(firstName || '').trim();
  const last = String(lastName || '').trim();
  const dom = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!first || !last || !dom) return { email: null, why: 'needs a first name, a last name and a domain' };
  const key = `${first.toLowerCase()} ${last.toLowerCase()} @ ${dom}`;
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
    console.warn(`[hunter-finder] ${key} SKIPPED: monthly search budget spent (${acct.used}/${MONTHLY_BUDGET})`);
    require('./ourFault').record('hunter', `search budget spent (${acct.used}/${MONTHLY_BUDGET})`, '@' + dom);
    return { email: null, budget: true, why: `this month's Hunter search budget is spent (${acct.used}/${MONTHLY_BUDGET})` };
  }
  const params = new URLSearchParams({ domain: dom, first_name: first, last_name: last, api_key: apiKey });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await (opts.fetchImpl || fetch)(FINDER_URL + '?' + params.toString(), { signal: ctrl.signal });
  } catch (e) {
    clearTimeout(t);
    const oc = e && (e.name === 'AbortError' || /abort/i.test(e.message || '')) ? OUTCOME.TIMEOUT : OUTCOME.ERROR;
    return { email: null, ..._fault(dom, oc, 'email finder: ' + e.message) };
  }
  clearTimeout(t);
  if (!resp.ok) {
    // 404 is Hunter's "no address for this person", an answer, not a fault.
    if (resp.status === 404) {
      const ev = { email: null, score: null, sources: 0, acceptAll: null, status: 404 };
      await _recordFinder(key, OUTCOME.NONE, ev);
      return ev;
    }
    const oc = _outcomeForStatus(resp.status);
    let detail = null;
    try { const j = await resp.json(); detail = j && j.errors && j.errors[0] && j.errors[0].details; } catch (_) {}
    require('./ourFault').providerError('hunter', { status: resp.status, message: detail || ('HTTP ' + resp.status) }, 'hunterLookup.findEmail');
    return { email: null, ..._fault(dom, oc, 'email finder: ' + (detail || ('HTTP ' + resp.status))) };
  }
  let j;
  try { j = await resp.json(); } catch (_) { return { email: null, ..._fault(dom, OUTCOME.ERROR, 'email finder: unreadable body') }; }
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
};
