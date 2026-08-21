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
const { resolveSchool, SHIPPED_NAMES, EXTRA_SCHOOLS, normalize, core, similarity } = require('./schoolResolver');

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

// What did they probably mean? Scored on the same similarity the resolver uses,
// so a suggestion that appears here will actually resolve when clicked.
function suggestionsFor(raw, limit = MAX_SUGGESTIONS) {
  const q = String(raw || '').trim();
  if (q.length < 3) return [];
  const c = core(q);
  const scored = [];
  for (const name of allNames()) {
    const s = Math.max(similarity(core(name), c), similarity(normalize(name), normalize(q)));
    if (s >= SUGGEST_MIN) scored.push({ name, score: Math.round(s * 100) / 100 });
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
