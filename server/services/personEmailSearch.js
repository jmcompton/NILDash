'use strict';
// STEP 3 OF THE ADDRESS LADDER: LOOK FOR ONE NAMED PERSON'S ADDRESS.
//
// Runs only when the site scrape and Hunter have both failed, and only for a
// person some other source ALREADY NAMED. It never produces a name. That
// restriction is the whole safety story: a search for "who works at X and what is
// their email" invents plausible people with plausible addresses, and an athlete
// then emails a stranger by first name. A search for "does Dave Horn at Post
// Office Pies have a published address" can only be wrong about the address.
//
// AND IT MUST BE PUBLISHED, NOT CONSTRUCTED. A model asked for someone's work
// email will pattern it from the domain -- dave@postofficepies.com is a very good
// guess and often wrong, and a bounced first send is worse than no send. So an
// address is accepted only when the model returns a citation URL alongside it and
// says it read it there. Anything it "inferred", "typically", "likely" or
// "standard format" is discarded.
//
// CAPPED. Two searches per business, hard, counted by the caller and enforced
// here as well. Cached 30 days per person+business so a re-scan is free.

const store = require('../store');

const CACHE_DAYS = 30;
const CACHE_V = 'v1';
const LANE = 'personemail';
const DEFAULT_MAX = 2;

const SYS = 'You look for ONE named person\'s published work email address using web search. '
  + 'You report only an address you can see on a page you opened. You never construct, infer, '
  + 'guess or pattern an address from a domain. Returning null is a correct and expected answer.';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
// The words a model uses when it is about to hand over a guess.
const HEDGE_RE = /\b(infer|inferred|likely|typical|typically|standard format|common format|probably|presum|construct|pattern|guess|assum)/i;

function _prompt(person, brand, where, domain) {
  return `Find the PUBLISHED work email address of this specific person.

Person: ${person}
Business: "${brand}"${where ? `\nCity/area: ${where}` : ''}${domain ? `\nBusiness domain: ${domain}` : ''}

Return ONLY this JSON:
{"email": "someone@example.com", "sourceUrl": "https://the-page-you-read-it-on", "published": true}

RULES:
- The address must appear, in full, on a page you actually opened. Give that page as sourceUrl.
- Do NOT construct one from the domain. "first@domain" and "first.last@domain" are guesses even
  when they look obvious, and a guess that bounces is worse than no address.
- If you only found the business's general inbox and not this person's, return {"email": null}.
- If you cannot find a published address for this person, return {"email": null}. That is the
  right answer and is expected most of the time.`;
}

function _parse(text) {
  const t = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    const o = JSON.parse(t.slice(a, b + 1));
    if (!o || typeof o.email !== 'string') return null;
    return { email: o.email.trim(), sourceUrl: (o.sourceUrl || '').trim(), published: o.published !== false };
  } catch (_) { return null; }
}

// Accept only a published address on a domain we can tie to a citation.
// { email, sourceUrl } or null, plus why it was refused.
function _screen(parsed, rawText, citations) {
  if (!parsed || !parsed.email || !EMAIL_RE.test(parsed.email)) {
    return { email: null, why: 'no address returned' };
  }
  if (!parsed.published) return { email: null, why: 'the model marked it unpublished' };
  if (HEDGE_RE.test(rawText)) {
    return { email: null, why: 'the answer hedged, so the address was constructed rather than read' };
  }
  const cites = Array.isArray(citations) ? citations : [];
  const src = parsed.sourceUrl && /^https?:\/\//i.test(parsed.sourceUrl) ? parsed.sourceUrl : null;
  // The cited page must be one the search actually opened. A sourceUrl the model
  // wrote but never visited vouches for nothing.
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return null; } };
  const srcHost = src && host(src);
  const opened = srcHost && cites.some((c) => host(c) === srcHost);
  if (!opened) return { email: null, why: 'no web-search citation backs the page it claims to have read' };
  return { email: parsed.email.toLowerCase(), sourceUrl: src, why: null };
}

// opts: { brand, where, domain, webSearch, budget, force }
// budget: { left: n } -- decremented here, so the cap holds across callers.
// { email, sourceUrl, searches, why, cached }
async function findPersonEmail(person, opts = {}) {
  const name = String(person || '').trim();
  const brand = String(opts.brand || '').trim();
  if (!name || !brand) return { email: null, searches: 0, why: 'no person or business' };

  const cacheKey = `pe:${name.toLowerCase()} @ ${brand.toLowerCase()} | ${CACHE_V}`;
  if (!opts.force) {
    try {
      const c = await store.getBrandEvidence(cacheKey, LANE, CACHE_DAYS);
      if (c && c.evidence && c.evidence.v === CACHE_V) return { ...c.evidence, cached: true, searches: 0 };
    } catch (_) { /* a cache miss is not a failure */ }
  }

  const budget = opts.budget;
  if (budget && !(budget.left > 0)) {
    return { email: null, searches: 0, why: 'search budget for this business is spent' };
  }
  if (typeof opts.webSearch !== 'function') {
    return { email: null, searches: 0, why: 'no web search available' };
  }

  let text = '', citations = [], searches = 0;
  try {
    if (budget) budget.left -= 1;                 // spent on the ATTEMPT, not the hit
    const r = await opts.webSearch(_prompt(name, brand, opts.where, opts.domain), SYS);
    text = (r && r.text) || '';
    citations = (r && Array.isArray(r.citations)) ? r.citations : [];
    searches = (r && r.searches) || 0;
  } catch (e) {
    // Not cached: a failed search is not evidence this person has no address.
    console.warn(`[person-email] "${name}" @ ${brand} search failed: ${e.message}`);
    return { email: null, searches: 0, why: 'search failed: ' + e.message };
  }

  const screened = _screen(_parse(text), text, citations);
  const out = { v: CACHE_V, email: screened.email || null, sourceUrl: screened.sourceUrl || null, why: screened.why };
  try {
    await store.saveBrandEvidence(cacheKey, LANE, brand, opts.domain || null, out, out.email ? 'OK' : 'NONE');
  } catch (_) { /* best effort */ }

  console.log(`[person-email] "${name}" @ ${brand} ${out.email ? 'FOUND ' + out.email : 'none: ' + out.why} searches=${searches}`);
  return { ...out, cached: false, searches };
}

module.exports = { findPersonEmail, DEFAULT_MAX, _parse, _screen, _prompt };
