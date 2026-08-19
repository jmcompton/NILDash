'use strict';
// IS THIS WEBSITE ACTUALLY THIS BUSINESS'S WEBSITE?
//
// lookupPlace sends one text query, takes result #1, and reads websiteUri off
// whatever came back. When Places resolves the wrong entity the URL is still
// correct -- for the wrong business. Charleston Battery got the Wikipedia page
// for The Battery; Skullcandy got a Staples store locator. Everything scraped
// from those was counted as a real miss, which inflated the miss rate and
// understated the emailable rate.
//
// TWO LAYERS, IN THIS ORDER.
//   1. NAME AGREEMENT. Google's own displayName for the place it matched is
//      stored on every places row. If it does not agree with the business we
//      asked about, nothing else matters -- the whole record is the wrong
//      business. This catches wrong-entity matches a domain blocklist cannot,
//      including a wrongly-matched LOCAL business with a perfectly ordinary
//      website.
//   2. DOMAIN RULES. A right-entity match can still point at a directory,
//      an encyclopedia, a national retailer's store locator, or an MLM
//      distributor page. Name agreement says nothing about those.
//
// Social and link-in-bio URLs are NOT failures. A business whose only web
// presence is Instagram is correctly matched and genuinely reachable; it just
// cannot be scraped for an address. They get their own type.

const { rootDomain, nameTokens } = require('./siteEmail');

// Encyclopedias, directories, aggregators, review sites. A page here is about
// the business but is not the business.
const DIRECTORY_HOSTS = [
  'wikipedia.org', 'wikiwand.com', 'fandom.com', 'yelp.com', 'yelp.ca',
  'mapquest.com', 'yellowpages.com', 'whitepages.com', 'superpages.com',
  'bbb.org', 'tripadvisor.com', 'foursquare.com', 'manta.com', 'usabizlink.top',
  'chamberofcommerce.com', 'bizapedia.com', 'dnb.com', 'crunchbase.com',
  'opencorporates.com', 'zoominfo.com', 'apollo.io', 'buzzfile.com',
  'localstack.com', 'citysearch.com', 'merchantcircle.com', 'hotfrog.com',
  'brownbook.net', 'cylex.us.com', 'expiredomains.net', 'loc8nearme.com',
  'trustpilot.com', 'glassdoor.com', 'indeed.com', 'linkedin.com',
];

// A page ON one of these is that retailer's, not the brand it stocks.
// Skullcandy -> stores.staples.com is the shape.
const RETAILER_HOSTS = [
  'staples.com', 'vitaminshoppe.com', 'target.com', 'walmart.com',
  'bestbuy.com', 'gnc.com', 'walgreens.com', 'cvs.com', 'kroger.com',
  'amazon.com', 'ebay.com', 'costco.com', 'samsclub.com', 'dickssportinggoods.com',
  'academy.com', 'rei.com', 'petco.com', 'petsmart.com', 'homedepot.com',
  'lowes.com', 'officedepot.com', 'ulta.com', 'sephora.com',
];

// Multi-level-marketing and distributor platforms. The page belongs to an
// individual distributor, and the domain belongs to the parent programme.
const MLM_HOSTS = [
  'goherbalife.com', 'herbalife.com', 'myrandf.com', 'rodanandfields.com',
  'arbonne.com', 'beachbodycoach.com', 'teambeachbody.com', 'itworks.com',
  'myitworks.com', 'younique.com', 'youniqueproducts.com', 'scentsy.com',
  'pamperedchef.com', 'amway.com', 'melaleuca.com', 'doterra.com',
  'youngliving.com', 'juiceplus.com', 'isagenix.com', 'plexusworldwide.com',
  'zyia.com', 'lularoe.com', 'nuskin.com', 'usborne.com', 'tupperware.com',
  'primerica.com', 'monat.com', 'optaviacoach.com',
];

// Correct matches for a business with no scrapeable site of its own.
const SOCIAL_HOSTS = [
  'instagram.com', 'facebook.com', 'fb.com', 'fb.me', 'linktr.ee',
  'linkin.bio', 'beacons.ai', 'campsite.bio', 'allmylinks.com', 'lnk.bio',
  'twitter.com', 'x.com', 'tiktok.com', 'youtube.com', 'youtu.be',
  'snapchat.com', 'pinterest.com', 'nextdoor.com', 'threads.net',
  'linktree.com', 'carrd.co', 'about.me', 'bio.link', 'solo.to',
];

// Storefront/booking platforms: the business really is there, but the page is
// a tenant page on someone else's domain. Treated as social-ish: reachable,
// not scrapeable for a business address.
const PLATFORM_HOSTS = [
  'square.site', 'squarespace.com', 'wixsite.com', 'shopify.com',
  'myshopify.com', 'bigcartel.com', 'ecwid.com', 'toasttab.com',
  'clover.com', 'doordash.com', 'ubereats.com', 'grubhub.com', 'slicelife.com',
  'booksy.com', 'vagaro.com', 'styleseat.com', 'schedulicity.com',
  'mindbodyonline.com', 'opentable.com', 'resy.com', 'eventbrite.com',
  'gofundme.com', 'godaddysites.com', 'weebly.com', 'business.site',
];

function hostMatches(root, host, list) {
  return list.some((d) => root === d || host === d || host.endsWith('.' + d));
}

function hostOf(url) {
  let h = String(url || '').trim().toLowerCase();
  h = h.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].split('#')[0];
  return h.replace(/:\d+$/, '');
}

// ── Layer 1: name agreement ──────────────────────────────────────────────────
// EVERY DISTINCTIVE WORD OF THE NAME WE ASKED FOR MUST SURVIVE in the name
// Places returned. Deliberately asymmetric: Places adding words is fine
// ("Ourisman Chevrolet of Bowie" -> "... Service Center" keeps every asked
// word), Places DROPPING a distinctive word is not ("Charleston Battery" ->
// "The Battery" loses "charleston", the only word that identified it).
//
// A dropped word cannot be judged safe from the strings alone -- "Rally House
// Fayetteville" -> "Rally House" drops a city and is probably right, while
// "Charleston Battery" -> "The Battery" drops a city and is wrong. So anything
// with partial coverage is REJECTED but flagged borderline, and the borderline
// list is meant to be read before this runs at scale.
function verifyPlaceName(asked, returned) {
  const a = nameTokens(asked);
  const r = nameTokens(returned);
  if (!asked || !returned) {
    return { ok: false, coverage: 0, missing: [], borderline: false, reason: 'no name to compare' };
  }
  if (!a.length) {
    // Nothing distinctive to check against -- do not claim a disagreement.
    return { ok: true, coverage: 1, missing: [], borderline: false, reason: 'asked name is all generic words' };
  }
  const rFlat = r.join(' ');
  const rRaw = String(returned).toLowerCase().replace(/[^a-z0-9]/g, '');
  const present = (t) => r.includes(t) || rFlat.includes(t) || rRaw.includes(t);
  const missing = a.filter((t) => !present(t));
  const coverage = (a.length - missing.length) / a.length;
  if (!missing.length) return { ok: true, coverage: 1, missing: [], borderline: false, reason: null };
  return {
    ok: false,
    coverage,
    missing,
    // Partial overlap is the ambiguous zone a human should look at; zero
    // overlap is unambiguously a different business.
    borderline: coverage > 0,
    reason: coverage > 0
      ? `Places dropped ${missing.map((m) => '"' + m + '"').join(', ')} from the name`
      : 'no word of the name survived',
  };
}

// ── Layer 2 + the whole verdict ──────────────────────────────────────────────
// verdict: pass | social | platform | reject-name | reject-domain
function validateWebsite(brand, googleName, website) {
  const host = hostOf(website);
  const root = rootDomain(website);
  if (!root) return { verdict: 'reject-domain', rule: 'no-domain', detail: 'not a resolvable URL', borderline: false };

  // 1. NAME FIRST. A wrong-entity match makes every later question moot.
  const nameCheck = verifyPlaceName(brand, googleName);
  if (!nameCheck.ok) {
    return {
      verdict: 'reject-name',
      rule: 'name-disagreement',
      detail: nameCheck.reason,
      asked: brand,
      returned: googleName,
      coverage: nameCheck.coverage,
      missing: nameCheck.missing,
      borderline: nameCheck.borderline,
    };
  }

  // 2. Social / link-in-bio: a correct match with nothing to scrape.
  if (hostMatches(root, host, SOCIAL_HOSTS)) {
    return { verdict: 'social', rule: 'social-host', detail: root, borderline: false };
  }
  if (hostMatches(root, host, PLATFORM_HOSTS)) {
    return { verdict: 'platform', rule: 'platform-host', detail: root, borderline: false };
  }

  // 3. Domain rules, for a right-entity match pointed somewhere useless.
  if (hostMatches(root, host, DIRECTORY_HOSTS)) {
    return { verdict: 'reject-domain', rule: 'directory-or-encyclopedia', detail: root, borderline: false };
  }
  if (hostMatches(root, host, MLM_HOSTS)) {
    return { verdict: 'reject-domain', rule: 'mlm-distributor', detail: root, borderline: false };
  }
  if (hostMatches(root, host, RETAILER_HOSTS)) {
    // Only a rejection when the business is not that retailer. "Staples" itself
    // pointing at staples.com is a correct match.
    const bt = nameTokens(brand);
    const label = root.split('.')[0];
    const isThatRetailer = bt.some((t) => label.includes(t) || t.includes(label));
    if (!isThatRetailer) {
      return { verdict: 'reject-domain', rule: 'national-retailer-locator', detail: root, borderline: false };
    }
  }
  // A store-locator path on any host is a locator, not a business site.
  if (/^(stores|locations|store-?locator|find-?a-?store)\./i.test(host)
      || /\/(store-?locator|find-?a-?store)\b/i.test(String(website))) {
    const bt = nameTokens(brand);
    const label = root.split('.')[0];
    if (!bt.some((t) => label.includes(t) || t.includes(label))) {
      return { verdict: 'reject-domain', rule: 'store-locator-page', detail: host, borderline: false };
    }
  }
  return { verdict: 'pass', rule: null, detail: root, borderline: false };
}

module.exports = {
  validateWebsite, verifyPlaceName, hostOf, hostMatches,
  DIRECTORY_HOSTS, RETAILER_HOSTS, MLM_HOSTS, SOCIAL_HOSTS, PLATFORM_HOSTS,
};
