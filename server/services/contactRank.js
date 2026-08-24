'use strict';
// ── WHO IS THE DECISION MAKER, DECIDED THE SAME WAY EVERY TIME ───────────────
//
// THE FAILURE THIS REPLACES. Three runs of the same twenty Birmingham businesses
// on the same day named a different person for seven of them:
//
//   Continental Bakery   Carole / David Griner / Carole Griffin
//   Iron Tribe Fitness   Jenny Auvil / Forrest Walden / Forrest Walden
//   Homewood Cycle       Mandy / Walter Busenlehner / Mandy
//
// David Griner is an Adweek editor. Walter Busenlehner was carried as "Building
// owner (per news)", which is a landlord. The pitch goes out addressed to
// whoever won, under the agent's own name.
//
// It varied because the old comparator was not a total order:
//
//   named.sort((a, b) =>
//     (rank(a.title) - rank(b.title)) ||
//     ((a.confidence === 'high' ? 0 : 1) - (b.confidence === 'high' ? 0 : 1)));
//
// rank("Owner") and rank("Owner (per news)") are BOTH 0, because the old rank
// function matched \bowner\b and ignored everything around it. Equal rank plus
// equal confidence compares 0, Array.sort is stable, so the winner was whichever
// source's network call returned first.
//
// FOUR THINGS DECIDE IT NOW, in this order, and the last one is always decisive:
//
//   1. AUTHORITY   what the title claims -- owner, officer, GM, marketing
//   2. HEDGING     how strongly it claims it. "Owner" from the business's own
//                  site beats "Owner (per news)". "Building owner" and "not
//                  confirmed owner" are not owner claims at all.
//   3. CORROBORATION  how many independent sources named this person
//   4. SOURCE      which source, by how well it knows who runs a business
//   5. NAME        a stable alphabetical tie-break, so two genuinely equal
//                  candidates still resolve identically on every run
//
// Nothing here depends on arrival order, latency, or which wave finished first.
// Given the same set of contacts in any order, this returns the same winner.

// ── 1. AUTHORITY ─────────────────────────────────────────────────────────────
// Lower is more senior. 0-6 mirror the ranks the rest of the codebase already
// uses (TIER1_RANKS = [0,1,2,4,5]); 8 and 9 are the two "this is not a decision
// maker" outcomes.
const RANK = {
  OWNER: 0, FRANCHISEE: 1, OFFICER: 2, GM: 3,
  MARKETING_LEAD: 4, MARKETING_MGR: 5, MANAGER: 6,
  UNTITLED: 7,
  PLACEHOLDER: 8,      // the title says, in words, that we do not know who this is
  REGISTERED_AGENT: 9, // a lawyer or filing service, not someone who can say yes
};

// TITLES THAT CONTAIN "OWNER" AND DO NOT MEAN THE OWNER OF THIS BUSINESS.
// Checked BEFORE the owner pattern, which is the whole point: "Building owner"
// and "not confirmed owner" both contain \bowner\b and both used to rank 0,
// identically to a real owner from the business's own about page.
const NOT_THIS_OWNER = [
  { re: /\b(building|property|land|premises|real[\s-]?estate|site)\s+owner\b/i,
    why: 'owns the building, not the business' },
  { re: /\b(former|previous|prior|ex)[\s-]?owner\b/i,
    why: 'no longer the owner' },
  { re: /\bnot\s+(a\s+)?(the\s+)?(confirmed|verified)?\s*owner\b/i,
    why: 'the title itself says this is not confirmed' },
];

// Placeholder titles: a role-shaped string that is really "we could not tell".
// Kept in step with greetingGuard.NON_ROLE_TITLE deliberately -- a title the
// greeting guard refuses to greet on must not be able to win the ladder either.
const PLACEHOLDER = new RegExp('(' + [
  'not confirmed', 'unconfirmed', 'not verified', 'unverified', 'possible',
  'company contact', 'business contact', 'primary contact', 'listed contact',
  'general (inbox|contact)', 'named mailbox', 'placeholder', 'unknown',
].join('|') + ')', 'i');

// Classify the title. Returns the rank AND why, so a card can say in words why an
// apparent owner was not treated as one.
function authorityOf(title) {
  const t = String(title || '').trim();
  if (!t) return { rank: RANK.UNTITLED, why: 'no title given' };

  // Registered agent first, so it is never caught by a looser rule below.
  if (/registered agent/i.test(t)) return { rank: RANK.REGISTERED_AGENT, why: 'registered agent, usually a lawyer or filing service' };
  if (PLACEHOLDER.test(t)) return { rank: RANK.PLACEHOLDER, why: 'the title is a placeholder, not a role' };

  for (const d of NOT_THIS_OWNER) {
    if (d.re.test(t)) return { rank: RANK.PLACEHOLDER, why: d.why };
  }

  if (/\bowner\b|founder|proprietor|principal|\bceo\b|president/i.test(t)) return { rank: RANK.OWNER, why: 'owner or founder' };
  if (/franchis/i.test(t)) return { rank: RANK.FRANCHISEE, why: 'franchisee' };
  if (/\bofficer\b|\bmember\b|managing member|\bpartner\b|\bdirector\b(?!.*marketing)|\btreasurer\b|\bsecretary\b|incorporator/i.test(t)) return { rank: RANK.OFFICER, why: 'officer or LLC member' };
  if (/general manager|\bgm\b|managing director|\bmanaging\b/i.test(t)) return { rank: RANK.GM, why: 'general manager' };
  if (/(marketing|brand|partnership|sponsorship)[^.]*(director|vp|vice president|head|chief|lead)|\bcmo\b|director of marketing/i.test(t)) return { rank: RANK.MARKETING_LEAD, why: 'marketing leadership' };
  if (/marketing manager|partnerships? (manager|lead|coordinator)|brand manager/i.test(t)) return { rank: RANK.MARKETING_MGR, why: 'marketing or partnerships manager' };
  if (/manager|coordinator|specialist/i.test(t)) return { rank: RANK.MANAGER, why: 'manager' };
  return { rank: RANK.UNTITLED, why: 'title does not name a decision-making role' };
}

// ── 2. HEDGING ───────────────────────────────────────────────────────────────
// _labelTitle appends exactly one provenance qualifier. It is a claim about how
// well we know the title, so it belongs in the ordering rather than being
// stripped and forgotten. Lower is a stronger claim.
const HEDGE = { NONE: 0, FILING: 1, NEWS: 2 };
function hedgeOf(title) {
  const t = String(title || '');
  if (/\(per news\)|per news report|reportedly/i.test(t)) return HEDGE.NEWS;
  if (/\(state filing\)|state filing|secretary of state/i.test(t)) return HEDGE.FILING;
  return HEDGE.NONE;
}

// ── 3 & 4. SOURCE ────────────────────────────────────────────────────────────
// Ordered by how well the source knows WHO RUNS THIS BUSINESS, which is not the
// same as how often it answers. The business's own site is its own statement
// about itself. News is last among real sources: it is where the Adweek editor
// came from, named in an article that merely mentioned the bakery.
const SOURCE_ORDER = ['site', 'chamber', 'facebook', 'registry', 'linkedin', 'maps', 'news', 'instagram', 'hunter'];
const SOURCE_RANK = {};
SOURCE_ORDER.forEach((s, i) => { SOURCE_RANK[s] = i; });

// TWO VOCABULARIES REACH THIS FILE. The contact fan-out in ai.js tags rows with
// the lane that found them ('site', 'chamber', 'news', ...). contactDiscovery.js
// writes brand_contacts.source from a different list entirely
// ('company_website', 'public_record', 'web_search', 'ai_inference',
// 'published', 'shared'). Mapping them onto one scale is not cosmetic: without
// it every contact on the AI Outreach path has an unrecognised source, counts as
// uncorroborated, and loses its first-name greeting.
const SOURCE_ALIASES = {
  company_website: 'site',
  website: 'site',
  public_record: 'registry',
  // 'published' and 'shared' describe where the EMAIL came from, not how we know
  // who the person is, so they map to nothing and are treated as unknown
  // provenance rather than as weak provenance.
};
function normalizeSource(source) {
  const s = String(source || '').toLowerCase().trim();
  if (!s) return null;
  return SOURCE_ALIASES[s] || (SOURCE_RANK[s] !== undefined ? s : null);
}
function sourceRankOf(source) {
  const s = normalizeSource(source);
  return s === null ? SOURCE_ORDER.length : SOURCE_RANK[s];
}
// Did a source we RECOGNISE name this person? Distinguishes "we know it was a
// news article" from "we have no idea", which need different treatment.
function hasKnownProvenance(c) {
  if (!c) return false;
  const list = Array.isArray(c.sources) && c.sources.length ? c.sources : (c.source ? [c.source] : []);
  return list.some((s) => normalizeSource(s) !== null);
}

// The business's own site, naming a real role, with no hedge. A single source,
// but the single source that is the business itself -- treating that as
// "uncorroborated" would mark almost every correct answer we have as unsure.
function isSelfAttested(c) {
  if (!c) return false;
  const list = Array.isArray(c.sources) && c.sources.length ? c.sources : (c.source ? [c.source] : []);
  return list.some((s) => normalizeSource(s) === 'site')
    && hedgeOf(c.title) === HEDGE.NONE
    && authorityOf(c.title).rank <= RANK.MANAGER;
}

// How many DISTINCT sources named this person. _mergeContacts collects them.
function corroborationOf(c) {
  if (!c) return 0;
  if (Array.isArray(c.sources) && c.sources.length) return new Set(c.sources.map((s) => String(s).toLowerCase())).size;
  return c.source ? 1 : 0;
}

// ── UNCONFIRMED ──────────────────────────────────────────────────────────────
// One third-party source naming a person is a lead, not a fact. Marked here and
// honoured by greetingGuard, which drops to "Hi," rather than opening a pitch
// with a first name we cannot stand behind. This is deliberately NOT a reason to
// drop the contact: the name is still useful on a call ("ask for Mandy"), it is
// just not something to assert in writing.
// IT ONLY FIRES ON POSITIVE EVIDENCE OF WEAKNESS. The tempting version -- "not
// corroborated means unconfirmed" -- marks every contact whose provenance we
// cannot read, which is every contact on the AI Outreach path, because
// contactDiscovery's source vocabulary does not overlap the fan-out's. That
// silently removes the first name from every pitch in the product, which is a
// worse failure than the one being fixed and would have looked like a feature.
//
// So: a placeholder title, a hedged title, or a KNOWN third-party source with
// nothing else agreeing is unconfirmed. Provenance we cannot assess falls through
// to the checks greetingGuard already made -- role title, affiliation scope,
// emailKind, confidence score -- rather than adding a blanket refusal on top.
function isUnconfirmed(c) {
  if (!c) return true;
  const a = authorityOf(c.title);
  if (a.rank >= RANK.PLACEHOLDER) return true;      // placeholder, landlord, ex-owner
  if (corroborationOf(c) >= 2) return false;        // two sources agree: confirmed
  if (isSelfAttested(c)) return false;              // the business's own site
  // The title hedges itself. "Owner (per news)" is a report about an owner, not
  // a statement by the business, and it is what put an Adweek editor at the top
  // of a bakery's ladder.
  if (hedgeOf(c.title) !== HEDGE.NONE) return true;
  // A single source we recognise as third-party.
  return hasKnownProvenance(c);
}

// ── THE COMPARATOR ───────────────────────────────────────────────────────────
// A TOTAL ORDER. Every step is derived from the contact's own fields; none of it
// depends on which network call returned first. The final step is a stable
// alphabetical tie-break, so even two identical-looking candidates resolve the
// same way on every run rather than by arrival.
function compareContacts(a, b) {
  const ra = authorityOf(a && a.title).rank;
  const rb = authorityOf(b && b.title).rank;
  if (ra !== rb) return ra - rb;

  const ha = hedgeOf(a && a.title);
  const hb = hedgeOf(b && b.title);
  if (ha !== hb) return ha - hb;

  // More sources agreeing wins, among claims of equal strength.
  const ca = corroborationOf(a);
  const cb = corroborationOf(b);
  if (ca !== cb) return cb - ca;

  const sa = sourceRankOf(a && a.source);
  const sb = sourceRankOf(b && b.source);
  if (sa !== sb) return sa - sb;

  // A full name beats a bare first name ("Carole Griffin" over "Carole"), which
  // is nearly always the same person reported twice with different completeness.
  const wa = String((a && a.name) || '').trim().split(/\s+/).length;
  const wb = String((b && b.name) || '').trim().split(/\s+/).length;
  if (wa !== wb) return wb - wa;

  // THE DECISIVE STEP. Never returns 0 for different people, so sort stability
  // -- and therefore arrival order -- can never decide the winner.
  return String((a && a.name) || '').localeCompare(String((b && b.name) || ''));
}

// Sort a list into the canonical order. Copies rather than sorting in place so a
// caller's array order is never load-bearing.
function rankContacts(contacts) {
  return (Array.isArray(contacts) ? contacts.slice() : []).sort(compareContacts);
}

// Everything a card or a log line needs to explain the choice.
function explain(c) {
  const a = authorityOf(c && c.title);
  return {
    rank: a.rank, why: a.why,
    hedge: hedgeOf(c && c.title),
    corroboration: corroborationOf(c),
    sources: (c && c.sources) || (c && c.source ? [c.source] : []),
    selfAttested: isSelfAttested(c),
    unconfirmed: isUnconfirmed(c),
  };
}

module.exports = {
  RANK, HEDGE, SOURCE_ORDER,
  authorityOf, hedgeOf, sourceRankOf, normalizeSource, hasKnownProvenance, corroborationOf,
  isSelfAttested, isUnconfirmed, compareContacts, rankContacts, explain,
};
