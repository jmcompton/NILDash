'use strict';
// ── FIND LOCAL BUSINESSES OF A KIND IN AN AREA (Google Places, New API) ─────
//
// One Text Search per target term: "dental office in Birmingham, AL". The
// field mask asks for the website and phone, which the market-pool search in
// services/placesMarket does not (it fills them later, per business), because
// here the website IS the lead: no domain, no email check, no email.
//
// Returns businesses with a usable domain only, de-duplicated by domain.
// Social pages and site builders' shared hosts are not a business's domain.

const SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELDS = ['id', 'displayName', 'formattedAddress', 'shortFormattedAddress', 'websiteUri', 'nationalPhoneNumber',
  'primaryTypeDisplayName', 'userRatingCount', 'businessStatus', 'location'];
const MASK = FIELDS.map((f) => 'places.' + f).join(',');
const NOT_A_DOMAIN = /(^|\.)(facebook|instagram|linkedin|twitter|x|yelp|google|business\.site|wixsite|squarespace|godaddysites|weebly|sites\.google|linktr|tiktok|youtube|square\.site|mapquest|yellowpages)\./i;

function domainOf(url) {
  if (!url) return null;
  try {
    const h = new URL(/^https?:/i.test(url) ? url : 'https://' + url).hostname.toLowerCase().replace(/^www\./, '');
    if (!h.includes('.') || NOT_A_DOMAIN.test(h + '.')) return null;
    return h;
  } catch (_) { return null; }
}

async function searchText(query, opts = {}) {
  const apiKey = (opts.apiKey || require('../placesProvider').apiKey() || '').trim();
  if (!apiKey) return { ok: false, places: [], error: 'neither SERPER_API_KEY nor GOOGLE_PLACES_API_KEY is set' };
  // Serper first, Google under the monthly cap (services/placesProvider).
  const fetchImpl = opts.fetchImpl || require('../placesProvider').placesFetch;
  try {
    const resp = await fetchImpl(SEARCH_TEXT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': MASK },
      body: JSON.stringify({ textQuery: query, pageSize: opts.pageSize || 20 }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined,
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, places: [], error: `Places HTTP ${resp.status}: ${(body.error && body.error.message) || ''}`.trim() };
    return { ok: true, places: Array.isArray(body.places) ? body.places : [] };
  } catch (e) {
    return { ok: false, places: [], error: 'Places request failed: ' + e.message };
  }
}

// terms x area -> [{ name, domain, website, phone, address, category, placeId, term, locations }]
//
// EVERY TERM IS SEARCHED, then the results are taken in turn, one from each
// term, so a cap of 150 is a mix of dentists, law firms, CPAs... and not the
// first five terms' worth of dentists (the first live run stopped at vets and
// never reached a law firm). `locations` counts how many places share one
// website: a chain's tell.
async function find(terms, area, opts = {}) {
  const byDomain = new Map();
  const perTerm = [];
  const errors = [];
  for (const term of terms) {
    const r = await searchText(`${term} in ${area}`, opts);
    const mine = [];
    perTerm.push(mine);
    if (!r.ok) { errors.push(r.error); continue; }
    for (const p of r.places) {
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;
      const domain = domainOf(p.websiteUri);
      if (!domain) continue;
      const seen = byDomain.get(domain);
      if (seen) { if (!seen.placeIds.has(p.id)) { seen.placeIds.add(p.id); seen.b.locations++; } continue; }
      const b = {
        name: (p.displayName && p.displayName.text) || domain,
        domain, website: p.websiteUri || null, phone: p.nationalPhoneNumber || null,
        address: p.shortFormattedAddress || p.formattedAddress || null,
        category: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || term,
        placeId: p.id || null, term, ratings: p.userRatingCount || 0, locations: 1,
      };
      byDomain.set(domain, { b, placeIds: new Set([p.id]) });
      mine.push(b);
    }
  }
  const out = [];
  for (let i = 0; perTerm.some((l) => i < l.length); i++) for (const l of perTerm) if (i < l.length) out.push(l[i]);
  return { businesses: opts.max ? out.slice(0, opts.max) : out, errors };
}

module.exports = { find, searchText, domainOf, MASK };
