'use strict';
// ── THE FOOTER THE LAW REQUIRES ──────────────────────────────────────────────
//
// Every commercial email NILDash sends to a business is cold outreach under the
// CAN-SPAM Act (15 U.S.C. 7704). Two things were missing from every one of them:
//
//   1. A clear way to opt out. 7704(a)(3): a working return address or
//      "Internet-based mechanism" the recipient can use to say stop, which must
//      keep working for at least 30 days after the message went out, and which
//      must be honoured within 10 business days.
//   2. A valid physical postal address for the sender. 7704(a)(5)(A)(iii).
//
// Neither was in the pitch, the follow-up, the Closer's release, the inbox
// compose or the athlete's own brand email. The penalty is per message, and a
// nightly job sends in volume, so this is not a paperwork problem.
//
// ── WHY THIS REFUSES TO SEND WHEN IT IS NOT CONFIGURED ──────────────────────
//
// The postal address is not in this file, in the database, or in any default.
// It comes from BUSINESS_MAILING_ADDRESS and nowhere else. If that variable is
// not set, required() still says the footer is required, footerText() throws,
// and the send fails with a sentence naming the variable.
//
// That is deliberate and it is the safe direction. An outreach run that stops
// because one environment variable is unset is an afternoon of lost sending. An
// outreach run that quietly mails four hundred businesses with no postal
// address and no unsubscribe link is an unlawful mailing per message. So the
// broken state is loud and stopped rather than quiet and sending.
//
// ── WHAT IS NOT UNDER THIS RULE ────────────────────────────────────────────
//
// Mail to our own agents (the nightly digest, password reset, verification) is
// not commercial mail to a stranger, and it must NOT carry this footer: the
// unsubscribe link writes to the GLOBAL suppression list, so an agent clicking
// it would block their own address for every system we have. services/sendRules
// already sorts senders into outreach and notices; required() reads that same
// list rather than inventing a second one.

const crypto = require('crypto');

const ENV_NAME = 'BUSINESS_MAILING_ADDRESS';

// ── THE ADDRESS ─────────────────────────────────────────────────────────────
// Typed however the operator types it: one line, or several. Several lines are
// folded into one comma-separated line, because a footer is one sentence and a
// four-line block at the bottom of a cold email reads like a letterhead.
function mailingAddress() {
  const raw = String(process.env[ENV_NAME] || '').trim();
  if (!raw) return '';
  return raw
    .replace(/\r\n/g, '\n')
    .split('\n').map((l) => l.trim()).filter(Boolean).join(', ')
    .replace(/\s*,\s*,+/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 300);
}

function configured() {
  return !!mailingAddress();
}

// The sentence a human reads when a send is refused. Names the variable,
// because "not configured" sends somebody reading the code instead of the
// settings.
function problem() {
  if (configured()) return null;
  return `${ENV_NAME} is not set, so no outreach can go out: CAN-SPAM requires a `
    + `valid physical mailing address in every commercial email. Set ${ENV_NAME} `
    + `to Compton Group LLC's mailing address (street, city, state, ZIP).`;
}

function appUrl() {
  return String(process.env.APP_URL || 'https://mynildash.com').trim().replace(/\/+$/, '');
}

// ── THE LINK, SIGNED ────────────────────────────────────────────────────────
// The token carries the address so the click needs no session and no lookup --
// the recipient is a business owner who has never heard of us and will not be
// logging in to opt out. It is signed so the address cannot be swapped: an
// unsigned ?email= parameter is an open endpoint for suppressing anybody's
// address, including a competitor's whole contact list.
//
// UNSUBSCRIBE_SECRET, falling back to SESSION_SECRET, matching how
// services/crypto derives its key. Rotating the secret invalidates links in
// mail already sent, so it should not be rotated casually; the address is also
// accepted by hand on the page for exactly that case.
function secret() {
  return process.env.UNSUBSCRIBE_SECRET || process.env.SESSION_SECRET || 'nildash-dev-secret';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t + '='.repeat((4 - (t.length % 4)) % 4), 'base64').toString('utf8');
}

function normalize(email) {
  return String(email || '').trim().toLowerCase() || null;
}

function sign(payload) {
  return b64url(crypto.createHmac('sha256', secret()).update(payload).digest()).slice(0, 27);
}

// tokenFor(email) -> "<b64url address>.<signature>", or '' with no address.
function tokenFor(email) {
  const addr = normalize(email);
  if (!addr) return '';
  const body = b64url(addr);
  return body + '.' + sign(body);
}

// emailFromToken(token) -> the address, or null when the signature does not
// match. Constant-time compare: this is a signature check on a public endpoint.
function emailFromToken(token) {
  const s = String(token || '').trim();
  const dot = s.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = s.slice(0, dot);
  const sig = s.slice(dot + 1);
  const want = sign(body);
  if (sig.length !== want.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  } catch (_) { return null; }
  const addr = normalize(unb64url(body));
  if (!addr || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return null;
  return addr;
}

function unsubscribeUrl(email) {
  const t = tokenFor(email);
  return t ? `${appUrl()}/unsubscribe?u=${encodeURIComponent(t)}` : `${appUrl()}/unsubscribe`;
}

// ── WHICH SENDERS CARRY IT ──────────────────────────────────────────────────
// Outreach carries it; a notice to one of our own agents does not. The list of
// notices is services/sendRules.NOTICE_SYSTEMS -- one list, so a sender added
// there is automatically right here too. An unknown system is treated as
// outreach: a sender nobody classified is far more likely to be a new way of
// mailing a business than a new kind of digest, and being wrong in that
// direction adds a footer rather than breaking a law.
const NEVER = new Set(['password-reset', 'verification', 'reset', 'verify']);
function required(system) {
  const s = String(system || '').trim().toLowerCase();
  if (!s) return true;
  if (NEVER.has(s)) return false;
  try {
    const { NOTICE_SYSTEMS } = require('./sendRules');
    if (NOTICE_SYSTEMS && NOTICE_SYSTEMS.has(s)) return false;
  } catch (_) { /* a missing rulebook is not a reason to drop the footer */ }
  return true;
}

// ── THE FOOTER ITSELF ───────────────────────────────────────────────────────
// Short, plain, and it says who is writing and why they got it. "Unsubscribe"
// is the word people look for; anything cleverer is a dark pattern and reads
// like one.
const MARKER = 'nildash-can-spam';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function lines(email, opts = {}) {
  const addr = mailingAddress();
  if (!addr) { const e = new Error(problem()); e.code = 'CANSPAM_UNCONFIGURED'; throw e; }
  const who = String((opts && opts.senderName) || '').trim();
  return {
    why: who
      ? `You received this message because ${who} is working with an athlete near your business.`
      : 'You received this message because an athlete we represent is looking for local partners near your business.',
    url: unsubscribeUrl(email),
    address: addr,
  };
}

function footerText(email, opts = {}) {
  const l = lines(email, opts);
  return [l.why, `Unsubscribe: ${l.url}`, l.address].join('\n');
}

function footerHtml(email, opts = {}) {
  const l = lines(email, opts);
  return '<div data-' + MARKER + '="1" style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;'
    + 'font-family:sans-serif;font-size:12px;line-height:1.5;color:#6b7280">'
    + esc(l.why) + '<br>'
    + '<a href="' + esc(l.url) + '" style="color:#6b7280;text-decoration:underline">Unsubscribe</a> from future emails.<br>'
    + esc(l.address)
    + '</div>';
}

// ── APPENDING IT ────────────────────────────────────────────────────────────
// IDEMPOTENT, for the same reason services/signature is: a draft can be
// regenerated, edited, re-saved and re-sent, and a business reading two
// unsubscribe links wonders which one works. The check is on the marker in the
// markup, not on a flag somebody has to remember to clear.
function hasFooter(body) {
  const s = String(body == null ? '' : body);
  return s.indexOf(MARKER) !== -1 || /unsubscribe\?u=/i.test(s);
}

function appendText(body, email, opts = {}) {
  const b = String(body == null ? '' : body).replace(/\s+$/, '');
  if (hasFooter(b)) return b;
  return b + '\n\n-- \n' + footerText(email, opts);
}

function appendHtml(html, email, opts = {}) {
  const h = String(html == null ? '' : html).replace(/\s+$/, '');
  if (hasFooter(h)) return h;
  return h + footerHtml(email, opts);
}

module.exports = {
  ENV_NAME, MARKER,
  mailingAddress, configured, problem, appUrl, normalize,
  tokenFor, emailFromToken, unsubscribeUrl,
  required, footerText, footerHtml, hasFooter, appendText, appendHtml,
};
