#!/usr/bin/env node
'use strict';
// ── FOLLOW-UPS: WHO I OWE, OR WHO OWES ME ────────────────────────────────────
//
// Reads sent mail from Mail.app (Gmail and Outlook), finds every thread where
// I sent the last message and nothing came back in `silentDays` or more, and
// emails one brief: who, what the thread was about, what I said I would do,
// and how long it has been. Sorted longest-silent first.
//
// One `claude -p` call for the whole list (max 2 turns, no tools): it reads
// my last message in each thread and writes the "about" and "promised" lines.
// Everything else is arithmetic on dates. Nothing is sent to anyone but me.

const L = require('./lib');
const { dumpMail, addrOf, nameOf } = require('./mail-dump');

const KIND = 'follow-ups';
const norm = (s) => String(s || '').replace(/^\s*((re|fw|fwd|aw|wg)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();

async function main() {
  const cfg = L.loadConfig();
  const audit = L.authAudit();
  const calls = [];
  const mail = dumpMail({ accounts: cfg.mailAccounts, lookbackDays: cfg.lookbackDays });
  const mine = new Set(cfg.myAddresses.concat(...mail.accounts.map((a) => (a.addresses || []).map((x) => String(x).toLowerCase()))));

  // Threads: normalised subject + the person I wrote to.
  const threads = new Map();
  for (const m of mail.sent) {
    const to = (m.to || []).map(addrOf).filter((a) => a && !mine.has(a));
    if (!to.length) continue;
    const who = to[0];
    const key = norm(m.subject) + '|' + who;
    const t = threads.get(key) || { key, who, whoName: null, subject: m.subject, lastSent: null, sentCount: 0, account: m.account };
    t.sentCount++;
    if (!t.lastSent || m.date > t.lastSent.date) t.lastSent = m;
    threads.set(key, t);
  }
  // A reply is anything from that person, same subject, after my last message.
  for (const r of mail.received) {
    const from = addrOf(r.from);
    if (!from || mine.has(from)) continue;
    const t = threads.get(norm(r.subject) + '|' + from);
    if (!t) continue;
    if (!t.whoName) t.whoName = nameOf(r.from);
    if (r.date > t.lastSent.date) t.replied = r.date;
    else t.everReplied = true;
  }
  const now = new Date().toISOString();
  const waiting = [...threads.values()]
    .filter((t) => !t.replied)
    .map((t) => Object.assign(t, { days: L.daysBetween(t.lastSent.date, now) }))
    .filter((t) => t.days >= cfg.silentDays)
    .sort((a, b) => b.days - a.days);

  L.log(KIND, `${threads.size} thread(s) in ${cfg.lookbackDays} days, ${waiting.length} silent ${cfg.silentDays}+ days`);

  // The model reads my last message in each and says what it was about and what I promised.
  let notes = new Map();
  if (waiting.length) {
    const items = waiting.slice(0, 60).map((t, i) => ({
      i, to: t.who, subject: t.subject, sentOn: t.lastSent.date.slice(0, 10),
      myLastMessage: String(t.lastSent.content || '').replace(/\r/g, '').slice(0, 1200),
    }));
    const prompt = `Below are email threads where I wrote last and have heard nothing back. For EACH item, read my last message and return a JSON array of objects {"i": <index>, "about": "<what the thread is about, one short line>", "promised": "<what I said I would do or send, one short line, or 'nothing specific'>"}. Use only what is in the message. Return ONLY the JSON array.\n\n${JSON.stringify(items, null, 1)}`;
    try {
      const r = await L.claudeP(prompt, { cfg, label: 'follow-ups', maxTurns: cfg.maxTurns.followups, tools: [] });
      calls.push(r);
      for (const n of (Array.isArray(r.json) ? r.json : [])) if (n && Number.isInteger(n.i)) notes.set(n.i, n);
    } catch (e) {
      L.log(KIND, 'claude call failed: ' + e.message);
    }
  }

  // ── THE BRIEF ────────────────────────────────────────────────────────────
  const md = [];
  md.push(`# Follow-ups: ${waiting.length} waiting`, '');
  md.push(`Threads where you sent last and nothing came back in ${cfg.silentDays}+ days. Last ${cfg.lookbackDays} days of sent mail`
    + (mail.accounts.length ? ` across ${mail.accounts.map((a) => a.name).join(', ')}.` : '.'), '');
  if (mail.warnings.length) { md.push('**Warnings**'); for (const w of mail.warnings) md.push(`- ${w}`); md.push(''); }
  if (!waiting.length) md.push('Nothing waiting. Every thread you started has an answer or is under a week old.');
  waiting.forEach((t, i) => {
    const n = notes.get(i) || {};
    const who = t.whoName ? `${t.whoName} <${t.who}>` : t.who;
    md.push(`## ${t.days} days · ${who}`);
    md.push(`- **Subject:** ${t.subject || '(no subject)'}`);
    md.push(`- **About:** ${n.about || '(not summarised)'}`);
    md.push(`- **You said you would:** ${n.promised || '(not summarised)'}`);
    md.push(`- **Your last message:** ${t.lastSent.date.slice(0, 10)}${t.sentCount > 1 ? ` (${t.sentCount} messages from you in this thread)` : ''}${t.everReplied ? ', they replied earlier in the thread' : ', they have never replied'}`);
    md.push('');
  });
  md.push(L.footer(KIND, calls, audit));
  const text = md.join('\n');
  const file = L.writeBrief(KIND, text);
  L.log(KIND, `archived ${file}`);

  const subject = `Follow-ups: ${waiting.length} waiting`;
  try { await L.sendBrief(cfg, { subject, markdown: text, kind: KIND }); }
  catch (e) { L.log(KIND, `EMAIL FAILED: ${e.message}. The archive at ${file} is complete.`); process.exitCode = 2; }
}

main().catch((e) => { L.log(KIND, 'FAILED: ' + (e.stack || e.message)); process.exit(1); });
