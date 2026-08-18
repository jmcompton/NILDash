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
const SLOTS_PER_ATHLETE = 3;
const WAITING_AFTER_DAYS = 3;
const OUTCOMES = ['no_reply', 'replied', 'closed'];

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

// The DM, written from the card the scan already produced. No model call: the
// rationale that justified showing the business is the same sentence that
// justifies the message.
function writeDm(athleteName, brandName, why) {
  const who = String(athleteName || 'a college athlete I work with').trim();
  const angle = String(why || '').trim().replace(/\s+/g, ' ');
  const first = angle ? angle.split(/(?<=[.!?])\s/)[0] : '';
  return `Hi! I work on the NIL side with ${who}, a college athlete here in your area. `
    + `I had an idea for a partnership with ${brandName}`
    + (first ? ` — ${first.charAt(0).toLowerCase()}${first.slice(1).replace(/\.$/, '')}` : '')
    + `. Would love to send over a short overview if you're open to it!`;
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
    dmText: dmable ? writeDm(c.athleteName, c.brand || c.brandName, c.rationale) : null,
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
  DEFAULT_AGENT_NIGHTLY_USD, MAX_ATTEMPTS_PER_SLOT, SLOTS_PER_ATHLETE,
  WAITING_AFTER_DAYS, OUTCOMES,
};
