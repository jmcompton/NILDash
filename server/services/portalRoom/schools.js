'use strict';
// ── THE FBS SCHOOLS THE PORTAL ROOM KNOWS ───────────────────────────────────
//
// The program map (services/programMap) holds each school's athletics domain.
// The Portal Room needs two more facts about a school: where it is (the state,
// for "close to home" and an agent's region list) and whether it is Power 4
// (the money: College Sports Commission pay data shows a Power 4 receiver's
// revenue-share median at $112,500 against $15,000 outside it).
//
// LEVEL IS AS OF THE 2026-27 SEASON. Power 4 is the SEC, Big Ten, Big 12, ACC
// and Notre Dame. Group of 5 conferences are not recorded: they churn every
// year and nothing here needs which one a school is in.

const P4 = {
  SEC: ['Alabama', 'Arkansas', 'Auburn', 'Florida', 'Georgia', 'Kentucky', 'LSU', 'Ole Miss', 'Mississippi State', 'Missouri', 'Oklahoma', 'South Carolina', 'Tennessee', 'Texas', 'Texas A&M', 'Vanderbilt'],
  'Big Ten': ['Illinois', 'Indiana', 'Iowa', 'Maryland', 'Michigan', 'Michigan State', 'Minnesota', 'Nebraska', 'Northwestern', 'Ohio State', 'Oregon', 'Penn State', 'Purdue', 'Rutgers', 'UCLA', 'USC', 'Washington', 'Wisconsin'],
  'Big 12': ['Arizona', 'Arizona State', 'Baylor', 'BYU', 'Cincinnati', 'Colorado', 'Houston', 'Iowa State', 'Kansas', 'Kansas State', 'Oklahoma State', 'TCU', 'Texas Tech', 'UCF', 'Utah', 'West Virginia'],
  ACC: ['Boston College', 'California', 'Clemson', 'Duke', 'Florida State', 'Georgia Tech', 'Louisville', 'Miami', 'NC State', 'North Carolina', 'Pittsburgh', 'SMU', 'Stanford', 'Syracuse', 'Virginia', 'Virginia Tech', 'Wake Forest'],
  Independent: ['Notre Dame'],
};

const STATE = {
  Alabama: 'AL', Auburn: 'AL', Georgia: 'GA', Tennessee: 'TN', 'Ole Miss': 'MS', LSU: 'LA', 'Texas A&M': 'TX', Florida: 'FL', 'South Carolina': 'SC', Missouri: 'MO',
  Arkansas: 'AR', Kentucky: 'KY', 'Mississippi State': 'MS', Oklahoma: 'OK', Vanderbilt: 'TN', Texas: 'TX',
  Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Maryland: 'MD', Michigan: 'MI', 'Michigan State': 'MI', Minnesota: 'MN', Nebraska: 'NE', Northwestern: 'IL', 'Ohio State': 'OH', Oregon: 'OR', 'Penn State': 'PA', Purdue: 'IN', Rutgers: 'NJ', UCLA: 'CA', USC: 'CA', Washington: 'WA', Wisconsin: 'WI',
  Arizona: 'AZ', 'Arizona State': 'AZ', Baylor: 'TX', BYU: 'UT', Cincinnati: 'OH', Colorado: 'CO', Houston: 'TX', 'Iowa State': 'IA', Kansas: 'KS', 'Kansas State': 'KS', 'Oklahoma State': 'OK', TCU: 'TX', 'Texas Tech': 'TX', UCF: 'FL', Utah: 'UT', 'West Virginia': 'WV',
  'Boston College': 'MA', California: 'CA', Clemson: 'SC', Duke: 'NC', 'Florida State': 'FL', 'Georgia Tech': 'GA', Louisville: 'KY', Miami: 'FL', 'NC State': 'NC', 'North Carolina': 'NC', Pittsburgh: 'PA', SMU: 'TX', Stanford: 'CA', Syracuse: 'NY', Virginia: 'VA', 'Virginia Tech': 'VA', 'Wake Forest': 'NC',
  'Notre Dame': 'IN', UConn: 'CT',
  Army: 'NY', Charlotte: 'NC', 'East Carolina': 'NC', 'Florida Atlantic': 'FL', Memphis: 'TN', Navy: 'MD', 'North Texas': 'TX', Rice: 'TX', 'South Florida': 'FL', Temple: 'PA', Tulane: 'LA', Tulsa: 'OK', UAB: 'AL', UTSA: 'TX',
  'Air Force': 'CO', 'Boise State': 'ID', 'Colorado State': 'CO', 'Fresno State': 'CA', Hawaii: 'HI', Nevada: 'NV', 'New Mexico': 'NM', 'San Diego State': 'CA', 'San Jose State': 'CA', UNLV: 'NV', 'Utah State': 'UT', Wyoming: 'WY',
  Delaware: 'DE', 'Florida International': 'FL', 'Jacksonville State': 'AL', 'Kennesaw State': 'GA', Liberty: 'VA', 'Louisiana Tech': 'LA', 'Middle Tennessee': 'TN', 'Missouri State': 'MO', 'New Mexico State': 'NM', 'Sam Houston': 'TX', UTEP: 'TX', 'Western Kentucky': 'KY',
  Akron: 'OH', 'Ball State': 'IN', 'Bowling Green': 'OH', Buffalo: 'NY', 'Central Michigan': 'MI', 'Eastern Michigan': 'MI', 'Kent State': 'OH', 'Miami (OH)': 'OH', 'Northern Illinois': 'IL', Ohio: 'OH', Toledo: 'OH', UMass: 'MA', 'Western Michigan': 'MI',
  'Oregon State': 'OR', 'Washington State': 'WA',
  'Appalachian State': 'NC', 'Arkansas State': 'AR', 'Coastal Carolina': 'SC', 'Georgia Southern': 'GA', 'Georgia State': 'GA', 'James Madison': 'VA', Louisiana: 'LA', 'Louisiana-Monroe': 'LA', Marshall: 'WV', 'Old Dominion': 'VA', 'South Alabama': 'AL', 'Southern Miss': 'MS', 'Texas State': 'TX', Troy: 'AL',
};

// Regions an agent can pick instead of naming states.
const REGIONS = {
  Southeast: ['AL', 'FL', 'GA', 'KY', 'LA', 'MS', 'NC', 'SC', 'TN', 'VA', 'WV', 'AR'],
  Northeast: ['CT', 'DE', 'MA', 'MD', 'NJ', 'NY', 'PA', 'RI', 'VT', 'NH', 'ME', 'DC'],
  Midwest: ['IA', 'IL', 'IN', 'KS', 'MI', 'MN', 'MO', 'NE', 'OH', 'WI', 'ND', 'SD'],
  Southwest: ['AZ', 'NM', 'OK', 'TX'],
  West: ['CA', 'CO', 'HI', 'ID', 'NV', 'OR', 'UT', 'WA', 'WY', 'MT', 'AK'],
};

const CONF_OF = {};
for (const [conf, list] of Object.entries(P4)) for (const s of list) CONF_OF[s] = conf;

function domains() {
  try { return require('../programMap').SCHOOLS || {}; } catch (_) { return {}; }
}

// Every school, with level, conference (Power 4 only), state, region and domain.
function all() {
  const d = domains();
  const names = [...new Set([...Object.keys(STATE), ...Object.keys(d)])].sort();
  return names.map((name) => info(name, d)).filter(Boolean);
}

function regionOf(state) {
  for (const [r, list] of Object.entries(REGIONS)) if (list.includes(state)) return r;
  return null;
}

function info(name, d = domains()) {
  if (!name) return null;
  const conf = CONF_OF[name] || null;
  const state = STATE[name] || null;
  const dom = d[name] ? d[name].athletics : null;
  return { name, level: conf ? 'P4' : 'G5', conference: conf, state, region: regionOf(state), domain: dom || null };
}

// "university of texas", "TEXAS", "Texas Longhorns" -> "Texas". Exact and
// case-insensitive first, then the team-name map, then the school resolver's
// own fuzzy pass. Never guesses on ambiguity: unknown comes back null.
const ALIASES = {
  'ole miss': 'Ole Miss', mississippi: 'Ole Miss', 'university of mississippi': 'Ole Miss',
  'louisiana state': 'LSU', 'louisiana state university': 'LSU',
  'southern california': 'USC', 'university of southern california': 'USC',
  'central florida': 'UCF', 'brigham young': 'BYU', 'texas christian': 'TCU',
  'southern methodist': 'SMU', 'north carolina state': 'NC State', 'nc st': 'NC State',
  'pitt': 'Pittsburgh', 'cal': 'California', 'uconn': 'UConn', connecticut: 'UConn',
  'miami (fl)': 'Miami', 'miami fl': 'Miami', 'university of miami': 'Miami',
  'miami university': 'Miami (OH)', 'miami ohio': 'Miami (OH)', fiu: 'Florida International',
  fau: 'Florida Atlantic', usf: 'South Florida', jmu: 'James Madison', 'app state': 'Appalachian State',
  ulm: 'Louisiana-Monroe', 'ul monroe': 'Louisiana-Monroe', 'louisiana lafayette': 'Louisiana', 'ul lafayette': 'Louisiana',
  'massachusetts': 'UMass', 'umass amherst': 'UMass', 'texas a&m university': 'Texas A&M', tamu: 'Texas A&M',
  'penn st': 'Penn State', 'ohio st': 'Ohio State', 'western kentucky university': 'Western Kentucky', wku: 'Western Kentucky',
  'middle tennessee state': 'Middle Tennessee', mtsu: 'Middle Tennessee', 'sam houston state': 'Sam Houston',
  'hawai\'i': 'Hawaii', 'san josé state': 'San Jose State', 'nevada las vegas': 'UNLV', 'utsa': 'UTSA', 'utep': 'UTEP',
};
const NOT_FBS = new Set(['washington university', 'washington university in st. louis', 'miami dade college', 'texas college', 'georgia college', 'ohio university eastern']);
const NOT_A_NICKNAME = /\b(state|st\.?|a\s*&\s*m|a\s*&\s*t|tech|southern|northern|eastern|western|central|university|college|christian|international|atlantic|baptist|lutheran|wesleyan|methodist|institute|polytechnic|valley|community|city|of|at|-)\b/i;
function canonical(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const all_ = all().map((x) => x.name);
  const lc = s.toLowerCase();
  // Different schools that strip down to an FBS name.
  if (NOT_FBS.has(lc)) return null;
  const hit = all_.find((n) => n.toLowerCase() === lc);
  if (hit) return hit;
  const stripped = lc.replace(/^the\s+/, '').replace(/\buniversity of\s+/, '').replace(/\s+university$/, '').replace(/\s+(state )?college$/, '').trim();
  if (ALIASES[lc]) return ALIASES[lc];
  if (ALIASES[stripped]) return ALIASES[stripped];
  const hit2 = all_.find((n) => n.toLowerCase() === stripped);
  if (hit2) return hit2;
  // "Texas Longhorns", "Georgia Bulldogs": the school name plus a nickname.
  // Only a nickname: "Tennessee State", "Florida A&M", "Texas Southern" and
  // "Washington University" are different schools, and a remainder that reads
  // like part of a school's name is refused.
  const lead = all_.filter((n) => lc.startsWith(n.toLowerCase() + ' ')).sort((a, b) => b.length - a.length);
  if (lead.length) {
    const rest = lc.slice(lead[0].length + 1);
    if (!NOT_A_NICKNAME.test(rest)) return lead[0];
  }
  return null;
}

module.exports = { all, info, canonical, regionOf, REGIONS, P4, STATE };
