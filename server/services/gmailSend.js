// server/services/gmailSend.js
// Athlete Gmail send integration for NILDash.
//
// Uses the existing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET credentials so no
// new environment variables are needed.  The only registered redirect URI is:
//   https://mynildash.com/api/email/oauth/gmail/callback
// which dispatches to /auth/google/athlete-gmail/callback when state.type
// is 'athlete-gmail'.

'use strict';

let google;
try {
  ({ google } = require('googleapis'));
} catch (e) {
  google = null;
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',     // send as the athlete
  'https://www.googleapis.com/auth/calendar.events', // combined so one consent covers both features
  'https://www.googleapis.com/auth/userinfo.email',  // confirm identity / save gmail_address
];

// ── Credential helpers ──────────────────────────────────────────────────────

function _clientId()     { return process.env.GMAIL_CLIENT_ID; }
function _clientSecret() { return process.env.GMAIL_CLIENT_SECRET; }
function _redirectUri()  {
  return process.env.GOOGLE_REDIRECT_URI
    || 'https://mynildash.com/api/email/oauth/gmail/callback';
}

function isAvailable() {
  return !!(google && _clientId() && _clientSecret());
}

function _createClient() {
  if (!google) throw new Error('googleapis package not loaded');
  const id  = _clientId();
  const sec = _clientSecret();
  if (!id || !sec) throw new Error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not configured');
  return new google.auth.OAuth2(id, sec, _redirectUri());
}

// ── Auth URL ────────────────────────────────────────────────────────────────

/**
 * Generate the Google consent URL for an athlete's Gmail send grant.
 * @param {string} state — base64url-encoded JSON { athleteId, type:'athlete-gmail' }
 */
function getAthleteGmailAuthUrl(state) {
  const client = _createClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',   // always returns a refresh_token
    scope:       SCOPES,
    state,
  });
}

// ── Code exchange ───────────────────────────────────────────────────────────

/**
 * Exchange an authorization code for tokens.
 * Returns raw tokens: { access_token, refresh_token, expiry_date, ... }
 */
async function exchangeCode(code) {
  const client = _createClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

// ── User identity ───────────────────────────────────────────────────────────

/**
 * Look up the Google account email address using an access token.
 */
async function getGmailAddress(accessToken) {
  if (!google) throw new Error('googleapis package not loaded');
  const client = _createClient();
  client.setCredentials({ access_token: accessToken });
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const info   = await oauth2.userinfo.get();
  return info.data.email || null;
}

// ── Email send ──────────────────────────────────────────────────────────────

/**
 * Send an email as the athlete via the Gmail API.
 *
 * The message originates from the athlete's connected Gmail account —
 * Google sets the From header automatically to the authenticated account.
 *
 * @param {object} opts
 * @param {string}  opts.refreshToken  — athlete's gmail_refresh_token
 * @param {string}  opts.to            — recipient address
 * @param {string}  opts.subject
 * @param {string}  opts.body          — plain text body
 * @param {string?} opts.cc            — optional CC address (agent)
 * @returns {{ messageId: string }}
 * @throws if refresh token is expired / invalid — caller must handle and prompt reconnect
 */
async function sendEmail({ refreshToken, to, subject, body, cc }) {
  if (!google) throw new Error('googleapis package not loaded');

  const client = _createClient();
  client.setCredentials({ refresh_token: refreshToken });

  const gmailClient = google.gmail({ version: 'v1', auth: client });

  // Build a minimal RFC 2822 MIME message
  const lines = [
    `To: ${to}`,
    `Subject: ${_encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
  ];
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push('', body);

  const raw = lines.join('\r\n');
  // Gmail expects URL-safe base64 with no padding
  const encoded = Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  try {
    const res = await gmailClient.users.messages.send({
      userId:      'me',
      requestBody: { raw: encoded },
    });
    return { messageId: res.data.id };
  } catch (err) {
    // Translate token errors into a recognisable shape so the route layer can
    // return a specific "reconnect" error to the frontend.
    const msg = err.message || '';
    if (
      msg.includes('invalid_grant') ||
      msg.includes('Token has been expired') ||
      msg.includes('Invalid Credentials')
    ) {
      const e = new Error('Gmail token expired or revoked — athlete must reconnect');
      e.code = 'GMAIL_TOKEN_EXPIRED';
      throw e;
    }
    throw err;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** RFC 2047-encode a header value that may contain non-ASCII characters. */
function _encodeHeader(text) {
  if (/[^\x00-\x7F]/.test(text)) {
    return '=?UTF-8?B?' + Buffer.from(text).toString('base64') + '?=';
  }
  return text;
}

module.exports = {
  isAvailable,
  getAthleteGmailAuthUrl,
  exchangeCode,
  getGmailAddress,
  sendEmail,
};
