'use strict';
// ── THE TITLE AS SHOWN ON A CARD (CARD_RULES_ON) ────────────────────────────
//
// A contact's title often carries where it came from: "Owner (per news)",
// "Registered Agent (state filing)", "Owner (operator, per news report)".
// That note is for us -- contactRank and the greeting guard read it to decide
// how far to trust the title -- and it stays in the record. On a card it
// reads like a hedge to the agent, and in an email like a citation, so the
// title SHOWN is the title without it.
//
// Only a source note is removed: a bracket that names where the title came
// from (news, a filing, a registry, records, a website, a listing). "(Tempe)"
// or "(not confirmed owner)" says something about the person and stays.
//
// Off (the default), every title is shown exactly as stored.

const ON = () => process.env.CARD_RULES_ON === '1';
const SOURCE_WORDS = /\b(per|via|according to|source[ds]?|news|press|article|report(ed|s)?|filings?|secretary of state|registry|registered|records?|linkedin|website|site|google|yelp|facebook|instagram|directory|listing|chamber|bbb|public)\b/i;

function stripSourceNotes(title) {
  const t = String(title == null ? '' : title);
  const out = t.replace(/\s*\(([^()]*)\)/g, (whole, inner) => (SOURCE_WORDS.test(inner) ? '' : whole))
    .replace(/\s{2,}/g, ' ').replace(/[\s,;:–—-]+$/, '').trim();
  return out;
}

// The title to show. Never empties a title that was only a note: then the
// stored one is shown rather than nothing.
function displayTitle(title) {
  if (title == null) return title;
  if (!ON()) return title;
  const s = stripSourceNotes(title);
  return s || title;
}

module.exports = { displayTitle, stripSourceNotes, ON };
