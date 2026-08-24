'use strict';
// FIND THE BUSINESS'S OWN DOMAIN WHEN THE ONES WE WERE HANDED ARE WRONG.
//
// The domain gate stops us using another company's website. It does not find the
// right one, and "no website" is expensive: it removes the site-email scrape, the
// Instagram scrape and Hunter all at once, which for a small local business is
// most of the ways to reach anybody. Dropping a wrong domain and stopping there
// trades a wrong answer for no answer.
//
// So on a total miss -- every candidate rejected -- ask for the domain directly,
// and put the answer through THE SAME GATE. That last part is the whole design.
// A model asked for a business's website will happily return the nearest
// same-trade business it can find, which is precisely the failure that started
// this: Post Office Pies -> davenportspizza.com is exactly the shape of answer a
// search returns. An unchecked search result is not better evidence than an
// unchecked Places result, it is the same evidence from a different source.
//
// TWO SOURCES OF CANDIDATE, ONE STANDARD.
//   1. The domain the model states.
//   2. Every web-search CITATION url, because the pages the search actually
//      opened are evidence the model's stated answer is not. A citation is often
//      the business's own site even when the model's summary names something else.
// Both go through checkDomain. Neither is trusted for being a search result.
//
// COST. One web search per business, only when nothing passed, cached 30 days on
// the same terms as every other lane -- so this tracks NEW businesses, not scans.
// It is skipped entirely on the cheap card path, where no website is consumed.

const store = require('../store');
const { checkDomain } = require('./domainGate');
const { canonicalRegion } = require('./regionKey');

const CACHE_DAYS = 30;
const CACHE_V = 'v1';
const LANE = 'domain';
const MAX_CANDIDATES = 8;

const SYS = 'You identify the official website of one specific local business using web search. '
  + 'You report only what the pages you opened actually show. You never guess a domain from the '
  + 'business name, and you never substitute a different business.';

function _prompt(brand, where, address) {
  return `Find the official website of this exact business.

Business: "${brand}"${where ? `\nCity/area: ${where}` : ''}${address ? `\nStreet address: ${address}` : ''}

Return ONLY this JSON, nothing else:
{"website": "https://example.com", "why": "one short sentence naming the page that showed it"}

RULES, and a wrong answer here is worse than no answer:
- It must be THIS business's OWN website${address ? ', the one at that street address' : ''}.
- NOT a directory, listing or review site (Yelp, TripAdvisor, MapQuest, Chamber pages).
- NOT a social or storefront platform (Facebook, Instagram, Linktree, Square, Toast, DoorDash).
- NOT a business with a similar name in another city.
- NOT a different business in the same line of work, however close by.
- If you cannot find this business's own website, return {"website": null}. Returning null is
  the correct answer when you are unsure. Do not construct a domain from the name.`;
}

function _extractUrl(text) {
  const t = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b > a) {
    try {
      const o = JSON.parse(t.slice(a, b + 1));
      if (o && typeof o.website === 'string' && o.website.trim()) return o.website.trim();
    } catch (_) { /* fall through */ }
  }
  const m = t.match(/https?:\/\/[^\s"'<>)]+/);
  return m ? m[0] : null;
}

// { website, matchedOn, reason, tried, searches, cached }
// website is null when nothing survived the gate. tried lists every candidate and
// what the gate said about it, so a miss is diagnosable without a re-run.
async function resolveDomain(brand, opts = {}) {
  const name = String(brand || '').trim();
  if (!name) return { website: null, matchedOn: null, reason: 'no brand name', tried: [], searches: 0 };
  const where = String(opts.city || opts.region || '').trim();
  const address = String(opts.address || '').trim();

  const cacheKey = `dom:${name.toLowerCase()} | ${canonicalRegion(where) || '-'} | ${CACHE_V}`;
  if (!opts.force) {
    try {
      const c = await store.getBrandEvidence(cacheKey, LANE, CACHE_DAYS);
      if (c && c.evidence && c.evidence.v === CACHE_V) {
        return { ...c.evidence, cached: true, searches: 0 };
      }
    } catch (_) { /* a cache miss is not a failure */ }
  }

  const webSearch = opts.webSearch;
  if (typeof webSearch !== 'function') {
    return { website: null, matchedOn: null, reason: 'no web search available', tried: [], searches: 0 };
  }

  let text = '', citations = [], searches = 0;
  try {
    const r = await webSearch(_prompt(name, where, address), SYS);
    text = (r && r.text) || '';
    citations = (r && Array.isArray(r.citations)) ? r.citations : [];
    searches = (r && r.searches) || 0;
  } catch (e) {
    // NOT cached. A failed search is a failed search, not a finding that this
    // business has no website -- caching it would make one outage look like a
    // permanent absence for thirty days.
    console.warn(`[domain-resolve] brand="${name}" search failed: ${e.message}`);
    return { website: null, matchedOn: null, reason: 'search failed: ' + e.message, tried: [], searches: 0 };
  }

  // Model's answer first, then the pages the search actually opened.
  const stated = _extractUrl(text);
  const candidates = [];
  const seenRoot = new Set();
  for (const u of [stated].concat(citations)) {
    if (!u || candidates.length >= MAX_CANDIDATES) continue;
    const k = String(u).trim().toLowerCase();
    if (!k || seenRoot.has(k)) continue;
    seenRoot.add(k);
    candidates.push(u);
  }

  const tried = [];
  let picked = null, matchedOn = null;
  for (const u of candidates) {
    const v = checkDomain(name, u);
    tried.push({ url: u, ok: v.ok, code: v.code, from: u === stated ? 'stated' : 'citation' });
    if (v.ok && !picked) { picked = u; matchedOn = v.matchedOn; }
  }

  const out = {
    v: CACHE_V,
    website: picked,
    matchedOn,
    reason: picked ? null
      : (candidates.length
        ? `the search returned ${candidates.length} address(es), none carrying this business's name`
        : 'the search returned no website'),
    tried: tried.slice(0, MAX_CANDIDATES),
    statedByModel: stated || null,
  };

  try {
    await store.saveBrandEvidence(cacheKey, LANE, name, picked, out, picked ? 'OK' : 'NONE');
  } catch (_) { /* caching is best-effort */ }

  console.log(`[domain-resolve] brand="${name}" ${picked ? `RESOLVED ${picked} (matched "${matchedOn}")`
    : `no domain: ${out.reason}`} candidates=${candidates.length} searches=${searches}`);
  return { ...out, cached: false, searches };
}

module.exports = { resolveDomain, _extractUrl, _prompt };
