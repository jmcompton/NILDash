'use strict';
// Reply capture via Resend Inbound, not Gmail scopes.
//
// WHY THIS OVER GMAIL. Reading an agent's inbox for replies needs a restricted
// Gmail scope and a CASA security assessment -- the actual blocker. Routing the
// Reply-To on outgoing outreach to a token address we control sidesteps that
// completely: the reply comes to US regardless of what client the business used
// to answer (Gmail, Outlook, IMAP, whatever), and works for an athlete with no
// mailbox connected at all, since sending never required reading anything back.
//
// THE TOKEN. outreach_logs ids are already 'out_' + 16 random hex chars
// (crypto.randomBytes(8), see workflowOrchestrator.js / draftPrewarm.js) -- 64
// bits of entropy, already unguessable. The token is just that hex suffix with
// the 'out_' dropped, so decoding needs no secret and no signature: the id space
// itself is the security property. If ids ever stop being this shape, encoding
// and decoding both live here and both have to change together.

const crypto = require('crypto');

const REPLY_DOMAIN = process.env.OUTREACH_REPLY_DOMAIN || 'reply.mynildash.com';
// Off by default -- flipping this on rewrites Reply-To on every outreach send,
// which must not happen before the DNS/webhook side is actually verified working.
const ENABLED = process.env.OUTREACH_REPLY_CAPTURE_ENABLED === '1';

const ID_RE = /^out_([0-9a-f]{16})$/;
const TOKEN_RE = /^[0-9a-f]{16}$/;

function tokenForLogId(id) {
  const m = ID_RE.exec(String(id || ''));
  return m ? m[1] : null;
}

function logIdForToken(token) {
  return TOKEN_RE.test(String(token || '')) ? 'out_' + token : null;
}

// null when capture is off (so callers omit Reply-To entirely, same as before
// this existed) or when the id isn't the shape this scheme understands.
function replyToAddressFor(logId) {
  if (!ENABLED) return null;
  const token = tokenForLogId(logId);
  return token ? `r${token}@${REPLY_DOMAIN}` : null;
}

// Pulls the outreach_logs id back out of an inbound "to" address. Case-insensitive
// on both the local part and the domain -- mail clients vary.
function logIdForReplyAddress(address) {
  const m = /^r([0-9a-f]{16})@(.+)$/i.exec(String(address || '').trim());
  if (!m) return null;
  if (m[2].toLowerCase() !== REPLY_DOMAIN.toLowerCase()) return null;
  return logIdForToken(m[1].toLowerCase());
}

// ── Auto-reply / out-of-office / bounce detection ────────────────────────────
// Both arrive within minutes and look exactly like engagement if you only check
// "did an email come back". Headers are the real signal; subject text is a
// fallback for senders that don't set them correctly.
function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const add = (name, value) => {
    if (name == null) return;
    const k = String(name).toLowerCase();
    out[k] = out[k] ? out[k] + ', ' + value : String(value == null ? '' : value);
  };
  if (Array.isArray(headers)) {
    headers.forEach((h) => { if (h) add(h.name, h.value); });
  } else if (typeof headers === 'object') {
    Object.keys(headers).forEach((k) => add(k, headers[k]));
  }
  return out;
}

const BOUNCE_SUBJECT_RE = /undeliverable|delivery status notification|mail delivery failed|returned to sender|delivery has failed|failure notice/i;
const AUTOREPLY_SUBJECT_RE = /^(re:\s*)?(auto(matic)?[\s:-]?reply|out[\s-]of[\s-]office|away from (the|my) (office|desk)|vacation (response|auto[\s-]?reply))/i;

function classifyInbound({ headers, subject, from } = {}) {
  const h = normalizeHeaders(headers);
  const autoSubmitted = (h['auto-submitted'] || '').toLowerCase();
  const contentType = (h['content-type'] || '').toLowerCase();
  const precedence = (h['precedence'] || '').toLowerCase();
  const subj = String(subject || '');
  const fromAddr = String(from || '').toLowerCase();

  // Bounce first: a delivery-status report or mailer-daemon sender is definitive,
  // not a heuristic, and a bounce can ALSO be Auto-Submitted, so this has to be
  // checked before the auto-reply rules below or a bounce would be misclassified
  // as an auto-reply.
  if (/multipart\/report/.test(contentType) && /report-type\s*=\s*delivery-status/.test(contentType)) {
    return { kind: 'bounce', reason: 'multipart/report; report-type=delivery-status' };
  }
  if (h['x-failed-recipients']) return { kind: 'bounce', reason: 'X-Failed-Recipients header' };
  if (/^(mailer-daemon|postmaster)@/.test(fromAddr)) return { kind: 'bounce', reason: 'mailer-daemon/postmaster sender' };
  if (BOUNCE_SUBJECT_RE.test(subj)) return { kind: 'bounce', reason: 'bounce-shaped subject line' };

  // RFC 3834 is the real signal for auto-replies and vacation responders; the
  // legacy X-Autoreply/X-Autorespond headers predate it but are still sent by
  // some systems. Subject is the last resort for senders that set neither.
  if (autoSubmitted && autoSubmitted !== 'no') return { kind: 'auto_reply', reason: 'Auto-Submitted: ' + autoSubmitted };
  if ((h['x-autoreply'] || '').toLowerCase() === 'yes' || h['x-autorespond'] != null) {
    return { kind: 'auto_reply', reason: 'X-Autoreply/X-Autorespond header' };
  }
  if (precedence === 'auto_reply') return { kind: 'auto_reply', reason: 'Precedence: auto_reply' };
  if (AUTOREPLY_SUBJECT_RE.test(subj)) return { kind: 'auto_reply', reason: 'out-of-office-shaped subject line' };

  return { kind: 'reply', reason: null };
}

// ── Resend/Svix webhook signature verification ───────────────────────────────
// Manual implementation (no dependency on which resend SDK version is deployed
// exposing resend.webhooks.verify) -- HMAC-SHA256 over "id.timestamp.rawBody",
// keyed by the base64-decoded secret with its whsec_ prefix stripped. The
// signature header can carry several "v1,<sig>" entries space-separated; any one
// matching is valid. Constant-time compare so this can't be timed out.
function verifyResendSignature({ payload, headers, secret, toleranceSeconds }) {
  const id = headers && (headers['svix-id'] || headers['Svix-Id']);
  const timestamp = headers && (headers['svix-timestamp'] || headers['Svix-Timestamp']);
  const sigHeader = headers && (headers['svix-signature'] || headers['Svix-Signature']);
  if (!id || !timestamp || !sigHeader || !secret) return false;

  const tolerance = toleranceSeconds || 300;
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > tolerance) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${timestamp}.${payload}`;
  const expected = crypto.createHmac('sha256', key).update(signedContent).digest('base64');
  const expectedBuf = Buffer.from(expected, 'base64');

  return String(sigHeader).split(' ').some((entry) => {
    const sig = entry.startsWith('v1,') ? entry.slice(3) : entry;
    let sigBuf;
    try { sigBuf = Buffer.from(sig, 'base64'); } catch (e) { return false; }
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}

module.exports = {
  REPLY_DOMAIN, ENABLED,
  tokenForLogId, logIdForToken, replyToAddressFor, logIdForReplyAddress,
  normalizeHeaders, classifyInbound, verifyResendSignature,
};
