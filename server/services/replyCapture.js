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

// The public reply domain. Resend Inbound is CATCH-ALL -- every local part on a
// receiving domain is accepted and forwarded to the webhook -- so agents need no
// per-agent setup in Resend, and adding an agent needs no DNS change.
const REPLY_DOMAIN = process.env.OUTREACH_REPLY_DOMAIN || 'mynildash.com';
// Still recognised on the way IN so replies to already-sent token addresses keep
// matching. Nothing new is ever addressed here.
const LEGACY_TOKEN_DOMAIN = process.env.OUTREACH_LEGACY_REPLY_DOMAIN || 'reply.mynildash.com';

// Local parts an agent must never be handed, because the domain is shared with
// everything else that sends from it. Handing an agent "noreply" would point
// every bounce and every reply-to-a-system-email at that agent's outreach.
const RESERVED_LOCAL_PARTS = new Set([
  'noreply', 'no-reply', 'hello', 'help', 'support', 'admin', 'administrator',
  'info', 'contact', 'sales', 'billing', 'accounts', 'team', 'mail', 'email',
  'postmaster', 'mailer-daemon', 'abuse', 'security', 'root', 'webmaster',
  'bounce', 'bounces', 'notifications', 'notification', 'alerts', 'system',
  'reply', 'replies', 'digest', 'nildash', 'mynildash', 'app', 'api', 'www',
]);

// GIVEN NAMES, NOT JUST THE FIRST TOKEN. "John Mark Compton" -> "johnmark",
// which is what a person would write on a business card; taking only the first
// token would give "john" and collide far more often. The surname is held back
// as the first rung of the collision ladder below.
function localPartFrom(name) {
  const toks = String(name || '').trim().split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z0-9]/g, '').toLowerCase())
    .filter(Boolean);
  if (!toks.length) return null;
  const given = toks.length > 1 ? toks.slice(0, -1) : toks;
  const base = given.join('');
  return base.length ? base.slice(0, 40) : null;
}

// Candidate addresses in the order we would like to hand them out. Stays
// human-looking as long as possible: johnmark, then johnmarkc, then
// johnmarkcompton, and only then a number.
function localPartCandidates(name, email) {
  const toks = String(name || '').trim().split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z0-9]/g, '').toLowerCase()).filter(Boolean);
  const base = localPartFrom(name);
  const out = [];
  const push = (v) => { if (v && v.length >= 2 && !RESERVED_LOCAL_PARTS.has(v) && out.indexOf(v) === -1) out.push(v); };
  if (base) {
    push(base);
    const surname = toks.length > 1 ? toks[toks.length - 1] : null;
    if (surname) { push(base + surname.charAt(0)); push(base + surname); }
    for (let i = 2; i <= 20; i++) push(base + i);
  }
  // Someone with no usable name at all still needs an address.
  const fromEmail = String(email || '').split('@')[0].replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (fromEmail) { push(fromEmail); for (let i = 2; i <= 20; i++) push(fromEmail + i); }
  return out;
}

function agentReplyAddress(localPart) {
  return localPart ? `${localPart}@${REPLY_DOMAIN}` : null;
}

// ── Message-ID: the only exact anchor left ───────────────────────────────────
// Dropping the token from the address bought professionalism and cost
// certainty. The RFC822 Message-ID buys the certainty back for every client
// that threads properly: a reply echoes it in In-Reply-To and References, so
// matching on it is exact even when the same business has been pitched twice by
// the same agent -- the case sender-matching cannot resolve.
//
// SET BY US, NOT THE PROVIDER. email_message_id holds the provider's own id (a
// Gmail API id; null from Graph), which is not what gets echoed. We mint this
// one, put it on the wire, and store it.
function buildMessageId(logId) {
  const rand = crypto.randomBytes(8).toString('hex');
  return `<${String(logId || 'out')}.${rand}@${REPLY_DOMAIN}>`;
}

// Every message-id referenced by a reply, newest-intent first: In-Reply-To names
// the direct parent, References carries the whole thread. Both are checked
// because clients vary in which they populate.
function referencedMessageIds(headers) {
  const h = normalizeHeaders(headers);
  const ids = [];
  const grab = (v) => {
    const m = String(v || '').match(/<[^<>\s]+>/g);
    if (m) for (const one of m) if (ids.indexOf(one) === -1) ids.push(one);
  };
  grab(h['in-reply-to']);
  // References is oldest-first; reverse so the most recent ancestor is tried
  // before the root of a long thread.
  const refs = String(h['references'] || '').match(/<[^<>\s]+>/g) || [];
  for (const one of refs.reverse()) if (ids.indexOf(one) === -1) ids.push(one);
  return ids;
}
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

// Pulls the outreach_logs id back out of a LEGACY token address. Kept so replies
// to mail already sent under the token scheme still match. Accepts the token on
// either the legacy subdomain or the current reply domain, since the scheme
// moved domains when it moved to named addresses.
function logIdForReplyAddress(address) {
  const m = /^r([0-9a-f]{16})@(.+)$/i.exec(String(address || '').trim());
  if (!m) return null;
  const dom = m[2].toLowerCase();
  if (dom !== LEGACY_TOKEN_DOMAIN.toLowerCase() && dom !== REPLY_DOMAIN.toLowerCase()) return null;
  return logIdForToken(m[1].toLowerCase());
}

// What an inbound recipient address means to us. Exactly one of logId (legacy,
// exact) or localPart (named, needs matching) is set.
function classifyRecipient(address) {
  const addr = String(address || '').trim().toLowerCase();
  const legacy = logIdForReplyAddress(addr);
  if (legacy) return { kind: 'token', logId: legacy, localPart: null };
  const m = /^([^@]+)@(.+)$/.exec(addr);
  if (!m) return null;
  if (m[2] !== REPLY_DOMAIN.toLowerCase()) return null;
  // Plus-addressing is stripped: a mail client that turns johnmark@ into
  // johnmark+something@ must still resolve to the same agent.
  const local = m[1].split('+')[0];
  if (!local || RESERVED_LOCAL_PARTS.has(local)) return null;
  return { kind: 'named', logId: null, localPart: local };
}

function emailDomain(addr) {
  const m = /@([^@>\s]+)/.exec(String(addr || '').trim().toLowerCase());
  return m ? m[1].replace(/[>\s]+$/, '') : null;
}

// ── Matching a named reply back to one outreach ──────────────────────────────
// WITHOUT A TOKEN THERE IS NO CERTAINTY, ONLY A BEST GUESS, and this function
// exists to make the guess explicit and to say how confident it is rather than
// pretending. `rows` are this agent's sent outreaches; `from` is the replier.
//
// Precision ladder, best first:
//   exact   the reply comes from the very address we emailed. Near-certain.
//   domain  same company, different mailbox -- we mailed info@acme.com and Dana
//           replies from dana@acme.com. This is the COMMON case, not the edge
//           one: the contact ladder finds a published personal address roughly
//           never, so most outreach goes to a general inbox and comes back from
//           a human. Matching only on the exact address would silently lose
//           most real replies.
//
// Within a precision level, an un-replied outreach beats one already answered,
// and more recent beats older. When more than one row survives that, the reply
// is genuinely ambiguous -- the message carries nothing that distinguishes
// them -- so we say so instead of quietly picking.
function matchOutreach(rows, from) {
  const fromAddr = String(from || '').trim().toLowerCase();
  const fromDom = emailDomain(fromAddr);
  const sent = (rows || []).filter((r) => r && r.sent_to_email);

  const exact = sent.filter((r) => String(r.sent_to_email).toLowerCase() === fromAddr);
  const domain = fromDom ? sent.filter((r) => emailDomain(r.sent_to_email) === fromDom) : [];
  const pool = exact.length ? exact : domain;
  const precision = exact.length ? 'exact' : (domain.length ? 'domain' : null);
  if (!pool.length) {
    return { row: null, precision: null, ambiguous: false, candidates: [], reason: 'no outreach from this agent was sent to ' + (fromAddr || 'that sender') };
  }
  const rank = (r) => [r.replied_at ? 1 : 0, -(r.sent_at ? Date.parse(r.sent_at) : 0)];
  const sorted = pool.slice().sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1];
  });
  const open = sorted.filter((r) => !r.replied_at);
  // Ambiguous only when more than one row is genuinely still open at the same
  // precision. Older already-answered rows are not competing for this reply.
  const ambiguous = open.length > 1;
  return {
    row: sorted[0],
    precision,
    ambiguous,
    candidates: sorted,
    reason: ambiguous
      ? `${open.length} open outreaches from this agent to ${fromDom} — attributed to the most recent, which may be wrong`
      : null,
  };
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
  REPLY_DOMAIN, LEGACY_TOKEN_DOMAIN, ENABLED, RESERVED_LOCAL_PARTS,
  tokenForLogId, logIdForToken, replyToAddressFor, logIdForReplyAddress,
  localPartFrom, localPartCandidates, agentReplyAddress,
  buildMessageId, referencedMessageIds,
  classifyRecipient, emailDomain, matchOutreach,
  normalizeHeaders, classifyInbound, verifyResendSignature,
};
