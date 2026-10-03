'use strict';
// ── CATCH THE SCHOOL AT THE MOMENT IT IS TYPED ───────────────────────────────
//
// An athlete whose school does not resolve has no local market, and the local
// lane is most of the product. Before this, that failure was INVISIBLE at entry:
// the form accepted anything, and the consequence showed up days later as an
// athlete who quietly got nothing every night. We spent a day debugging exactly
// that, and then built an admin page to find the 21 athletes it had already
// happened to.
//
// The fix is to fail at the keyboard, where the agent still has the answer in
// their head. This is that check: resolve what they typed, and when it does not
// match, say so immediately and offer the near misses so correcting it is one
// click rather than a research task.
//
// IT NEVER BLOCKS. An agent who insists on a school we cannot match is allowed
// to proceed -- some schools are real and simply not in our list, and refusing
// their client would be worse than a thin local lane. What they are not allowed
// to do is finish WITHOUT KNOWING, so the warning is explicit and names the
// consequence.
const { resolveSchool, SHIPPED_NAMES, EXTRA_SCHOOLS, normalize, core, similarity, levenshtein } = require('./schoolResolver');

// Near misses worth offering. Below this a suggestion is noise -- offering
// "Auburn University" to someone who typed "Zzz" helps nobody.
const SUGGEST_MIN = 0.55;
const MAX_SUGGESTIONS = 4;

function allNames() {
  const out = new Set();
  for (const k of Object.keys(EXTRA_SCHOOLS || {})) out.add(k);
  for (const k of (SHIPPED_NAMES || [])) out.add(k);
  return [...out];
}

// What did they probably mean? Scored on the WORDS of the name, so a
// suggestion shares something the agent actually typed. "Western New Mexico
// University" used to be offered Western Kentucky and West Virginia: the old
// character similarity saw "western" and "university" and nothing else. Now:
//   - direction words (western, eastern, north, state, tech...) and
//     institution words count for nothing on their own
//   - a distinctive word shared with the name counts (new, mexico)
//   - the name's STATE counts when the agent typed it, in either form
//     ("New Mexico", "NM")
//   - the old character similarity only breaks ties among names that share
//     a word, and a near-typo of the whole name still ranks first
// A name that shares no distinctive word and no state is never offered.
const GENERIC_WORDS = new Set(['university', 'univ', 'college', 'of', 'the', 'at', 'state', 'tech', 'technology', 'institute', 'academy',
  'western', 'eastern', 'northern', 'southern', 'central', 'north', 'south', 'east', 'west', 'saint', 'st', 'and', 'a', 'm', 'community', 'polytechnic', 'in', 'for']);
const STATE_WORDS = (() => {
  const { US_STATES } = require('./schoolResolver');
  const m = new Map();
  for (const [name, abbr] of Object.entries(US_STATES || {})) { m.set(name, abbr); m.set(abbr.toLowerCase(), abbr); }
  return m;
})();
function _words(s) { return normalize(String(s || '')).split(/[^a-z0-9]+/).filter(Boolean); }
// The distinctive words of a name, and the state it names (a state name may be
// two words: "new mexico", "north carolina").
function _nameParts(s) {
  const words = _words(s);
  const joined = words.join(' ');
  let state = null;
  for (const [k, abbr] of STATE_WORDS) { if (k.length > 2 && new RegExp('(^| )' + k + '( |$)').test(joined)) { state = abbr; break; } }
  if (!state) for (const w of words) if (w.length === 2 && STATE_WORDS.has(w) && words.length > 1) { state = STATE_WORDS.get(w); break; }
  const stateWords = new Set(state ? [...STATE_WORDS.keys()].filter((k) => STATE_WORDS.get(k) === state).flatMap((k) => k.split(' ')) : []);
  const distinctive = words.filter((w) => !GENERIC_WORDS.has(w) && !stateWords.has(w));
  return { words, distinctive, state };
}
function suggestionsFor(raw, limit = MAX_SUGGESTIONS) {
  const q = String(raw || '').trim();
  if (q.length < 3) return [];
  const c = core(q);
  const qp = _nameParts(q);
  const scored = [];
  for (const name of allNames()) {
    const np = _nameParts(name);
    const shared = np.distinctive.filter((w) => qp.distinctive.includes(w));
    const stateMatch = !!(qp.state && np.state && qp.state === np.state);
    const sim = Math.max(similarity(core(name), c), similarity(normalize(name), normalize(q)));
    // A misspelling of the whole name: within two edits, and only when the
    // agent typed a distinctive word at all ("Western University" is two edits
    // from "Eastern University" and means neither).
    const typo = qp.distinctive.length > 0 && sim >= 0.86 && levenshtein(core(name), c) <= 2;
    if (!shared.length && !stateMatch && !typo) continue;
    // Shared words first, the state next, the character similarity last.
    // A whole-name typo outranks a shared word: it IS the name, misspelt.
    const score = Math.min(1, (shared.length / Math.max(1, qp.distinctive.length)) * 0.6 + (stateMatch ? 0.25 : 0) + sim * 0.15 + (typo ? 0.6 : 0));
    if (score >= SUGGEST_MIN * 0.5) scored.push({ name, score: Math.round(score * 100) / 100 });
  }
  scored.sort((a, b) => b.score - a.score);
  // Verified before offering: a suggestion that does not itself resolve would
  // send the agent round the same loop again.
  return scored.slice(0, limit * 2)
    .map((x) => ({ ...x, loc: resolveSchool(x.name) }))
    .filter((x) => x.loc && x.loc.city)
    .slice(0, limit)
    .map((x) => ({ name: x.name, city: x.loc.city, state: x.loc.state, score: x.score }));
}

function checkSchool(raw) {
  const input = String(raw || '').trim();
  if (!input) {
    return { ok: false, status: 'empty', matched: null, market: null,
      message: 'Add a school so the local lane has a town to work in.',
      suggestions: [] };
  }
  const hit = resolveSchool(input);
  if (hit && hit.city) {
    return {
      ok: true,
      status: 'matched',
      matched: hit.matched,
      market: hit.state ? `${hit.city}, ${hit.state}` : hit.city,
      city: hit.city, state: hit.state,
      method: hit.method, confidence: hit.confidence,
      // Says what it will DO, not that a lookup succeeded. "Matched with
      // confidence 0.91" is a developer's sentence.
      message: `Local businesses will be found around ${hit.city}${hit.state ? ', ' + hit.state : ''}.`,
      suggestions: [],
    };
  }
  const suggestions = suggestionsFor(input);
  return {
    ok: false,
    status: 'unmatched',
    matched: null, market: null,
    // THE CONSEQUENCE, NAMED. Not "invalid school" -- the agent needs to know
    // what it costs them, or they will click past it.
    message: suggestions.length
      ? `We could not match "${input}" to a town. Pick the right one below, or keep it and this athlete will only get national and social brands.`
      : `We could not match "${input}" to a town. You can keep it, but this athlete will only get national and social brands, not local businesses.`,
    suggestions,
  };
}

module.exports = { checkSchool, suggestionsFor, SUGGEST_MIN, MAX_SUGGESTIONS };
