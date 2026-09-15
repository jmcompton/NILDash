#!/usr/bin/env node
'use strict';
// ── FOLLOW-UPS: WHO I OWE, OR WHO OWES ME ────────────────────────────────────
//
// Reads sent and received mail from Mail.app across my accounts and emails one
// brief, one entry PER PERSON, longest-silent first:
//
//   CALENDAR (top)   my responses to invites. "Accepted" reads "Meeting booked,
//                    no email since"; "Declined" or "Canceled" reads "Needs
//                    reschedule". Dated by the meeting when the invite says
//                    when, otherwise by my response.
//   WAITING          threads where I wrote last and nothing came back in
//                    `silentDays` or more: about, what I said I would do, when.
//   USERS (bottom)   the same, for people whose address is in `nildashUsers`
//                    in config.json.
//
// Anyone who has sent me ANYTHING after my last message to them -- any thread,
// any account -- is not on the list. Addresses at `skipDomains` are never on
// it. One `claude -p` call summarises the waiting threads (max 2 turns, no
// tools); if that call fails the brief says so and why, in the footer.

const L = require('./lib');
const { dumpMail, addrOf, nameOf } = require('./mail-dump');

const KIND = 'follow-ups';
const norm = (s) => String(s || '').replace(/^\s*((re|fw|fwd|aw|wg)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
const domainOf = (a) => String(a || '').split('@')[1] || '';
const CAL_RE = /^\s*(accepted|declined|canceled|cancelled|tentative|tentatively accepted)\s*:\s*(.*)$/i;

// The meeting's date, from the invite text Mail keeps in the response. Looks
// for the common shapes ("When: Tuesday, September 16, 2026 2:00 PM",
// "@ Tue Sep 16, 2026 2pm", "Sep 16, 2026") and takes the first that parses.
function meetingDateFrom(subject, content) {
  const hay = `${subject || ''}\n${content || ''}`;
  const pats = [
    /when:\s*([^\n]+)/i,
    /@\s*([A-Z][a-z]{2,8},?\s+[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4}[^\n]*)/,
    /\b((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}[^\n]*)/i,
    /\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4})/i,
    /\b(\d{4}-\d{2}-\d{2})/,
  ];
  for (const re of pats) {
    const m = hay.match(re);
    if (!m) continue;
    const cleaned = m[1].replace(/\s*(?:–|-|to)\s*\d{1,2}(:\d{2})?\s*(am|pm)?.*$/i, '').replace(/\s*\(.*$/, '').trim();
    for (const cand of [m[1], cleaned]) {
      const d = new Date(cand);
      if (!isNaN(d.getTime()) && d.getFullYear() > 2000) return d.toISOString();
    }
  }
  return null;
}

async function main() {
  const cfg = L.loadConfig();
  const audit = L.authAudit();
  const calls = [];
  const debug = process.argv.includes('--debug') || !!process.env.BRIEFS_DEBUG;
  const skipDomains = new Set((cfg.skipDomains || []).map((d) => String(d).toLowerCase()));
  const users = new Set((cfg.nildashUsers || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  const mail = dumpMail({ accounts: cfg.mailAccounts, myAddresses: cfg.myAddresses, lookbackDays: cfg.lookbackDays, debug });
  if (!mail.sent.length) mail.warnings.push('0 sent messages were read. Run `node tools/briefs/mail-dump.js --debug` on the Mac to see what Mail returned.');
  const mine = new Set(cfg.myAddresses.concat(...mail.accounts.map((a) => (a.addresses || []).map((x) => String(x).toLowerCase()))));
  const skip = (addr) => !addr || mine.has(addr) || skipDomains.has(domainOf(addr));

  // ── ONE ENTRY PER PERSON ─────────────────────────────────────────────────
  const people = new Map();
  const personFor = (addr, name) => {
    let p = people.get(addr);
    if (!p) { p = { addr, name: null, threads: new Map(), calendar: [], lastSentAt: null, lastSent: null, lastReceivedAt: null }; people.set(addr, p); }
    if (name && !p.name) p.name = name;
    return p;
  };
  let sentSeen = 0, calSeen = 0;
  for (const m of mail.sent) {
    const to = (m.to || []).map(addrOf).filter((a) => a && !mine.has(a));
    if (!to.length) continue;
    const who = to[0];
    if (skip(who)) continue;
    sentSeen++;
    const p = personFor(who, nameOf((m.to || [])[0]));
    const cal = String(m.subject || '').match(CAL_RE);
    if (cal) {
      calSeen++;
      const kind = cal[1].toLowerCase();
      const type = /^accepted|^tentative/.test(kind) ? 'accepted' : 'declined';
      p.calendar.push({ type, event: cal[2].trim(), respondedAt: m.date, meetingDate: meetingDateFrom(cal[2], m.content), account: m.account });
    } else {
      const key = norm(m.subject);
      const t = p.threads.get(key) || { subject: m.subject, count: 0, lastSent: null };
      t.count++;
      if (!t.lastSent || m.date > t.lastSent.date) t.lastSent = m;
      p.threads.set(key, t);
    }
    if (!p.lastSentAt || m.date > p.lastSentAt) { p.lastSentAt = m.date; p.lastSent = m; }
  }
  // Anything they sent me, in any thread, from any account.
  for (const r of mail.received) {
    const from = addrOf(r.from);
    if (!from || mine.has(from)) continue;
    const p = people.get(from);
    if (!p) continue;
    if (!p.name) p.name = nameOf(r.from);
    if (!p.lastReceivedAt || r.date > p.lastReceivedAt) p.lastReceivedAt = r.date;
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const entries = [];
  let droppedReplied = 0, droppedFresh = 0, droppedFuture = 0;
  for (const p of people.values()) {
    if (p.lastReceivedAt && p.lastReceivedAt > p.lastSentAt) { droppedReplied++; continue; }
    // The most recent calendar response, if any, decides the type; the meeting
    // date is the activity date when the invite carried one.
    const cal = p.calendar.slice().sort((a, b) => (b.meetingDate || b.respondedAt).localeCompare(a.meetingDate || a.respondedAt))[0] || null;
    let activityAt = p.lastSentAt;
    let section = 'waiting', label = null;
    if (cal) {
      const when = cal.meetingDate || cal.respondedAt;
      if (cal.meetingDate && cal.meetingDate > nowIso) { droppedFuture++; continue; }   // booked and still ahead: nothing to chase yet
      activityAt = when > p.lastSentAt ? when : p.lastSentAt;
      section = 'calendar';
      label = cal.type === 'accepted' ? 'Meeting booked, no email since.' : 'Needs reschedule.';
    }
    const days = L.daysBetween(activityAt, nowIso);
    if (days < cfg.silentDays) { droppedFresh++; continue; }
    if (users.has(p.addr)) section = 'users';
    entries.push({ p, cal, section, label, days, activityAt });
  }
  entries.sort((a, b) => b.days - a.days);
  const bySection = { calendar: entries.filter((e) => e.section === 'calendar'), waiting: entries.filter((e) => e.section === 'waiting'), users: entries.filter((e) => e.section === 'users') };
  L.log(KIND, `${people.size} people written to; ${entries.length} waiting (${bySection.calendar.length} calendar, ${bySection.waiting.length} threads, ${bySection.users.length} users); dropped ${droppedReplied} who wrote back, ${droppedFresh} under ${cfg.silentDays} days, ${droppedFuture} with a meeting still ahead`);

  // ── THE SUMMARIES ────────────────────────────────────────────────────────
  // One call for every non-calendar entry (waiting and users). If it fails,
  // the brief carries the error, not a blank.
  const notes = new Map();
  let summaryError = null;
  const toSummarise = entries.filter((e) => !e.cal).slice(0, 60);
  if (toSummarise.length) {
    const items = toSummarise.map((e, i) => ({
      i, to: e.p.addr, subject: e.p.lastSent.subject, sentOn: e.p.lastSent.date.slice(0, 10),
      myLastMessage: String(e.p.lastSent.content || '').replace(/\r/g, '').slice(0, 1200),
    }));
    const prompt = `Below are email threads where I wrote last and have heard nothing back. For EACH item, read my last message and return a JSON array of objects {"i": <index>, "about": "<what the thread is about, one short line>", "promised": "<what I said I would do or send, one short line, or 'nothing specific'>"}. Use only what is in the message. Return ONLY the JSON array.\n\n${JSON.stringify(items, null, 1)}`;
    try {
      const r = await L.claudeP(prompt, { cfg, label: 'follow-ups', maxTurns: cfg.maxTurns.followups, tools: [] });
      calls.push(r);
      const arr = Array.isArray(r.json) ? r.json : [];
      for (const n of arr) if (n && Number.isInteger(n.i)) notes.set(toSummarise[n.i] && toSummarise[n.i].p.addr, n);
      if (!arr.length) summaryError = 'claude answered but returned no JSON array; first 200 chars: ' + String(r.text || '').slice(0, 200);
    } catch (e) {
      summaryError = e.message;
      L.log(KIND, 'claude call failed: ' + e.message);
    }
  }

  // ── THE BRIEF ────────────────────────────────────────────────────────────
  const md = [];
  md.push(`# Follow-ups: ${entries.length} waiting`, '');
  md.push(`One entry per person. Anyone who wrote back after your last message is off the list. Last ${cfg.lookbackDays} days`
    + (mail.accounts.length ? ` across ${mail.accounts.filter((a) => !a.skipped).map((a) => a.name).join(', ')}.` : '.'), '');
  if (mail.warnings.length) { md.push('**Warnings**'); for (const w of mail.warnings) md.push(`- ${w}`); md.push(''); }
  if (summaryError) { md.push('**Summaries did not run**: ' + summaryError, ''); }
  const fmtDate = (iso) => iso ? new Date(iso).toDateString().replace(/^\w+ /, '').replace(/ \d{4}$/, '') : '';
  const entryMd = (e) => {
    const p = e.p;
    const who = p.name ? `${p.name} <${p.addr}>` : p.addr;
    md.push(`## ${e.days} days · ${who}`);
    if (e.cal) {
      md.push(`- **${e.label}** ${e.cal.type === 'accepted' ? 'Accepted' : 'Declined or canceled'}: ${e.cal.event || '(untitled)'}${e.cal.meetingDate ? ` · meeting ${fmtDate(e.cal.meetingDate)}` : ` · responded ${fmtDate(e.cal.respondedAt)}, no meeting date in the invite`}`);
    }
    const threads = [...p.threads.values()].sort((a, b) => b.lastSent.date.localeCompare(a.lastSent.date));
    if (threads.length) {
      md.push(`- **Thread${threads.length > 1 ? 's' : ''}:** ${threads.slice(0, 3).map((t) => (t.subject || '(no subject)') + (t.count > 1 ? ` (${t.count} from you)` : '')).join(' · ')}${threads.length > 3 ? ` · and ${threads.length - 3} more` : ''}`);
      const n = notes.get(p.addr) || {};
      if (!e.cal || n.about) md.push(`- **About:** ${n.about || (summaryError ? '(summaries did not run)' : '(not summarised)')}`);
      if (!e.cal || n.promised) md.push(`- **You said you would:** ${n.promised || (summaryError ? '(summaries did not run)' : '(not summarised)')}`);
    }
    md.push(`- **Your last message:** ${p.lastSent.date.slice(0, 10)}${p.lastReceivedAt ? ', they wrote earlier in the exchange' : ', they have never written to you'}`);
    md.push('');
  };
  if (bySection.calendar.length) { md.push(`## Calendar (${bySection.calendar.length})`, ''); bySection.calendar.forEach(entryMd); }
  if (bySection.waiting.length) { md.push(`## Waiting (${bySection.waiting.length})`, ''); bySection.waiting.forEach(entryMd); }
  if (!entries.length) md.push('Nothing waiting. Everyone you wrote to has answered or is under a week old.');
  if (bySection.users.length) { md.push(`## Users (${bySection.users.length})`, '', 'NILDash users, from `nildashUsers` in config.json.', ''); bySection.users.forEach(entryMd); }
  md.push(L.footer(KIND, calls, audit) + (summaryError ? `\n_summaries: FAILED: ${summaryError}_` : ''));
  const text = md.join('\n');
  const file = L.writeBrief(KIND, text);
  L.log(KIND, `archived ${file}`);
  if (process.argv.includes('--print')) console.log('\n' + text);

  const subject = `Follow-ups: ${entries.length} waiting`;
  if (process.argv.includes('--no-email')) { L.log(KIND, 'email skipped (--no-email)'); return; }
  try { await L.sendBrief(cfg, { subject, markdown: text, kind: KIND }); }
  catch (e) { L.log(KIND, `EMAIL FAILED: ${e.message}. The archive at ${file} is complete.`); process.exitCode = 2; }
}

main().catch((e) => { L.log(KIND, 'FAILED: ' + (e.stack || e.message)); process.exit(1); });
