// THE HANDLE HAS TO BELONG TO THIS BUSINESS.
//
// This used to be one fetch of the homepage and a regex that took the FIRST
// instagram.com link in the HTML, with no check that it was the business's own.
// A footer crediting the web designer returned the designer's account, and an
// athlete DMs a stranger under their own name. It also missed ~40% of local
// businesses: no site at all, a JS-rendered footer, or a bot-blocked fetch.
//
// Two paths now, and both answer to the same two rules.
//
//   1. SCRAPE the homepage, as before, but walk EVERY instagram link and take the
//      first that passes the ownership test rather than the first that exists.
//   2. Only on a MISS, ask the web-search source. A hit on the scrape costs
//      nothing extra, which is the whole point of the ordering.
//
// THE CITATION RULE, for anything the search returns. A model asked for an
// Instagram handle will happily construct one from the business name; @sawsbbq is
// a very good guess and sometimes wrong. So a searched handle is accepted ONLY
// when a web-search citation URL is literally instagram.com/<handle> and the path
// segment equals the handle the model returned. No citation, discard, whatever it
// claims. The same rule gates the bio-derived owner name and booking email: the
// profile citation is what vouches for them.
//
// THE ENTITY RULES, for both paths:
//   no token overlap with the business name          -> DROP. Millennium
//        Chiropractic returned @manaclinics, a 28-clinic network.
//   overlap, but the business name carries a place
//   the handle does not                              -> KEEP, scope 'brand'.
//        Rally House Fayetteville returned @rally_house, the national account with
//        135k followers. That is a real channel, it is just not the store, so it
//        is labelled rather than thrown away.
//   overlap, no place qualifier                      -> KEEP, scope 'business'.
//
// Returns null, or { handle, scope, source, ownerName, bookingEmail, evidenceKind }.
// NEVER guesses a handle.
const store = require('../store');
const TIMEOUT_MS = 8000;
const SEARCH_TIMEOUT_MS = parseInt(process.env.IG_SEARCH_TIMEOUT_MS, 10) || 15000;
const CACHE_DAYS = 30;
// Bumped when the cached SHAPE or the rules change. v1 rows are a bare handle
// chosen with no ownership test at all, so serving one would keep handing back the
// web designer's account -- and the parent network's -- for another 30 days.
const CACHE_V = 'v2';
const BAD = new Set(['p','reel','reels','explore','tv','stories','accounts','about','developer','directory','legal','privacy','safety','help','sitemap','www']);
const HANDLE_RE = /instagram\.com\/(?:#!\/)?@?([A-Za-z0-9._]{2,30})/gi;

function _cacheKey(domain) { return domain + ' | ' + CACHE_V; }

// ── ownership ────────────────────────────────────────────────────────────────
function _squash(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function _tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
}

// Does this handle plausibly name this business? Compared squashed, because a
// handle drops the spaces and punctuation a name has: "Saw's BBQ" -> sawsbbq.
function _overlaps(handle, brand) {
  const h = _squash(handle);
  const b = _squash(brand);
  if (!h || !b) return false;
  if (b.indexOf(h) !== -1 || h.indexOf(b) !== -1) return true;
  return _tokens(brand).filter((t) => t.length >= 4).some((t) => h.indexOf(t) !== -1);
}

// Is this a STORE of a brand? "Rally House Fayetteville" carries a place that
// "rally_house" does not, so the handle is the brand's, not this location's.
function _hasPlaceQualifier(handle, brand, loc) {
  const places = _tokens(String(loc || '').split(',')[0]).filter((t) => t.length >= 4);
  if (!places.length) return false;
  const b = _squash(brand);
  const h = _squash(handle);
  return places.some((p) => b.indexOf(p) !== -1 && h.indexOf(p) === -1);
}

// 'business' | 'brand' | 'reject'. Without a brand there is nothing to check
// against, so the handle is taken as-is exactly as it was before this change.
function handleVerdict(handle, brand, loc) {
  if (!handle) return 'reject';
  if (!brand) return 'business';
  if (!_overlaps(handle, brand)) return 'reject';
  return _hasPlaceQualifier(handle, brand, loc) ? 'brand' : 'business';
}

// ── the scrape ───────────────────────────────────────────────────────────────
// Walks EVERY link rather than stopping at the first. The old version returned
// whichever account happened to appear earliest in the document.
function _extractHandle(html, brand, loc) {
  if (!html) return null;
  HANDLE_RE.lastIndex = 0;
  let m, firstRejected = null;
  while ((m = HANDLE_RE.exec(html)) !== null) {
    const h = m[1].replace(/\/+$/, '').toLowerCase();
    if (!h || BAD.has(h)) continue;
    const verdict = handleVerdict(h, brand, loc);
    if (verdict === 'reject') { firstRejected = firstRejected || h; continue; }
    return { handle: h, scope: verdict };
  }
  if (firstRejected) console.log('[instagram] rejected on-site handle=' + firstRejected + ' brand="' + brand + '" (not this business)');
  return null;
}

// ── the search ───────────────────────────────────────────────────────────────
function _citedHandle(handle, citations) {
  const h = String(handle || '').replace(/^@/, '').toLowerCase();
  if (!h) return false;
  for (const u of (Array.isArray(citations) ? citations : [])) {
    const re = /instagram\.com\/(?:#!\/)?@?([A-Za-z0-9._]{2,30})/gi;
    let c;
    while ((c = re.exec(String(u || ''))) !== null) {
      const seg = c[1].replace(/\/+$/, '').toLowerCase();
      if (BAD.has(seg)) continue;         // instagram.com/p/<id> is a post, not a profile
      if (seg === h) return true;
    }
  }
  return false;
}

const _SEARCH_SYS = 'You find the official Instagram account of a specific local business using web search, '
  + 'and report ONLY what the search results actually show. Never construct a handle from the business name.';

function _searchPrompt(brand, loc) {
  return `Find the official Instagram account of "${brand}"${loc ? ` in ${loc}` : ''} using web search `
    + `(query "${brand} ${loc || ''} instagram").\n`
    + `Respond with ONLY a single JSON object and nothing else:\n`
    + `{"handle":"theirhandle","ownerName":null,"bookingEmail":null,"bioText":null}\n`
    + `Rules:\n`
    + `- handle is the account name WITHOUT the @, and ONLY if a search result is actually an instagram.com profile URL for it. If your search did not surface a real profile URL, return {"handle":null}.\n`
    + `- NEVER build a handle out of the business name. A plausible guess is worse than nothing here, because a message sent to a wrong account goes to a stranger.\n`
    + `- Do NOT return the account of a parent company, franchisor, clinic network or national brand unless that is genuinely all that exists; if you do, still return it and it will be labelled.\n`
    + `- ownerName: a person named as the owner in the profile bio, if the bio text appears in your search results. Else null. Never a guess.\n`
    + `- bookingEmail: an email address written in the bio, if the bio text appears. Else null.\n`
    + `- bioText: the bio text exactly as it appeared in the search result, else null.`;
}

async function _searchForHandle(brand, loc, webSearch) {
  let raw = null;
  try {
    raw = await Promise.race([
      webSearch(_searchPrompt(brand, loc), _SEARCH_SYS),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ig-search-timeout')), SEARCH_TIMEOUT_MS)),
    ]);
  } catch (e) {
    console.warn('[instagram] search failed brand="' + brand + '" error=' + (e && e.message));
    return null;
  }
  const text = (raw && raw.text) || '';
  const citations = (raw && raw.citations) || [];
  let obj = null;
  try {
    const t = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const i = t.indexOf('{'), j = t.lastIndexOf('}');
    if (i !== -1 && j > i) obj = JSON.parse(t.slice(i, j + 1));
  } catch (_) { obj = null; }
  if (!obj || !obj.handle) return null;

  const handle = String(obj.handle).replace(/^@/, '').replace(/\/+$/, '').toLowerCase();
  if (!handle || BAD.has(handle)) return null;

  // THE RULE. A handle the search did not actually surface as a profile URL is a
  // guess, however confident the sentence around it sounded.
  if (!_citedHandle(handle, citations)) {
    console.log('[instagram] search brand="' + brand + '" DISCARDED uncited handle=' + handle);
    return null;
  }
  return {
    handle,
    // Bio fields ride on the same citation: the profile URL is what vouches for
    // them. They are never presented as published on the business website.
    ownerName: (obj.ownerName && String(obj.ownerName).trim()) || null,
    bookingEmail: (obj.bookingEmail && String(obj.bookingEmail).trim()) || null,
    bioText: (obj.bioText && String(obj.bioText).trim()) || null,
  };
}

// ── entry point ──────────────────────────────────────────────────────────────
// opts: { brand, loc, webSearch }. webSearch(prompt, system) -> { text, citations }.
// Without brand+webSearch the search half is simply skipped, so the cheap paths
// and any legacy caller behave as they did.
async function findInstagram(website, opts) {
  const o = opts || {};
  if (!website) return null;
  let url = String(website).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let domain;
  try { domain = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return null; }

  const key = _cacheKey(domain);
  try {
    const cached = await store.getBrandEvidence(key, 'instagram', CACHE_DAYS);
    if (cached && cached.evidence) {
      const ev = cached.evidence;
      return ev.found === false ? null : {
        handle: ev.handle || null, scope: ev.scope || 'business', source: ev.source || 'site',
        ownerName: ev.ownerName || null, bookingEmail: ev.bookingEmail || null,
        evidenceKind: ev.evidenceKind || null,
      };
    }
  } catch (_) { /* fall through */ }

  // 1. the site itself
  let html = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NILDashBot/1.0)' } });
    clearTimeout(t);
    if (!resp.ok) console.warn('[instagram] ' + domain + ' http=' + resp.status);
    else html = await resp.text();
  } catch (e) { console.warn('[instagram] ' + domain + ' error=' + e.message); }

  const scraped = _extractHandle(html, o.brand, o.loc);
  let out = null;
  if (scraped) {
    out = { handle: scraped.handle, scope: scraped.scope, source: 'site', ownerName: null, bookingEmail: null, evidenceKind: null };
  } else if (o.brand && typeof o.webSearch === 'function') {
    // 2. only now, and only when there is a brand to verify against
    const found = await _searchForHandle(o.brand, o.loc, o.webSearch);
    if (found) {
      const verdict = handleVerdict(found.handle, o.brand, o.loc);
      if (verdict === 'reject') {
        console.log('[instagram] search brand="' + o.brand + '" REJECTED handle=' + found.handle + ' (different entity)');
      } else {
        out = {
          handle: found.handle, scope: verdict, source: 'search',
          ownerName: found.ownerName, bookingEmail: found.bookingEmail,
          // Said once, here, so nothing downstream can present a bio as a
          // published business address.
          evidenceKind: (found.ownerName || found.bookingEmail) ? 'bio' : null,
          bioText: found.bioText || null,
        };
      }
    }
  }

  if (!out) {
    try { await store.saveBrandEvidence(key, 'instagram', website, null, { found: false }, 'NONE'); } catch (_) {}
    console.log('[instagram] ' + domain + ' found=0');
    return null;
  }
  try { await store.saveBrandEvidence(key, 'instagram', website, null, Object.assign({ found: true }, out), 'OK'); } catch (_) {}
  console.log('[instagram] ' + domain + ' found=1 handle=' + out.handle + ' scope=' + out.scope + ' via=' + out.source
    + (out.ownerName ? ' bioOwner="' + out.ownerName + '"' : ''));
  return out;
}

module.exports = { findInstagram, handleVerdict, _extractHandle, _citedHandle };
