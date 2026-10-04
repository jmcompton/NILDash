'use strict';
// ── THE RULE ────────────────────────────────────────────────────────────────
//
//   A failure on our side is never recorded as a fact about their market,
//   is never cached, and never counts toward a pause.
//
// Why it exists. Google disabled an API and every market build failed. Each
// failure was written down as a fact about the customer's market ("worked
// out", "below the bar", "no name found"), counted toward the three-night
// pause, and in the worst cases cached for 30 days as "found nothing", so a
// one-hour outage became a month of damage that outlived the fix.
//
// What "our side" means: anything that is not an answer about the business.
// A provider that refused (401/403/429/quota), timed out, was down, returned an
// error inside a 200, or was never called because a key is missing; our own
// database failing; a model returning something we cannot parse. "We asked and
// the answer was no" is a fact. "We could not ask" never is.
//
// HOW IT IS ENFORCED, in three places, so new code gets it for free:
//   1. CACHING. store.saveBrandEvidence refuses any error outcome, and refuses a
//      negative (NONE, found:false, ...) unless the caller passes
//      { confirmed: true }. A negative must be positively confirmed to be kept;
//      the default is to keep nothing.
//   2. THE SEARCH LAYER throws an OurFault when a provider fails, rather than
//      handing the model an empty result to summarise as "nothing found".
//   3. THE NIGHTLY RUN records an OurFault as a fault (tried[].fault, emptyReason
//      'our-fault'), which the pause counter ignores, and the run row carries
//      the service and the provider's own words.
// Every OurFault is also written to service_faults (best effort), which the
// morning alert and the admin status page read.

class OurFault extends Error {
  constructor(service, message, extra) {
    super(`${service}: ${message}`);
    this.name = 'OurFault';
    this.ourFault = true;
    this.service = service;
    this.reason = String(message || 'unknown');
    if (extra) Object.assign(this, extra);
  }
}

const isOurFault = (x) => !!(x && (x.ourFault === true || x instanceof OurFault));

function fault(service, message, extra) { return new OurFault(service, message, extra); }

// Outcomes that can only come from failing to ask. Never cached.
const ERROR_OUTCOMES = new Set(['ERROR', 'TIMEOUT', 'UNAUTHORIZED', 'RATE_LIMITED', 'HTTP_ERROR', 'NO_KEY',
  'FAULT', 'QUOTA', 'UNAVAILABLE']);
// Outcomes that say "there is nothing". Cached only when confirmed.
const NEGATIVE_OUTCOMES = new Set(['NONE', 'NO_EVIDENCE', 'NOT_FOUND', 'NO_MATCH', 'EMPTY', 'UNKNOWN']);

// May this be written to a cache? { ok } or { ok:false, why }.
function cacheable(outcome, evidence, opts) {
  const o = String(outcome || '').toUpperCase();
  if (ERROR_OUTCOMES.has(o) || /^HTTP_/.test(o)) return { ok: false, why: `outcome ${o} is our failure, not an answer` };
  if (evidence && isOurFault(evidence)) return { ok: false, why: 'evidence carries an OurFault' };
  const negative = NEGATIVE_OUTCOMES.has(o) || (evidence && evidence.found === false);
  if (negative && !(opts && opts.confirmed === true)) {
    return { ok: false, why: `negative outcome ${o || '(found:false)'} not confirmed; only a negative we actually confirmed is cached` };
  }
  return { ok: true };
}

// ── PAYMENT, KEY AND QUOTA FAILURES: OURS, ALWAYS, AND THE LOUDEST ─────────
//
// On 2026-10-03 DeepSeek answered every call with 402 Insufficient Balance and
// customers saw it in the Add Client screen while the status page was green:
// the nightly check had passed at 05:31 UTC and the money ran out during the
// day, and the 402s themselves were recorded nowhere. Now every paid
// provider's client sends its HTTP failures through providerError() below, so
// a failure to PAY, to AUTHENTICATE or to stay within QUOTA is recorded the
// moment a customer hits it, with its kind, and a payment or key failure
// emails the admin at once (at most once every three hours per provider and
// kind) instead of waiting for the next preflight or the morning alert.
//
//   kind 'billing'  402; "insufficient balance", "credit balance is too low",
//                   "not enough credits", a quota tied to the bill (Google
//                   billing disabled, Tavily 432)
//   kind 'auth'     401; 403 that is not about billing; a key refused
//   kind 'quota'    429; rate limit; resource exhausted
const BILLING_TEXT = /insufficient[_ ]balance|credit balance is too low|not enough credits|out of credits|no credits (?:left|remaining)|payment required|billing (?:is )?(?:not enabled|disabled)|requires? (?:a )?billing|enable billing|billing must be enabled|billing to be enabled|billing account|exceeded your current quota|plan limit|usage limit (?:reached|exceeded)|account (?:is )?suspended/i;
const AUTH_TEXT = /invalid[_ ]?api[_ ]?key|api key not valid|incorrect api key|invalid x-api-key|unauthori[sz]ed|authentication[_ ]error|permission[_ ]denied/i;
const QUOTA_TEXT = /rate[_ ]?limit|too many requests|resource[_ ]exhausted/i;
function statusOf(err) {
  if (!err) return 0;
  const s = Number(err.status || err.statusCode || (err.response && err.response.status) || 0);
  if (s) return s;
  const m = String(err.message || err).match(/\bHTTP (\d{3})\b/);
  return m ? Number(m[1]) : 0;
}
function classify(status, message) {
  const m = String(message || '');
  if (status === 402 || status === 432 || BILLING_TEXT.test(m)) return 'billing';
  if (status === 401) return 'auth';
  if (status === 403) return 'auth';
  if (AUTH_TEXT.test(m)) return 'auth';
  if (status === 429 || QUOTA_TEXT.test(m)) return 'quota';
  return null;
}
const KIND_WORDS = { billing: 'PAYMENT FAILURE', auth: 'KEY REFUSED', quota: 'QUOTA / RATE LIMIT' };

// Every paid provider's client calls this with what went wrong. Returns the
// kind (or null for an ordinary failure, which the caller handles as before)
// and tags the error with it, so callers and the customer-facing message can
// tell "we did not pay" from "the business does not exist".
function providerError(service, err, where) {
  const status = statusOf(err);
  const kind = classify(status, err && (err.message || err));
  if (!kind) return null;
  try { if (err && typeof err === 'object') { err.providerKind = kind; err.providerService = service; } } catch (_) {}
  const reason = `${KIND_WORDS[kind]}: ${status ? 'HTTP ' + status + ': ' : ''}${String((err && err.message) || err).slice(0, 400)}`;
  console.error(`[our-fault] ${service} ${KIND_WORDS[kind]}${where ? ' (' + where + ')' : ''}: ${String((err && err.message) || err).slice(0, 300)}`);
  record(service, reason, where, kind);
  if (kind === 'billing' || kind === 'auth') alertNow(service, kind, reason, where);
  return kind;
}

// ── THE ADMIN HEARS NOW, NOT TOMORROW ───────────────────────────────────────
const ALERT_EVERY_MS = 3 * 3600 * 1000;
const _alerted = new Map();
async function alertNow(service, kind, reason, where, opts = {}) {
  const k = service + '|' + kind;
  const now = Date.now();
  if (!opts.force && _alerted.has(k) && now - _alerted.get(k) < ALERT_EVERY_MS) return { sent: false, why: 'throttled' };
  _alerted.set(k, now);
  try {
    const { pool } = require('../store');
    await pool.query(`CREATE TABLE IF NOT EXISTS service_fault_alerts (service TEXT NOT NULL, kind TEXT NOT NULL, sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (service, kind))`);
    // Across restarts and instances: one email per provider and kind per window.
    const claim = await pool.query(
      `INSERT INTO service_fault_alerts (service, kind, sent_at) VALUES ($1,$2,NOW())
       ON CONFLICT (service, kind) DO UPDATE SET sent_at = NOW()
        WHERE service_fault_alerts.sent_at < NOW() - INTERVAL '3 hours' RETURNING sent_at`, [service, kind]);
    if (!opts.force && !claim.rowCount) return { sent: false, why: 'sent within the last 3 hours' };
  } catch (e) { console.error('[our-fault] alert claim failed: ' + e.message); }
  const to = process.env.ADMIN_ALERT_EMAIL || process.env.ADMIN_EMAIL;
  const subject = `NILDash ${KIND_WORDS[kind]}: ${service} -- customers are affected now`;
  const text = [subject, '', reason, where ? 'First seen in: ' + where : '', '',
    kind === 'billing' ? 'Top up or fix billing with ' + service + '. Every call to it fails until then; customers see a plain "try again" message, not this one.'
      : 'The key for ' + service + ' was refused. Check the key in Railway.',
    '', 'Live status: ' + String(process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, '') + '/admin/status'].filter((x) => x !== null).join('\n');
  if (!to || !process.env.RESEND_API_KEY) {
    console.error(`[our-fault] ALERT NOT SENT (${!to ? 'no ADMIN_ALERT_EMAIL / ADMIN_EMAIL' : 'no RESEND_API_KEY'}): ${subject}`);
    return { sent: false, why: !to ? 'no destination' : 'no Resend key' };
  }
  try {
    const resend = (opts.makeResend || require('./resendChecked').makeResend)(process.env.RESEND_API_KEY);
    const from = process.env.ADMIN_ALERT_FROM || process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>';
    await resend.emails.send({ from, to, subject, text });
    return { sent: true };
  } catch (e) { console.error('[our-fault] ALERT SEND FAILED: ' + e.message); return { sent: false, why: e.message }; }
}

// ── service_faults: one row per failure, for the alert and the status page ──
// Throttled in-process: the same service+reason is written at most once a
// minute, so a dead key hit ten thousand times a night is ten rows an hour,
// not ten thousand. The count is kept on the row.
const _recent = new Map();
async function record(serviceOrFault, reason, where, kind) {
  const f = isOurFault(serviceOrFault) ? serviceOrFault : null;
  const service = f ? f.service : String(serviceOrFault || 'unknown');
  const why = String(f ? f.reason : reason || 'unknown').slice(0, 500);
  const at = where || (f && f.where) || null;
  const kd = kind || (f && f.providerKind) || null;
  const k = service + '|' + why;
  const now = Date.now();
  const prev = _recent.get(k);
  if (prev && now - prev.at < 60000) { prev.n++; return; }
  const n = prev ? prev.n : 0;
  _recent.set(k, { at: now, n: 0 });
  try {
    const { pool } = require('../store');
    await pool.query(`INSERT INTO service_faults (service, reason, context, suppressed, kind) VALUES ($1,$2,$3,$4,$5)`,
      [service, why, at, n, kd]);
  } catch (e) {
    console.error('[our-fault] could not record a fault for ' + service + ': ' + e.message);
  }
}

module.exports = { OurFault, fault, isOurFault, cacheable, record, ERROR_OUTCOMES, NEGATIVE_OUTCOMES,
  providerError, classify, statusOf, alertNow, KIND_WORDS };
