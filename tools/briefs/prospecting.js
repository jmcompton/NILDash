#!/usr/bin/env node
'use strict';
// ── PROSPECTS: TWENTY OPENERS, DRAFTED, NOT SENT ─────────────────────────────
//
// Reads LinkedIn's Connections.csv from ~/nildash-briefs/inbox/, keeps the
// people whose title or company matches the prospect keywords, drops anyone
// already in my sent mail (by address, or by name when LinkedIn withheld the
// address) and anyone drafted on an earlier run, then researches the next
// twenty with one `claude -p` each (WebSearch allowed, --max-turns capped) and
// drafts a personalised opener. Emailed and archived. Nothing is sent to any
// of them: the openers are for me to read, edit and send by hand.

const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { dumpMail, addrOf, nameOf } = require('./mail-dump');

const KIND = 'prospecting';
const STATE = 'prospecting-done.json';

// LinkedIn's export starts with a few lines of notes before the real header.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const hi = rows.findIndex((r) => r.some((x) => /^first name$/i.test(String(x).trim())));
  if (hi < 0) return [];
  const header = rows[hi].map((h) => String(h).trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const ix = { first: col('first name'), last: col('last name'), url: col('url'), email: col('email address'), company: col('company'), position: col('position'), on: col('connected on') };
  return rows.slice(hi + 1).filter((r) => r.length >= 2 && (r[ix.first] || r[ix.last])).map((r) => ({
    first: (r[ix.first] || '').trim(), last: (r[ix.last] || '').trim(),
    url: (r[ix.url] || '').trim(), email: (r[ix.email] || '').trim().toLowerCase(),
    company: (r[ix.company] || '').trim(), position: (r[ix.position] || '').trim(),
    connectedOn: (r[ix.on] || '').trim(),
  }));
}

function findCsv() {
  const dir = L.DIRS.inbox;
  const files = fs.readdirSync(dir).filter((f) => /\.csv$/i.test(f)).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  const pick = files.find((x) => /connections/i.test(x.f)) || files[0];
  return pick ? path.join(dir, pick.f) : null;
}

async function main() {
  const cfg = L.loadConfig();
  const audit = L.authAudit();
  const calls = [];
  const warnings = [];

  const csvPath = findCsv();
  if (!csvPath) {
    const md = [`# Prospects: 0 drafted`, '', `No CSV in ${L.DIRS.inbox}. Export LinkedIn connections (Settings > Data privacy > Get a copy of your data > Connections) and drop Connections.csv there.`, L.footer(KIND, calls, audit)].join('\n');
    L.writeBrief(KIND, md);
    await L.sendBrief(cfg, { subject: 'Prospects: 0 drafted', markdown: md, kind: KIND }).catch((e) => L.log(KIND, 'EMAIL FAILED: ' + e.message));
    return;
  }
  const people = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const kw = cfg.prospectKeywords.map((k) => String(k).toLowerCase());
  const matches = people.filter((p) => { const hay = `${p.position} ${p.company}`.toLowerCase(); return kw.some((k) => hay.includes(k)); });

  // Exclusions: sent mail (address or name) and earlier runs.
  const mail = dumpMail({ accounts: cfg.mailAccounts, myAddresses: cfg.myAddresses, lookbackDays: Math.max(cfg.lookbackDays, 365),
    debug: process.argv.includes('--debug') || !!process.env.BRIEFS_DEBUG });
  if (mail.warnings.length) warnings.push(...mail.warnings.map((w) => 'mail: ' + w));
  const sentAddr = new Set(), sentNames = new Set();
  for (const m of mail.sent) {
    for (const t of (m.to || []).concat(m.cc || [])) { const a = addrOf(t); if (a) sentAddr.add(a); const n = nameOf(t).toLowerCase(); if (n) sentNames.add(n); }
  }
  if (!mail.sent.length) warnings.push('sent mail was empty or unreadable, so nobody was excluded on that basis');
  const done = L.readState(STATE, {});
  const keyOf = (p) => (p.url || `${p.first} ${p.last}|${p.company}`).toLowerCase();
  const queue = matches.filter((p) => {
    if (done[keyOf(p)]) return false;
    if (p.email && sentAddr.has(p.email)) return false;
    if (sentNames.has(`${p.first} ${p.last}`.toLowerCase())) return false;
    return true;
  });
  const batch = queue.slice(0, cfg.prospectsPerRun);
  L.log(KIND, `${people.length} connections, ${matches.length} match keywords, ${queue.length} not yet contacted or drafted, drafting ${batch.length}`);

  const drafted = [];
  for (const p of batch) {
    const name = `${p.first} ${p.last}`.trim();
    const prompt = `Research this person briefly on the web and draft a LinkedIn opener from me.

PERSON: ${name}, ${p.position || 'unknown title'} at ${p.company || 'unknown company'}${p.url ? ' (' + p.url + ')' : ''}. We are connected on LinkedIn.
ME: ${cfg.aboutMe}

Return ONLY JSON: {"summary": "two lines on who they are and what they do, from what you found", "hook": "the one thing about them that makes NILDash relevant, or null if nothing real", "opener": "3-4 sentences, first person, plain, no flattery, no em dashes, no exclamation marks, ends with one easy question; if hook is null write an honest short opener that does not pretend to know them"}. Never invent facts about them; if you found nothing, say so in summary.`;
    try {
      const r = await L.claudeP(prompt, { cfg, label: `prospect:${name}`, maxTurns: cfg.maxTurns.prospect, tools: ['WebSearch', 'WebFetch'] });
      calls.push(r);
      const j = r.json && !Array.isArray(r.json) ? r.json : {};
      drafted.push({ p, name, summary: String(j.summary || '(no research returned)'), hook: j.hook || null, opener: String(j.opener || '(no opener returned)') });
      L.log(KIND, `${name}: ${r.numTurns == null ? '?' : r.numTurns} turn(s), ${Math.round(r.ms / 1000)}s`);
    } catch (e) {
      drafted.push({ p, name, summary: 'research failed: ' + e.message, hook: null, opener: null });
      L.log(KIND, `${name}: FAILED ${e.message}`);
    }
    done[keyOf(p)] = L.today();
  }
  L.writeState(STATE, done);

  const md = [];
  const n = drafted.filter((d) => d.opener).length;
  md.push(`# Prospects: ${n} drafted`, '');
  md.push(`${people.length} connections in ${path.basename(csvPath)}; ${matches.length} match the keywords; ${queue.length - batch.length} more in the queue for the next runs. Nothing has been sent.`, '');
  if (warnings.length) { md.push('**Warnings**'); for (const w of warnings) md.push(`- ${w}`); md.push(''); }
  for (const d of drafted) {
    md.push(`## ${d.name} · ${[d.p.position, d.p.company].filter(Boolean).join(', ')}`);
    if (d.p.url) md.push(d.p.url);
    md.push(`- **Who:** ${d.summary}`);
    md.push(`- **Hook:** ${d.hook || 'none found; the opener does not pretend otherwise'}`);
    md.push('', '```', d.opener || '(no opener)', '```', '');
  }
  md.push(L.footer(KIND, calls, audit));
  const text = md.join('\n');
  const file = L.writeBrief(KIND, text);
  L.log(KIND, `archived ${file}`);

  const subject = `Prospects: ${n} drafted`;
  try { await L.sendBrief(cfg, { subject, markdown: text, kind: KIND }); }
  catch (e) { L.log(KIND, `EMAIL FAILED: ${e.message}. The archive at ${file} is complete.`); process.exitCode = 2; }
}

main().catch((e) => { L.log(KIND, 'FAILED: ' + (e.stack || e.message)); process.exit(1); });
