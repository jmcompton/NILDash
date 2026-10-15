'use strict';
// ── THE MARKET SCORE: HOW BIG A BRAND THIS ATHLETE CAN CARRY (MARKET_MIX_ON) ──
//
// 0-100 per athlete, recomputed weekly and stored with what drove it
// (athlete_market_scores). The score decides the athlete's tier, and the tier
// decides how the five nightly slots split between the local, social and
// national lanes (services/dealMix).
//
//   Level and sport   25   Power 4 / Group of 5 / FCS and other D1 / D2 /
//                          NAIA / D3 / JUCO / high school, and the sport
//                          (football and men's basketball weigh most)
//   Social reach      30   followers per platform (log scale) and the
//                          engagement rate; a connected Instagram is read
//                          first (instagramConnect / instagramInsights)
//   Performance       20   starter, stats, awards, all-conference, recruiting
//                          stars, draft status: read from what the record
//                          says, never looked up and never assumed
//   Media             10   news mentions in the last 90 days, from a weekly
//                          search that keeps only articles the search actually
//                          returned and that name the athlete
//   Market            15   the population of the school's city (2020 Census);
//                          when that cannot be read, the depth of the local
//                          business pool we hold for the market, at low
//                          confidence
//
// MISSING DATA SCORES ZERO AND LOWERS CONFIDENCE. Nothing is guessed: an
// athlete with no follower count gets no reach points (not an average), and
// the confidence says how much of the 100 was backed by data. A low score
// from missing data puts the athlete in a smaller tier, so the gap can only
// ever cost a national pitch, never cause one.
//
// Pure where it can be: score() takes everything it reads as an argument, so
// the tests and the dry run score with the same code the week does.

const STALE_DAYS = 7;
const NEWS_DAYS = 90;
const NEWS_STALE_DAYS = 7;
const ON = () => process.env.MARKET_MIX_ON === '1';

const fold = (s) => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const round1 = (n) => Math.round(n * 10) / 10;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const fmtN = (n) => Number(n).toLocaleString('en-US');

// ── TIERS ───────────────────────────────────────────────────────────────────
// Highest first. A score at a threshold is in the higher tier.
const TIERS = [
  { key: 'national', label: 'National', min: 75 },
  { key: 'regional', label: 'Regional', min: 55 },
  { key: 'rising', label: 'Rising', min: 35 },
  { key: 'local_star', label: 'Local Star', min: 0 },
];
function tierFor(score) {
  const s = Number(score) || 0;
  return TIERS.find((t) => s >= t.min) || TIERS[TIERS.length - 1];
}
const TIER_LABEL = Object.fromEntries(TIERS.map((t) => [t.key, t.label]));

// ── LEVEL ───────────────────────────────────────────────────────────────────
// The conferences as they stand for 2025-26. Each school carries its state, so
// a name that is two schools (Miami) is told apart by where it is, and is
// never resolved by guessing.
const P4 = [
  // SEC
  ['Alabama', 'AL', 'bama'], ['Arkansas', 'AR'], ['Auburn', 'AL'], ['Florida', 'FL', 'uf'], ['Georgia', 'GA', 'uga'],
  ['Kentucky', 'KY'], ['LSU', 'LA', 'louisiana state'], ['Ole Miss', 'MS', 'mississippi'], ['Mississippi State', 'MS'],
  ['Missouri', 'MO', 'mizzou'], ['Oklahoma', 'OK'], ['South Carolina', 'SC'], ['Tennessee', 'TN', 'tennessee knoxville'],
  ['Texas', 'TX', 'texas austin', 'ut austin'], ['Texas A&M', 'TX', 'tamu', 'texas a and m college station'], ['Vanderbilt', 'TN', 'vandy'],
  // Big Ten
  ['Illinois', 'IL', 'illinois urbana champaign', 'uiuc'], ['Indiana', 'IN', 'indiana bloomington'], ['Iowa', 'IA'],
  ['Maryland', 'MD', 'maryland college park'], ['Michigan', 'MI', 'michigan ann arbor'], ['Michigan State', 'MI'],
  ['Minnesota', 'MN', 'minnesota twin cities'], ['Nebraska', 'NE', 'nebraska lincoln'], ['Northwestern', 'IL'],
  ['Ohio State', 'OH'], ['Penn State', 'PA', 'pennsylvania state'], ['Purdue', 'IN'], ['Rutgers', 'NJ', 'rutgers new brunswick'],
  ['Wisconsin', 'WI', 'wisconsin madison'], ['UCLA', 'CA', 'california los angeles'], ['USC', 'CA', 'southern california'],
  ['Oregon', 'OR'], ['Washington', 'WA'],
  // ACC
  ['Boston College', 'MA'], ['Cal', 'CA', 'california', 'california berkeley', 'uc berkeley', 'berkeley'], ['Clemson', 'SC'],
  ['Duke', 'NC'], ['Florida State', 'FL', 'fsu'], ['Georgia Tech', 'GA', 'georgia institute technology'], ['Louisville', 'KY'],
  ['Miami', 'FL', 'miami fl', 'miami florida'], ['NC State', 'NC', 'north carolina state', 'ncsu'],
  ['North Carolina', 'NC', 'unc', 'north carolina chapel hill', 'unc chapel hill'], ['Pittsburgh', 'PA', 'pitt'],
  ['SMU', 'TX', 'southern methodist'], ['Stanford', 'CA'], ['Syracuse', 'NY'], ['Virginia', 'VA', 'uva'],
  ['Virginia Tech', 'VA', 'virginia polytechnic institute and state'], ['Wake Forest', 'NC'],
  // Big 12
  ['Arizona', 'AZ'], ['Arizona State', 'AZ'], ['Baylor', 'TX'], ['BYU', 'UT', 'brigham young'], ['Cincinnati', 'OH'],
  ['Colorado', 'CO', 'colorado boulder'], ['Houston', 'TX'], ['Iowa State', 'IA'], ['Kansas', 'KS'], ['Kansas State', 'KS', 'k state'],
  ['Oklahoma State', 'OK'], ['TCU', 'TX', 'texas christian'], ['Texas Tech', 'TX'], ['UCF', 'FL', 'central florida'],
  ['Utah', 'UT'], ['West Virginia', 'WV', 'wvu'],
  // Independent, Power 4 in every sense that matters to a sponsor
  ['Notre Dame', 'IN'],
];
const G5 = [
  // American
  ['Army', 'NY', 'army west point', 'united states military academy'], ['Charlotte', 'NC', 'unc charlotte', 'north carolina charlotte'],
  ['East Carolina', 'NC', 'ecu'], ['Florida Atlantic', 'FL', 'fau'], ['Memphis', 'TN'], ['Navy', 'MD', 'united states naval academy', 'naval academy'],
  ['North Texas', 'TX', 'unt'], ['Rice', 'TX'], ['South Florida', 'FL', 'usf'], ['Temple', 'PA'], ['Tulane', 'LA'], ['Tulsa', 'OK'],
  ['UAB', 'AL', 'alabama birmingham'], ['UTSA', 'TX', 'texas san antonio'],
  // Conference USA
  ['Delaware', 'DE'], ['FIU', 'FL', 'florida international'], ['Jacksonville State', 'AL'], ['Kennesaw State', 'GA'], ['Liberty', 'VA'],
  ['Louisiana Tech', 'LA'], ['Middle Tennessee', 'TN', 'middle tennessee state', 'mtsu'], ['Missouri State', 'MO'],
  ['New Mexico State', 'NM'], ['Sam Houston', 'TX', 'sam houston state'], ['Western Kentucky', 'KY', 'wku'], ['UTEP', 'TX', 'texas el paso'],
  // MAC
  ['Akron', 'OH'], ['Ball State', 'IN'], ['Bowling Green', 'OH', 'bowling green state'], ['Buffalo', 'NY'], ['Central Michigan', 'MI'],
  ['Eastern Michigan', 'MI'], ['Kent State', 'OH'], ['Miami (OH)', 'OH', 'miami', 'miami oh', 'miami ohio'], ['Northern Illinois', 'IL', 'niu'],
  ['Ohio', 'OH'], ['Toledo', 'OH'], ['Western Michigan', 'MI'], ['UMass', 'MA', 'massachusetts', 'massachusetts amherst'],
  // Mountain West
  ['Air Force', 'CO', 'air force academy', 'united states air force academy'], ['Boise State', 'ID'], ['Colorado State', 'CO'],
  ['Fresno State', 'CA', 'california state fresno'], ['Hawaii', 'HI', 'hawaii manoa'], ['Nevada', 'NV', 'nevada reno'], ['New Mexico', 'NM'],
  ['San Diego State', 'CA'], ['San Jose State', 'CA'], ['UNLV', 'NV', 'nevada las vegas'], ['Utah State', 'UT'], ['Wyoming', 'WY'],
  // Sun Belt
  ['Appalachian State', 'NC', 'app state'], ['Arkansas State', 'AR'], ['Coastal Carolina', 'SC'], ['Georgia Southern', 'GA'],
  ['Georgia State', 'GA'], ['James Madison', 'VA', 'jmu'], ['Louisiana', 'LA', 'louisiana lafayette', 'ul lafayette'],
  ['UL Monroe', 'LA', 'louisiana monroe', 'ulm'], ['Marshall', 'WV'], ['Old Dominion', 'VA', 'odu'], ['South Alabama', 'AL'],
  ['Southern Miss', 'MS', 'southern mississippi'], ['Texas State', 'TX'], ['Troy', 'AL'],
  // Pac-12 and independents
  ['Oregon State', 'OR'], ['Washington State', 'WA'], ['UConn', 'CT', 'connecticut'],
];
// High-major basketball outside the football Power 4: the Big East and
// Gonzaga. Power 4 level for a basketball player, other Division I otherwise.
const HOOPS_MAJOR = [
  ['Butler', 'IN'], ['Creighton', 'NE'], ['DePaul', 'IL'], ['Georgetown', 'DC'], ['Marquette', 'WI'], ['Providence', 'RI'],
  ['Seton Hall', 'NJ'], ['St. John\'s', 'NY', 'st johns', 'saint johns'], ['Villanova', 'PA'], ['Xavier', 'OH'], ['Gonzaga', 'WA'],
];

// "University of North Carolina at Chapel Hill" -> "north carolina chapel hill".
// "college" stays: Boston College and Boston University are two schools.
const DROP = new Set(['university', 'of', 'the', 'at', 'in', 'main', 'campus']);
function schoolKey(name) {
  return fold(String(name || '').replace(/\([^)]*\)/g, ' ')).split(' ').filter((w) => w && !DROP.has(w)).join(' ');
}
function parenOf(name) { const m = String(name || '').match(/\(([^)]+)\)/); return m ? m[1].trim() : null; }

function indexOf(list, level) {
  const m = new Map();
  for (const [name, st, ...aliases] of list) {
    for (const k of new Set([schoolKey(name), ...aliases.map(schoolKey)])) {
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push({ name, state: st, level });
    }
  }
  return m;
}
const CONF_INDEX = (() => {
  const m = new Map();
  for (const idx of [indexOf(P4, 'p4'), indexOf(G5, 'g5'), indexOf(HOOPS_MAJOR, 'hoops')]) {
    for (const [k, v] of idx) m.set(k, (m.get(k) || []).concat(v));
  }
  return m;
})();

function stateCodeOf(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  if (/^(fl|florida)$/i.test(t)) return 'FL';
  try { const c = require('./schoolResolver').stateCode(t); return c && /^[A-Z]{2}$/.test(c) ? c : null; } catch (_) { return null; }
}

// -> { entry, ambiguous: [entries] } | null
function conferenceMatch(names, state) {
  const st = stateCodeOf(state);
  for (const n of names) {
    const hits = CONF_INDEX.get(schoolKey(n));
    if (!hits || !hits.length) continue;
    const ph = stateCodeOf(parenOf(n));
    const s2 = ph || st;
    if (hits.length === 1 && (!s2 || hits[0].state === s2)) return { entry: hits[0] };
    if (s2) { const one = hits.filter((h) => h.state === s2); if (one.length === 1) return { entry: one[0] }; if (!one.length) continue; }
    return { ambiguous: hits };
  }
  return null;
}

const DIVISION_SETS = (() => {
  const out = { d2: new Set(), d3: new Set(), naia: new Set() };
  try {
    const SD = require('./schoolsDivisions');
    for (const k of ['d2', 'd3', 'naia']) {
      const parsed = SD.parse(SD[k.toUpperCase()]);
      for (const name of Object.keys(parsed)) out[k].add(schoolKey(name));
    }
  } catch (_) { /* the agent's division still decides */ }
  return out;
})();

const LEVEL = {
  pro: { pts: 15, label: 'a professional' },
  p4: { pts: 15, label: 'Power 4' },
  g5: { pts: 11, label: 'Group of 5' },
  fcs: { pts: 8, label: 'FCS / other Division I' },
  d2: { pts: 5, label: 'Division II' },
  naia: { pts: 4, label: 'NAIA' },
  d3: { pts: 3, label: 'Division III' },
  juco: { pts: 3, label: 'junior college' },
  hs: { pts: 2, label: 'high school' },
};
const DIV_WORDS = {
  d1: 'd1', 'division i': 'd1', 'ncaa d1': 'd1', fbs: 'fbs', fcs: 'fcs', d2: 'd2', 'division ii': 'd2', d3: 'd3', 'division iii': 'd3',
  naia: 'naia', juco: 'juco', njcaa: 'juco', cccaa: 'juco', 'junior college': 'juco', jc: 'juco', hs: 'hs', 'high school': 'hs',
};

// rec: services/athleteRecord.resolveAthlete's record (school, schoolState,
// division, athleteType, sport). -> { level, pts, confidence, why }
function levelOf(rec, sportKey) {
  const a = rec || {};
  if (a.athleteType === 'pro') return { level: 'pro', ...LEVEL.pro, confidence: 1, why: 'a professional athlete' };
  const school = String(a.school || '').trim();
  const div = DIV_WORDS[String(a.division || '').trim().toLowerCase()] || null;
  const names = [school];
  let resolved = null;
  if (school) {
    try { resolved = require('./schoolResolver').resolveSchool(school); } catch (_) { resolved = null; }
    if (resolved && resolved.matched) names.push(resolved.matched);
  }
  const state = a.schoolState || (resolved && resolved.state) || null;
  const hoops = sportKey === 'mbb' || sportKey === 'wbb' || sportKey === 'basketball';
  const conf = school ? conferenceMatch(names, state) : null;
  const fromConf = (e) => {
    if (e.level === 'hoops') {
      return hoops ? { level: 'p4', ...LEVEL.p4, label: 'high-major basketball', confidence: 1, why: `${e.name}, high-major basketball (Big East / Gonzaga)` }
        : { level: 'fcs', ...LEVEL.fcs, confidence: 1, why: `${e.name}, Division I` };
    }
    return { level: e.level, ...LEVEL[e.level], confidence: 1, why: `${e.name}, ${LEVEL[e.level].label}` };
  };
  if (conf && conf.entry && (!div || div === 'd1' || div === 'fbs')) return fromConf(conf.entry);
  if (conf && conf.ambiguous && (!div || div === 'd1' || div === 'fbs')) {
    // Two schools by this name and no state to tell them apart: counted at the
    // lower of the two, at half confidence, until the state is on the record.
    const levels = conf.ambiguous.map((e) => (e.level === 'hoops' ? 'fcs' : e.level));
    const low = levels.sort((x, y) => LEVEL[x].pts - LEVEL[y].pts)[0];
    return { level: low, ...LEVEL[low], confidence: 0.5,
      why: `"${school}" is ${conf.ambiguous.map((e) => (/\(/.test(e.name) ? e.name : `${e.name} (${e.state})`)).join(' or ')}; counted as ${LEVEL[low].label} until the state is set` };
  }
  if (div === 'fbs') return { level: 'g5', ...LEVEL.g5, confidence: 0.7, why: `FBS by the agent's division, school not on the Power 4 list` };
  if (div && div !== 'd1' && LEVEL[div]) return { level: div, ...LEVEL[div], confidence: 0.9, why: `${LEVEL[div].label}, as the agent set it` };
  // The lists, then the shared level reader (services/athleteTier).
  const keys = names.map(schoolKey);
  for (const k of ['d2', 'naia', 'd3']) {
    if (keys.some((x) => DIVISION_SETS[k].has(x))) return { level: k, ...LEVEL[k], confidence: 0.9, why: `${school}, ${LEVEL[k].label}` };
  }
  let base = 'unconfirmed';
  try { base = require('./athleteTier').levelOf(a); } catch (_) { base = 'unconfirmed'; }
  if (base === 'juco') return { level: 'juco', ...LEVEL.juco, confidence: 0.9, why: `${school || 'school'}, a junior college` };
  if (base === 'd1' || div === 'd1') return { level: 'fcs', ...LEVEL.fcs, confidence: 0.8, why: `${school}, Division I, not on the Power 4 or Group of 5 lists` };
  if (base === 'small') return { level: 'd3', ...LEVEL.d3, confidence: 0.5, why: `${school}, a small college whose division is not recorded; counted as Division III` };
  if (div === 'hs') return { level: 'hs', ...LEVEL.hs, confidence: 0.9, why: 'high school, as the agent set it' };
  try { if (school && require('./athleteCreate').isHighSchool(school)) return { level: 'hs', ...LEVEL.hs, confidence: 0.9, why: `${school}, a high school` }; } catch (_) { /* not checked */ }
  return { level: null, pts: 0, label: null, confidence: 0, why: school ? `the level of "${school}" is not confirmed` : 'no school on file' };
}

// ── SPORT ───────────────────────────────────────────────────────────────────
// The revenue sports weigh most. A bare "basketball" with no men's or women's
// on the record takes the women's weight, the lower of the two.
function sportOf(raw) {
  const s = fold(raw);
  if (!s) return null;
  const women = /\b(women|womens|w|girls|lady|ladies)\b/.test(s);
  const men = /\b(men|mens|boys)\b/.test(s);
  const r = (key, label, pts, note) => ({ key, label, pts, note: note || null });
  if (/\bfootball\b/.test(s) && !/\bflag\b/.test(s)) return r('football', 'football', 10);
  if (/basketball|\bmbb\b|\bwbb\b/.test(s)) {
    if (women || /\bwbb\b/.test(s)) return r('wbb', 'women\'s basketball', 9);
    if (men || /\bmbb\b/.test(s)) return r('mbb', 'men\'s basketball', 10);
    return r('basketball', 'basketball', 9, 'men\'s or women\'s is not recorded, so the women\'s weight is used');
  }
  if (/volleyball/.test(s)) return r('volleyball', 'volleyball', 7);
  if (/gymnast/.test(s)) return r('gymnastics', 'gymnastics', 7);
  if (/baseball/.test(s)) return r('baseball', 'baseball', 6);
  if (/softball/.test(s)) return r('softball', 'softball', 6);
  if (/hockey/.test(s)) return r('hockey', 'hockey', 5);
  if (/soccer/.test(s)) return r('soccer', 'soccer', 5);
  if (/lacrosse/.test(s)) return r('lacrosse', 'lacrosse', 5);
  if (/wrestl/.test(s)) return r('wrestling', 'wrestling', 5);
  if (/track|cross country|\bxc\b/.test(s)) return r('track', 'track and field', 4);
  if (/swim|diving/.test(s)) return r('swimming', 'swimming and diving', 4);
  if (/tennis/.test(s)) return r('tennis', 'tennis', 4);
  if (/golf/.test(s)) return r('golf', 'golf', 4);
  if (/row|crew/.test(s)) return r('rowing', 'rowing', 3);
  return r('other', String(raw).trim().toLowerCase(), 4);
}

// ── SOCIAL ──────────────────────────────────────────────────────────────────
// Followers on a log scale: 100 is nothing, 1,000,000 is the full 22.
// TikTok and X followers count at half: they are cheaper to gain and a brand
// pays less for them.
const PLATFORM_WEIGHT = { instagram: 1, tiktok: 0.5, twitter: 0.5 };
const PLATFORM_NAME = { instagram: 'Instagram', tiktok: 'TikTok', twitter: 'X' };
function reachPoints(effective) {
  if (!(effective > 0)) return 0;
  return round1(22 * clamp01((Math.log10(effective) - 2) / 4));
}
function engagementPoints(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p) || p <= 0) return 0;
  if (p >= 8) return 8;
  if (p >= 5) return 6.5;
  if (p >= 3) return 5;
  if (p >= 1.5) return 3;
  if (p >= 0.5) return 1.5;
  return 0;
}

// rec: the resolved athlete; raw: the stored data JSON; cols: the athletes
// row's follower columns; ig: instagramConnect.latestFor's row or null.
function socialOf({ rec, raw, cols, ig, now }) {
  const a = rec || {};
  const d = raw || {};
  const platforms = [];
  // Instagram: a connected account first. It is current by construction.
  if (ig && ig.followers_count != null) {
    const rate = ig.engagement_rate != null ? Number(ig.engagement_rate) * 100 : null;
    platforms.push({ platform: 'instagram', followers: Number(ig.followers_count), source: 'connected Instagram',
      asOf: ig.fetched_at ? new Date(ig.fetched_at).toISOString().slice(0, 10) : null, confidence: 1,
      engagement: Number.isFinite(rate) ? round1(rate) : null });
  }
  let prov = null;
  try { prov = require('./reachProvenance').reachProvenance(a, now); } catch (_) { prov = null; }
  const handTyped = (n) => {
    if (!prov) return 0.5;
    if (prov.isLive) return 1;
    if (prov.stale) return 0.5;
    if (prov.asOf) return 0.75;
    return 0.6;
  };
  const typedLabel = prov ? (prov.isLive ? 'connected Instagram'
    : ([prov.sourceLabel, prov.label && !/date not recorded/.test(prov.label) ? prov.label : (prov.sourceLabel ? 'date not recorded' : prov.label)].filter(Boolean).join(', ') || 'hand-entered')) : 'hand-entered';
  if (!platforms.length && a.instagram) {
    platforms.push({ platform: 'instagram', followers: Number(a.instagram), source: typedLabel, asOf: prov && prov.asOfText, confidence: handTyped(),
      engagement: a.engagement != null && Number.isFinite(Number(a.engagement)) ? Number(a.engagement) : null });
  }
  if (a.tiktok) platforms.push({ platform: 'tiktok', followers: Number(a.tiktok), source: typedLabel, asOf: prov && prov.asOfText, confidence: handTyped() });
  const tw = Number(cols && cols.twitter_followers) || Number(d.twitter) || Number(d.twitterFollowers) || null;
  if (tw) platforms.push({ platform: 'twitter', followers: tw, source: 'hand-entered', confidence: 0.6 });

  const reasons = [];
  if (!platforms.length) {
    return { points: 0, max: 30, confidence: 0, platforms, reasons: ['0 social: no follower count on file for any platform'],
      missing: ['follower counts'] };
  }
  const effective = platforms.reduce((s, p) => s + p.followers * (PLATFORM_WEIGHT[p.platform] || 0.5), 0);
  const rPts = reachPoints(effective);
  const total = platforms.reduce((s, p) => s + p.followers, 0);
  const wConf = platforms.reduce((s, p) => s + p.confidence * p.followers * (PLATFORM_WEIGHT[p.platform] || 0.5), 0) / (effective || 1);
  reasons.push(`+${rPts} reach: ${fmtN(total)} followers (`
    + platforms.map((p) => `${PLATFORM_NAME[p.platform] || p.platform} ${fmtN(p.followers)}, ${p.source}${p.asOf && !/as of/.test(p.source) ? ' as of ' + p.asOf : ''}`).join('; ') + ')');
  const igRow = platforms.find((p) => p.platform === 'instagram' && p.engagement != null);
  let ePts = 0, eConf = 0;
  const missing = [];
  if (igRow) {
    ePts = engagementPoints(igRow.engagement);
    eConf = igRow.confidence;
    reasons.push(`+${ePts} engagement: ${igRow.engagement}% on Instagram (${igRow.source})`);
  } else {
    missing.push('engagement rate');
    reasons.push('0 engagement: no engagement rate on file');
  }
  const points = round1(rPts + ePts);
  // Reach is 22 of the 30, engagement 8: the confidence is weighted the same way.
  const confidence = round1(((22 * wConf) + (8 * eConf)) / 30 * 100) / 100;
  return { points, max: 30, confidence, platforms, effectiveReach: Math.round(effective), reasons, missing };
}

// ── PERFORMANCE ─────────────────────────────────────────────────────────────
// What the record SAYS, matched on the words that mean something to a
// sponsor. Each signal names the text it came from.
const PERF_SIGNALS = [
  { key: 'all_american', pts: 8, label: 'All-American', re: /\ball[\s-]?american\b/i },
  { key: 'poy', pts: 6, label: 'player of the year / MVP', re: /\b(player|freshman|rookie|newcomer|pitcher|defensive player|offensive player|setter|goalkeeper) of the year\b|\bmvp\b/i },
  { key: 'all_conference', pts: 5, label: 'All-Conference', re: /\ball[\s-]?(conference|sec|acc|big ten|big 12|big east|pac[\s-]?12|aac|mac|mwc|mountain west|sun belt|c[\s-]?usa|wcc|a[\s-]?10|ivy|patriot|colonial|caa|southland|swac|meac|ovc|summit|horizon|maac|big sky|big south|socon|southern|asun|wac|nec|america east|big west|missouri valley|mvc|gliac|gsc|psac|lone star|rmac|nsic|miaa|gac|sac|siac|ciaa|ccaa|gnac|pacwest|ssc|nescac|uaa|centennial|liberty league|odac|usa south|wiac|ccac|ncac|heartland|american rivers|iiac|scac|naia|njcaa|region|district|state)\b|\b(first|second|third|1st|2nd|3rd)[\s-]team\b|\ball[\s-]league\b/i },
  { key: 'stars5', pts: 6, label: 'five-star recruit', re: /\b(5|five)[\s-]?star\b/i },
  { key: 'stars4', pts: 4, label: 'four-star recruit', re: /\b(4|four)[\s-]?star\b/i },
  { key: 'stars3', pts: 2, label: 'three-star recruit', re: /\b(3|three)[\s-]?star\b/i },
  { key: 'draft', pts: 4, label: 'draft prospect', re: /\bdraft(ed)?\b|\bprospect\b|\bdeclared\b/i },
  { key: 'starter', pts: 3, label: 'starter', re: /\bstarter\b|\bstarting\b|\bstarted (\d+|all|every)\b|\bstarts\b|\bqb1\b|\bopening day\b/i },
  { key: 'captain', pts: 2, label: 'team captain', re: /\bcaptain\b/i },
  { key: 'record', pts: 3, label: 'record holder / champion', re: /\brecord[\s-]?(holder|setting|breaking)\b|\b(school|program|conference|national) record\b|\b(national|conference|state) champion(ship)?s?\b/i },
  { key: 'stats', pts: 2, label: 'a stat line', re: /\b\d+(\.\d+)?\s*(ppg|rpg|apg|pts|points|rebounds|assists|yards|yds|tds?|touchdowns|goals|saves|kills|digs|blocks|aces|era|rbis?|hrs?|home runs|avg|batting|strikeouts|ks|tackles|sacks|interceptions|ints|receptions|catches|steals)\b|\.\d{3}\b/i },
];
const STAR_KEYS = ['stars5', 'stars4', 'stars3'];
function performanceOf(raw, rec) {
  const d = raw || {};
  const a = rec || {};
  const fields = [['stats', d.stats || a.stats], ['known for', d.knownFor], ['highlight', d.highlight], ['draft status', d.draftStatus],
    ['notes', d.notes || a.notes], ['awards', Array.isArray(d.awards) ? d.awards.join('; ') : d.awards], ['honors', d.honors],
    ['recruiting', d.recruiting || d.recruitingStars]]
    .filter(([, v]) => v != null && String(v).trim());
  if (d.starter === true) fields.push(['starter', 'starter']);
  if (!fields.length) {
    return { points: 0, max: 20, confidence: 0, signals: [], reasons: ['0 performance: no stats, awards, honors or notes on file'], missing: ['performance'] };
  }
  const signals = [];
  for (const sig of PERF_SIGNALS) {
    if (STAR_KEYS.includes(sig.key) && signals.some((s) => STAR_KEYS.includes(s.key))) continue;
    for (const [field, val] of fields) {
      const text = String(val);
      const m = text.match(sig.re);
      if (!m) continue;
      // "not a starter", "no stars": a negated mention is not the signal.
      const before = text.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
      if (/\b(not|no|non|never|former)\b(\s+(a|an|the|yet a))?[\s-]*$/.test(before)) continue;
      const at = Math.max(0, m.index - 30);
      signals.push({ key: sig.key, pts: sig.pts, label: sig.label, field, quote: text.slice(at, m.index + m[0].length + 30).replace(/\s+/g, ' ').trim() });
      break;
    }
  }
  const raw_ = signals.reduce((s, x) => s + x.pts, 0);
  const points = Math.min(20, raw_);
  const reasons = signals.length
    ? signals.map((s) => `+${s.pts} ${s.label} (${s.field}: "${s.quote.slice(0, 80)}")`)
    : [`0 performance: the record's ${fields.map((f) => f[0]).join(', ')} name no starter role, award, honor, ranking or stat line`];
  if (raw_ > 20) reasons.push(`performance capped at 20 (signals add to ${raw_})`);
  // Typed by an agent or the athlete, not checked against a box score: 0.8.
  // Text that says nothing measurable: 0.5 (we read it, it did not say).
  return { points, max: 20, confidence: signals.length ? 0.8 : 0.5, signals, reasons, missing: [] };
}

// ── MEDIA ───────────────────────────────────────────────────────────────────
const NATIONAL_OUTLETS = /(^|\.)(espn\.com|si\.com|on3\.com|247sports\.com|theathletic\.com|nytimes\.com|usatoday\.com|sports\.yahoo\.com|yahoo\.com|cbssports\.com|foxsports\.com|nbcsports\.com|bleacherreport\.com|apnews\.com|ncaa\.com|maxpreps\.com|rivals\.com)$/i;
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; } }
function mediaOf(news, now) {
  if (!news || !news.searchedAt) {
    return { points: 0, max: 10, confidence: 0, mentions: 0, reasons: ['0 media: news mentions not searched yet'], missing: ['news mentions'] };
  }
  const t = (now ? new Date(now) : new Date()).getTime();
  const recent = (news.mentions || []).filter((m) => m.published_on && (t - new Date(m.published_on).getTime()) <= NEWS_DAYS * 86400000);
  const indep = recent.filter((m) => m.kind !== 'school');
  const school = recent.filter((m) => m.kind === 'school');
  const n = indep.length;
  let pts = n >= 8 ? 8 : n >= 4 ? 6.5 : n >= 2 ? 5 : n === 1 ? 3 : 0;
  const national = indep.filter((m) => NATIONAL_OUTLETS.test(hostOf(m.url)));
  if (national.length) pts += 1;
  if (school.length) pts += Math.min(1, school.length * 0.5);
  pts = Math.min(10, round1(pts));
  const searched = new Date(news.searchedAt).toISOString().slice(0, 10);
  const reasons = [];
  if (news.fault && !recent.length) {
    return { points: 0, max: 10, confidence: 0, mentions: 0, reasons: [`0 media: the news search failed on our side (${news.fault})`], missing: ['news mentions'] };
  }
  if (!recent.length) reasons.push(`0 media: no news mentions in the last ${NEWS_DAYS} days (searched ${searched})`);
  else {
    reasons.push(`+${pts} media: ${n} news mention${n === 1 ? '' : 's'}${national.length ? ` (${national.length} national: ${[...new Set(national.map((m) => hostOf(m.url)))].slice(0, 3).join(', ')})` : ''}`
      + `${school.length ? ` and ${school.length} school release${school.length === 1 ? '' : 's'}` : ''} in the last ${NEWS_DAYS} days (searched ${searched})`);
    for (const m of recent.slice(0, 3)) reasons.push(`   ${m.published_on ? String(m.published_on).slice(0, 10) : ''} ${hostOf(m.url)}: ${String(m.title || '').slice(0, 90)}`);
  }
  // A search can miss coverage: 0.8, never 1.
  return { points: pts, max: 10, confidence: 0.8, mentions: n, national: national.length, schoolReleases: school.length, reasons, missing: [] };
}

// ── MARKET ──────────────────────────────────────────────────────────────────
// City population on a log scale: 10,000 is nothing, about 3.2 million is the
// full 15.
function marketPoints(pop) {
  if (!(pop > 0)) return 0;
  return round1(15 * clamp01((Math.log10(pop) - 4) / 2.5));
}
// cityPop: { pop, place, state, source } | null. pool: { usable, rows } | null.
function marketOf({ rec, cityPop, pool }) {
  const a = rec || {};
  const where = a.market || (a.schoolCity ? a.schoolCity + (a.schoolState ? ', ' + a.schoolState : '') : null);
  if (!where) return { points: 0, max: 15, confidence: 0, reasons: ['0 market: no school city on file'], missing: ['school city'] };
  if (cityPop && cityPop.pop > 0) {
    const pts = marketPoints(cityPop.pop);
    return { points: pts, max: 15, confidence: 0.9, population: cityPop.pop, place: cityPop.place,
      reasons: [`+${pts} market: ${where}, ${fmtN(cityPop.pop)} people (${cityPop.source || '2020 Census'}, ${cityPop.place})`], missing: [] };
  }
  if (pool && pool.usable > 0) {
    // Not a population: how many usable local businesses we hold for the
    // market. 600 or more is a big-city pool. Low confidence by design.
    const pts = round1(Math.min(15, 15 * clamp01(Math.log10(pool.usable) / Math.log10(600))) * 0.6);
    return { points: pts, max: 15, confidence: 0.4, poolUsable: pool.usable,
      reasons: [`+${pts} market: ${where}, city population not available; ${fmtN(pool.usable)} usable local businesses in our pool used instead (low confidence)`],
      missing: ['city population'] };
  }
  return { points: 0, max: 15, confidence: 0, reasons: [`0 market: ${where}, city population not available and no local business pool yet`], missing: ['city population'] };
}

// ── THE SCORE ───────────────────────────────────────────────────────────────
// inputs: { rec, raw, cols, ig, news, cityPop, pool, now }
function score(inputs) {
  const i = inputs || {};
  const rec = i.rec || {};
  const sport = sportOf(rec.sport || (i.raw && i.raw.sport));
  const lvl = levelOf(rec, sport && sport.key);
  const lsPts = round1((lvl.pts || 0) + (sport ? sport.pts : 0));
  const lsConf = round1(((15 * (lvl.confidence || 0)) + (10 * (sport ? 1 : 0))) / 25 * 100) / 100;
  const levelSport = {
    points: lsPts, max: 25, confidence: lsConf, level: lvl.level, levelLabel: lvl.level ? (lvl.label || LEVEL[lvl.level].label) : null,
    sport: sport ? sport.label : null,
    reasons: [
      lvl.level ? `+${lvl.pts} level: ${lvl.why}` : `0 level: ${lvl.why}`,
      sport ? `+${sport.pts} sport: ${sport.label}${sport.pts >= 9 ? ' (a revenue sport)' : ''}${sport.note ? '; ' + sport.note : ''}` : '0 sport: no sport on file',
    ],
    missing: [].concat(lvl.level ? [] : ['school level'], sport ? [] : ['sport']),
  };
  const social = socialOf({ rec, raw: i.raw, cols: i.cols, ig: i.ig, now: i.now });
  const performance = performanceOf(i.raw, rec);
  const media = mediaOf(i.news, i.now);
  const market = marketOf({ rec, cityPop: i.cityPop, pool: i.pool });
  const components = { levelSport, social, performance, media, market };
  const total = Math.round(Object.values(components).reduce((s, c) => s + c.points, 0));
  const scoreN = Math.max(0, Math.min(100, total));
  // How much of the 100 the data behind it covers.
  const confidence = Math.round(Object.values(components).reduce((s, c) => s + c.max * c.confidence, 0)) / 100;
  const tier = tierFor(scoreN);
  // What drove it: the components, biggest first, then what is missing.
  const order = Object.entries(components).sort((x, y) => y[1].points - x[1].points);
  const reasons = [];
  for (const [, c] of order) reasons.push(...c.reasons);
  const missing = [].concat(...Object.values(components).map((c) => c.missing || []));
  return { score: scoreN, tier: tier.key, tierLabel: tier.label, confidence, components, reasons, missing };
}

// ── STORAGE ─────────────────────────────────────────────────────────────────
let _ready = null;
function ensureTables(pool) {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS athlete_market_scores (
      id SERIAL PRIMARY KEY,
      athlete_id TEXT NOT NULL,
      agent_id TEXT,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      score INTEGER NOT NULL,
      tier TEXT NOT NULL,
      confidence NUMERIC NOT NULL,
      components JSONB NOT NULL,
      reasons JSONB NOT NULL,
      missing JSONB
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS athlete_market_scores_ath ON athlete_market_scores (athlete_id, computed_at DESC)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS athlete_news_mentions (
      athlete_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      outlet TEXT,
      kind TEXT,
      published_on DATE,
      found_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (athlete_id, url)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS athlete_news_searches (
      athlete_id TEXT PRIMARY KEY,
      searched_at TIMESTAMPTZ,
      found INTEGER,
      fault TEXT
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS census_place_pop (
      state TEXT NOT NULL,
      place_key TEXT NOT NULL,
      place TEXT,
      pop INTEGER,
      PRIMARY KEY (state, place_key)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS census_state_fetch (
      state TEXT PRIMARY KEY,
      fetched_at TIMESTAMPTZ,
      places INTEGER,
      fault TEXT
    )`);
  })().catch((e) => { _ready = null; throw e; });
  return _ready;
}

async function latestFor(pool, athleteId) {
  await ensureTables(pool);
  const r = await pool.query(`SELECT * FROM athlete_market_scores WHERE athlete_id = $1 ORDER BY computed_at DESC, id DESC LIMIT 1`, [athleteId]);
  const row = r.rows[0];
  if (!row) return null;
  return { athleteId: row.athlete_id, score: row.score, tier: row.tier, tierLabel: TIER_LABEL[row.tier] || row.tier,
    confidence: Number(row.confidence), components: row.components, reasons: row.reasons, missing: row.missing || [], computedAt: row.computed_at };
}

// ── CITY POPULATION (2020 CENSUS) ───────────────────────────────────────────
const STATE_FIPS = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11', FL: '12', GA: '13', HI: '15', ID: '16',
  IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29',
  MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42',
  RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56', PR: '72',
};
const CENSUS_URL = (fips) => `https://api.census.gov/data/2020/dec/pl?get=NAME,P1_001N&for=place:*&in=state:${fips}`;
// "Athens-Clarke County unified government (balance), Georgia" -> ["athens clarke county", "athens"]
function placeKeys(censusName) {
  const base = String(censusName || '').split(',')[0]
    .replace(/\s*\(balance\)\s*/i, ' ')
    .replace(/\s+(city|town|village|borough|cdp|municipality|urban county|consolidated government|metropolitan government|metro government|unified government|city and borough|plantation|comunidad|zona urbana)\b.*$/i, '')
    .trim();
  const keys = [fold(base)];
  const first = base.split(/[-/]/)[0].trim();
  if (first && fold(first) !== keys[0]) keys.push(fold(first));
  return keys.filter(Boolean);
}
async function loadState(pool, st, { fetchImpl, timeoutMs = 15000 } = {}) {
  const fips = STATE_FIPS[st];
  if (!fips) return { ok: false, fault: `no FIPS code for ${st}` };
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, fault: 'no fetch' };
  let rows;
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    const res = await f(CENSUS_URL(fips), { signal: ac.signal }).finally(() => clearTimeout(to));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    rows = await res.json();
  } catch (e) {
    await pool.query(`INSERT INTO census_state_fetch (state, fetched_at, places, fault) VALUES ($1, NOW(), 0, $2)
                      ON CONFLICT (state) DO UPDATE SET fetched_at = NOW(), fault = EXCLUDED.fault`, [st, String(e.message || e).slice(0, 200)]).catch(() => {});
    return { ok: false, fault: e.message || String(e) };
  }
  if (!Array.isArray(rows) || rows.length < 2) return { ok: false, fault: 'empty answer' };
  const best = new Map();
  for (const r of rows.slice(1)) {
    const name = r[0];
    const pop = parseInt(r[1], 10);
    if (!name || !(pop > 0)) continue;
    const keys = placeKeys(name);
    keys.forEach((k, i) => {
      const prev = best.get(k);
      // The full name always wins over a first-part key ("Athens" the city
      // over "Athens" read off "Athens-Clarke County").
      if (!prev || (i === 0 && prev.partial) || (prev.partial === (i > 0) && pop > prev.pop)) best.set(k, { place: name, pop, partial: i > 0 });
    });
  }
  for (const [k, v] of best) {
    await pool.query(`INSERT INTO census_place_pop (state, place_key, place, pop) VALUES ($1,$2,$3,$4)
                      ON CONFLICT (state, place_key) DO UPDATE SET place = EXCLUDED.place, pop = EXCLUDED.pop`, [st, k, v.place, v.pop]);
  }
  await pool.query(`INSERT INTO census_state_fetch (state, fetched_at, places, fault) VALUES ($1, NOW(), $2, NULL)
                    ON CONFLICT (state) DO UPDATE SET fetched_at = NOW(), places = EXCLUDED.places, fault = NULL`, [st, best.size]);
  return { ok: true, places: best.size };
}
// -> { pop, place, state, source } | { fault } | null
async function cityPopulation(pool, city, state, opts = {}) {
  const st = stateCodeOf(state);
  const key = fold(String(city || '').split(',')[0]);
  if (!st || !key) return null;
  await ensureTables(pool);
  const read = async () => (await pool.query(`SELECT place, pop FROM census_place_pop WHERE state = $1 AND place_key = $2`, [st, key])).rows[0] || null;
  let hit = await read();
  if (hit) return { pop: hit.pop, place: hit.place, state: st, source: '2020 Census' };
  const f = (await pool.query(`SELECT fetched_at, places, fault FROM census_state_fetch WHERE state = $1`, [st])).rows[0];
  // Loaded once per state. A failed load is tried again after a day.
  if (f && !f.fault) return null;
  if (f && f.fault && Date.now() - new Date(f.fetched_at).getTime() < 86400000) return { fault: f.fault };
  if (opts.noFetch) return null;
  const l = await loadState(pool, st, opts);
  if (!l.ok) return { fault: l.fault };
  hit = await read();
  return hit ? { pop: hit.pop, place: hit.place, state: st, source: '2020 Census' } : null;
}

// ── NEWS MENTIONS ───────────────────────────────────────────────────────────
// One web search per athlete per week. Only articles the search itself
// returned are kept (the URL must be among the search results), they must be
// dated within 90 days, and the athlete's last name must appear in the
// result's title or in the text the model quoted from it.
function newsPrompt({ name, school, sport, since }) {
  return `Find news articles published on or after ${since} that mention the ${sport || 'college'} athlete ${name}`
    + `${school ? ` of ${school}` : ''}. Search news sites. Include only articles that name this athlete; `
    + 'exclude roster pages, stat pages, recruiting databases and social media posts. '
    + 'For each article quote one sentence that names the athlete.\n\n'
    + 'Return ONLY this JSON, nothing else:\n'
    + '{"articles":[{"url":"","title":"","outlet":"","date":"YYYY-MM-DD","kind":"news|school"}]}\n'
    + '"kind" is "school" for the school\'s own athletics site, "news" for everything else. An empty list is a fine answer.';
}
const ATHLETICS_DOMAINS = (() => {
  try { return new Set(Object.values(require('../data/fbsSchools').FBS_SCHOOLS).map((d) => String(d).toLowerCase().replace(/^www\./, ''))); } catch (_) { return new Set(); }
})();
function parseNews(msg, { name, school, now }) {
  const blocks = (msg && msg.content) || [];
  const results = new Map();     // url -> { title, page_age }
  const quoted = new Map();      // url -> cited text
  for (const b of blocks) {
    if (b && b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r && r.url) results.set(r.url, { title: r.title || '', pageAge: r.page_age || null });
    }
    if (b && b.type === 'text' && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c && c.url) quoted.set(c.url, (quoted.get(c.url) || '') + ' ' + (c.cited_text || ''));
    }
  }
  const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  let parsed = null;
  try { const m = text.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; } catch (_) { parsed = null; }
  const out = [], dropped = [];
  const last = fold(String(name || '').trim().split(/\s+/).slice(-1)[0]);
  const t = (now ? new Date(now) : new Date()).getTime();
  // The school's own athletics site: an .edu, an "athletics" host, or an FBS
  // athletics domain (data/fbsSchools). Everything else is independent news.
  const schoolHost = (u) => { const h = hostOf(u); return /\.edu$|athletics/i.test(h) || ATHLETICS_DOMAINS.has(h); };
  for (const a of ((parsed && parsed.articles) || [])) {
    const url = a && String(a.url || '').trim();
    if (!url) continue;
    const r = results.get(url);
    if (!r) { dropped.push({ url, why: 'not among the search results' }); continue; }
    const hay = fold(`${r.title} ${quoted.get(url) || ''}`);
    if (!last || !new RegExp(`\\b${last}\\b`).test(hay)) { dropped.push({ url, why: 'the result does not name the athlete' }); continue; }
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(a.date || '')) ? new Date(a.date + 'T12:00:00Z') : null;
    if (!d || isNaN(d.getTime())) { dropped.push({ url, why: 'no date' }); continue; }
    if (t - d.getTime() > NEWS_DAYS * 86400000 || d.getTime() - t > 2 * 86400000) { dropped.push({ url, why: 'outside the last 90 days' }); continue; }
    const kind = a.kind === 'school' || schoolHost(url) ? 'school' : 'news';
    out.push({ url, title: r.title || a.title || null, outlet: a.outlet || hostOf(url), kind, published_on: a.date });
  }
  return { mentions: out, dropped, results: results.size };
}
async function searchNews(pool, rec, { webSearch, now, ctx } = {}) {
  await ensureTables(pool);
  const since = new Date((now ? new Date(now) : new Date()).getTime() - NEWS_DAYS * 86400000).toISOString().slice(0, 10);
  const ws = webSearch || ((o) => require('../ai').webSearchMessage(o));
  let res;
  try {
    const msg = await ws({ prompt: newsPrompt({ name: rec.name, school: rec.school, sport: rec.sport, since }),
      system: 'You report news coverage of one athlete. Report only articles that appear in your search results. Return only JSON.',
      maxSearches: 3, maxTokens: 1500, ctx: ctx || { site: 'market-news', athleteId: rec.id } });
    res = parseNews(msg, { name: rec.name, school: rec.school, now });
  } catch (e) {
    await pool.query(`INSERT INTO athlete_news_searches (athlete_id, searched_at, found, fault) VALUES ($1, NOW(), 0, $2)
                      ON CONFLICT (athlete_id) DO UPDATE SET searched_at = NOW(), found = 0, fault = EXCLUDED.fault`, [rec.id, String(e.message || e).slice(0, 200)]);
    return { fault: e.message || String(e), mentions: [] };
  }
  for (const m of res.mentions) {
    await pool.query(`INSERT INTO athlete_news_mentions (athlete_id, url, title, outlet, kind, published_on) VALUES ($1,$2,$3,$4,$5,$6)
                      ON CONFLICT (athlete_id, url) DO UPDATE SET title = EXCLUDED.title, kind = EXCLUDED.kind, published_on = EXCLUDED.published_on`,
    [rec.id, m.url, m.title, m.outlet, m.kind, m.published_on]);
  }
  await pool.query(`INSERT INTO athlete_news_searches (athlete_id, searched_at, found, fault) VALUES ($1, NOW(), $2, NULL)
                    ON CONFLICT (athlete_id) DO UPDATE SET searched_at = NOW(), found = EXCLUDED.found, fault = NULL`, [rec.id, res.mentions.length]);
  return res;
}
async function newsFor(pool, athleteId) {
  await ensureTables(pool);
  const s = (await pool.query(`SELECT searched_at, found, fault FROM athlete_news_searches WHERE athlete_id = $1`, [athleteId])).rows[0];
  if (!s) return null;
  const m = (await pool.query(`SELECT url, title, outlet, kind, published_on::text AS published_on FROM athlete_news_mentions
                                 WHERE athlete_id = $1 ORDER BY published_on DESC NULLS LAST`, [athleteId])).rows;
  return { searchedAt: s.searched_at, fault: s.fault || null, mentions: m };
}

// ── ONE ATHLETE ─────────────────────────────────────────────────────────────
// row: { id, agent_id, data, instagram_followers, tiktok_followers,
// twitter_followers, athlete_type }. opts.search: run the news search when the
// last one is older than a week. opts.save: store the result.
async function computeFor(pool, row, opts = {}) {
  await ensureTables(pool);
  const AR = require('./athleteRecord');
  const resolveSchool = opts.schoolLocation || ((s) => { try { const r = require('./schoolResolver').resolveSchool(s); return r && r.city ? r : null; } catch (_) { return null; } });
  const rec = AR.resolveAthlete(row, { schoolLocation: resolveSchool });
  rec.id = rec.id || row.id;
  const now = opts.now || new Date();
  let ig = null;
  try { ig = opts.ig !== undefined ? opts.ig : await require('./instagramConnect').latestFor(pool, row.id); } catch (_) { ig = null; }
  let news = await newsFor(pool, row.id);
  const stale = !news || (now.getTime() - new Date(news.searchedAt).getTime() > NEWS_STALE_DAYS * 86400000);
  let searched = false;
  if (opts.search && stale && rec.name) {
    await searchNews(pool, rec, { webSearch: opts.webSearch, now });
    news = await newsFor(pool, row.id);
    searched = true;
  }
  let cityPop = null;
  if (rec.schoolCity) {
    try { cityPop = await cityPopulation(pool, rec.schoolCity, rec.schoolState, { fetchImpl: opts.fetchImpl, noFetch: !!opts.noFetch }); } catch (_) { cityPop = null; }
  }
  let poolDepth = null;
  if (!(cityPop && cityPop.pop) && rec.marketKey) {
    try { poolDepth = (await require('./marketPools').usableCounts(pool, [rec.marketKey])).get(rec.marketKey) || null; } catch (_) { poolDepth = null; }
  }
  const out = score({ rec, raw: row.data || {}, cols: row, ig, news, cityPop: cityPop && cityPop.pop ? cityPop : null, pool: poolDepth, now });
  out.athleteId = row.id;
  out.agentId = row.agent_id || null;
  out.name = rec.name;
  out.newsSearched = searched;
  if (opts.save !== false) {
    await pool.query(`INSERT INTO athlete_market_scores (athlete_id, agent_id, computed_at, score, tier, confidence, components, reasons, missing)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [row.id, row.agent_id || null, now, out.score, out.tier, out.confidence, JSON.stringify(out.components), JSON.stringify(out.reasons), JSON.stringify(out.missing)]);
  }
  return out;
}

const ROW_SQL = `SELECT id, agent_id, data, instagram_followers, tiktok_followers, twitter_followers, athlete_type FROM athletes`;

// The score the nightly fill uses: the stored one when it is under a week
// old, else computed now (no news search: that is the weekly job's) and stored.
async function forAthlete(pool, athleteId, opts = {}) {
  const last = await latestFor(pool, athleteId);
  const now = opts.now || new Date();
  if (last && now.getTime() - new Date(last.computedAt).getTime() < STALE_DAYS * 86400000) return last;
  const row = (await pool.query(ROW_SQL + ' WHERE id = $1', [athleteId])).rows[0];
  if (!row) return last;
  const out = await computeFor(pool, row, { ...opts, search: false, save: opts.save !== false });
  return { athleteId, score: out.score, tier: out.tier, tierLabel: out.tierLabel, confidence: out.confidence,
    components: out.components, reasons: out.reasons, missing: out.missing, computedAt: now };
}

// ── THE WEEK ────────────────────────────────────────────────────────────────
// Every athlete whose score is older than STALE_DAYS (or who has none), with
// the news search, up to NEWS_MAX searches per pass. Never throws.
const NEWS_MAX = () => parseInt(process.env.MARKET_NEWS_MAX_PER_PASS, 10) || 200;
async function recomputeIfStale(pool, opts = {}) {
  await ensureTables(pool);
  const rows = (await pool.query(`${ROW_SQL} a
      WHERE NOT EXISTS (SELECT 1 FROM athlete_market_scores s WHERE s.athlete_id = a.id AND s.computed_at > NOW() - ($1 || ' days')::interval)
      ORDER BY a.created_at ASC`, [String(STALE_DAYS)])).rows;
  let done = 0, searches = 0, failed = 0;
  for (const row of rows) {
    if (opts.limit && done >= opts.limit) break;
    try {
      const out = await computeFor(pool, row, { ...opts, search: searches < (opts.newsMax || NEWS_MAX()) });
      if (out.newsSearched) searches++;
      done++;
    } catch (e) { failed++; console.error(`[marketScore] athlete=${row.id}: ${e.message}`); }
  }
  if (done || failed) console.log(`[marketScore] recomputed ${done} athlete(s), ${searches} news search(es), ${failed} failed`);
  return { done, searches, failed, due: rows.length };
}

// ── PRINTED ─────────────────────────────────────────────────────────────────
function format(s, { name } = {}) {
  const L = [];
  const pct = Math.round((Number(s.confidence) || 0) * 100);
  L.push(`${name || s.name || s.athleteId}: ${s.score}/100, ${s.tierLabel || TIER_LABEL[s.tier]} (confidence ${pct}%)`);
  const c = s.components || {};
  const line = (k, label) => c[k] ? `  ${label.padEnd(16)} ${String(c[k].points).padStart(5)} / ${c[k].max}   confidence ${Math.round((c[k].confidence || 0) * 100)}%` : null;
  for (const [k, label] of [['levelSport', 'Level and sport'], ['social', 'Social reach'], ['performance', 'Performance'], ['media', 'Media'], ['market', 'Market']]) {
    const l = line(k, label);
    if (l) L.push(l);
  }
  L.push('  What drove it:');
  for (const r of (s.reasons || [])) L.push('    ' + r);
  if ((s.missing || []).length) L.push(`  Missing (scored 0, lowers confidence): ${[...new Set(s.missing)].join(', ')}`);
  return L.join('\n');
}

module.exports = {
  ON, TIERS, TIER_LABEL, tierFor, score, levelOf, sportOf, socialOf, performanceOf, mediaOf, marketOf,
  reachPoints, engagementPoints, marketPoints, schoolKey, conferenceMatch, placeKeys, parseNews, newsPrompt,
  ensureTables, latestFor, computeFor, forAthlete, recomputeIfStale, cityPopulation, loadState, searchNews, newsFor, format,
  STALE_DAYS, NEWS_DAYS, P4, G5, HOOPS_MAJOR, LEVEL, STATE_FIPS,
};
