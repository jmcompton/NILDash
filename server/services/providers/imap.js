// server/services/providers/imap.js
// Generic IMAP (read) + SMTP via Nodemailer (send).
// Covers: Yahoo Mail, Apple iCloud, Exchange, and any IMAP provider.
// Requires: npm install imap nodemailer mailparser
// Credentials stored encrypted — never held in memory after sync.

'use strict';

let Imap, nodemailer, simpleParser;
try {
  Imap         = require('imap');
  nodemailer   = require('nodemailer');
  simpleParser = require('mailparser').simpleParser;
} catch (e) {
  Imap = null;
}

function isAvailable() {
  return !!Imap;
}

// Well-known IMAP/SMTP configs so users only enter email + password
const PROVIDER_PRESETS = {
  'yahoo.com':    { imap: { host: 'imap.mail.yahoo.com',    port: 993, tls: true }, smtp: { host: 'smtp.mail.yahoo.com',    port: 587, secure: false } },
  'icloud.com':   { imap: { host: 'imap.mail.me.com',        port: 993, tls: true }, smtp: { host: 'smtp.mail.me.com',        port: 587, secure: false } },
  'me.com':       { imap: { host: 'imap.mail.me.com',        port: 993, tls: true }, smtp: { host: 'smtp.mail.me.com',        port: 587, secure: false } },
  'hotmail.com':  { imap: { host: 'outlook.office365.com',   port: 993, tls: true }, smtp: { host: 'smtp.office365.com',     port: 587, secure: false } },
  'live.com':     { imap: { host: 'outlook.office365.com',   port: 993, tls: true }, smtp: { host: 'smtp.office365.com',     port: 587, secure: false } },
  'outlook.com':  { imap: { host: 'outlook.office365.com',   port: 993, tls: true }, smtp: { host: 'smtp.office365.com',     port: 587, secure: false } },
  'aol.com':      { imap: { host: 'imap.aol.com',            port: 993, tls: true }, smtp: { host: 'smtp.aol.com',            port: 587, secure: false } },
  'zoho.com':     { imap: { host: 'imap.zoho.com',           port: 993, tls: true }, smtp: { host: 'smtp.zoho.com',          port: 465, secure: true  } },
  'protonmail.com':{ imap: { host: '127.0.0.1',              port: 1143, tls: false }, smtp: { host: '127.0.0.1',             port: 1025, secure: false } },
};

function getPreset(emailAddress) {
  const domain = (emailAddress || '').split('@')[1]?.toLowerCase();
  return PROVIDER_PRESETS[domain] || null;
}

/**
 * Test that IMAP credentials are valid.
 * Returns true on success, throws on failure.
 */
async function testConnection(emailAddress, password, imapHost, imapPort, smtpHost, smtpPort) {
  if (!Imap) throw new Error('imap package not installed. Run: npm install imap nodemailer mailparser');

  const preset = getPreset(emailAddress);
  const host = imapHost || preset?.imap.host;
  const port = imapPort || preset?.imap.port || 993;
  if (!host) throw new Error('No IMAP host configured for this provider');

  return new Promise((resolve, reject) => {
    const conn = new Imap({
      user: emailAddress,
      password,
      host,
      port,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 10000,
      authTimeout: 10000,
    });
    conn.once('ready', () => { conn.end(); resolve(true); });
    conn.once('error', reject);
    conn.connect();
  });
}

/**
 * Fetch recent messages via IMAP.
 * cursor: UID of last seen message (fetch newer ones only).
 * Returns { messages: NormalizedMessage[], nextCursor: string }
 */
async function fetchMessages(emailAddress, password, imapConfig, cursor, maxResults = 50) {
  if (!Imap) throw new Error('imap package not installed');

  const preset = getPreset(emailAddress);
  const host = imapConfig?.host || preset?.imap.host;
  const port = imapConfig?.port || preset?.imap.port || 993;

  if (!host) throw new Error('No IMAP host for ' + emailAddress);

  return new Promise((resolve, reject) => {
    const conn = new Imap({
      user: emailAddress,
      password,
      host,
      port,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 15000,
    });

    const messages = [];
    let highestUid = cursor ? parseInt(cursor) : 0;

    conn.once('ready', () => {
      conn.openBox('INBOX', true, (err, box) => {
        if (err) { conn.end(); reject(err); return; }

        const totalMsgs = box.messages.total;
        if (totalMsgs === 0) { conn.end(); resolve({ messages: [], nextCursor: cursor }); return; }

        // Search for messages newer than cursor UID, or last N if no cursor
        const searchCriteria = cursor
          ? [['UID', (highestUid + 1) + ':*']]
          : [['SINCE', daysAgo(90)]];

        conn.search(searchCriteria, (searchErr, uids) => {
          if (searchErr || !uids.length) { conn.end(); resolve({ messages: [], nextCursor: cursor }); return; }

          // Take the most recent maxResults UIDs
          const fetchUids = uids.slice(-maxResults);

          const fetch = conn.fetch(fetchUids, { bodies: '', struct: true });

          fetch.on('message', (msg, seqno) => {
            const chunks = [];
            let uid = null;

            msg.on('attributes', attrs => { uid = attrs.uid; });
            msg.on('body', stream => {
              stream.on('data', chunk => chunks.push(chunk));
            });
            msg.once('end', async () => {
              try {
                const raw = Buffer.concat(chunks);
                const parsed = await simpleParser(raw);
                messages.push(normalizeImapMessage(parsed, uid, emailAddress));
                if (uid > highestUid) highestUid = uid;
              } catch (e) {
                console.error('[imap] Parse error:', e.message);
              }
            });
          });

          fetch.once('error', err => { conn.end(); reject(err); });
          fetch.once('end', () => { conn.end(); });
        });
      });
    });

    conn.once('end', () => resolve({ messages, nextCursor: String(highestUid) }));
    conn.once('error', err => reject(err));
    conn.connect();
  });
}

/**
 * Send via SMTP (Nodemailer).
 */
async function sendEmail(emailAddress, password, smtpConfig, { to, cc, subject, bodyHtml, threadId }) {
  if (!nodemailer) throw new Error('nodemailer not installed');

  const preset = getPreset(emailAddress);
  const smtpHost = smtpConfig?.host || preset?.smtp.host;
  const smtpPort = smtpConfig?.port || preset?.smtp.port || 587;
  const secure   = smtpConfig?.secure ?? preset?.smtp.secure ?? false;

  if (!smtpHost) throw new Error('No SMTP host for ' + emailAddress);

  const transporter = nodemailer.createTransporter({
    host: smtpHost,
    port: smtpPort,
    secure,
    auth: { user: emailAddress, pass: password },
    tls: { rejectUnauthorized: false },
  });

  const info = await transporter.sendMail({
    from: emailAddress,
    to: Array.isArray(to) ? to.join(', ') : to,
    cc: Array.isArray(cc) ? cc.join(', ') : cc,
    subject: subject || '',
    html: bodyHtml || '',
  });

  return { providerMessageId: info.messageId, providerThreadId: null };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeImapMessage(parsed, uid, accountEmail) {
  const fromObj = (parsed.from?.value || [])[0] || {};
  const isSent = (parsed.to?.text || '').toLowerCase().includes(accountEmail.toLowerCase()) === false
    && (parsed.from?.text || '').toLowerCase().includes(accountEmail.toLowerCase());

  return {
    providerMessageId: parsed.messageId || String(uid),
    providerThreadId:  parsed.inReplyTo || parsed.messageId,
    subject:           parsed.subject || '(no subject)',
    fromAddress:       (fromObj.address || '').toLowerCase(),
    fromName:          fromObj.name || '',
    toAddresses:       (parsed.to?.value || []).map(a => a.address || ''),
    ccAddresses:       (parsed.cc?.value || []).map(a => a.address || ''),
    bodyText:          parsed.text || '',
    bodyHtml:          parsed.html || null,
    sentAt:            parsed.date ? new Date(parsed.date) : new Date(),
    isRead:            false, // IMAP flags not parsed in this simple mode
    hasAttachments:    (parsed.attachments || []).length > 0,
    direction:         isSent ? 'sent' : 'received',
  };
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

module.exports = { isAvailable, getPreset, testConnection, fetchMessages, sendEmail };
