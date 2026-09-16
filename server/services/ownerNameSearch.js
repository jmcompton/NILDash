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
async function findOwnerName({ brand, city, search, say }) {
  const b = String(brand || '').trim();
  const c = String(city || '').trim();
  if (!b) return null;
  for (const q of QUERIES) {
    const prompt = `Search for: ${q.q(b, c)}\nBusiness: ${b}${c ? `\nCity: ${c}` : ''}\nWho is ${q.ask} of this business? Use only what the pages say.`;
    let text = null;
    try { text = await search(prompt, SYS); }
    catch (e) { if (say) say(`${b}: owner search (${q.key}) failed: ${e.message}`); continue; }
    const j = parseJson(text);
    if (!j || !j.name) continue;
    if (!looksLikePerson(j.name, b)) { if (say) say(`${b}: owner search (${q.key}) returned "${j.name}", not a person's name; refused`); continue; }
    const fallback = q.key === 'owner' ? 'Owner' : 'Marketing Director';
    const title = acceptableTitle(j.title, fallback);
    if (!title) { if (say) say(`${b}: owner search (${q.key}) named ${j.name} as "${j.title}", not a decision maker; refused`); continue; }
    return { name: String(j.name).trim().replace(/\s+/g, ' '), title, sourceUrl: j.sourceUrl || null, query: q.key, confidence: String(j.confidence || 'low') };
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
      sourceNote: `Named by a web search for "${found.query === 'owner' ? 'owner' : 'marketing director'}"${found.sourceUrl ? ' at ' + found.sourceUrl : ''}`,
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

module.exports = { findOwnerName, looksLikePerson, acceptableTitle, parseJson, ladderRowFor, attachToLadder, QUERIES, SYS, NO_NAME_REASON };
