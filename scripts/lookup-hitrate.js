#!/usr/bin/env node
'use strict';
// ── HOW OFTEN THE ATHLETE LOOKUP FINDS SOMEONE, BY LEVEL ─────────────────────
//
//   node scripts/lookup-hitrate.js --file athletes.csv [--force] [--limit 40]
//   node scripts/lookup-hitrate.js --sample            a built-in list of public names
//
// The CSV has a header and columns name, school (or team for a pro), level
// (college | high_school | pro), and optionally sport. Runs the real lookup
// (services/athleteLookup: the roster feeds, then DeepSeek through Serper),
// so it needs DEEPSEEK_API_KEY and SERPER_API_KEY and a DATABASE_URL for
// the cache and the ledger. Run it from the Mac against production or from
// Railway; the development sandbox reaches none of the feeds.
//
// Prints one line per lookup (found, candidates, which fields were filled,
// cost, ms) and a table per level: lookups, found, hit rate, fields filled
// per found athlete, average cost. --force reads past the cache so the hit
// rate is measured, not remembered.

const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const has = (k) => args.includes(k);

const SAMPLE = [
  { name: 'Caleb Williams', team: 'Chicago Bears', sport: 'football', level: 'pro' },
  { name: 'Caitlin Clark', team: 'Indiana Fever', sport: 'basketball', level: 'pro' },
  { name: 'Bobby Witt Jr.', team: 'Kansas City Royals', sport: 'baseball', level: 'pro' },
  { name: 'Nathan MacKinnon', team: 'Colorado Avalanche', sport: 'hockey', level: 'pro' },
  { name: 'Arch Manning', school: 'Texas', sport: 'football', level: 'college' },
  { name: 'JuJu Watkins', school: 'USC', sport: "women's basketball", level: 'college' },
  { name: 'NiJaree Canady', school: 'Texas Tech', sport: 'softball', level: 'college' },
  { name: 'Ryan Williams', school: 'Alabama', sport: 'football', level: 'college' },
  { name: 'Bryce Underwood', school: 'Belleville High School', sport: 'football', level: 'high_school' },
  { name: 'Cooper Flagg', school: 'Montverde Academy', sport: 'basketball', level: 'high_school' },
];

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',').map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((l) => {
    const cells = l.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const row = {}; head.forEach((h, i) => { row[h] = cells[i] || ''; });
    return { name: row.name, school: row.school || '', team: row.team || row.school || '', sport: row.sport || '', level: (row.level || 'college').toLowerCase().replace(/\s+/g, '_') };
  }).filter((r) => r.name);
}

async function main() {
  const file = val('--file');
  let list = has('--sample') ? SAMPLE : (file ? parseCsv(fs.readFileSync(path.resolve(file), 'utf8')) : null);
  if (!list) { console.log('usage: node scripts/lookup-hitrate.js --file athletes.csv [--force] [--limit N]  |  --sample'); process.exit(1); }
  const limit = parseInt(val('--limit'), 10); if (limit) list = list.slice(0, limit);
  const force = has('--force');
  const AL = require('../server/services/athleteLookup');
  const DS = require('../server/services/deepseek');
  console.log(`lookup-hitrate: ${list.length} lookup(s), ${force ? 'cache bypassed' : 'cache allowed'}; ${DS.describeRouting()}\n`);
  const FIELDS = ['sport', 'position', 'year', 'jersey', 'hometown', 'height', 'weight', 'instagramHandle', 'instagram', 'tiktokHandle', 'tiktok', 'highlight'];
  const per = new Map();
  for (const q of list) {
    const level = q.level === 'pro' ? 'pro' : (q.level === 'high_school' ? 'high_school' : 'college');
    const query = { name: q.name, school: level === 'pro' ? '' : q.school, team: level === 'pro' ? (q.team || q.school) : '', sport: q.sport || '', athleteType: level === 'pro' ? 'pro' : 'college', level };
    let r;
    try { r = await AL.resolveAthlete(null, query, { force }); }
    catch (e) { r = { found: false, candidates: [], message: e.message, costUsd: 0, ms: 0 }; }
    const best = r.candidates && r.candidates[0];
    const filled = best ? FIELDS.filter((f) => best[f] !== null && best[f] !== undefined && best[f] !== '' && best[f] !== 0) : [];
    const g = per.get(level) || { n: 0, found: 0, fields: 0, usd: 0, ms: 0 };
    g.n++; if (r.found) { g.found++; g.fields += filled.length; } g.usd += r.costUsd || 0; g.ms += r.ms || 0; per.set(level, g);
    console.log(`${r.found ? ' hit ' : 'MISS '} ${level.padEnd(11)} ${q.name.padEnd(22)} ${(query.school || query.team || '').padEnd(22)} ${String((r.candidates || []).length)} cand  ${filled.length.toString().padStart(2)} fields${r.cached ? ' (cached)' : ''}  $${(r.costUsd || 0).toFixed(4)}  ${r.ms}ms${r.found ? '' : '  ' + (r.message || '')}`
      + (filled.length ? `\n       ${filled.map((f) => `${f}=${String(best[f]).slice(0, 24)}`).join('  ')}` : ''));
  }
  console.log('\nHIT RATE BY LEVEL');
  console.log(`  ${'level'.padEnd(12)} ${'lookups'.padStart(8)} ${'found'.padStart(6)} ${'rate'.padStart(6)} ${'fields/found'.padStart(13)} ${'avg usd'.padStart(9)} ${'avg ms'.padStart(8)}`);
  for (const [level, g] of per) {
    console.log(`  ${level.padEnd(12)} ${String(g.n).padStart(8)} ${String(g.found).padStart(6)} ${(Math.round(100 * g.found / g.n) + '%').padStart(6)} ${(g.found ? (g.fields / g.found).toFixed(1) : '-').padStart(13)} ${('$' + (g.usd / g.n).toFixed(4)).padStart(9)} ${String(Math.round(g.ms / g.n)).padStart(8)}`);
  }
  try { await require('../server/services/aiLedger').drain(); } catch (_) {}
  process.stdout.write('', () => process.exit(0));
}
main().catch((e) => { console.error('lookup-hitrate: THREW', e); process.exit(1); });
