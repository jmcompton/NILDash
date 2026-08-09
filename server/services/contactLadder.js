'use strict';
// Contact ladder for the manual "Add a Business" flow. Pure and deterministic:
// no AI, no network. It takes the output of ai.getBrandContacts and arranges it
// into the three tiers an agent actually works down, attaching a confidence label
// and a one-line source note to EVERY row.
//
//   Tier 1: owner or marketing decision maker
//   Tier 2: GM or manager (and any other named contact we could not rank higher)
//   Tier 3: the main line, with a suggested call window
//
// Rules held here:
//   - Never render a name without a source note. A contact with no derivable note
//     gets an explicit honest one, never an empty string.
//   - Never return empty. With no named person we still return the main line plus
//     a call window, and failing that a maps affordance.
//   - Authority ranking is NOT duplicated: rankOf is injected (ai.contactAuthorityRank).

// Tier 1 = decision makers: owner/founder/CEO (0), franchise owner (1),
// officer/member/partner/director (2), marketing leadership/CMO (4),
// marketing/partnerships manager (5). Tier 2 = GM/managing (3), manager/
// coordinator/specialist (6), and anything else we could not rank higher, so a
// named person is never silently dropped.
const TIER1_RANKS = [0, 1, 2, 4, 5];

// Readable provenance per source lane, used to build the one-line source note.
const SOURCE_NOTES = {
  site: 'Listed on the business website',
  facebook: 'Listed on their Facebook page',
  maps: 'Listed on their Google Business profile',
  places: 'From the Google Places listing',
  registry: 'Named in a state business filing',
  news: 'Named in a news article',
  chamber: 'Listed in a chamber of commerce directory',
  hunter: 'Email matched to the company domain',
};

// Suggested call windows. Local businesses are reachable at different times by
// type; these avoid each type's rush rather than guessing a person's calendar.
const CALL_WINDOWS = {
  restaurant: 'Tue to Thu, 2pm to 4pm local, between the lunch and dinner rushes',
  food: 'Tue to Thu, 2pm to 4pm local, between the lunch and dinner rushes',
  coffee: 'Tue to Thu, 1pm to 3pm local, after the morning rush',
  bar: 'Tue to Thu, 2pm to 4pm local, before the evening crowd',
  gym: 'Tue to Thu, 10am to 11:30am local, between the morning and evening blocks',
  fitness: 'Tue to Thu, 10am to 11:30am local, between the morning and evening blocks',
  salon: 'Tue to Thu, 10am to 11:30am local, before the afternoon appointments',
  dealership: 'Tue to Thu, 10am to 11:30am local, before the afternoon floor traffic',
  auto: 'Tue to Thu, 10am to 11:30am local',
  retail: 'Tue to Thu, 10am to 11:30am local, before the midday shoppers',
  apparel: 'Tue to Thu, 10am to 11:30am local, before the midday shoppers',
};
const DEFAULT_CALL_WINDOW = 'Tue to Thu, 10am to 11:30am local, outside the Monday and Friday rush';

function _hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

// One-line note saying HOW this contact was found, from source + sourceUrl.
// Always returns a non-empty string so a name can never render bare.
function sourceNote(contact) {
  const c = contact || {};
  const base = SOURCE_NOTES[c.source] || null;
  const host = _hostOf(c.sourceUrl);
  if (base && host) return `${base} (${host})`;
  if (base) return base;
  if (host) return `Found on ${host}`;
  if (c.emailSource === 'hunter') return SOURCE_NOTES.hunter;
  if (c.emailSource === 'published') return 'Published contact address';
  return 'Source not recorded, treat as unverified';
}

// Confidence label for the NAME ATTRIBUTION only, i.e. how sure we are that this
// person holds this role at this business. It says NOTHING about whether the phone
// number reaches them; that is phoneKind below.
//   Confident = 'high' WITH a sourceUrl (an official or business-owned page)
//   Likely    = 'medium', or 'high' with no sourceUrl to point at
//   Fallback  = a row with no name attached
function confidenceLabel(contact) {
  const c = contact || {};
  if (!c.name || !String(c.name).trim()) return 'Fallback';
  if (c.confidence === 'high' && c.sourceUrl) return 'Confident';
  return 'Likely';
}

// Digits-only, for comparing a contact's phone against the business main line.
function _digits(p) { return String(p || '').replace(/\D/g, ''); }

function callWindowFor(category) {
  const k = String(category || '').toLowerCase();
  for (const key of Object.keys(CALL_WINDOWS)) {
    if (k.indexOf(key) !== -1) return CALL_WINDOWS[key];
  }
  return DEFAULT_CALL_WINDOW;
}

// Build the ladder. res is the ai.getBrandContacts return value.
// opts: { rankOf, category, brand, mapsUrl }
// Returns { tiers: [{tier,label,rows:[...]}], topTier, hasTier1, callWindow }.
function buildContactLadder(res, opts = {}) {
  const r = res || {};
  const rankOf = typeof opts.rankOf === 'function' ? opts.rankOf : () => 7;
  const named = Array.isArray(r.contacts) ? r.contacts.filter((c) => c && c.name && String(c.name).trim()) : [];

  const mainDigits = _digits(r.businessPhone);
  const t1 = [];
  const t2 = [];
  for (const c of named) {
    const rank = rankOf(c.title);
    // Separate the NAME confidence from the NUMBER. getBrandContacts donates the
    // business main line to the top named contact who has none, and a source can
    // also report the main line as a person's number. Either way that number does
    // NOT reach that person, so never present it as their direct line: a confident
    // name attached to a general number was reading as "call this to get Don".
    const ownDigits = _digits(c.phone);
    const isOwnLine = !!ownDigits && ownDigits !== mainDigits;
    const phone = isOwnLine ? c.phone : (r.businessPhone || null);
    const phoneKind = !phone ? null : (isOwnLine ? 'direct' : 'main');
    const first = String(c.name || '').trim().split(/\s+/)[0];
    const row = {
      name: c.name,
      title: c.title || null,
      email: c.email || null,
      emailKind: c.email ? (c.emailSource === 'hunter' ? 'pattern' : 'published') : null,
      phone,
      phoneKind,
      // Says exactly what the number is, so nothing implies a direct line.
      phoneNote: phoneKind === 'main'
        ? (first ? `Main line, ask for ${first}` : 'Main line, not a direct number')
        : (phoneKind === 'direct' ? 'Direct number listed for this person' : null),
      linkedinUrl: c.linkedinUrl || null,
      sourceUrl: c.sourceUrl || null,
      // Name attribution only. Rendered as "Name: Confident", never as a claim
      // about the phone or email.
      confidence: confidenceLabel(c),
      sourceNote: sourceNote(c),
    };
    if (TIER1_RANKS.indexOf(rank) !== -1) t1.push(row); else t2.push(row);
  }

  const callWindow = callWindowFor(opts.category);
  const tiers = [];
  if (t1.length) tiers.push({ tier: 1, label: 'Owner or marketing decision maker', rows: t1 });
  if (t2.length) tiers.push({ tier: 2, label: 'GM or manager', rows: t2 });

  // Tier 3 is ALWAYS present when there is a line to call, and is the guaranteed
  // non-empty floor when no person was found.
  const t3 = [];
  if (r.businessPhone) {
    t3.push({
      name: null,
      title: 'Main line',
      phone: r.businessPhone,
      email: null,
      confidence: 'Fallback',
      sourceNote: 'Business phone from the Google Places listing',
      callWindow,
    });
  }
  if (r.genericInbox) {
    t3.push({
      name: null,
      title: 'General inbox',
      phone: null,
      email: r.genericInbox,
      confidence: 'Fallback',
      sourceNote: 'Published general inbox, not a named person',
      callWindow: null,
    });
  }
  if (!t1.length && !t2.length && !t3.length) {
    // Absolute floor: never an empty result.
    t3.push({
      name: null,
      title: 'No contact found yet',
      phone: null,
      email: null,
      mapsUrl: r.mapsUrl || opts.mapsUrl || null,
      confidence: 'Fallback',
      sourceNote: 'No published contact found in the free sources. Try the Google Maps listing.',
      callWindow,
    });
  }
  if (t3.length) tiers.push({ tier: 3, label: 'Main line', rows: t3 });

  return {
    tiers,
    hasTier1: t1.length > 0,
    topTier: t1.length ? 1 : (t2.length ? 2 : 3),
    callWindow,
  };
}

module.exports = { buildContactLadder, confidenceLabel, sourceNote, callWindowFor, TIER1_RANKS, SOURCE_NOTES };
