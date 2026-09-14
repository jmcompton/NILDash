'use strict';
// ── READ SENT AND RECEIVED MAIL OUT OF MAIL.APP ──────────────────────────────
//
// Both accounts (Gmail and Outlook) are already synced into Mail.app on the
// Mac, so this reads them there: no passwords, no OAuth, no IMAP. It runs a
// JXA script through osascript and returns plain objects.
//
//   dumpMail({ accounts: [], lookbackDays: 60, debug: false, fresh: false })
//     -> { sent: [...], received: [...], accounts: [...], mailboxes: [...], warnings: [...] }
//
// A message is { account, mailbox, id, subject, date (ISO), from, to: [],
// cc: [], content (sent only, first 1500 chars) }.
//
// Cached per day in ~/nildash-briefs/state/mail-<date>.json so follow-ups
// and prospecting, which both need it, pay for one read.
//
// DEBUG. `node tools/briefs/mail-dump.js --debug` (or BRIEFS_DEBUG=1 on any
// brief) prints, before anything is parsed: what osascript returned (length
// and head), then every account Mail knows with its addresses, every mailbox
// walked with how it was classified and how many messages it yielded, and
// every warning. That is the difference between "read zero" and "read them
// and could not serialise".
//
// THE OPTIONS ARE BAKED INTO THE SCRIPT, not passed as an argument. The first
// version ran `osascript -l JavaScript -e <script> - <json>` and osascript
// handed the bare `-` to run(argv) as argv[0], so JSON.parse('-') threw
// "Invalid number" before Mail was ever asked. The AppleScript error code
// -2700 on that message is just "a script error occurred".

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DIRS, today, log } = require('./lib');

function buildScript(opts) {
  const conf = JSON.stringify({ accounts: opts.accounts || [], lookbackDays: opts.lookbackDays || 60, withContent: opts.withContent !== false });
  return `
var OPTS = ${conf};
function run() {
  var Mail = Application('Mail');
  var cutoff = new Date(Date.now() - OPTS.lookbackDays * 86400000);
  var rxCutoff = new Date(cutoff.getTime() - 7 * 86400000);
  var out = { sent: [], received: [], accounts: [], mailboxes: [], warnings: [] };
  var want = (OPTS.accounts || []).map(function (s) { return String(s).toLowerCase(); });
  var isSent = function (n) { return /^(sent|sent messages|sent mail|sent items)$/i.test(n) || /^sent\\b/i.test(n); };
  var isInbox = function (n) { return /^(inbox|all mail)$/i.test(n); };
  function walk(mbs, depth, cb) {
    for (var i = 0; i < mbs.length; i++) {
      var mb = mbs[i];
      var name = '';
      try { name = mb.name(); } catch (e) { continue; }
      cb(mb, name);
      if (depth < 2) { try { walk(mb.mailboxes(), depth + 1, cb); } catch (e) {} }
    }
  }
  function toRec(m, account, name, kind, withContent) {
    var rec = {
      account: account, mailbox: name, kind: kind,
      id: '', subject: '', date: null, from: '', to: [], cc: []
    };
    try { rec.id = String(m.messageId()); } catch (e) {}
    try { rec.subject = String(m.subject() || ''); } catch (e) {}
    try { rec.date = new Date(m.dateSent()).toISOString(); } catch (e) {}
    try { rec.from = String(m.sender() || ''); } catch (e) {}
    try { rec.to = m.toRecipients.address(); } catch (e) {}
    try { rec.cc = m.ccRecipients.address(); } catch (e) {}
    if (withContent) { try { rec.content = String(m.content() || '').slice(0, 1500); } catch (e) { rec.content = ''; } }
    return rec;
  }
  function pull(mb, name, account, kind, after, withContent) {
    var entry = { account: account, mailbox: name, kind: kind, count: 0, method: '', note: '' };
    out.mailboxes.push(entry);
    var cap = 3000;
    var list = null;
    try {
      list = mb.messages.whose({ dateSent: { _greaterThan: after } })();
      entry.method = 'whose';
    } catch (e) {
      entry.note = 'whose() failed (' + e.message + '), scanning from the newest';
      list = [];
      try {
        var n = mb.messages.length;
        var stale = 0;
        for (var i = n - 1; i >= 0 && list.length < cap && stale < 50; i--) {
          var m = mb.messages[i];
          var d = null;
          try { d = new Date(m.dateSent()); } catch (e2) { continue; }
          if (d > after) { list.push(m); stale = 0; } else { stale++; }
        }
        entry.method = 'scan';
      } catch (e3) { out.warnings.push(account + '/' + name + ': ' + e3.message); return; }
    }
    if (list.length > cap) { out.warnings.push(account + '/' + name + ': ' + list.length + ' messages, reading the newest ' + cap); list = list.slice(list.length - cap); }
    for (var j = 0; j < list.length; j++) {
      var rec = toRec(list[j], account, name, kind, withContent);
      if (!rec.date) continue;
      (kind === 'sent' ? out.sent : out.received).push(rec);
      entry.count++;
    }
  }
  var accts = Mail.accounts();
  for (var a = 0; a < accts.length; a++) {
    var acct = accts[a];
    var aname = '';
    try { aname = acct.name(); } catch (e) { continue; }
    var addrs = [];
    try { addrs = acct.emailAddresses(); } catch (e) {}
    var enabled = null;
    try { enabled = acct.enabled(); } catch (e) {}
    var skipped = want.length && want.indexOf(aname.toLowerCase()) === -1;
    out.accounts.push({ name: aname, addresses: addrs, enabled: enabled, skipped: !!skipped });
    if (skipped) continue;
    var boxes;
    try { boxes = acct.mailboxes(); } catch (e) { out.warnings.push(aname + ': no mailboxes readable (' + e.message + ')'); continue; }
    walk(boxes, 0, function (mb, name) {
      if (isSent(name)) pull(mb, name, aname, 'sent', cutoff, OPTS.withContent);
      else if (isInbox(name)) pull(mb, name, aname, 'received', rxCutoff, false);
      else out.mailboxes.push({ account: aname, mailbox: name, kind: 'ignored', count: null });
    });
  }
  return JSON.stringify(out);
}`;
}

function dumpMail(opts = {}) {
  const debug = !!(opts.debug || process.env.BRIEFS_DEBUG);
  const cacheFile = path.join(DIRS.state, `mail-${today()}.json`);
  if (!opts.fresh && !debug) {
    try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) { /* no cache today */ }
  }
  if (process.platform !== 'darwin') {
    return { sent: [], received: [], accounts: [], mailboxes: [], warnings: ['not macOS: Mail.app is not available, nothing was read'] };
  }
  let raw;
  try {
    raw = execFileSync('osascript', ['-l', 'JavaScript', '-e', buildScript(opts)], {
      encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().slice(0, 600);
    if (debug) console.log('[mail-dump] osascript FAILED before returning anything:\n' + msg);
    return { sent: [], received: [], accounts: [], mailboxes: [], warnings: ['Mail.app read failed: ' + msg
      + ' (first run: System Settings > Privacy & Security > Automation must allow Terminal, and cron, to control Mail)'] };
  }
  if (debug) {
    console.log(`[mail-dump] osascript returned ${raw.length} chars; head: ${JSON.stringify(raw.slice(0, 300))}`);
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) {
    const w = `Mail.app returned something that is not JSON (${e.message}); first 500 chars: ${raw.slice(0, 500)}`;
    if (debug) console.log('[mail-dump] ' + w);
    return { sent: [], received: [], accounts: [], mailboxes: [], warnings: [w] };
  }
  if (debug) {
    console.log(`[mail-dump] accounts (${data.accounts.length}):`);
    for (const a of data.accounts) console.log(`   ${a.skipped ? 'SKIPPED' : 'read   '}  ${JSON.stringify(a.name)}  enabled=${a.enabled}  addresses=${JSON.stringify(a.addresses)}`);
    console.log(`[mail-dump] mailboxes walked (${data.mailboxes.length}):`);
    for (const m of data.mailboxes) console.log(`   ${m.kind.padEnd(8)} ${(m.account + ' / ' + m.mailbox).padEnd(44)} ${m.count === null ? '' : m.count + ' message(s) via ' + m.method}${m.note ? '  ' + m.note : ''}`);
    console.log(`[mail-dump] sent=${data.sent.length} received=${data.received.length} warnings=${data.warnings.length}`);
    for (const w of data.warnings) console.log('   ! ' + w);
    if (data.sent.length) console.log(`[mail-dump] newest sent: ${data.sent.map((m) => m.date).sort().pop()}  oldest sent: ${data.sent.map((m) => m.date).sort()[0]}`);
  }
  for (const f of fs.readdirSync(DIRS.state)) {
    if (/^mail-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== path.basename(cacheFile)) { try { fs.unlinkSync(path.join(DIRS.state, f)); } catch (_) {} }
  }
  fs.writeFileSync(cacheFile, JSON.stringify(data));
  log('mail', `read ${data.sent.length} sent and ${data.received.length} received across ${data.accounts.filter((a) => !a.skipped).length} account(s)` + (data.warnings.length ? `; warnings: ${data.warnings.join(' | ')}` : ''));
  return data;
}

const addrOf = (s) => { const m = String(s || '').match(/<([^>]+)>/); return (m ? m[1] : String(s || '')).trim().toLowerCase(); };
const nameOf = (s) => { const m = String(s || '').match(/^\s*"?([^"<]+?)"?\s*</); return m ? m[1].trim() : ''; };

module.exports = { dumpMail, addrOf, nameOf, buildScript };

// `node tools/briefs/mail-dump.js --debug [--days 60] [--account "Gmail"]`
if (require.main === module) {
  const { loadConfig } = require('./lib');
  const cfg = loadConfig();
  const argv = process.argv.slice(2);
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const accounts = argv.includes('--account') ? [val('--account')] : cfg.mailAccounts;
  const data = dumpMail({ accounts, lookbackDays: parseInt(val('--days', cfg.lookbackDays), 10) || 60, debug: true, fresh: true });
  if (!data.sent.length) {
    console.log('\nZERO SENT MESSAGES. Read the mailbox list above: if no line says "sent", the Sent mailbox has a name this script did not recognise;'
      + ' tell me the name and it goes in the list. If accounts are listed but no mailboxes, Mail has not been granted Automation access to this terminal.');
  }
  process.exit(0);
}
