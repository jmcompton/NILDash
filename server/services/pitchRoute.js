'use strict';
// ── How do you actually pitch this brand? ────────────────────────────────────
//
// WHY THIS EXISTS. socialProof.verifySocialProof answers "does this brand run a
// public athlete program with an application page". That is the right bar for
// the nightly discovery job, which is building a curated index and must not
// fill it with guesses. It is the WRONG bar for an agent typing a brand name
// into a search box: Red Bull, Gatorade and Buffalo Wild Wings all run athlete
// and campus promotions, and all of them fail that check, because they take
// partnerships through contact and agencies rather than a signup form.
//
// So this module answers the agent's actual question -- "can I pitch this
// company, and where do I send it" -- WITHOUT touching the discovery gate.
// socialProof.js is not modified and nothing here is written to social_brands.
//
// Three outcomes, mapped to the card's program state:
//   open-program  a public application page exists       (decided by socialProof, not here)
//   direct-pitch  no application page, but a partnerships/marketing route exists
//   unknown       neither -- the company is real, we just have no route yet
//
// Budget: at most MAX_PAGES fetches, no model call, no crawling.

const SE = require('./siteEmail');
const { rootDomain, screenEmail, classifyEmail, extractMailtos, extractPlainEmails,
        hasContactForm, fetchPage } = SE;

const MAX_PAGES = 4;              // homepage + 3, hard cap

// Pages worth reading, best first. A partnerships page beats a sponsorship page
// beats a generic contact page, because the first two tell the agent the company
// expects this kind of approach.
const ROUTE_PATTERNS = [
  { re: /\/(brand-)?partnerships?\b/i,                 label: 'Partnerships page' },
  { re: /\/partner-?with-?us\b/i,                      label: 'Partner with us' },
  { re: /\/sponsorships?\b/i,                          label: 'Sponsorship page' },
  { re: /\/sponsor(-|_)?(request|inquiry|inquiries)\b/i, label: 'Sponsorship request' },
  { re: /\/(athlete|ambassador|influencer|creator)s?\b/i, label: 'Athlete / ambassador page' },
  { re: /\/collab(orations?)?\b/i,                     label: 'Collaborations page' },
  { re: /\/marketing\b/i,                              label: 'Marketing page' },
  { re: /\/contact-?us\b/i,                            label: 'Contact page' },
  { re: /\/contact\b/i,                                label: 'Contact page' },
  { re: /\/get-?in-?touch\b/i,                         label: 'Contact page' },
];

// Anchor TEXT that means the same thing, for sites whose URLs are opaque
// (/pages/12345). Scored lower than a path match, which is more reliable.
const ROUTE_TEXT = /partner(ship)?s?\b|sponsor(ship)?s?\b|brand collab|work with us|ambassador|influencer|creator program/i;

// Fallback paths, tried only if the homepage yielded no candidate links at all.
const FALLBACK_PATHS = [
  '/partnerships', '/partnership', '/sponsorships', '/sponsorship',
  '/partner-with-us', '/pages/partnerships', '/contact-us', '/contact',
];

// Local parts that mean "this desk handles brand partnerships". A pitch sent
// here reaches someone whose job is to read it, which is the whole point.
const PITCH_LOCALS = new Set([
  'partnerships', 'partnership', 'partners', 'partner',
  'sponsorship', 'sponsorships', 'sponsor', 'sponsors',
  'brandpartnerships', 'brandpartners', 'brand',
  'influencer', 'influencers', 'creator', 'creators',
  'collab', 'collabs', 'collaboration', 'collaborations',
  'ambassador', 'ambassadors', 'nil', 'athlete', 'athletes',
  'sponsorme', 'endorsements', 'endorsement',
]);
// Second best: a marketing desk. Not partnership-specific, but the right building.
const MARKETING_LOCALS = new Set([
  'marketing', 'brandmarketing', 'pr', 'publicity', 'comms', 'communications',
]);

function localPart(addr) {
  return String(addr || '').trim().toLowerCase().split('@')[0].replace(/[^a-z0-9._-]/g, '');
}

// 0 best. A partnerships desk beats a marketing desk beats a named human beats
// a generic info@. A named human outranks info@ because a person can forward it;
// it loses to partnerships@ because that desk is the documented route.
function routeRank(addr) {
  const lp = localPart(addr);
  const base = lp.split(/[._-]/)[0];
  if (PITCH_LOCALS.has(lp) || PITCH_LOCALS.has(base)) return 0;
  if (MARKETING_LOCALS.has(lp) || MARKETING_LOCALS.has(base)) return 1;
  return classifyEmail(addr) === 'personal' ? 2 : 3;
}

function routeKindOf(addr) {
  const r = routeRank(addr);
  return r === 0 ? 'partnerships' : r === 1 ? 'marketing' : r === 2 ? 'named' : 'general';
}

// Candidate pages on the homepage, ranked. Same-site only: a "Partners" link to
// LinkedIn is not a route.
function routeLinks(html, baseUrl) {
  let base;
  try { base = new URL(baseUrl); } catch (_) { return []; }
  const baseRoot = rootDomain(base.hostname);
  const found = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"'>]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = String(m[1]).trim();
    if (/^(mailto:|tel:|javascript:|data:|#)/i.test(raw)) continue;
    let abs;
    try { abs = new URL(raw, base); } catch (_) { continue; }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
    if (rootDomain(abs.hostname) !== baseRoot) continue;
    const path = abs.pathname || '/';
    const text = String(m[2] || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    let rank = -1, label = null;
    const i = ROUTE_PATTERNS.findIndex((p) => p.re.test(path));
    if (i >= 0) { rank = i; label = ROUTE_PATTERNS[i].label; }
    else if (ROUTE_TEXT.test(text)) { rank = ROUTE_PATTERNS.length; label = text.slice(0, 40) || 'Partnerships link'; }
    if (rank < 0) continue;
    const url = abs.origin + abs.pathname;
    if (found.some((f) => f.url === url)) continue;
    found.push({ url, rank, label });
  }
  found.sort((a, b) => a.rank - b.rank);
  return found;
}

// ── Does this company exist at all? ──────────────────────────────────────────
// The ONLY thing that should produce an outright decline. Note what does NOT
// count as "does not exist": a 403, a 429, a 500 or a timeout. Large brands sit
// behind bot protection and refuse our user agent all day -- gatorade.com
// answering 403 is proof the domain resolves, not evidence the company is
// fictional. Only a name that resolves to nothing is a real miss.
async function probeSite(website, fetchImpl) {
  if (!website) return { exists: false, reason: 'no website to check' };
  let url;
  try {
    let w = String(website).trim();
    if (!/^https?:\/\//i.test(w)) w = 'https://' + w;
    url = new URL(w);
  } catch (_) { return { exists: false, reason: 'not a usable URL' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { exists: false, reason: 'not a web URL' };

  const r = await fetchPage(url.href, fetchImpl);
  if (r.html) return { exists: true, html: r.html, url: url.href, reachable: true };
  const reason = r.reason || 'unknown';
  // DNS is the one failure that means the name is not real.
  if (/dns failure|connection refused/i.test(reason)) return { exists: false, reason, url: url.href };
  // Everything else: the domain is there, we just cannot read it.
  return { exists: true, html: null, url: url.href, reachable: false, reason };
}

// ── The lookup ───────────────────────────────────────────────────────────────
// opts: { fetchImpl, homepageHtml }  homepageHtml lets the caller hand over a
// page it already fetched (probeSite) so we do not pay for it twice.
async function findPitchRoute(website, opts = {}) {
  const out = {
    kind: 'unknown', email: null, emailType: null, routeKind: null,
    pageUrl: null, pageLabel: null, formUrl: null,
    pagesFetched: 0, notes: [], rejected: [],
  };
  let base;
  try {
    let w = String(website || '').trim();
    if (!/^https?:\/\//i.test(w)) w = 'https://' + w;
    base = new URL(w);
  } catch (_) { out.notes.push('not a usable URL'); return out; }
  const siteRoot = rootDomain(base.hostname);

  const seen = new Set();
  const candidates = [];   // { email, rank, sourceUrl }
  const consider = (html, sourceUrl) => {
    const raw = [].concat(extractMailtos(html), extractPlainEmails(html));
    for (const a of raw) {
      const s = screenEmail(a, siteRoot);
      if (!s.ok) { if (out.rejected.length < 12) out.rejected.push({ raw: a, reason: s.reason }); continue; }
      if (seen.has(s.email)) continue;
      seen.add(s.email);
      candidates.push({ email: s.email, rank: routeRank(s.email), sourceUrl });
    }
  };

  // 1. Homepage (reused if the caller already has it).
  let html = opts.homepageHtml || null;
  if (!html) {
    const r = await fetchPage(base.href, opts.fetchImpl);
    out.pagesFetched++;
    if (r.html) html = r.html;
    else out.notes.push('homepage: ' + (r.reason || 'unreadable'));
  }
  if (html) consider(html, base.href);

  // 2. Ranked route pages from the homepage, else the fallback paths.
  let targets = html ? routeLinks(html, base.href).slice(0, MAX_PAGES - out.pagesFetched) : [];
  if (!targets.length) {
    targets = FALLBACK_PATHS.slice(0, MAX_PAGES - out.pagesFetched).map((p) => {
      let u = null;
      try { u = new URL(p, base.origin).href; } catch (_) { return null; }
      const i = ROUTE_PATTERNS.findIndex((x) => x.re.test(p));
      return { url: u, rank: i < 0 ? 99 : i, label: i < 0 ? 'Contact page' : ROUTE_PATTERNS[i].label, guessed: true };
    }).filter(Boolean);
  }

  for (const t of targets) {
    if (out.pagesFetched >= MAX_PAGES) break;
    const r = await fetchPage(t.url, opts.fetchImpl);
    out.pagesFetched++;
    if (!r.html) { out.notes.push(t.url.replace(base.origin, '') + ': ' + (r.reason || 'unreadable')); continue; }
    // A guessed path that 200s on a catch-all is not proof of a page; only
    // count it as a route once it actually yields an address or a form.
    const hadEmail = candidates.length;
    consider(r.html, t.url);
    const form = hasContactForm(r.html);
    const gained = candidates.length > hadEmail;
    if (!out.pageUrl && (!t.guessed || gained || form)) { out.pageUrl = t.url; out.pageLabel = t.label; }
    if (form && !out.formUrl) out.formUrl = t.url;
    // A partnerships desk address is the best possible answer -- stop paying.
    if (candidates.some((c) => c.rank === 0)) break;
  }

  candidates.sort((a, b) => a.rank - b.rank);
  const best = candidates[0] || null;
  if (best) {
    out.email = best.email;
    out.emailType = classifyEmail(best.email);
    out.routeKind = routeKindOf(best.email);
    out.emailSourceUrl = best.sourceUrl;
  }
  // A route exists if there is somewhere to send it: an address, a partnerships
  // page, or a form. Otherwise the company is real but we have no way in yet.
  out.kind = (out.email || out.formUrl || out.pageUrl) ? 'direct-pitch' : 'unknown';
  return out;
}

// One sentence telling the agent what to actually do, built from what was
// found. This is what replaces the old copy that explained our indexing policy.
function describeRoute(brand, state, route) {
  const b = brand || 'This brand';
  if (state === 'open-program') return `${b} runs a public program — apply through their page.`;
  if (state === 'direct-pitch') {
    if (route && route.routeKind === 'partnerships') return `No public application. Pitch ${route.email} directly — that desk handles partnerships.`;
    if (route && route.routeKind === 'marketing') return `No public application. Their marketing desk (${route.email}) is the closest route.`;
    if (route && route.email) return `No public application. ${route.email} is the best address we could find on their site.`;
    if (route && route.formUrl) return `No public application and no published address — their contact form is the way in.`;
    if (route && route.pageUrl) return `No public application, but they have a ${String(route.pageLabel || 'partnerships page').toLowerCase()} — start there.`;
  }
  return `${b} is a real company, but we could not find a partnerships route on their site. Worth an approach through an agency contact or a DM.`;
}

module.exports = {
  findPitchRoute, probeSite, describeRoute, routeRank, routeKindOf, routeLinks,
  MAX_PAGES, PITCH_LOCALS, MARKETING_LOCALS, ROUTE_PATTERNS,
};
