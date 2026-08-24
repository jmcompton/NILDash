'use strict';
// ── THE ASSISTANT'S PRODUCT KNOWLEDGE, DERIVED FROM THE PRODUCT ──────────────
//
// WHY THIS IS NOT A PROSE FILE ANY MORE. It used to be a block of hand-written
// text behind a "PASTE KNOWLEDGE BASE HERE" marker. Every number in it was a
// copy: the send ceiling, the follow-up cadence, how many slots a night, what
// compliance blocks. A copy of a number is wrong the day the number changes, and
// nothing fails when it drifts -- the assistant just starts confidently telling
// agents something that stopped being true months ago. That is the same class of
// problem as a test that passes because a string moved.
//
// So the facts are READ FROM THE MODULES THAT IMPLEMENT THEM. Raise the send cap
// in sendGuard and the assistant's answer changes on the next boot. Add a
// restricted category to compliance and the assistant lists it. Nothing to
// remember, nothing to keep in step.
//
// WHAT STAYS PROSE: framing and judgement -- what the product is FOR, why the
// agent does not pick the send time. Those are decisions, not values, and they
// belong in words. They are kept next to the derived numbers so it is obvious
// which is which.
//
// WHAT IS DELIBERATELY WRITTEN DOWN AS A LIMIT: everything the product does NOT
// do. An assistant that oversells is worse than one that says "I don't know",
// because an agent acts on it. The honest numbers here are the measured ones,
// not the flattering ones.

function _try(fn, dflt) { try { const v = fn(); return v === undefined ? dflt : v; } catch (_) { return dflt; } }
const _list = (a) => (a.length === 1 ? a[0] : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);

// ── THE SIX ROLES ────────────────────────────────────────────────────────────
// Five come from the shift report's own role cards, which is what the agent sees
// every morning, so the assistant cannot describe a team the page does not show.
// Compliance is the sixth: it has no card because it produces no nightly output,
// it stops things.
function rolesText() {
  const sr = _try(() => require('./shiftReport'), null);
  // buildRoleCards needs a stat object; a zeroed one still yields the names and
  // the order, which is all that is wanted here.
  const zero = { checked: 0, kept: 0, contacts: 0, emailable: 0, drafts: 0, emailDrafts: 0,
    dmScripts: 0, sent: 0, replies: 0, kits: 0, valuations: 0 };
  const cards = sr && sr.buildRoleCards ? _try(() => sr.buildRoleCards(zero), []) : [];
  const names = cards.map((c) => c.name).filter(Boolean);
  const WHAT = {
    Scout: 'finds businesses worth approaching for a given athlete, and says why each one',
    Researcher: 'finds the person at that business who can actually approve a deal, and a way to reach them',
    Writer: 'drafts the pitch in the agent\'s voice, naming what the athlete would actually do',
    Closer: 'sends approved pitches at the right time, follows up, and stops the moment someone replies',
    Analyst: 'keeps one current media kit per athlete',
  };
  const lines = names.map((n) => `- ${n}: ${WHAT[n] || 'part of the nightly run'}`);
  lines.push('- Compliance: checks every pitch before it sends and holds anything that '
    + 'needs a human decision. It is the only role that stops work rather than producing it, '
    + 'which is why it has no card on the morning report.');
  return lines.join('\n');
}

// ── THE THREE LANES ──────────────────────────────────────────────────────────
function lanesText() {
  const C = _try(() => require('./closer'), null);
  // laneLabel is what the agent sees on every draft row, so the names match.
  const label = (k) => (C && C.laneLabel ? _try(() => C.laneLabel({ lane: k }), k) : k);
  return `- Local (${label('local')}): businesses near the athlete's school, and their hometown when it is set.
  This is the lane most deals come from. It needs the school to resolve to a town -- an athlete
  whose school does not resolve has NO local lane and will quietly get nothing every night.
- DTC (${label('social')}): brands running athlete or affiliate programmes. Usually product or
  commission rather than cash, and often the better fit for a smaller following.
- National (${label('national')}): larger brands with a real NIL history. Lowest hit rate, and
  the pitch goes to a corporate inbox rather than a person.`;
}

// ── OUTREACH: WRITTEN, APPROVED, SENT ────────────────────────────────────────
function outreachText() {
  const sg = _try(() => require('./sendGuard'), {});
  const C = _try(() => require('./closer'), {});
  const oq = _try(() => require('./outreachQueue'), {});
  const sr = _try(() => require('./shiftReport'), {});
  const cap = sg.DEFAULT_DAILY_CAP;
  const cadence = Array.isArray(C.CADENCE) ? C.CADENCE : [];
  const gaps = cadence.slice(1).map((c) => c.afterDays);
  const slots = oq.NIGHTLY_SLOTS;
  const expiry = sr.DRAFT_EXPIRY_DAYS;
  const auto = C.AUTO_MODE_THRESHOLD;

  return `The nightly run drafts up to ${slots == null ? 'a few' : slots} pitches per athlete. Nothing sends on its own.

APPROVAL IS ONE DECISION, NOT ONE PER MESSAGE. The morning page groups everything
waiting by athlete. The agent opens a draft, reads exactly what will go out, edits it
in place or skips it, then approves the batch. There is deliberately no per-message
send button: forty clicks a night is data entry, not review.

THE AGENT DOES NOT PICK THE SEND TIME, and this is on purpose rather than an
omission. A pitch lands better on a weekday morning in the RECIPIENT's timezone, and
that is a fact about the recipient, not a preference the agent should have to hold in
their head. Approved pitches are released into that window automatically.

${cap == null ? '' : `THE CEILING IS ${cap} EMAILS PER AGENT PER DAY. That is a deliverability limit, not a
Google one: sending more from a new domain is how a mailbox starts landing in spam.
DMs and calls are not affected by it.

`}${cadence.length ? `FOLLOW-UPS: ${cadence.length} touches${gaps.length ? `, the second after ${gaps[0]} days and the ${cadence.length === 3 ? 'third' : 'last'} after ${gaps[gaps.length - 1]}` : ''}.
They stop immediately when someone replies, and stop and flag the address when one
bounces.

` : ''}${auto == null ? '' : `AUTO MODE is off by default and is not even offered until the agent has approved ${auto}
pitches without editing any of them. It is per athlete or per lane, never global.

`}${expiry == null ? '' : `A draft nobody sends expires after ${expiry} days. Expiring is a status change, not a
delete -- the text is kept and can still be read.`}`;
}

// ── COMPLIANCE: WHAT IT BLOCKS, AND WHAT IT DOES NOT CHECK ───────────────────
// Both halves derived. The second half matters more: an agent who believes we
// check their school's policy will not check it themselves.
function complianceText() {
  const co = _try(() => require('./compliance'), null);
  if (!co) return 'A compliance gate runs before every send. Details unavailable right now.';
  const cats = (co.CATEGORIES || []).map((c) => {
    const both = c.minor === c.adult;
    return `- ${c.label}: ${both ? (c.minor === 'block' ? 'blocked for every athlete' : 'held for a human decision')
      : `blocked for a minor, held for a human decision for an adult`}`;
  });
  const unchecked = (co.UNCHECKED || []).map((u) => `- ${u}`);
  return `Every pitch passes a gate before it can send. It BLOCKS -- it is not a warning the
agent can click past -- and it fails closed: if the check cannot run, the send does not
happen.

Three outcomes: a hard block the agent cannot override, a hold the agent can override
with a recorded reason, and a note that proceeds but stays on the record. Every one is
written to a log with what was held, which rule, why, when, and how it was resolved.

WHAT IT CHECKS, by business category:
${cats.join('\n')}

Category comes from the Google Places record for the business plus its name. A business
we hold no record for cannot be classified, and that is a HOLD, never a pass.

Age comes from a date of birth the agent entered. There is no other source for it. With
no date of birth the athlete's age is UNKNOWN, and unknown age against a restricted
category holds rather than assuming they are an adult.

WHAT IT DOES NOT CHECK, and an agent should not assume otherwise:
${unchecked.join('\n')}

If asked whether we check a school's NIL policy: we do NOT. We hold only what the agent
told us about their own school's restrictions, recorded as agent-supplied and not
verified. We do not read school policies, and most of them sit behind a student login.

Disclosure filings are PREPARED, never submitted. Schools file through their own portal
with the athlete's login.`;
}

// ── WHAT WE DO NOT KNOW, IN NUMBERS ──────────────────────────────────────────
// The measured figures, including the unflattering ones. An assistant quoting the
// old 69% would be quoting a warm-cache re-read as if it were cold discovery.
const LIMITS = `HONEST NUMBERS. Use these, not more flattering ones.

CONTACT COVERAGE ON A COLD MARKET. On a business we have never looked at before,
roughly 10% yield a personal email address for a named person. Measured over 60
business-runs in Birmingham. Do not quote 69% for this: that figure came from
Fayetteville businesses that had ALREADY been processed, so it measured re-reading a
warm cache rather than cold discovery. They are different quantities.

Do not quote a "named person found" rate at all. The measurement counted people who
turned out to be wrong -- in one sample an editor at a trade magazine was carried as a
bakery owner -- so any figure would be an upper bound on something we cannot currently
compute.

Mobile numbers: we found none at all in that sample. Assume we do not have them.

FOLLOWER COUNTS are typed in by the agent or estimated from public sources today. They
go stale. Connecting the athlete's Instagram is the fix, and until an athlete connects,
treat every follower and engagement number as approximate.

SCHOOL SPONSOR CONFLICTS are not checked. We hold our own deal history at a school,
which is not the same as the school's official sponsor roster.`;

// ── FRAMING ──────────────────────────────────────────────────────────────────
const PURPOSE = `WHAT NILDASH IS FOR

NILDash is an AI team that works an agent's roster overnight. The agent does not
operate a tool: they wake up to work already done -- businesses found, contacts
researched, pitches drafted -- and their job is to decide what goes out, not to run
searches.

It is built for the athletes nobody is chasing yet. An athlete with brands already
coming to them does not need this.

The whole product runs on one rhythm: the team works at night, the agent reviews in
the morning, approved pitches go out during the day when the recipient is most likely
to read them.`;

const SHIFT_REPORT = `THE MORNING REPORT

One sentence saying what the team did overnight, then what needs the agent.

The sentence counts ONLY the overnight run. Work the agent's own page load triggers
during the day is counted separately and said in its own line, so the numbers do not
quietly inflate as the day goes on.

"Across N of M athletes" means the run attempted M and produced work for N. The
difference is real athletes who got nothing, and the reasons are listed rather than
hidden.

NEEDS YOU is ordered by what cannot move without a person: compliance holds first
(the pitch is already stopped), then replies (someone is waiting on an answer), then
drafts to approve, then queue cards.

A role that did nothing is ABSENT from the sentence rather than shown as a zero.`;

const PRICING = `PRICING

$99 a month per agent, with no per-athlete charge, so an agent can put their whole
roster in without thinking about cost. Athletes are not charged.

If asked what tier they are on and it is not in the data provided, say you cannot see
their billing from here and point them at Settings. Do not guess.`;

function buildKnowledge() {
  return [
    PURPOSE,
    '', 'THE SIX ROLES', rolesText(),
    '', 'DEAL SCAN AND THE THREE LANES',
    'A scan looks for businesses worth approaching for one athlete, in three lanes:',
    lanesText(),
    '', 'HOW OUTREACH GETS WRITTEN, APPROVED AND SENT', outreachText(),
    '', 'REPLIES',
    `A reply is captured automatically and lands on the morning report above everything
else. It stops the follow-up cadence for that business immediately -- nobody gets a
"just following up" after they have answered -- and marks the business as having
engaged, which feeds future targeting. A bounce also stops the cadence and flags the
address as bad so nothing else is sent to it.`,
    '', 'THE COMPLIANCE GATE', complianceText(),
    '', SHIFT_REPORT,
    '', PRICING,
    '', LIMITS,
  ].join('\n');
}

// Derived knowledge is present as long as the modules load. The check is that the
// numbers actually resolved -- a KNOWLEDGE block full of "unavailable" is the same
// failure as an empty one and should be just as visible on boot.
function hasKnowledge() {
  const k = buildKnowledge();
  return k.length > 800 && !/unavailable right now/.test(k);
}

// KNOWLEDGE is kept as a getter so existing callers that read it as a value still
// work, while the text is rebuilt from live module values on each read.
module.exports = {
  buildKnowledge, hasKnowledge, rolesText, lanesText, outreachText, complianceText,
  get KNOWLEDGE() { return buildKnowledge(); },
};
