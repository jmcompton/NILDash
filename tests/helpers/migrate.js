'use strict';
// ── THE SQL MIGRATIONS, APPLIED THE WAY THE SERVER DOES AT BOOT ─────────────
//
// server/index.js runs server/migrations/*.sql on startup, statement by
// statement, a failing statement costing only itself. A suite that needs a
// migration's tables (university_teams, university_market_*) and inserts
// before -- or without -- booting the server used to depend on some earlier
// suite having booted it against the same database. This applies them
// itself, with the server's own splitter lifted from server/index.js (as
// tests/split.js does), so it cannot drift from what production runs.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..', '..') + path.sep;

function lift(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(`migrate helper: ${name} not found in server/index.js`);
  let p = 0, i = src.indexOf('(', start);
  for (; i < src.length; i++) { if (src[i] === '(') p++; else if (src[i] === ')') { p--; if (!p) break; } }
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) break; } }
  return src.slice(start, j + 1);
}
let _split = null;
function splitter() {
  if (_split) return _split;
  const SRV = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  _split = new Function(lift(SRV, 'splitSqlStatements') + '\n return splitSqlStatements;')();
  return _split;
}

// -> { files, ok, failed: [{ file, error }] }. Never throws on a statement.
async function migrate(pool) {
  const dir = REPO + 'server/migrations';
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const split = splitter();
  let ok = 0; const failed = [];
  for (const file of files) {
    for (const stmt of split(fs.readFileSync(path.join(dir, file), 'utf8'))) {
      try { await pool.query(stmt); ok++; } catch (e) { failed.push({ file, error: e.message }); }
    }
  }
  return { files: files.length, ok, failed };
}

module.exports = { migrate };
