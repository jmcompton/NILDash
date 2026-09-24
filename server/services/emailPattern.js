'use strict';
// ── A DOMAIN'S ADDRESS PATTERN, AND AN ADDRESS BUILT FROM IT ────────────────
//
// Hunter's Domain Search returns `data.pattern` -- how this domain spells its
// people's addresses: "{first}", "{first}.{last}", "{f}{last}", "{first}_{l}".
// We used to throw it away and keep only the addresses it listed. With the
// owner's name from another source and the pattern, the owner's address can be
// built. It is Tier 2 (services/emailTier): likely right, never seen written
// down, and marked as such everywhere it goes.
//
// When Hunter gives no pattern but lists one real person's address WITH that
// person's name, the pattern is read off that address (inferPattern).
//
// Nothing here spends anything or calls anything.

const TOKENS = ['{first}', '{last}', '{f}', '{l}'];

// Names reduced to what can appear in a mailbox: lower case, accents off,
// letters only. "José O'Neil-Smith" -> jose, oneilsmith.
function _clean(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z]/g, '');
}

// First and last name from a full name. Titles and suffixes are dropped;
// a single-word name has no last name, so only a {first} pattern can use it.
function splitName(full) {
  const words = String(full || '').replace(/\([^)]*\)/g, ' ').split(/[\s,]+/).filter(Boolean)
    .filter((w) => !/^(mr|mrs|ms|dr|jr|sr|ii|iii|iv|md|dds|dvm|phd|esq)\.?$/i.test(w));
  if (!words.length) return null;
  const first = _clean(words[0]);
  const last = words.length > 1 ? _clean(words[words.length - 1]) : '';
  return first ? { first, last } : null;
}

// Hunter's string, checked. Only the four tokens and . _ - separators are
// accepted: anything else is a pattern we do not understand, and a wrong guess
// is an email to a stranger's mailbox.
function normalizePattern(p) {
  const s = String(p || '').trim().toLowerCase();
  if (!s || !/\{(first|last|f|l)\}/.test(s)) return null;
  const rest = s.replace(/\{(first|last|f|l)\}/g, '');
  if (!/^[._-]*$/.test(rest)) return null;
  return s;
}

// Build the local part for a name, or null when the pattern needs a part of the
// name we do not have.
function localFor(pattern, name) {
  const p = normalizePattern(pattern);
  const n = typeof name === 'string' ? splitName(name) : name;
  if (!p || !n || !n.first) return null;
  if (/\{(last|l)\}/.test(p) && !n.last) return null;
  return p.replace(/\{first\}/g, n.first).replace(/\{last\}/g, n.last)
    .replace(/\{f\}/g, n.first[0]).replace(/\{l\}/g, n.last ? n.last[0] : '');
}

function construct(pattern, name, domain) {
  const lp = localFor(pattern, name);
  const d = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!lp || !d || !/\./.test(d)) return null;
  return `${lp}@${d}`;
}

// Read the pattern off one known address and the name of the person it belongs
// to. Tries every shape we can build and keeps the one that reproduces the
// local part exactly. Ambiguity is refused rather than guessed at: when two
// different patterns reproduce it (a person named "Al Al"), there is no answer.
const CANDIDATES = (() => {
  const out = [];
  const seps = ['', '.', '_', '-'];
  for (const s of seps) {
    out.push(`{first}${s}{last}`, `{last}${s}{first}`, `{f}${s}{last}`, `{first}${s}{l}`,
      `{last}${s}{f}`, `{l}${s}{first}`, `{f}${s}{l}`);
  }
  out.push('{first}', '{last}');
  return [...new Set(out)];
})();

function inferPattern(email, name) {
  const e = String(email || '').trim().toLowerCase();
  const lp = e.split('@')[0];
  const n = typeof name === 'string' ? splitName(name) : (name && name.first ? { first: _clean(name.first), last: _clean(name.last) } : null);
  if (!lp || !n || !n.first) return null;
  const hits = new Set();
  for (const p of CANDIDATES) {
    if (localFor(p, n) === lp) hits.add(p);
  }
  // {first}{last} and {first}.{last} can never both match; the same local part
  // matching several shapes only happens with repeated or one-letter names.
  return hits.size === 1 ? [...hits][0] : null;
}

// From a Hunter domain-search result: its own pattern, or one read off the
// best-confidence personal address that carries a name.
// Returns { pattern, from: 'hunter' | 'inferred', example, exampleSourceUrl } or null.
function patternFromHunter(h) {
  if (!h) return null;
  const own = normalizePattern(h.pattern);
  if (own) return { pattern: own, from: 'hunter', example: null, exampleSourceUrl: null };
  const people = (Array.isArray(h.emails) ? h.emails : [])
    .filter((x) => x && x.email && x.type !== 'generic' && x.firstName)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  for (const x of people) {
    const p = inferPattern(x.email, { first: x.firstName, last: x.lastName || '' });
    if (p) return { pattern: p, from: 'inferred', example: x.email, exampleSourceUrl: x.sourceUrl || null };
  }
  return null;
}

module.exports = { normalizePattern, localFor, construct, inferPattern, patternFromHunter, splitName, TOKENS, CANDIDATES };
