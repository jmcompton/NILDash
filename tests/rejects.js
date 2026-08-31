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
// THE THREE RULES THAT WERE REJECTING GOOD WORK, and the slot count that made
// the Scout ask for three businesses instead of fifteen.
// Every case here is one the audit page actually reported.
const ROOT = REPO;
const P = require(ROOT + 'server/services/pitchWriter.js');
const Q = require(ROOT + 'server/services/outreachQueue.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

// ── 1. THE DELIVERABLE LINT: 5 REJECTIONS ──────────────────────────────────
// It demanded a quantifier + noun. A pitch that says what the athlete would do
// in any other shape was thrown away by our own check.
const concrete = [
  'Two feed posts and an appearance at your location.',
  'She would post about you on game day.',
  "He'd come by the shop and film a quick video.",
  'I can get her to shout you out to her following.',
  'A story about the new location.',
  'She would wear your gear at the meet.',
  'She can tag you in her meet recaps.',
  'He would stop by and sign autographs for an hour.',
];
for (const m of concrete) {
  ok('concrete: ' + JSON.stringify(m).slice(0, 52), P.DELIVERABLE_RE.test(m), m);
}

// STILL A REAL CHECK. These name no action and must still fail, which is the
// case the rule exists for.
const vague = [
  'Would love to send over a short overview.',
  'We think there is a great fit here.',
  'Let me know if you would be open to a conversation.',
];
for (const m of vague) {
  ok('still vague: ' + JSON.stringify(m).slice(0, 46), !P.DELIVERABLE_RE.test(m), m);
}
ok('  and the reason says what is missing, in words',
  /never says what the athlete would actually do/.test(
    P.lintMessage('Hi,\n\nWe think there is a great fit here.\n\nJohnMark',
      { requireDeliverable: true }).problems.join('; ')), null);

// ── 2. THE SIGN-OFF: 2 REJECTIONS ──────────────────────────────────────────
// NOT case sensitivity -- the old regex already had the i flag. The trailing \b
// was the bug: \bjohn\b does not match "JohnMark" because M is a word character.
ok('THE OLD CHECK REJECTED "JohnMark" FOR AN AGENT NAMED "john"',
  !new RegExp('\\bjohn\\b', 'i').test('Thanks,\nJohnMark'), null);
ok('  which was never a case problem — the i flag was already there',
  new RegExp('\\bjohn\\b', 'i').test('Thanks,\nJohn'), null);

ok('a message signed JohnMark now satisfies an agent named john',
  P.signsOffAs('Thanks,\n\nJohnMark', 'john'), null);
ok('  and one signed John satisfies JohnMark', P.signsOffAs('Thanks,\n\nJohn', 'JohnMark'), null);
ok('  and Jon satisfies Jonathan', P.signsOffAs('Thanks,\n\nJon', 'Jonathan'), null);
ok('  an exact match still passes', P.signsOffAs('Thanks,\n\nDana', 'Dana'), null);
ok('  a genuinely absent sign-off does not', !P.signsOffAs('Thanks for your time.', 'Dana'), null);

// AND IT IS REPAIRED, NOT REJECTED.
const wrong = "Hi,\n\nShe'd post about you on game day.\n\nSteve";
const fixed = P.repairSignOff(wrong, 'Dana');
ok('A WRONG SIGN-OFF IS REPAIRED, NOT REJECTED', /Dana\s*$/.test(fixed), fixed);
ok('  the wrong name is replaced, not stacked underneath', !/Steve/.test(fixed), fixed);
ok('  and the pitch itself is untouched', /post about you on game day/.test(fixed), fixed);
const none = P.repairSignOff("Hi,\n\nShe'd post about you.", 'Dana');
ok('  a missing sign-off is appended', /Dana\s*$/.test(none), none);
const already = P.repairSignOff("Hi,\n\nShe'd post about you.\n\nDana", 'Dana');
ok('  and a correct one is left alone', already.split('Dana').length === 2, already);
ok('  the last SENTENCE is never mistaken for a sign-off',
  /great fit\./.test(P.repairSignOff('Hi,\n\nThis is a great fit.', 'Dana')), null);
ok('  the writer repairs before it lints',
  /repairSignOff\(autoRepair/.test(require('fs').readFileSync(ROOT + 'server/services/pitchWriter.js', 'utf8')), null);

// ── 3. THE BAR: 11 REJECTIONS, ALL REACHABLE ───────────────────────────────
const ladder = (opts) => ({
  tiers: [
    { tier: 1, rows: opts.named ? [{ name: 'Dana Reed', title: 'Owner', phone: opts.namedPhone || null }] : [] },
    { tier: 3, rows: opts.inbox ? [{ title: 'General inbox', email: 'info@shop.example' }] : [] },
  ],
  mainLine: opts.phone ? { phone: '(334) 555-1212' } : null,
  unreachable: [],
});

const handleOnly = Q.passesBar(ladder({ named: false }), { instagram: 'shopname', instagramScope: 'this-location' });
ok('AN INSTAGRAM HANDLE WITH NO NAMED OWNER NOW PASSES', handleOnly.ok === true, handleOnly);
ok('  and is marked as needing a generic greeting', handleOnly.greeting === 'generic', handleOnly);

const lineOnly = Q.passesBar(ladder({ named: false, phone: true }), {});
ok('A MAIN LINE WITH NO NAMED OWNER NOW PASSES', lineOnly.ok === true, lineOnly);
const inboxOnly = Q.passesBar(ladder({ named: false, inbox: true }), {});
ok('A GENERAL INBOX WITH NO NAMED OWNER NOW PASSES', inboxOnly.ok === true, inboxOnly);
ok('  reached via the inbox', inboxOnly.via === 'inbox', inboxOnly);

// WHAT STILL FAILS.
const nothing = Q.passesBar(ladder({ named: false }), {});
ok('a business with NOTHING reachable still fails', nothing.ok === false, nothing);
ok('  saying so plainly', /nothing found at all/.test(nothing.reason), nothing.reason);
const nameNoChannel = Q.passesBar(ladder({ named: true }), {});
ok('a NAME with no channel still fails — that is research, not a card',
  nameNoChannel.ok === false, nameNoChannel);
ok('  and names who was found', /Dana Reed/.test(nameNoChannel.reason), nameNoChannel.reason);

// A named contact still passes and still ranks as named.
const full = Q.passesBar(ladder({ named: true, phone: true }), { instagram: 'shop', instagramScope: 'this-location' });
ok('a named owner with a channel still passes', full.ok === true && full.named === true, full);
ok('  and is marked for a named greeting', full.greeting === 'named', full);

// ── 4. THE SLOT COUNT ──────────────────────────────────────────────────────
ok('NIGHTLY_SLOTS IS FIVE', Q.NIGHTLY_SLOTS === 5, Q.NIGHTLY_SLOTS);
ok('  so the Scout is asked for fifteen businesses, not three',
  Q.NIGHTLY_SLOTS * Q.MAX_ATTEMPTS_PER_SLOT === 15, Q.NIGHTLY_SLOTS * Q.MAX_ATTEMPTS_PER_SLOT);
ok('  and it matches the slots an athlete actually has', Q.NIGHTLY_SLOTS === Q.SLOTS_PER_ATHLETE,
  [Q.NIGHTLY_SLOTS, Q.SLOTS_PER_ATHLETE]);
ok('  slotsToFill offers all five to a fresh athlete', Q.slotsToFill([]).length === 5, Q.slotsToFill([]));
const JOB = require('fs').readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
ok('  and the full-queue message no longer says "three"',
  !/all three slots/.test(JOB) && /all \$\{Q\.SLOTS_PER_ATHLETE\} slots/.test(JOB), null);

// ── THE GENUINE REFUSALS ARE UNTOUCHED ─────────────────────────────────────
// The Writer refusing "no real connection" is it doing its job, and none of the
// three changes above can turn a refusal into a pitch.
const PWSRC = require('fs').readFileSync(ROOT + 'server/services/pitchWriter.js', 'utf8');
ok('THE WRITER CAN STILL REFUSE', /if \(j\.skip\)/.test(PWSRC), null);
ok('  and its reason is carried, not overwritten',
  /skipped: true, reason: String\(j\.reason/.test(PWSRC), null);
ok('the price ban is untouched', /PRICE_PATTERNS/.test(PWSRC), null);
ok('the invented-fact check is untouched', /verifyAthleteFacts/.test(PWSRC), null);

OUT.push(''); OUT.push('failures: ' + F);
console.log(OUT.join('\n'));
process.exit(F ? 1 : 0);
