'use strict';
// One table, one entry per sport. Each sport declares its own inclusion; everything
// not matched is excluded by default.
//
// WHY THIS SHAPE. The guard used to be two different things: FOOTBALL_RE was the
// included sport and OTHER_SPORTS was a hand-maintained list of fifteen excluded
// ones. Adding a second sport to that meant maintaining a second exclusion list that
// had to stay the complement of the first. Here the exclusion list is DERIVED: every
// key except the one being scanned.
//
// THE ORDER OF THE GUARD IS THE WHOLE TRICK, because "BASKETBALL, MEN'S" and
// "BASKETBALL, WOMEN'S" both match /\bbasketball\b/. Ordering is the only thing that
// separates them:
//
//   1. excludeIfMatches   a sibling sharing the base word  -> BLOCKED
//   2. match              this sport                       -> allowed
//   3. any other sport    something else entirely          -> BLOCKED, named
//   4. nothing named      -> caller falls through to the page-level rule
//
// Step 1 before step 2 is what makes women's basketball fail for men's basketball
// even though the word "basketball" is right there.

const SPORTS = {
  football: {
    key: 'football',
    label: 'Football',
    slug: 'football',
    match: /\bfootball\b|\bgridiron\b|\bqb\b|\boffensive line\b|\bdefensive line\b/i,
    // Section HEADINGS are matched more narrowly than titles and free text. `match`
    // is deliberately wide so "QB Coach" reads as football; but a football-only page
    // that groups its staff under "Offensive Line" and "Defensive Line" would then
    // look department-wide and get filtered down to those two groups, dropping the
    // strength and support staff. Headings therefore test the sport NAME only.
    sectionMatch: /\bfootball\b/i,
    // Whole tokens only, for email addresses. Never substrings: "patrick" must not
    // match "track" and "jbaseball" must not match "baseball".
    tokens: ['football', 'fb', 'fball'],
    // Sweep candidates, in order. The two bare paths stay LAST: they are the most
    // likely to resolve to a department-wide page.
    paths: [
      '/sports/football/coaches',
      '/sports/football/coaches/',
      '/sports/football/staff',
      '/staff-directory/department/football',
      '/staff-directory?path=football',
      '/staff-directory/football',
      '/coaches.aspx?path=football',
      '/sports/football/roster/staff',
      '/sports/football/coaches/2026',
      '/sports/football/coaches/1000',
      '/staff-directory/?path=football',
      '/coaches',
      '/football/coaches',
    ],
    roles: [
      { key: 'general_manager', label: 'General Manager / Football Ops', match: /\bgeneral manager\b|\bgm\b|chief of staff|director of football operations|football operations|executive director of football|director of football management|\bfootball management\b|\bfootball administration\b/i },
      { key: 'player_personnel', label: 'Player Personnel', match: /player personnel|\bpersonnel\b|\bscouting\b/i },
      { key: 'recruiting', label: 'Recruiting', match: /recruiting|recruitment/i },
      { key: 'head_coach', label: 'Head Coach', match: /\bhead\s+(?:football\s+)?coach\b/i },
      { key: 'collective_director', label: 'NIL Collective Director', match: /\bcollective\b|\bnil\b/i },
    ],
    // Position groups that make a coaching title a decision maker.
    positionGroups: /\b(quarterbacks?|running ?backs?|wide ?receivers?|receivers?|tight ?ends?|offensive line(men)?|o-?line|defensive line(men)?|d-?line|linebackers?|cornerbacks?|safet(y|ies)|secondary|defensive backs?|special teams|edge|nickel|tackles?|guards?|centers?|running game|passing game|run game|pass game)\b/i,
    // A real football directory returns 60 to 110 people.
    thresholds: { minKeyRoles: 3, minStaff: 5 },
    verifiedUrls: {
      'Alabama': 'https://rolltide.com/sports/football/coaches',
      'Georgia': 'https://georgiadogs.com/sports/football/coaches',
      'Ole Miss': 'https://olemisssports.com/sports/football/coaches',
      'Florida': 'https://floridagators.com/sports/football/coaches/',
      'South Carolina': 'https://gamecocksonline.com/staff-directory/football-803-777-4271/',
    },
  },

  mens_basketball: {
    key: 'mens_basketball',
    label: "Men's Basketball",
    slug: 'mens-basketball',
    match: /\bbasketball\b|\bhoops\b|\bmbb\b|\bmbball\b/i,
    tokens: ['basketball', 'mbb', 'mbball', 'bball', 'hoops', 'mensbasketball'],
    // Women's basketball shares the base word, so it has to be actively excluded
    // rather than merely not-matched.
    excludeIfMatches: /\bwomen'?s?\b|\bwbb\b|\bwbball\b|\blady\b/i,
    excludeTokens: ['wbb', 'wbball', 'womensbasketball', 'womens'],
    // No bare /coaches equivalent on purpose: /coaches on most athletics sites IS
    // the football page, and a hand-set URL is the right answer for the schools
    // that need one.
    paths: [
      '/sports/mens-basketball/coaches',
      '/sports/mens-basketball/coaches/',
      '/sports/mbball/coaches',
      '/sports/mens-basketball/staff',
      '/staff-directory/department/mens-basketball',
      '/staff-directory?path=mbball',
      '/staff-directory?path=mens-basketball',
      '/sports/mens-basketball/roster/staff',
    ],
    roles: [
      { key: 'general_manager', label: 'General Manager', match: /\bgeneral manager\b|\bgm\b|chief of staff/i },
      { key: 'basketball_ops', label: 'Basketball Operations', match: /basketball operations|director of operations|\bbasketball administration\b|\bbasketball management\b/i },
      { key: 'player_personnel', label: 'Player Personnel / Recruiting', match: /player personnel|\bpersonnel\b|\bscouting\b|recruiting|recruitment/i },
      { key: 'head_coach', label: 'Head Coach', match: /\bhead\s+(?:men'?s?\s+)?(?:basketball\s+)?coach\b/i },
      { key: 'assistant_coach', label: 'Assistant Coach', match: /\bassistant coach\b|\bassociate head coach\b|\bassistant head coach\b/i },
    ],
    positionGroups: /\b(guards?|forwards?|centers?|post|perimeter|big ?men|wings?|player development)\b/i,
    // Basketball staffs are much smaller. A page with a head coach and one
    // assistant is a real page, not a failure.
    thresholds: { minKeyRoles: 2, minStaff: 3 },
    verifiedUrls: {},
  },

  womens_basketball: {
    key: 'womens_basketball',
    label: "Women's Basketball",
    slug: 'womens-basketball',
    // Matches "Women's Basketball" and "BASKETBALL, WOMEN'S" in either order.
    match: /\bwomen'?s?\b[\s\S]{0,20}\bbasketball\b|\bbasketball\b[\s\S]{0,20}\bwomen'?s?\b|\bwbb\b|\bwbball\b/i,
    tokens: ['wbb', 'wbball', 'womensbasketball'],
    // The mirror image of men's. Symmetric rather than a one-way special case.
    excludeIfMatches: /\bmen'?s?\b|\bmbb\b|\bmbball\b/i,
    excludeTokens: ['mbb', 'mbball', 'mensbasketball'],
    paths: [
      '/sports/womens-basketball/coaches',
      '/sports/womens-basketball/coaches/',
      '/sports/wbball/coaches',
      '/sports/womens-basketball/staff',
      '/staff-directory/department/womens-basketball',
      '/staff-directory?path=wbball',
      '/staff-directory?path=womens-basketball',
      '/sports/womens-basketball/roster/staff',
    ],
    roles: [
      { key: 'general_manager', label: 'General Manager', match: /\bgeneral manager\b|\bgm\b|chief of staff/i },
      { key: 'basketball_ops', label: 'Basketball Operations', match: /basketball operations|director of operations|\bbasketball administration\b/i },
      { key: 'player_personnel', label: 'Player Personnel / Recruiting', match: /player personnel|\bpersonnel\b|\bscouting\b|recruiting|recruitment/i },
      { key: 'head_coach', label: 'Head Coach', match: /\bhead\s+(?:women'?s?\s+)?(?:basketball\s+)?coach\b/i },
      { key: 'assistant_coach', label: 'Assistant Coach', match: /\bassistant coach\b|\bassociate head coach\b|\bassistant head coach\b/i },
    ],
    positionGroups: /\b(guards?|forwards?|centers?|post|perimeter|wings?|player development)\b/i,
    thresholds: { minKeyRoles: 2, minStaff: 3 },
    verifiedUrls: {},
  },
};

// ── Sports we never scan, but must still recognise ───────────────────────────
// These exist ONLY to be excluded. Dropping them when OTHER_SPORTS was replaced
// would have quietly un-blocked Missouri's baseball head coach on a football scan:
// with a derived exclusion list, a sport that is not in the table is a sport that
// nothing blocks. They carry no paths, roles or thresholds because they are never
// the sport being scanned.
const BLOCK_ONLY = [
  ['track', /\btrack\b|\bcross ?country\b|\btrack and field\b|\bt&f\b/i, ['track', 'xc', 'crosscountry', 'trackandfield', 'tf']],
  ['baseball', /\bbaseball\b/i, ['baseball']],
  ['softball', /\bsoftball\b/i, ['softball', 'sball']],
  ['soccer', /\bsoccer\b/i, ['soccer']],
  ['volleyball', /\bvolleyball\b/i, ['volleyball', 'vball']],
  ['golf', /\bgolf\b/i, ['golf']],
  ['tennis', /\btennis\b/i, ['tennis']],
  ['swimming', /\bswim\w*\b|\bdiving\b/i, ['swimming', 'swim', 'dive', 'diving']],
  ['gymnastics', /\bgymnastics\b/i, ['gymnastics']],
  ['wrestling', /\bwrestling\b/i, ['wrestling']],
  ['hockey', /\bhockey\b/i, ['hockey']],
  ['rowing', /\browing\b|\bcrew\b/i, ['rowing', 'crew']],
  ['lacrosse', /\blacrosse\b/i, ['lacrosse']],
  ['equestrian', /\bequestrian\b/i, ['equestrian']],
];
for (const [key, match, tokens] of BLOCK_ONLY) {
  SPORTS[key] = { key, label: key, slug: key, match, tokens, scannable: false };
}

// Sports the Programs tab offers. Women's basketball exists in the table and works
// end to end from the CLI, but is deliberately not in the UI yet.
const UI_SPORTS = ['football', 'mens_basketball'];
// Sports that can actually be scanned: they have paths, roles and thresholds.
const SCANNABLE = Object.values(SPORTS).filter((s) => s.scannable !== false).map((s) => s.key);
const DEFAULT_SPORT = 'football';

// Input spellings accepted from a CLI flag or a query string. 'basketball' resolves
// to men's: the stored value is always the specific key so that adding women's later
// needs no data migration to disambiguate rows already written.
const ALIASES = {
  football: 'football',
  fb: 'football',
  basketball: 'mens_basketball',
  'mens-basketball': 'mens_basketball',
  mens_basketball: 'mens_basketball',
  mensbasketball: 'mens_basketball',
  mbb: 'mens_basketball',
  'mbball': 'mens_basketball',
  'womens-basketball': 'womens_basketball',
  womens_basketball: 'womens_basketball',
  womensbasketball: 'womens_basketball',
  wbb: 'womens_basketball',
  wbball: 'womens_basketball',
};

// Returns a SCANNABLE sport key, or null. A block-only sport such as 'baseball' is
// deliberately not resolvable: it exists to be excluded, never to be scanned, and
// silently accepting --sport baseball would produce a run with no paths and no roles.
function normalizeSport(input) {
  if (!input) return DEFAULT_SPORT;
  const k = String(input).trim().toLowerCase().replace(/\s+/g, '-');
  return ALIASES[k] || ALIASES[k.replace(/-/g, '_')] || ALIASES[k.replace(/[-_]/g, '')] || null;
}

function getSport(input) {
  const key = normalizeSport(input);
  return key ? SPORTS[key] : null;
}

// ── The guard ────────────────────────────────────────────────────────────────

// Whole-token match against an email address. Tokenised, never regexed, so that
// "patrick" cannot match "track" and "jbaseball" cannot match "baseball".
function emailTokens(email) {
  return String(email || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

// Does this text name THIS sport, and is it not actually naming the sibling?
function namesSport(text, sportKey) {
  const s = SPORTS[sportKey];
  if (!s || !text) return false;
  const v = String(text);
  if (s.excludeIfMatches && s.excludeIfMatches.test(v)) return false;
  return s.match.test(v);
}

// The same question asked of a SECTION HEADING, which is matched on the sport's name
// rather than its full vocabulary. See the sectionMatch note in the table.
function sectionNamesSport(text, sportKey) {
  const s = SPORTS[sportKey];
  if (!s || !text) return false;
  const v = String(text);
  if (s.excludeIfMatches && s.excludeIfMatches.test(v)) return false;
  return (s.sectionMatch || s.match).test(v);
}

// Which OTHER sport does this text name, if any? Returns a sport key or null.
// The sibling case is reported as the sibling, not as "no match", so the reason a
// row was blocked is the true one.
function namesOtherSport(text, sportKey) {
  if (!text) return null;
  const v = String(text);
  const self = SPORTS[sportKey];
  if (!self) return null;
  // The sibling first: it shares the base word, so a plain match test would say
  // "this is my sport" about a women's row on a men's scan.
  if (self.excludeIfMatches && self.excludeIfMatches.test(v)) {
    const sibling = Object.values(SPORTS).find((o) => o.key !== sportKey && o.match.test(v)
      && (!o.excludeIfMatches || !o.excludeIfMatches.test(v)));
    return sibling ? sibling.key : `not ${self.label.toLowerCase()}`;
  }
  if (self.match.test(v)) return null;
  for (const other of Object.values(SPORTS)) {
    if (other.key === sportKey) continue;
    if (other.excludeIfMatches && other.excludeIfMatches.test(v)) continue;
    if (other.match.test(v)) return other.key;
  }
  return null;
}

// An email address is a claim about who someone is. wbb@school.edu on a row being
// scanned as men's basketball is a contradiction, and the address is harder evidence
// than a section heading.
function emailNamesOtherSport(email, sportKey) {
  const toks = emailTokens(email);
  if (!toks.length) return null;
  const self = SPORTS[sportKey];
  if (!self) return null;
  // An excluded sibling token wins over a shared base token: wbb@ beats basketball@.
  for (const t of (self.excludeTokens || [])) if (toks.includes(t)) {
    const sib = Object.values(SPORTS).find((o) => o.key !== sportKey && (o.tokens || []).includes(t));
    return sib ? sib.key : `not ${self.label.toLowerCase()}`;
  }
  if ((self.tokens || []).some((t) => toks.includes(t))) return null;
  for (const other of Object.values(SPORTS)) {
    if (other.key === sportKey) continue;
    if ((other.excludeTokens || []).some((t) => toks.includes(t))) continue;
    if ((other.tokens || []).some((t) => toks.includes(t))) return other.key;
  }
  return null;
}

// Is this URL scoped to the sport? A page served from /sports/mens-basketball/... IS
// the men's basketball page even when its section markup is department-wide.
function sportScopedUrl(url, sportKey) {
  const s = SPORTS[sportKey];
  if (!s || !url) return false;
  const path = (() => {
    try { return new URL(String(url)).pathname.toLowerCase() + (new URL(String(url)).search || '').toLowerCase(); }
    catch (_) { return String(url).toLowerCase(); }
  })();
  if (s.excludeIfMatches && s.excludeIfMatches.test(path)) return false;
  if (path.includes('/' + s.slug) || path.includes('=' + s.slug)) return true;
  return s.match.test(path);
}

// Returns null when the person is fine for this sport, otherwise why not.
//   kind 'email'   -> DROP the record: the address contradicts the claim outright.
//   kind 'section' -> keep on the roster, never a key contact.
//   kind 'title'   -> same.
function sportContradiction(p, sportKey) {
  const sport = normalizeSport(sportKey) || DEFAULT_SPORT;
  const byEmail = emailNamesOtherSport(p && p.email, sport);
  if (byEmail) return { kind: 'email', sport: byEmail, evidence: (p && p.email) || '' };
  const bySection = namesOtherSport(p && p.section, sport);
  if (bySection) return { kind: 'section', sport: bySection, evidence: (p && p.section) || '' };
  const byTitle = namesOtherSport(p && p.title, sport);
  if (byTitle) return { kind: 'title', sport: byTitle, evidence: (p && p.title) || '' };
  return null;
}

module.exports = {
  SPORTS, UI_SPORTS, SCANNABLE, DEFAULT_SPORT, ALIASES, BLOCK_ONLY,
  normalizeSport, getSport,
  namesSport, sectionNamesSport, namesOtherSport, emailNamesOtherSport, sportScopedUrl, sportContradiction,
  emailTokens,
};
