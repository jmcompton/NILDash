// server/services/providers/outlook.js
// Microsoft OAuth2 + Graph API for Outlook / Microsoft 365.
//
// Deps: @azure/msal-node, @microsoft/microsoft-graph-client -- both installed
// and declared in package.json.
//
// Env vars, none of which are set yet: OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET,
// OUTLOOK_REDIRECT_URI, OUTLOOK_TENANT_ID. Until they are, isAvailable() is
// false and /api/email/oauth/outlook refuses rather than half-starting a flow.
// The Connect Outlook button stays hidden behind OUTLOOK_ENABLED in
// public/email.js until this has been run against a real tenant.

'use strict';
// ── TOKENS: MICROSOFT IDENTITY PLATFORM v2, DIRECTLY ────────────────────────
//
// This used @azure/msal-node for the code exchange and the refresh. MSAL does
// not hand back the refresh token: acquireTokenByCode keeps it in MSAL's own
// in-memory cache and the result has no refreshToken field, so every Outlook
// connection was saved with refresh_token = null and died an hour later, at
// the first send after the access token expired. The token endpoint is three
// form posts; called directly it returns the refresh token, and on refresh it
// returns a NEW one (Microsoft rotates them), which the caller stores
// (emailStore.freshOutlookTokens, emailSync, the preflight).
//
// Env: OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, OUTLOOK_REDIRECT_URI,
// OUTLOOK_TENANT_ID ('common' when unset: any work, school or personal
// Microsoft account). isAvailable() is false until the first two are set, and
// /api/email/oauth/outlook refuses rather than half-starting a flow.

let MicrosoftGraph;
try { MicrosoftGraph = require('@microsoft/microsoft-graph-client'); } catch (e) { MicrosoftGraph = null; }

// ── THE SMALLEST ASK THAT WORKS ─────────────────────────────────────────────
// SEND (the default connection): Mail.Send to send as the agent, User.Read
// for the mailbox address, offline_access to stay connected. Replies to a
// pitch do not need any read permission: every pitch carries a Reply-To that
// routes the answer to our inbound address (services/replyCapture).
// READ (the optional upgrade, "also read replies from this mailbox"): adds
// Mail.Read, for answers that bypass the Reply-To.
// Mail.ReadWrite is NOT asked for: it was needed only to create a draft and
// stamp our own Message-ID on it before sending. None of these is marked
// "admin consent required" by Microsoft; whether a customer can consent
// alone is the tenant's user-consent setting, handled by the admin path
// (routes/email: consent_required -> /microsoft-consent.html).
const G = (x) => 'https://graph.microsoft.com/' + x;
const SCOPES_SEND = [G('Mail.Send'), G('User.Read'), 'offline_access'];
const SCOPES_READ = [G('Mail.Send'), G('Mail.Read'), G('User.Read'), 'offline_access'];
const SCOPES = SCOPES_SEND;
const canReadFrom = (granted) => (granted || []).some((g) => /Mail\.Read(Write)?$/i.test(String(g)));
const DEFAULT_REDIRECT = 'https://mynildash.com/api/email/oauth/outlook/callback';

function isAvailable() {
  return !!(MicrosoftGraph && process.env.OUTLOOK_CLIENT_ID && process.env.OUTLOOK_CLIENT_SECRET);
}
const tenant = () => (process.env.OUTLOOK_TENANT_ID || 'common').trim() || 'common';
const redirectUri = () => (process.env.OUTLOOK_REDIRECT_URI || DEFAULT_REDIRECT).trim();
const authority = () => `https://login.microsoftonline.com/${encodeURIComponent(tenant())}/oauth2/v2.0`;

function getAuthUrl(stateToken, opts = {}) {
  if (!isAvailable()) throw new Error('Outlook is not configured on this server (OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET)');
  const q = new URLSearchParams({
    client_id: process.env.OUTLOOK_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(),
    response_mode: 'query', scope: (opts.read ? SCOPES_READ : SCOPES_SEND).join(' '), state: stateToken,
    // Always the account picker: an agent signed in to a personal Outlook in
    // the same browser must be able to choose the work mailbox.
    prompt: 'select_account',
  });
  return `${authority()}/authorize?${q.toString()}`;
}

// The token endpoint. A refused grant throws with Microsoft's own error code
// and description (e.g. invalid_grant: AADSTS700082 the refresh token has
// expired), and .status, so ourFault classifies it.
async function tokenRequest(params) {
  const body = new URLSearchParams({
    client_id: process.env.OUTLOOK_CLIENT_ID, client_secret: process.env.OUTLOOK_CLIENT_SECRET,
    // A refresh asks for what was already granted (.default), so a send-only
    // connection and an upgraded one refresh the same way.
    scope: 'https://graph.microsoft.com/.default offline_access', ...params,
  });
  const r = await fetch(`${authority()}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (_) { j = null; }
  if (!r.ok || !j || !j.access_token) {
    const e = new Error(`Microsoft token endpoint HTTP ${r.status}: ${(j && (j.error + (j.error_description ? ': ' + String(j.error_description).split('\r\n')[0] : ''))) || text.slice(0, 200)}`);
    e.status = r.status; e.code = j && j.error;
    try { require('../ourFault').providerError('outlook', e, 'outlook.token'); } catch (_) {}
    throw e;
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token || null,
    expiry: j.expires_in ? new Date(Date.now() + Number(j.expires_in) * 1000) : null,
    scope: j.scope || '',
  };
}

async function exchangeCode(code, opts = {}) {
  if (!isAvailable()) throw new Error('Outlook is not configured on this server');
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), scope: (opts.read ? SCOPES_READ : SCOPES_SEND).join(' ') });
  if (!t.refreshToken) throw new Error('Microsoft did not return a refresh token (offline_access was not granted), so this mailbox could not stay connected. Reconnect and accept every permission.');
  const profile = await getGraphClient(t.accessToken).api('/me').select('mail,userPrincipalName,displayName').get();
  const granted = t.scope.split(/\s+/).filter(Boolean);
  return {
    accessToken: t.accessToken, refreshToken: t.refreshToken, expiry: t.expiry,
    email: String(profile.mail || profile.userPrincipalName || '').toLowerCase(),
    displayName: profile.displayName || profile.mail || profile.userPrincipalName,
    grantedScopes: granted,
    // Mail.Send can be refused on the consent screen (or by a tenant policy);
    // a mailbox that cannot send must not claim it can.
    canSend: granted.length ? granted.some((g) => /Mail\.Send$/i.test(g)) : null,
    canRead: canReadFrom(granted),
  };
}

// ── WHEN THE TENANT SAYS "ASK YOUR ADMIN" ──────────────────────────────────
// A tenant that blocks user consent sends the agent back with an error and an
// AADSTS code: 65001 (consent required), 90094 / 90095 (admin approval
// needed / requested), or consent_required / access_denied with one of those
// in the description. isConsentError reads that; adminConsentUrl is the
// link the agent's IT admin opens to approve NILDash for the whole tenant.
function isConsentError(error, description) {
  const d = String(description || '');
  // 65004: the user pressed Cancel themselves. Not an admin matter.
  if (/AADSTS65004/.test(d)) return false;
  return /consent_required|interaction_required/i.test(String(error || '')) || /AADSTS(65001|90094|90095|90008)/.test(d)
    || (/access_denied/i.test(String(error || '')) && /admin|approval|consent/i.test(d));
}
const adminRedirectUri = () => (process.env.OUTLOOK_ADMIN_REDIRECT_URI || redirectUri().replace(/\/callback$/, '/admin-callback')).trim();
function adminConsentUrl(opts = {}) {
  const q = new URLSearchParams({
    client_id: process.env.OUTLOOK_CLIENT_ID || '',
    scope: (opts.read ? SCOPES_READ : SCOPES_SEND).filter((x) => x !== 'offline_access').join(' '),
    redirect_uri: adminRedirectUri(), state: opts.state || 'admin',
  });
  // 'organizations' lets the admin sign in to their own tenant.
  return `https://login.microsoftonline.com/${encodeURIComponent(opts.tenant || 'organizations')}/v2.0/adminconsent?${q.toString()}`;
}

// -> { accessToken, refreshToken (the NEW one; store it), expiry }
async function refreshAccessToken(refreshToken) {
  if (!isAvailable()) throw new Error('Outlook is not configured on this server');
  if (!refreshToken) { const e = new Error('no refresh token stored for this Outlook mailbox; reconnect it'); e.status = 401; throw e; }
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  return { accessToken: t.accessToken, refreshToken: t.refreshToken || refreshToken, expiry: t.expiry };
}

async function fetchMessages(accessToken, _refreshToken, cursor, maxResults = 50, opts = {}) {
  if (!MicrosoftGraph) throw new Error('@microsoft/microsoft-graph-client not installed');
  const client = getGraphClient(accessToken);

  // internetMessageId is selected because it is the same anchor sendEmail
  // stamps on the way out; without it an inbound reply can only be matched by
  // sender, which is exactly the ambiguity the anchor exists to remove.
  let endpoint = `/me/messages?$top=${maxResults}&$orderby=receivedDateTime desc&$select=id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,body,bodyPreview,receivedDateTime,isRead,hasAttachments,isDraft,sentDateTime,flag`;

  if (cursor && cursor.startsWith('$skip')) {
    endpoint += `&${cursor}`;
  }

  const result = await client.api(endpoint).get();
  const messages = result.value || [];
  const nextLink = result['@odata.nextLink'];
  const nextCursor = nextLink ? extractSkip(nextLink) : null;

  const normalized = messages.map((m) => normalizeGraphMessage(m, opts.ownAddress));
  return { messages: normalized, nextCursor };
}

// ── SEND: ONE CALL, ON Mail.Send ALONE ───────────────────────────────────────
//
// /me/sendMail for a new message; /me/messages/{id}/reply when answering a
// thread we can find. Both need only Mail.Send. The earlier draft-stamp-send
// path set our own Message-ID, which needs Mail.ReadWrite -- a second, broader
// mail permission on every connection, for an anchor the Reply-To already
// gives us: the business's answer goes to the agent's reply address
// (services/replyCapture) whichever Message-ID the message carries. Our id
// rides along as an X- header. The Message-ID on the wire is Microsoft's and
// cannot be read back without a read permission, so the result says
// messageIdUnknown: the caller stores no anchor rather than one that never
// shipped, and a reply is matched by the Reply-To address and the sender.
async function sendEmail(accessToken, _refreshToken, opts = {}) {
  if (!MicrosoftGraph) throw new Error('@microsoft/microsoft-graph-client not installed');
  const { to, cc, subject, bodyHtml, threadId, replyToMessageId, attachments, replyTo, messageId } = opts;
  const client = getGraphClient(accessToken);
  const fileAtts = (attachments || []).map((att) => ({
    '@odata.type': '#microsoft.graph.fileAttachment', name: att.filename,
    contentType: att.mimeType || 'application/octet-stream', contentBytes: att.data,
  }));
  const headers = messageId ? [{ name: 'X-NILDash-Message-Id', value: String(messageId).slice(0, 200) }] : [];

  // A reply needs the message id; a conversation id is resolved to its latest
  // message, which needs Mail.Read -- without it this sends as a new message.
  const target = await resolveReplyTarget(client, { replyToMessageId, threadId });
  if (target) {
    await client.api(`/me/messages/${target}/reply`).post({
      message: {
        ...(to ? { toRecipients: toAddressList(to) } : {}),
        ...(cc ? { ccRecipients: toAddressList(cc) } : {}),
        ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
        ...(fileAtts.length ? { attachments: fileAtts } : {}),
      },
      comment: bodyHtml || '',
    });
    return { providerMessageId: null, providerThreadId: threadId || null, messageId: null, messageIdStamped: false, messageIdUnknown: true };
  }
  await client.api('/me/sendMail').post({
    message: {
      subject: subject || '',
      body: { contentType: 'HTML', content: bodyHtml || '' },
      toRecipients: toAddressList(to),
      ...(cc ? { ccRecipients: toAddressList(cc) } : {}),
      ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
      ...(fileAtts.length ? { attachments: fileAtts } : {}),
      ...(headers.length ? { internetMessageHeaders: headers } : {}),
    },
    saveToSentItems: true,
  });
  return { providerMessageId: null, providerThreadId: null, messageId: null, messageIdStamped: false, messageIdUnknown: true };
}

// Graph's reply endpoints take a MESSAGE id. providerThreadId is a
// conversationId -- a different identifier space entirely -- so posting it to
// /me/messages/{id}/createReply was a guaranteed 404. Resolve the conversation
// to its most recent message, which is what "reply to this thread" means.
async function resolveReplyTarget(client, { replyToMessageId, threadId }) {
  if (replyToMessageId) return replyToMessageId;
  if (!threadId) return null;
  try {
    const r = await client.api('/me/messages')
      .filter(`conversationId eq '${String(threadId).replace(/'/g, "''")}'`)
      .orderby('receivedDateTime desc')
      .top(1)
      .select('id')
      .get();
    const hit = (r && r.value && r.value[0] && r.value[0].id) || null;
    if (!hit) console.warn('[outlook] conversation ' + threadId + ' has no message to reply to; sending as a new message');
    return hit;
  } catch (e) {
    // Better a delivered message with a broken thread than no message.
    console.warn('[outlook] could not resolve a reply target (' + e.message + '); sending as a new message');
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getGraphClient(accessToken) {
  return MicrosoftGraph.Client.init({
    authProvider: done => done(null, accessToken),
  });
}

function normalizeGraphMessage(msg, ownAddress) {
  const from = msg.from?.emailAddress || {};
  // SENT IS "FROM THIS MAILBOX". It was sentDateTime && !isDraft -- but every
  // received message has a sentDateTime too (the sender's), so every reply
  // read as one of ours and nothing ever arrived in the inbox.
  const own = String(ownAddress || '').toLowerCase();
  const fromAddr = (from.address || '').toLowerCase();
  return {
    providerMessageId: msg.id,
    providerThreadId:  msg.conversationId,
    internetMessageId: msg.internetMessageId || null,
    subject:           msg.subject || '(no subject)',
    fromAddress:       (from.address || '').toLowerCase(),
    fromName:          from.name || '',
    toAddresses:       (msg.toRecipients || []).map(r => r.emailAddress?.address || ''),
    ccAddresses:       (msg.ccRecipients || []).map(r => r.emailAddress?.address || ''),
    bodyText:          msg.bodyPreview || '',
    bodyHtml:          msg.body?.contentType === 'HTML' ? msg.body.content : null,
    sentAt:            msg.sentDateTime ? new Date(msg.sentDateTime) : new Date(msg.receivedDateTime),
    isRead:            msg.isRead || false,
    hasAttachments:    msg.hasAttachments || false,
    direction:         msg.isDraft ? 'draft' : (own && fromAddr === own ? 'sent' : 'received'),
  };
}

function toAddressList(addresses) {
  if (!addresses) return [];
  const list = Array.isArray(addresses) ? addresses : [addresses];
  return list.map(a => ({ emailAddress: { address: a } }));
}

function extractSkip(nextLink) {
  const match = nextLink.match(/\$skip=(\d+)/);
  return match ? `$skip=${match[1]}` : null;
}

module.exports = { isAvailable, getAuthUrl, exchangeCode, refreshAccessToken, fetchMessages, sendEmail, normalizeGraphMessage, adminConsentUrl, isConsentError,
  SCOPES, SCOPES_SEND, SCOPES_READ, canReadFrom, redirectUri, adminRedirectUri, DEFAULT_REDIRECT };
