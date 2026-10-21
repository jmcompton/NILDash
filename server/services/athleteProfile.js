'use strict';
// ── THE ATHLETE'S PROFILE FOR PITCHES (ATHLETE_PROFILE_ON) ──────────────────
//
// What an agent knows about an athlete that a pitch can use, kept on the
// athlete (athletes.data):
//
//   contentNiche     up to 3 from a fixed list
//   causes           causes and ambassador roles, in the agent's words
//   partnerships     current partnerships the agent adds: brand, what they do,
//                    start date. Deals signed on NILDash are added on their
//                    own (partnershipsFor), never stored twice.
//   mediaExposure    national TV, regional TV or streamed only, plus links to
//                    recent articles
//   marketable       what makes them marketable, in 3 short lines
//   rateCard         the agent's price per post, reel, story and appearance.
//                    NILDash suggests each one from followers and engagement
//                    (suggestRates) and says how it got there.
//
// The pitch writer gets ONE line from it, "why this brand fits" (fitLine):
// the niches that match the business first, then causes and marketable
// points. Never the rate card: outreach names no price.

const ON = () => process.env.ATHLETE_PROFILE_ON === '1';

const NICHES = ['health and wellness', 'fitness', 'food', 'fashion', 'faith', 'family', 'gaming', 'music', 'outdoors', 'pets', 'business', 'other'];
const NICHE_MAX = 3;
const MEDIA = [['national_tv', 'National TV'], ['regional_tv', 'Regional TV'], ['streamed', 'Streamed only']];
const RATES = [['post', 'Instagram post', 'ig-post'], ['reel', 'Reel', 'ig-reel'], ['story', 'Story', 'stories'], ['appearance', 'Appearance', 'appearance-inperson']];
const KEYS = ['contentNiche', 'causes', 'partnerships', 'mediaExposure', 'marketable', 'rateCard'];
const LIMITS = { causes: 400, line: 120, brand: 80, what: 160, links: 5, link: 300, partnerships: 12 };

const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const labelOf = (list, key) => { const x = list.find((p) => p[0] === key); return x ? x[1] : null; };
function dateOf(v) {
  const s = str(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s + 'T12:00:00Z');
  return Number.isFinite(t) ? s : null;
}
function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(String(v).replace(/[$,\s]/g, '')));
  return Number.isFinite(n) && n > 0 && n <= 1000000 ? n : null;
}
function linkOf(v) {
  const s = str(v, LIMITS.link);
  if (!s) return null;
  try { const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.toString() : null; }
  catch (_) { return null; }
}

// ── WHAT THE FORM SENDS, CHECKED ────────────────────────────────────────────
// -> { ok, profile, errors } with only the keys that were sent. A key sent
// blank clears it. Nothing here is required.
function clean(body = {}) {
  const out = {}, errors = [];
  if ('contentNiche' in body) {
    const raw = Array.isArray(body.contentNiche) ? body.contentNiche : [];
    const picked = [...new Set(raw.map((x) => str(x, 40).toLowerCase()).filter((x) => NICHES.includes(x)))];
    if (picked.length > NICHE_MAX) errors.push(`Pick up to ${NICHE_MAX} content niches.`);
    out.contentNiche = picked.slice(0, NICHE_MAX);
  }
  if ('causes' in body) out.causes = str(body.causes, LIMITS.causes);
  if ('partnerships' in body) {
    const raw = Array.isArray(body.partnerships) ? body.partnerships : [];
    out.partnerships = raw.map((p) => ({ brand: str(p && p.brand, LIMITS.brand), what: str(p && p.what, LIMITS.what), start: dateOf(p && p.start) }))
      .filter((p) => p.brand).slice(0, LIMITS.partnerships);
  }
  if ('mediaExposure' in body) {
    const m = body.mediaExposure || {};
    const level = labelOf(MEDIA, m.level) ? m.level : null;
    const links = (Array.isArray(m.links) ? m.links : String(m.links || '').split(/\s*\n\s*/)).map(linkOf).filter(Boolean);
    out.mediaExposure = { level, links: [...new Set(links)].slice(0, LIMITS.links) };
  }
  if ('marketable' in body) {
    const raw = Array.isArray(body.marketable) ? body.marketable : [];
    out.marketable = raw.map((x) => str(x, LIMITS.line)).filter(Boolean).slice(0, 3);
  }
  if ('rateCard' in body) {
    const r = body.rateCard || {};
    out.rateCard = {};
    for (const [k] of RATES) out.rateCard[k] = money(r[k]);
  }
  return { ok: !errors.length, profile: out, errors };
}

// For the create path: the profile keys of a new athlete, or nothing when off.
function fromBody(body) {
  if (!ON()) return {};
  const c = clean(body || {});
  return c.profile;
}

// ── THE SUGGESTED RATE CARD ─────────────────────────────────────────────────
// From the same estimator Deal Scan uses (benchmarks.nilViewVal), so the
// numbers agree across the product. Each line says how it was worked out.
const round5 = (n) => Math.max(5, Math.round(n / 5) * 5);
function suggestRates(athlete = {}) {
  const { nilViewVal } = require('../benchmarks');
  const ig = Number(athlete.instagram) || 0, tt = Number(athlete.tiktok) || 0;
  const er = Number(athlete.engagement);
  const hasEr = Number.isFinite(er) && er > 0;
  const reach = ig + tt;
  const basis = reach
    ? `${reach.toLocaleString('en-US')} followers (${[ig ? 'Instagram ' + ig.toLocaleString('en-US') : null, tt ? 'TikTok ' + tt.toLocaleString('en-US') : null].filter(Boolean).join(', ')})`
    : 'no follower count on file';
  const erText = hasEr ? `a ${er}% engagement rate` : 'no engagement rate on file, so none is assumed';
  const out = {};
  for (const [key, label, type] of RATES) {
    let r;
    try { r = nilViewVal(athlete, type); } catch (_) { r = null; }
    if (!r || !(r.mid || r.low)) { out[key] = { key, label, amount: null, low: null, high: null, how: 'Not enough on file to suggest a price.' }; continue; }
    const mid = Number(r.mid) || Math.round(((Number(r.low) || 0) + (Number(r.high) || 0)) / 2);
    const b = r.breakdown || {};
    const how = type === 'appearance-inperson'
      ? `A flat fee for the school's level and sport, adjusted for ${erText}: about $${round5(r.low)} to $${round5(r.high)}.`
      : `From ${basis} and ${erText}: about $${round5(r.low)} to $${round5(r.high)}`
        + (b.cpm && b.cpm !== 'N/A (flat fee)' ? `, at $${b.cpm} per 1,000 followers` : '')
        + (b.engMult && hasEr ? `, with engagement counted at x${b.engMult}` : '') + '.';
    out[key] = { key, label, amount: round5(mid), low: round5(r.low), high: round5(r.high), how };
  }
  return out;
}

// ── PARTNERSHIPS: THE AGENT'S, AND NILDASH'S OWN ────────────────────────────
// A deal signed on NILDash is a current partnership without anyone typing it:
// the Pipeline row at Closing or Closed, dated from its start date, its logged
// deal or the day it reached Closed. One per business; the agent's own entry
// wins when both name the same brand.
async function partnershipsFor(pool, athleteId, typed) {
  const own = Array.isArray(typed) ? typed : [];
  let rows = [];
  try {
    rows = (await pool.query(
      `SELECT d.brand_name, d.deliverables, d.deal_type, d.start_date, d.stage_history,
              (SELECT MAX(o.closed_at) FROM deal_outcomes o WHERE o.athlete_id = d.athlete_id AND LOWER(TRIM(o.brand)) = LOWER(TRIM(d.brand_name))) AS closed_at,
              (SELECT o.deliverable FROM deal_outcomes o WHERE o.athlete_id = d.athlete_id AND LOWER(TRIM(o.brand)) = LOWER(TRIM(d.brand_name)) ORDER BY o.id DESC LIMIT 1) AS deliverable
         FROM athlete_self_deals d
        WHERE d.athlete_id = $1 AND d.stage IN ('Closed', 'Closing')
        ORDER BY d.created_at ASC`, [athleteId])).rows;
  } catch (_) { rows = []; }
  const seen = new Set(own.map((p) => str(p.brand, 200).toLowerCase()));
  const fromDeals = [];
  for (const r of rows) {
    const k = str(r.brand_name, 200).toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const hist = Array.isArray(r.stage_history) ? r.stage_history : [];
    const closedAt = (hist.slice().reverse().find((h) => /^clos/i.test(String(h.stage || ''))) || {}).date || null;
    const start = r.start_date ? new Date(r.start_date).toISOString().slice(0, 10)
      : r.closed_at ? new Date(r.closed_at).toISOString().slice(0, 10)
      : closedAt ? String(closedAt).slice(0, 10) : null;
    fromDeals.push({ brand: r.brand_name, what: str(r.deliverable || r.deliverables || (r.deal_type && r.deal_type !== 'Other' ? r.deal_type : ''), LIMITS.what), start, source: 'nildash' });
  }
  return [...own.map((p) => ({ ...p, source: 'agent' })), ...fromDeals];
}

// ── WHY THIS BRAND FITS, ONE LINE FOR THE WRITER ────────────────────────────
// The niches that match this kind of business first ("fitness content, and
// this is a gym"), then the causes and what makes them marketable. Empty when
// the agent has filled in none of it, or when the switch is off.
// Stems: "veterinar" reads veterinary and veterinarian, "shoe" reads shoes.
const MATCH = [
  [/\b(gym|fitness|crossfit|yoga|pilates|training|boxing|martial)\w*/i, ['fitness', 'health and wellness']],
  [/\b(restaurant|food|cafe|coffee|bakery|pizz|burger|grill|bar|diner|taco|taqueria|bbq|barbecue|kitchen|smoothie|juice|dessert|ice cream|creamery)(s|es|eria|eria)?\b/i, ['food']],
  [/\b(wellness|spa|chiropract|physical therap|medspa|med spa|dental|dentist|health|nutrition|supplement|pharmac)\w*/i, ['health and wellness', 'fitness']],
  [/\b(apparel|clothing|boutique|fashion|shoe|sneaker|jewel|salon|barber|beauty)\w*/i, ['fashion']],
  [/\b(church|ministr|faith|christian)\w*/i, ['faith']],
  [/\b(pet|vet|veterinar|animal|groom)\w*/i, ['pets']],
  [/\b(outdoor|hunting|fishing|bait|tackle|camping|marine|boat|golf)\w*/i, ['outdoors']],
  [/\b(music|guitar|record store|recording|studio|instrument)\w*/i, ['music']],
  [/\b(gaming|esports|arcade|video game)\w*/i, ['gaming']],
  [/\b(bank|credit union|insurance|realty|real estate|law firm|attorney|accounting|financial|dealership|auto)\w*/i, ['business']],
  [/\b(daycare|pediatric|family|kids|toy)\w*/i, ['family']],
];
function fitLine(athlete = {}, business = {}) {
  if (!ON()) return '';
  const niche = Array.isArray(athlete.contentNiche) ? athlete.contentNiche.filter((x) => NICHES.includes(x) && x !== 'other') : [];
  const causes = str(athlete.causes, LIMITS.causes);
  const marketable = Array.isArray(athlete.marketable) ? athlete.marketable.map((x) => str(x, LIMITS.line)).filter(Boolean) : [];
  if (!niche.length && !causes && !marketable.length) return '';
  const what = [business.category, business.primaryType, business.name].filter(Boolean).join(' ');
  const wanted = new Set();
  for (const [re, ns] of MATCH) if (re.test(what)) ns.forEach((n) => wanted.add(n));
  const matched = niche.filter((n) => wanted.has(n));
  const rest = niche.filter((n) => !wanted.has(n));
  const bits = [];
  if (matched.length) bits.push(`${matched.join(' and ')} content, which matches this business`);
  if (rest.length) bits.push(`also posts about ${rest.join(' and ')}`);
  if (causes) bits.push(`causes and roles: ${causes}`);
  if (marketable.length) bits.push(`marketable for: ${marketable.join('; ')}`);
  return 'Why this brand fits (from the agent, use it as the reason in your own words): ' + bits.join('; ') + '.';
}

module.exports = { ON, NICHES, NICHE_MAX, MEDIA, RATES, KEYS, clean, fromBody, suggestRates, partnershipsFor, fitLine, labelOf };
