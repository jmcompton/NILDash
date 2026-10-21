'use strict';
// ── THE FIRST EMAIL'S SUBJECT ───────────────────────────────────────────────
// "NIL opportunity for {Business}" on every first email to a business, built
// here rather than written by a model, so it reads the same wherever the
// email was drafted: the nightly cards (services/outreachQueue), a prewarmed
// draft (services/draftPrewarm), Write Outreach and the athlete's own pitch
// (ai.js). It used to be "Quick idea for {Business}".
//
// A professional athlete's pitch never says NIL (services/proLane: it is an
// endorsement), so theirs reads "Endorsement opportunity for {Business}".
// Follow-ups keep their reply subject (services/followUps), and a draft
// already written keeps the subject it was written with.
function firstTouchSubject(brand, opts = {}) {
  const b = String(brand || '').trim() || 'your business';
  return (opts.pro ? 'Endorsement opportunity for ' : 'NIL opportunity for ') + b;
}

module.exports = { firstTouchSubject };
