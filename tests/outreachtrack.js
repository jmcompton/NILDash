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

// ── ONE PLACE TO WORK A CARD ────────────────────────────────────────────────
//
// The Outreach tab carried a SECOND, older implementation of the morning queue:
// its own renderer, its own card, its own Mark sent / Copy DM buttons, its own
// fill button, mounted at #hm-queue. Home has had its own since the two-table
// merge. Two places to act on one card is how a card gets actioned twice, and
// the two copies did not even agree on what a card was.
//
// Outreach is tracking now. What this suite holds is that the queue is really
// gone rather than merely hidden, that nothing went with it that had nowhere
// else to live -- specifically the Resume button, the only manual exit from a
// pause that had none at all -- and that no dead reference was left behind.

const fs = require('fs');
const ROOT = REPO;

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

function main() {
  const html = fs.readFileSync(ROOT + 'public/index.html', 'utf8');

  // ── THE QUEUE IS GONE FROM OUTREACH ───────────────────────────────────────
  ok('the queue mount point is removed', !/id="hm-queue"/.test(html), null);
  ok('  and so is its renderer', !/function renderOutreachQueue/.test(html), null);
  ok('  and its loader', !/function loadOutreachQueue/.test(html), null);
  ok('  and its card', !/\nfunction hqCard\(c\)/.test(html), null);
  ok('  and its fill button', !/function hqFillNow/.test(html) && !/function hqFillPoll/.test(html), null);
  ok('  and its mark-sent action', !/function hqMark\(/.test(html), null);
  ok('  and its athlete tabs', !/function hqSelectAthlete/.test(html), null);

  // NOT MERELY HIDDEN. A dead onclick is worse than a visible button: it looks
  // like the product is broken rather than like the feature moved.
  for (const dead of ['renderOutreachQueue', 'loadOutreachQueue', 'hqSelectAthlete',
    'hqMark', 'hqOutcome', 'hqFillUi', 'hqFillNow', 'hqFillSay', 'hqFillPoll',
    'hqFillDone', 'hqIsAdmin', 'hqIgLink', 'hqResumeAthlete', '_hqLastData',
    '_hqSelectedAthlete', '_hqFillLog']) {
    ok('  NO DANGLING REFERENCE to ' + dead,
      html.indexOf(dead) === -1, (html.match(new RegExp('.{0,50}' + dead + '.{0,30}')) || [])[0]);
  }
  ok('opening Outreach no longer loads a queue',
    !/setTimeout\(loadOutreachQueue/.test(html)
      && /if \(id === 'outreach'\) \{ setTimeout\(loadUnifiedOutreach/.test(html), null);
  ok('and the page says what it is for',
    /Everything already sent/.test(html) && /Cards are worked on Home/.test(html), null);

  // ── WHAT CAME WITH IT RATHER THAN GOING WITH IT ───────────────────────────
  // The paused-athlete state carried the ONLY Resume button in the product.
  ok('THE RESUME BUTTON SURVIVED, ON HOME',
    /function hqResume\(athleteId, btn\)/.test(html) && /Resume this athlete/.test(html), null);
  ok('  rendered by Home\'s own renderer',
    /var _paused = \(d\.paused \|\| \[\]\)/.test(html), null);
  ok('  hitting the same resume endpoint',
    /api\/outreach-queue\/athletes\/'\s*\n?\s*\+ encodeURIComponent\(athleteId\) \+ '\/resume/.test(html)
      || /\/resume'/.test(html), null);
  ok('  and reloading Home rather than a queue that no longer exists',
    /hqLoad\(athleteId\);/.test(html), null);
  ok('PAUSED BEATS THE ORDINARY EMPTY STATE on Home',
    /if \(!d\.cards\.length && _paused\)/.test(html), null);
  // hqEsc is shared with the shift report above the removed block.
  ok('hqEsc stayed, because the shift report uses it',
    /function hqEsc\(v\)/.test(html), null);

  // ── HOME SERVES WHAT HOME NOW RENDERS ─────────────────────────────────────
  const hq = fs.readFileSync(ROOT + 'server/services/homeQueue.js', 'utf8');
  ok('buildHome returns the paused list', /\n    paused,/.test(hq), null);
  ok('  read per agent, with the retry date', /PQ\.pausedUntilNote\(rel\)/.test(hq), null);
  ok('  and a failure there does not empty the page',
    /errs\.push\('paused: ' \+ e\.message\)/.test(hq), null);

  // ── THE STALE DOB BLOCKER ─────────────────────────────────────────────────
  // Home blocked on a missing date of birth, which stopped being the only way to
  // answer the age question when the over-18 checkbox shipped.
  ok('THE AGE BLOCKER ACCEPTS THE CHECKBOX, not only a date of birth',
    /who\.over18 === 'true' \|\| who\.over18 === 'false'/.test(hq), null);
  ok('  reading over18 out of the athlete row', /a\.data->>'over18' AS over18/.test(hq), null);
  ok('  as TEXT, because jsonb ->> never returns a boolean',
    /jsonb ->> returns TEXT/.test(hq), null);
  ok('  and the copy no longer names only a birthday',
    /has no age on file/.test(hq) && !/has no date of birth on file, /.test(hq), null);

  // ── WHAT OUTREACH KEPT ────────────────────────────────────────────────────
  // Tracking, and only tracking: the feed, the stat cards, marking a reply, and
  // logging outreach that happened outside the product.
  ok('the unified feed is still there', /function loadUnifiedOutreach/.test(html), null);
  ok('  with the AI outreach list', /function loadAiOutreachLogs/.test(html), null);
  ok('  and marking a reply, which is tracking, not approving',
    /function markOutreachReplied/.test(html), null);
  ok('  and Log Outreach, for outreach that happened elsewhere',
    /function openLogOutreachModal/.test(html), null);

  // ── THE ONE APPROVABLE THING LEFT, AND WHY ────────────────────────────────
  // agentApproveOutreach is athlete-SUBMITTED outreach awaiting the agent, a
  // different workflow from the card queue with its own live endpoint. Removing
  // it would leave athlete-submitted outreach unapprovable anywhere. Asserted so
  // that it is a recorded decision rather than something nobody noticed.
  ok('athlete-submitted outreach can still be approved somewhere',
    /function agentApproveOutreach/.test(html), null);
  const idx = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
  ok('  because its endpoint is live and has no other surface',
    /athlete-outreach\/:id\/approve/.test(idx), null);

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main();
