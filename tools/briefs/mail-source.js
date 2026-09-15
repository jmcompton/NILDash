'use strict';
// ── WHERE THE MAIL COMES FROM: MAIL.APP ON THE MAC, THE PROVIDERS ON A SERVER ─
//
// follow-ups needs my sent mail and my received mail for the last N days,
// from both accounts. On the Mac that is Mail.app (mail-dump.js). On Railway
// there is no Mail.app, and the two accounts need two different doors:
//
//   Gmail      IMAP with a Google APP PASSWORD (imap.gmail.com). Not OAuth:
//              NILDash's Google consent is gmail.send only, and reading mail
//              needs gmail.readonly, a RESTRICTED scope that Google verifies
//              with a security assessment and, for an app left in "testing",
//              expires refresh tokens after seven days. An app password is a
//              16-character secret tied to the account, needs 2-Step
//              Verification on, and does not expire.
//   Outlook    Microsoft Graph with the OAuth connection the NILDash app
//              already holds for the account (Mail.ReadWrite is in its
//              scopes). The refresh token sits encrypted in email_accounts;
//              this reads it with the same key the app uses and asks Graph
//              for the Sent Items and Inbox folders. Nothing is written back.
//              So: connect the Outlook mailbox in NILDash once, under your
//              own agent login, and the briefs can read it from then on.
//
// Every door returns the shape mail-dump.js returns, so follow-ups does not
// know which machine it is on:
//   { sent, received, accounts, mailboxes, warnings }
//   message: { account, mailbox, id, subject, date (ISO), from, to: [], cc: [], content (sent only) }
//
// Chosen by BRIEFS_MAIL_SOURCES (mac, gmail-imap, outlook-graph; comma list),
// or, when unset: mac on macOS, otherwise whichever of the two server doors
// has its variables set.

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const SOURCES = ['mac', 'gmail-imap', 'outlook-graph'];
const PER_BOX_CAP = 600;

function chooseSources(cfg, opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const explicit = (cfg.mailSources || []).map((s) => String(s).trim().toLowerCase()).filter((s) => SOURCES.includes(s));
  if (explicit.length) return explicit;
  if (platform === 'darwin') return ['mac'];
  const auto = [];
  if (env.BRIEFS_GMAIL_USER && env.BRIEFS_GMAIL_APP_PASSWORD) auto.push('gmail-imap');
  if (env.DATABASE_URL && env.OUTLOOK_CLIENT_ID && env.OUTLOOK_CLIENT_SECRET) auto.push('outlook-graph');
  return auto;
}

const fmtAddr = (name, addr) => { const a = String(addr || '').trim(); const n = String(name || '').trim(); return n && a ? `${n} <${a}>` : a; };
const stripHtml = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

// A mailparser result -> a brief message.
function fromParsed(parsed, account, mailbox, kind) {
  const from = ((parsed.from && parsed.from.value) || [])[0] || {};
  const list = (x) => ((x && x.value) || []).map((a) => fmtAddr(a.name, a.address)).filter(Boolean);
  const date = parsed.date ? new Date(parsed.date) : null;
  const m = {
    account, mailbox, kind,
    id: String(parsed.messageId || ''),
    subject: String(parsed.subject || ''),
    date: date && !isNaN(date.getTime()) ? date.toISOString() : new Date(0).toISOString(),
    from: fmtAddr(from.name, from.address),
    to: list(parsed.to), cc: list(parsed.cc),
  };
  if (kind === 'sent') m.content = String(parsed.text || stripHtml(parsed.html) || '').slice(0, 1500);
  return m;
}

// A Graph message -> a brief message.
function fromGraph(msg, account, mailbox, kind) {
  const from = (msg.from && msg.from.emailAddress) || {};
  const list = (rs) => (rs || []).map((r) => fmtAddr(r.emailAddress && r.emailAddress.name, r.emailAddress && r.emailAddress.address)).filter(Boolean);
  const when = msg.sentDateTime || msg.receivedDateTime;
  const m = {
    account, mailbox, kind,
    id: String(msg.internetMessageId || msg.id || ''),
    subject: String(msg.subject || ''),
    date: when ? new Date(when).toISOString() : new Date(0).toISOString(),
    from: fmtAddr(from.name, from.address),
    to: list(msg.toRecipients), cc: list(msg.ccRecipients),
  };
  if (kind === 'sent') {
    const body = msg.body && msg.body.content ? (msg.body.contentType === 'html' || msg.body.contentType === 'HTML' ? stripHtml(msg.body.content) : String(msg.body.content)) : String(msg.bodyPreview || '');
    m.content = body.slice(0, 1500);
  }
  return m;
}

// ── GMAIL OVER IMAP ──────────────────────────────────────────────────────────
function imapBox(conn, box, criteria, cap) {
  return new Promise((resolve, reject) => {
    conn.openBox(box, true, (err, info) => {
      if (err) return reject(err);
      if (!info || !info.messages || info.messages.total === 0) return resolve([]);
      conn.search(criteria, (sErr, uids) => {
        if (sErr) return reject(sErr);
        if (!uids || !uids.length) return resolve([]);
        const wanted = uids.slice(-cap);
        const raws = [];
        const f = conn.fetch(wanted, { bodies: '' });
        f.on('message', (msg) => {
          const chunks = [];
          msg.on('body', (stream) => stream.on('data', (c) => chunks.push(c)));
          msg.once('end', () => raws.push(Buffer.concat(chunks)));
        });
        f.once('error', reject);
        f.once('end', () => resolve(raws));
      });
    });
  });
}

async function readGmailImap({ user, password, since, debug }) {
  const Imap = require('imap');
  const { simpleParser } = require('mailparser');
  const out = { sent: [], received: [], accounts: [{ name: 'Gmail (IMAP)', addresses: [String(user).toLowerCase()], enabled: true, skipped: false, why: 'BRIEFS_GMAIL_USER' }], mailboxes: [], warnings: [] };
  const conn = new Imap({ user, password, host: 'imap.gmail.com', port: 993, tls: true, connTimeout: 20000, authTimeout: 20000 });
  await new Promise((resolve, reject) => { conn.once('ready', resolve); conn.once('error', reject); conn.connect(); });
  try {
    for (const box of [{ name: '[Gmail]/Sent Mail', kind: 'sent' }, { name: 'INBOX', kind: 'received' }]) {
      const entry = { account: 'Gmail (IMAP)', mailbox: box.name, kind: box.kind, count: 0, note: '' };
      try {
        const raws = await imapBox(conn, box.name, [['SINCE', since]], PER_BOX_CAP);
        for (const raw of raws) {
          try { out[box.kind].push(fromParsed(await simpleParser(raw), 'Gmail (IMAP)', box.name, box.kind)); entry.count++; }
          catch (e) { entry.note = 'parse: ' + e.message; }
        }
      } catch (e) {
        entry.note = e.message;
        out.warnings.push(`Gmail ${box.name}: ${e.message}`);
      }
      out.mailboxes.push(entry);
      if (debug) console.log(`[mail-source] gmail-imap ${box.name}: ${entry.count} read${entry.note ? ' (' + entry.note + ')' : ''}`);
    }
  } finally {
    try { conn.end(); } catch (_) { /* closing */ }
  }
  return out;
}

// ── OUTLOOK OVER GRAPH, WITH THE APP'S CONNECTION ────────────────────────────
async function outlookAccounts(myAddresses) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1|\/tmp/.test(process.env.DATABASE_URL || '') ? false : { rejectUnauthorized: false } });
  try {
    const r = await pool.query(`SELECT id, provider, email_address, access_token_enc, refresh_token_enc, token_expiry, status
                                  FROM email_accounts WHERE provider IN ('outlook','microsoft365') AND status = 'active'`);
    const mine = new Set((myAddresses || []).map((a) => String(a).toLowerCase()));
    return r.rows.filter((row) => mine.has(String(row.email_address || '').toLowerCase()));
  } finally { await pool.end().catch(() => {}); }
}

async function graphPages(client, endpoint, maxPages) {
  const items = [];
  let next = endpoint;
  for (let i = 0; i < maxPages && next; i++) {
    const page = await client.api(next).get();
    items.push(...(page.value || []));
    next = page['@odata.nextLink'] || null;
  }
  return items;
}

async function readOutlookGraph({ myAddresses, since, debug }) {
  const out = { sent: [], received: [], accounts: [], mailboxes: [], warnings: [] };
  const crypto = require('../../server/services/crypto');
  const outlook = require('../../server/services/providers/outlook');
  const MicrosoftGraph = require('@microsoft/microsoft-graph-client');
  const rows = await outlookAccounts(myAddresses);
  if (!rows.length) {
    out.warnings.push(`No Outlook mailbox in NILDash matches myAddresses (${(myAddresses || []).join(', ') || 'empty'}). Connect it in NILDash (Email > Connect Outlook) under your own login.`);
    return out;
  }
  const sinceIso = since.toISOString();
  const select = '$select=id,internetMessageId,subject,from,toRecipients,ccRecipients,body,bodyPreview,sentDateTime,receivedDateTime';
  for (const row of rows) {
    const name = `Outlook (${row.email_address})`;
    const acct = { name, addresses: [String(row.email_address).toLowerCase()], enabled: true, skipped: false, why: 'email_accounts' };
    out.accounts.push(acct);
    let access = null;
    try {
      const refresh = row.refresh_token_enc ? crypto.decrypt(row.refresh_token_enc) : null;
      const stored = row.access_token_enc ? crypto.decrypt(row.access_token_enc) : null;
      const fresh = row.token_expiry && (new Date(row.token_expiry).getTime() - Date.now() > 5 * 60 * 1000);
      if (stored && fresh) access = stored;
      else if (refresh) access = (await outlook.refreshAccessToken(refresh)).accessToken;
      else throw new Error('no refresh token stored for this mailbox');
    } catch (e) {
      acct.skipped = true; acct.why = 'token: ' + e.message;
      out.warnings.push(`${name}: could not get an access token (${e.message}). Reconnect the mailbox in NILDash.`);
      continue;
    }
    const client = MicrosoftGraph.Client.init({ authProvider: (done) => done(null, access) });
    for (const box of [
      { name: 'Sent Items', kind: 'sent', ep: `/me/mailFolders/sentitems/messages?$filter=sentDateTime ge ${sinceIso}&$orderby=sentDateTime desc&$top=100&${select}` },
      { name: 'Inbox', kind: 'received', ep: `/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${sinceIso}&$orderby=receivedDateTime desc&$top=100&${select}` },
    ]) {
      const entry = { account: name, mailbox: box.name, kind: box.kind, count: 0, note: '' };
      try {
        const msgs = await graphPages(client, box.ep, Math.ceil(PER_BOX_CAP / 100));
        for (const m of msgs) { out[box.kind].push(fromGraph(m, name, box.name, box.kind)); entry.count++; }
      } catch (e) {
        entry.note = e.message;
        out.warnings.push(`${name} ${box.name}: ${e.message}`);
      }
      out.mailboxes.push(entry);
      if (debug) console.log(`[mail-source] outlook-graph ${name} ${box.name}: ${entry.count} read${entry.note ? ' (' + entry.note + ')' : ''}`);
    }
  }
  return out;
}

// ── ONE CALL, WHATEVER THE MACHINE ───────────────────────────────────────────
async function readMail(cfg, opts = {}) {
  const debug = !!(opts.debug || process.env.BRIEFS_DEBUG);
  const sources = opts.sources || chooseSources(cfg, opts);
  const cacheFile = path.join(L.DIRS.state, `mail-${L.today()}.json`);
  if (!opts.fresh && !debug) {
    try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) { /* no cache today */ }
  }
  const empty = () => ({ sent: [], received: [], accounts: [], mailboxes: [], warnings: [] });
  const all = empty();
  const merge = (r) => { for (const k of ['sent', 'received', 'accounts', 'mailboxes', 'warnings']) all[k].push(...(r[k] || [])); };
  const since = new Date(Date.now() - (cfg.lookbackDays || 60) * 86400000);
  if (!sources.length) {
    all.warnings.push('No mail source: on macOS Mail.app is read; elsewhere set BRIEFS_GMAIL_USER + BRIEFS_GMAIL_APP_PASSWORD and/or DATABASE_URL + OUTLOOK_CLIENT_ID + OUTLOOK_CLIENT_SECRET (README: Running on Railway).');
  }
  for (const s of sources) {
    try {
      if (s === 'mac') merge(require('./mail-dump').dumpMail({ accounts: cfg.mailAccounts, myAddresses: cfg.myAddresses, lookbackDays: cfg.lookbackDays, debug, fresh: true }));
      else if (s === 'gmail-imap') merge(await (opts.readGmailImap || readGmailImap)({ user: process.env.BRIEFS_GMAIL_USER, password: process.env.BRIEFS_GMAIL_APP_PASSWORD, since, debug }));
      else if (s === 'outlook-graph') merge(await (opts.readOutlookGraph || readOutlookGraph)({ myAddresses: cfg.myAddresses, since, debug }));
    } catch (e) {
      all.warnings.push(`${s}: ${e.message}`);
      L.log('mail', `${s} FAILED ${e.message}`);
    }
  }
  // Within the window only, newest first; the Mac path filtered already.
  const cut = since.toISOString();
  for (const k of ['sent', 'received']) {
    all[k] = all[k].filter((m) => m.date >= cut).sort((a, b) => b.date.localeCompare(a.date));
  }
  try {
    for (const f of fs.readdirSync(L.DIRS.state)) {
      if (/^mail-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== path.basename(cacheFile)) { try { fs.unlinkSync(path.join(L.DIRS.state, f)); } catch (_) {} }
    }
    fs.writeFileSync(cacheFile, JSON.stringify(all));
  } catch (_) { /* a read-only state dir is not fatal */ }
  L.log('mail', `sources ${sources.join('+') || 'none'}: read ${all.sent.length} sent and ${all.received.length} received across ${all.accounts.filter((a) => !a.skipped).length} account(s)` + (all.warnings.length ? `; warnings: ${all.warnings.join(' | ')}` : ''));
  return all;
}

module.exports = { readMail, chooseSources, fromParsed, fromGraph, readGmailImap, readOutlookGraph, SOURCES, PER_BOX_CAP };

// `node tools/briefs/mail-source.js --probe`: read through the server doors
// and print counts, on whatever machine this is.
if (require.main === module && process.argv.includes('--probe')) {
  const cfg = L.loadConfig();
  readMail(cfg, { fresh: true, debug: true }).then((r) => {
    console.log(`sources: ${chooseSources(cfg).join(', ') || 'none'}`);
    console.log(`sent=${r.sent.length} received=${r.received.length}`);
    for (const a of r.accounts) console.log(`  ${a.skipped ? 'SKIPPED' : 'read   '} ${a.name} ${JSON.stringify(a.addresses)} (${a.why})`);
    for (const w of r.warnings) console.log('  ! ' + w);
    process.exit(0);
  }).catch((e) => { console.error('FAILED', e.message); process.exit(1); });
}
