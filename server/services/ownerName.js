'use strict';
// ── THE OWNER FIELD HOLDS ONE PERSON'S NAME ─────────────────────────────────
//
// My Brands showed this in the Owner column for Wilvet South:
//
//   "The practice is led by Dr. Sarah Wilson, Dr. James Vetter, Dr. Amy Chen,
//    Dr. Mark Ross and Dr. Lisa Kim"
//
// A hundred and three characters, five people, and a verb. It is a sentence a
// research call wrote about the business, stored in a column whose entire job
// is to answer "who do I ask for when I call". It reached the card because
// services/outreachQueue.personNameProblem checked that the value was not a
// ROLE and not an ORGANISATION, and never checked that it was ONE PERSON or
// that it was a NAME rather than prose.
//
// Worse than useless: the pitch writer greets the contact by name, so a
// sentence in this field is a sentence in the greeting of a cold email to a
// real business.
//
// ── WHAT THIS REFUSES, AND WHY EACH TEST ────────────────────────────────────
//
// A VERB. Names do not contain "is", "owned", "leads", "founded". This is the
// test that catches prose outright, and it is checked on word boundaries so
// "Isley", "Owens" and "Ledbetter" are not caught by "is", "owns" and "led".
//
// MORE THAN ONE PERSON. Split on commas, "and" and "&", drop the segments that
// are roles ("Dana Whitfield, Owner" is one person and a title), and refuse
// what is left if it still names two. One column, one person; a business with
// two owners gets the first, not both jammed together.
//
// DIGITS AND COLONS. A year, a phone number, a suite number or a "Owner:"
// label are all signs of something that is not a bare name.
//
// FORTY CHARACTERS. Long enough for "Maria Fernanda Rodriguez de la Cruz" and
// every real name this codebase has seen; short enough that nothing resembling
// a sentence survives. It is a backstop, not the main test -- the rules above
// catch prose that happens to be short.
//
// ── AND WHAT IT DOES NOT DO ─────────────────────────────────────────────────
// It does not invent a name. clean() strips a label or a trailing title off a
// value that already holds one name; extract() pulls the FIRST person out of a
// sentence that names several, which is a real person at that business and the
// one the sentence named first. Neither will guess, and both return null
// rather than return something they are not sure about -- an empty Owner
// column is honest, and a wrong name in the greeting of a cold email is not.

const MAX_LEN = 40;

// Verbs and connectives that only appear in prose. Word-boundaried on purpose.
const PROSE_RE = /\b(?:is|are|was|were|be|been|being|owns?|owned|leads?|led|runs?|ran|founded|co-?founded|manages?|managed|operates?|operated|serves?|served|includes?|included|including|works?|worked|provides?|offers?|specialis(?:e|es|ing)|specializ(?:e|es|ing)|established|started|opened|staffed|comprises?|consists?|who|whom|whose|which|they|their|them)\b/i;

// A role or a department, not a person. Deliberately narrow: only words that
// are never a surname.
const ROLE_SEGMENT_RE = /^(?:the\s+)?(?:owner|co-?owner|founder|co-?founder|president|vice\s+president|vp|manager|general\s+manager|gm|director|managing\s+director|principal|partner|proprietor|ceo|coo|cfo|cmo|md|dvm|dds|phd|esq|operator|team|staff|management|ownership|others?|more|etc\.?)$/i;

const HONORIFIC = '(?:dr|mr|mrs|ms|miss|prof|professor|doctor|coach|rev|fr|sr|capt|sgt)\\.?';

function norm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// The segments a value names, once roles are dropped. "Dana Whitfield, Owner"
// -> ["Dana Whitfield"]. "Ann Lee and Bob Ray" -> ["Ann Lee", "Bob Ray"].
function peopleSegments(value) {
  return norm(value)
    .split(/\s*(?:,|\band\b|&|\/|\bor\b|;)\s*/i)
    .map((s) => norm(s))
    .filter(Boolean)
    .filter((s) => !ROLE_SEGMENT_RE.test(s));
}

// problem(name, brandName) -> a sentence saying what is wrong, or null.
// Checked IN ADDITION to outreachQueue.personNameProblem, which still owns
// "is this a role", "is this an organisation" and "can it be greeted".
function problem(name, brandName) {
  const n = norm(name);
  if (!n) return 'no owner name';
  if (n.length > MAX_LEN) return `${n.length} characters: an owner field holds one person's name, not a sentence`;
  if (/\d/.test(n)) return 'contains a digit, so it is not a bare name';
  if (/[:;]/.test(n)) return 'contains a label separator, so it is not a bare name';
  // A FULL STOP IS NOT ALWAYS A SENTENCE END. "Dr. Sarah Wilson" and "J. R.
  // Whitfield" are names; both were rejected by a naive "period, space,
  // letter" test. Honorifics and single-letter initials come out first, and
  // what is left is tested for a real sentence break.
  const abbrevless = n
    .replace(new RegExp('\\b' + HONORIFIC + '\\s*', 'gi'), '')
    .replace(/\b[A-Z]\.\s*/g, '');
  if (/[.!?]\s+\S/.test(abbrevless)) return 'runs to a second sentence';
  const prose = n.match(PROSE_RE);
  if (prose) return `contains "${prose[0]}", so it is prose and not a name`;
  const segs = peopleSegments(n);
  if (segs.length > 1) return `names ${segs.length} people; the owner field holds one`;
  if (!segs.length) return 'is a role or a title with no name in it';
  // NOTHING ELSE. "Dana Whitfield, Owner" names one person, and the title is
  // still something other than a name sitting in a name column. The write path
  // refuses it so clean() has to strip it first; clean() then re-checks and
  // this test passes, because by then the value IS just the name.
  if (norm(segs[0]) !== n.replace(/[,;:]+$/, '')) return 'carries a title or a note as well as the name';
  // The business is not its own owner. outreachQueue.personNameProblem makes
  // the same check; it is repeated here so this module is safe to call on its
  // own, which the repair script does.
  if (brandName && n.toLowerCase() === norm(brandName).toLowerCase()) return 'is the business name, not a person';
  return null;
}

// clean(name, brandName) -> one person's name, or null.
// Strips a leading label ("Owner: Dana Whitfield") and a trailing title
// ("Dana Whitfield, Owner"), then accepts only what passes problem().
// It never reaches into a sentence -- that is extract()'s job, and the two are
// separate so the write path can be strict while the repair script is allowed
// to be cleverer.
function clean(name, brandName) {
  let n = norm(name);
  if (!n) return null;
  n = n.replace(/^(?:owner|contact|manager|gm|principal|proprietor|founder)\s*[:\-–]\s*/i, '');
  const segs = peopleSegments(n);
  if (segs.length === 1) n = segs[0];
  n = norm(n).replace(/[,;:]+$/, '');
  if (brandName && n.toLowerCase() === norm(brandName).toLowerCase()) return null;
  return problem(n, brandName) ? null : n;
}

// extract(value, brandName) -> the FIRST person named in a sentence, or null.
// Used by the repair script on rows that are already stored, never by a write
// path. "The practice is led by Dr. Sarah Wilson, Dr. James Vetter, ..." gives
// "Dr. Sarah Wilson": a real person at that business, and the one the sentence
// put first.
//
// A candidate is an optional honorific plus two or three capitalised words. The
// business's own name is skipped, so "Wilvet South is owned by Dr. Ann Lee"
// does not yield "Wilvet South".
const NAME_RE = new RegExp(
  `\\b(${HONORIFIC}\\s+)?([A-Z][a-z'’\\-]{1,20}(?:\\s+(?:de|del|della|der|van|von|da|di|la|le|bin|al)\\b)?(?:\\s+[A-Z][a-z'’\\-]{1,20}){1,2})\\b`, 'g');
function extract(value, brandName) {
  const v = norm(value);
  if (!v) return null;
  const direct = clean(v, brandName);
  if (direct) return direct;
  const brand = norm(brandName).toLowerCase();
  NAME_RE.lastIndex = 0;
  let m;
  while ((m = NAME_RE.exec(v))) {
    const candidate = norm((m[1] || '') + m[2]);
    const bare = norm(m[2]);
    if (brand && (bare.toLowerCase() === brand || brand.includes(bare.toLowerCase()))) continue;
    // The candidate has to stand on its own as an owner name.
    const cleaned = clean(candidate, brandName);
    if (cleaned) return cleaned;
  }
  return null;
}

module.exports = { MAX_LEN, PROSE_RE, ROLE_SEGMENT_RE, norm, peopleSegments, problem, clean, extract };
