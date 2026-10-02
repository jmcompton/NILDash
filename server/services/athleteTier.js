'use strict';
// ── THE JUDGE'S FIRST QUESTION: WHAT LEVEL IS THIS ATHLETE? ─────────────────
//
// A JUCO athlete with 800 followers does not get pitched to a national CPG.
// An NFL player does. The tier decides which lanes this athlete may draw from:
//
//   low   small school or small following       local businesses only
//   mid   in between                             local + social/DTC brands
//                                                (matched to their reach)
//   high  pro, or a large following             local + social + national
//
// THERE IS NO STORED TIER FIELD. The athlete record has no tier column; the
// tier is derived, every time, from what the record does hold, so it moves
// when the numbers do:
//   level       pro (athlete_type); otherwise the athlete's CONFIRMED level:
//                 1. the athlete's own `division` field, when set (D1, D2,
//                    D3, NAIA, JUCO) -- how an agent confirms a level
//                 2. a two-year college (data/twoYearColleges: CCCAA and
//                    NJCAA members, e.g. "Cypress College"), or a name that
//                    says so (community / junior / city college)
//                 3. NCAA D2, D3 or NAIA (services/schoolsDivisions)
//                 4. Division I: the shipped D1 school map (ai.js) and the
//                    FBS list (data/fbsSchools)
//               A school on none of these is UNCONFIRMED and is treated as
//               low tier until it is: a junior college whose name does not
//               say so must never be read as Division I and sent a national
//               brand.
//   reach       Instagram + TikTok followers
//   engagement  the connected Instagram's rate, when there is one; a strong
//               rate lifts a small following one band, never two
// Unknown reach is not zero: it is judged on level alone. A following of
// HIGH_REACH (100,000) is high tier at a confirmed four-year school: that is
// the audience a national brand buys. A junior college tops out at mid, and
// an unconfirmed school is low until it is confirmed.
function fold(s) { return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim(); }
const setOf = (names) => new Set(names.map(fold));
const SMALL = (() => { try { return setOf(Object.keys(require('./schoolsDivisions').SCHOOLS)); } catch (_) { return new Set(); } })();
const TWO_YEAR = (() => { try { return setOf(require('../data/twoYearColleges').TWO_YEAR); } catch (_) { return new Set(); } })();
// Division I is matched with "University", "of" and "the" dropped, so
// "Louisville" and "University of Louisville" are one school.
const d1Key = (n) => fold(n).split(' ').filter((w) => !['university', 'of', 'the'].includes(w)).join(' ');
const D1 = (() => {
  const names = [];
  try { names.push(...(require('./schoolResolver').SHIPPED_NAMES || [])); } catch (_) { /* the FBS list stands alone */ }
  try { names.push(...Object.keys(require('../data/fbsSchools').FBS_SCHOOLS)); } catch (_) { /* the shipped map stands alone */ }
  return new Set(names.map(d1Key));
})();
const JUCO = /\b(community|junior|city) college\b|\bjc\b|\bjuco\b/i;
const DIVISION = { d1: 'd1', 'division i': 'd1', 'ncaa d1': 'd1', fbs: 'd1', fcs: 'd1', d2: 'small', 'division ii': 'small', d3: 'small',
  'division iii': 'small', naia: 'small', juco: 'juco', njcaa: 'juco', cccaa: 'juco', 'junior college': 'juco', jc: 'juco' };

const HIGH_REACH = parseInt(process.env.TIER_HIGH_REACH, 10) || 100000;   // anyone at this reach
const HIGH_REACH_D1 = parseInt(process.env.TIER_HIGH_REACH_D1, 10) || 50000;
const LOW_REACH = parseInt(process.env.TIER_LOW_REACH, 10) || 5000;       // below this: local only
const LOW_REACH_SMALL = parseInt(process.env.TIER_LOW_REACH_SMALL, 10) || 20000;
const STRONG_ENGAGEMENT = 6;   // percent

// -> 'pro' | 'd1' | 'small' | 'juco' | 'unconfirmed'
function levelOf(a) {
  if (!a) return 'unconfirmed';
  if (a.athleteType === 'pro') return 'pro';
  const set = DIVISION[String(a.division || '').trim().toLowerCase()];
  if (set) return set;
  const raw = String(a.school || '').trim();
  if (!raw) return 'unconfirmed';
  const names = [fold(raw)];
  try {
    const r = require('./schoolResolver').resolveSchool(raw);
    if (r && r.matched) names.push(fold(r.matched));
  } catch (_) { /* the raw name is still checked */ }
  if (JUCO.test(raw) || names.some((n) => TWO_YEAR.has(n))) return 'juco';
  if (names.some((n) => SMALL.has(n))) return 'small';
  if ([raw].concat(names).some((n) => D1.has(d1Key(n)))) return 'd1';
  return 'unconfirmed';
}

const LEVEL_WORDS = { juco: 'a junior college', small: 'a small school', unconfirmed: 'a school whose level is not confirmed' };

// a: the athlete record (services/athleteRecord). -> { tier, why, level, reach, lanes, socialSeats }
function tierOf(a) {
  const level = levelOf(a);
  const reach = ((Number(a && a.instagram) || 0) + (Number(a && a.tiktok) || 0)) || null;
  const eng = Number(a && a.engagement);
  const strong = Number.isFinite(eng) && eng >= STRONG_ENGAGEMENT;
  const fmt = (n) => n.toLocaleString('en-US');
  let tier, why;
  if (level === 'pro') { tier = 'high'; why = 'a professional athlete'; }
  // UNCONFIRMED IS LOW, WHATEVER THE FOLLOWING, until an agent sets the
  // division or a list confirms the school.
  else if (level === 'unconfirmed') { tier = 'low'; why = `${LEVEL_WORDS.unconfirmed}${reach !== null ? `, ${fmt(reach)} followers` : ''}; low until the level is confirmed`; }
  // A JUNIOR COLLEGE NEVER REACHES NATIONAL: its ceiling is mid.
  else if (level === 'juco' && reach !== null && reach >= LOW_REACH_SMALL) { tier = 'mid'; why = `${fmt(reach)} followers at a junior college (a junior college is never national)`; }
  else if (reach !== null && reach >= HIGH_REACH) { tier = 'high'; why = `${fmt(reach)} followers`; }
  else if (level === 'd1' && reach !== null && reach >= HIGH_REACH_D1) { tier = 'high'; why = `Division I with ${fmt(reach)} followers`; }
  else if (reach === null) { tier = level === 'd1' ? 'mid' : 'low'; why = `${level === 'd1' ? 'a Division I' : LEVEL_WORDS[level]} athlete, following not known`; }
  else if (reach < LOW_REACH || (level !== 'd1' && reach < LOW_REACH_SMALL)) { tier = 'low'; why = `${fmt(reach)} followers${level !== 'd1' ? ` at ${LEVEL_WORDS[level]}` : ''}`; }
  else { tier = 'mid'; why = `${fmt(reach)} followers${level !== 'd1' ? ` at ${LEVEL_WORDS[level]}` : ''}`; }
  if (tier === 'low' && level !== 'unconfirmed' && strong && reach !== null && reach >= 1000) { tier = 'mid'; why += `, lifted by ${eng}% engagement`; }
  const out = { tier, why, level, reach, engagement: Number.isFinite(eng) ? eng : null, ...lanesFor(tier) };
  // NOT BLANKED. An athlete with no local market at all (no school on file, or
  // one we cannot place) would get nothing from "local only" -- zero cards
  // every night. The social lane opens for them; the national lane never does
  // for an unconfirmed level.
  if (tier === 'low' && a && a.hasLocalMarket === false && a.athleteType !== 'pro') {
    out.lanes = { local: true, social: true, national: false };
    out.socialSeats = 2;
    out.why += '; no local market, so the social lane is open (never national)';
  }
  return out;
}

function lanesFor(tier) {
  if (tier === 'low') return { lanes: { local: true, social: false, national: false }, socialSeats: 0 };
  if (tier === 'mid') return { lanes: { local: true, social: true, national: false }, socialSeats: 2 };
  return { lanes: { local: true, social: true, national: true }, socialSeats: 2 };
}

// The ladder for a tier. Social goes straight after the athlete's own pool for
// mid and high: an empty market goes to the social lane before paying Google.
// tier: the tier name, or tierOf()'s result (whose lanes decide when a low
// tier has had the social lane opened for having no market).
function ladderFor(tier) {
  if (tier && typeof tier === 'object') {
    const l = tier.lanes || {};
    return ['local'].concat(l.social ? ['social'] : [], l.national ? ['national'] : [], ['local-wide', 'places-refresh', 'hometown']);
  }
  if (tier === 'low') return ['local', 'local-wide', 'places-refresh', 'hometown'];
  if (tier === 'mid') return ['local', 'social', 'local-wide', 'places-refresh', 'hometown'];
  return ['local', 'social', 'national', 'local-wide', 'places-refresh', 'hometown'];
}

module.exports = { tierOf, levelOf, lanesFor, ladderFor, HIGH_REACH, HIGH_REACH_D1, LOW_REACH, LOW_REACH_SMALL };
