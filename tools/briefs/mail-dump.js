'use strict';
// ── READ SENT AND RECEIVED MAIL OUT OF MAIL.APP ──────────────────────────────
//
// Both accounts (Gmail and Outlook) are already synced into Mail.app on the
// Mac, so this reads them there: no passwords, no OAuth, no IMAP. It runs a
// JXA script through osascript and returns plain objects.
//
//   dumpMail({ accounts: [], myAddresses: [], lookbackDays: 60, debug: false, fresh: false })
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
  const conf = JSON.stringify({ accounts: opts.accounts || [], myAddresses: (opts.myAddresses || []).map((a) => String(a).toLowerCase()), lookbackDays: opts.lookbackDays || 60, withContent: opts.withContent !== false });
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
  function pull(mb, name, account, kind, after, withContent) {
    var entry = { account: account, mailbox: name, kind: kind, total: null, inWindow: 0, count: 0, newest: null, method: 'bulk', note: '' };
    out.mailboxes.push(entry);
    var cap = 3000;
    // ONE APPLE EVENT PER PROPERTY, NOT ONE PER MESSAGE. whose({dateSent:
    // {_greaterThan: d}}) returns an EMPTY list on Mail without throwing,
    // which is how every mailbox read "0 via whose" while the classification
    // was right. Bulk property reads are the reliable JXA path: the dates for
    // the whole mailbox come back as one array, the filter is done here, and
    // only the messages inside the window are touched individually.
    var dates, subjects, senders, ids;
    try { dates = mb.messages.dateSent(); } catch (e) { entry.note = 'dateSent() bulk read failed: ' + e.message; out.warnings.push(account + '/' + name + ': ' + entry.note); return; }
    entry.total = dates.length;
    var idx = [];
    for (var i = 0; i < dates.length; i++) {
      var d = dates[i];
      if (!d) continue;
      if (!(d instanceof Date)) { try { d = new Date(d); } catch (e) { continue; } }
      if (isNaN(d.getTime())) continue;
      if (!entry.newest || d > entry.newest) entry.newest = d;
      if (d > after) idx.push(i);
    }
    entry.newest = entry.newest ? entry.newest.toISOString() : null;
    entry.inWindow = idx.length;
    // Newest first, then the cap.
    idx.sort(function (x, y) { return dates[y] - dates[x]; });
    if (idx.length > cap) { out.warnings.push(account + '/' + name + ': ' + idx.length + ' messages in the window, reading the newest ' + cap); idx = idx.slice(0, cap); }
    if (!idx.length) return;
    try { subjects = mb.messages.subject(); } catch (e) { subjects = null; }
    try { senders = mb.messages.sender(); } catch (e) { senders = null; }
    try { ids = mb.messages.messageId(); } catch (e) { ids = null; }
    for (var j = 0; j < idx.length; j++) {
      var k = idx[j];
      var rec = { account: account, mailbox: name, kind: kind,
        id: ids ? String(ids[k] || '') : '', subject: subjects ? String(subjects[k] || '') : '',
        date: new Date(dates[k]).toISOString(), from: senders ? String(senders[k] || '') : '', to: [], cc: [] };
      // Recipients and content are per message, and only for the window.
      // A received message needs neither: sender and subject are enough to
      // say "they answered", and a mailbox of thousands must not cost
      // thousands of events.
      if (kind === 'sent') {
        var m = null;
        try { m = mb.messages[k]; } catch (e) {}
        if (m) {
          try { rec.to = m.toRecipients.address(); } catch (e) {}
          try { rec.cc = m.ccRecipients.address(); } catch (e) {}
          if (withContent) { try { rec.content = String(m.content() || '').slice(0, 1500); } catch (e) { rec.content = ''; } }
        }
      }
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
    // ── ONLY MY OWN ACCOUNTS ARE READ ────────────────────────────────────
    // An account is read when one of its addresses is in myAddresses, or it
    // is named in mailAccounts. Anything else on this Mac (a family member's
    // account, a shared machine) is listed as skipped and never walked. With
    // both lists empty nothing is read at all, and the warning says why.
    var lower = addrs.map(function (x) { return String(x).toLowerCase(); });
    var named = want.indexOf(aname.toLowerCase()) !== -1;
    var mine = lower.some(function (x) { return OPTS.myAddresses.indexOf(x) !== -1; });
    var why = named ? 'named in mailAccounts' : (mine ? 'address is in myAddresses' : (OPTS.myAddresses.length || want.length ? 'none of its addresses are in myAddresses and it is not named in mailAccounts' : 'myAddresses and mailAccounts are both empty; nothing is read until one names it'));
    var skipped = !(named || mine);
    out.accounts.push({ name: aname, addresses: addrs, enabled: enabled, skipped: skipped, why: why });
    if (skipped) { if (!OPTS.myAddresses.length && !want.length) out.warnings.push(aname + ': skipped, ' + why); continue; }
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
    for (const a of data.accounts) console.log(`   ${a.skipped ? 'SKIPPED' : 'read   '}  ${JSON.stringify(a.name)}  enabled=${a.enabled}  addresses=${JSON.stringify(a.addresses)}  (${a.why})`);
    console.log(`[mail-dump] mailboxes walked (${data.mailboxes.length}):`);
    for (const m of data.mailboxes) console.log(`   ${m.kind.padEnd(8)} ${(m.account + ' / ' + m.mailbox).padEnd(44)} ${m.count === null ? '' : `${m.total} total, ${m.inWindow} in window, ${m.count} read, newest ${m.newest ? m.newest.slice(0, 10) : 'none'}`}${m.note ? '  ' + m.note : ''}`);
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

// ── THE PROBE: PERMISSION, THEN A RAW COUNT WITH NO FILTER ───────────────────
//
//   node tools/briefs/mail-dump.js --probe
//
// Four steps, each wrapped on its own so the first failure is named:
//   1. Mail.accounts().length            Automation permission. A denial is
//                                        error -1743 "Not authorized to send
//                                        Apple events to Mail", never a zero.
//   2. For every account that is mine: the first Sent mailbox's
//      messages.length                   total messages, no date filter at all
//   3. The date of the first and last message in that mailbox, read one at a
//      time                              is the date a real Date?
//   4. messages.dateSent() in bulk       the read the briefs use: how many
//                                        dates came back, and the newest
function probeScript(myAddresses, accounts) {
  const conf = JSON.stringify({ myAddresses: (myAddresses || []).map((a) => String(a).toLowerCase()), accounts: (accounts || []).map((a) => String(a).toLowerCase()) });
  return `
var OPTS = ${conf};
function run() {
  var out = { steps: [] };
  var step = function (name, fn) { try { out.steps.push({ step: name, ok: true, value: fn() }); return true; } catch (e) { out.steps.push({ step: name, ok: false, error: String(e && e.message || e), code: e && e.errorNumber }); return false; } };
  var Mail = Application('Mail');
  var n = null;
  if (!step('1. Mail.accounts().length (Automation permission)', function () { n = Mail.accounts().length; return n; })) return JSON.stringify(out);
  var accts = Mail.accounts();
  for (var a = 0; a < accts.length; a++) {
    var acct = accts[a], aname = '', addrs = [];
    try { aname = acct.name(); } catch (e) { continue; }
    try { addrs = acct.emailAddresses().map(function (x) { return String(x).toLowerCase(); }); } catch (e) {}
    var mine = addrs.some(function (x) { return OPTS.myAddresses.indexOf(x) !== -1; }) || OPTS.accounts.indexOf(aname.toLowerCase()) !== -1;
    if (!mine) { out.steps.push({ step: 'account ' + aname, ok: true, value: 'skipped (not mine)' }); continue; }
    var sent = null, sentName = '';
    step('account ' + aname + ': find a Sent mailbox', function () {
      var boxes = acct.mailboxes();
      for (var i = 0; i < boxes.length; i++) { var nm = boxes[i].name(); if (/^sent/i.test(nm)) { sent = boxes[i]; sentName = nm; return nm; } }
      for (var i2 = 0; i2 < boxes.length; i2++) { var subs = []; try { subs = boxes[i2].mailboxes(); } catch (e) {} for (var j = 0; j < subs.length; j++) { var nm2 = subs[j].name(); if (/^sent/i.test(nm2)) { sent = subs[j]; sentName = boxes[i2].name() + '/' + nm2; return sentName; } } }
      return 'none found; mailboxes: ' + boxes.map(function (b) { return b.name(); }).join(', ');
    });
    if (!sent) continue;
    var total = null;
    step('account ' + aname + ' / ' + sentName + ': 2. messages.length (no filter)', function () { total = sent.messages.length; return total; });
    if (!total) continue;
    step('account ' + aname + ' / ' + sentName + ': 3. first and last message dateSent(), read singly', function () {
      var first = sent.messages[0].dateSent(), last = sent.messages[total - 1].dateSent();
      return { first: String(first), firstIsDate: first instanceof Date, last: String(last), lastIsDate: last instanceof Date };
    });
    step('account ' + aname + ' / ' + sentName + ': 4. messages.dateSent() in bulk', function () {
      var ds = sent.messages.dateSent();
      var newest = null, valid = 0;
      for (var k = 0; k < ds.length; k++) { var d = ds[k]; if (d && !isNaN(new Date(d).getTime())) { valid++; if (!newest || d > newest) newest = d; } }
      var cutoff = new Date(Date.now() - 60 * 86400000);
      var inWindow = 0; for (var k2 = 0; k2 < ds.length; k2++) { if (ds[k2] && ds[k2] > cutoff) inWindow++; }
      return { returned: ds.length, validDates: valid, newest: newest ? String(newest) : null, last60Days: inWindow, typeofFirst: typeof ds[0], isDate: ds[0] instanceof Date };
    });
  }
  return JSON.stringify(out);
}`;
}

function probe(opts = {}) {
  if (process.platform !== 'darwin') { console.log('probe: not macOS, nothing to ask'); return; }
  let raw;
  try {
    raw = execFileSync('osascript', ['-l', 'JavaScript', '-e', probeScript(opts.myAddresses, opts.accounts)], { encoding: 'utf8', timeout: 5 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString();
    console.log('probe: osascript itself failed:\n' + msg.slice(0, 800));
    if (/-1743|not authorized|Not authorized/i.test(msg)) {
      console.log('\nTHAT IS THE AUTOMATION PERMISSION. This terminal was denied (or never asked) to control Mail.'
        + '\nFix: System Settings > Privacy & Security > Automation > your terminal app > turn Mail on.'
        + '\nIf the terminal is not listed there, reset the prompt and run this again:  tccutil reset AppleEvents');
    }
    return;
  }
  let data;
  try { data = JSON.parse(raw); } catch (e) { console.log('probe: Mail returned non-JSON: ' + raw.slice(0, 500)); return; }
  for (const s of data.steps) {
    console.log(`${s.ok ? ' ok ' : 'FAIL'}  ${s.step}  ->  ${s.ok ? JSON.stringify(s.value) : s.error + (s.code ? ' (code ' + s.code + ')' : '')}`);
  }
  const first = data.steps[0];
  if (first && first.ok) console.log('\nStep 1 succeeded, so Automation permission for Mail IS granted to this terminal. A denial errors with -1743; it never returns a count.');
  const zeroTotals = data.steps.filter((s) => /2\. messages\.length/.test(s.step) && s.ok && s.value === 0);
  if (zeroTotals.length) console.log(`\n${zeroTotals.length} Sent mailbox(es) report 0 messages WITH NO FILTER. That is Mail itself saying the mailbox is empty as far as scripting can see:`
    + ' usually the account is set to keep mail on the server only, or Mail has not finished downloading. Open Mail, select that Sent mailbox, and check Mailbox > Get Account Info for the message count.');
}

module.exports = { dumpMail, addrOf, nameOf, buildScript, probe };

// `node tools/briefs/mail-dump.js --debug [--days 60] [--account "Gmail"]`
// `node tools/briefs/mail-dump.js --probe`
if (require.main === module) {
  const { loadConfig } = require('./lib');
  const cfg = loadConfig();
  const argv = process.argv.slice(2);
  if (argv.includes('--probe')) { probe({ myAddresses: cfg.myAddresses, accounts: cfg.mailAccounts }); process.exit(0); }
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const accounts = argv.includes('--account') ? [val('--account')] : cfg.mailAccounts;
  const data = dumpMail({ accounts, myAddresses: cfg.myAddresses, lookbackDays: parseInt(val('--days', cfg.lookbackDays), 10) || 60, debug: true, fresh: true });
  if (!data.sent.length) {
    console.log('\nZERO SENT MESSAGES. Read the mailbox list above: if no line says "sent", the Sent mailbox has a name this script did not recognise;'
      + ' tell me the name and it goes in the list. If accounts are listed but no mailboxes, Mail has not been granted Automation access to this terminal.');
  }
  process.exit(0);
}
