'use strict';
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// CREATE TABLE IF NOT EXISTS IS A NO-OP ON A TABLE THAT ALREADY EXISTS. Not a
// partial apply, not an error -- Postgres reads the name, sees the table, and
// returns success without looking at a single column. So adding a column to a
// CREATE TABLE block works perfectly on every fresh database (every test run,
// every new environment, every laptop) and does absolutely nothing to
// production, where the table was created months ago.
//
// The failure surfaces days later as `column "x" does not exist`, thrown by a
// query nobody changed, in a lane whose catch returns [] -- so it reads as a
// thin market rather than as a broken deploy:
//
//   deal_comps.brand         getTopNilComps threw on every athlete, every run,
//                            for a week. The national lane returned nothing.
//   deal_comps.school        the same table, the same week, the same shape.
//   email_verify_credit_log  the ledger table shipped without its migration.
//   market_deepen_log        a composite key added inside the CREATE.
//
// Four instances of one mistake. This finds the rest of them mechanically.
//
// THE RULE: every column named in a CREATE TABLE IF NOT EXISTS must ALSO have an
// ALTER TABLE ... ADD COLUMN IF NOT EXISTS somewhere. The ALTER is what actually
// reaches an existing database; the CREATE is only what a fresh one gets. Both
// are idempotent, so carrying both costs nothing and the pair is the only shape
// that is correct in both directions.

const fs = require('fs');
const path = require('path');

// Table-level constraints look like columns to a naive splitter. None of these
// is a column and none of them needs an ALTER.
const CONSTRAINT_START = /^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT|EXCLUDE|LIKE|INHERITS)\b/i;

// Reserved words that can never be a column name; a match means the split went
// wrong and the fragment is not a column definition.
const NOT_A_NAME = /^(SELECT|FROM|WHERE|AND|OR|AS|ON|USING|WITH|REFERENCES|DEFAULT|NOT|NULL)$/i;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Split a CREATE TABLE body on commas that are at paren depth zero, so
// NUMERIC(10,2) and CHECK (a IN ('x','y')) survive intact.
function splitTopLevel(body) {
  const out = [];
  let depth = 0, cur = '', quote = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// Everything from the opening paren of a CREATE TABLE to its balanced close.
//
// A BACKTICK ENDS THE SEARCH. Every one of these statements lives inside a JS
// template literal, so a backtick means the walk has left the SQL -- which only
// happens when the SQL itself is unbalanced. Returning null there is how a
// mis-parse announces itself instead of swallowing the next few hundred lines
// and reporting another table's columns as this one's. That is exactly what
// happened before this guard: state_category_rules came back with 29 columns,
// several of them belonging to compliance_holds and one of them the fragment
// `athleteid || null` lifted out of a query.
function balancedBody(src, openIdx) {
  let depth = 0, quote = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '`') return null;
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
  }
  return null;
}

// Strip SQL comments so a commented-out column is not reported as missing, and
// so an apostrophe inside one ("-- don't") cannot open a quote that swallows the
// rest of the statement.
//
// LENGTH-PRESERVING. The scanner reports file and line from string offsets, so a
// comment is blanked in place rather than removed; collapsing it would shift
// every offset after it and misreport where a column was declared.
function decomment(s) {
  return String(s).replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
}

// { table -> { columns: Map(col -> {type, file, line}), files: Set } }
function scanCreates(files) {
  const tables = new Map();
  const RE = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
  const skipped = [];
  for (const f of files) {
    // Comments neutralised BEFORE the paren walk, not after: an apostrophe in a
    // comment would otherwise open a quote and the walk would run off the end.
    const src = decomment(fs.readFileSync(f, 'utf8'));
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(src))) {
      const table = m[1].toLowerCase();
      const open = m.index + m[0].length - 1;
      const line = src.slice(0, m.index).split('\n').length;
      const body = balancedBody(src, open);
      // RECORDED, NOT SWALLOWED. A statement this cannot parse is a table this
      // sweep does not cover, and a sweep with silent holes is worse than none.
      if (body == null) { skipped.push({ table, file: f, line }); continue; }
      const rec = tables.get(table)
        || { table, columns: new Map(), sites: [] };
      rec.sites.push({ file: f, line });
      for (const raw of splitTopLevel(body)) {
        const frag = raw.trim().replace(/\s+/g, ' ');
        if (!frag || CONSTRAINT_START.test(frag)) continue;
        const name = (frag.split(/[\s(]/)[0] || '').replace(/["`]/g, '');
        if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || NOT_A_NAME.test(name)) continue;
        // A definition carrying JS or SQL-expression syntax is not a column
        // definition; it is proof the split went wrong. Refuse it rather than
        // generating an ALTER from it.
        if (/[`${}|]/.test(frag)) continue;
        // First definition wins; a second CREATE for the same table is usually
        // an older or narrower copy.
        if (!rec.columns.has(name.toLowerCase())) {
          rec.columns.set(name.toLowerCase(),
            { name: name.toLowerCase(), def: frag, file: f, line });
        }
      }
      tables.set(table, rec);
    }
  }
  tables._skipped = skipped;
  return tables;
}

// { table -> Set(col) } for every ALTER ... ADD COLUMN IF NOT EXISTS anywhere.
function scanAlters(files) {
  const alters = new Map();
  const RE = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const f of files) {
    const src = decomment(fs.readFileSync(f, 'utf8'));
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(src))) {
      const t = m[1].toLowerCase();
      if (!alters.has(t)) alters.set(t, new Set());
      alters.get(t).add(m[2].toLowerCase());
    }
  }
  return alters;
}

// ── WHAT AN ALTER MAY CARRY ─────────────────────────────────────────────────
// A column added to a table that already has rows cannot be NOT NULL without a
// default, and cannot be a PRIMARY KEY. Those clauses belong to the CREATE,
// which is the fresh-database path; the ALTER carries the type and the DEFAULT
// and nothing else. SERIAL and REFERENCES are kept -- both are legal in an ADD
// COLUMN and both are meaningful on a backfill.
function alterFor(table, col) {
  let def = col.def.replace(/^[A-Za-z_][A-Za-z0-9_]*\s*/, '').trim();
  def = def
    .replace(/\bPRIMARY\s+KEY\b/gi, '')
    .replace(/\bUNIQUE\b/gi, '')
    .replace(/\bNOT\s+NULL\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!def) def = 'TEXT';
  return `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col.name} ${def}`;
}

// The whole report, used by both the sweep script and the guard test.
function scan(roots) {
  const files = [];
  for (const r of roots) if (fs.existsSync(r)) walk(r, files);
  const creates = scanCreates(files);
  const alters = scanAlters(files);
  const gaps = [];
  for (const [table, rec] of creates) {
    const have = alters.get(table) || new Set();
    for (const [name, col] of rec.columns) {
      if (have.has(name)) continue;
      gaps.push({ table, column: name, def: col.def, file: col.file, line: col.line,
        alter: alterFor(table, col) });
    }
  }
  gaps.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
  return { files, creates, alters, gaps, skipped: creates._skipped || [] };
}

module.exports = { scan, scanCreates, scanAlters, alterFor, splitTopLevel, balancedBody, walk };
