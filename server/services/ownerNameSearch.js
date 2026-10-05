'use strict';
// ── THE LAST DOOR: "[BUSINESS] [CITY] OWNER" ─────────────────────────────────
//
// A pitch that opens "Hi," or greets nobody is worse than no pitch: the agent
// sends it under their athlete's name to a real business. So a business is
// only handed to the writer once a REAL PERSON's name was found: the owner, a
// marketing director, or another decision maker. The contact ladder finds one
// most of the time. When every one of its sources came back empty, this runs
// two Haiku web searches, "[business] [city] owner" and "[business] [city]
// marketing director", and reads a name off the pages that come back. Only
// when that too returns nothing is the business skipped, and the skip is
// logged with the reason so the rate is visible the next morning.
//
// NEVER A GUESS. The model is told to return null when the pages do not name
// a person; a name that is a role, a company, the business itself, or a single
// word is refused here; and the title has to be one the rank table treats as
// a decision maker or a manager, not a placeholder.

const CR = require('./contactRank');

const SYS = 'You find the named person who runs or markets a specific local business, from web search results only. '
  + 'Return ONLY a JSON object: {"name": "First Last or null", "title": "their role as the page states it, or null", '
  + '"sourceUrl": "the page that names them, or null", "confidence": "high|medium|low"}. '
  + 'Rules: the name must be a real person named ON A PAGE ABOUT THIS BUSINESS in this city; never a role word, never the business name, '
  + 'never a person at a different business with the same name, never a guess. If no page names a person, return {"name": null}. No text outside the JSON.';

// The city is left out of the query when there is none: a national or DTC
// brand (the program lane) is searched as "Brand marketing director", not
// "Brand  marketing director".
const QUERIES = [
  { key: 'owner', q: (b, c) => [b, c, 'owner'].filter(Boolean).join(' '), ask: 'the owner, founder or proprietor' },
  { key: 'marketing', q: (b, c) => [b, c, 'marketing director'].filter(Boolean).join(' '), ask: 'the marketing director, marketing manager or partnerships lead' },
  // TWO MORE DOORS BEFORE A BUSINESS IS DROPPED. The LinkedIn company page
  // lists who runs a small business more often than its own site does, and
  // an owner usually signs the Instagram bio or answers Google reviews by name.
  { key: 'linkedin', q: (b, c) => ['site:linkedin.com', b, c, 'owner OR founder OR president'].filter(Boolean).join(' '), ask: 'the owner, founder or president, as their LinkedIn profile or the company page states it' },
  // A large brand: the person who runs athlete and influencer partnerships.
  { key: 'partnerships', q: (b, c) => [b, c, 'head of partnerships OR "athlete marketing" OR "influencer marketing" OR sponsorships'].filter(Boolean).join(' '), ask: 'the head of partnerships, athlete marketing, influencer marketing or sponsorships' },
  { key: 'social', q: (b, c) => [b, c, 'instagram OR "response from the owner"'].filter(Boolean).join(' '), ask: 'the owner, as the business Instagram bio or the owner replies on its Google reviews name them' },
];

// Any of these words anywhere in the "name" means it is not a person: "The
// Team", "Front Office", "Marketing Dept", "Business Owner".
const ROLE_WORDS = /\b(owner|owners|manager|management|team|staff|marketing|director|founder|ceo|president|office|admin|info|contact|customer|service|sales|support|dept|department|business|company|llc|inc|unknown|none|null|n\/a)\b/i;

function parseJson(text) {
  const s = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

// A name we would open a letter with: two to four words, letters (with the
// odd apostrophe, hyphen or period), not a role word, not the business.
function looksLikePerson(name, brand) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n || ROLE_WORDS.test(n)) return false;
  const parts = n.split(' ');
  if (parts.length < 2 || parts.length > 4) return false;
  if (!parts.every((p) => /^[A-Za-z][A-Za-z'’.\-]*$/.test(p))) return false;
  const b = String(brand || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const nl = n.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (b && (nl === b || b.includes(nl))) return false;
  return true;
}

// ── THE MARKETING OR PARTNERSHIPS DECISION MAKER, OR NOBODY ─────────────────
//
// Jasper Johnson's cards went to Phil Knight ("Chairman Emeritus and
// co-founder" of Nike) and Lawrence Schovanec ("17th President of Texas Tech
// University"). The owner finder printed the disqualifying title and nothing
// read it. titleProblem() does, for every lane:
//   never     emeritus, retired or former; chairman or chair of the board, a
//             trustee or regent; a school's president, chancellor, provost,
//             dean, athletic director or coach
//   large     (the national lane, or a social brand sized national): the CEO,
//             president, chairman, founder or owner of a company that size is
//             someone we would never reach. Only a marketing, partnerships,
//             brand, influencer, sponsorship, athlete, creator or community
//             title is accepted.
// -> null when the person may be pitched, or the reason they may not.
const NEVER_TITLE = /\b(emerit(us|a)|retired|former|ex-|chair(man|woman|person)? of the board|board (chair|member)|board of (directors|trustees|regents)|trustee|regent|vice chancellor|chancellor|provost|dean|athletic director|athletics director|director of athletics|head coach|assistant coach|coach)\b|\bpresident of (the )?[\w .&'-]*\b(university|college|school|institute)\b|\b(university|college) president\b|^\s*\d+(st|nd|rd|th) president\b/i;
const DECIDES = /\b(marketing|partnerships?|brand|influencer|sponsorships?|athletes?|creators?|community|social media|nil|ambassador|talent|communications|public relations|events?|growth|affiliate|activation)\b/i;
const TOP_EXEC = /\b(ceo|chief executive|president|chair(man|woman|person)?|co-?founder|founder|owner|proprietor|managing director|general partner)\b/i;
// ── THE PARENT COMPANY'S LEADERSHIP IS NOT THIS LOCATION'S ──────────────────
// A local franchise or chain location went down the local lane, where
// "founder" is a fine title for a corner shop, so it was given the parent
// company's founder: Chris Tomshack (HealthSource's franchise founder), Todd
// Carmichael (La Colombe's co-founder), Ernest Garcia III for Carvana Tempe.
// At a chain location the people who can say yes are the franchise owner and
// the location's manager. So a founder / CEO / chair / president is refused
// there unless the title is scoped to the location.
//   a chain location: on the national-chains list; named for the town it is in
//   ("Carvana Tempe", "HealthSource of Tempe"); a title that names a corporate
//   parent ("... Franchising", "... Holdings", "corporate"); or a person found
//   on a page about public figures (Wikipedia, Forbes, Bloomberg ...), where
//   the owner of a corner shop does not appear.
const PARENT_EXEC = /\b(ceo|chief executive|chair(man|woman|person)?|co-?founder|founder|president|managing director|general partner|executive chairman)\b/i;
const LOCATION_SCOPED = /\b(franchise(e|\s+owner|\s+partner)?|owner[\/ -]operator|operator|general manager|store manager|branch manager|location manager|clinic director|office manager|area|regional|district|market)\b/i;
const CORPORATE = /\b(franchising|franchise system|franchisor|corporate|corporation|holdings|brands|worldwide|international|global|nationwide|headquarters)\b/i;
const FIGUREHEAD_SOURCE = /\b(wikipedia\.org|forbes\.com|bloomberg\.com|crunchbase\.com|businessinsider\.com|nytimes\.com|wsj\.com|fortune\.com|cnbc\.com|inc\.com|entrepreneur\.com|fastcompany\.com|theorg\.com|zoominfo\.com|craft\.co)\b/i;
function chainLocation({ brand, city, title, sourceUrl } = {}) {
  const b = String(brand || '').toLowerCase();
  const c = String(city || '').split(',')[0].trim().toLowerCase();
  if (b && require('./nationalChains').isNationalChain(b)) return 'a national chain';
  // The town AFTER a brand ("Carvana Tempe", "HealthSource of Tempe",
  // "Orangetheory - Tempe"): a location. The town first ("Tempe Tattoo") is a
  // local business named for its town.
  if (c.length >= 4) {
    const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = b.match(new RegExp('^(.*?)\\s*(?:\\bof\\b|\\bin\\b|\\bat\\b|-|–|,)?\\s*' + esc + '(?:\\s+(?:location|store|clinic|office))?\\s*$'));
    if (m && m[1].replace(/[^a-z]/g, '').length >= 3) return `a location named for ${city}`;
  }
  if (CORPORATE.test(String(title || ''))) return 'a title naming the corporate parent';
  if (FIGUREHEAD_SOURCE.test(String(sourceUrl || ''))) return 'a person found on a public-figure page';
  return null;
}
function titleProblem(title, opts = {}) {
  const t = String(title || '').trim();
  if (NEVER_TITLE.test(t)) return `"${t}" is not someone who signs an athlete deal (emeritus, retired, a board seat or a school's leadership)`;
  // "Owner" at a franchise location is the franchisee; only a title that also
  // names the corporate parent is refused.
  const ownerTitle = /\b(co-?)?owner\b/i.test(t) && !CORPORATE.test(t);
  if (!opts.large && PARENT_EXEC.test(t) && !LOCATION_SCOPED.test(t) && !ownerTitle) {
    const c = String(opts.city || '').split(',')[0].trim();
    const scopedToTown = c.length >= 4 && t.toLowerCase().includes(c.toLowerCase());
    const chain = !scopedToTown && chainLocation({ brand: opts.brand, city: opts.city, title: t, sourceUrl: opts.sourceUrl });
    if (chain) return `"${t}" is the parent company's leadership, not this location's (${chain}); we want the franchise owner or the location's manager`;
  }
  if (opts.large) {
    if (DECIDES.test(t)) return null;
    if (TOP_EXEC.test(t)) return `"${t}" at a company this size is someone we would never reach; we want the marketing or partnerships decision maker`;
    return `"${t}" is not the marketing or partnerships decision maker`;
  }
  return null;
}

// A title the greeting guard would accept: a decision maker or a manager,
// not a placeholder. A missing title becomes the role we searched for.
function acceptableTitle(title, fallback) {
  const t = String(title || '').trim() || fallback;
  const a = CR.authorityOf(t);
  if (!a || a.rank >= CR.RANK.PLACEHOLDER) return null;
  return t;
}

// search: (prompt, sys) => text. Injected so the job passes the labelled,
// metered primitive and a test passes a stub.
//   -> { name, title, sourceUrl, query, confidence } | null
// order: the query keys to run, in order. The default asks for the owner
// first; a pro athlete's job passes ['marketing', 'owner'] so the marketing
// director is found first and the owner is the fallback (services/proLane).
async function findOwnerName({ brand, city, search, say, order, large }) {
  const b = String(brand || '').trim();
  const c = String(city || '').trim();
  if (!b) return null;
  // The default (a local business): owner, marketing, LinkedIn, the social /
  // review owner. 'partnerships' is asked for only when named (LARGE_ORDER).
  const queries = Array.isArray(order) && order.length ? order.map((k) => QUERIES.find((q) => q.key === k)).filter(Boolean)
    : QUERIES.filter((q) => q.key !== 'partnerships');
  // How many searches actually answered. If NONE did, "no name" is not an
  // answer about the business, it is our outage (services/ourFault): thrown,
  // so it is never cached and never recorded as "no name found".
  let answered = 0, lastErr = null;
  for (const q of queries) {
    const prompt = `Search for: ${q.q(b, c)}\nBusiness: ${b}${c ? `\nCity: ${c}` : ''}\nWho is ${q.ask} of this business? Use only what the pages say.`;
    let out = null;
    try { out = await search(prompt, SYS); answered++; }
    catch (e) { lastErr = e; if (say) say(`${b}: owner search (${q.key}) failed: ${e.message}`); continue; }
    // THE SEARCH RETURNS AN OBJECT, NOT A STRING. ai.webSearchJson (the
    // primitive the job injects) returns { text, citations, searches, ... };
    // this read it as a string, so every answer parsed as "[object Object]"
    // and the last door never found anyone in production. The text is read
    // off the object, and the first citation stands in for a missing sourceUrl.
    const text = (out && typeof out === 'object') ? out.text : out;
    const cited = (out && typeof out === 'object' && Array.isArray(out.citations) && out.citations[0]) || null;
    const j = parseJson(text);
    if (!j || !j.name) continue;
    if (!looksLikePerson(j.name, b)) { if (say) say(`${b}: owner search (${q.key}) returned "${j.name}", not a person's name; refused`); continue; }
    const fallback = q.key === 'marketing' ? 'Marketing Director' : q.key === 'partnerships' ? 'Head of Partnerships' : 'Owner';
    const title = acceptableTitle(j.title, fallback);
    if (!title) { if (say) say(`${b}: owner search (${q.key}) named ${j.name} as "${j.title}", not a decision maker; refused`); continue; }
    const tp = titleProblem(j.title || title, { large, brand: b, city: c, sourceUrl: j.sourceUrl || cited });
    if (tp) { if (say) say(`${b}: owner search (${q.key}) named ${j.name}: ${tp}; refused`); continue; }
    return { name: String(j.name).trim().replace(/\s+/g, ' '), title, sourceUrl: j.sourceUrl || cited || null, query: q.key, confidence: String(j.confidence || 'low') };
  }
  if (!answered && lastErr) {
    const OF = require('./ourFault');
    throw OF.isOurFault(lastErr) ? lastErr : OF.fault('owner-name-search', lastErr.message || String(lastErr));
  }
  return null;
}

// The row the ladder gets when the last door found someone. Tier 1 when the
// title is owner-level or marketing leadership, tier 2 for a manager, so the
// card and the greeting read the same judgement the ladder would have made.
function ladderRowFor(found) {
  const a = CR.authorityOf(found.title);
  const tier = a.rank <= CR.RANK.MARKETING_LEAD ? 1 : 2;
  return {
    tier,
    row: {
      name: found.name, title: found.title, rank: a.rank, email: null, phone: null,
      source: 'owner-search', sources: ['owner-search'], sourceUrl: found.sourceUrl || null,
      confidence: found.confidence === 'high' ? 'Confident' : 'Likely',
      unconfirmed: false, affiliationScope: 'search',
      sourceNote: `Named by a web search for "${({ owner: 'owner', marketing: 'marketing director', linkedin: 'LinkedIn owner', social: 'Instagram or Google-review owner' })[found.query] || 'owner'}"${found.sourceUrl ? ' at ' + found.sourceUrl : ''}`,
      channel: 'mainline', reachVia: null, askAs: found.name.split(' ')[0],
    },
  };
}

// Put the found person onto the ladder in place, so buildCard, the greeting
// guard and the writer all see them the way they see any other named row.
function attachToLadder(ladder, found) {
  const L = ladder || { tiers: [] };
  if (!Array.isArray(L.tiers)) L.tiers = [];
  const { tier, row } = ladderRowFor(found);
  let t = L.tiers.find((x) => x.tier === tier);
  if (!t) {
    t = { tier, label: tier === 1 ? 'Owner or marketing decision maker' : 'GM or manager', rows: [] };
    L.tiers.push(t);
    L.tiers.sort((x, y) => x.tier - y.tier);
  }
  t.rows.unshift(row);
  return L;
}

const NO_NAME_REASON = 'no contact name found after all sources, including the final owner and marketing-director search';

// What a large brand is searched for: its partnerships lead, then marketing.
// Never its owner or founder.
const LARGE_ORDER = ['partnerships', 'marketing'];

module.exports = { titleProblem, chainLocation, NEVER_TITLE, LARGE_ORDER, findOwnerName, looksLikePerson, acceptableTitle, parseJson, ladderRowFor, attachToLadder, QUERIES, SYS, NO_NAME_REASON };
