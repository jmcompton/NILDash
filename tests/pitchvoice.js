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

// ── THE VOICE AGENTS ASKED FOR ──────────────────────────────────────────────
//
//   Open by naming the athlete, not the business.
//   Say nothing about the brand -- they know their own brand.
//   One line on where the athlete is, one on what they post.
//   Sell the potential, not a package of posts.
//   Never mention the season or a practice schedule; the timing is often wrong.
//   Close as a question. Link the athlete's Instagram.
//
// The one claim in that list that is a statement of FACT about a real person --
// "already has several NIL partnerships" -- is grounded in deals we hold, not
// asserted because it reads well. That is most of what this suite is about.

const fs = require('fs');
const ROOT = REPO;
const PW = require(ROOT + 'server/services/pitchWriter');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

const SHAPE = 'Hi Ronda,\n\n'
  + 'I wanted to call your attention to Amari Allen, a wide receiver on the Auburn football team. '
  + 'She already has several NIL partnerships and is looking to expand. '
  + 'She posts training clips, day in the life and gear reviews to an audience that overlaps with yours. '
  + 'Would you like to learn more about this NIL opportunity with Amari?\n\n'
  + 'https://instagram.com/amariallen\n\nJohnMark';
const lint = (m) => PW.lintMessage(m, { signOff: 'JohnMark' });

function main() {
  // ── THE PRESCRIBED SHAPE PASSES ───────────────────────────────────────────
  const base = lint(SHAPE);
  ok('THE SHAPE AGENTS ASKED FOR PASSES THE LINT', base.ok === true, base.problems);

  // ── THE DELIVERABLE LINT NO LONGER REJECTS IT ─────────────────────────────
  // This rule rejected 5 pitches in the run that paused six athletes for nine
  // days. The new voice deliberately does not enumerate a package, so it is off
  // by default rather than loosened again.
  ok('a message that names no countable deliverable is accepted',
    lint(SHAPE).ok === true, null);
  // The same message, judged both ways. "Her audience overlaps with yours" names
  // nothing the athlete would DO, which is exactly what the old rule demanded.
  const NO_DELIVERABLE = 'Hi Ronda,\n\nI wanted to call your attention to Amari Allen, a wide '
    + 'receiver on the Auburn football team. She already has several NIL partnerships and is '
    + 'looking to expand. Her audience overlaps heavily with yours. '
    + 'Would you like to learn more about this NIL opportunity with Amari?\n\nJohnMark';
  ok('  and the rule is OFF by default, not merely relaxed',
    PW.lintMessage(NO_DELIVERABLE, { signOff: 'JohnMark' }).ok === true,
    PW.lintMessage(NO_DELIVERABLE, { signOff: 'JohnMark' }).problems);
  ok('  while a caller that still wants it can opt back in',
    PW.lintMessage(NO_DELIVERABLE, { signOff: 'JohnMark', requireDeliverable: true }).ok === false,
    PW.lintMessage(NO_DELIVERABLE, { signOff: 'JohnMark', requireDeliverable: true }).problems);

  // ── THE SEASON IS NEVER MENTIONED ─────────────────────────────────────────
  const seasonal = [
    'before the season starts', 'during spring practice', 'ahead of the season',
    'in fall camp', 'this season starts soon', 'during the offseason', 'game week',
  ];
  for (const phrase of seasonal) {
    const m = SHAPE.replace('She posts training clips, day in the life and gear reviews to an '
      + 'audience that overlaps with yours.', 'She would be a good fit ' + phrase + '.');
    const r = lint(m);
    ok('  "' + phrase + '" is refused', r.ok === false
      && r.problems.some((p) => /season or practice schedule/.test(p)), r.problems);
  }
  ok('  and an ordinary message is not caught by the season rule',
    !lint(SHAPE).problems.some((p) => /season/.test(p)), null);

  // ── THE LINK IS A LINE, NOT A SENTENCE ────────────────────────────────────
  // Counting it pushed a correctly structured pitch over the five-sentence
  // maximum and lost it to a retry.
  ok('THE INSTAGRAM LINK DOES NOT COUNT AGAINST THE SENTENCE MAXIMUM',
    lint(SHAPE).ok === true && /instagram\.com/.test(SHAPE), null);
  ok('  and a message that drops a required line is still too short',
    lint('Hi Ronda,\n\nI wanted to call your attention to Amari Allen. '
      + 'Would you like to learn more?\n\nJohnMark').problems
      .some((p) => /minimum is four/.test(p)), null);

  // ── THE RULES THAT MUST NOT HAVE BEEN LOOSENED ────────────────────────────
  ok('a price is still refused',
    lint(SHAPE.replace('to expand', 'to expand for $500')).problems
      .some((p) => /names a price/.test(p)), null);
  ok('an exclamation mark is still refused',
    lint(SHAPE.replace('to expand.', 'to expand!')).problems
      .some((p) => /exclamation/.test(p)), null);
  ok('an em dash is still refused',
    lint(SHAPE.replace(', a wide receiver', ' — a wide receiver')).problems
      .some((p) => /em or en dash/.test(p)), null);
  ok('corporate filler is still refused',
    lint(SHAPE.replace('is looking to expand', 'is looking to leverage synergies')).problems
      .some((p) => /corporate filler/.test(p)), null);
  ok('a banned opener is still refused',
    lint(SHAPE.replace('I wanted to call your attention to', 'I wanted to reach out about'))
      .problems.some((p) => /banned phrase/.test(p)), null);
  ok('  but the PRESCRIBED opener is not mistaken for one',
    !lint(SHAPE).problems.some((p) => /banned phrase/.test(p)), null);

  // ── THE PARTNERSHIP CLAIM IS GROUNDED ─────────────────────────────────────
  // The single sentence in this voice that asserts a fact about a real athlete
  // to a real business.
  const pw = fs.readFileSync(ROOT + 'server/services/pitchWriter.js', 'utf8');
  ok('WITH TWO OR MORE DEALS ON FILE, "several" IS ALLOWED',
    /deals >= 2[\s\S]{0,200}already has several NIL partnerships/.test(pw), null);
  ok('  with exactly one, the model is told NOT to say "several"',
    /deals === 1[\s\S]{0,220}Do not say "several"/.test(pw), null);
  ok('  WITH NONE, IT MAY NOT CLAIM ANY',
    /NONE on file[\s\S]{0,220}Do NOT claim they already have any/.test(pw), null);

  // ── THE BRAND IS NOT DESCRIBED BACK TO ITSELF ─────────────────────────────
  ok('the prompt forbids writing about the brand',
    /DO NOT WRITE ABOUT THE BRAND/.test(pw), null);
  ok('  and says why: they know their own business',
    /know their own business better than we do/.test(pw), null);
  ok('the prompt dictates the opener, verbatim',
    /I wanted to call your attention to \[athlete\], \[position\] on the \[team\]/.test(pw), null);
  ok('  and the close, verbatim',
    /Would you like to learn more about this NIL opportunity with \[athlete\]\?/.test(pw), null);
  ok('  and asks for potential rather than a package',
    /SELL THE POTENTIAL, NOT A PACKAGE/.test(pw), null);
  ok('  and forbids the season outright, not only in the lint',
    /DO NOT REFERENCE THE SEASON/.test(pw), null);
  ok('the Instagram link is handed to the model when we hold a handle',
    /Instagram link, to go on its own line at the end/.test(pw), null);
  ok('the ask survives for the CARD but is not required in the message',
    /NOT for the message itself/.test(pw), null);

  // ── THE JOB SUPPLIES WHAT THE VOICE NEEDS ─────────────────────────────────
  const job = fs.readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the job counts real partnerships rather than assuming them',
    /FROM athlete_deal_pipeline/.test(job) && /partnershipCount = Number/.test(job), null);
  ok('  and claims none when the count cannot be read',
    /the pitch will not claim any/.test(job), null);
  ok('  reading it once per athlete, not once per candidate',
    job.indexOf('let partnershipCount = 0;') < job.indexOf('for (const slot of open)'), null);
  ok('the content line is schedule-free by construction',
    /function contentThemesOf/.test(job) && /name no date/.test(job), null);
  ok('both writer call sites get the handle and the themes',
    (job.match(/contentThemes: contentThemesOf/g) || []).length === 2, null);
  ok('AND THE ON-DEMAND PATH GETS THE SAME CONTEXT AS THE NIGHTLY ONE',
    (job.match(/athleteRow: ath\.data \|\| null/g) || []).length === 2, null);

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main();
