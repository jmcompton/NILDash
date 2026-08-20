'use strict';
// THE MORNING OUTREACH QUEUE: what goes on a card, and what never does.
//
// Three slots an athlete. A nightly job fills EMPTY slots only, so an agent who
// does not act costs nothing, and a slot freed today waits for tonight's run
// rather than triggering a lookup the moment it is freed.
//
// THE CARD IS SHAPED BY THE MEASUREMENT, not by what a CRM usually shows. Across
// twenty Birmingham businesses: a named owner nearly always, an Instagram handle
// about nine times in ten, a phone essentially always but almost always the shop
// line, and a personal email approximately never. So:
//
//   handle  -> a DM card, with the message already written
//   no handle -> a call card, "ask for Bryan" on the main line
//   email   -> NEVER SHOWN. An email box that is empty 100% of the time makes the
//              product look broken and teaches an agent to ignore the card.
//
// TIER 2 COUNTS. The affiliation check demotes a contact to Tier 2 when the source
// names them for the business but states no tie to the address -- which is what
// every chamber and directory listing looks like, and chamber is the highest-yield
// source there is (24 people across 14 of 20 businesses). Requiring Tier 1 would
// leave the queue empty, so a Tier 2 contact is queued WITH its honest source note
// rather than silently promoted or silently dropped.
//
// A NATIONAL BRAND ACCOUNT IS NEVER A DM. Rally House Fayetteville resolves to
// @rally_house: 135k followers, corporate social, no idea this store exists. The
// handle is still shown and labelled, and the card routes to the phone.
//
// Pure: no SQL, no network, no store. The job supplies the data, this decides.

// $0.50 an agent a night. At $99/month a queue that costs $30 to fill for one
// agent is not a feature, it is a leak. A slot that cannot be filled inside the
// cap stays EMPTY and says why.
const DEFAULT_AGENT_NIGHTLY_USD = 0.50;
// A slot must not burn the whole cap on candidates that all fail the bar.
const MAX_ATTEMPTS_PER_SLOT = 3;
// Five per athlete per night, and five means five WORTH SENDING. The filler
// runs out long before the slots do, so a night that produces two strong
// pitches writes two: the shift report saying "wrote two, both strong" beats
// five with three pieces of filler in it, and the writer is allowed to refuse.
const SLOTS_PER_ATHLETE = 5;
const WAITING_AFTER_DAYS = 3;
const OUTCOMES = ['no_reply', 'replied', 'closed'];

// ── Generate on demand, not overnight ────────────────────────────────────────
// Building three cards a night for every athlete spends real money on deals
// nobody opens. The night now guarantees ONE fresh card per athlete -- enough
// that the page is never empty -- and slots 2 and 3 are built when an agent
// actually opens that athlete's queue.
const NIGHTLY_SLOTS = 1;
// Per athlete per DAY, not per open: an agent flipping between athletes all
// morning must not re-trigger a fill each time they come back.
const DEFAULT_ONDEMAND_USD = 0.15;

// ── Back off instead of retrying forever ─────────────────────────────────────
// slotsToFill returns every empty slot every night, so an athlete whose
// businesses keep failing the bar was re-attempted nightly, indefinitely, at
// full price. After this many consecutive nights that spent money and placed
// nothing, stop attempting and SAY SO on the page -- a queue that quietly
// spends forever on an athlete it cannot fill is the worst of both.
const BACKOFF_NIGHTS = 3;

function pausedNote(failures) {
  return 'paused after ' + (failures || BACKOFF_NIGHTS) + ' nights where nothing passed the bar. '
    + 'Nothing is being spent on this athlete until their scan has new businesses — run a Deal Scan to refresh it.';
}

// ── Predict failure before paying for it ─────────────────────────────────────
// About one in five deep lookups returns nothing usable and costs full price.
// Places is already fetched (and cached 30 days) for the phone number on every
// lookup, so these signals are FREE at this point -- the question is only
// whether they are worth acting on.
//
// HOW MUCH EACH SIGNAL IS ACTUALLY WORTH, stated honestly rather than tuned to
// a number nobody measured:
//   businessStatus != OPERATIONAL  near-certain failure, and a closed business
//                                  is a bad pitch regardless. HARD SKIP.
//   no website                     the strongest of the soft signals: site is
//                                  one of the two top-yield sources, and a
//                                  business with no site tends to have thin web
//                                  presence generally. FLAGGED, not skipped.
//   not found in Places at all     same shape of signal, same treatment.
//   rating / userRatingCount       directional at best. RECORDED ONLY.
// Everything here is recorded on the tried entry (see placesFacts) so the real
// predictive rate is measurable in a few weeks instead of asserted today.
function prescreen(place) {
  if (!place) {
    return { skip: false, risk: 'high', reason: 'not found in Places — thin web presence is likely' };
  }
  const status = place.businessStatus || null;
  if (status && status !== 'OPERATIONAL') {
    return { skip: true, risk: 'certain', reason: 'Places says this business is ' + String(status).toLowerCase().replace(/_/g, ' ') };
  }
  if (!place.website) {
    return { skip: false, risk: 'high', reason: 'no website on file — site is a top-yield source and it has nothing to read' };
  }
  return { skip: false, risk: 'normal', reason: null };
}

// The Places fields worth keeping next to every attempt, so failure prediction
// can be calibrated against what actually happened rather than guessed at.
function placesFacts(place) {
  if (!place) return { found: false };
  return {
    found: true,
    businessStatus: place.businessStatus || null,
    hasWebsite: !!place.website,
    hasPhone: !!place.phone,
    primaryType: place.primaryType || null,
    rating: place.rating != null ? place.rating : null,
    userRatingCount: place.userRatingCount != null ? place.userRatingCount : null,
  };
}

// Every named row the ladder is willing to show, Tier 1 or Tier 2. Tier 3 is
// business channels and never a person.
function namedRows(ladder) {
  const out = [];
  for (const t of (ladder && ladder.tiers) || []) {
    if (t.tier === 3) continue;
    for (const r of (t.rows || [])) if (r && r.name) out.push(r);
  }
  return out;
}

// Can we name someone AND reach them? The two halves are separate: a name with no
// channel is research, not a card, and a channel with no name is a cold inbox.
// A REASON, NOT A COUNT. "no named person" tells an agent nothing about whether
// the business is a dead end or simply has an owner who is not published
// anywhere. Every rejection says what the lookup DID come back with, because
// that is the difference between "try a different business" and "this ledger is
// stale".
function _whatWeGot(ladder, ig) {
  const bits = [];
  const t3 = ((ladder && ladder.tiers) || []).find((t) => t.tier === 3);
  const has = (title) => (t3 && (t3.rows || []).some((r) => new RegExp(title, 'i').test(r.title || '')));
  if (ladder && ladder.mainLine && ladder.mainLine.phone) bits.push('a main line');
  if (has('general inbox')) bits.push('a general inbox');
  if (has('named mailbox')) bits.push('a named mailbox');
  if (ig && ig.instagram) bits.push('an Instagram handle (' + ig.instagramScope + ')');
  const unreachable = (ladder && ladder.unreachable) || [];
  if (unreachable.length) bits.push('names with no way through (' + unreachable.join(', ') + ')');
  return bits;
}

function passesBar(ladder, ig) {
  const rows = namedRows(ladder);
  const got = _whatWeGot(ladder, ig);
  if (!rows.length) {
    return {
      ok: false,
      reason: got.length
        ? 'no named decision maker — found ' + got.join(', ')
        : 'nothing found at all: no name, no phone, no inbox, no handle',
    };
  }
  const handle = ig && ig.instagram ? ig.instagram : null;
  const phone = (ladder && ladder.mainLine && ladder.mainLine.phone)
    || rows.map((r) => r.phone).find(Boolean) || null;
  if (!handle && !phone) {
    return {
      ok: false,
      reason: 'found ' + rows.map((r) => r.name).join(', ') + ' but no way to reach '
        + (rows.length > 1 ? 'them' : 'them') + ' — no phone, no handle',
    };
  }
  return { ok: true, reason: null };
}

// Who to ask for on a shared line. Mirrors askName in contactLadder: keep an
// honorific with the surname, otherwise the first name.
function askFirstName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const hon = /^(dr|mr|mrs|ms|prof|doctor)\.?$/i;
  if (parts.length > 1 && hon.test(parts[0])) {
    const h = parts[0].replace(/\.?$/, '.');
    return h.charAt(0).toUpperCase() + h.slice(1) + ' ' + parts[parts.length - 1];
  }
  return parts[0];
}

// THE FALLBACK ONLY. The real writer is services/pitchWriter.js, which reads the
// business and the athlete and reasons about the angle before it writes a word.
// This exists for one case: the model was unreachable and we still owe the agent
// a card. It is deliberately plain rather than dressed up, because a bland
// message an agent will rewrite is honest, and a fake-specific one is not.
//
// Anything this produces is marked angle=null, so the shift report and the
// reply-learning never mistake a fallback for a reasoned pitch.
function writeDm(athleteName, brandName, why) {
  const who = String(athleteName || 'a college athlete I work with').trim();
  const angle = String(why || '').trim().replace(/\s+/g, ' ');
  const first = angle ? angle.split(/(?<=[.!?])\s/)[0] : '';
  return `Hi, I work with ${who} on the NIL side and had an idea for ${brandName}`
    + (first ? `, ${first.charAt(0).toLowerCase()}${first.slice(1).replace(/\.$/, '')}` : '')
    + `. Worth a quick conversation?`;
}

// One card. `cand` is the scan candidate, `ladder` the built contact ladder, `ig`
// the Instagram record ({ instagram, instagramScope }).
function buildCard(cand, ladder, ig) {
  const c = cand || {};
  const rows = namedRows(ladder);
  const top = rows[0] || {};
  const handle = (ig && ig.instagram) || null;
  const scope = (ig && ig.instagramScope) || null;
  // A brand account is a real channel but it is not a route to this location, so
  // it never becomes the DM. The handle is kept and labelled.
  const dmable = !!handle && scope !== 'brand';
  const phone = (ladder && ladder.mainLine && ladder.mainLine.phone)
    || rows.map((r) => r.phone).find(Boolean) || null;

  return {
    brandKey: c.brandKey || null,
    brandName: c.brand || c.brandName || null,
    why: c.rationale || null,
    contactName: top.name || null,
    contactTitle: top.title || null,
    // Carried so the card can say, in words, why an owner is only Tier 2.
    sourceNote: top.sourceNote || null,
    affiliationScope: top.affiliationScope || null,
    instagram: handle,
    instagramScope: scope,
    phone,
    phoneAskFor: top.name ? askFirstName(top.name) : null,
    channel: dmable ? 'dm' : 'call',
    // Only written when it can actually be sent. A DM drafted for a corporate
    // account is a message nobody should paste.
    //
    // c.pitch is what services/pitchWriter.js produced for this pairing. When it
    // is present the card carries the reasoned message AND the angle behind it;
    // when it is absent (model unreachable) the plain fallback is used and the
    // angle stays null, so nothing downstream can mistake one for the other.
    dmText: dmable ? (c.pitch && c.pitch.message
      ? c.pitch.message
      : writeDm(c.athleteName, c.brand || c.brandName, c.rationale)) : null,
    angle: (c.pitch && c.pitch.angle) || null,
    angleKey: (c.pitch && c.pitch.angleKey) || null,
    categoryKey: (c.pitch && c.pitch.categoryKey) || null,
    ask: (c.pitch && c.pitch.ask) || null,
  };
}

// DM-able first: a card an agent can act on in ten seconds outranks one that
// needs a phone call, whatever else is true of it.
function sortCards(cards) {
  return (cards || []).slice().sort((a, b) => {
    const rank = (x) => (x && x.channel === 'dm' ? 0 : 1);
    return rank(a) - rank(b);
  });
}

// Which of the three slots are open. Only a QUEUED row holds a slot -- sent and
// skipped rows stay for outcome tracking but free their slot for the next run.
function slotsToFill(rows) {
  const taken = new Set((rows || []).filter((r) => r && r.state === 'queued').map((r) => Number(r.slot)));
  const out = [];
  for (let s = 1; s <= SLOTS_PER_ATHLETE; s++) if (!taken.has(s)) out.push(s);
  return out;
}

// The cap, as an object rather than a number, so "can I afford this" is asked
// BEFORE the money is spent rather than discovered after.
function newBudget(capUsd) {
  const cap = typeof capUsd === 'number' ? capUsd : DEFAULT_AGENT_NIGHTLY_USD;
  let used = 0;
  return {
    cap: () => cap,
    spent: () => used,
    remaining: () => Math.max(0, cap - used),
    canSpend: (amount) => used + (amount || 0) <= cap + 1e-9,
    spend: (amount) => { used += (amount || 0); return used; },
  };
}

function slotSkipReason(budget, projected) {
  return 'left empty: budget cap reached ($' + budget.spent().toFixed(2)
    + ' of $' + budget.cap().toFixed(2) + ' spent, next lookup ~$' + Number(projected || 0).toFixed(2) + ')';
}

// Sent more than three days ago and never answered. A card sent yesterday is not
// late, and one already answered is done.
function waitingOnYou(rows, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const cutoff = now - WAITING_AFTER_DAYS * 86400000;
  return (rows || []).filter((r) => r && r.state === 'sent' && !r.outcome
    && r.sent_at && Date.parse(r.sent_at) <= cutoff);
}

module.exports = {
  passesBar, _whatWeGot, buildCard, sortCards, slotsToFill, newBudget, slotSkipReason,
  waitingOnYou, writeDm, askFirstName, namedRows,
  prescreen, placesFacts, pausedNote,
  DEFAULT_AGENT_NIGHTLY_USD, MAX_ATTEMPTS_PER_SLOT, SLOTS_PER_ATHLETE,
  WAITING_AFTER_DAYS, OUTCOMES,
  NIGHTLY_SLOTS, DEFAULT_ONDEMAND_USD, BACKOFF_NIGHTS,
};
