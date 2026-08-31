'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// EVERY <script> BLOCK ON AN ADMIN PAGE MUST PARSE.
//
// The "Project the cleanup" button did nothing when clicked. Not a failed
// request, not an error toast -- nothing. The cause was one character: the
// handler is emitted from a template literal in index.js, and \' inside a
// template literal is just ', so the string it was meant to escape terminated
// early and the WHOLE script block became a syntax error. retireStale was never
// defined, and an onclick naming an undefined function fails silently.
//
// A page can only be trusted if its script parses, so this parses them. It reads
// the admin page templates straight out of index.js source, evaluates them the
// way Node will, and runs every script block through the parser.
const fs = require('fs');
const ROOT = REPO;
const SRC = fs.readFileSync(ROOT + 'server/index.js', 'utf8');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

// Pull every `<script> ... </script>` that appears inside a TEMPLATE LITERAL in
// index.js, with the template escapes resolved the way the engine resolves them.
// Interpolations are replaced with a placeholder: the question is whether the
// surrounding JS parses, not what the data is.
function emittedScripts(src) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let body = m[1];
    // Only blocks that are actually inside a template literal can suffer this
    // bug; those are the ones carrying ${...} or sitting in a `...` region. Be
    // inclusive: checking a plain block too costs nothing.
    const startsAt = m.index;
    // Resolve the template-literal escapes: \' -> ', \" -> ", \` -> `, \\ -> \
    const resolved = body
      .replace(/\\`/g, '`')
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"');
    // Blank out interpolations so the parse tests the code, not the data.
    const noInterp = resolved.replace(/\$\{[^}]*\}/g, '0');
    out.push({ body: noInterp, at: src.slice(0, startsAt).split('\n').length });
  }
  return out;
}

const blocks = emittedScripts(SRC);
ok('index.js emits script blocks we can check', blocks.length > 0, blocks.length);

let broken = [];
for (const b of blocks) {
  try { new Function(b.body); }
  catch (e) { broken.push({ line: b.at, error: e.message }); }
}
ok('EVERY emitted admin script block parses', broken.length === 0, broken);

// The specific regression, pinned by name: the handler must exist and the button
// must call something that is actually defined in the same block.
const retire = blocks.find((b) => /function retireStale/.test(b.body));
ok('the retireStale handler is in an emitted block', !!retire, blocks.length);
if (retire) {
  let parsed = true, err = null;
  try { new Function(retire.body); } catch (e) { parsed = false; err = e.message; }
  ok('  and the block it lives in parses', parsed, err);
  ok('  so onclick="retireStale()" resolves to a real function',
    parsed && /function retireStale\s*\(/.test(retire.body), err);
  ok('  it carries NO bare apostrophe inside a single-quoted string',
    !/'[^'\n]*[A-Za-z]'[a-z]/.test(retire.body), (retire.body.match(/'[^'\n]*[A-Za-z]'[a-z][^']*'/) || [])[0]);
  ok('  it still posts to the retire endpoint', /retire-stale-queue/.test(retire.body));
  ok('  it still projects before it retires (confirm gate intact)',
    /confirm:\s*confirmed/.test(retire.body) && /d\.dryRun/.test(retire.body), null);
  ok('  and the confirm step names the count it would retire',
    /wouldRetire/.test(retire.body), null);
}

// The button itself must be wired to the handler.
ok('the button calls retireStale', /onclick="retireStale\(\)"/.test(SRC));

OUT.push(''); OUT.push('failures: ' + F);
console.log(OUT.join('\n'));
process.exit(F ? 1 : 0);
