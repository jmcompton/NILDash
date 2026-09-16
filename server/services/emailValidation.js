'use strict';
// ── IS THIS AN ADDRESS WE CAN SEND TO? ───────────────────────────────────────
//
// Before an address is stored as a contact, offered on a card, or stamped on
// a draft: the shape has to be an email address, and the domain has to
// publish a mail exchanger. Both are free and take milliseconds. An address
// that fails either is UNDELIVERABLE: it stays on the record with the reason,
// it is never offered as an email pitch, and the card says why so the agent
// can see that the DM or the call is what they got and not a gap.
//
// Built on services/emailVerify, which owns the MX lookup, the per-address
// cache (email_verification, ninety days) and the optional mailbox verifier.
// Three answers:
//   deliverable: true    the domain takes mail (MX found), or a verifier
//                        confirmed the mailbox
//   deliverable: false   bad syntax, no MX, or the domain does not exist:
//                        NOT offered as an email
//   deliverable: null    the check could not run (resolver timeout). Not a
//                        verdict: offered, marked unverified, checked again
//                        next time
//
// checkSyntax is a practical rule, not the full RFC: a local part, one @, a
// dotted domain with a real top-level label, nothing that a mail server would
// refuse on sight.

const EV = require('./emailVerify');

const SYNTAX = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;

function checkSyntax(email) {
  const s = String(email == null ? '' : email).trim();
  if (!s) return { ok: false, reason: 'no address' };
  if (s.length > 254) return { ok: false, reason: 'not a valid email address (too long)' };
  if (/\s/.test(s)) return { ok: false, reason: 'not a valid email address (contains a space)' };
  if ((s.match(/@/g) || []).length !== 1) return { ok: false, reason: 'not a valid email address' };
  const [local, domain] = s.split('@');
  if (/^\.|\.$|\.\./.test(local)) return { ok: false, reason: 'not a valid email address' };
  if (!SYNTAX.test(s)) return { ok: false, reason: 'not a valid email address' };
  if (/^(?:example|test|invalid|localhost)(?:\.|$)/i.test(domain) || /\.(?:example|test|invalid|local|localhost)$/i.test(domain)) {
    return { ok: false, reason: 'a placeholder domain, not a real one' };
  }
  return { ok: true, reason: null };
}

// validateMany(pool, emails, opts) -> Map(email -> { deliverable, reason, source })
// opts.verifier is passed through to emailVerify (a mailbox verifier, when
// one is configured); opts.deadlineMs bounds the whole batch.
async function validateMany(pool, emails, opts = {}) {
  const out = new Map();
  const list = Array.from(new Set((emails || []).map(EV.norm).filter(Boolean)));
  const toCheck = [];
  for (const e of list) {
    const s = checkSyntax(e);
    if (!s.ok) out.set(e, { deliverable: false, reason: s.reason, source: 'syntax' });
    else toCheck.push(e);
  }
  if (toCheck.length) {
    let verdicts = new Map();
    try { verdicts = await EV.verifyMany(pool, toCheck, { verifier: opts.verifier, deadlineMs: opts.deadlineMs, force: opts.force }); }
    catch (err) { console.warn('[email-validation] verify failed: ' + err.message); }
    for (const e of toCheck) {
      const v = verdicts.get(e);
      if (!v) { out.set(e, { deliverable: null, reason: 'the check could not run', source: 'error' }); continue; }
      if (v.result === 'invalid') out.set(e, { deliverable: false, reason: v.detail || 'undeliverable', source: v.source || 'mx' });
      else if (v.result === 'valid') out.set(e, { deliverable: true, reason: v.detail || 'the mailbox was confirmed', source: v.source || 'verifier' });
      else if (v.source === 'mx' && /no mailbox verifier configured/.test(String(v.detail || ''))) {
        // MX cleared and there is nothing else to ask: the domain takes mail.
        out.set(e, { deliverable: true, reason: 'the domain accepts mail (MX record found)', source: 'mx' });
      } else {
        out.set(e, { deliverable: null, reason: v.detail || 'could not be confirmed', source: v.source || 'unknown' });
      }
    }
  }
  return out;
}

// Every row on a ladder that carries an address gets row.emailCheck. Returns
// a summary for the log and the run row.
async function validateLadder(pool, ladder, opts = {}) {
  const rows = [];
  for (const t of ((ladder && ladder.tiers) || [])) for (const r of (t.rows || [])) if (r && r.email) rows.push(r);
  const summary = { checked: 0, deliverable: [], undeliverable: [], unverified: [] };
  if (!rows.length) return summary;
  const checks = await validateMany(pool, rows.map((r) => r.email), opts);
  for (const r of rows) {
    const v = checks.get(EV.norm(r.email)) || { deliverable: null, reason: 'not checked', source: 'none' };
    r.emailCheck = { ok: v.deliverable, reason: v.reason, source: v.source };
    summary.checked++;
    const entry = { email: EV.norm(r.email), reason: v.reason };
    if (v.deliverable === false) summary.undeliverable.push(entry);
    else if (v.deliverable === true) summary.deliverable.push(entry);
    else summary.unverified.push(entry);
  }
  if (ladder) ladder.emailCheck = summary;
  return summary;
}

module.exports = { checkSyntax, validateMany, validateLadder, SYNTAX };
