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
    if (!resp || !resp.ok) return null;
    const ct = (resp.headers && resp.headers.get && resp.headers.get('content-type')) || '';
    if (ct && !/text\/html|application\/xhtml/i.test(ct)) return null;
    const body = await resp.text();
    return typeof body === 'string' ? body.slice(0, MAX_BYTES) : null;
  } catch (_) {
    return null;
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
  const homeUrl = start.origin + (start.pathname === '/' ? '/' : start.pathname);
  const home = await fetchPage(homeUrl, opts.fetchImpl);
  if (home) pages.push({ url: homeUrl, html: home });

  // Only pages the homepage actually links to. No guessing at /contact and no
  // crawling: the cap is the cap.
  if (home) {
    for (const link of contactLinks(home, homeUrl)) {
      if (pages.length >= MAX_PAGES) break;
      const html = await fetchPage(link, opts.fetchImpl);
      if (html) pages.push({ url: link, html });
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
  const corpDomains = corporateDomainsFrom(opts.notAffiliated);
  const corporate = !!best && (corpDomains.has(best.domain) || opts.isFranchise === true);
  const corporateVia = !best ? null
    : (corpDomains.has(best.domain) ? 'parent-or-brand contact at the same domain'
      : (opts.isFranchise === true ? 'scan flagged this as a franchise location' : null));

  const out = {
    v: CACHE_V,
    email: best ? best.email : null,
    type: best ? best.type : (formUrl ? 'form' : null),
    formUrl,
    corporate,
    corporateDomain: corporate && best ? best.domain : null,
    corporateVia,
    free: best ? !!best.free : false,
    sourceUrl: best ? best.sourceUrl : formUrl,
    how: best ? best.how : (formUrl ? 'form' : null),
    siteRoot,
    pagesFetched: pages.length,
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
};
