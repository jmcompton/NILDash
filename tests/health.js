'use strict';
// Runs from a checkout on any machine and needs NO database and no server.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/health.js         just this one

// ── THE ROUTE THAT SAYS WHAT IS LIVE ────────────────────────────────────────
//
// For weeks the only way to tell whether a deploy had happened was to curl the
// page and grep the HTML for a field that should have been removed. That is not
// a check, it is an inference, and it fails in the exact case that matters: a
// deploy that silently did not happen looks identical to one that happened and
// did not work. /health answers it directly with the commit SHA.
//
// WHAT THIS SUITE PROTECTS, in order of what would actually hurt:
//
//   1. THE ROUTE STAYS PUBLIC AND STAYS EARLY. It is mounted before the static
//      handler and before session, on purpose. Move it below either and it
//      either gets shadowed by a file or starts requiring the thing it exists
//      to diagnose. A health check you need a session for cannot tell you the
//      session layer is broken.
//
//   2. EVERY ENV NAME IS STILL READ. The platform decides which variable
//      exists. Dropping one is invisible in dev -- the git fallback covers for
//      it -- and shows up in production as a permanent null, which is how this
//      route becomes useless again without anyone noticing.
//
//   3. NULL STAYS NULL. builtAt must not quietly become startedAt. Reporting
//      process start as build time is a guess presented as a fact, and a guess
//      presented as a fact is the entire class of problem this route exists to
//      end. An honest null is worth more than a confident wrong answer.
//
//   4. IT IS COMPUTED ONCE. `git rev-parse` per request would put a subprocess
//      spawn on the endpoint whose whole job is to answer while other things
//      are broken.
//
// HOW IT TESTS THE RESOLUTION ORDER WITHOUT BOOTING THE SERVER. server/index.js
// connects to Postgres, starts schedulers and binds a port at require time, so
// requiring it here would make a no-database suite need a database. Instead the
// `const BUILD = (() => {...})();` block is lifted out of the source and
// evaluated on its own under a controlled env. That means these assertions run
// against the REAL code, not a copy of it: rewrite the block and this suite
// either follows the change or fails to find it, and both are correct outcomes.

const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..') + path.sep;
const SRC = fs.readFileSync(REPO + 'server/index.js', 'utf8');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

// Comments are stripped before any source assertion below. This suite has
// already been broken twice by prose -- a test that matches its own explanatory
// comment passes whether or not the code does the thing.
const CODE = SRC.replace(/^\s*\/\/.*$/gm, '');

// ── LIFT THE BUILD BLOCK ────────────────────────────────────────────────────
const BLOCK = (() => {
  const start = SRC.indexOf('const BUILD = (() => {');
  if (start === -1) return null;
  // Brace-match rather than regex: the block contains braces and a nested IIFE,
  // and a lazy match would stop at the first inner close.
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  const end = SRC.indexOf(';', i);
  return end === -1 ? null : SRC.slice(start, end + 1);
})();

// Evaluate the real block with a controlled process.env, then restore. Nothing
// else in the block touches global state.
function buildWith(env) {
  if (!BLOCK) return null;
  const saved = process.env;
  // A clean env, so a variable set on THIS machine cannot satisfy an assertion
  // about a variable the test did not provide.
  process.env = Object.assign({ PATH: saved.PATH, HOME: saved.HOME }, env || {});
  try {
    // eslint-disable-next-line no-new-func
    return new Function('require', '__dirname', BLOCK + ' return BUILD;')(require, REPO);
  } finally { process.env = saved; }
}

const SHA = 'a'.repeat(40);

// ── 1. THE ROUTE EXISTS, IS PUBLIC, AND IS MOUNTED EARLY ────────────────────
ok('/health route is registered', /app\.get\('\/health'/.test(CODE), null);

{
  const h = CODE.indexOf("app.get('/health'");
  const stat = CODE.indexOf('app.use(express.static(');
  const sess = CODE.indexOf('app.use(session(');
  ok('  mounted before the static handler (a file cannot shadow it)',
    h > -1 && stat > -1 && h < stat, { health: h, static: stat });
  ok('  mounted before session (it must answer when session is broken)',
    h > -1 && sess > -1 && h < sess, { health: h, session: sess });

  // The handler body, from the route to the end of its arrow function.
  const body = h === -1 ? '' : CODE.slice(h, CODE.indexOf('});', h) + 3);
  ok('  no auth middleware on the route',
    !/requireAuth|requireLogin|isAuthenticated|ensureAuth/.test(body), body.slice(0, 200));
  ok('  no database call in the handler',
    !/\b(pool|store|db|client)\.query\b|await\s/.test(body), body.slice(0, 200));
  ok('  responds with JSON', /res\.json\(/.test(body), null);
  ok('  reports the precomputed BUILD rather than recomputing',
    /\.\.\.BUILD/.test(body), null);
}

// ── 2. EVERY ENV NAME IS STILL READ ─────────────────────────────────────────
// Each of these is the name some platform actually uses. A dropped one is a
// permanent null in production and invisible here, because the git fallback
// hides it in dev.
for (const name of ['RAILWAY_GIT_COMMIT_SHA', 'SOURCE_VERSION', 'COMMIT_SHA',
  'GIT_COMMIT', 'VERCEL_GIT_COMMIT_SHA', 'HEROKU_SLUG_COMMIT']) {
  ok('  reads ' + name, BLOCK !== null && BLOCK.includes(name), null);
}
ok('  reads RAILWAY_BUILD_TIME / BUILD_TIME for the build stamp',
  BLOCK !== null && /RAILWAY_BUILD_TIME/.test(BLOCK) && /BUILD_TIME/.test(BLOCK), null);

// And each one actually resolves, which grepping for the name does not prove --
// a variable can be mentioned in a branch that never runs.
for (const name of ['RAILWAY_GIT_COMMIT_SHA', 'SOURCE_VERSION', 'COMMIT_SHA',
  'GIT_COMMIT', 'VERCEL_GIT_COMMIT_SHA', 'HEROKU_SLUG_COMMIT']) {
  const b = buildWith({ [name]: SHA });
  ok('  ' + name + ' resolves to the commit', b && b.commit === SHA, b && b.commit);
}

// ── 3. PRECEDENCE ───────────────────────────────────────────────────────────
// Railway is production. If anything else in the environment can outrank it,
// the route reports the wrong SHA on the one host where being wrong costs
// something.
{
  const b = buildWith({
    RAILWAY_GIT_COMMIT_SHA: SHA,
    SOURCE_VERSION: 'b'.repeat(40),
    COMMIT_SHA: 'c'.repeat(40),
    GIT_COMMIT: 'd'.repeat(40),
  });
  ok('Railway wins over every other commit variable', b && b.commit === SHA, b && b.commit);
}

{
  const b = buildWith({
    RAILWAY_GIT_COMMIT_SHA: SHA,
    RAILWAY_GIT_BRANCH: 'main',
    RAILWAY_GIT_COMMIT_MESSAGE: 'a real commit subject',
    RAILWAY_DEPLOYMENT_ID: 'dep-123',
    RAILWAY_BUILD_TIME: '2026-09-08T00:00:00.000Z',
  });
  ok('  branch is reported', b && b.branch === 'main', b && b.branch);
  ok('  message is reported', b && b.message === 'a real commit subject', b && b.message);
  ok('  deployment id is reported', b && b.deploymentId === 'dep-123', b && b.deploymentId);
  ok('  builtAt is reported when the platform supplies it',
    b && b.builtAt === '2026-09-08T00:00:00.000Z', b && b.builtAt);
}

// ── 4. THE FALLBACK, AND THE HONEST NULL ────────────────────────────────────
// With nothing in the environment the block shells out to git. In this checkout
// that must return the real HEAD -- if it returns null here, the fallback is
// broken and nobody would find out until a host that sets no variables.
{
  const { execSync } = require('child_process');
  let head = null;
  try {
    head = execSync('git rev-parse HEAD', { cwd: REPO, encoding: 'utf8' }).trim();
  } catch (_) { /* not a checkout; the assertion below is skipped */ }
  const b = buildWith({});
  if (head) {
    ok('git fallback resolves HEAD when no env var is set', b && b.commit === head,
      b && b.commit);
  } else {
    OUT.push('PASS git fallback (skipped: not a git checkout)');
  }
  ok('  the fallback never throws out of the block', b !== null, null);
}

// A commit the process genuinely cannot determine must read as null. The
// alternative -- inventing something plausible -- is exactly the failure mode
// this route was added to end.
{
  const b = buildWith({ PATH: '/nonexistent-so-git-cannot-be-found' });
  ok('unknown commit reports null, not a guess', b && b.commit === null, b && b.commit);
}

// ── 5. builtAt MUST NOT QUIETLY BECOME startedAt ────────────────────────────
// The tempting "fix" for a null build time is to fill it with process start.
// They are different facts: one says which code, the other says how long this
// process has been up. Conflating them makes a restarted container look freshly
// built, which would make the route lie in precisely the situation it exists
// for -- a deploy that did not happen.
{
  const b = buildWith({});
  ok('builtAt is null when the platform does not supply it', b && b.builtAt === null,
    b && b.builtAt);
  ok('  and is NOT filled in from process start',
    b && b.builtAt !== b.startedAt, { builtAt: b && b.builtAt, startedAt: b && b.startedAt });
  ok('  startedAt is a real ISO timestamp',
    b && typeof b.startedAt === 'string' && !isNaN(Date.parse(b.startedAt)), b && b.startedAt);
}

// ── 6. COMPUTED ONCE AT BOOT ────────────────────────────────────────────────
// A subprocess spawn per request on the endpoint whose job is to stay
// answerable while other things are failing.
ok('BUILD is computed once at module scope, not per request',
  /const BUILD = \(\(\) => \{/.test(CODE), null);
{
  const h = CODE.indexOf("app.get('/health'");
  const body = h === -1 ? '' : CODE.slice(h, CODE.indexOf('});', h) + 3);
  ok('  the handler does not shell out',
    !/execSync|spawnSync|child_process/.test(body), body.slice(0, 200));
}
ok('  uptime is reported (the one value that must be per-request)',
  /uptimeSeconds/.test(CODE) && /process\.uptime\(\)/.test(CODE), null);

OUT.push(''); OUT.push('failures: ' + F);
console.log(OUT.join('\n'));
process.exit(F ? 1 : 0);
