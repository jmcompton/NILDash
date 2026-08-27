'use strict';
// ── Hunter.io Domain Search ──────────────────────────────────────────────────
//
// Given a business domain, return the addresses Hunter holds for it. NEVER
// guesses: only addresses Hunter actually has.
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
const FAIL_COOLDOWN_HOURS = parseInt(process.env.HUNTER_FAIL_COOLDOWN_HOURS, 10) || 6;
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
              WHERE lane = $1 AND outcome <> 'NO_KEY'
                AND refreshed_at >= date_trunc('month', NOW())`, [LANE]);
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

async function budgetStatus() {
  const a = await accountUsedThisMonth(true);
  return { used: a.used, ladderUsed: a.ladder, verifyUsed: a.verify,
    budget: MONTHLY_BUDGET, remaining: Math.max(0, MONTHLY_BUDGET - a.used) };
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

async function _record(domain, outcome, evidence) {
  try {
    await store.saveBrandEvidence(domain, LANE, domain, null,
      { ...evidence, outcome, at: new Date().toISOString() }, outcome);
    // NOT incremented here. The credit was reserved at the budget gate before the
    // request went out; counting it again on the way back would double-charge.
  } catch (e) {
    console.error('[hunter] cache write failed @' + domain + ': ' + e.message);
  }
}

// opts: { force } -- force skips the cache read (not the write).
async function findDomainEmails(domain, opts = {}) {
  const key = String(domain || '').trim().toLowerCase();
  if (!key) return null;

  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) {
    // RECORDED, not silent. "The key was never set" used to be indistinguishable
    // from "we never looked", which is the ambiguity this whole rewrite exists
    // to remove.
    console.warn('[hunter] @' + key + ' skipped: HUNTER_API_KEY is not set');
    await _record(key, OUTCOME.NO_KEY, { found: false, reason: 'HUNTER_API_KEY not set' });
    return null;
  }

  if (!opts.force) {
    try {
      const cached = await store.getBrandEvidence(key, LANE, CACHE_DAYS);
      if (cached && cached.evidence) {
        const ev = cached.evidence;
        const oc = cached.outcome || (ev.found ? OUTCOME.OK : OUTCOME.NONE);
        if (ANSWERED.has(oc)) {
          // A real answer, still fresh. Free.
          return ev.found === false ? null : { ...ev, cached: true };
        }
        // A failure row. Honour it only briefly, then allow a retry.
        const ageH = cached.refreshed_at
          ? (Date.now() - new Date(cached.refreshed_at).getTime()) / 3.6e6 : 1e9;
        if (ageH < FAIL_COOLDOWN_HOURS) {
          console.log(`[hunter] @${key} skipped: ${oc} ${ageH.toFixed(1)}h ago, cooling down`);
          return null;
        }
      }
    } catch (_) { /* a cache problem must never block the call */ }
  }

  // Budget check goes AFTER the cache read, so a domain we already know about is
  // still served when the budget is spent -- the cap limits new spend, not access
  // to what has already been paid for. No row is written for a budget skip: not
  // spending a credit is a fact about us, not about the domain, and writing it
  // would occupy the cache key that the real answer needs later.
  //
  // CHECK AND RESERVE IN ONE TICK. Incrementing only when the row is written let
  // a burst of concurrent scans all read the same pre-burst count and each
  // decide there was room: 12 concurrent lookups spent 6 credits against a cap
  // of 5. The await below may yield, but nothing runs between it resolving and
  // the ++, so the comparison and the reservation cannot interleave.
  //
  // A reservation that never becomes a request (the fetch throws before leaving
  // the machine) is reconciled down by the next DB read. Over-reserving is the
  // safe direction; over-spending is not.
  // BOTH CONSUMERS. Domain Search and mailbox verification bill the same plan,
  // so a ceiling that counted only Domain Search was not a ceiling on the plan.
  const acct = await accountUsedThisMonth();
  if (acct.used >= MONTHLY_BUDGET) {
    console.warn(`[hunter] @${key} SKIPPED: monthly budget spent (${acct.used}/${MONTHLY_BUDGET}`
      + ` — ${acct.ladder} domain searches, ${acct.verify} verifications)`);
    return null;
  }
  _reserved++;

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
    await _record(key, oc, { found: false, reason: e.message, ms });
    return null;
  }
  clearTimeout(t);
  const ms = Date.now() - t0;

  if (!resp.ok) {
    const oc = _outcomeForStatus(resp.status);
    let detail = null;
    try { const j = await resp.json(); detail = j && j.errors && j.errors[0] && j.errors[0].details; } catch (_) {}
    console.warn(`[hunter] @${key} http=${resp.status} ${oc} ms=${ms}${detail ? ' detail=' + detail : ''}`);
    await _record(key, oc, { found: false, status: resp.status, reason: detail || ('HTTP ' + resp.status), ms });
    return null;
  }

  let json;
  try { json = await resp.json(); }
  catch (e) {
    console.warn(`[hunter] @${key} unreadable body: ${e.message}`);
    await _record(key, OUTCOME.ERROR, { found: false, status: resp.status, reason: 'unreadable body', ms });
    return null;
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
  })).filter((e) => e.email);

  if (!emails.length) {
    console.log(`[hunter] @${key} found=0 ms=${ms}`);
    await _record(key, OUTCOME.NONE, { found: false, status: 200, ms });
    return null;
  }

  const p = emails.filter((e) => e.type === 'personal').length;
  console.log(`[hunter] @${key} found=${emails.length} personal=${p} generic=${emails.length - p} ms=${ms}`);
  const out = { found: true, emails, status: 200, ms };
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

async function verifyEmail(email) {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return { ok: false, why: 'no Hunter key configured' };
  const addr = String(email || '').trim().toLowerCase();
  if (!addr) return { ok: false, why: 'no address' };

  const b = await budgetStatus().catch(() => null);
  if (b && b.remaining <= 0) {
    console.warn(`[hunter-verify] refused: monthly budget spent (${b.used}/${b.budget}`
      + ` — ${b.ladderUsed} domain searches, ${b.verifyUsed} verifications)`);
    return { ok: false, why: `this month's Hunter budget is spent (${b.used}/${b.budget})` };
  }

  const url = `${VERIFY_URL}?email=${encodeURIComponent(addr)}&api_key=${encodeURIComponent(key)}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) {
      const why = resp.status === 401 || resp.status === 403 ? 'Hunter rejected the key'
        : resp.status === 429 ? 'Hunter rate limited or out of credits'
          : `Hunter returned HTTP ${resp.status}`;
      console.warn(`[hunter-verify] ${addr}: ${why}`);
      return { ok: false, why };
    }
    const j = await resp.json();
    const status = j && j.data && j.data.status;
    console.log(`[hunter-verify] ${addr} -> ${status || 'no status'}`);
    return { ok: true, status: status || null, score: (j && j.data && j.data.score) || null };
  } catch (e) {
    const why = (e && e.name === 'AbortError') ? 'Hunter timed out' : `Hunter call failed: ${e.message}`;
    console.warn(`[hunter-verify] ${addr}: ${why}`);
    return { ok: false, why };
  }
}

module.exports = {
  findDomainEmails, verifyEmail, VERIFY_URL, OUTCOME, ANSWERED, LANE, CACHE_DAYS,
  creditsThisMonth, verifyCreditsThisMonth, accountUsedThisMonth, budgetStatus, MONTHLY_BUDGET,
  _resetBudgetCache: () => { _budgetCache = { at: 0, used: 0 }; _reserved = 0; _inflight = null; },
};
