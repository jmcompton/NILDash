'use strict';
// ── HOW GOOD IS THIS ADDRESS? FOUR TIERS ────────────────────────────────────
//
// Every address the contact lookup produces is put in exactly one tier, and the
// tier and the page it came from are stored on the card and the draft:
//
//   Tier 1  a named person at the business's own domain, FOUND stated on a page
//           (the business site, a directory, Hunter's crawl of the web).
//   Tier 2  a named person at the business's own domain, CONSTRUCTED from the
//           domain's address pattern and the owner's name. Never seen written
//           down; likely right, not confirmed.
//   Tier 3  a named person at a personal domain (gmail, yahoo, a vanity domain)
//           publicly tied to this business.
//   Tier 4  a generic mailbox: info@, contact@, hello@ and the rest. A desk, not
//           a person, and NO EMAIL CARD IS BUILT FROM ONE (services/outreachQueue
//           routes the business to a call or a DM, or drops it).
//
// This is a different axis from the contact ladder's own tiers (owner, manager,
// business channels), which rank PEOPLE. These rank ADDRESSES, so the column is
// email_tier and never "tier".

// The generic mailboxes, as the product defines them. A local part that is one
// of these, or starts with one (info.austin@, sales-team@), is Tier 4.
const GENERIC_LOCALS = new Set([
  'info', 'contact', 'hello', 'hi', 'team', 'admin', 'office', 'support', 'sales',
  'orders', 'bookings', 'inquiries', 'general', 'frontdesk',
]);
// SPELLING VARIANTS of the list, and only those: the product list is the
// definition, so a mailbox is Tier 4 because it IS one of those fourteen, not
// because it looks deskish. Other role mailboxes -- owner@, marketing@,
// events@ -- are not on the list and are left as they were (a role address at
// the business domain, sendable), with a reason that says what they are.
const VARIANTS = new Set([
  'contactus', 'information', 'booking', 'inquiry', 'enquiry', 'enquiries', 'order',
]);
// Role words that are not on the list, for the REASON only (never the tier).
const ROLE_WORDS = new Set(['owner', 'owners', 'marketing', 'manager', 'management', 'events',
  'catering', 'reservations', 'service', 'help', 'mail', 'shop', 'store', 'studio', 'press', 'media']);

const FREE_DOMAINS = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|aol|icloud|me|mac|live|msn|protonmail|proton|pm|att|sbcglobal|comcast|bellsouth|verizon|cox|charter|earthlink|gmx|mail|zoho)\.[a-z.]+$/;

const LABELS = {
  1: 'Tier 1: a named person at the business domain, found stated on a page',
  2: 'Tier 2: a named person at the business domain, built from the domain\'s address pattern',
  3: 'Tier 3: a named person at a personal address publicly tied to the business',
  4: 'Tier 4: a generic mailbox, not a person',
};

function _addr(email) {
  const e = String(email || '').trim().toLowerCase().replace(/^mailto:/, '');
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) ? e : null;
}
function localPart(email) { const e = _addr(email); return e ? e.split('@')[0] : ''; }
function domainOf(email) { const e = _addr(email); return e ? e.split('@')[1] : ''; }

function rootDomain(urlOrHost) {
  let h = String(urlOrHost || '').trim().toLowerCase();
  if (!h) return null;
  h = h.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].split('#')[0];
  h = h.replace(/^www\./, '').replace(/:\d+$/, '');
  if (h.includes('@')) h = h.split('@').pop();
  const parts = h.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const last2 = parts.slice(-2).join('.');
  if (parts.length >= 3 && /^(co|com|net|org|gov|ac)\.[a-z]{2}$/.test(last2)) return parts.slice(-3).join('.');
  return last2;
}

// Tier 4 or not. The whole local part, or its first token (info.austin@,
// sales_team@), or the whole part with trailing digits dropped (info2@).
function isGeneric(email) {
  const lp = localPart(email);
  if (!lp) return false;
  const bare = lp.replace(/\d+$/, '');
  const joined = bare.replace(/[._+-]/g, '');        // front-desk, front.desk -> frontdesk
  const first = lp.split(/[._+-]/)[0];
  for (const t of [lp, bare, joined, first]) {
    if (GENERIC_LOCALS.has(t) || VARIANTS.has(t)) return true;
  }
  return false;
}

// A role mailbox the product list does not name (owner@, marketing@). Not
// Tier 4; only used to say what it is.
function isRoleMailbox(email) {
  const lp = localPart(email);
  return ROLE_WORDS.has(lp.replace(/\d+$/, '')) || ROLE_WORDS.has(lp.split(/[._+-]/)[0]);
}

function isFreeMail(email) { return FREE_DOMAINS.test(domainOf(email)); }

// Classify one address.
//   email          the address
//   emailKind      provenance: 'published' | 'searched' | 'bio' | 'hunter' | 'pattern'
//   businessDomain the confirmed business website's root domain, or null
// Returns { tier, reason } or null when there is no address.
function classify({ email, emailKind, businessDomain } = {}) {
  const e = _addr(email);
  if (!e) return null;
  if (isGeneric(e)) return { tier: 4, reason: `${localPart(e)}@ is a generic mailbox, not a person` };
  const kind = emailKind || 'published';
  const at = rootDomain(domainOf(e));
  const biz = businessDomain ? rootDomain(businessDomain) : null;
  if (isFreeMail(e)) {
    return { tier: 3, reason: `a personal ${domainOf(e)} address published for this business` };
  }
  if (biz && at !== biz) {
    // A person's own domain (a vanity domain, a holding company). Publicly tied
    // to the business by whatever page stated it, but not the business's own.
    return { tier: 3, reason: `a named address at ${at}, not the business domain (${biz})` };
  }
  if (kind === 'pattern') {
    return { tier: 2, reason: `built from ${at}'s address pattern and the owner's name; never seen written down` };
  }
  if (isRoleMailbox(e)) {
    return { tier: 1, reason: `${localPart(e)}@ is a role mailbox at the business domain, not on the generic list, so it is sent to` };
  }
  return { tier: 1, reason: kind === 'hunter'
    ? `found by Hunter at ${at}, the business domain`
    : `stated on a page, at ${biz ? 'the business domain' : at}` };
}

// Annotate every address on a contact ladder in place: emailTier,
// emailTierReason, and emailSourceUrl (the page the address came from, which is
// not always the page the NAME came from). Returns the ladder.
function annotateLadder(ladder, businessDomain) {
  const L = ladder || {};
  const biz = businessDomain !== undefined ? businessDomain : (L.businessDomain || null);
  for (const t of (L.tiers || [])) {
    for (const r of (t.rows || [])) {
      if (!r || !r.email) continue;
      const c = classify({ email: r.email, emailKind: r.emailKind, businessDomain: biz });
      if (!c) continue;
      r.emailTier = c.tier;
      r.emailTierReason = c.reason;
      if (r.emailSourceUrl === undefined) r.emailSourceUrl = r.sourceUrl || null;
    }
  }
  return L;
}

// The tier of one ladder row, computing it when the row was never annotated
// (a row attached after annotateLadder ran).
function tierOfRow(row, businessDomain) {
  if (!row || !row.email) return null;
  if (row.emailTier) return row.emailTier;
  const c = classify({ email: row.email, emailKind: row.emailKind, businessDomain });
  return c ? c.tier : null;
}

// ── THE NIGHT, BY TIER ──────────────────────────────────────────────────────
// From a nightly run's details (outreach_queue_runs.details: one entry per
// athlete, each with the `tried` list the job recorded per business). A
// business can appear more than once in `tried` -- 'queued' before the writer
// ran, then 'no_angle' if it refused -- so each business is judged by its LAST
// entry, and its route by the entry that recorded one.
//   email cards by tier: tier1, tier2, tier3
//   toPhone / toDm: only a generic mailbox, so the card became a call / a DM
//   dropped: only a generic mailbox and nothing to route to; discovery refilled
function routeTally(details) {
  const t = { tier1: 0, tier2: 0, tier3: 0, toPhone: 0, toDm: 0, dropped: 0, untiered: 0 };
  for (const d of (Array.isArray(details) ? details : [])) {
    const byBrand = new Map();
    for (const x of ((d && d.tried) || [])) {
      if (!x || !x.brand) continue;
      const k = String(x.brand).toLowerCase();
      const cur = byBrand.get(k) || { last: null, route: null };
      cur.last = x;
      if (x.why && x.why.emailRoute) cur.route = x.why.emailRoute;
      byBrand.set(k, cur);
    }
    for (const { last, route } of byBrand.values()) {
      if (!route) continue;
      if (last.result === 'queued') {
        if (route.route === 'email') {
          if (route.emailTier >= 1 && route.emailTier <= 3) t['tier' + route.emailTier]++;
          else t.untiered++;
        } else if (route.tier4Only && route.route === 'call') t.toPhone++;
        else if (route.tier4Only && route.route === 'dm') t.toDm++;
      } else if (last.result === 'rejected' && route.route === 'dropped') {
        t.dropped++;
      }
    }
  }
  return t;
}

module.exports = {
  routeTally,
  classify, annotateLadder, tierOfRow, isGeneric, isRoleMailbox, isFreeMail, rootDomain, localPart, domainOf,
  GENERIC_LOCALS, VARIANTS, LABELS,
};
