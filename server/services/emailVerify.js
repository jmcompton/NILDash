'use strict';
// ── DOES THIS ADDRESS ACCEPT MAIL? ───────────────────────────────────────────
//
// Nothing checked, before this. screenEmail decides whether we SHOULD mail an
// address -- shape, role words, domain matching the business -- and none of that
// asks whether a mailbox exists. The only feedback loop was the bounce, which
// arrives after the send, on the agent's own sending reputation.
//
// TWO STEPS, CHEAPEST FIRST.
//
//   1. MX. Free, ~20ms, no vendor. If the domain publishes no mail exchanger it
//      takes no mail, full stop, and there is nothing to pay a verifier to tell
//      us. Catches dead domains, typos and parked domains.
//   2. HUNTER. Only for addresses that cleared MX. Reuses the key, the cache and
//      the monthly budget that hunterLookup already owns -- a second vendor for
//      one field would be a second bill, a second outage and a second thing to
//      reason about.
//
// THREE ANSWERS, AND THE THIRD IS THE IMPORTANT ONE.
//
//   valid    the verifier confirmed the mailbox
//   invalid  the domain takes no mail, or the verifier said undeliverable
//   unknown  catch-all, risky, or the check could not run
//
// `unknown` is NOT a failure and does not hold a card back. A domain configured
// to accept all mail -- which is most of Google Workspace and Microsoft 365, and
// therefore most of the independent restaurants, bike shops and gyms this
// product exists to reach -- returns accept-all from every verifier on the
// market. Treating that as bad would cost far more reach than it saves. The card
// shows the address as unverified and the agent decides, which is the same
// stance the compliance gate and the domain gate already take: proceed, and say
// what you do not know.
//
// A CHECK THAT COULD NOT RUN IS NOT A VERDICT. No Hunter key, a 429, a timeout:
// all of those are `unknown` and none of them is cached as a finding. Caching an
// outage would mark a live address dead for as long as the row survived.

const dns = require('dns').promises;
const store = require('../store');

const MX_TIMEOUT_MS = parseInt(process.env.MX_TIMEOUT_MS, 10) || 4000;
// A verification is a fact about a mailbox, and mailboxes do not churn weekly.
// Long enough that the same local business costs nothing on the second athlete.
const CACHE_DAYS = parseInt(process.env.EMAIL_VERIFY_CACHE_DAYS, 10) || 90;

const norm = (e) => String(e || '').trim().toLowerCase();
const domainOf = (e) => { const p = norm(e).split('@'); return p.length === 2 ? p[1] : null; };

// ── The store ───────────────────────────────────────────────────────────────
async function cached(pool, emails) {
  const list = (emails || []).map(norm).filter(Boolean);
  if (!list.length) return new Map();
  try {
    const rows = (await pool.query(
      `SELECT email, result, detail, source FROM email_verification
        WHERE email = ANY($1::text[])
          AND checked_at > NOW() - ($2 || ' days')::interval`,
      [list, String(CACHE_DAYS)])).rows;
    return new Map(rows.map((r) => [r.email, r]));
  } catch (e) {
    console.error('[email-verify] cache read:', e.message);
    return new Map();
  }
}

async function record(pool, email, result, detail, source) {
  try {
    await pool.query(
      `INSERT INTO email_verification (email, result, detail, source, checked_at)
       VALUES ($1,$2,$3,$4, NOW())
       ON CONFLICT (email) DO UPDATE
         SET result = EXCLUDED.result, detail = EXCLUDED.detail,
             source = EXCLUDED.source, checked_at = NOW()`,
      [norm(email), result, detail || null, source || null]);
  } catch (e) { console.error('[email-verify] write:', e.message); }
}

// ── Step 1: MX ──────────────────────────────────────────────────────────────
// Per DOMAIN, not per address, and memoised for the life of the call: a batch of
// drafts for one business is one lookup, not five.
async function hasMx(domain, memo) {
  if (!domain) return { ok: false, why: 'no domain' };
  if (memo && memo.has(domain)) return memo.get(domain);
  let out;
  try {
    const recs = await Promise.race([
      dns.resolveMx(domain),
      new Promise((_, rej) => setTimeout(() => rej(new Error('mx-timeout')), MX_TIMEOUT_MS)),
    ]);
    out = (recs && recs.length)
      ? { ok: true }
      // A domain with no MX at all publishes no route for mail. This is a real
      // NO, not a "could not check".
      : { ok: false, why: 'the domain publishes no mail server' };
  } catch (e) {
    const code = e && (e.code || e.message);
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN') {
      out = { ok: false, why: 'the domain does not exist' };
    } else {
      // A timeout or a resolver failure says nothing about the domain.
      out = { ok: null, why: 'the MX lookup did not complete (' + code + ')' };
    }
  }
  if (memo) memo.set(domain, out);
  return out;
}

// ── Step 2: Hunter ──────────────────────────────────────────────────────────
// Hunter's verifier returns a `status`. Mapped conservatively: only `invalid`
// holds a card back, and everything ambiguous is unknown.
const HUNTER_INVALID = new Set(['invalid', 'disposable']);
const HUNTER_VALID = new Set(['valid']);

function mapHunter(status) {
  const s = String(status || '').trim().toLowerCase();
  if (HUNTER_INVALID.has(s)) return { result: 'invalid', detail: `the verifier says ${s}` };
  if (HUNTER_VALID.has(s)) return { result: 'valid', detail: 'the verifier confirmed the mailbox' };
  // accept_all, webmail, unknown, and anything new Hunter adds later.
  return { result: 'unknown', detail: s ? `the verifier says ${s}` : 'the verifier could not say' };
}

// ── The one entry point ─────────────────────────────────────────────────────
// verifyMany(pool, emails, opts) -> Map(email -> { result, detail, source })
// opts.verifier lets a test supply Hunter's answer; production injects the real
// one from hunterLookup so this file never owns a key or a budget.
// CONCURRENCY, because a caller can now be a page load. This ran strictly one
// address at a time, which was fine behind an overnight job and is not fine in
// front of an agent waiting for Home: fifteen addresses became fifteen serial
// round trips. The work is almost entirely network wait, so a small fan-out
// costs nothing and turns the total into roughly the slowest one.
const CONCURRENCY = parseInt(process.env.EMAIL_VERIFY_CONCURRENCY, 10) || 5;

// A DEADLINE, because a page must not be able to hang on a resolver. Past it,
// addresses not yet checked come back `unknown` and nothing is written -- the
// same answer an outage gives, for the same reason.
async function verifyMany(pool, emails, opts = {}) {
  const list = Array.from(new Set((emails || []).map(norm).filter(Boolean)));
  const out = new Map();
  if (!list.length) return out;

  const known = opts.force ? new Map() : await cached(pool, list);
  const memo = new Map();
  const deadline = opts.deadlineMs ? Date.now() + opts.deadlineMs : null;
  const outOfTime = () => deadline !== null && Date.now() > deadline;

  const one = async (email) => {
    const hit = known.get(email);
    if (hit) { out.set(email, { result: hit.result, detail: hit.detail, source: hit.source, cached: true }); return; }

    if (outOfTime()) {
      out.set(email, { result: 'unknown', detail: 'the check ran out of time', source: 'deadline' });
      return;
    }

    const mx = await hasMx(domainOf(email), memo);
    if (mx.ok === false) {
      await record(pool, email, 'invalid', mx.why, 'mx');
      out.set(email, { result: 'invalid', detail: mx.why, source: 'mx' });
      return;
    }
    if (mx.ok === null) {
      // Could not check. Not cached -- a resolver blip must not mark an address
      // for ninety days.
      out.set(email, { result: 'unknown', detail: mx.why, source: 'mx' });
      return;
    }

    if (typeof opts.verifier !== 'function') {
      // MX passed and there is no verifier configured. That is genuinely all we
      // know, and it is not cached as a finding for the same reason.
      out.set(email, { result: 'unknown', detail: 'no mailbox verifier configured', source: 'mx' });
      return;
    }

    if (outOfTime()) {
      out.set(email, { result: 'unknown', detail: 'the check ran out of time', source: 'deadline' });
      return;
    }

    let v = null;
    try {
      // THE DEADLINE HAS TO BOUND THE CALL, NOT JUST PRECEDE IT. Checking the
      // clock and then awaiting an 8-second vendor timeout means the deadline
      // was never a deadline: one hung request and the page waits the full
      // eight. Raced against whatever time is left, so the worst case for a
      // caller in front of a page is the deadline it asked for.
      const left = deadline === null ? null : Math.max(0, deadline - Date.now());
      v = left === null
        ? await opts.verifier(email)
        : await Promise.race([
          opts.verifier(email),
          new Promise((res) => setTimeout(
            () => res({ ok: false, why: 'the verifier did not answer in time' }), left)),
        ]);
    } catch (e) {
      console.warn('[email-verify] verifier failed for ' + email + ': ' + e.message);
    }
    if (!v || v.ok === false) {
      // The call failed, or a budget refused it. Not a verdict, not cached.
      out.set(email, { result: 'unknown', detail: (v && v.why) || 'the verifier could not be reached', source: 'hunter' });
      return;
    }
    const m = mapHunter(v.status);
    await record(pool, email, m.result, m.detail, 'hunter');
    out.set(email, { ...m, source: 'hunter' });
  };

  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      try { await one(list[i]); } catch (e) {
        // One bad address must not lose the whole batch.
        console.warn('[email-verify] ' + list[i] + ': ' + e.message);
        if (!out.has(list[i])) out.set(list[i], { result: 'unknown', detail: e.message, source: 'error' });
      }
    }
  };
  const lanes = Math.max(1, Math.min(opts.concurrency || CONCURRENCY, list.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  return out;
}

module.exports = { verifyMany, hasMx, mapHunter, domainOf, norm, CACHE_DAYS };
