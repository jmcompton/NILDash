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
//   email   -> an EMAIL card, which writes an outreach_logs draft and sends
//              itself once approved
//   no email, a handle -> a DM card, with the message already written
//   neither -> a call card, "ask for Bryan" on the main line
//
// EMAIL WAS "NEVER SHOWN", AND THAT WAS RIGHT UNTIL IT WASN'T. The original
// note here read: "An email box that is empty 100% of the time makes the product
// look broken and teaches an agent to ignore the card." That was measured on
// twenty Birmingham businesses where a PERSONAL email was approximately never
// found -- and it stayed true of personal mailboxes. What changed is that the
// contact ladder now finds GENERAL inboxes, passesBar has counted one as
// reachable for a long time, and buildCard was still throwing the address away
// on the floor between the two. An empty box teaches an agent to ignore a card;
// a box we filled in and then deleted is worse.
//
// The order is about what the agent's morning costs. An email is approved and
// sends itself; a DM is a copy, a tab and a paste; a call is several minutes and
// a person. Cheapest actionable channel wins, and the others stay on the card.
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

// ── THE NIGHTLY CAP ──────────────────────────────────────────────────────────
// $0.50 bought EIGHT lookups a night for a whole roster, because the budget
// charges the worst-case ceiling ($0.06) per uncached lookup. Six athletes
// wanting three candidates each is eighteen lookups against eight affordable,
// which is why the last athlete processed was told "budget cap reached
// ($0.48 of $0.50)" -- $0.48 is exactly eight lookups.
//
// $8.00 buys roughly 130 lookups at the ceiling, and far more in practice:
// cached lookups are free and most businesses resolve from cache after the first
// pass. It was $3.00, which a five-slot roster of 45 athletes can exhaust before
// the last athletes are reached -- and an athlete who gets nothing because the
// roster ran out of money before their turn is indistinguishable, from the page,
// from an athlete whose market is empty.
//
// It is still a CAP, not a target. A slot that cannot be filled inside it stays
// empty and says which limit stopped it.
const DEFAULT_AGENT_NIGHTLY_USD = parseFloat(process.env.OUTREACH_QUEUE_AGENT_CAP_USD) || 8.00;

// ── A CARD NOBODY WORKED IS NOT WORK ────────────────────────────────────────
//
// uq_outreach_queue_open holds one queued row per (athlete, slot), so a card the
// agent never touched holds its slot forever. Five untouched cards is a
// permanently full queue and a nightly run that reports "all 5 slots already
// hold work you have not actioned" every morning -- correct, and useless.
//
// After this many days a queued card is EXPIRED. It keeps every field it had;
// only the state changes, so the record of what was offered survives.
const EXPIRE_AFTER_DAYS = parseInt(process.env.OUTREACH_QUEUE_EXPIRE_DAYS, 10) || 7;

// ── AND IT DOES NOT COME BACK TOMORROW ──────────────────────────────────────
//
// Expiring a card frees the slot, and the slate's prior-exclusion only looks at
// QUEUED cards and contacted brands -- so without a cooldown the same business
// would be re-offered to the same athlete on the very next run, re-paid for, and
// expire again seven days later. A treadmill that costs money.
//
// Thirty days is long enough that the market has moved and short enough that a
// business is not written off for a quarter because nobody got to it in a week.
const EXPIRE_COOLDOWN_DAYS = parseInt(process.env.OUTREACH_QUEUE_COOLDOWN_DAYS, 10) || 30;
// A slot must not burn the whole cap on candidates that all fail the bar.
const MAX_ATTEMPTS_PER_SLOT = 3;
// Five per athlete per night, and five means five WORTH SENDING. The filler
// runs out long before the slots do, so a night that produces two strong
// pitches writes two: the shift report saying "wrote two, both strong" beats
// five with three pieces of filler in it, and the writer is allowed to refuse.
const SLOTS_PER_ATHLETE = 5;
const WAITING_AFTER_DAYS = 3;
const OUTCOMES = ['no_reply', 'replied', 'closed'];

// ── FIVE A NIGHT, AS INTENDED ────────────────────────────────────────────────
// This was 1, and it was the whole reason a night produced one card per athlete.
// The slate size is derived from it -- limit = openSlots * MAX_ATTEMPTS_PER_SLOT
// -- so one slot meant the Scout was only ever ASKED for three businesses, no
// matter how many it had. The audit's "3 businesses tried" was this number,
// multiplied by three, not a shortage of supply.
//
// It was 1 to stop the night spending on cards nobody opens. That reasoning has
// been overtaken twice: the cap is now $8.00 rather than $0.50, and it is
// allocated per athlete rather than raced for, so five slots cannot let the
// first athlete eat the roster's budget.
const NIGHTLY_SLOTS = 5;
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

// ── AND THEN COME BACK ──────────────────────────────────────────────────────
//
// The pause had NO EXIT. Exactly one statement in the codebase cleared
// paused_at -- inside recordAttempt, on its filled > 0 branch -- and fillAthlete
// returned before ever reaching recordAttempt when an athlete was paused. Both
// call sites also guard on `!r.paused`. So a paused athlete could not place a
// card, and only placing a card could unpause them: an athlete removed from the
// product permanently, three thin nights after signing up, with the page showing
// a reason and no way to act on it.
//
// Two exits now, and the automatic one is the one that matters, because it does
// not depend on anyone noticing.
const PAUSE_RETRY_DAYS = parseInt(process.env.OUTREACH_QUEUE_PAUSE_RETRY_DAYS, 10) || 7;

// Should this paused athlete be tried again tonight? A market is not a fixed
// object -- businesses open, a scan widens, the social index grows -- so a pause
// is a "not now", never a verdict.
function pauseRelease(state, opts = {}) {
  const days = Number(opts.retryDays) || PAUSE_RETRY_DAYS;
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  if (!state || !state.paused_at) return { paused: false, retry: false, days: 0, nextRetryAt: null };
  // pg hands back a Date; Date.parse takes a string. Getting this wrong is what
  // sorted email cards above queue cards in the Home ladder, so it is spelled out.
  const at = state.paused_at instanceof Date ? state.paused_at.getTime()
    : Date.parse(state.paused_at);
  if (!isFinite(at)) {
    // An unreadable timestamp must not mean "paused forever". Retry, and say so.
    return { paused: true, retry: true, days: 0, nextRetryAt: null, unreadable: true };
  }
  const heldDays = Math.floor((now - at) / 86400000);
  const nextRetryAt = new Date(at + days * 86400000);
  return { paused: true, retry: heldDays >= days, days: heldDays, nextRetryAt, retryDays: days };
}

function pausedNote(failures) {
  return 'paused after ' + (failures || BACKOFF_NIGHTS) + ' nights where nothing passed the bar. '
    + 'Nothing is being spent on this athlete until their market has something new — '
    + 'we try again automatically in ' + PAUSE_RETRY_DAYS + ' days, or resume them now to try tonight.';
}

// What the page says while an athlete is held. Names the date, because "paused"
// with no end is indistinguishable from broken.
function pausedUntilNote(rel) {
  if (!rel || !rel.paused) return null;
  if (!rel.nextRetryAt) return 'we will try again on the next run';
  const d = rel.nextRetryAt;
  if (rel.retry) return 'due to be retried on tonight\'s run';
  return 'we try again automatically on '
    + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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

// ── THE BAR ──────────────────────────────────────────────────────────────────
//
// It used to require a NAMED person before anything else, and that was the
// largest rejection group on the audit: 11 businesses, four of which had an
// Instagram handle, three a main line and two a general inbox. All eleven were
// reachable. We threw them away because nobody had published the owner's name.
//
// THE REASON THAT RULE EXISTED IS GONE. It was there because a pitch opening
// "Hi Dana," to a general inbox is worse than no pitch, and at the time nothing
// stopped the writer greeting an unnamed contact by a guessed first name. The
// greeting guard now refuses to greet anyone we cannot name -- so an unnamed
// business gets "Hi," and the failure mode the rule protected against cannot
// happen any more.
//
// So the bar is now what it always meant: CAN WE REACH THEM. A named decision
// maker is better and still ranks higher, but a shop with a real inbox and no
// published owner is a business worth pitching, not a dead end.
//
// What still fails: nothing reachable at all, and a name with no channel behind
// it (which is research, not a card).
function passesBar(ladder, ig) {
  const rows = namedRows(ladder);
  const got = _whatWeGot(ladder, ig);
  const handle = ig && ig.instagram ? ig.instagram : null;
  const phone = (ladder && ladder.mainLine && ladder.mainLine.phone)
    || rows.map((r) => r.phone).find(Boolean) || null;

  // Tier 3 channels: a general inbox or a named mailbox is a way in.
  const t3 = ((ladder && ladder.tiers) || []).find((t) => t.tier === 3);
  const inbox = !!(t3 && (t3.rows || []).some((r) => r && (r.email || /inbox|mailbox|email/i.test(r.title || ''))));

  const reachable = !!(handle || phone || inbox);
  if (!reachable) {
    return {
      ok: false,
      named: rows.length > 0,
      reason: rows.length
        ? 'found ' + rows.map((r) => r.name).join(', ') + ' but no way to reach them — no phone, no inbox, no handle'
        : (got.length
          ? 'nothing reachable — found only ' + got.join(', ')
          : 'nothing found at all: no name, no phone, no inbox, no handle'),
    };
  }
  // Reachable. Whether we can NAME anyone decides how the pitch opens, and the
  // greeting guard is what enforces that downstream.
  return { ok: true, reason: null, named: rows.length > 0,
    greeting: rows.length ? 'named' : 'generic',
    via: handle ? 'handle' : phone ? 'phone' : 'inbox' };
}

// ── THE NAME WE ARE ALLOWED TO GREET ────────────────────────────────────────
// One function, so the prompt's instruction and the guard's enforcement cannot
// drift apart. Returns '' when nobody on the ladder is verified enough to name,
// which is the case the bare "Hi," exists for.
//
// The guard's own rules decide -- corroborated by two sources, or named by the
// business's own website, with a real role title and not model-invented. This
// does not relax any of them; it just asks the question in one place.
function greetNameOf(ladder) {
  try {
    const GG = require('./greetingGuard');
    const rows = namedRows(ladder);
    const ok = GG.greetableContacts(rows);
    return ok.length ? GG.salutationName(ok[0].name) : '';
  } catch (_) { return ''; }
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
function writeDm(athleteName, brandName, why, greetName) {
  const who = String(athleteName || 'a college athlete I work with').trim();
  const angle = String(why || '').trim().replace(/\s+/g, ' ');
  const first = angle ? angle.split(/(?<=[.!?])\s/)[0] : '';
  // The fallback opened "Hi," even when the ladder had named the owner. Only a
  // name the greeting guard cleared reaches this, so an unverified one still
  // gets the bare greeting rather than a guess.
  const hi = greetName ? `Hi ${greetName},` : 'Hi,';
  return `${hi} I work with ${who} on the NIL side and had an idea for ${brandName}`
    + (first ? `, ${first.charAt(0).toLowerCase()}${first.slice(1).replace(/\.$/, '')}` : '')
    + `. Worth a quick conversation?`;
}

// ── THE ADDRESS THE CARD USED TO THROW AWAY ─────────────────────────────────
// Tier 3 is "Business channels": contactLadder puts personalInbox and
// genericInbox there, both carrying `.email`. passesBar has always counted one
// as reachable. Nothing ever read it back out.
//
// A NAMED PERSON'S MAILBOX FIRST. contactLadder pushes personalInbox ahead of
// genericInbox in the tier, so first-wins is that preference, not an accident.
function inboxOf(ladder) {
  const t3 = ((ladder && ladder.tiers) || []).find((t) => t.tier === 3);
  const row = ((t3 && t3.rows) || []).find((r) => r && r.email);
  if (!row) return null;
  return { email: String(row.email).trim().toLowerCase(), kind: row.kind || row.label || null };
}

// ── EMAIL, THEN DM, THEN CALL ───────────────────────────────────────────────
//
// The order is about what the agent's morning costs them, not about which
// channel we like. An email card is approved and sends itself: the send window,
// the cadence, the media kit and the reply capture are all automatic. A DM is a
// copy, a tab and a paste. A call is a person and several minutes. So the
// cheapest actionable channel wins, and the others stay ON the card as fallbacks
// rather than being discarded.
//
// A brand-scoped handle is not a route to this location, so it never becomes the
// DM -- it is shown and labelled. That rule predates this and is unchanged.
function channelFor(ladder, ig) {
  if (inboxOf(ladder)) return 'email';
  const handle = (ig && ig.instagram) || null;
  if (handle && (ig && ig.instagramScope) !== 'brand') return 'dm';
  return 'call';
}

// A plain subject, built rather than written. writePitch returns a message and
// an angle and has never returned a subject; asking it for one means changing a
// contract the DM and programme lanes share. This matches the house rule the
// draft writer is given -- short, plain, no exclamation points, names the
// business -- and a written subject is a follow-up, not a blocker.
function subjectFor(brandName) {
  return 'Quick idea for ' + String(brandName || 'your business').trim();
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
  // The name we are allowed to open with, or ''. Computed once here so the card,
  // the DM fallback and the email fallback all greet the same person -- or all
  // greet nobody.
  const _greet = greetNameOf(ladder);
  const inbox = inboxOf(ladder);
  const channel = channelFor(ladder, ig);
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
    // EVERY CHANNEL WE HOLD, ON EVERY CARD. Only one of them decides the
    // `channel`; the rest stay so an agent whose email bounces has the handle
    // and the number in front of them rather than a dead card.
    instagram: handle,
    instagramScope: scope,
    phone,
    phoneAskFor: top.name ? askFirstName(top.name) : null,
    // Empty when nobody on the ladder was verified enough to name. The card
    // records WHO the pitch opens to, so "Hi," is visibly a decision rather than
    // a missing field.
    greetName: _greet || null,
    email: inbox ? inbox.email : null,
    emailKind: inbox ? inbox.kind : null,
    subject: channel === 'email' ? subjectFor(c.brand || c.brandName) : null,
    channel,
    // Only written when it can actually be sent. A DM drafted for a corporate
    // account is a message nobody should paste.
    //
    // c.pitch is what services/pitchWriter.js produced for this pairing. When it
    // is present the card carries the reasoned message AND the angle behind it;
    // when it is absent (model unreachable) the plain fallback is used and the
    // angle stays null, so nothing downstream can mistake one for the other.
    dmText: dmable && channel === 'dm' ? (c.pitch && c.pitch.message
      ? c.pitch.message
      : writeDm(c.athleteName, c.brand || c.brandName, c.rationale, _greet)) : null,
    // THE SAME PITCH, ADDRESSED DIFFERENTLY. An email card's body is what the
    // writer produced for this pairing; it becomes the outreach_logs draft that
    // actually sends. Kept under its own name so nothing that reads dm_text --
    // the Outreach tab's copy button, the shift report's "DM scripts written" --
    // starts counting emails as DMs.
    emailBody: channel === 'email' ? (c.pitch && c.pitch.message
      ? c.pitch.message
      : writeDm(c.athleteName, c.brand || c.brandName, c.rationale, _greet)) : null,
    angle: (c.pitch && c.pitch.angle) || null,
    angleKey: (c.pitch && c.pitch.angleKey) || null,
    categoryKey: (c.pitch && c.pitch.categoryKey) || null,
    ask: (c.pitch && c.pitch.ask) || null,
  };
}

// ── THE PROGRAM LANE (social, DTC, national) ─────────────────────────────────
// These brands are not reached the way a local business is. There is no owner to
// name, no main line to call, and a Places lookup on them resolves to whichever
// storefront happens to be nearby -- the exact mistake store.findNationalBrand
// exists to prevent.
//
// A NON-LOCAL BRAND IS REACHABLE TWO WAYS, AND WE ONLY EVER COUNTED ONE.
// The bar used to be: no athlete-program page, no card. That dropped every brand
// whose entire presence IS its Instagram -- GoNutre, RYZE, CWENCH, most of the
// social index. Those brands were never un-pitchable; they were un-pitchable BY
// FORM. With a handle we can verify, they are a DM, exactly like a local business
// whose address we could not find -- and a DM outranks a form anyway, because a
// DM is a conversation with someone and a form is homework.
function passesProgramBar(cand, ig) {
  const c = cand || {};
  const handle = (ig && ig.handle) ? ig.handle : null;
  // The page wins when there is one: a brand running a real athlete program has
  // told us how it wants to be approached, and that is not by DM.
  if (c.programUrl) return { ok: true, reason: null, channel: 'program' };
  if (handle) return { ok: true, reason: null, channel: 'dm' };
  return { ok: false, channel: null,
    reason: 'they spend on NIL but we hold no athlete-program page for them and could '
      + 'not verify an Instagram account, so there is nowhere to send this' };
}

// ── HOW MANY FORMS ONE ATHLETE SHOULD BE HOLDING ─────────────────────────────
// One. 86 of 155 queued cards were program applications, because the national
// lane never runs out: it quietly backfilled every slot the local lane could not
// produce, and the agent opened a queue of five and found four forms. A program
// card is the weakest thing we make -- nobody is on the other end of it -- so it
// gets one slot out of five and the rest are LEFT EMPTY rather than filled with a
// second one. An empty slot is honest about a thin market. A second form is not.
const PROGRAM_SLOT_CAP = 1;
function programCapReached(held) { return (Number(held) || 0) >= PROGRAM_SLOT_CAP; }

function buildProgramCard(cand, pitch, athleteName, ig) {
  const c = cand || {};
  const handle = (ig && ig.handle) ? ig.handle : null;
  return {
    brandKey: c.brand_key || null,
    brandName: c.brand_name || null,
    why: c.why || null,
    contactName: null,
    contactTitle: null,
    sourceNote: c.offerSummary || null,
    affiliationScope: null,
    // ON THE PROGRAM CARD TOO, not just on the ones the handle rescued. An agent
    // filling in a brand's form has nowhere to follow up; with the handle on the
    // card they can send the DM as well, from the same card, in the same minute.
    instagram: handle,
    instagramScope: handle ? (ig.scope || 'business') : null,
    phone: null,
    phoneAskFor: null,
    // A brand with a page is a form. A brand with only a handle is a DM. This is
    // the whole of the routing change -- everything else about the card is the same.
    channel: c.programUrl ? 'program' : 'dm',
    programUrl: c.programUrl || null,
    // Written the same way a DM is, by the same writer, under the same lint --
    // the ban on naming a price and the ban on inventing an athlete fact do not
    // relax because the lane changed.
    dmText: (pitch && pitch.message) ? pitch.message : writeDm(athleteName, c.brand_name, c.why),
    angle: (pitch && pitch.angle) || null,
    angleKey: (pitch && pitch.angleKey) || null,
    categoryKey: (pitch && pitch.categoryKey) || null,
    ask: (pitch && pitch.ask) || null,
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

// Which of the five slots are open. Only a QUEUED row holds a slot -- sent and
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
  // Per-athlete share, so the ordering of the roster stops deciding who eats.
  let share = Infinity;
  let sharedUsed = 0;
  const b = {
    cap: () => cap,
    spent: () => used,
    remaining: () => Math.max(0, cap - used),
    spend: (amount) => { used += (amount || 0); sharedUsed += (amount || 0); return used; },

    // ── ALLOCATED, NOT FIRST-COME-FIRST-SERVED ─────────────────────────────
    // The first athletes processed used to spend the whole cap and the last ones
    // got "budget cap reached" -- which is not a budget, it is a race decided by
    // the ORDER BY on the roster query. Each athlete now gets a share of what is
    // left, computed from how many are still to come.
    //
    // It is a SHARE, NOT A RESERVATION: an athlete who needs less leaves the rest
    // in the pot, because the next call recomputes against the true remaining.
    // So a cheap night for the first three genuinely funds the last three.
    openFor: (athletesRemaining) => {
      const n = Math.max(1, Number(athletesRemaining) || 1);
      share = Math.max(0, cap - used) / n;
      sharedUsed = 0;
      return share;
    },
    shareLeft: () => Math.max(0, share - sharedUsed),
    shareOf: () => share,
    // Affordable against BOTH the agent's cap and this athlete's share.
    canSpend: (amount) => {
      const a = amount || 0;
      if (used + a > cap + 1e-9) return false;
      return sharedUsed + a <= share + 1e-9;
    },
    // The cap is a hard stop; a share is not. When the roster is nearly done and
    // money is left over, the last athlete should be allowed to use it rather
    // than leave it unspent on principle.
    canSpendFromPot: (amount) => used + (amount || 0) <= cap + 1e-9,
  };
  return b;
}

// ── WHAT A LOOKUP ACTUALLY COST ──────────────────────────────────────────────
// Priced from what the lookup really did, not from a flat ceiling.
//
//   web search   $10 per 1,000 searches, so $0.01 each. This dominates.
//   model call   Haiku with a small prompt and a short structured answer. At
//                Haiku 4.5 rates and the sizes this path sends, a few tenths of
//                a cent; $0.003 is a deliberate over-estimate so the figure
//                never flatters itself.
//
// It is an ESTIMATE FROM REAL COUNTS, which is a different thing from both a
// measured invoice and a guess: the counts are exact, the unit prices are the
// published rates. Anyone reconciling against a bill should expect it to be
// slightly high rather than slightly low.
const USD_PER_WEB_SEARCH = 0.01;
const USD_PER_AI_CALL = 0.003;

function priceOf(meter) {
  if (!meter) return 0;
  const web = Number(meter.webSearches) || 0;
  const ai = Number(meter.aiCalls) || 0;
  return Math.round((web * USD_PER_WEB_SEARCH + ai * USD_PER_AI_CALL) * 10000) / 10000;
}

// Roll a night's lookups into the per-athlete figure the audit asked for.
//
// FREE MEANS COST NOTHING, NOT "the contacts boolean was true". `paid` used to
// filter on `x.cached`, a per-brand flag that was undefined on every row for as
// long as it existed -- so paidLookups equalled lookups, cachedLookups was
// always zero, and perPaidLookupUsd divided by the wrong denominator. A lookup
// that cost $0 is free whatever any flag says, and one that cost something is
// not free even if part of it was served from cache.
function costSummary(spendLogs) {
  const flat = [].concat(...(spendLogs || []).filter(Boolean));
  const paid = flat.filter((x) => x && Number(x.cost) > 0);
  const total = flat.reduce((n, x) => n + (Number(x.cost) || 0), 0);
  const athletes = (spendLogs || []).filter((l) => Array.isArray(l) && l.length).length;
  // The authoritative cache measurement: every read a lookup made, not one
  // boolean about one lane. A single lookup reads contacts, places, siteemail
  // and the ladder's rows, so these are counts rather than a yes/no.
  const hits = flat.reduce((n, x) => n + (Number(x.cacheHits) || 0), 0);
  const misses = flat.reduce((n, x) => n + (Number(x.cacheMisses) || 0), 0);
  const reads = hits + misses;
  // Lookups the meter could not measure at all, charged the ceiling. Reported
  // rather than folded in, because a ceiling charge is a failed measurement and
  // an average that hides them is flattering itself.
  const unmetered = flat.filter((x) => x && x.metered === false).length;
  return {
    lookups: flat.length,
    paidLookups: paid.length,
    // Cost nothing: every read it made was a hit.
    freeLookups: flat.length - paid.length,
    // Kept under the old name so nothing downstream breaks, now meaning the same
    // thing the name always claimed.
    cachedLookups: flat.length - paid.length,
    cacheReads: reads, cacheHits: hits, cacheMisses: misses,
    cacheHitPct: reads ? Math.round((hits / reads) * 1000) / 10 : null,
    unmeteredLookups: unmetered,
    totalUsd: Math.round(total * 10000) / 10000,
    perPaidLookupUsd: paid.length ? Math.round((total / paid.length) * 10000) / 10000 : 0,
    perAthleteUsd: athletes ? Math.round((total / athletes) * 10000) / 10000 : 0,
    athletes,
  };
}

function slotSkipReason(budget, projected) {
  // Says WHICH limit stopped it. "Budget cap reached" was reported when the
  // agent's whole cap was gone AND when this athlete had merely used their share,
  // which are different problems: the first needs a bigger cap, the second needs
  // nothing at all because the money is still there for whoever comes next.
  const capGone = !budget.canSpendFromPot || !budget.canSpendFromPot(projected || 0);
  if (capGone) {
    return 'left empty: the night\'s cap is spent ($' + budget.spent().toFixed(2)
      + ' of $' + budget.cap().toFixed(2) + ', next lookup ~$' + Number(projected || 0).toFixed(2) + ')';
  }
  return 'left empty: this athlete used their share of tonight\'s budget ($'
    + Number(budget.shareOf ? budget.shareOf() : 0).toFixed(2) + '), and the rest is held for the others';
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
  inboxOf, channelFor, subjectFor,
  priceOf, costSummary, USD_PER_WEB_SEARCH, USD_PER_AI_CALL,
  passesProgramBar, buildProgramCard, programCapReached, PROGRAM_SLOT_CAP,
  waitingOnYou, writeDm, askFirstName, namedRows, greetNameOf,
  pauseRelease, pausedUntilNote, PAUSE_RETRY_DAYS,
  prescreen, placesFacts, pausedNote,
  DEFAULT_AGENT_NIGHTLY_USD, MAX_ATTEMPTS_PER_SLOT, SLOTS_PER_ATHLETE,
  WAITING_AFTER_DAYS, OUTCOMES,
  NIGHTLY_SLOTS, DEFAULT_ONDEMAND_USD, BACKOFF_NIGHTS,
  EXPIRE_AFTER_DAYS, EXPIRE_COOLDOWN_DAYS,
};
