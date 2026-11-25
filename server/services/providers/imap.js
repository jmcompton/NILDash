// server/services/providers/imap.js
// Any mailbox that is not Gmail or Outlook: send over SMTP (Nodemailer).
// Covers Zoho, Yahoo, iCloud, GoDaddy, Fastmail and a company's own server.
// Credentials stored encrypted — never held in memory after sync.

'use strict';

// Each on its own: sending needs nodemailer alone, and a missing inbox
// library must not take sending down with it.
let Imap = null, nodemailer = null, simpleParser = null;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }
try { Imap = require('imap'); } catch (e) { Imap = null; }
try { simpleParser = require('mailparser').simpleParser; } catch (e) { simpleParser = null; }

// Sending needs nodemailer only.
function isAvailable() {
  return !!nodemailer;
}

// ── ANY OTHER MAILBOX: SEND OVER SMTP ───────────────────────────────────────
//
// Gmail and Outlook connect with a sign-in screen. Everything else (Zoho,
// Yahoo, iCloud, GoDaddy, Fastmail, a company's own mail server) connects here
// with the address and an app password, and NILDash SENDS through that
// provider's SMTP server. It never reads the inbox: replies to a pitch come
// back through the Reply-To address (services/replyCapture), the same as a
// Gmail mailbox connected send-only. An agent on Zoho could not use NILDash at
// all before this (Nov 2026).
//
// THE AGENT TYPES TWO THINGS. The server works out the rest:
//   1. the address's own domain, when it is a mail provider (yahoo.com);
//   2. else the domain's MX records, which name who hosts its mail
//      (a company domain -> mx.zoho.com -> Zoho);
//   3. else whatever host and port the agent typed under Advanced.
// A provider can have more than one server (Zoho: smtppro for a company's own
// domain, smtp for a personal address). Each is tried in order and the one
// that accepts the password is the one saved.
//
// Stored on the account: the password as the access token and
// { smtpHost, smtpPort, secure, kind } as the refresh token, both encrypted
// (services/emailStore). provider = 'imap', the name every send path already
// branches on.

const dns = require('dns').promises;
const net = require('net');

const S = (host, port) => ({ host, port, secure: port === 465 });
// kind -> what to call it, the servers to try, and what to tell the agent.
const KINDS = {
  zoho: { label: 'Zoho Mail', servers: (tld) => [S('smtppro.zoho.' + tld, 465), S('smtp.zoho.' + tld, 465)],
    help: 'Use your normal email password.',
    refused: 'If you have two-step login turned on, Zoho only accepts an app password here: in Zoho, open My Account, then Security, then App Passwords, create one for NILDash and paste it in.' },
  yahoo: { label: 'Yahoo Mail', servers: () => [S('smtp.mail.yahoo.com', 465)],
    help: 'Yahoo needs an app password: in Yahoo, open Account Security and choose Generate app password. Use that here.' },
  aol: { label: 'AOL Mail', servers: () => [S('smtp.aol.com', 465)],
    help: 'AOL needs an app password: in AOL, open Account Security and choose Generate app password. Use that here.' },
  icloud: { label: 'iCloud Mail', servers: () => [S('smtp.mail.me.com', 587)],
    help: 'iCloud needs an app password: at account.apple.com, open Sign-In and Security, then App-Specific Passwords, and create one. Use that here.' },
  fastmail: { label: 'Fastmail', servers: () => [S('smtp.fastmail.com', 465)],
    help: 'Fastmail needs an app password: in Fastmail, open Settings, then Privacy and Security, then App passwords, and create one. Use that here.' },
  godaddy: { label: 'GoDaddy email', servers: () => [S('smtpout.secureserver.net', 465)],
    help: 'Use the password for this mailbox.' },
  other: { label: 'your mail server', servers: () => [], help: 'Use your email password.', refused: 'If your provider uses two-step login, create an app password there and use that.' },
};
const DOMAIN_KIND = { 'zoho.com': 'zoho', 'zohomail.com': 'zoho', 'yahoo.com': 'yahoo', 'ymail.com': 'yahoo', 'aol.com': 'aol',
  'icloud.com': 'icloud', 'me.com': 'icloud', 'mac.com': 'icloud', 'fastmail.com': 'fastmail', 'fastmail.fm': 'fastmail' };
// These have their own button, and a password here would be refused anyway.
const USE_BUTTON = { 'gmail.com': 'gmail', 'googlemail.com': 'gmail', 'outlook.com': 'outlook', 'hotmail.com': 'outlook', 'live.com': 'outlook', 'msn.com': 'outlook' };
const ALLOWED_PORTS = [465, 587, 2525];

const domainOf = (email) => String(email || '').trim().toLowerCase().split('@')[1] || '';
const validEmail = (email) => /^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(String(email || '').trim());

// An MX host name -> who hosts the mail.
function kindOfMx(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  let m;
  if ((m = h.match(/(?:^|\.)zoho\.(com|eu|in|com\.au|jp|sa|com\.cn)$/))) return { kind: 'zoho', tld: m[1] };
  if (/(?:^|\.)(google|googlemail)\.com$/.test(h)) return { use: 'gmail' };
  if (/\.outlook\.com$|\.office365\.com$/.test(h)) return { use: 'outlook' };
  if (/\.yahoodns\.net$/.test(h)) return { kind: 'yahoo' };
  if (/\.icloud\.com$|\.mail\.me\.com$/.test(h)) return { kind: 'icloud' };
  if (/\.messagingengine\.com$/.test(h)) return { kind: 'fastmail' };
  if (/\.secureserver\.net$/.test(h)) return { kind: 'godaddy' };
  return null;
}

// -> { kind, label, help, servers: [{host,port,secure}], use: 'gmail'|'outlook'|null }
// Never throws: a domain whose records cannot be read is "other", and the
// agent is asked for the server.
async function detect(email, deps = {}) {
  const d = domainOf(email);
  const out = (kind, tld, use) => ({ kind, label: KINDS[kind].label, help: KINDS[kind].help, refused: KINDS[kind].refused || KINDS[kind].help, servers: KINDS[kind].servers(tld || 'com'), use: use || null });
  if (!d) return out('other');
  if (USE_BUTTON[d]) return out('other', null, USE_BUTTON[d]);
  if (DOMAIN_KIND[d]) return out(DOMAIN_KIND[d]);
  let mx = [];
  try { mx = await (deps.resolveMx || dns.resolveMx)(d); } catch (_) { mx = []; }
  mx = (mx || []).slice().sort((a, b) => (a.priority || 0) - (b.priority || 0));
  for (const r of mx) {
    const k = kindOfMx(r.exchange);
    if (k && k.use) return out('other', null, k.use);
    if (k) return out(k.kind, k.tld);
  }
  return out('other');
}

// A host an agent typed is a host this server will open a connection to. Only
// a public mail server on a mail port: never this machine, never a private
// network, never another port.
function privateAddress(ip) {
  if (net.isIPv6(ip)) { const x = ip.toLowerCase(); return x === '::1' || x === '::' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^::ffff:/.test(x); }
  const o = ip.split('.').map(Number);
  return o[0] === 10 || o[0] === 127 || o[0] === 0 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)
    || (o[0] === 169 && o[1] === 254) || (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || o[0] >= 224;
}
async function checkHost(host, port, deps = {}) {
  const h = String(host || '').trim().toLowerCase();
  const p = parseInt(port, 10);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || net.isIP(h)) throw userError('Enter the mail server by name, like smtp.example.com.');
  if (!ALLOWED_PORTS.includes(p)) throw userError('The port must be 465 or 587.');
  let addrs = [];
  try { addrs = await (deps.lookup || ((x) => dns.lookup(x, { all: true })))(h); } catch (_) { throw userError(`The mail server ${h} could not be found. Check the spelling.`); }
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw userError(`The mail server ${h} is not one NILDash can connect to.`);
  return { host: h, port: p, secure: p === 465 };
}
function userError(msg, code) { const e = new Error(msg); e.userMessage = msg; if (code) e.code = code; return e; }

function transportFor(emailAddress, password, server, deps = {}) {
  const mk = deps.createTransport || (nodemailer && nodemailer.createTransport);
  if (!mk) throw new Error('nodemailer is not installed');
  return mk({
    host: server.host, port: server.port, secure: server.secure === true || server.port === 465,
    requireTLS: !(server.secure === true || server.port === 465),   // 587: refuse to send the password in the clear
    auth: { user: emailAddress, pass: password },
    connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 20000,
  });
}
const isAuthError = (e) => !!e && (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534 || /\b(535|534)\b|authentication failed|invalid login|username and password not accepted/i.test(String(e.message || '')));

// Proves the address and password can send, and returns what to store.
// cfg: { smtpHost, smtpPort } when the agent typed a server; else detected.
// Throws an Error with .userMessage, in words the agent can act on.
async function verifySmtp(emailAddress, password, cfg = {}, deps = {}) {
  const email = String(emailAddress || '').trim().toLowerCase();
  if (!validEmail(email)) throw userError('Enter the full email address.');
  if (!password) throw userError('Enter the password.');
  const found = await detect(email, deps);
  if (found.use && !cfg.smtpHost) {
    throw userError(found.use === 'gmail' ? 'This address is a Google mailbox. Use the Gmail button instead.' : 'This address is a Microsoft mailbox. Use the Outlook button instead.');
  }
  let servers;
  if (cfg.smtpHost) servers = [await checkHost(cfg.smtpHost, cfg.smtpPort || 465, deps)];
  else servers = found.servers;
  if (!servers.length) throw userError('NILDash could not tell who hosts this mailbox. Open Advanced and enter the outgoing (SMTP) server and port from your email provider.', 'NEED_SERVER');
  let authRefused = null, last = null;
  for (const sv of servers) {
    let t = null;
    try {
      t = transportFor(email, String(password), sv, deps);
      await t.verify();
      return { smtpHost: sv.host, smtpPort: sv.port, secure: sv.secure === true, kind: found.kind, label: found.label };
    } catch (e) { last = e; if (isAuthError(e)) authRefused = e; }
    finally { try { if (t && t.close) t.close(); } catch (_) {} }
  }
  if (authRefused) throw userError(`${found.label === 'your mail server' ? 'The mail server' : found.label} did not accept that password. ${found.refused}`, 'BAD_PASSWORD');
  throw userError(`NILDash could not reach ${servers.map((x) => x.host).join(' or ')} (${String((last && last.message) || 'no answer').slice(0, 120)}). Try again in a minute, or enter the server under Advanced.`, 'UNREACHABLE');
}

// The stored config, whatever shape it was saved in: { smtpHost, smtpPort }
// (the connect route), { host, port } or { smtp: { host, port } }.
function storedServer(emailAddress, smtpConfig) {
  const c = smtpConfig || {};
  const host = c.smtpHost || c.host || (c.smtp && c.smtp.host) || null;
  const port = parseInt(c.smtpPort || c.port || (c.smtp && c.smtp.port) || 0, 10) || null;
  if (host) return { host, port: port || 465, secure: c.secure === true || (port || 465) === 465 };
  const k = DOMAIN_KIND[domainOf(emailAddress)];
  const sv = k ? KINDS[k].servers('com')[0] : null;
  return sv || null;
}

// Kept for callers that still ask by domain.
function getPreset(emailAddress) {
  const sv = storedServer(emailAddress, null);
  return sv ? { smtp: sv } : null;
}

/**
 * Kept under its old name for callers: proves the mailbox can send.
 */
async function testConnection(emailAddress, password, imapHost, imapPort, smtpHost, smtpPort) {
  await verifySmtp(emailAddress, password, { smtpHost, smtpPort });
  return true;
}

/**
 * Fetch recent messages via IMAP.
 * cursor: UID of last seen message (fetch newer ones only).
 * Returns { messages: NormalizedMessage[], nextCursor: string }
 */
async function fetchMessages(emailAddress, password, imapConfig, cursor, maxResults = 50) {
  if (!Imap) throw new Error('imap package not installed');

  // Not used by the app: a mailbox connected here is send-only (see the top of
  // this file). Works only with an explicit IMAP host.
  const host = imapConfig?.host || null;
  const port = imapConfig?.port || 993;

  if (!host) throw new Error('No IMAP host for ' + emailAddress);

  return new Promise((resolve, reject) => {
    const conn = new Imap({
      user: emailAddress,
      password,
      host,
      port,
      tls: true,
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
 * Send one message through the mailbox's own SMTP server.
 * A refused password is thrown with code 401, which the send queue reads as
 * "this mailbox is disconnected" (services/sendGuard), the same as a revoked
 * Gmail or Outlook token.
 */
async function sendEmail(emailAddress, password, smtpConfig, { to, cc, subject, bodyHtml, replyTo, messageId, fromName, inReplyTo, references } = {}, deps = {}) {
  const server = storedServer(emailAddress, smtpConfig);
  if (!server) throw new Error('No SMTP server on file for ' + emailAddress);
  const transporter = transportFor(emailAddress, password, server, deps);
  const name = String(fromName || '').replace(/["\r\n<>]/g, '').trim();
  try {
    const info = await transporter.sendMail({
      from: name ? { name, address: emailAddress } : emailAddress,
      to: Array.isArray(to) ? to.join(', ') : to,
      cc: Array.isArray(cc) ? cc.join(', ') : cc,
      subject: subject || '',
      html: bodyHtml || '',
      ...(replyTo ? { replyTo } : {}),
      // nodemailer honours this verbatim, so SMTP sends carry the exact
      // Message-ID we stored and reply matching on it is reliable here.
      ...(messageId ? { messageId } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references ? { references } : {}),
    });
    if (info && Array.isArray(info.rejected) && info.rejected.length && !(info.accepted || []).length) {
      const e = new Error('the mail server refused the recipient: ' + info.rejected.join(', '));
      e.code = 'RECIPIENT_REFUSED'; throw e;   // not a number: 5xx would read as "their server is down, retry" (services/sendGuard)
    }
    return { providerMessageId: (info && info.messageId) || null, providerThreadId: null };
  } catch (e) {
    if (isAuthError(e)) { const x = new Error('the mail server refused the saved password for ' + emailAddress + ': ' + String(e.message).slice(0, 140)); x.code = 401; x.status = 401; throw x; }
    throw e;
  } finally { try { if (transporter.close) transporter.close(); } catch (_) {} }
}

// Is the saved password still good? For the morning mailbox check.
async function verifyStored(emailAddress, password, smtpConfig, deps = {}) {
  const server = storedServer(emailAddress, smtpConfig);
  if (!server) throw new Error('no SMTP server on file');
  const t = transportFor(emailAddress, password, server, deps);
  try { await t.verify(); return true; }
  finally { try { if (t.close) t.close(); } catch (_) {} }
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

module.exports = { isAvailable, getPreset, testConnection, fetchMessages, sendEmail, verifySmtp, verifyStored, detect, kindOfMx, storedServer, checkHost, isAuthError, KINDS };
