'use strict';
// ── THE ADMIN SCRIPTS, DISCOVERED, NOT LISTED ───────────────────────────────
//
// GET /api/admin/scripts/<name> runs one diagnostic script as a child process
// with the arguments its descriptor builds from the query. The descriptors
// used to be one hand-maintained object in server/index.js, and every branch
// that added a script edited the same lines of it: PRs #6, #7 and the
// Instagram branch all conflicted there.
//
// Now each script has its own small file in server/scripts/admin/:
//
//   module.exports = { name: 'campus-reach', file: 'scripts/campus-reach.js', args: (q) => [...] };
//
//   name   the URL name; must match the file name (campus-reach.js)
//   file   the script to run, relative to the repo root; must exist
//   args   query -> the argument list; throws (with .status) to refuse. Only
//          what it returns reaches the script; nothing from the query
//          reaches a shell.
//
// ONLY server/scripts/admin/, never server/scripts/ itself: the scripts there
// run the moment they are loaded (seed-samford.js writes to the database,
// most call process.exit), so loading them to read a shape would run them.
// A descriptor only describes.
//
// STRICT, AT BOOT. A file in the folder that is not a valid descriptor, two
// descriptors with one name, or a descriptor whose script is missing stops the
// registry from loading, with the reason: a script that silently fails to
// register is a URL that silently 404s.
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const DIR = path.join(__dirname, '..', 'scripts', 'admin');
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function problemsOf(def, fileName, repo) {
  const p = [];
  const base = path.basename(fileName, '.js');
  if (!def || typeof def !== 'object') return [`${fileName} does not export an object`];
  if (typeof def.name !== 'string' || !NAME_RE.test(def.name)) p.push(`${fileName}: name must be lowercase letters, digits and hyphens`);
  else if (def.name !== base) p.push(`${fileName}: name "${def.name}" does not match the file name "${base}"`);
  if (typeof def.file !== 'string' || !def.file || path.isAbsolute(def.file) || def.file.split(/[\\/]/).includes('..')) p.push(`${fileName}: file must be a path inside the repo`);
  else if (!fs.existsSync(path.join(repo, def.file))) p.push(`${fileName}: ${def.file} does not exist`);
  if (typeof def.args !== 'function') p.push(`${fileName}: args must be a function of the query`);
  return p;
}

// -> { name: { file, args } }. opts.dir / opts.repo for tests.
function discover(opts = {}) {
  const dir = opts.dir || DIR;
  const repo = opts.repo || REPO;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  // No prototype: /api/admin/scripts/constructor (or __proto__) is not a script.
  const reg = Object.create(null), problems = [];
  for (const f of files) {
    let def;
    try { def = require(path.join(dir, f)); }
    catch (e) { problems.push(`${f} could not be loaded: ${e.message}`); continue; }
    const p = problemsOf(def, f, repo);
    if (p.length) { problems.push(...p); continue; }
    if (reg[def.name]) { problems.push(`two descriptors are named "${def.name}"`); continue; }
    reg[def.name] = Object.freeze({ file: def.file, args: def.args });
  }
  if (problems.length) throw new Error('admin scripts (server/scripts/admin): ' + problems.join('; '));
  return Object.freeze(reg);
}

let _reg = null;
function registry() { return _reg || (_reg = discover()); }

module.exports = { discover, registry, problemsOf, DIR };
