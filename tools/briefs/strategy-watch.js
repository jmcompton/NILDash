#!/usr/bin/env node
'use strict';
// ── STRATEGY WATCH: SEND ONLY WHEN SOMETHING MOVED ───────────────────────────
//
// Three things, watched with Haiku through `claude -p` (subscription, never
// the API; see lib.js):
//
//   1. Legislation   S. 4668 (Protect College Sports Act), NIL agent
//                    regulation, NCAA NIL rule changes. A vote scheduled, an
//                    amendment, committee movement. ONE PARAGRAPH, sources
//                    linked.
//   2. Competitors   new NIL agent software, CRMs, compliance tools announced
//                    or funded. Flagged when it competes with NILDash's agent
//                    workflow. One line each.
//   3. Market        a major NIL deal, an agency announcement, a College
//                    Sports Commission report. One line each.
//
// THE RULE: nothing is sent unless something meaningful changed since the
// last send. config.json carries strategyWatch.lastSentAt and a list of the
// URLs already shown (strategyWatch.seen, kept 90 days), so an item is never
// repeated and a quiet week produces no email at all. The archive file is
// written only when an email goes out; a quiet run leaves one log line.
//
//   node tools/briefs/strategy-watch.js                 the cron run
//   node tools/briefs/strategy-watch.js --print         print the brief too
//   node tools/briefs/strategy-watch.js --no-email      build and archive, do not send
//   node tools/briefs/strategy-watch.js --force         send even if nothing changed (a pipe test)
//   node tools/briefs/strategy-watch.js --since 2026-09-01   look back from a date

const fs = require('fs');
const L = require('./lib');

const KIND = 'strategy-watch';
const MODEL = 'haiku';
const SEEN_DAYS = 90;
const MAX_LINES = 6;              // per list section; the whole email stays under a page
const MAX_PARAGRAPH_WORDS = 130;

// What is "meaningful" is decided twice: the search prompt asks for it, and
// the filter below drops anything the model marked false or left blank. The
// kinds are fixed so the model cannot invent a category to smuggle noise in.
const WATCH = [
  {
    key: 'legislation', title: 'Legislation',
    kinds: ['vote', 'amendment', 'committee', 'rule', 'hearing', 'introduced', 'signed'],
    query: (since) => `Search the web for developments since ${since} on: (a) S. 4668, the Protect College Sports Act, in the U.S. Senate; (b) federal or state regulation of NIL agents (registration, certification, fee caps, agent laws for college athletes); (c) NCAA NIL rule changes, and the College Sports Commission's NIL rules. ` +
      `Report ONLY concrete movement: a vote scheduled or held, an amendment filed or adopted, a committee markup or hearing, a rule adopted, a bill introduced or signed. Not opinion pieces, not explainers, not restatements of an old bill.`,
    lineAsk: 'one plain sentence: what moved, when, and what it would change for sports agents doing NIL deals',
  },
  {
    key: 'competitors', title: 'Competitors',
    kinds: ['launch', 'funding', 'feature', 'acquisition', 'partnership'],
    query: (since) => `Search the web for announcements since ${since} of new or updated software for the NIL market: NIL agent software, athlete-representation CRMs, NIL deal marketplaces, NIL compliance or disclosure tools, brand-athlete matching tools, collective management platforms. Include funding rounds, launches, major features and acquisitions. Known names to check: Opendorse, INFLCR (Teamworks), Basepath, SponsorFlo, Duffl, Athliance, NOCAP Sports, MOGL, Postgame, Icon Source, Altius, Blueprint Sports, Campus Ink, Marketpryce, Dreamfield, NIL Store.`,
    lineAsk: 'one plain sentence: who, what they announced, and whether it overlaps with software that finds local businesses for an agent\'s athletes and writes the outreach (say "competes" or "adjacent")',
  },
  {
    key: 'market', title: 'Market signals',
    kinds: ['deal', 'agency', 'csc', 'report', 'lawsuit', 'enforcement'],
    query: (since) => `Search the web for NIL market news since ${since}: a major NIL deal (six figures or a notable brand), a sports agency announcement (a new NIL division, a merger, a notable signing of a college athlete), a College Sports Commission report, ruling, enforcement action or published data, or a court ruling that changes how NIL deals are done.`,
    lineAsk: 'one plain sentence: what happened and why an NIL agent should know',
  },
];

function canon(url) {
  try {
    const u = new URL(String(url).trim());
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|source$)/i.test(k)) u.searchParams.delete(k);
    return (u.origin + u.pathname).replace(/\/+$/, '').toLowerCase() + (u.search || '');
  } catch (_) { return String(url || '').trim().toLowerCase(); }
}
function isoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null; }

function searchPrompt(w, since) {
  return `${w.query(since)}\n\nReturn ONLY a JSON array of up to 8 items, newest first:\n` +
    `[{"title": "...", "url": "https://...", "source": "publication or site", "published": "YYYY-MM-DD or null", ` +
    `"kind": one of ${JSON.stringify(w.kinds)} or "other", "meaningful": true or false, "line": "${w.lineAsk}"}]\n` +
    `Rules: only items you actually found, each with its real URL; "meaningful" is true only for concrete movement of the kinds listed and false for commentary, explainers or repeats of older news; ` +
    `only items published on or after ${since}; no text outside the JSON.`;
}

// The state that lives in config.json: when the last email went out, and
// what it showed. Read from the raw file (not the merged defaults) and
// written back to the same file, everything else in it untouched.
function readWatchState(configPath) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { raw = {}; }
  const sw = raw.strategyWatch && typeof raw.strategyWatch === 'object' ? raw.strategyWatch : {};
  return { raw, lastSentAt: isoDate(sw.lastSentAt), seen: sw.seen && typeof sw.seen === 'object' ? sw.seen : {} };
}
function writeWatchState(configPath, raw, { lastSentAt, seen }) {
  const cutoff = L.dateOffset(-SEEN_DAYS);
  const kept = {};
  for (const [k, d] of Object.entries(seen)) if (!isoDate(d) || d >= cutoff) kept[k] = d;
  const next = Object.assign({}, raw, { strategyWatch: Object.assign({}, raw.strategyWatch || {}, { lastSentAt, seen: kept }) });
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
}

// Everything found -> what is new, meaningful and not yet shown.
function filterFresh(found, { seen, since }) {
  const fresh = [];
  const keys = new Set();
  for (const it of found) {
    if (!it || !it.url || !/^https?:\/\//i.test(String(it.url))) continue;
    if (it.meaningful !== true) continue;
    if (!String(it.line || '').trim()) continue;
    const k = canon(it.url);
    if (seen[k] || keys.has(k)) continue;
    if (it.published && it.published < since) continue;
    keys.add(k);
    fresh.push(it);
  }
  fresh.sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
  return fresh;
}

function itemLine(it) {
  const meta = [it.source, it.published].filter(Boolean).join(', ');
  return `- **${it.title || it.source || 'Item'}** — ${it.line}${meta ? ` _(${meta})_` : ''} ${it.url}`;
}

// The legislation paragraph: one Haiku call with no tools over the fresh
// items, falling back to the items' own sentences joined. Every source is
// linked whichever way it is written.
async function legislationParagraph(items, claudeP, cfg, calls) {
  if (!items.length) return '';
  const links = items.map((it) => `[${it.source || it.title || 'source'}](${it.url})`).join(', ');
  const fallback = items.map((it) => it.line.replace(/\.?$/, '')).join('. ') + `. Sources: ${links}.`;
  const prompt = `Write ONE paragraph of at most ${MAX_PARAGRAPH_WORDS} words for a founder who sells software to NIL sports agents, summarising these legislative and regulatory developments and what they would change for agents. Plain sentences, no bullet points, no headings, no preamble. Do not add facts beyond the items. Items:\n` +
    items.map((it, i) => `${i + 1}. ${it.title} (${it.source || ''}, ${it.published || 'date unknown'}): ${it.line}`).join('\n');
  try {
    const r = await claudeP(prompt, { cfg, label: 'strategy:legislation-paragraph', maxTurns: 1, model: MODEL });
    calls.push(r);
    const text = String(r.text || '').replace(/\s+/g, ' ').trim();
    const words = text.split(' ').filter(Boolean);
    if (words.length < 15 || words.length > MAX_PARAGRAPH_WORDS + 40 || /^\s*[\[{]/.test(text)) return fallback;
    return `${text} Sources: ${links}.`;
  } catch (e) {
    L.log(KIND, `legislation paragraph FAILED ${e.message}; using the items' own lines`);
    return fallback;
  }
}

function renderBrief({ sections, since, counts, errors, footer }) {
  const md = [];
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  md.push(`# Strategy watch: ${total} change${total === 1 ? '' : 's'} since ${since}`, '');
  for (const s of sections) {
    if (!s.items.length) continue;
    md.push(`## ${s.title}`, '');
    if (s.paragraph) md.push(s.paragraph, '');
    else { for (const it of s.items) md.push(itemLine(it)); md.push(''); }
  }
  md.push(`_${counts.found} found, ${counts.notMeaningful} not meaningful, ${counts.alreadyShown} already shown, ${counts.heldBack} held back by the per-section cap._`);
  if (errors.length) { md.push('', '**Searches that failed**'); for (const e of errors) md.push(`- ${e}`); }
  md.push(footer);
  return md.join('\n');
}

// opts: { cfg, claudeP, sendBrief, configPath, force, noEmail, since, print }
async function run(opts = {}) {
  const cfg = opts.cfg || L.loadConfig();
  const claudeP = opts.claudeP || L.claudeP;
  const sendBrief = opts.sendBrief || L.sendBrief;
  const configPath = opts.configPath || L.CONFIG_PATH;
  const audit = L.authAudit();
  const calls = [];
  const errors = [];

  const st = readWatchState(configPath);
  const since = isoDate(opts.since) || st.lastSentAt || L.dateOffset(-7);
  L.log(KIND, `looking back to ${since}${st.lastSentAt ? ` (last sent ${st.lastSentAt})` : ' (never sent)'}, ${Object.keys(st.seen).length} url(s) already shown`);

  const counts = { found: 0, notMeaningful: 0, alreadyShown: 0, heldBack: 0 };
  const sections = [];
  for (const w of WATCH) {
    let found = [];
    try {
      const r = await claudeP(searchPrompt(w, since), { cfg, label: `strategy:${w.key}`, maxTurns: cfg.maxTurns.strategy, tools: ['WebSearch', 'WebFetch'], model: MODEL });
      calls.push(r);
      found = (Array.isArray(r.json) ? r.json : []).map((it) => ({
        section: w.key, title: String((it && it.title) || '').trim(), url: String((it && it.url) || '').trim(),
        source: String((it && it.source) || '').trim(), published: isoDate(it && it.published),
        kind: String((it && it.kind) || 'other'), meaningful: !!(it && it.meaningful === true), line: String((it && it.line) || '').trim(),
      }));
      L.log(KIND, `${w.key}: ${found.length} item(s), ${found.filter((x) => x.meaningful).length} meaningful, in ${r.numTurns == null ? '?' : r.numTurns} turn(s), ${Math.round(r.ms / 1000)}s`);
    } catch (e) {
      errors.push(`${w.title}: ${e.message}`);
      L.log(KIND, `${w.key}: FAILED ${e.message}`);
    }
    counts.found += found.length;
    counts.notMeaningful += found.filter((x) => !x.meaningful).length;
    const fresh = filterFresh(found, { seen: st.seen, since });
    counts.alreadyShown += found.filter((x) => x.meaningful && st.seen[canon(x.url)]).length;
    const items = fresh.slice(0, MAX_LINES);
    counts.heldBack += Math.max(0, fresh.length - items.length);
    sections.push({ key: w.key, title: w.title, items, paragraph: '' });
  }

  const leg = sections.find((s) => s.key === 'legislation');
  if (leg && leg.items.length) leg.paragraph = await legislationParagraph(leg.items, claudeP, cfg, calls);

  const total = sections.reduce((n, s) => n + s.items.length, 0);
  if (!total && !opts.force) {
    L.log(KIND, `nothing meaningful since ${since} (${counts.found} found, ${counts.notMeaningful} not meaningful, ${counts.alreadyShown} already shown${errors.length ? `, ${errors.length} search(es) failed` : ''}); no email`);
    return { sent: false, total: 0, counts, errors, since };
  }

  const text = renderBrief({ sections, since, counts, errors, footer: L.footer(KIND, calls, audit) });
  const file = L.writeBrief(KIND, text);
  L.log(KIND, `archived ${file}`);
  if (opts.print) console.log('\n' + text + '\n');
  if (opts.noEmail) { L.log(KIND, '--no-email: not sent, config.json not updated'); return { sent: false, total, counts, errors, since, text, file }; }

  const subject = total ? `Strategy watch: ${total} change${total === 1 ? '' : 's'}` : 'Strategy watch: pipe test, nothing changed';
  await sendBrief(cfg, { subject, markdown: text, kind: KIND });
  // Only after the email went out: the date moves and the urls are remembered.
  const seen = Object.assign({}, st.seen);
  for (const s of sections) for (const it of s.items) seen[canon(it.url)] = L.today();
  writeWatchState(configPath, st.raw, { lastSentAt: L.today(), seen });
  L.log(KIND, `config.json: lastSentAt=${L.today()}, ${Object.keys(seen).length} url(s) remembered`);
  return { sent: true, total, counts, errors, since, text, file };
}

module.exports = { run, filterFresh, renderBrief, readWatchState, writeWatchState, searchPrompt, canon, WATCH, MAX_LINES, MODEL };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  run({ force: argv.includes('--force'), noEmail: argv.includes('--no-email'), print: argv.includes('--print'), since: val('--since') })
    .then((r) => { if (r.sent === false && r.total && !argv.includes('--no-email')) process.exitCode = 2; })
    .catch((e) => { L.log(KIND, 'FAILED: ' + (e.stack || e.message)); process.exit(1); });
}
