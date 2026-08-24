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
  linkedin: 'Public LinkedIn profile naming this business',
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
// How strongly an address is vouched for, by where it came from. Only
// 'published' is greeted by first name (see greetingGuard). An emailSource this
// map does not know falls to 'unverified', which fails closed on the greeting
// rather than promoting an unrecognised source to the strongest label.
const EMAIL_KIND = {
  published: 'published',   // a source found it printed for this person
  hunter: 'hunter',         // paid domain lookup, matched to the person by surname
  bio: 'bio',               // off an Instagram profile, not the business website
  searched: 'searched',     // address ladder step 3: claimed, with a citation
};

function sourceNote(contact) {
  const c = contact || {};
  // Said in words on the row, because "why is the owner in Tier 2" has to be
  // answerable from the card without reading the code.
  const scopeNote = c.affiliationScope === 'unclear'
    ? '. Named for this business but the source states no tie to this location, so not confirmed as the local decision maker'
    : '';
  const base = SOURCE_NOTES[c.source] || null;
  const host = _hostOf(c.sourceUrl);
  if (base && host) return `${base} (${host})` + scopeNote;
  if (base) return base + scopeNote;
  if (host) return `Found on ${host}` + scopeNote;
  if (c.emailSource === 'published') return 'Published contact address' + scopeNote;
  return 'Source not recorded, treat as unverified' + scopeNote;
}

// Confidence label for the NAME ATTRIBUTION only, i.e. how sure we are that this
// person holds this role at this business. It says NOTHING about whether the phone
// number reaches them; that is phoneKind below.
//   Confident = 'high' WITH a sourceUrl (an official or business-owned page)
//   Likely    = 'medium', or 'high' with no sourceUrl to point at
//   Fallback  = a row with no name attached
// CORROBORATION OUTRANKS THE SOURCE'S OWN OPINION OF ITSELF. `confidence` is a
// field the extracting model sets about its own answer, and it said 'high' just
// as readily for the Adweek editor it found in an article about a bakery. Two
// independent sources naming the same person is evidence; one source calling
// itself confident is not.
function confidenceLabel(contact) {
  const c = contact || {};
  if (!c.name || !String(c.name).trim()) return 'Fallback';
  const CR = require('./contactRank');
  if (CR.corroborationOf(c) >= 2) return 'Confirmed';
  if (CR.isUnconfirmed(c)) return 'Unconfirmed';
  if (c.confidence === 'high' && c.sourceUrl) return 'Confident';
  return 'Likely';
}

// Digits-only, for comparing a contact's phone against the business main line.
function _digits(p) { return String(p || '').replace(/\D/g, ''); }

// Fallback root-domain reducer, used when the caller does not inject ai.rootDomain.
function _fallbackRootDomain(url) {
  let s = String(url || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].split('@').pop().split(':')[0].replace(/^www\./, '');
  if (!s.includes('.')) return s;
  const parts = s.split('.').filter(Boolean);
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

// CROSS-DOMAIN GUARD. An address on a domain other than the business website is not
// necessarily wrong (a rebranded business often keeps the old mailbox: EW Motion
// Therapy publishing info@eskridgeandwhite.com), but an agent has no way to know
// that from the row. So it is never shown as if it belongs to the business: it is
// labeled with the mismatch, naming the other domain. Returns null when the domains
// match or when either side is unknown.
//
// IT NEEDS A CONFIRMED WEBSITE, OR IT RUNS BACKWARDS. This compares an address to
// a domain it assumes is the business's own. Give it the wrong domain and every
// verdict inverts: with Post Office Pies holding davenportspizza.com, the real
// address at postofficepies.com gets labelled "different domain, verify before
// using" while the other company's address is presented clean, as the business's
// own. The agent is warned off the right answer and reassured about the wrong one.
// With no ground truth there is nothing to compare against, so it says nothing --
// which is why bizDomain must be null, not a rejected URL, when the gate dropped
// one. Callers pass websiteConfirmed=false to make that refusal explicit rather
// than relying on the empty-string fall-through.
function crossDomainNote(email, bizDomain, rootFn, websiteConfirmed) {
  if (websiteConfirmed === false) return null;
  const root = typeof rootFn === 'function' ? rootFn : _fallbackRootDomain;
  const biz = root(bizDomain || '');
  const at = String(email || '').split('@')[1];
  if (!biz || !at) return null;
  const emailRoot = root(at);
  if (!emailRoot || emailRoot === biz) return null;
  return `Different domain (${emailRoot}) from the business site (${biz}), possibly a former business name. Verify before using.`;
}

// The one sentence an agent reads when the domain gate rejected the listed URL.
// Written HERE rather than imported from domainGate on purpose: this module is
// pure string work with no network and no database, and domainGate reaches
// siteEmail, which opens a pg pool. A card renderer must not drag a connection in.
// It never implies the business is unreachable -- the ladder below it still ran.
function _droppedNote(dropped) {
  if (!dropped) return null;
  const host = _fallbackRootDomain(dropped.url || '') || String(dropped.url || '').slice(0, 60);
  if (!host) return 'No confirmed website for this business.';
  if (dropped.code === 'third-party-host') {
    return `No confirmed website. The listed address was ${host}, a platform page rather than this `
      + `business's own site, so nothing was read from it.`;
  }
  if (dropped.code === 'no-distinctive-word') {
    return `No confirmed website. The listed address was ${host}, and this business's name is all `
      + `trade words, so we could not confirm the domain is theirs. Contacts below come from other sources.`;
  }
  return `No confirmed website. The listed address was ${host}, which does not carry this business's `
    + `name, so it was not used. Contacts below come from other sources.`;
}

// Front-of-house staff: real people, but not who an agent should be calling about a
// deal. They are held back and only surfaced when there is no Tier 1 or Tier 2
// contact at all, so a thin result still shows someone rather than nothing.
// Deliberately narrow: it matches explicit support roles only, never a bare
// unrecognized title, so a "Chiropractor" or "Dentist" who is actually the owner is
// never swept into staff.
const _CR = require('./contactRank');
const STAFF_TITLE_RE = /\b(assistant|receptionist|front desk|hygienist|technician|tech|aide|intern|clerk|cashier|server|waitstaff|host|hostess|barista|stylist|shampoo|massage therapist|patient (care|coordinator)|office coordinator|sales associate|team member|crew member)\b/i;
function isStaffTitle(title) {
  const t = String(title || '').trim();
  if (!t) return false;
  return STAFF_TITLE_RE.test(t);
}

// The name an agent should say on the phone. Keeps an honorific when there is one
// ("Dr. Scott Duca" -> "Dr. Duca"), otherwise the first name ("Dave Horn" -> "Dave").
function askName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const hon = /^(dr|mr|mrs|ms|prof|doctor)\.?$/i;
  if (parts.length > 1 && hon.test(parts[0])) {
    const h = parts[0].replace(/\.?$/, '.');
    return h.charAt(0).toUpperCase() + h.slice(1) + ' ' + parts[parts.length - 1];
  }
  return parts[0];
}

// Does an Instagram handle look like it belongs to this person rather than to the
// business? "davehorn" / "dave.horn" / "hornd" for Dave Horn. Conservative: a
// handle that merely contains the business name will not match a person.
function _handleMatchesName(handle, fullName) {
  const h = String(handle || '').toLowerCase().replace(/[^a-z]/g, '');
  const parts = String(fullName || '').toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z]/g, '')).filter(Boolean);
  if (!h || h.length < 4 || parts.length < 2) return false;
  const first = parts[0];
  const last = parts[parts.length - 1];
  const cands = [first + last, last + first, first[0] + last, first + last[0]];
  return cands.some((c) => c && c.length >= 4 && (c === h || h === c + 'official'));
}

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
  // Business domain that every email on this ladder is checked against -- ONLY if
  // the domain gate confirmed it. A dropped website is not weaker ground truth,
  // it is none: opts.website is deliberately not consulted as a fallback when the
  // gate rejected one, because that is the ungated URL the gate just refused.
  const websiteDropped = r.websiteDropped || opts.websiteDropped || null;
  const bizSite = websiteDropped ? null : (r.website || opts.website || null);
  const websiteConfirmed = !!bizSite;
  const _rootFn = typeof opts.rootDomain === 'function' ? opts.rootDomain : _fallbackRootDomain;
  const _xdom = (email) => crossDomainNote(email, bizSite, _rootFn, websiteConfirmed);
  // A site-scraped handle that carries a person's name is a PERSONAL account, so it
  // belongs to that person's row and rides their tier. Otherwise it is the business
  // account and becomes its own business-channel row.
  const bizHandle = r.instagram || opts.instagram || null;
  // 'brand' means the handle belongs to the national brand rather than this store
  // -- Rally House Fayetteville resolves to @rally_house, 135k followers and no
  // idea this location exists. Absent scope means a row cached before the check,
  // and is treated exactly as before.
  const handleScope = r.instagramScope || opts.instagramScope || null;
  const brandHandle = handleScope === 'brand';
  let personalHandleOwner = null;
  // A corporate account is never somebody's personal DM, so it must not be pinned
  // to a named row even if the letters happen to line up.
  if (bizHandle && !brandHandle) {
    personalHandleOwner = named.find((c) => _handleMatchesName(bizHandle, c.name)) || null;
  }
  const askFor = [];      // names to say on the main line, collected for one row
  const staffPool = [];   // held back unless there is no Tier 1 or Tier 2
  const unreachable = []; // named, but no channel of any kind: never given a row
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
    const say = askName(c.name);
    const igHandle = c.instagram || (personalHandleOwner === c ? bizHandle : null);
    // A NAME IS NOT A CONTACT. A row must offer a way to reach the person: their own
    // number, an email, a DM, or failing those the business line with "ask for" them.
    // With no channel at all they get no row; they are listed under the main line
    // instead, so the ladder never shows a name an agent cannot act on.
    const hasOwnChannel = !!(isOwnLine || c.email || c.linkedinUrl || igHandle);
    const isStaff = isStaffTitle(c.title);
    if (!hasOwnChannel && !r.businessPhone) { if (say && !isStaff) unreachable.push(say); continue; }
    const row = {
      name: c.name,
      title: c.title || null,
      email: c.email || null,
      // 'published' means a source found this address printed for this person.
      // 'hunter' means a paid domain lookup had it against the COMPANY and we
      // matched it to this person by surname -- likely right, not confirmed. The
      // distinction is load-bearing, not cosmetic: greetingGuard refuses to greet
      // by first name on anything but 'published', which is the guard that was
      // missing when this lookup was removed in fbf5865.
      // AN ALLOW-LIST, NOT A DEFAULT. This read "hunter ? hunter : published",
      // so every emailSource that was not literally 'hunter' was announced as
      // published -- including 'bio', which ai.js sets precisely so that an
      // address off an Instagram profile never reads as published on the
      // business website, and 'searched', which is step 3 of the address ladder:
      // a model's claim backed by a citation, not something we read on the
      // business's own page. greetingGuard greets by first name on 'published'
      // and nothing else, so the default was handing the strongest label to the
      // two weakest sources.
      emailKind: c.email ? (EMAIL_KIND[c.emailSource] || 'unverified') : null,
      emailDomainNote: c.email ? _xdom(c.email) : null,
      phone: isOwnLine ? c.phone : null,
      phoneKind: isOwnLine ? 'direct' : null,
      phoneNote: isOwnLine ? 'Direct number listed for this person' : null,
      instagram: igHandle,
      // Primary channel for this row, most person-specific first:
      //   1 direct email, 2 LinkedIn profile, 3 personal Instagram, 4 direct phone,
      //   5 the shared main line. Drives what the UI leads with.
      channel: c.email ? 'email'
        : (c.linkedinUrl ? 'linkedin'
        : (igHandle ? 'instagram'
        : (isOwnLine ? 'phone' : 'mainline'))),
      // When their only route is the shared line, say so in words. The digits stay
      // in the single main-line row at the top and are never reprinted here.
      reachVia: hasOwnChannel ? null : `Main line, ask for ${say}`,
      askAs: hasOwnChannel ? null : say, // feeds the single main-line row below
      linkedinUrl: c.linkedinUrl || null,
      sourceUrl: c.sourceUrl || null,
      // Name attribution only. Rendered as "Name: Confident", never as a claim
      // about the phone or email.
      confidence: confidenceLabel(c),
      // Carried onto the row so the card, the pitch and the greeting guard all
      // read the same judgement rather than each re-deriving one.
      unconfirmed: c.unconfirmed === undefined ? _CR.isUnconfirmed(c) : !!c.unconfirmed,
      corroboration: _CR.corroborationOf(c),
      sources: c.sources || (c.source ? [c.source] : []),
      affiliationScope: c.affiliationScope || null,
      affiliationEvidence: c.affiliationEvidence || null,
      sourceNote: sourceNote(c) + (igHandle && personalHandleOwner === c ? '. Instagram handle matches this name, so it is likely their personal account' : ''),
    };
    // TIER 1 MEANS "CAN APPROVE A DEAL AT THIS LOCATION", so it needs both an
    // authoritative title AND a source that tied them to this location. A chamber
    // listing names a real owner without ever stating an address; that is scope
    // 'unclear', and it is DEMOTED rather than rejected -- it is the highest-yield
    // source there is, and dropping it would delete what works to fix a problem
    // that only occurs on chains. A contact with no scope at all predates the
    // check (a cached row) and is treated exactly as before.
    const unconfirmed = c.affiliationScope === 'unclear';
    if (isStaff) staffPool.push(row);
    else if (TIER1_RANKS.indexOf(rank) !== -1 && !unconfirmed) t1.push(row);
    else t2.push(row);
  }
  // Staff surface ONLY when there is no decision maker and no manager to show.
  if (!t1.length && !t2.length && staffPool.length) {
    for (const row of staffPool) t2.push(row);
  }
  // "Ask for" names come from the rows that actually made the ladder, so a held-back
  // staff member is not surfaced through the main-line row by the back door.
  for (const row of t1.concat(t2)) {
    if (row.askAs && askFor.indexOf(row.askAs) === -1) askFor.push(row.askAs);
  }

  const callWindow = callWindowFor(opts.category);
  const tiers = [];
  if (t1.length) tiers.push({ tier: 1, label: 'Owner or marketing decision maker', rows: t1 });
  if (t2.length) tiers.push({ tier: 2, label: 'GM or manager', rows: t2 });

  // The main line is hoisted OUT of the tiers and rendered once, at the top, naming
  // everyone to ask for. Previously it appeared on each sharing contact's row AND
  // again as a Tier 3 row, so one number read as three dead ends.
  const _join = (a) => (a.length === 1 ? a[0] : a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1]);
  const mainLine = r.businessPhone ? {
    phone: r.businessPhone,
    askFor,
    note: askFor.length ? `Main line, ask for ${_join(askFor)}` : 'Main line, no named person confirmed',
    callWindow,
    channel: 'phone',
    sourceNote: 'Business phone from the Google Places listing',
  } : null;

  // Tier 3 now carries the OTHER business-level channels, not the phone.
  const t3 = [];
  if (bizHandle && !personalHandleOwner) {
    t3.push({
      name: null,
      title: brandHandle ? 'National brand Instagram' : 'Business Instagram',
      instagram: bizHandle,
      channel: 'instagram',
      phone: null,
      email: null,
      // A brand account is a real channel and is offered, but it is not a route to
      // this location and must never read as one.
      confidence: brandHandle ? 'Fallback' : 'Likely',
      sourceNote: brandHandle
        ? 'The national brand account, not this location. A DM here reaches corporate social, not the store.'
        : 'Instagram link found on the business website. DM the account, owners usually read these.',
      callWindow: null,
    });
  }
  if (r.personalInbox) {
    t3.push({
      name: null,
      title: 'Named mailbox',
      email: r.personalInbox,
      emailKind: 'published',
      emailDomainNote: _xdom(r.personalInbox),
      channel: 'email',
      phone: null,
      confidence: 'Likely',
      sourceNote: 'Published mailbox with a personal name, not a general inbox. Likely a specific person.',
      callWindow: null,
    });
  }
  // ── The address found on the business's own website ───────────────────────
  // Placed ABOVE the generic inbox because it is better evidence: it was
  // published by the business itself on its own site, not inferred. A personal
  // address here outranks a role one, which is why the type travels with it.
  if (r.siteEmail && r.siteEmail.email) {
    const se = r.siteEmail;
    const personal = se.type === 'personal';
    t3.push({
      name: null,
      title: se.corporate ? 'Corporate email (not this location)'
        : (personal ? 'Email from their website' : 'Role email from their website'),
      email: se.email,
      emailKind: 'published',
      emailType: se.type,
      // A corporate address on a franchise is a real address and a dead end for a
      // local deal, so it is shown and labelled rather than hidden.
      corporate: !!se.corporate,
      emailDomainNote: _xdom(se.email),
      channel: 'email',
      phone: null,
      confidence: se.corporate ? 'Fallback' : (personal ? 'Likely' : 'Fallback'),
      sourceNote: se.corporate
        ? `This address belongs to the national brand, not this location${se.corporateVia ? ' (' + se.corporateVia + ')' : ''}. Corporate cannot approve a local deal.`
        : (personal
          ? 'Published on the business website and addressed to a person, not a general desk.'
          : 'Published on the business website. A role inbox, so it reaches a desk rather than a named person.'),
      sourceUrl: se.sourceUrl || null,
      callWindow: null,
    });
  } else if (r.siteEmail && r.siteEmail.formUrl) {
    // No address anywhere on the site, but a working contact form is still a
    // channel -- and a better one than nothing at all.
    t3.push({
      name: null,
      title: 'Contact form',
      email: null,
      emailType: 'form',
      channel: 'form',
      formUrl: r.siteEmail.formUrl,
      phone: null,
      confidence: 'Fallback',
      sourceNote: 'No email published, but the site has a working contact form.',
      sourceUrl: r.siteEmail.formUrl,
      callWindow: null,
    });
  }
  if (r.genericInbox) {
    t3.push({
      name: null,
      title: 'General inbox',
      phone: null,
      email: r.genericInbox,
      emailKind: 'published',
      emailDomainNote: _xdom(r.genericInbox),
      channel: 'email',
      confidence: 'Fallback',
      sourceNote: 'Published general inbox, not a named person',
      callWindow: null,
    });
  }
  if (!t1.length && !t2.length && !t3.length && !mainLine) {
    // Absolute floor: never an empty result.
    t3.push({
      name: null,
      title: 'No contact found yet',
      phone: null,
      email: null,
      channel: 'phone',
      mapsUrl: r.mapsUrl || opts.mapsUrl || null,
      confidence: 'Fallback',
      sourceNote: 'No published contact found in the free sources. Try the Google Maps listing.',
      callWindow,
    });
  }
  if (t3.length) tiers.push({ tier: 3, label: 'Business channels', rows: t3 });

  return {
    mainLine,
    tiers,
    // A website the domain gate rejected. Shown on the card, not hidden: an agent
    // seeing contacts with no website should know it is because the listed URL
    // belonged to someone else, not because the business has no web presence.
    websiteNote: websiteDropped ? _droppedNote(websiteDropped) : null,
    websiteDroppedCode: websiteDropped ? (websiteDropped.code || null) : null,
    // Named people we found but cannot reach by any channel. Never given a row;
    // shown as context so the research is not silently thrown away.
    unreachable,
    staffHeldBack: (t1.length || t2.length) ? staffPool.length : 0,
    hasTier1: t1.length > 0,
    topTier: t1.length ? 1 : (t2.length ? 2 : 3),
    callWindow,
  };
}

module.exports = { buildContactLadder, confidenceLabel, sourceNote, callWindowFor, isStaffTitle, askName, crossDomainNote, TIER1_RANKS, SOURCE_NOTES };
