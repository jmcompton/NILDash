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
//
// THE QUALITY FILTER. A researched person is FILTERED, not drafted, when the
// research says they are not US-based, or not working in US sports markets,
// or when no opener came back. Filtered people are recorded in the state file
// with the reason so they are not researched again; a research call that
// failed outright (timeout, claude error) is not recorded and is retried on
// the next run. The brief reports "N drafted, M filtered" with each reason.
//
// --exclude "Ann Lee,https://www.linkedin.com/in/bobray"  skips those people
// on this run only: nothing is recorded, they are back in the queue next time.

const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { addrOf, nameOf } = require('./mail-dump');
const { readMail } = require('./mail-source');
const os = require('os');

const DEBUG = process.argv.includes('--debug') || !!process.env.BRIEFS_DEBUG;
const DRY = process.argv.includes('--dry');          // count and list, draft nothing, send nothing
const NO_EMAIL = process.argv.includes('--no-email');
const dbg = (...a) => { if (DEBUG) console.log('[prospecting:debug]', ...a); };
const expandHome = (p) => String(p || '').replace(/^~(?=$|[\/\\])/, os.homedir());

const KIND = 'prospecting';
const STATE = 'prospecting-done.json';

// ── --exclude: NAMES OR LINKEDIN URLS TO SKIP THIS RUN ──────────────────────
// `--exclude a,b` or `--exclude=a,b`, repeatable. Each item is a full name
// ("Ann Lee"), a LinkedIn URL (with or without https://www.), or the handle
// after /in/. Case does not matter.
function excludeList(argv) {
  const raw = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exclude') { if (argv[i + 1] != null) raw.push(argv[++i]); }
    else if (argv[i].startsWith('--exclude=')) raw.push(argv[i].slice('--exclude='.length));
  }
  return raw.join(',').split(',').map((s) => s.trim()).filter(Boolean);
}
const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const normUrl = (u) => String(u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
const handleOf = (u) => { const m = normUrl(u).match(/\/in\/([^\/]+)$/); return m ? m[1] : ''; };
// Returns the exclude item that names this person, or null.
function excludedBy(items, p) {
  const mine = new Set([normName(`${p.first} ${p.last}`), normUrl(p.url), handleOf(p.url)].filter(Boolean));
  return items.find((t) => mine.has(normName(t)) || mine.has(normUrl(t)) || mine.has(handleOf(t)) || (/^[a-z0-9_-]+$/i.test(t) && mine.has(t.toLowerCase()))) || null;
}

// ── THE QUALITY FILTER: why a researched person is not drafted ──────────────
// null means draft them. The research JSON carries usBased and
// usSportsMarket as true / false / null (unknown); only a clear false skips,
// so a person the web knows nothing about still gets an honest opener.
function filterReason(j) {
  if (j.usBased === false) return 'not US-based' + (j.location ? ` (${j.location})` : '');
  if (j.usSportsMarket === false) return 'not working in US sports markets' + (j.location ? ` (${j.location})` : '');
  if (!String(j.opener || '').trim()) return 'no opener generated';
  return null;
}

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

// On Railway nobody drops a file into an inbox. BRIEFS_CONNECTIONS_URL (a
// direct-download link to the LinkedIn export, e.g. a Dropbox or Drive link
// with the download flag) is fetched into the inbox at the start of a run and
// then found like any other file. A failed fetch keeps the last copy.
async function fetchConnectionsIfConfigured(cfg, warnings) {
  const url = String(cfg.connectionsUrl || '').trim();
  if (!url) return;
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (!/first name/i.test(text.slice(0, 4000)) && !/,/.test(text.slice(0, 200))) throw new Error('the download is not a CSV (no header row); is the link a direct download?');
    fs.writeFileSync(path.join(L.DIRS.inbox, 'Connections.csv'), text);
    L.log(KIND, `fetched Connections.csv from BRIEFS_CONNECTIONS_URL (${text.length} chars)`);
  } catch (e) {
    warnings.push(`Could not fetch the connections CSV from BRIEFS_CONNECTIONS_URL: ${e.message}. Using the last copy if there is one.`);
    L.log(KIND, `BRIEFS_CONNECTIONS_URL fetch failed: ${e.message}`);
  }
}

// WHERE THE FILE IS LOOKED FOR, IN ORDER, and every place is reported in
// --debug. config.json's connectionsFile first (the first live run had it set
// to ~/nildash-briefs/Connections.csv, and the script only ever looked in
// inbox/, so 1,741 connections produced "No CSV"). Then the inbox. Then the
// briefs root itself, where a file dropped beside config.json lands.
function findCsv(cfg, tried) {
  const note = (where, found) => { if (tried) tried.push({ where, found }); };
  const explicit = expandHome(cfg.connectionsFile || '');
  if (explicit) {
    const p = path.isAbsolute(explicit) ? explicit : path.join(L.ROOT, explicit);
    const ok = fs.existsSync(p) && fs.statSync(p).isFile();
    note(`config connectionsFile: ${p}`, ok);
    if (ok) return p;
  }
  for (const dir of [L.DIRS.inbox, L.ROOT]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.csv$/i.test(f)).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t); } catch (_) { files = []; }
    const pick = files.find((x) => /connections/i.test(x.f)) || files[0];
    note(`${dir}/*.csv (${files.length} csv file(s)${files.length ? ': ' + files.map((x) => x.f).join(', ') : ''})`, !!pick);
    if (pick) return path.join(dir, pick.f);
  }
  return null;
}

// What --debug prints about the config: every key, secrets masked.
function describeConfig(cfg) {
  const mask = (v) => (v ? String(v).slice(0, 6) + '…' + String(v).slice(-3) : '(unset)');
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === '_source') continue;
    out[k] = /apikey|password|secret|token/i.test(k) ? mask(v) : v;
  }
  return out;
}

async function main() {
  const cfg = L.loadConfig();
  const audit = L.authAudit();
  const calls = [];
  const warnings = [];

  if (DEBUG) {
    dbg('config loaded from', cfg._source && cfg._source.file ? L.CONFIG_PATH : '(no config.json)', 'with', (cfg._source && cfg._source.env.length) ? 'environment overrides: ' + cfg._source.env.join(', ') : 'no environment overrides');
    dbg('config:', JSON.stringify(describeConfig(cfg), null, 2));
    dbg('briefs root:', L.ROOT, ' inbox:', L.DIRS.inbox, ' state:', L.DIRS.state);
  }
  await fetchConnectionsIfConfigured(cfg, warnings);
  const tried = [];
  const csvPath = findCsv(cfg, tried);
  if (DEBUG) for (const t of tried) dbg(`looked ${t.found ? 'FOUND  ' : 'nothing'} ${t.where}`);
  if (!csvPath) {
    dbg('why 0: no CSV was found in any of the places above; nothing to filter');
    const md = [`# Prospects: 0 drafted`, '', `No connections CSV. Looked for: ${tried.map((t) => t.where).join('; ')}. Set connectionsFile in config.json (or BRIEFS_CONNECTIONS_FILE) to the LinkedIn export, or drop Connections.csv in ${L.DIRS.inbox}.`, L.footer(KIND, calls, audit)].join('\n');
    L.writeBrief(KIND, md);
    if (!NO_EMAIL && !DRY) await L.sendBrief(cfg, { subject: 'Prospects: 0 drafted', markdown: md, kind: KIND }).catch((e) => L.log(KIND, 'EMAIL FAILED: ' + e.message));
    return;
  }
  dbg('reading', csvPath);
  const csvText = fs.readFileSync(csvPath, 'utf8');
  const rawLines = csvText.split(/\r?\n/);
  const headerLine = rawLines.findIndex((l) => /first name/i.test(l));
  dbg(`file: ${csvText.length} chars, ${rawLines.filter((l) => l.trim()).length} non-empty lines; header row at line ${headerLine + 1}${headerLine > 0 ? ` (after ${headerLine} line(s) of LinkedIn preamble)` : ''}${headerLine < 0 ? ' -- NO "First Name" HEADER FOUND, the file is not a LinkedIn Connections export' : ''}`);
  if (DEBUG && headerLine >= 0) dbg('header:', rawLines[headerLine]);
  const people = parseCsv(csvText);
  dbg(`parsed ${people.length} connection(s)`);
  if (DEBUG) for (const p of people.slice(0, 5)) dbg('  row:', JSON.stringify({ first: p.first, last: p.last, company: p.company, position: p.position, email: p.email || '(withheld)', connectedOn: p.connectedOn }));
  const kw = cfg.prospectKeywords.map((k) => String(k).toLowerCase());
  const hayOf = (p) => `${p.position} ${p.company}`.toLowerCase();
  const matches = people.filter((p) => kw.some((k) => hayOf(p).includes(k)));
  if (DEBUG) {
    dbg(`keywords (${kw.length}): ${kw.join(', ')}`);
    for (const k of kw) dbg(`  "${k}": ${people.filter((p) => hayOf(p).includes(k)).length} match(es) in position or company`);
    dbg(`${matches.length} of ${people.length} match at least one keyword`);
    if (!people.length) dbg('why 0: the parser returned no rows (see the header line above)');
    else if (!matches.length) dbg('why 0: no position or company contains any keyword; sample positions: ' + people.slice(0, 8).map((p) => JSON.stringify(p.position || '(blank)')).join(', '));
  }

  // Exclusions: sent mail (address or name) and earlier runs.
  const mail = await readMail({ ...cfg, lookbackDays: Math.max(cfg.lookbackDays, 365) }, { debug: DEBUG });
  if (mail.warnings.length) warnings.push(...mail.warnings.map((w) => 'mail: ' + w));
  const sentAddr = new Set(), sentNames = new Set();
  for (const m of mail.sent) {
    for (const t of (m.to || []).concat(m.cc || [])) { const a = addrOf(t); if (a) sentAddr.add(a); const n = nameOf(t).toLowerCase(); if (n) sentNames.add(n); }
  }
  if (!mail.sent.length) warnings.push('sent mail was empty or unreadable, so nobody was excluded on that basis');
  const done = L.readState(STATE, {});
  const keyOf = (p) => (p.url || `${p.first} ${p.last}|${p.company}`).toLowerCase();
  const exclude = excludeList(process.argv.slice(2));
  const excludedNames = [];
  const dropped = { drafted: 0, sentAddress: 0, sentName: 0, excluded: 0 };
  const queue = matches.filter((p) => {
    if (done[keyOf(p)]) { dropped.drafted++; return false; }
    if (p.email && sentAddr.has(p.email)) { dropped.sentAddress++; return false; }
    if (sentNames.has(`${p.first} ${p.last}`.toLowerCase())) { dropped.sentName++; return false; }
    const by = exclude.length ? excludedBy(exclude, p) : null;
    if (by) { dropped.excluded++; excludedNames.push(`${p.first} ${p.last}`.trim()); dbg(`excluded this run: ${p.first} ${p.last} (--exclude "${by}")`); return false; }
    return true;
  });
  if (exclude.length) {
    const unmatched = exclude.filter((t) => !people.some((p) => excludedBy([t], p)));
    if (unmatched.length) warnings.push(`--exclude did not match any connection in the CSV: ${unmatched.map((t) => `"${t}"`).join(', ')}`);
    L.log(KIND, `--exclude: ${exclude.length} item(s), ${dropped.excluded} skipped this run${unmatched.length ? `, ${unmatched.length} matched nobody` : ''}`);
  }
  const batch = queue.slice(0, cfg.prospectsPerRun);
  L.log(KIND, `${people.length} connections, ${matches.length} match keywords, ${queue.length} not yet contacted or drafted, drafting ${batch.length}`);
  if (DEBUG) {
    dbg(`exclusions: ${dropped.drafted} drafted on an earlier run (${Object.keys(done).length} in ${STATE}), ${dropped.sentAddress} already in sent mail by address, ${dropped.sentName} by name (${mail.sent.length} sent message(s) read, ${sentAddr.size} address(es)), ${dropped.excluded} by --exclude`);
    dbg(`queue: ${queue.length}; this run drafts up to ${cfg.prospectsPerRun}`);
    if (matches.length && !queue.length) dbg('why 0: every keyword match was excluded, by the reasons above. Delete state/' + STATE + ' to draft them again.');
    for (const p of queue.slice(0, 10)) dbg('  next:', `${p.first} ${p.last}`, '|', p.position, '@', p.company);
  }
  if (DRY) { console.log(`[prospecting] --dry: ${people.length} connections, ${matches.length} matches, ${dropped.excluded} excluded by --exclude, ${queue.length} in the queue, would research ${batch.length}. Nothing drafted or sent.`); return; }

  const drafted = [], filtered = [];
  for (const p of batch) {
    const name = `${p.first} ${p.last}`.trim();
    const prompt = `Research this person briefly on the web and draft a LinkedIn opener from me.

PERSON: ${name}, ${p.position || 'unknown title'} at ${p.company || 'unknown company'}${p.url ? ' (' + p.url + ')' : ''}. We are connected on LinkedIn.
ME: ${cfg.aboutMe}

Return ONLY JSON: {"summary": "two lines on who they are and what they do, from what you found", "location": "the city, state or country they are based in, from what you found, or null", "usBased": true or false, or null when you could not tell, "usSportsMarket": true when their work touches US college or pro sports, athletes, NIL, athletic departments, or sports business in the US; false when it clearly does not; null when you could not tell, "hook": "the one thing about them that makes NILDash relevant, or null if nothing real", "opener": "3-4 sentences, first person, plain, no flattery, no em dashes, no exclamation marks, ends with one easy question; if hook is null write an honest short opener that does not pretend to know them; null when usBased or usSportsMarket is false"}. Never invent facts about them; if you found nothing, say so in summary and leave usBased and usSportsMarket null.`;
    try {
      const r = await L.claudeP(prompt, { cfg, label: `prospect:${name}`, maxTurns: cfg.maxTurns.prospect, tools: ['WebSearch', 'WebFetch'] });
      calls.push(r);
      const j = r.json && !Array.isArray(r.json) ? r.json : {};
      const summary = String(j.summary || '(no research returned)');
      const reason = filterReason(j);
      if (reason) {
        filtered.push({ p, name, reason, summary, retry: false });
        done[keyOf(p)] = `${L.today()} filtered: ${reason}`;
        L.log(KIND, `${name}: filtered (${reason}), ${r.numTurns == null ? '?' : r.numTurns} turn(s), ${Math.round(r.ms / 1000)}s`);
      } else {
        drafted.push({ p, name, summary, location: j.location || null, hook: j.hook || null, opener: String(j.opener).trim() });
        done[keyOf(p)] = L.today();
        L.log(KIND, `${name}: drafted, ${r.numTurns == null ? '?' : r.numTurns} turn(s), ${Math.round(r.ms / 1000)}s`);
      }
    } catch (e) {
      // Not recorded: a failed call says nothing about the person, so they are
      // researched again on the next run.
      filtered.push({ p, name, reason: 'research failed: ' + e.message, summary: null, retry: true });
      L.log(KIND, `${name}: FAILED ${e.message} (not recorded, retried next run)`);
    }
  }
  L.writeState(STATE, done);

  const n = drafted.length;
  const reasons = {};
  for (const f of filtered) { const k = f.retry ? 'research failed' : f.reason.replace(/ \(.*\)$/, ''); reasons[k] = (reasons[k] || 0) + 1; }
  const breakdown = Object.entries(reasons).map(([k, v]) => `${v} ${k}`).join(', ');
  L.log(KIND, `drafted ${n}, filtered ${filtered.length}${breakdown ? ` (${breakdown})` : ''}, excluded by --exclude ${dropped.excluded}`);

  const md = [];
  md.push(`# Prospects: ${n} drafted, ${filtered.length} filtered`, '');
  md.push(`${people.length} connections in ${path.basename(csvPath)}; ${matches.length} match the keywords; ${batch.length} researched this run: ${n} drafted, ${filtered.length} filtered${breakdown ? ` (${breakdown})` : ''}${dropped.excluded ? `; ${dropped.excluded} skipped by --exclude (${excludedNames.join(', ')})` : ''}; ${queue.length - batch.length} more in the queue for the next runs. Nothing has been sent.`, '');
  if (warnings.length) { md.push('**Warnings**'); for (const w of warnings) md.push(`- ${w}`); md.push(''); }
  if (filtered.length) {
    md.push(`## Filtered (${filtered.length})`, '');
    for (const f of filtered) md.push(`- **${f.name}** · ${[f.p.position, f.p.company].filter(Boolean).join(', ')}${f.p.url ? ` · ${f.p.url}` : ''}: ${f.reason}${f.retry ? ' (will be retried next run)' : ''}${f.summary && !f.retry ? ` | ${f.summary}` : ''}`);
    md.push('');
  }
  for (const d of drafted) {
    md.push(`## ${d.name} · ${[d.p.position, d.p.company].filter(Boolean).join(', ')}`);
    if (d.p.url) md.push(d.p.url);
    md.push(`- **Who:** ${d.summary}${d.location ? ` (${d.location})` : ''}`);
    md.push(`- **Hook:** ${d.hook || 'none found; the opener does not pretend otherwise'}`);
    md.push('', '```', d.opener, '```', '');
  }
  md.push(L.footer(KIND, calls, audit));
  const text = md.join('\n');
  const file = L.writeBrief(KIND, text);
  L.log(KIND, `archived ${file}`);

  const subject = `Prospects: ${n} drafted, ${filtered.length} filtered`;
  if (NO_EMAIL) { L.log(KIND, `--no-email: "${subject}" archived, not sent`); return; }
  try { await L.sendBrief(cfg, { subject, markdown: text, kind: KIND }); }
  catch (e) { L.log(KIND, `EMAIL FAILED: ${e.message}. The archive at ${file} is complete.`); process.exitCode = 2; }
}

main().catch((e) => { L.log(KIND, 'FAILED: ' + (e.stack || e.message)); process.exit(1); });
