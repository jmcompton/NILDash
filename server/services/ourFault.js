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

// ── service_faults: one row per failure, for the alert and the status page ──
// Throttled in-process: the same service+reason is written at most once a
// minute, so a dead key hit ten thousand times a night is ten rows an hour,
// not ten thousand. The count is kept on the row.
const _recent = new Map();
async function record(serviceOrFault, reason, where) {
  const f = isOurFault(serviceOrFault) ? serviceOrFault : null;
  const service = f ? f.service : String(serviceOrFault || 'unknown');
  const why = String(f ? f.reason : reason || 'unknown').slice(0, 500);
  const at = where || (f && f.where) || null;
  const k = service + '|' + why;
  const now = Date.now();
  const prev = _recent.get(k);
  if (prev && now - prev.at < 60000) { prev.n++; return; }
  const n = prev ? prev.n : 0;
  _recent.set(k, { at: now, n: 0 });
  try {
    const { pool } = require('../store');
    await pool.query(`INSERT INTO service_faults (service, reason, context, suppressed) VALUES ($1,$2,$3,$4)`,
      [service, why, at, n]);
  } catch (e) {
    console.error('[our-fault] could not record a fault for ' + service + ': ' + e.message);
  }
}

module.exports = { OurFault, fault, isOurFault, cacheable, record, ERROR_OUTCOMES, NEGATIVE_OUTCOMES };
