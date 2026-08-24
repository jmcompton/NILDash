'use strict';
// DOES THIS DOMAIN BELONG TO THIS BUSINESS? A GATE, NOT A METRIC.
//
// A Birmingham market run resolved Post Office Pies to davenportspizza.com,
// Homewood Cycle & Fitness to cahabacycles.com and to three15studio.com, Onyx
// Coffee Lab to daysolcoffeelab.co, and Millennium Chiropractic to
// pillarchiropractic.com. Every one of those is a real business. None of them is
// the business we asked about.
//
// Nothing on the live path was checking. websiteValidation.js compares the brand
// to the NAME Places returned, never to the domain, and its only caller is an
// admin audit route. siteEmail's domainMatchesBusiness does compare brand to
// domain, but its only callers are the coverage report, and its own comment says
// it deliberately undercounts. Both are reports. This is the gate.
//
// WHY A WRONG DOMAIN IS EXPENSIVE. getBrandContacts hands the website to four
// consumers that all treat it as the business's own: the Instagram scrape, the
// contact fan-out (which writes the domain into the model's prompt as fact), the
// site-email scrape, and Hunter -- which spends a paid credit on it. Downstream,
// contactLadder checks every address against that domain, so a wrong website
// inverts the cross-domain warning: the business's real address gets flagged as
// suspect and the other company's address is presented as its own.
//
// THE RULE: A POSITIVE MATCH, NOT THE ABSENCE OF A MISMATCH.
// The old report asked "do the name and the domain share nothing at all?", which
// passes anything with one word in common. This asks the opposite question -- is
// there a DISTINCTIVE word of the business name in this domain -- and a word that
// names the trade rather than the business is not distinctive. That single change
// is what separates "Onyx Coffee Lab" from "daysolcoffeelab": both are coffee
// labs, only one is Onyx.
//
// WHAT IT DOES NOT DO. It cannot catch a wrong domain that happens to contain the
// right distinctive word (Barstool Athletics -> barstoolsports.com), and it does
// not fetch the page to confirm anything. It is string work over data already in
// hand: free, instant, and safe to run on every lookup.

const { rootDomain, nameTokens, collapsedOverlapOk } = require('./siteEmail');
const {
  hostOf, hostMatches, SOCIAL_HOSTS, PLATFORM_HOSTS, DIRECTORY_HOSTS,
} = require('./websiteValidation');

// Words that carry no identity, so they cannot contribute the initial of an
// acronym either. Kept tiny and purely grammatical.
const GRAMMAR = new Set(['the', 'of', 'and', 'for', 'at', 'in', 'on', 'to', 'a', 'an']);

const _collapse = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Verdict codes, so a log line and a card note can be counted and told apart.
//   ok                     a distinctive word of the name is in the domain
//   no-domain              not a resolvable URL
//   third-party-host       a Facebook page, a Linktree, a Yelp listing, a Square
//                          storefront: real, but not a domain belonging to this
//                          business, and not something to scrape or buy against
//   no-distinctive-word    the business name is entirely trade and generic words,
//                          so nothing in it can confirm any domain
//   name-absent            no distinctive word of the name appears in the domain
//                          -- the Birmingham class
const CODES = ['ok', 'no-domain', 'third-party-host', 'no-distinctive-word', 'name-absent'];

// { ok, code, reason, matchedOn, root }
function checkDomain(brand, website) {
  const root = rootDomain(website);
  if (!root) {
    return { ok: false, code: 'no-domain', root: null, matchedOn: null,
      reason: 'not a resolvable web address' };
  }
  const host = hostOf(website);
  const label = root.split('.')[0];
  const flat = label.replace(/[^a-z0-9]/g, '');
  const name = String(brand || '').trim();

  // THIRD-PARTY HOSTS FIRST, so a coincidence cannot buy a pass. "Square Deal
  // Auto" on square.site shares the word "square" with Square's own domain; that
  // is a storefront on someone else's platform, not this business's domain. The
  // same reasoning covers a Facebook page and a Yelp listing. The business is
  // real and reachable -- the ladder still runs -- but there is nothing here to
  // scrape for an address and nothing worth a Hunter credit.
  if (hostMatches(root, host, SOCIAL_HOSTS) || hostMatches(root, host, PLATFORM_HOSTS)) {
    return { ok: false, code: 'third-party-host', root, matchedOn: null,
      reason: `${root} is a social or storefront platform, not this business's own domain` };
  }
  if (hostMatches(root, host, DIRECTORY_HOSTS)) {
    return { ok: false, code: 'third-party-host', root, matchedOn: null,
      reason: `${root} is a directory or listing site, not this business's own domain` };
  }

  const toks = nameTokens(brand);
  const collapsed = _collapse(brand);

  // NO DISTINCTIVE WORD AT ALL. "Cycle Therapy", "The Coffee Shop" -- every word
  // names the trade. There is no positive match available, so the only thing that
  // can confirm a domain is the WHOLE name, which is far stronger evidence than
  // any single trade word: "cycletherapy.com" yes, "cahabacycles.com" no.
  if (!toks.length) {
    if (collapsedOverlapOk(collapsed, flat)) {
      return { ok: true, code: 'ok', root, matchedOn: collapsed + ' (whole name)', reason: null };
    }
    return { ok: false, code: 'no-distinctive-word', root, matchedOn: null,
      reason: `"${name}" is made only of trade and generic words, so nothing in the name can `
        + `confirm ${root} belongs to it` };
  }

  // THE MAIN TEST. A distinctive word of the name, inside the domain label.
  const hit = toks.find((t) => flat.includes(t));
  if (hit) return { ok: true, code: 'ok', root, matchedOn: hit, reason: null };

  // ACRONYM. "David Protein Bar" -> dpb.com. Built from every word that is not
  // pure grammar, because a real acronym includes the trade word -- but at least
  // one DISTINCTIVE word must contribute a letter, or "The Coffee Shop" -> tcs
  // would pass on nothing. Anchored to the start of the label rather than merely
  // contained in it: a three-letter run inside a long domain is a coincidence,
  // not a name.
  const acrWords = String(brand || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter((w) => w.length >= 2 && !GRAMMAR.has(w));
  const acr = acrWords.map((w) => w[0]).join('');
  const acrHasDistinctive = acrWords.some((w) => toks.includes(w));
  if (acr.length >= 3 && acrHasDistinctive && (flat === acr || flat.startsWith(acr))) {
    return { ok: true, code: 'ok', root, matchedOn: acr + ' (acronym)', reason: null };
  }

  return {
    ok: false, code: 'name-absent', root, matchedOn: null,
    reason: `no distinctive word of "${name}" (${toks.join(', ')}) appears in ${root}`,
  };
}

// Pick the first candidate URL that passes, and report the ones that did not.
// getBrandContacts has two candidates -- the caller's stored website and the one
// Places returned -- and used to take the caller's without looking at the other.
// A rejected first candidate is no longer the end of the road.
// Returns { website, dropped } where dropped is null or { url, code, reason }.
function pickWebsite(brand, candidates) {
  const seen = new Set();
  let firstDrop = null;
  const drops = [];
  for (const c of (candidates || [])) {
    if (!c) continue;
    const k = String(c).trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const v = checkDomain(brand, c);
    if (v.ok) return { website: c, dropped: null, matchedOn: v.matchedOn, drops };
    const d = { url: c, code: v.code, reason: v.reason };
    drops.push(d);
    if (!firstDrop) firstDrop = d;
  }
  return { website: null, dropped: firstDrop, matchedOn: null, drops };
}

// The agent-facing sentence lives in contactLadder._droppedNote, not here.
// That module is pure and must not require this one: domainGate reaches
// siteEmail, which opens a pg pool, and a card renderer has no business holding
// a database connection. One copy of the wording, on the side that renders it.

module.exports = { checkDomain, pickWebsite, CODES, GRAMMAR };
