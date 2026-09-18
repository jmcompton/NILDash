'use strict';
// ── THE ONE REASON TO EMAIL AN AGENT ─────────────────────────────────────────
//
// New pitches are ready. That is it. One agent with no athletes received 29
// daily reports in a month; another got a report, a weekly digest and a
// deliverable reminder about the same quiet week. Every recurring agent email
// except the nightly digest is off, here, in one place, and the nightly digest
// goes out only on a night that placed at least one new card.
//
// NOT ENV FLAGS. A switch an operator can flip back on in Railway is a switch
// that gets flipped; these are decisions about how the product behaves. Turning
// one back on is a code change with a reason in the commit.
//
// Untouched by this file, because they are not "email to an agent about their
// work": password reset, account verification and the welcome or account-ready
// emails (the person just asked for them), the brand-inquiry forward (a
// business writing to the agent), the athlete's weekly report (the agent
// chooses to send it to a family), the growth sequence (prospects, not agents),
// and the prospecting briefs (the founder's own tools).
const SENDS = Object.freeze({
  nightlyDigest: true,        // "3 pitches ready, Fri Sep 18" -- only when cards were placed
  shiftReport: false,         // the daily report: off for everyone
  weeklyDigest: false,        // off
  deliverableDigest: false,   // off; the pinned overdue block on Home carries this
  mediaKitOpened: false,      // off; the open shows on the media kit page
});

function enabled(kind) { return SENDS[kind] === true; }

// For the settings page and the admin: what still sends and why.
const STILL_SENDS = [
  { kind: 'nightlyDigest', label: 'Nightly digest', trigger: 'the overnight fill placed at least one new card for one of your athletes; one email per night, never on an empty night' },
];

module.exports = { SENDS, enabled, STILL_SENDS };
