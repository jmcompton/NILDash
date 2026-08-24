'use strict';
// WEBSITE-BASED EMAIL CAPTURE for the local business lane.
//
// The local lane is the highest-value one and it had no email channel at all:
// cards showed a phone and "No named contact found", because the ladder never
// looked at the business's own website -- the one place a small business
// reliably publishes an address.
//
// PLAIN HTTP AND REGEX, NO MODEL. At most 3 fetches per business (homepage plus
// up to two contact-ish pages actually linked from it), no crawling, cached by
// DOMAIN so every later scan of the same business is free. A model pass is
// available but only as a last resort, only when the HTML yielded no address at
// all, and only if a reader is injected -- this file has no AI dependency.
//
// WHAT IT RETURNS, and why the type matters more than the address:
//   personal  robert@ourisman.com   -- a named human. Worth a real pitch.
//   role      marketing@, info@     -- a desk, not a person. Still sendable.
//   form      no address anywhere, but a working contact form URL.
// The outreach agent writes a different email to a person than to info@, so the
// type travels with the address rather than being re-guessed downstream.

const store = require('../store');
const { canonicalRegion } = require('./regionKey');

const MAX_PAGES = 3;              // hard cap, homepage included
const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 600 * 1024;     // a contact page that is bigger than this is not a contact page
const CACHE_DAYS = 30;
const CACHE_V = 'v1';

// Never a contact for a NIL pitch, whatever else is true of them.
const REJECT_LOCALS = new Set([
  'careers', 'career', 'jobs', 'job', 'hiring', 'recruiting', 'recruitment',
  'hr', 'humanresources', 'privacy', 'legal', 'compliance', 'press', 'media',
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'unsubscribe',
  'abuse', 'postmaster', 'mailer-daemon', 'webmaster', 'security',
]);

// A desk rather than a person. Deliberately generous: mislabelling a role
// address as personal is the expensive error, because it produces an outreach
// email that opens "Hi Info,".
const ROLE_LOCALS = new Set([
  'info', 'information', 'hello', 'hi', 'contact', 'contactus', 'contact-us',
  'marketing', 'owner', 'owners', 'manager', 'management', 'gm',
  'sales', 'admin', 'office', 'team', 'support', 'help', 'service',
  'customerservice', 'guestservices', 'bookings', 'booking', 'reservations',
  'reserve', 'orders', 'order', 'catering', 'events', 'general', 'mail',
  'email', 'enquiries', 'enquiry', 'inquiries', 'inquiry', 'frontdesk',
  'shop', 'store', 'studio', 'clinic', 'desk', 'ask', 'connect',
]);

// FRANCHISE DETECTION IS NOT REIMPLEMENTED HERE. The contacts lane already
// works it out per business and caches the answer: every contact whose
// affiliationScope resolved to 'parent-or-brand' is kept in
// evidence.notAffiliated (ai.js:1735) precisely because they belong to the
// franchisor, the operator or corporate head office rather than this location.
//
// That is a better signal than any hardcoded brand list could be -- it is
// evidence about THIS business, gathered when we looked it up, rather than a
// list somebody has to remember to extend when a new chain shows up. So the
// corporate domains are derived from those held-back people: wherever the
// parent's staff live is, by definition, the corporate domain.
function corporateDomainsFrom(notAffiliated) {
  const out = new Set();
  for (const row of (notAffiliated || [])) {
    if (!row) continue;
    const fromEmail = row.email ? rootDomain(emailDomain(row.email)) : null;
    if (fromEmail) out.add(fromEmail);
    // sourceUrl is where the parent-or-brand person was PUBLISHED, which for a
    // franchisor is the corporate site even when no address was found.
    const fromSource = row.sourceUrl ? rootDomain(row.sourceUrl) : null;
    if (fromSource) out.add(fromSource);
  }
  return out;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|ico|tiff?|avif)$/i;

// Link text / hrefs that mean "contact page". Ordered: an explicit contact page
// beats an about page, because it is where an address actually lives.
const CONTACT_PATTERNS = [
  /\/contact-?us\b/i, /\/contact\b/i, /\/get-?in-?touch\b/i,
  /\/about-?us\b/i, /\/about\b/i, /\/our-?team\b/i, /\/team\b/i, /\/staff\b/i,
];

function rootDomain(urlOrHost) {
  let h = String(urlOrHost || '').trim().toLowerCase();
  if (!h) return null;
  h = h.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].split('#')[0];
  h = h.replace(/^www\./, '').replace(/:\d+$/, '');
  const parts = h.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  // Good enough for the two-label public suffixes we actually meet (co.uk).
  const twoLabel = /^(co|com|net|org|gov|ac)\.[a-z]{2}$/;
  const last2 = parts.slice(-2).join('.');
  if (parts.length >= 3 && twoLabel.test(last2)) return parts.slice(-3).join('.');
  return last2;
}

function emailDomain(addr) {
  const m = /@([^@\s>"')]+)/.exec(String(addr || '').trim().toLowerCase());
  return m ? m[1].replace(/[.,;:]+$/, '') : null;
}

function localPart(addr) {
  return String(addr || '').trim().toLowerCase().split('@')[0].replace(/[^a-z0-9._-]/g, '');
}

// Is this address usable at all? Returns a reason when not, so a rejection is
// never silent and the coverage report can explain itself.
function screenEmail(addr, siteRoot) {
  const clean = String(addr || '').trim().toLowerCase().replace(/^mailto:/, '').split('?')[0];
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(clean)) return { ok: false, reason: 'not an email' };
  // @2x.png and friends: sprite filenames that look like addresses.
  if (IMAGE_EXT.test(clean)) return { ok: false, reason: 'image filename artifact' };
  const lp = localPart(clean);
  const base = lp.split(/[._-]/)[0];
  if (REJECT_LOCALS.has(lp) || REJECT_LOCALS.has(base)) return { ok: false, reason: `${lp}@ is never a NIL contact` };
  const dom = emailDomain(clean);
  if (!dom) return { ok: false, reason: 'no domain' };
  // Free mailboxes published on a business site are usually the owner's, so
  // they are kept -- but they cannot be domain-matched, so they are marked.
  const FREE = /^(gmail|yahoo|hotmail|outlook|aol|icloud|live|msn|protonmail|proton)\./;
  const eRoot = rootDomain(dom);
  const free = FREE.test(dom);
  if (siteRoot && !free && eRoot !== siteRoot) {
    return { ok: false, reason: `domain ${eRoot} does not match the business (${siteRoot})` };
  }
  return { ok: true, email: clean, localPart: lp, domain: eRoot, free };
}

// personal or role. Called only on addresses that already passed screenEmail.
function classifyEmail(addr) {
  const lp = localPart(addr);
  const base = lp.split(/[._-]/)[0];
  if (ROLE_LOCALS.has(lp) || ROLE_LOCALS.has(base)) return 'role';
  // firstname.lastname / f.lastname / firstnamelastname -- treat a local part
  // with no generic word in it as a person.
  return 'personal';
}

// Rank: a named human beats a desk; within a kind, an address on the business's
// own domain beats a free mailbox.
function rankEmail(cand) {
  const typeRank = cand.type === 'personal' ? 0 : 1;
  return typeRank * 10 + (cand.free ? 1 : 0);
}

// ── HTML parsing (no DOM, no dependency) ─────────────────────────────────────
function extractMailtos(html) {
  const out = [];
  const re = /href\s*=\s*["']\s*mailto:([^"'?\s>]+)/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function extractPlainEmails(html) {
  // Strip script/style so tracking blobs do not contribute fake addresses.
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const out = [];
  const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  let m;
  while ((m = re.exec(text))) out.push(m[0]);
  return out;
}

// Contact-ish links actually present in the page, absolutised, de-duped, capped.
function contactLinks(html, baseUrl) {
  const found = [];
  const re = /href\s*=\s*["']([^"'#>]+)["']/gi;
  let m;
  let base;
  try { base = new URL(baseUrl); } catch (_) { return []; }
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (/^(mailto:|tel:|javascript:|data:)/i.test(raw)) continue;
    let abs;
    try { abs = new URL(raw, base); } catch (_) { continue; }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    // Same site only. A "contact" link to Facebook is not a contact page.
    if (rootDomain(abs.hostname) !== rootDomain(base.hostname)) continue;
    const path = abs.pathname || '/';
    const idx = CONTACT_PATTERNS.findIndex((p) => p.test(path));
    if (idx === -1) continue;
    const clean = abs.origin + abs.pathname;
    if (found.some((f) => f.url === clean)) continue;
    found.push({ url: clean, rank: idx });
  }
  found.sort((a, b) => a.rank - b.rank);
  return found.map((f) => f.url);
}

// A contact FORM, for the case where there is no address anywhere. Only counted
// when the page actually contains a form with an input -- a "Contact" link to a
// page with no form is not a channel.
function hasContactForm(html) {
  if (!/<form[\s>]/i.test(html)) return false;
  const forms = String(html).match(/<form[\s\S]{0,4000}?<\/form>/gi) || [];
  return forms.some((f) => /<input|<textarea/i.test(f) && !/type\s*=\s*["']?(search|hidden)["']?/i.test(f.replace(/<input[^>]*type\s*=\s*["']?(?:submit|button)["']?[^>]*>/gi, '')));
}

// ── Fetching ─────────────────────────────────────────────────────────────────
// Returns { html } on success or { reason } on failure. A NAMED reason, always:
// swallowing every failure into null made "found nothing" and "never got the
// page" indistinguishable, so a scraper problem read as a real miss rate.
async function fetchPage(url, fetchImpl) {
  const f = fetchImpl || fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await f(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NILDashBot/1.0; +https://mynildash.com)', Accept: 'text/html' },
    });
    if (!resp) return { reason: 'no response' };
    if (!resp.ok) {
      const s = resp.status;
      if (s === 403 || s === 401) return { reason: 'blocked (' + s + ')' };
      if (s === 429) return { reason: 'rate limited (429)' };
      if (s === 404) return { reason: 'not found (404)' };
      if (s >= 500) return { reason: 'server error (' + s + ')' };
      return { reason: 'http ' + s };
    }
    const ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
    if (ct && !/text\/html|application\/xhtml/i.test(ct)) {
      return { reason: 'not html (' + String(ct).split(';')[0].trim() + ')' };
    }
    const body = await resp.text();
    if (typeof body !== 'string') return { reason: 'unreadable body' };
    const html = body.slice(0, MAX_BYTES);
    // A page whose markup carries almost no text is a JS-rendered shell: the
    // content exists only after hydration, so there is nothing for us to read.
    const visible = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    if (visible.length < 200 && /<div[^>]+id=["'](root|app|__next)["']/i.test(html)) {
      return { html, reason: 'js-rendered (no static text)', thin: true };
    }
    return { html };
  } catch (e) {
    if (e && (e.name === 'AbortError' || /abort/i.test(e.message || ''))) {
      return { reason: 'timeout (' + FETCH_TIMEOUT_MS + 'ms)' };
    }
    const m = String((e && e.message) || 'error');
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return { reason: 'dns failure' };
    if (/ECONNREFUSED/i.test(m)) return { reason: 'connection refused' };
    if (/certificate|SSL|TLS/i.test(m)) return { reason: 'tls error' };
    return { reason: 'network: ' + m.slice(0, 60) };
  } finally { clearTimeout(t); }
}

// ── The lookup ───────────────────────────────────────────────────────────────
// opts: { brand, isFranchise, fetchImpl, readContactBlock, force }
// readContactBlock(text) -> email|null   OPTIONAL single model pass, used ONLY
// when the HTML produced nothing. Injected, so this module never imports ai.js.
async function findSiteEmail(website, opts = {}) {
  const site = String(website || '').trim();
  if (!site) return null;
  let start;
  try { start = new URL(/^https?:\/\//i.test(site) ? site : 'https://' + site); } catch (_) { return null; }
  const siteRoot = rootDomain(start.hostname);
  if (!siteRoot) return null;

  // CACHED BY DOMAIN, not by brand+region: the same website is the same website
  // whichever athlete's scan reached it, so a second scan is free.
  const cacheKey = `site:${siteRoot} | ${CACHE_V}`;
  if (!opts.force) {
    try {
      const cached = await store.getBrandEvidence(cacheKey, 'siteemail', CACHE_DAYS);
      if (cached && cached.evidence && cached.evidence.v === CACHE_V) {
        return { ...cached.evidence, cached: true };
      }
    } catch (_) { /* fall through to a live fetch */ }
  }

  const pages = [];
  const failures = [];   // named reasons, so a scraper problem never reads as a real miss
  const homeUrl = start.origin + (start.pathname === '/' ? '/' : start.pathname);
  const home = await fetchPage(homeUrl, opts.fetchImpl);
  if (home && home.html) pages.push({ url: homeUrl, html: home.html, thin: !!home.thin });
  if (home && home.reason) failures.push({ url: homeUrl, reason: home.reason });

  // Only pages the homepage actually links to. No guessing at /contact and no
  // crawling: the cap is the cap.
  if (home && home.html) {
    for (const link of contactLinks(home.html, homeUrl)) {
      if (pages.length >= MAX_PAGES) break;
      const got = await fetchPage(link, opts.fetchImpl);
      if (got && got.html) pages.push({ url: link, html: got.html, thin: !!got.thin });
      if (got && got.reason) failures.push({ url: link, reason: got.reason });
    }
  }

  const rejected = [];
  const candidates = [];
  const seen = new Set();
  const consider = (addr, sourceUrl, how) => {
    const s = screenEmail(addr, siteRoot);
    if (!s.ok) {
      if (rejected.length < 12) rejected.push({ raw: String(addr).slice(0, 120), reason: s.reason });
      return;
    }
    if (seen.has(s.email)) return;
    seen.add(s.email);
    candidates.push({ email: s.email, type: classifyEmail(s.email), free: s.free, domain: s.domain, sourceUrl, how });
  };

  // mailto: first -- an address the site chose to make clickable is more
  // reliable than one scraped out of body text.
  for (const p of pages) for (const a of extractMailtos(p.html)) consider(a, p.url, 'mailto');
  for (const p of pages) for (const a of extractPlainEmails(p.html)) consider(a, p.url, 'text');

  candidates.sort((a, b) => rankEmail(a) - rankEmail(b));
  let best = candidates[0] || null;
  let usedModel = false;

  // LAST RESORT, ONE PASS, ONLY WITH NOTHING ELSE. Reads the contact page text
  // for an address the markup obscured (images, entity-encoding, "name at
  // domain dot com"). Never runs when regex already found something.
  if (!best && opts.readContactBlock && pages.length) {
    const target = pages[pages.length - 1];
    const text = String(target.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000);
    try {
      const got = await opts.readContactBlock(text);
      usedModel = true;
      if (got) {
        const s = screenEmail(got, siteRoot);
        if (s.ok) best = { email: s.email, type: classifyEmail(s.email), free: s.free, domain: s.domain, sourceUrl: target.url, how: 'model' };
        else rejected.push({ raw: String(got).slice(0, 120), reason: s.reason });
      }
    } catch (_) { usedModel = true; }
  }

  // A form is a channel, but only when there is no address at all.
  let formUrl = null;
  if (!best) {
    const withForm = pages.find((p) => hasContactForm(p.html));
    if (withForm) formUrl = withForm.url;
  }

  // FRANCHISE: a corporate address is useless for a local deal. Flagged rather
  // than dropped, so the card can say what it is instead of showing nothing.
  //
  // The domains come from the contacts lane's own cached notAffiliated rows --
  // people we already established work for the parent, not this location. If
  // the address we just scraped lives at the same domain as the franchisor's
  // staff, it is the franchisor's address. isFranchise stays as a secondary
  // signal because the scan already computes it upstream; it is read, not
  // re-derived.
  // THREE SIGNALS, because the first one is only available where a deep contact
  // lookup actually ran -- which for a local scan is almost never, and is why a
  // whole backfill came back with corporate=0.
  //
  //   notAffiliated  best evidence, but needs a cached contacts row.
  //   sharedSites    a website serving SEVERAL DISTINCT BUSINESSES is a chain.
  //                  Raising Cane's Fayetteville and Raising Cane's Rogers both
  //                  point at raisingcanes.com; a one-location business does not
  //                  share its domain with anybody. Free, derived from data we
  //                  already hold, and it needs no deep lookup.
  //   isFranchise    whatever the scan already decided upstream.
  const corpDomains = corporateDomainsFrom(opts.notAffiliated);
  const sharedSites = Number(opts.sharedSites || 0);   // distinct businesses on this domain
  const byContact = !!best && corpDomains.has(best.domain);
  const byShared = !!best && sharedSites > 1;
  const corporate = byContact || byShared || (!!best && opts.isFranchise === true);
  const corporateVia = !corporate ? null
    : (byContact ? 'a parent-or-brand contact lives at this domain'
      : (byShared ? `this website serves ${sharedSites} different businesses, so it is a chain site`
        : 'the scan flagged this as a franchise location'));

  const out = {
    v: CACHE_V,
    email: best ? best.email : null,
    type: best ? best.type : (formUrl ? 'form' : null),
    formUrl,
    corporate,
    corporateDomain: corporate && best ? best.domain : null,
    corporateVia,
    sharedSites,
    free: best ? !!best.free : false,
    sourceUrl: best ? best.sourceUrl : formUrl,
    how: best ? best.how : (formUrl ? 'form' : null),
    siteRoot,
    pagesFetched: pages.length,
    // THE SPLIT: did we fail to READ the site, or read it and find nothing?
    //   fetch-failed      the homepage never came back. reason says why.
    //   js-rendered       we got HTML but it is a hydration shell with no text.
    //   fetched-empty     we genuinely read the pages and there was no address.
    outcomeKind: !pages.length ? 'fetch-failed'
      : (best || formUrl) ? 'found'
        : (pages.every((p) => p.thin) ? 'js-rendered' : 'fetched-empty'),
    failureReason: !pages.length ? ((failures[0] && failures[0].reason) || 'unknown') : null,
    failures: failures.slice(0, 4),
    usedModel,
    rejected: rejected.slice(0, 6),
    cached: false,
  };

  try {
    await store.saveBrandEvidence(cacheKey, 'siteemail', opts.brand || siteRoot, site, out, out.email ? 'OK' : (formUrl ? 'FORM' : 'NONE'));
  } catch (_) { /* caching is best-effort */ }

  console.log(`[site-email] ${siteRoot} pages=${pages.length} email=${out.email || '-'} type=${out.type || '-'}`
    + `${out.corporate ? ' CORPORATE' : ''}${out.formUrl ? ' form=yes' : ''} rejected=${rejected.length}`);
  return out;
}

module.exports = {
  findSiteEmail,
  rootDomain, emailDomain, localPart, screenEmail, classifyEmail, rankEmail,
  extractMailtos, extractPlainEmails, contactLinks, hasContactForm,
  MAX_PAGES, REJECT_LOCALS, ROLE_LOCALS, corporateDomainsFrom,
  // Exported for pitchRoute.js, which needs the SAME named-reason fetch
  // behaviour: "403 blocked" and "dns failure" mean very different things when
  // deciding whether a company exists at all.
  fetchPage,
};

// ── Does this website plausibly belong to this business? ─────────────────────
// SIZING A PROBLEM, NOT FIXING IT. Places sometimes returns an unrelated
// national site for a local business -- Agua Plus pointed at rotoplas.com.mx,
// David Protein at a Vitamin Shoppe locator. Two consequences: the shared-domain
// chain heuristic mislabels those as corporate, and any address scraped from
// them belongs to the wrong company.
//
// The test is deliberately CONSERVATIVE -- it only reports a mismatch when the
// business name and the domain share nothing at all. That means it catches the
// Agua Plus class and MISSES the Barstool class, where "Barstool Athletics"
// points at barstoolsports.com: the token overlaps, so this cannot tell that it
// is the wrong entity at the right brand. Undercounting is the right direction
// for a number used to decide whether to act.
const NAME_STOPWORDS = new Set([
  'the', 'of', 'and', 'a', 'an', 'at', 'in', 'on', 'for', 'llc', 'inc', 'co',
  'corp', 'ltd', 'company', 'group', 'holdings', 'enterprises', 'services',
  'restaurant', 'cafe', 'coffee', 'bar', 'grill', 'kitchen', 'shop', 'store',
  'salon', 'studio', 'gym', 'fitness', 'center', 'centre', 'clinic', 'auto',
  'motors', 'plus', 'pro', 'best', 'new', 'my', 'us',

  // ── WORDS THAT NAME THE TRADE, NOT THE BUSINESS ────────────────────────────
  // Every competitor in a trade shares these, so matching on one says only that
  // two businesses are in the same line of work -- which is exactly the mistake
  // that let a Birmingham market run accept three wrong domains:
  //   Homewood Cycle & Fitness -> cahabaCYCLEs.com     matched on "cycle"
  //   Onyx Coffee Lab          -> daysolcoffeeLAB.co   matched on "lab"
  //   Millennium Chiropractic  -> pillarCHIROPRACTIC…  matched on "chiropractic"
  // In all three the distinctive word (homewood, onyx, millennium) is absent
  // from the domain. A trade word is the weakest possible evidence and it was
  // being treated as sufficient.
  //
  // STRICTLY TRADE NOUNS AND THEIR ADJECTIVES. Deliberately NOT here: place
  // names, family names, nature words (cahaba, magnolia, oak, summit, ridge) or
  // quality words. Those are how a local business is actually distinguished, and
  // stopwording them would gut the check to fix the opposite problem.
  'cycle', 'cycles', 'cycling', 'bike', 'bikes', 'bicycle', 'bicycles',
  'lab', 'labs', 'laboratory', 'laboratories',
  'chiropractic', 'chiropractor', 'chiropractors', 'chiro',
  'dental', 'dentistry', 'dentist', 'orthodontics', 'orthodontist',
  'medical', 'medicine', 'med', 'health', 'healthcare', 'wellness', 'therapy',
  'therapeutic', 'physical', 'rehab', 'rehabilitation', 'pharmacy', 'dermatology',
  'optical', 'optometry', 'vision', 'veterinary', 'vet', 'animal', 'pet', 'pets',
  'nutrition', 'supplements',
  'pizza', 'pizzeria', 'bakery', 'bakeries', 'deli', 'delicatessen', 'diner',
  'eatery', 'bistro', 'tavern', 'pub', 'taproom', 'brewing', 'brewery', 'brewhouse',
  'roasters', 'roasting', 'roastery', 'catering', 'caterers', 'smoothie', 'juice',
  'yogurt', 'creamery', 'donuts', 'donut', 'bagel', 'bagels', 'sandwich',
  'sandwiches', 'burger', 'burgers', 'taco', 'tacos', 'sushi', 'barbecue', 'bbq',
  'steakhouse', 'seafood', 'wings', 'grocery', 'liquor', 'wine', 'spirits',
  'barber', 'barbershop', 'beauty', 'nails', 'tattoo', 'aesthetics', 'skincare',
  'cleaners', 'cleaning', 'laundry', 'landscaping', 'lawn', 'plumbing', 'plumbers',
  'electric', 'electrical', 'electricians', 'hvac', 'heating', 'cooling',
  'roofing', 'roofers', 'construction', 'contracting', 'contractors', 'builders',
  'remodeling', 'renovations', 'paving', 'concrete', 'fencing', 'flooring',
  'painting', 'painters', 'glass', 'windows', 'cabinets', 'countertops',
  'realty', 'realtors', 'estate', 'properties', 'property', 'insurance', 'agency',
  'financial', 'finance', 'accounting', 'accountants', 'bookkeeping', 'tax',
  'legal', 'law', 'attorneys', 'attorney', 'lawyers', 'mortgage', 'lending',
  'apparel', 'boutique', 'outfitters', 'sporting', 'goods', 'supply', 'supplies',
  'hardware', 'furniture', 'appliance', 'appliances', 'equipment', 'rentals',
  'rental', 'storage', 'moving', 'movers', 'printing', 'signs', 'signage',
  'photography', 'photo', 'films', 'media', 'marketing', 'advertising', 'design',
  'consulting', 'consultants', 'solutions', 'systems', 'technologies', 'technology',
  'tech', 'software', 'digital', 'security', 'staffing', 'recruiting',
  'training', 'academy', 'school', 'learning', 'tutoring', 'daycare', 'childcare',
  'preschool', 'montessori', 'yoga', 'pilates', 'crossfit', 'martial', 'dance',
  'athletics', 'sports', 'nutrition', 'wellbeing',
  'tire', 'tires', 'collision', 'repair', 'repairs', 'detailing', 'towing',
  'transmission', 'automotive', 'dealership', 'powersports', 'marine', 'boat',
  'motorcycle', 'trailer', 'trucking', 'logistics', 'freight', 'delivery',
  'florist', 'flowers', 'nursery', 'garden', 'farms', 'orchard',
  'hotel', 'inn', 'suites', 'lodging', 'travel', 'tours', 'events',
  'entertainment', 'cinema', 'theater', 'theatre', 'bowling', 'golf',
  'grooming', 'boarding', 'kennel', 'pest', 'septic', 'welding', 'machining',
  'fabrication', 'industrial', 'manufacturing', 'distributing', 'distributors',
  'wholesale', 'retail', 'outlet', 'market', 'mart',
]);

function nameTokens(brand) {
  return String(brand || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t));
}

// Is one collapsed name SUBSTANTIALLY the other, rather than merely inside it?
// "cycletherapy" vs "cycletherapyllc" is the same business; "chiropractic" vs
// "millenniumchiropractic" is a trade word sitting inside a name. Containment
// alone cannot tell those apart, so the shorter side must also account for most
// of the longer one.
const _OVERLAP_MIN_LEN = 8;
const _OVERLAP_MIN_SHARE = 0.7;
function collapsedOverlapOk(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (!x || !y) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < _OVERLAP_MIN_LEN) return false;
  if (!long.includes(short)) return false;
  return (short.length / long.length) >= _OVERLAP_MIN_SHARE;
}

// { plausible, reason, matchedOn }
function domainMatchesBusiness(brand, website) {
  const root = rootDomain(website);
  if (!root) return { plausible: false, reason: 'no resolvable domain', matchedOn: null };
  const label = root.split('.')[0];                   // "rotoplas" from rotoplas.com.mx
  const flat = label.replace(/[^a-z0-9]/g, '');
  const toks = nameTokens(brand);
  const collapsed = String(brand || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  if (!toks.length) return { plausible: true, reason: 'business name is all generic words, cannot judge', matchedOn: null };

  // A significant name token inside the domain label, or the domain label
  // inside the collapsed name ("onyxcoffeelab" vs "Onyx Coffee Lab").
  const hit = toks.find((t) => flat.includes(t));
  if (hit) return { plausible: true, reason: null, matchedOn: hit };
  // The label inside the collapsed name used to accept on containment alone,
  // which let a bare trade word through: "chiropractic.com" sits inside
  // "millenniumchiropractic" and was read as a match. The label must now account
  // for most of the name, not just appear somewhere in it.
  if (collapsedOverlapOk(collapsed, flat)) {
    return { plausible: true, reason: null, matchedOn: flat };
  }
  // Acronym: "David Protein Bar" -> "dpb"
  const acr = toks.map((t) => t[0]).join('');
  if (acr.length >= 3 && flat.includes(acr)) return { plausible: true, reason: null, matchedOn: acr + ' (acronym)' };

  const foreign = /\.(mx|uk|ca|au|de|fr|es|it|nl|br|in|cn|jp)$/.test(root)
    || /\.com\.[a-z]{2}$/.test(root);
  return {
    plausible: false,
    matchedOn: null,
    reason: 'no word of "' + String(brand).trim() + '" appears in ' + root
      + (foreign ? ' (and it is a foreign domain)' : ''),
    foreign,
  };
}

module.exports.nameTokens = nameTokens;
module.exports.domainMatchesBusiness = domainMatchesBusiness;
module.exports.collapsedOverlapOk = collapsedOverlapOk;
module.exports.NAME_STOPWORDS = NAME_STOPWORDS;
