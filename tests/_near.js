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
// near(src, anchor, target, window) -- a distance assertion that reports its own
// headroom instead of silently passing until the day it does not.
//
// WHY THIS EXISTS. Three assertions in this suite have now given false signal:
//   deadend    the notice-clearing code sat 438 chars into a 400-char window, so
//              a correct product reported a bug for days
//   hometown   passed because the word survived in a COMMENT after the code went
//   engagement a negative match passed only because the thing it forbade sat 629
//              chars away, outside a 300-char window
// All three failed the same way: the window, not the behaviour, decided the
// result, and nothing said so until someone went looking.
//
// near() measures the real distance every run. It returns a normal boolean, so it
// drops into an existing ok(), but it also:
//   - WARNS at under WARN_RATIO headroom, before the window runs out
//   - FAILS LOUDLY when the anchor or target is missing, rather than reporting a
//     bare false that reads like "the behaviour is wrong"
//   - FAILS when the only match is inside a comment, which is not shipped code
//
// It is still second best. A distance check asserts that two strings are near
// each other, which is not the same as asserting the code does the right thing --
// prefer lifting the function and running it. Use near() where executing is
// genuinely impractical, and let it tell you when it is about to lie.

const WARN_RATIO = 0.25;

// Comments are not behaviour. Blanked rather than removed so every offset in the
// stripped copy still lines up with the original.
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

const warnings = [];
const errors = [];

function near(src, anchor, target, window, opts = {}) {
  const label = opts.label || `${anchor} -> ${target}`;
  const body = opts.includeComments ? String(src) : stripComments(String(src));
  const toRe = (x, flags) => (x instanceof RegExp ? new RegExp(x.source, flags || x.flags.replace(/g/g, ''))
    : new RegExp(String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags || ''));

  const aRe = toRe(anchor, 'g');
  let best = null, anchorSeen = false, m;
  while ((m = aRe.exec(body))) {
    anchorSeen = true;
    const from = m.index + m[0].length;
    const rest = body.slice(from);
    const t = rest.search(toRe(target));
    if (t >= 0 && (best === null || t < best)) best = t;
    if (m[0].length === 0) aRe.lastIndex++;   // zero-width match cannot advance itself
  }

  if (!anchorSeen) {
    errors.push(`${label}: ANCHOR NOT FOUND -- this assertion cannot pass or fail meaningfully`);
    return false;
  }
  if (best === null) {
    // A real negative. Say how far away the nearest match is when comments are
    // allowed back in, because "only in a comment" is its own diagnosis.
    if (!opts.includeComments) {
      const loose = near.distance(String(src), anchor, target);
      if (loose !== null) {
        warnings.push(`${label}: target found ONLY INSIDE A COMMENT at ${loose} chars -- not shipped behaviour`);
      }
    }
    return false;
  }
  if (best > window) return false;

  const headroom = window - best;
  if (headroom < window * WARN_RATIO) {
    warnings.push(`${label}: needs ${best} of ${window} -- ${headroom} chars of headroom `
      + `(under ${Math.round(WARN_RATIO * 100)}%). Widen the window or, better, assert on behaviour.`);
  }
  return true;
}

// Raw distance, comments and all. Returns null when there is no match.
near.distance = function (src, anchor, target) {
  const s = String(src);
  const aRe = anchor instanceof RegExp ? new RegExp(anchor.source, 'g')
    : new RegExp(String(anchor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const tRe = target instanceof RegExp ? new RegExp(target.source)
    : new RegExp(String(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  let best = null, m;
  while ((m = aRe.exec(s))) {
    const t = s.slice(m.index + m[0].length).search(tRe);
    if (t >= 0 && (best === null || t < best)) best = t;
    if (m[0].length === 0) aRe.lastIndex++;
  }
  return best;
};

// Call at the end of a suite. Returns the number of hard errors so a runner can
// exit non-zero on a broken assertion even when every ok() passed.
near.report = function () {
  for (const w of warnings) console.log('  WARN  ' + w);
  for (const e of errors) console.log('  ERROR ' + e);
  if (warnings.length) {
    console.log(`  -- ${warnings.length} proximity assertion(s) running low on headroom. `
      + 'This is the warning deadend.js never got.');
  }
  return errors.length;
};

near.WARN_RATIO = WARN_RATIO;
module.exports = { near, stripComments };
