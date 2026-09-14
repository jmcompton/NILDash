#!/usr/bin/env node
'use strict';
// ── NIL WATCH: TEN LINES ON THE MARKET ───────────────────────────────────────
//
// One `claude -p` call per term, with WebSearch allowed and --max-turns as the
// guardrail, asking for items from the last few days as JSON. Everything ever
// shown is remembered by URL in state/news-seen.json (30 days), so today's
// brief never repeats yesterday's. Ten newest lines, emailed and archived.

const L = require('./lib');

const KIND = 'news-watch';
const STATE = 'news-seen.json';

function canon(url) {
  try {
    const u = new URL(String(url).trim());
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|source$)/i.test(k)) u.searchParams.delete(k);
    return (u.origin + u.pathname).replace(/\/+$/, '').toLowerCase() + (u.search || '');
  } catch (_) { return String(url || '').trim().toLowerCase(); }
}

async function main() {
  const cfg = L.loadConfig();
  const audit = L.authAudit();
  const calls = [];
  const seen = L.readState(STATE, {});
  const cutoff = L.dateOffset(-30);
  for (const k of Object.keys(seen)) if (seen[k] < cutoff) delete seen[k];

  const found = [];
  const errors = [];
  for (const term of cfg.newsTerms) {
    const prompt = `Search the web for news from the last 7 days about: "${term}" (context: the NIL market, name-image-likeness for college athletes, and the software companies serving agents, athletes and collectives). Return ONLY a JSON array of up to 5 items: [{"title": "...", "url": "https://...", "source": "publication", "published": "YYYY-MM-DD or null", "line": "one plain sentence on what happened and why it matters to a company selling NIL outreach software to agents"}]. Only include items you actually found with a real URL. No commentary outside the JSON.`;
    try {
      const r = await L.claudeP(prompt, { cfg, label: `news:${term}`, maxTurns: cfg.maxTurns.news, tools: ['WebSearch', 'WebFetch'] });
      calls.push(r);
      const items = Array.isArray(r.json) ? r.json : [];
      for (const it of items) {
        if (!it || !it.url || !/^https?:\/\//i.test(it.url)) continue;
        found.push({ term, title: String(it.title || '').trim(), url: String(it.url).trim(), source: String(it.source || '').trim(),
          published: /^\d{4}-\d{2}-\d{2}$/.test(String(it.published || '')) ? it.published : null, line: String(it.line || '').trim() });
      }
      L.log(KIND, `${term}: ${items.length} item(s) in ${r.numTurns == null ? '?' : r.numTurns} turn(s), ${Math.round(r.ms / 1000)}s`);
    } catch (e) {
      errors.push(`${term}: ${e.message}`);
      L.log(KIND, `${term}: FAILED ${e.message}`);
    }
  }

  // Dedupe: against everything shown in the last 30 days, and within today.
  const fresh = [];
  const todayKeys = new Set();
  for (const it of found) {
    const k = canon(it.url);
    if (seen[k] || todayKeys.has(k)) continue;
    todayKeys.add(k);
    fresh.push(it);
  }
  fresh.sort((a, b) => String(b.published || '') .localeCompare(String(a.published || '')));
  const lines = fresh.slice(0, cfg.newsLines);
  for (const it of lines) seen[canon(it.url)] = L.today();
  L.writeState(STATE, seen);

  const md = [];
  md.push(`# NIL watch: ${lines.length} items`, '');
  md.push(`${found.length} found across ${cfg.newsTerms.length} terms, ${found.length - fresh.length} already shown in the last 30 days, ${Math.max(0, fresh.length - lines.length)} held back beyond the ${cfg.newsLines}-line cap.`, '');
  if (!lines.length) md.push('Nothing new today.');
  lines.forEach((it, i) => {
    md.push(`${i + 1}. **${it.title || it.url}** — ${it.line} _(${[it.source, it.published].filter(Boolean).join(', ')}; ${it.term})_ ${it.url}`);
  });
  if (errors.length) { md.push('', '**Terms that failed**'); for (const e of errors) md.push(`- ${e}`); }
  md.push(L.footer(KIND, calls, audit));
  const text = md.join('\n');
  const file = L.writeBrief(KIND, text);
  L.log(KIND, `archived ${file}`);

  const subject = `NIL watch: ${lines.length} items`;
  try { await L.sendBrief(cfg, { subject, markdown: text, kind: KIND }); }
  catch (e) { L.log(KIND, `EMAIL FAILED: ${e.message}. The archive at ${file} is complete.`); process.exitCode = 2; }
}

main().catch((e) => { L.log(KIND, 'FAILED: ' + (e.stack || e.message)); process.exit(1); });
