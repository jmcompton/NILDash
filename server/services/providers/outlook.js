// server/services/providers/outlook.js
// Microsoft OAuth2 + Graph API for Outlook / Microsoft 365.
// Requires: npm install @azure/msal-node @microsoft/microsoft-graph-client
// Env vars: OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, OUTLOOK_REDIRECT_URI, OUTLOOK_TENANT_ID

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

  let endpoint = `/me/messages?$top=${maxResults}&$orderby=receivedDateTime desc&$select=id,conversationId,subject,from,toRecipients,ccRecipients,body,bodyPreview,receivedDateTime,isRead,hasAttachments,isDraft,sentDateTime,flag`;

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

async function sendEmail(accessToken, _refreshToken, { to, cc, subject, bodyHtml, threadId, attachments }) {
  if (!MicrosoftGraph) throw new Error('@microsoft/microsoft-graph-client not installed');
  const client = getGraphClient(accessToken);

  const message = {
    subject: subject || '',
    body: { contentType: 'HTML', content: bodyHtml || '' },
    toRecipients: toAddressList(to),
    ccRecipients: toAddressList(cc),
  };

  // Attach PDF if provided (Graph API inline attachment format)
  if (attachments && attachments.length > 0) {
    message.attachments = attachments.map(att => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: att.filename,
      contentType: att.mimeType || 'application/octet-stream',
      contentBytes: att.data, // base64 string
    }));
  }

  if (threadId) {
    await client.api(`/me/messages/${threadId}/reply`).post({ message });
    return { providerMessageId: null, providerThreadId: threadId };
  } else {
    await client.api('/me/sendMail').post({ message: { ...message, isDraft: false } });
    return { providerMessageId: null, providerThreadId: null };
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
