'use strict';
// ── THE BUSINESS'S OWN FACEBOOK PAGE: THE WEBSITE AND EMAIL IT LISTS ────────
//
// The email finder's last stop before "no website" (services/emailFinder,
// findWebsite). A small business with no site Google can match often keeps a
// Facebook page whose Intro lists its website, an email, or both. Facebook
// does not let a server read the page, so this asks a web search to find the
// page and report what its Intro shows -- and nothing it shows is trusted for
// being on Facebook: the website still goes through the domain gate, and any
// address is verified before it is used.
//
// One search per business, cached 30 days (lane 'facebook'), "none found"
// included when the search completed, so the spend tracks new businesses.

const store = require('../store');
const { canonicalRegion } = require('./regionKey');

const LANE = 'facebook';
const CACHE_DAYS = 30;
const V = 'v1';

const SYS = 'You find the official Facebook page of one specific local business using web search, '
  + 'and report only what that page shows. You never guess, and you never substitute a different business.';

function prompt(brand, where) {
  return `Find the official Facebook page of this exact business, and what its Intro / About section lists.

Business: "${brand}"${where ? `\nCity/area: ${where}` : ''}

Return ONLY this JSON:
{"facebookUrl": "https://www.facebook.com/...", "website": "https://..." or null, "email": "..." or null, "why": "one short sentence"}

RULES:
- The page must be THIS business's own page, in this city. Not a fan page, a different location, or a similar name.
- website and email: only what the page itself lists. If the page lists none, null.
- If you cannot find this business's own page, return {"facebookUrl": null}.`;
}

function parse(text) {
  const t = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { return null; }
}

// What came back, checked: a facebook.com page, a website that is not another
// social or listing page, an address that looks like one.
function clean(o) {
  const out = { facebookUrl: null, website: null, email: null, why: null };
  if (!o || typeof o !== 'object') return out;
  const fb = typeof o.facebookUrl === 'string' ? o.facebookUrl.trim() : '';
  if (/^https?:\/\/(www\.|m\.|web\.)?(facebook|fb)\.com\/[^\s]+$/i.test(fb)) out.facebookUrl = fb;
  if (!out.facebookUrl) return out;
  const w = typeof o.website === 'string' ? o.website.trim() : '';
  if (w && /^(https?:\/\/)?[^\s/]+\.[a-z]{2,}/i.test(w) && !/(facebook|fb|instagram|linktr\.ee|yelp|google)\./i.test(w)) {
    out.website = /^https?:\/\//i.test(w) ? w : 'https://' + w;
  }
  const e = typeof o.email === 'string' ? o.email.trim().toLowerCase().replace(/^mailto:/, '') : '';
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)) out.email = e;
  out.why = typeof o.why === 'string' ? o.why.slice(0, 200) : null;
  return out;
}

// -> { facebookUrl, website, email, why, cached, searches }
async function findFacebookPage(brand, opts = {}) {
  const name = String(brand || '').trim();
  if (!name) return { facebookUrl: null, website: null, email: null, searches: 0 };
  const where = String(opts.city || '').trim();
  const key = `fb:${name.toLowerCase()} | ${canonicalRegion(where) || '-'} | ${V}`;
  if (!opts.force) {
    try {
      const c = await store.getBrandEvidence(key, LANE, CACHE_DAYS);
      if (c && c.evidence && c.evidence.v === V) return { ...c.evidence, cached: true, searches: 0 };
    } catch (_) { /* a cache miss is not a failure */ }
  }
  if (typeof opts.webSearch !== 'function') return { facebookUrl: null, website: null, email: null, searches: 0, why: 'no web search available' };
  let r;
  try { r = await opts.webSearch(prompt(name, where), SYS); }
  catch (e) {
    // Not cached: a failed search says nothing about the business.
    return { facebookUrl: null, website: null, email: null, searches: 0, why: 'search failed: ' + e.message };
  }
  const got = clean(parse(r && r.text));
  const out = { v: V, ...got };
  try {
    await store.saveBrandEvidence(key, LANE, name, got.website, out, got.facebookUrl ? 'OK' : 'NONE',
      { confirmed: !!String((r && r.text) || '').trim() });
  } catch (_) { /* best effort */ }
  return { ...out, cached: false, searches: (r && r.searches) || 1 };
}

module.exports = { findFacebookPage, clean, parse, prompt, LANE };
