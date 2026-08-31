// server/services/providers/gmail.js
// Gmail OAuth2 + message fetch via Google APIs.
// Requires npm package: googleapis
// Env vars: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI

'use strict';

let google;
try {
  ({ google } = require('googleapis'));
} catch (e) {
  // googleapis not installed yet — routes will return 501 until installed
  google = null;
}

// Declared Google-verification scopes ONLY. gmail.send + calendar.events power
// the combined "Connect Google" flow (send email + push calendar events); one
// consent covers both. Do NOT add gmail.readonly / gmail.compose (RESTRICTED —
// would force a CASA assessment) or userinfo.profile (unused; email is enough).
const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const SCOPES = [
  SEND_SCOPE,
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
];

// ── ASKING IS NOT GETTING ───────────────────────────────────────────────────
// gmail.send is a SENSITIVE scope, so Google renders it as its own checkbox on
// the consent screen. Untick it and the exchange still succeeds: a real token, a
// real refresh token, a working Calendar grant -- and a 403 the first time
// anyone presses Send. The granted set is the only thing that answers "can this
// mailbox send", and it comes back in the token response, once, here.
function parseGrantedScopes(tokens) {
  const raw = tokens && tokens.scope;
  if (!raw) return null;                       // Google said nothing: unknown, not empty
  const list = String(raw).split(/\s+/).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}
// null in => null out. "We never looked" must not collapse into "it cannot send".
function hasSendScope(scopes) {
  if (!Array.isArray(scopes)) return null;
  return scopes.includes(SEND_SCOPE);
}

function isAvailable() {
  return !!(google &&
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET);
}

function createOAuth2Client() {
  if (!google) throw new Error('googleapis package not installed. Run: npm install googleapis');
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI || 'https://mynildash.com/api/email/oauth/gmail/callback'
  );
}

/**
 * Step 1: generate the Google OAuth consent URL.
 */
function getAuthUrl(stateToken) {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',          // force refresh_token to be returned every time
    scope: SCOPES,
    state: stateToken,
  });
}

/**
 * Step 2: exchange authorization code for tokens.
 * Returns { accessToken, refreshToken, expiry, email, displayName }
 */
async function exchangeCode(code) {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Fetch user profile
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const profile = await oauth2.userinfo.get();

  const grantedScopes = parseGrantedScopes(tokens);
  return {
    accessToken:  tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiry:       tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    email:        profile.data.email,
    displayName:  profile.data.name || profile.data.email,
    // Carried out of the exchange rather than dropped on the floor. This return
    // used to end at displayName, which is how the one fact that decides whether
    // a mailbox can send was thrown away at the exact moment we held it.
    grantedScopes,
    canSend: hasSendScope(grantedScopes),
  };
}

// Ask Google what a token is actually good for. Used by the audit script on
// accounts that predate the column, where there is nothing stored to read.
// Read-only: it inspects a token, it does not send or refresh anything.
async function tokenScopes(accessToken) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token='
    + encodeURIComponent(accessToken));
  if (!r.ok) throw new Error('tokeninfo ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const body = await r.json();
  return parseGrantedScopes(body);
}

/**
 * Refresh an expired access token using the stored refresh token.
 * Returns { accessToken, expiry }
 */
async function refreshAccessToken(refreshToken) {
  const client = createOAuth2Client();
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  return {
    accessToken: credentials.access_token,
    expiry: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
  };
}

/**
 * Fetch recent messages since a given historyId or timestamp.
 * Returns array of normalized message objects.
 * maxResults: max messages to pull per sync cycle (default 50).
 */
async function fetchMessages(accessToken, refreshToken, cursor, maxResults = 50) {
  const client = createOAuth2Client();
  client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });

  const gmail = google.gmail({ version: 'v1', auth: client });

  // Build list query
  const listParams = {
    userId: 'me',
    maxResults,
    includeSpamTrash: false,
  };

  // cursor is a pageToken or a date-based q string
  if (cursor && cursor.startsWith('after:')) {
    listParams.q = cursor;
  } else if (cursor) {
    listParams.pageToken = cursor;
  } else {
    // First sync: last 90 days
    const d = new Date();
    d.setDate(d.getDate() - 90);
    const yyyymmdd = d.toISOString().slice(0, 10).replace(/-/g, '/');
    listParams.q = `after:${yyyymmdd}`;
  }

  const list = await gmail.users.messages.list(listParams);
  const messages = list.data.messages || [];
  const nextCursor = list.data.nextPageToken || null;

  const normalized = [];
  for (const msg of messages) {
    try {
      const full = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });
      normalized.push(normalizeGmailMessage(full.data));
    } catch (e) {
      console.error('[gmail] Failed to fetch message', msg.id, e.message);
    }
  }

  return { messages: normalized, nextCursor };
}

/**
 * Send an email via Gmail API.
 * attachments: [{ filename, mimeType, data }] where data is base64-encoded string
 */
async function sendEmail(accessToken, refreshToken, { to, cc, subject, bodyHtml, threadId, attachments, replyTo, messageId }) {
  const client = createOAuth2Client();
  client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: client });

  // Do NOT call gmail.users.getProfile here — it requires gmail.readonly/modify,
  // which we no longer request. On messages.send with userId:'me', Gmail sets the
  // From header to the authenticated account automatically, so we omit it.
  const mime = buildMimeMessage({ to, cc, subject, bodyHtml, threadId, attachments: attachments || [], replyTo, messageId });
  const encoded = Buffer.from(mime).toString('base64url');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encoded,
      ...(threadId ? { threadId } : {}),
    },
  });

  return { providerMessageId: res.data.id, providerThreadId: res.data.threadId };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeGmailMessage(data) {
  const headers = {};
  (data.payload?.headers || []).forEach(h => { headers[h.name.toLowerCase()] = h.value; });

  const { text, html } = extractBody(data.payload);
  const fromRaw = headers['from'] || '';
  const { address: fromAddress, name: fromName } = parseAddress(fromRaw);

  return {
    providerMessageId: data.id,
    providerThreadId:  data.threadId,
    subject:           headers['subject'] || '(no subject)',
    fromAddress,
    fromName,
    toAddresses:       parseAddressList(headers['to'] || ''),
    ccAddresses:       parseAddressList(headers['cc'] || ''),
    bodyText:          text,
    bodyHtml:          html,
    sentAt:            data.internalDate ? new Date(parseInt(data.internalDate)) : new Date(),
    isRead:            !(data.labelIds || []).includes('UNREAD'),
    hasAttachments:    (data.payload?.parts || []).some(p => p.filename && p.filename.length > 0),
    direction:         (data.labelIds || []).includes('SENT') ? 'sent' : 'received',
  };
}

function extractBody(payload) {
  if (!payload) return { text: '', html: '' };

  let text = '';
  let html = '';

  function walk(part) {
    if (!part) return;
    const mime = part.mimeType || '';
    const data = part.body?.data;
    if (data) {
      const decoded = Buffer.from(data, 'base64url').toString('utf8');
      if (mime === 'text/plain') text = decoded;
      else if (mime === 'text/html') html = decoded;
    }
    if (part.parts) part.parts.forEach(walk);
  }

  walk(payload);
  return { text, html };
}

function parseAddress(raw) {
  const match = raw.match(/^"?([^"<]+)"?\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim(), address: match[2].trim().toLowerCase() };
  return { name: '', address: raw.trim().toLowerCase() };
}

function parseAddressList(raw) {
  if (!raw) return [];
  return raw.split(/,\s*/).map(a => a.trim()).filter(Boolean);
}

function encodeHeaderValue(value) {
  const s = String(value || '');
  if (/[^\x00-\x7F]/.test(s)) {
    return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
  }
  return s;
}

function buildMimeMessage({ from, to, cc, subject, bodyHtml, threadId, attachments, replyTo, messageId }) {
  const toStr = Array.isArray(to) ? to.join(', ') : (to || '');
  const ccStr = cc && cc.length ? `Cc: ${Array.isArray(cc) ? cc.join(', ') : cc}` : '';
  // From is optional — Gmail sets it to the authenticated account on send.
  const fromLines = from ? [`From: ${from}`] : [];
  const replyToLines = replyTo ? [`Reply-To: ${replyTo}`] : [];
  // Ours, so a reply's In-Reply-To echoes something we can look up. Gmail may
  // still substitute its own on send, which is why message-id matching is a
  // best-effort FIRST pass and sender matching remains the fallback.
  const msgIdLines = messageId ? [`Message-ID: ${messageId}`] : [];

  if (!attachments || attachments.length === 0) {
    // Simple email — multipart/alternative (existing behaviour)
    const boundary = `nildash_${Date.now()}`;
    return [
      ...fromLines,
      `To: ${toStr}`,
      ...(ccStr ? [ccStr] : []),
      ...replyToLines,
      ...msgIdLines,
      `Subject: ${encodeHeaderValue(subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      bodyHtml || '',
      `--${boundary}--`,
    ].join('\r\n');
  }

  // Email with attachments — multipart/mixed wrapping multipart/alternative + parts
  const outerB = `nildash_outer_${Date.now()}`;
  const innerB = `nildash_inner_${Date.now() + 1}`;

  const lines = [
    ...fromLines,
    `To: ${toStr}`,
    ...(ccStr ? [ccStr] : []),
    ...replyToLines,
    ...msgIdLines,
    `Subject: ${encodeHeaderValue(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${outerB}"`,
    '',
    `--${outerB}`,
    `Content-Type: multipart/alternative; boundary="${innerB}"`,
    '',
    `--${innerB}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    bodyHtml || '',
    `--${innerB}--`,
  ];

  for (const att of attachments) {
    // Split base64 into 76-char lines per RFC 2045
    const b64Lines = (att.data || '').match(/.{1,76}/g) || [];
    lines.push(
      `--${outerB}`,
      `Content-Type: ${att.mimeType || 'application/octet-stream'}; name="${att.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${att.filename}"`,
      '',
      ...b64Lines,
    );
  }

  lines.push(`--${outerB}--`);
  return lines.join('\r\n');
}

module.exports = { isAvailable, getAuthUrl, exchangeCode, refreshAccessToken, fetchMessages, sendEmail,
  SEND_SCOPE, SCOPES, parseGrantedScopes, hasSendScope, tokenScopes };
