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
//   level       pro (athlete_type), a small-school college (NCAA D2/D3,
//               NAIA: services/schoolsDivisions; a community or junior
//               college by name), else Division I. A two-year college whose
//               name does not say so ("Cypress College") reads as Division I
//               here: its reach decides, which for most is the low band.
//   reach       Instagram + TikTok followers
//   engagement  the connected Instagram's rate, when there is one; a strong
//               rate lifts a small following one band, never two
// Unknown reach is not zero: it is judged on level alone.
const SMALL = (() => {
  try {
    const SD = require('./schoolsDivisions');
    return new Set(Object.keys(SD.SCHOOLS).map(fold));
  } catch (_) { return new Set(); }
})();
function fold(s) { return String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim(); }
const JUCO = /\b(community|junior|city) college\b|\bjc\b|\bjuco\b|\bcc\b$/i;

const HIGH_REACH = parseInt(process.env.TIER_HIGH_REACH, 10) || 100000;   // anyone at this reach
const HIGH_REACH_D1 = parseInt(process.env.TIER_HIGH_REACH_D1, 10) || 50000;
const LOW_REACH = parseInt(process.env.TIER_LOW_REACH, 10) || 5000;       // below this: local only
const LOW_REACH_SMALL = parseInt(process.env.TIER_LOW_REACH_SMALL, 10) || 20000;
const STRONG_ENGAGEMENT = 6;   // percent

function levelOf(a) {
  if (!a) return 'college';
  if (a.athleteType === 'pro') return 'pro';
  const s = fold(a.school);
  if (!s) return 'college';
  if (JUCO.test(String(a.school || ''))) return 'juco';
  if (SMALL.has(s)) return 'small';
  return 'd1';
}

// a: the athlete record (services/athleteRecord). -> { tier, why, level, reach, lanes, socialSeats }
function tierOf(a) {
  const level = levelOf(a);
  const reach = ((Number(a && a.instagram) || 0) + (Number(a && a.tiktok) || 0)) || null;
  const eng = Number(a && a.engagement);
  const strong = Number.isFinite(eng) && eng >= STRONG_ENGAGEMENT;
  const smallSchool = level === 'small' || level === 'juco';
  let tier, why;
  if (level === 'pro') { tier = 'high'; why = 'a professional athlete'; }
  else if (reach !== null && reach >= HIGH_REACH) { tier = 'high'; why = `${reach.toLocaleString('en-US')} followers`; }
  else if (level === 'd1' && reach !== null && reach >= HIGH_REACH_D1) { tier = 'high'; why = `Division I with ${reach.toLocaleString('en-US')} followers`; }
  else if (reach === null) { tier = smallSchool ? 'low' : 'mid'; why = `${smallSchool ? 'a small-school' : 'a Division I'} athlete, following not known`; }
  else if (reach < LOW_REACH || (smallSchool && reach < LOW_REACH_SMALL)) { tier = 'low'; why = `${reach.toLocaleString('en-US')} followers${smallSchool ? ` at a ${level === 'juco' ? 'junior' : 'small'} college` : ''}`; }
  else { tier = 'mid'; why = `${reach.toLocaleString('en-US')} followers`; }
  if (tier === 'low' && strong && reach !== null && reach >= 1000) { tier = 'mid'; why += `, lifted by ${eng}% engagement`; }
  return { tier, why, level, reach, engagement: Number.isFinite(eng) ? eng : null, ...lanesFor(tier) };
}

// What each tier may draw from, and how many of the five seats the social
// lane is held to when it has candidates: HALF THE SUPPLY, not a fallback.
function lanesFor(tier) {
  if (tier === 'low') return { lanes: { local: true, social: false, national: false }, socialSeats: 0 };
  if (tier === 'mid') return { lanes: { local: true, social: true, national: false }, socialSeats: 2 };
  return { lanes: { local: true, social: true, national: true }, socialSeats: 2 };
}

// The ladder for a tier. Social goes straight after the athlete's own pool for
// mid and high: an empty market goes to the social lane before paying Google.
function ladderFor(tier) {
  if (tier === 'low') return ['local', 'local-wide', 'places-refresh', 'hometown'];
  if (tier === 'mid') return ['local', 'social', 'local-wide', 'places-refresh', 'hometown'];
  return ['local', 'social', 'national', 'local-wide', 'places-refresh', 'hometown'];
}

module.exports = { tierOf, levelOf, lanesFor, ladderFor, HIGH_REACH, HIGH_REACH_D1, LOW_REACH, LOW_REACH_SMALL };
