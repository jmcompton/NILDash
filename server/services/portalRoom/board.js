'use strict';
// ── THE SCHOOL NEED BOARD ───────────────────────────────────────────────────
//
// Where could he play, and where does he want to go. For one player at one
// position, every FBS school gets:
//
//   NEED     his position room at that school: how many are on the roster, how
//            many are seniors or older (likely gone after the season), how many
//            come back, against the FBS median of players coming back in that
//            room. High: a quarter or more below the median. Medium: below it.
//            Low: at or above it. A new head coach is shown and adds to it.
//   LEVEL    Power 4 or Group of 5, against where he plays now or the level
//            the agent asked for.
//   MONEY    Power 4 pays more (services/portalRoom/value has the College
//            Sports Commission numbers by position). Level only, not a school's
//            own budget.
//   WANTS    the agent's wish list: named schools, states or regions, close to
//            home.
//
// Score = 40% need + 20% level + 15% money + 25% wants. His named schools are
// listed first, always, in score order; then the best of the rest, each with
// the reasons it is there. A school whose roster is not read yet says so and
// is scored as unknown need, never guessed.

const P = require('./positions');
const Schools = require('./schools');
const Coaching = require('./coachingChanges');

const W = { need: 0.40, level: 0.20, money: 0.15, wants: 0.25 };

// If too few rosters are read for a median to mean anything, these stand in
// (typical FBS returning counts by room) and the board says so.
const FALLBACK_MEDIAN = { QB: 3, RB: 4, WR: 8, TE: 4, OL: 12, DL: 12, LB: 7, DB: 12, K: 1, P: 1, LS: 1 };
const MIN_FOR_MEDIAN = 20;

// One school's rooms: { WR: { on, leaving, back, leavingNames:[...] }, ... }
function rooms(players) {
  const out = {};
  for (const g of P.GROUPS) out[g] = { on: 0, leaving: 0, back: 0, leavingPlayers: [] };
  for (const p of players || []) {
    const g = p.group || P.groupOf(p.pos);
    if (!g || !out[g]) continue;
    const leaving = p.leaving != null ? p.leaving : P.isLeaving(p.year);
    out[g].on++;
    if (leaving) { out[g].leaving++; out[g].leavingPlayers.push({ name: p.name, year: p.year || null, pos: p.pos || null }); }
    else out[g].back++;
  }
  return out;
}

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Medians of players coming back, by room, across every roster read.
function medians(roomsBySchool) {
  const list = Object.values(roomsBySchool);
  const out = {};
  const usedFallback = list.length < MIN_FOR_MEDIAN;
  for (const g of P.GROUPS) out[g] = usedFallback ? FALLBACK_MEDIAN[g] : median(list.map((r) => r[g].back));
  return { by: out, schools: list.length, fallback: usedFallback };
}

function needFor(room, med, coaching) {
  if (!room) return { rating: 'unknown', score: 0.4 };
  const m = Math.max(med || 0, 1);
  const ratio = room.back / m;
  let rating = ratio <= 0.75 ? 'high' : ratio < 1 ? 'medium' : 'low';
  let score = Math.max(0, Math.min(1, (m - room.back) / m + 0.5));
  if (coaching) {
    score = Math.min(1, score + 0.1);
    if (rating === 'low') rating = 'medium';
  }
  return { rating, score: Math.round(score * 100) / 100, on: room.on, leaving: room.leaving, back: room.back, median: med, leavingPlayers: room.leavingPlayers };
}

const LEVEL_ORDER = { JUCO: 0, D2: 1, FCS: 2, G5: 3, P4: 4 };
function levelFit(schoolLevel, { current, want } = {}) {
  if (want && want !== 'any') return want === schoolLevel ? 1 : 0.2;
  const c = LEVEL_ORDER[current];
  if (c == null) return 0.6;
  const diff = LEVEL_ORDER[schoolLevel] - c;
  if (diff === 0 || diff === 1) return 1;
  if (diff === 2) return 0.6;
  if (diff > 2) return 0.35;
  return 0.7;   // a step down: more playing time, less money
}

function wantsFor(s, prefs) {
  const reasons = [];
  let score = 0;
  const named = (prefs.schools || []).includes(s.name);
  if (named) { score = 1; reasons.push('On his list'); }
  else {
    const states = (prefs.states || []).map((x) => String(x).toUpperCase());
    const regions = prefs.regions || [];
    if (s.state && states.includes(s.state)) { score = Math.max(score, 0.7); reasons.push(`In ${s.state}, a state on his list`); }
    if (s.region && regions.includes(s.region)) { score = Math.max(score, 0.6); reasons.push(`In the ${s.region}, a region on his list`); }
    if (prefs.closeToHome && prefs.homeState && s.state) {
      if (s.state === String(prefs.homeState).toUpperCase()) { score = Math.max(score, 0.8); reasons.push('In his home state'); }
      else if (s.region && s.region === Schools.regionOf(String(prefs.homeState).toUpperCase())) { score = Math.max(score, 0.45); reasons.push('Same region as home'); }
    }
  }
  return { score, named, reasons };
}

function needLine(group, n) {
  if (n.rating === 'unknown') return 'Roster not read yet, so need is unknown.';
  const room = P.LABEL[group].toLowerCase();
  return `${n.on} ${room} on the roster, ${n.leaving} seniors or older likely leaving, ${n.back} coming back (FBS median ${n.median}).`;
}

// The whole board. rosters: [{ school, players, fetched_at, status }]
// keepAll: score every school even when a level is asked for (the workspace
// scores his own list with the same weights the board uses, so a school shows
// one fit score everywhere).
function rank({ group, prefs = {}, rosters = [], coaching = new Map(), limit = 25, keepAll = false }) {
  if (!P.GROUPS.includes(group)) { const e = new Error('unknown position group'); e.status = 400; throw e; }
  const byRooms = {};
  const fetched = {};
  for (const r of rosters) if (r.status === 'ok') { byRooms[r.school] = rooms(r.players); fetched[r.school] = r.fetched_at || null; }
  const med = medians(byRooms);
  const exclude = new Set([prefs.currentSchool].filter(Boolean));
  const rows = [];
  for (const s of Schools.all()) {
    if (exclude.has(s.name)) continue;
    if (!keepAll && prefs.level && prefs.level !== 'any' && s.level !== prefs.level && !(prefs.schools || []).includes(s.name)) continue;
    const ch = coaching.get(s.name) || null;
    const n = needFor(byRooms[s.name] ? byRooms[s.name][group] : null, med.by[group], ch);
    const lv = levelFit(s.level, { current: prefs.currentLevel, want: prefs.level });
    const money = s.level === 'P4' ? 1 : 0.45;
    const w = wantsFor(s, prefs);
    const total = W.need * n.score + W.level * lv + W.money * money + W.wants * w.score;
    const reasons = [];
    if (n.rating === 'high') reasons.push(`Thin at ${group}: ${n.back} coming back against a median of ${n.median}`);
    else if (n.rating === 'medium') reasons.push(`Below average at ${group}: ${n.back} back, median ${n.median}`);
    if (ch) reasons.push(Coaching.describe(ch));
    reasons.push(...w.reasons);
    if (s.level === 'P4') reasons.push(`Power 4 (${s.conference})`);
    rows.push({
      school: s.name, level: s.level, conference: s.conference, state: s.state, region: s.region,
      score: Math.round(total * 100), named: w.named,
      need: { rating: n.rating, on: n.on, leaving: n.leaving, back: n.back, median: n.median, line: needLine(group, n) },
      coachingChange: ch ? { coach: ch.coach, how: ch.how, date: ch.date, interim: ch.interim || null, newCoach: ch.newCoach || null, source: ch.source || null } : null,
      reasons, rosterReadAt: fetched[s.name] || null,
    });
  }
  rows.sort((a, b) => b.score - a.score || a.school.localeCompare(b.school));
  const named = rows.filter((r) => r.named);
  const rest = rows.filter((r) => !r.named).slice(0, Math.max(0, limit));
  return {
    group, groupLabel: P.LABEL[group],
    median: med.by[group], medianFrom: med.fallback ? 'typical FBS depth (too few rosters read yet)' : `${med.schools} FBS rosters`,
    rostersRead: Object.keys(byRooms).length, totalSchools: Schools.all().length,
    dream: named, options: rest,
  };
}

// One school's room in detail, for the school drawer.
function schoolRoom({ school, group, roster, rostersAll = [], coaching = null }) {
  const byRooms = {};
  for (const r of rostersAll) if (r.status === 'ok') byRooms[r.school] = rooms(r.players);
  const med = medians(byRooms);
  if (!roster || roster.status !== 'ok') return { school, group, read: false, coachingChange: coaching || null, median: med.by[group] };
  const rm = rooms(roster.players)[group];
  const n = needFor(rm, med.by[group], coaching);
  return {
    school, group, groupLabel: P.LABEL[group], read: true, rosterUrl: roster.roster_url || null, readAt: roster.fetched_at || null,
    need: { rating: n.rating, on: n.on, leaving: n.leaving, back: n.back, median: n.median, line: needLine(group, n) },
    leavingPlayers: rm.leavingPlayers,
    coachingChange: coaching || null,
  };
}

module.exports = { rank, schoolRoom, rooms, medians, needFor, levelFit, wantsFor, W, FALLBACK_MEDIAN, MIN_FOR_MEDIAN };
