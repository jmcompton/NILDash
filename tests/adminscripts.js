'use strict';
// No database needed.
//
//   node tests/adminscripts.js
//
// ── THE ADMIN SCRIPTS ARE DISCOVERED, AND EVERY ONE STILL RESOLVES ──────────
// The hand-written ADMIN_SCRIPTS object in server/index.js became one file per
// script in server/scripts/admin/ (services/adminScripts). The fixture
// tests/fixtures/admin-scripts-before.json is what the old object did: every
// name, its file, and its arguments (or its refusal, message and status) for
// 463 queries. The discovered registry must do exactly the same.
const path = require('path');
const fs = require('fs');
const os = require('os');
const REPO = path.join(__dirname, '..') + path.sep;
const AS = require(REPO + 'server/services/adminScripts.js');
const before = require(REPO + 'tests/fixtures/admin-scripts-before.json');
const svc0 = fs.readFileSync(REPO + 'server/services/adminScripts.js', 'utf8');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 500) : '')); } };
const run = (def, q) => { try { return { args: def.args({ ...q }) }; } catch (e) { return { throws: e.message, status: e.status || null }; } };

// THE REAL FOLDER, STRICT: any bad descriptor fails this suite, so it is never merged.
let strictErr = null;
try { AS.discover({ strict: true }); } catch (e) { strictErr = e.message; }
const reg = AS.registry();
const was = Object.keys(before.scripts).sort(), now = Object.keys(reg).sort();
ok('THE REAL FOLDER IS CLEAN: every descriptor in server/scripts/admin/ is valid (strict)', strictErr === null, strictErr);
ok(`every script that existed still exists (${was.length})`, was.every((n) => reg[n]), was.filter((n) => !reg[n]));
ok('  and none appeared from nowhere', now.length === was.length, now.filter((n) => !before.scripts[n]));
for (const name of was) {
  const def = reg[name];
  if (!def) continue;
  const diffs = before.queries.map((q, i) => [q, before.scripts[name].results[i], run(def, q)]).filter(([, a, b]) => JSON.stringify(a) !== JSON.stringify(b));
  ok(`${name}: same file, and the same arguments or refusal for all ${before.queries.length} queries`, def.file === before.scripts[name].file && !diffs.length,
    { file: def.file, diffs: diffs.slice(0, 2) });
}
for (const name of now) ok(`${name}: its script file exists`, fs.existsSync(path.join(REPO, reg[name].file)), reg[name].file);

const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
ok('server/index.js holds no list: it reads the folder', /const ADMIN_SCRIPTS = require\('\.\/services\/adminScripts'\)\.registry\(\);/.test(idx)
  && !/'campus-reach': \{ file:/.test(idx) && !/^\s+brief: \{$/m.test(idx));
ok('the route still answers /api/admin/scripts/:name from it', /app\.get\('\/api\/admin\/scripts\/:name'/.test(idx) && /const def = ADMIN_SCRIPTS\[req\.params\.name\];/.test(idx));
ok('a name that is not a script is not one (constructor, __proto__, toString)', !reg.constructor && !reg['__proto__'] && !reg.toString);

// ── A BAD DESCRIPTOR: strict (tests) refuses it; runtime skips it, says why ─
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adminscripts-'));
const write = (name, body) => fs.writeFileSync(path.join(tmp, name), body);
const tryDir = () => { for (const k of Object.keys(require.cache)) if (k.startsWith(tmp)) delete require.cache[k]; try { return { reg: AS.discover({ dir: tmp, repo: REPO, strict: true }) }; } catch (e) { return { error: e.message }; } };
// The runtime path: never throws, skips the bad one, reports each reason.
const runtimeDir = () => { for (const k of Object.keys(require.cache)) if (k.startsWith(tmp)) delete require.cache[k]; const told = []; let r = null, threw = null;
  try { r = AS.discover({ dir: tmp, repo: REPO, onProblem: (w) => told.push(w) }); } catch (e) { threw = e.message; } return { reg: r, told, threw }; };
write('good-one.js', "module.exports = { name: 'good-one', file: 'scripts/campus-reach.js', args: () => [] };");
ok('ADDING A SCRIPT IS ADDING A FILE: a valid descriptor registers', tryDir().reg && tryDir().reg['good-one'] && tryDir().reg['good-one'].file === 'scripts/campus-reach.js');
write('wrong-name.js', "module.exports = { name: 'other', file: 'scripts/campus-reach.js', args: () => [] };");
write('also-good.js', "module.exports = { name: 'also-good', file: 'scripts/campus-reach.js', args: () => ['--x'] };");
write('broken-runtime.js', "module.exports = {");
{
  const rt = runtimeDir();
  ok('AT RUNTIME A BAD DESCRIPTOR NEVER STOPS THE APP: no throw, the bad ones skipped, every good one registered',
    !rt.threw && rt.reg && rt.reg['good-one'] && rt.reg['also-good'] && !rt.reg.other && !rt.reg['wrong-name'] && !rt.reg['broken-runtime'], rt);
  ok('  and each skipped one is reported with its reason', rt.told.some((w) => /does not match the file name "wrong-name"/.test(w)) && rt.told.some((w) => /broken-runtime\.js could not be loaded/.test(w)), rt.told);
}
fs.unlinkSync(path.join(tmp, 'broken-runtime.js'));
fs.unlinkSync(path.join(tmp, 'also-good.js'));
ok('  a name that does not match its file is refused', /does not match the file name "wrong-name"/.test(tryDir().error || ''), tryDir());
fs.unlinkSync(path.join(tmp, 'wrong-name.js'));
write('no-script.js', "module.exports = { name: 'no-script', file: 'scripts/does-not-exist.js', args: () => [] };");
ok('  a missing script file is refused', /scripts\/does-not-exist\.js does not exist/.test(tryDir().error || ''), tryDir());
fs.unlinkSync(path.join(tmp, 'no-script.js'));
write('no-args.js', "module.exports = { name: 'no-args', file: 'scripts/campus-reach.js' };");
ok('  no args function is refused', /args must be a function/.test(tryDir().error || ''), tryDir());
fs.unlinkSync(path.join(tmp, 'no-args.js'));
write('escape.js', "module.exports = { name: 'escape', file: '../outside.js', args: () => [] };");
ok('  a file outside the repo is refused', /file must be a path inside the repo/.test(tryDir().error || ''), tryDir());
fs.unlinkSync(path.join(tmp, 'escape.js'));
write('broken.js', "module.exports = {");
ok('  a file that does not load is refused, named', /broken\.js could not be loaded/.test(tryDir().error || ''), tryDir());
fs.unlinkSync(path.join(tmp, 'broken.js'));
ok('  and with them gone the folder loads again', !!tryDir().reg);
fs.rmSync(tmp, { recursive: true, force: true });

// ── THE RUNTIME REGISTRY RECORDS A SKIP AS OUR FAULT ────────────────────────
ok('the runtime registry logs each skip and records it through ourFault (the morning alert)', /console\.error\('\[admin-scripts\] skipped: ' \+ why\)/.test(svc0)
  && /require\('\.\/ourFault'\)\.record\('admin-scripts', 'skipped a descriptor: ' \+ why/.test(svc0) && /_reg = Object\.freeze\(Object\.create\(null\)\)/.test(svc0));

// ── NOTHING ELSE IN server/scripts/ IS LOADED ───────────────────────────────
const svc = fs.readFileSync(REPO + 'server/services/adminScripts.js', 'utf8');
ok('discovery reads server/scripts/admin/ only (the scripts beside it run when loaded)', /path\.join\(__dirname, '\.\.', 'scripts', 'admin'\)/.test(svc)
  && fs.readdirSync(path.join(REPO, 'server/scripts/admin')).every((f) => f.endsWith('.js')));

console.log(OUT.join('\n'));
console.log(`\n${OUT.length - F}/${OUT.length} passed`);
process.exit(F ? 1 : 0);
