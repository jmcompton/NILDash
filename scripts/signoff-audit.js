'use strict';
// ── THE SIGN-OFF AUDIT, RUNNABLE FROM THE BROWSER ───────────────────────────
//
// Runs scripts/signoff-audit.sql against the app's own database and prints
// each section as a table. The SQL file stays the one source of the queries:
// this reads it, splits it on its \echo headings, and runs each block as-is.
// Read-only: every block is a SELECT.
//
//   node scripts/signoff-audit.js
//   /api/admin/scripts/signoff-audit?text=1
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
// Same wait as the other admin scripts: requiring the store starts its schema
// init, and ending the pool under it prints init errors.
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

// "\echo '== 1. Sent emails ... =='" followed by one statement, per section.
function sections(sql) {
  const out = [];
  let cur = null;
  for (const line of sql.split('\n')) {
    const m = line.match(/^\\echo\s+'(.*)'\s*$/);
    if (m) { if (cur) out.push(cur); cur = { title: m[1], sql: '' }; continue; }
    if (cur && !/^\s*--/.test(line)) cur.sql += line + '\n';
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ title: s.title, sql: s.sql.trim().replace(/;\s*$/, '') })).filter((s) => s.sql);
}

function table(rows) {
  if (!rows.length) return '  (none)';
  const cols = Object.keys(rows[0]);
  const cell = (v) => (v == null ? '' : v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 16) : String(v))
    .replace(/\s+/g, ' ').slice(0, 60);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals) => '  ' + vals.map((v, i) => v.padEnd(w[i])).join('  ');
  return [line(cols), line(w.map((n) => '-'.repeat(n))), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))].join('\n');
}

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const blocks = sections(fs.readFileSync(ROOT + 'scripts/signoff-audit.sql', 'utf8'));
  if (!blocks.length) throw new Error('no sections found in signoff-audit.sql');
  console.log('SIGN-OFF AUDIT  ' + new Date().toISOString());
  console.log('Messages that left under a stand-in name ("JohnMark", "Your Agent", "NIL Agent", "Agent",');
  console.log('or an email local part), and who received them. Read-only.\n');
  for (const b of blocks) {
    console.log(b.title);
    try {
      const rows = (await P.query(b.sql)).rows;
      console.log(table(rows));
      console.log(`  ${rows.length} row${rows.length === 1 ? '' : 's'}\n`);
    } catch (e) {
      console.log('  QUERY FAILED: ' + e.message + '\n');
    }
  }
  try { await P.end(); } catch (_) {}
  process.exit(0);
}
main().catch((e) => { console.error('signoff-audit: FAILED', e); process.exit(1); });
