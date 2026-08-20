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

module.exports = { findDomainEmails, OUTCOME, ANSWERED, LANE, CACHE_DAYS };
