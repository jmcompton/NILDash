'use strict';
// ── READ SENT AND RECEIVED MAIL OUT OF MAIL.APP ──────────────────────────────
//
// Both accounts (Gmail and Outlook) are already synced into Mail.app on the
// Mac, so this reads them there: no passwords, no OAuth, no IMAP. It runs a
// JXA script through osascript and returns plain objects.
//
//   dumpMail({ accounts: [], lookbackDays: 60 })
//     -> { sent: [...], received: [...], accounts: [...], warnings: [...] }
//
// A message is { account, mailbox, id, subject, date (ISO), from, to: [],
// content (sent only, first 1500 chars) }.
//
// Cached per day in ~/nildash-briefs/state/mail-<date>.json so follow-ups
// and prospecting, which both need it, pay for one read.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DIRS, today, log } = require('./lib');

const JXA = `
function run(argv) {
  const opts = JSON.parse(argv[0]);
  const Mail = Application('Mail');
  const cutoff = new Date(Date.now() - opts.lookbackDays * 86400000);
  const rxCutoff = new Date(cutoff.getTime() - 7 * 86400000);
  const out = { sent: [], received: [], accounts: [], warnings: [] };
  const want = (opts.accounts || []).map((s) => String(s).toLowerCase());
  const isSent = (n) => /^(sent|sent messages|sent mail|sent items|\\[gmail\\]\\/sent mail)$/i.test(n) || /^sent\\b/i.test(n);
  const isInbox = (n) => /^(inbox|all mail|\\[gmail\\]\\/all mail)$/i.test(n);
  function walk(mbs, depth, cb) {
    for (let i = 0; i < mbs.length; i++) {
      const mb = mbs[i];
      let name = ''; try { name = mb.name(); } catch (e) { continue; }
      cb(mb, name);
      if (depth < 2) { try { walk(mb.mailboxes(), depth + 1, cb); } catch (e) {} }
    }
  }
  function pull(mb, name, account, kind, after, withContent) {
    let msgs;
    try { msgs = mb.messages.whose({ dateSent: { _greaterThan: after } })(); }
    catch (e) { out.warnings.push(account + '/' + name + ': ' + e.message); return; }
    const cap = 3000;
    if (msgs.length > cap) out.warnings.push(account + '/' + name + ': ' + msgs.length + ' messages, reading the newest ' + cap);
    const list = msgs.slice(0, cap);
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      try {
        const rec = {
          account: account, mailbox: name, kind: kind,
          id: String(m.messageId()), subject: String(m.subject() || ''),
          date: new Date(m.dateSent()).toISOString(),
          from: String(m.sender() || ''),
          to: [],
        };
        try { rec.to = m.toRecipients.address(); } catch (e) {}
        try { rec.cc = m.ccRecipients.address(); } catch (e) { rec.cc = []; }
        if (withContent) { try { rec.content = String(m.content() || '').slice(0, 1500); } catch (e) { rec.content = ''; } }
        (kind === 'sent' ? out.sent : out.received).push(rec);
      } catch (e) { /* one unreadable message is not a reason to stop */ }
    }
  }
  const accts = Mail.accounts();
  for (let a = 0; a < accts.length; a++) {
    const acct = accts[a];
    let aname = ''; try { aname = acct.name(); } catch (e) { continue; }
    if (want.length && want.indexOf(aname.toLowerCase()) === -1) continue;
    let addrs = []; try { addrs = acct.emailAddresses(); } catch (e) {}
    out.accounts.push({ name: aname, addresses: addrs });
    let boxes; try { boxes = acct.mailboxes(); } catch (e) { out.warnings.push(aname + ': no mailboxes readable'); continue; }
    walk(boxes, 0, function (mb, name) {
      if (isSent(name)) pull(mb, name, aname, 'sent', cutoff, true);
      else if (isInbox(name)) pull(mb, name, aname, 'received', rxCutoff, false);
    });
  }
  return JSON.stringify(out);
}`;

function dumpMail(opts = {}) {
  const cacheFile = path.join(DIRS.state, `mail-${today()}.json`);
  if (!opts.fresh) {
    try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) { /* no cache today */ }
  }
  if (process.platform !== 'darwin') {
    return { sent: [], received: [], accounts: [], warnings: ['not macOS: Mail.app is not available, nothing was read'] };
  }
  const arg = JSON.stringify({ accounts: opts.accounts || [], lookbackDays: opts.lookbackDays || 60 });
  let raw;
  try {
    raw = execFileSync('osascript', ['-l', 'JavaScript', '-e', JXA, '-', arg], {
      encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60 * 1000,
    });
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().slice(0, 400);
    return { sent: [], received: [], accounts: [], warnings: ['Mail.app read failed: ' + msg
      + ' (first run: System Settings > Privacy & Security > Automation must allow Terminal/cron to control Mail)'] };
  }
  const data = JSON.parse(raw);
  // Old caches are removed so the state folder does not grow forever.
  for (const f of fs.readdirSync(DIRS.state)) {
    if (/^mail-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== path.basename(cacheFile)) { try { fs.unlinkSync(path.join(DIRS.state, f)); } catch (_) {} }
  }
  fs.writeFileSync(cacheFile, JSON.stringify(data));
  log('mail', `read ${data.sent.length} sent and ${data.received.length} received across ${data.accounts.length} account(s)` + (data.warnings.length ? `; warnings: ${data.warnings.join(' | ')}` : ''));
  return data;
}

const addrOf = (s) => { const m = String(s || '').match(/<([^>]+)>/); return (m ? m[1] : String(s || '')).trim().toLowerCase(); };
const nameOf = (s) => { const m = String(s || '').match(/^\s*"?([^"<]+?)"?\s*</); return m ? m[1].trim() : ''; };

module.exports = { dumpMail, addrOf, nameOf };
