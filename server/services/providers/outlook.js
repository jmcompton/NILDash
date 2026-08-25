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

let msal, MicrosoftGraph;
try {
  msal = require('@azure/msal-node');
  MicrosoftGraph = require('@microsoft/microsoft-graph-client');
} catch (e) {
  msal = null;
  MicrosoftGraph = null;
}

const SCOPES = [
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
];

function isAvailable() {
  return !!(msal && process.env.OUTLOOK_CLIENT_ID && process.env.OUTLOOK_CLIENT_SECRET);
}

function getMsalConfig() {
  return {
    auth: {
      clientId:     process.env.OUTLOOK_CLIENT_ID,
      clientSecret: process.env.OUTLOOK_CLIENT_SECRET,
      authority:    `https://login.microsoftonline.com/${process.env.OUTLOOK_TENANT_ID || 'common'}`,
    },
  };
}

function getAuthUrl(stateToken) {
  if (!msal) throw new Error('@azure/msal-node not installed. Run: npm install @azure/msal-node');
  const app = new msal.ConfidentialClientApplication(getMsalConfig());
  return app.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: process.env.OUTLOOK_REDIRECT_URI || 'https://mynildash.com/api/email/oauth/outlook/callback',
    state: stateToken,
  });
}

async function exchangeCode(code) {
  if (!msal) throw new Error('@azure/msal-node not installed');
  const app = new msal.ConfidentialClientApplication(getMsalConfig());
  const result = await app.acquireTokenByCode({
    code,
    scopes: SCOPES,
    redirectUri: process.env.OUTLOOK_REDIRECT_URI || 'https://mynildash.com/api/email/oauth/outlook/callback',
  });

  // Fetch user profile via Graph
  const client = getGraphClient(result.accessToken);
  const profile = await client.api('/me').get();

  return {
    accessToken:  result.accessToken,
    refreshToken: result.refreshToken || null,
    expiry:       result.expiresOn ? new Date(result.expiresOn) : null,
    email:        profile.mail || profile.userPrincipalName,
    displayName:  profile.displayName || profile.mail,
  };
}

async function refreshAccessToken(refreshToken) {
  if (!msal) throw new Error('@azure/msal-node not installed');
  const app = new msal.ConfidentialClientApplication(getMsalConfig());
  const result = await app.acquireTokenByRefreshToken({
    refreshToken,
    scopes: SCOPES,
  });
  return {
    accessToken: result.accessToken,
    expiry: result.expiresOn ? new Date(result.expiresOn) : null,
  };
}

async function fetchMessages(accessToken, _refreshToken, cursor, maxResults = 50) {
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

  const normalized = messages.map(normalizeGraphMessage);
  return { messages: normalized, nextCursor };
}

// ── SEND: DRAFT, STAMP, SEND ────────────────────────────────────────────────
//
// Not /me/sendMail, which is one call and would be simpler. Reply capture needs
// our own RFC2822 Message-ID on the wire -- the business's reply echoes it in
// In-Reply-To, and that echo is the only exact anchor we have when the same
// agent has pitched the same business twice. Graph will not let you set
// internetMessageId on a message you send in one shot; it is writable only while
// isDraft is true. So: create the draft, stamp it, send it.
//
// Both the new-message and the reply path go through the same three steps, so
// there is one story about where the Message-ID comes from rather than two.
//
// AND WE READ BACK WHAT STUCK. A tenant can refuse the stamp. If we returned the
// id we intended rather than the one Graph actually assigned, every reply to
// that message would fail to match and the follow-up cadence would keep sending
// to someone who had already answered. The confirmed value is what comes back.
async function sendEmail(accessToken, _refreshToken, opts = {}) {
  if (!MicrosoftGraph) throw new Error('@microsoft/microsoft-graph-client not installed');
  const { to, cc, subject, bodyHtml, threadId, replyToMessageId,
          attachments, replyTo, messageId } = opts;
  const client = getGraphClient(accessToken);

  const target = await resolveReplyTarget(client, { replyToMessageId, threadId });

  let draft;
  let patch;
  if (target) {
    // createReply hands back a draft already addressed to the original sender
    // and carrying the quoted original underneath.
    draft = await client.api(`/me/messages/${target}/createReply`).post({});
    patch = {
      body: { contentType: 'HTML', content: (bodyHtml || '') + (draft.body?.content || '') },
      ...(to ? { toRecipients: toAddressList(to) } : {}),
      ...(cc ? { ccRecipients: toAddressList(cc) } : {}),
      ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
    };
  } else {
    draft = await client.api('/me/messages').post({
      subject: subject || '',
      body: { contentType: 'HTML', content: bodyHtml || '' },
      toRecipients: toAddressList(to),
      ccRecipients: toAddressList(cc),
      ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
    });
    patch = null;
  }

  if (!draft || !draft.id) throw new Error('Graph did not return a draft to send');

  for (const att of attachments || []) {
    await client.api(`/me/messages/${draft.id}/attachments`).post({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: att.filename,
      contentType: att.mimeType || 'application/octet-stream',
      contentBytes: att.data, // base64 string
    });
  }

  const onWire = await stampDraft(client, draft.id, messageId, patch);

  await client.api(`/me/messages/${draft.id}/send`).post({});

  return {
    providerMessageId: draft.id,
    providerThreadId:  draft.conversationId || null,
    // The Message-ID that actually went out, which is not always the one we
    // asked for. Callers store this in preference to the one they minted.
    messageId: onWire || null,
    messageIdStamped: !!(messageId && onWire === messageId),
  };
}

// Apply the body/recipient patch and our Message-ID, then report the
// internetMessageId the draft really carries.
async function stampDraft(client, draftId, messageId, patch) {
  const base = patch || {};
  const hasPatch = Object.keys(base).length > 0;

  if (messageId) {
    try {
      await client.api(`/me/messages/${draftId}`).patch({ ...base, internetMessageId: messageId });
    } catch (e) {
      // Some tenants refuse a caller-supplied Message-ID. That costs us the
      // exact reply anchor, not the send -- the per-agent Reply-To address still
      // routes the answer back. Say so once and carry on.
      console.warn('[outlook] tenant would not accept our Message-ID (' + e.message
        + '); sending with the one Graph assigns, so replies match on sender only');
      if (hasPatch) await client.api(`/me/messages/${draftId}`).patch(base);
    }
  } else if (hasPatch) {
    await client.api(`/me/messages/${draftId}`).patch(base);
  }

  try {
    const g = await client.api(`/me/messages/${draftId}`).select('internetMessageId').get();
    return (g && g.internetMessageId) || null;
  } catch (e) {
    console.warn('[outlook] could not read back the Message-ID: ' + e.message);
    return null;
  }
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

function normalizeGraphMessage(msg) {
  const from = msg.from?.emailAddress || {};
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
    direction:         msg.sentDateTime && !msg.isDraft ? 'sent' : 'received',
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

module.exports = { isAvailable, getAuthUrl, exchangeCode, refreshAccessToken, fetchMessages, sendEmail };
