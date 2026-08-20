'use strict';
// ── RESOLVING A SCHOOL AN AGENT TYPED ────────────────────────────────────────
//
// The school on an athlete record is free text from Add Client. The lookup it
// fed wanted exact strings, so it failed on things a human would not blink at:
//
//   "Virgina Tech"                 misspelled
//   "UNIVERSITY OF PITTSBURGH"     all caps
//   "Eastern Kentucky University"  carries a suffix the map's key does not
//
// Both of the first two are in the map already. They failed on case and one
// transposed letter, and the local lane then fell back to the athlete's hometown
// and pitched businesses in the wrong town. So this is not a cosmetic cleanup;
// it is why 21 of 59 athletes had no market.
//
// THE ONE THING THIS MUST NOT DO IS GUESS. A wrong school is worse than no
// school: no school means the local lane returns nothing and says so, while a
// wrong school means confident outreach to businesses 400 miles away. So the
// fuzzy pass has a high floor and refuses on ambiguity -- "Miami" matching both
// University of Miami and Miami University (Ohio) returns null, not a coin toss.

const { lookupSchoolLocation } = require('../ai');

// Schools the shipped map does not carry. Kept here rather than edited into
// ai.js so the additions are reviewable in one place.
const EXTRA_SCHOOLS = {
  'Eastern Kentucky University': { city: 'Richmond', state: 'KY' },
  'Western Kentucky University': { city: 'Bowling Green', state: 'KY' },
  'Louisiana State University': { city: 'Baton Rouge', state: 'LA' },
  'University of Mississippi': { city: 'Oxford', state: 'MS' },
  'Mississippi State University': { city: 'Starkville', state: 'MS' },
  'University of Kentucky': { city: 'Lexington', state: 'KY' },
  'University of Louisville': { city: 'Louisville', state: 'KY' },
  'Marshall University': { city: 'Huntington', state: 'WV' },
  'West Virginia University': { city: 'Morgantown', state: 'WV' },
  'James Madison University': { city: 'Harrisonburg', state: 'VA' },
  'Old Dominion University': { city: 'Norfolk', state: 'VA' },
  'University of Virginia': { city: 'Charlottesville', state: 'VA' },
  'Liberty University': { city: 'Lynchburg', state: 'VA' },
  'Appalachian State University': { city: 'Boone', state: 'NC' },
  'East Carolina University': { city: 'Greenville', state: 'NC' },
  'Wake Forest University': { city: 'Winston-Salem', state: 'NC' },
  'Duke University': { city: 'Durham', state: 'NC' },
  'North Carolina State University': { city: 'Raleigh', state: 'NC' },
  'University of North Carolina': { city: 'Chapel Hill', state: 'NC' },
  'Coastal Carolina University': { city: 'Conway', state: 'SC' },
  'University of South Carolina': { city: 'Columbia', state: 'SC' },
  'Furman University': { city: 'Greenville', state: 'SC' },
  'Middle Tennessee State University': { city: 'Murfreesboro', state: 'TN' },
  'Austin Peay State University': { city: 'Clarksville', state: 'TN' },
  'Belmont University': { city: 'Nashville', state: 'TN' },
  'Vanderbilt University': { city: 'Nashville', state: 'TN' },
  'University of Memphis': { city: 'Memphis', state: 'TN' },
  'Tennessee Tech University': { city: 'Cookeville', state: 'TN' },
  'Troy University': { city: 'Troy', state: 'AL' },
  'Jacksonville State University': { city: 'Jacksonville', state: 'AL' },
  'University of South Alabama': { city: 'Mobile', state: 'AL' },
  'University of North Alabama': { city: 'Florence', state: 'AL' },
  'Arkansas State University': { city: 'Jonesboro', state: 'AR' },
  'University of Central Arkansas': { city: 'Conway', state: 'AR' },
  'Oklahoma State University': { city: 'Stillwater', state: 'OK' },
  'University of Oklahoma': { city: 'Norman', state: 'OK' },
  'University of Tulsa': { city: 'Tulsa', state: 'OK' },
  'Texas Christian University': { city: 'Fort Worth', state: 'TX' },
  'Baylor University': { city: 'Waco', state: 'TX' },
  'Texas Tech University': { city: 'Lubbock', state: 'TX' },
  'University of Houston': { city: 'Houston', state: 'TX' },
  'Southern Methodist University': { city: 'Dallas', state: 'TX' },
  'University of North Texas': { city: 'Denton', state: 'TX' },
  'Sam Houston State University': { city: 'Huntsville', state: 'TX' },
  'University of Missouri': { city: 'Columbia', state: 'MO' },
  'Missouri State University': { city: 'Springfield', state: 'MO' },
  'University of Kansas': { city: 'Lawrence', state: 'KS' },
  'Kansas State University': { city: 'Manhattan', state: 'KS' },
  'University of Nebraska': { city: 'Lincoln', state: 'NE' },
  'University of Iowa': { city: 'Iowa City', state: 'IA' },
  'Iowa State University': { city: 'Ames', state: 'IA' },
  'University of Minnesota': { city: 'Minneapolis', state: 'MN' },
  'University of Wisconsin': { city: 'Madison', state: 'WI' },
  'Marquette University': { city: 'Milwaukee', state: 'WI' },
  'University of Illinois': { city: 'Champaign', state: 'IL' },
  'Northwestern University': { city: 'Evanston', state: 'IL' },
  'DePaul University': { city: 'Chicago', state: 'IL' },
  'Indiana University': { city: 'Bloomington', state: 'IN' },
  'Purdue University': { city: 'West Lafayette', state: 'IN' },
  'Butler University': { city: 'Indianapolis', state: 'IN' },
  'University of Notre Dame': { city: 'Notre Dame', state: 'IN' },
  'University of Michigan': { city: 'Ann Arbor', state: 'MI' },
  'Michigan State University': { city: 'East Lansing', state: 'MI' },
  'University of Cincinnati': { city: 'Cincinnati', state: 'OH' },
  'University of Dayton': { city: 'Dayton', state: 'OH' },
  'Miami University': { city: 'Oxford', state: 'OH' },
  'University of Toledo': { city: 'Toledo', state: 'OH' },
  'Bowling Green State University': { city: 'Bowling Green', state: 'OH' },
  'Kent State University': { city: 'Kent', state: 'OH' },
  'Temple University': { city: 'Philadelphia', state: 'PA' },
  'Villanova University': { city: 'Villanova', state: 'PA' },
  'Rutgers University': { city: 'Piscataway', state: 'NJ' },
  'Syracuse University': { city: 'Syracuse', state: 'NY' },
  'University at Buffalo': { city: 'Buffalo', state: 'NY' },
  'Boston College': { city: 'Chestnut Hill', state: 'MA' },
  'University of Massachusetts': { city: 'Amherst', state: 'MA' },
  'University of Maryland': { city: 'College Park', state: 'MD' },
  'Towson University': { city: 'Towson', state: 'MD' },
  'University of Delaware': { city: 'Newark', state: 'DE' },
  'University of Central Florida': { city: 'Orlando', state: 'FL' },
  'University of South Florida': { city: 'Tampa', state: 'FL' },
  'Florida Atlantic University': { city: 'Boca Raton', state: 'FL' },
  'Florida International University': { city: 'Miami', state: 'FL' },
  'Stetson University': { city: 'DeLand', state: 'FL' },
  'University of Colorado': { city: 'Boulder', state: 'CO' },
  'Colorado State University': { city: 'Fort Collins', state: 'CO' },
  'University of Utah': { city: 'Salt Lake City', state: 'UT' },
  'Brigham Young University': { city: 'Provo', state: 'UT' },
  'Utah State University': { city: 'Logan', state: 'UT' },
  'Boise State University': { city: 'Boise', state: 'ID' },
  'University of Nevada': { city: 'Reno', state: 'NV' },
  'University of Nevada Las Vegas': { city: 'Las Vegas', state: 'NV' },
  'Arizona State University': { city: 'Tempe', state: 'AZ' },
  'University of Arizona': { city: 'Tucson', state: 'AZ' },
  'San Diego State University': { city: 'San Diego', state: 'CA' },
  'Fresno State University': { city: 'Fresno', state: 'CA' },
  'University of Southern California': { city: 'Los Angeles', state: 'CA' },
  'Stanford University': { city: 'Stanford', state: 'CA' },
  'University of Oregon': { city: 'Eugene', state: 'OR' },
  'Gonzaga University': { city: 'Spokane', state: 'WA' },
  // Added after the first live pass: every one of these is a real school an
  // agent had typed and the list simply did not carry.
  'University of Louisiana Monroe': { city: 'Monroe', state: 'LA' },
  'Florida A&M University': { city: 'Tallahassee', state: 'FL' },
  'The Citadel': { city: 'Charleston', state: 'SC' },
  'Grambling State University': { city: 'Grambling', state: 'LA' },
  'University of Montana': { city: 'Missoula', state: 'MT' },
  'Montana State University': { city: 'Bozeman', state: 'MT' },
  'Cape Fear Community College': { city: 'Wilmington', state: 'NC' },
  "Saint Mary's College of California": { city: 'Moraga', state: 'CA' },
  'Southern University': { city: 'Baton Rouge', state: 'LA' },
  'Jackson State University': { city: 'Jackson', state: 'MS' },
  'Alabama State University': { city: 'Montgomery', state: 'AL' },
  'Alabama A&M University': { city: 'Normal', state: 'AL' },
  'Tennessee State University': { city: 'Nashville', state: 'TN' },
  'North Carolina A&T State University': { city: 'Greensboro', state: 'NC' },
  'Howard University': { city: 'Washington', state: 'DC' },
  'Norfolk State University': { city: 'Norfolk', state: 'VA' },
  'Prairie View A&M University': { city: 'Prairie View', state: 'TX' },
  'Texas Southern University': { city: 'Houston', state: 'TX' },
  'Bethune-Cookman University': { city: 'Daytona Beach', state: 'FL' },
  'Virginia Military Institute': { city: 'Lexington', state: 'VA' },
};

// Abbreviations, nicknames and the misspellings that actually show up. An alias
// is an EXACT statement of intent, so it outranks anything fuzzy.
const ALIASES = {
  'virgina tech': 'Virginia Tech',
  'virginia poly': 'Virginia Tech',
  'vt': 'Virginia Tech',
  'pitt': 'University of Pittsburgh',
  'lsu': 'Louisiana State University',
  'ole miss': 'University of Mississippi',
  'miss state': 'Mississippi State University',
  'msu': null,                          // ambiguous on purpose: Michigan/Mississippi/Missouri State
  'eku': 'Eastern Kentucky University',
  'wku': 'Western Kentucky University',
  'uk': 'University of Kentucky',
  'uga': 'University of Georgia',
  'ucf': 'University of Central Florida',
  'usf': 'University of South Florida',
  'fau': 'Florida Atlantic University',
  'fiu': 'Florida International University',
  'fsu': 'Florida State University',
  'usc': 'University of Southern California',
  'unc': 'University of North Carolina',
  'ncsu': 'North Carolina State University',
  'nc state': 'North Carolina State University',
  'app state': 'Appalachian State University',
  'ecu': 'East Carolina University',
  'odu': 'Old Dominion University',
  'jmu': 'James Madison University',
  'wvu': 'West Virginia University',
  'tcu': 'Texas Christian University',
  'smu': 'Southern Methodist University',
  'unt': 'University of North Texas',
  'okstate': 'Oklahoma State University',
  'ou': 'University of Oklahoma',
  'ku': 'University of Kansas',
  'kstate': 'Kansas State University',
  'k state': 'Kansas State University',
  'mizzou': 'University of Missouri',
  'nd': 'University of Notre Dame',
  'byu': 'Brigham Young University',
  'unlv': 'University of Nevada Las Vegas',
  'sdsu': 'San Diego State University',
  'asu': 'Arizona State University',
  'mtsu': 'Middle Tennessee State University',
  'utsa': null,
  'cal': 'University of California',
  // Abbreviations for the schools added above.
  'ulm': 'University of Louisiana Monroe',
  'louisiana monroe': 'University of Louisiana Monroe',
  'famu': 'Florida A&M University',
  'florida a and m': 'Florida A&M University',
  'citadel': 'The Citadel',
  'grambling': 'Grambling State University',
  'grambling state': 'Grambling State University',
  'montana': 'University of Montana',
  'cape fear': 'Cape Fear Community College',
  'cfcc': 'Cape Fear Community College',
  'saint marys': "Saint Mary's College of California",
  'st marys': "Saint Mary's College of California",
  'smc': "Saint Mary's College of California",
  // Miami University IS the Ohio one; a bare "Miami" is Coral Gables. That is
  // the real-world naming convention, so it is stated rather than fuzzy-matched.
  'miami university': 'Miami University',
  'miami ohio': 'Miami University',
  'southern': null,                     // Southern U / USC / Southern Miss
  'jackson state': 'Jackson State University',
  'alabama state': 'Alabama State University',
  'alabama a and m': 'Alabama A&M University',
  'tennessee state': 'Tennessee State University',
  'nc a and t': 'North Carolina A&T State University',
  'howard': 'Howard University',
  'norfolk state': 'Norfolk State University',
  'prairie view': 'Prairie View A&M University',
  'texas southern': 'Texas Southern University',
  'bethune cookman': 'Bethune-Cookman University',
  'vmi': 'Virginia Military Institute',
};

// Suffixes and prefixes that carry no identity. "Eastern Kentucky University"
// and "Eastern Kentucky" are the same school; the map happens to key one of them.
const STRIP_RE = /\b(university|univ|college|the|at|of|a\s*&\s*m\b(?!\w))\b/g;

// Institution words a typo can land in. "Arizona State Univeristy" failed
// because STRIP_RE matches the word EXACTLY, so the misspelled suffix survived
// into the identity form: core became "arizona state univeristy" against a
// target of "arizona state", a distance of 11 rather than 1, and the single-edit
// allowance never got a chance. The typo was in the part we meant to throw away.
const INSTITUTION_WORDS = ['university', 'college', 'institute', 'academy', 'universary'];
function _isInstitutionWord(tok) {
  if (tok.length < 6) return false;
  return INSTITUTION_WORDS.some((w) => levenshtein(tok, w) <= 2);
}

const US_STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', tennessee: 'TN', texas: 'TX',
  utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', wisconsin: 'WI', wyoming: 'WY',
};

// A parenthetical is usually a NOTE, not part of the name: "Maryland (incoming;
// Class of 2026 recruit)" is Maryland. But "(Ohio)" in "Miami University (Ohio)"
// is the thing that tells two real schools apart. So it is removed from the name
// either way, and kept as a state hint when it names a state.
function splitParenthetical(raw) {
  const s2 = String(raw || '');
  let hint = null;
  const body = s2.replace(/\s*[([]([^)\]]*)[)\]]\s*/g, (m, inner) => {
    const t = String(inner || '').trim().toLowerCase().replace(/[.]/g, '');
    if (US_STATES[t]) hint = US_STATES[t];
    else if (/^[a-z]{2}$/.test(t) && Object.values(US_STATES).indexOf(t.toUpperCase()) !== -1) hint = t.toUpperCase();
    return ' ';
  });
  return { name: body.replace(/\s+/g, ' ').trim(), stateHint: hint };
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.,'’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Identity form: normalized, with the empty words removed -- including ones a
// typo landed in, which is what "Arizona State Univeristy" needed.
function core(s) {
  const base = normalize(s).replace(STRIP_RE, ' ');
  return base.split(/\s+/).filter((t) => t && !_isInstitutionWord(t)).join(' ').trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

// A fuzzy match must clear this AND beat the runner-up by MIN_MARGIN, so a near
// tie between two different schools resolves to nothing.
const MIN_CONFIDENCE = 0.86;
const MIN_MARGIN = 0.06;
// A ratio alone is length-blind: one transposed letter in a six-character core
// scores 0.83 and would be rejected, which is the "Auburm" case. A single edit
// on a core this long is a typo, not a different school. Short cores stay on the
// ratio alone, where one edit really can mean somewhere else.
const TYPO_MIN_CORE = 5;

// Words that identify nothing on their own. The shipped lookup matches by
// substring in BOTH directions, so a bare "State" finds "Kennesaw State
// University" and returns Kennesaw -- a confident answer built from one generic
// word. Anything here, or anything too short to be a name, never reaches it.
const GENERIC = new Set(['state', 'tech', 'university', 'college', 'the', 'a and m', 'am',
  'north', 'south', 'east', 'west', 'central', 'eastern', 'western', 'northern', 'southern',
  'city', 'community', 'junior', 'international', 'national', 'us', 'usa']);

function isIdentityLike(s) {
  const c = core(s);
  if (c.length < 4) return false;
  const toks = c.split(/\s+/).filter(Boolean);
  // Every token generic means the string names no school in particular.
  return !toks.every((t) => GENERIC.has(t));
}

// opts.map lets a test supply its own list. opts.lookup is the shipped exact
// lookup, injected so this module can be exercised without ai.js.
function resolveSchool(raw, opts = {}) {
  // The note comes off the name first. "Maryland (incoming; Class of 2026
  // recruit)" is Maryland; the parenthetical is an agent's aside, not part of
  // the school. A parenthetical that names a STATE is kept as a hint instead,
  // because "(Ohio)" is the only thing separating Miami University from the
  // University of Miami.
  const { name: input, stateHint } = splitParenthetical(String(raw || '').trim());
  if (!input) return null;
  const exact = opts.lookup || lookupSchoolLocation;
  const extra = opts.map || EXTRA_SCHOOLS;

  const fromExtra = (name) => {
    const c = core(name);
    for (const k of Object.keys(extra)) if (core(k) === c) return { name: k, loc: extra[k] };
    return null;
  };
  const hit = (loc, name, method, confidence) => (loc && loc.city
    ? { city: loc.city, state: loc.state || null, matched: name, method, confidence }
    : null);

  // 1. Exactly what the shipped map already does -- but ONLY for a string that
  //    identifies a school. The shipped lookup falls back to a two-way substring
  //    scan, so without this guard "State" resolves to Kennesaw with confidence
  //    1, which is precisely the confident wrong answer that sends outreach to
  //    the wrong town.
  if (isIdentityLike(input)) {
    const asIs = exact(input);
    if (asIs && asIs.city) return hit(asIs, input, 'exact', 1);
  }

  // 2. An alias is a statement of intent. A DELIBERATELY ambiguous alias (msu)
  //    maps to null and stops here rather than falling through to a fuzzy guess.
  const n = normalize(input);
  if (Object.prototype.hasOwnProperty.call(ALIASES, n)) {
    const target = ALIASES[n];
    if (target === null) return null;
    const viaExact = exact(target);
    if (viaExact && viaExact.city) return hit(viaExact, target, 'alias', 1);
    const viaExtra = fromExtra(target);
    if (viaExtra) return hit(viaExtra.loc, viaExtra.name, 'alias', 1);
  }

  // 3. The added list, on the identity form. This is where the suffix problem
  //    dies: "Eastern Kentucky University" and "Eastern Kentucky" share a core.
  const direct = fromExtra(input);
  if (direct) return hit(direct.loc, direct.name, 'normalized', 1);

  // 4. Case and punctuation only, against the shipped map. "UNIVERSITY OF
  //    PITTSBURGH" resolves here.
  const cands = [];
  for (const name of Object.keys(extra)) cands.push({ name, loc: extra[name] });
  for (const name of (opts.mapNames || SHIPPED_NAMES)) {
    const loc = exact(name);
    if (loc && loc.city) cands.push({ name, loc });
  }
  const inputCore = core(input);
  let exactCore = cands.filter((c) => core(c.name) === inputCore);
  if (exactCore.length) {
    // A state hint from the parenthetical breaks a tie that would otherwise be
    // unresolvable -- and only ever narrows, never invents.
    if (stateHint && exactCore.length > 1) {
      const narrowed = exactCore.filter((c) => (c.loc.state || '').toUpperCase() === stateHint);
      if (narrowed.length) exactCore = narrowed;
    }
    // Same identity form reached from several spellings is not ambiguity as long
    // as they all point at one city.
    const cities = new Set(exactCore.map((c) => (c.loc.city + '|' + (c.loc.state || ''))));
    if (cities.size === 1) return hit(exactCore[0].loc, exactCore[0].name, 'normalized', 1);
    return null;
  }

  // 5. Fuzzy, with a floor and a margin. This is what catches "Virgina Tech".
  let pool = cands;
  if (stateHint) {
    const inState = cands.filter((c) => (c.loc.state || '').toUpperCase() === stateHint);
    if (inState.length) pool = inState;
  }
  const scored = pool.map((c) => ({ ...c, s: similarity(inputCore, core(c.name)) }))
    .sort((a, b) => b.s - a.s);
  const best = scored[0];
  const typo = best && inputCore.length >= TYPO_MIN_CORE
    && levenshtein(inputCore, core(best.name)) <= 1;
  if (!best || (best.s < MIN_CONFIDENCE && !typo)) return null;
  // Runner-up pointing at a DIFFERENT city too close behind means we do not know.
  const rival = scored.find((c) => (c.loc.city + '|' + c.loc.state) !== (best.loc.city + '|' + best.loc.state));
  if (rival && best.s - rival.s < MIN_MARGIN) return null;
  return hit(best.loc, best.name, 'fuzzy', Math.round(best.s * 100) / 100);
}

// The shipped map's key list. Read once, lazily, so requiring this module does
// not pull ai.js apart at load time.
let SHIPPED_NAMES = [];
try {
  const fs = require('fs');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'ai.js'), 'utf8');
  const i = src.indexOf('const SCHOOL_LOCATIONS');
  const j = src.indexOf('\n};', i);
  if (i > 0 && j > i) {
    SHIPPED_NAMES = (src.slice(i, j).match(/^\s*'([^']+)':/gm) || [])
      .map((x) => x.replace(/^\s*'/, '').replace(/':$/, ''));
  }
} catch (_) { SHIPPED_NAMES = []; }

module.exports = {
  resolveSchool, normalize, core, similarity, levenshtein,
  EXTRA_SCHOOLS, ALIASES, MIN_CONFIDENCE, MIN_MARGIN, TYPO_MIN_CORE,
  GENERIC, isIdentityLike, SHIPPED_NAMES, splitParenthetical, US_STATES,
  INSTITUTION_WORDS,
};
