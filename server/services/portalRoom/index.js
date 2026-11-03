'use strict';
// ── THE PORTAL ROOM ─────────────────────────────────────────────────────────
//
// An agent's client is thinking about the transfer portal. The three questions
// in order:
//   1. Should he enter at all?   enterCheck: years left, whether this transfer
//                                costs him a year under the Protect College
//                                Sports Act, the window dates, and how many FBS
//                                schools are thin at his position.
//   2. Which schools need him?   board: every FBS school ranked on need at his
//                                position, level, money and his wish list.
//   3. Who do I call there?      school: his room at that school (who is
//                                leaving, by name) and the contact book.
//
// Shared data (program_roster, program_staff) is read-only here. The one thing
// an agent writes is a wish list for his own athlete (portal_wishlists).

const P = require('./positions');
const Schools = require('./schools');
const Board = require('./board');
const Coaching = require('./coachingChanges');
const Contacts = require('./contacts');
const Sweep = require('./rosterSweep');

const CACHE_MS = 5 * 60 * 1000;
const MAX_ROSTER_DAYS = 150;
let cache = { at: 0, rows: null };

async function rosters(pool, { fresh = false } = {}) {
  if (!fresh && cache.rows && Date.now() - cache.at < CACHE_MS) return cache.rows;
  await Sweep.ensureTables(pool);
  // A roster read more than MAX_ROSTER_DAYS ago describes a team that has
  // since graduated a class: it is left out (need shows as not read) rather
  // than counted.
  const r = await pool.query(`SELECT school, status, players, roster_url, fetched_at FROM program_roster
    WHERE sport = 'football' AND status = 'ok' AND fetched_at > NOW() - INTERVAL '${MAX_ROSTER_DAYS} days'`);
  cache = { at: Date.now(), rows: r.rows };
  return r.rows;
}
function clearCache() { cache = { at: 0, rows: null }; }

const LEVELS = ['P4', 'G5', 'FCS', 'D2', 'JUCO'];
const up2 = (s) => String(s || '').trim().toUpperCase();

// Everything an agent can send, cleaned. Unknown schools are dropped (and
// returned so the page can say so), never guessed.
function cleanPrefs(b = {}) {
  const unknown = [];
  const schools = [];
  for (const raw of (Array.isArray(b.schools) ? b.schools : []).slice(0, 15)) {
    const c = Schools.canonical(raw);
    if (c) { if (!schools.includes(c)) schools.push(c); } else if (String(raw || '').trim()) unknown.push(String(raw).slice(0, 60));
  }
  const states = [...new Set((Array.isArray(b.states) ? b.states : []).map(up2).filter((s) => /^[A-Z]{2}$/.test(s)))].slice(0, 12);
  const regions = [...new Set((Array.isArray(b.regions) ? b.regions : []).filter((r) => Schools.REGIONS[r]))];
  const level = ['P4', 'G5'].includes(up2(b.level)) ? up2(b.level) : 'any';
  const currentLevel = LEVELS.includes(up2(b.currentLevel)) ? up2(b.currentLevel) : null;
  const homeState = /^[A-Z]{2}$/.test(up2(b.homeState)) ? up2(b.homeState) : null;
  const currentSchool = Schools.canonical(b.currentSchool) || null;
  const position = String(b.position || '').trim().slice(0, 30);
  const group = P.GROUPS.includes(up2(b.group)) ? up2(b.group) : P.groupOf(position);
  return { prefs: { schools, states, regions, level, currentLevel, homeState, closeToHome: !!b.closeToHome, currentSchool, position, group }, unknown };
}

async function board(pool, body = {}, { now = new Date() } = {}) {
  const { prefs, unknown } = cleanPrefs(body);
  if (!prefs.group) { const e = new Error('Pick his position (QB, RB, WR, TE, OL, DL, LB, DB, K, P or LS).'); e.status = 400; throw e; }
  const [rows, coaching] = await Promise.all([rosters(pool), Coaching.load(pool, { now })]);
  const limit = Math.max(5, Math.min(60, parseInt(body.limit, 10) || 25));
  const out = Board.rank({ group: prefs.group, prefs, rosters: rows, coaching, limit });
  return { ...out, prefs, unknownSchools: unknown };
}

async function school(pool, store, name, groupRaw, { now = new Date() } = {}) {
  const sch = Schools.canonical(name);
  if (!sch) { const e = new Error('unknown FBS school'); e.status = 404; throw e; }
  const group = P.GROUPS.includes(up2(groupRaw)) ? up2(groupRaw) : P.groupOf(groupRaw);
  if (!group) { const e = new Error('position required'); e.status = 400; throw e; }
  const [rows, coaching] = await Promise.all([rosters(pool), Coaching.load(pool, { now })]);
  const roster = rows.find((r) => r.school === sch) || null;
  const room = Board.schoolRoom({ school: sch, group, roster, rostersAll: rows, coaching: coaching.get(sch) || null });
  const book = await Contacts.forSchool(store, sch, group);
  return { ...Schools.info(sch), group, groupLabel: P.LABEL[group], room, contacts: book };
}

// THE WINDOWS, 2026-27 football. Kept here so the page and the morning report
// say the same thing.
const WINDOWS = {
  football: {
    main: { opens: '2027-01-02', closes: '2027-01-16', text: 'The football portal window is Jan 2 to 16, 2027.' },
    postseason: 'A player whose team is still playing gets 5 days after his last game.',
    coachingChange: 'When a school names a new head coach, its players get a 30-day window.',
  },
};

async function enterCheck(pool, body = {}, { now = new Date() } = {}) {
  const pcsa = require('../pcsa');
  const { prefs } = cleanPrefs(body);
  const prior = Math.max(0, Math.min(5, parseInt(body.priorTransfers, 10) || 0));
  const coaching = await Coaching.load(pool, { now });
  const atCurrent = prefs.currentSchool ? coaching.get(prefs.currentSchool) || null : null;
  const EXC = ['head_coach_departed', 'sport_discontinued', 'sexual_assault_or_harassment', 'graduate_study'];
  let exception = EXC.includes(body.exception) ? body.exception : null;
  if (!exception && atCurrent) exception = 'head_coach_departed';
  // The clock alone, then this transfer on top: pcsa.eligibility looks at a
  // second transfer, but for a player on his third the question is the same,
  // does THIS one cost a year. It does when he has transferred before and no
  // exception applies.
  const elig = pcsa.eligibility({ birthDate: body.birthDate || null, firstEnrollment: body.firstEnrollment || null, transfers: [], now });
  const costsYear = prior >= 1 && !exception;
  // yearsLeft counts the academic year he is in now. He plays for the new
  // school starting next season, so that year is spent either way.
  const seasonsBefore = elig.yearsLeft == null ? null : Math.max(0, elig.yearsLeft - 1);
  const seasonsAfter = seasonsBefore == null ? null : Math.max(0, seasonsBefore - (costsYear ? 1 : 0));

  let demand = null;
  if (prefs.group) {
    const rows = await rosters(pool);
    const b = Board.rank({ group: prefs.group, prefs: { ...prefs, schools: [], level: 'any' }, rosters: rows, coaching, limit: 500 });
    const all = [...b.dream, ...b.options];
    demand = {
      group: prefs.group, groupLabel: P.LABEL[prefs.group],
      high: all.filter((r) => r.need.rating === 'high').length,
      medium: all.filter((r) => r.need.rating === 'medium').length,
      highP4: all.filter((r) => r.need.rating === 'high' && r.level === 'P4').length,
      read: b.rostersRead, total: b.totalSchools,
    };
  }

  const points = [];
  if (seasonsAfter != null) points.push({ level: seasonsAfter > 0 ? 'ok' : 'flag', text: seasonsAfter > 0 ? `${seasonsAfter} season${seasonsAfter === 1 ? '' : 's'} left to play at a new school (his 5-year clock runs through ${elig.lastYear}${costsYear ? ', less the year this transfer costs' : ''}).` : 'No seasons left to play after this one on the 5-year clock.' });
  else points.push({ level: 'unknown', text: 'Add his birth date or first enrollment to count his years left.' });
  if (prior === 0) points.push({ level: 'ok', text: 'First transfer: it costs him nothing.' });
  else if (costsYear) points.push({ level: 'flag', text: 'This would be another transfer with no exception: under the Protect College Sports Act it costs him a year.' });
  else points.push({ level: 'ok', text: exception === 'head_coach_departed' ? 'His head coach left, so another transfer does not cost him a year.' : 'An exception applies, so another transfer does not cost him a year.' });
  if (atCurrent) points.push({ level: 'ok', text: Coaching.describe(atCurrent) + ' ' + WINDOWS.football.coachingChange });
  // Demand only once enough rosters are read for the median to mean something.
  if (demand && demand.read < Board.MIN_FOR_MEDIAN) demand = { ...demand, tooFew: true };
  if (demand && !demand.tooFew) points.push({ level: demand.high >= 10 ? 'ok' : demand.high >= 4 ? 'warn' : 'flag', text: `${demand.high} FBS schools are thin at ${prefs.group} (${demand.highP4} of them Power 4), from ${demand.read} rosters read.` });

  let verdict;
  const known = demand && !demand.tooFew;
  if (seasonsBefore === 0) verdict = { level: 'flag', text: 'No seasons left after this one. Entering only makes sense for a graduate or NFL path.' };
  else if (costsYear && seasonsAfter === 0) verdict = { level: 'flag', text: 'This transfer would cost his last season: he could not play at a new school unless an exception applies.' };
  else if (costsYear) verdict = { level: 'warn', text: 'Think hard before entering: this transfer costs him a year unless an exception applies.' };
  else if (known && demand.high < 4) verdict = { level: 'warn', text: `Few schools need a ${prefs.group} right now. Line up interest before he enters.` };
  else verdict = { level: 'ok', text: known ? `The market is open: ${demand.high} schools are thin at ${prefs.group}. Build the target list below.` : 'Nothing here stops him. Build the target list below.' };

  return { verdict, points, eligibility: elig, seasonsAfter, costsYear, windows: WINDOWS.football, coachingAtCurrent: atCurrent, demand, exception, status: pcsa.rules().status };
}

async function ensureWishlists(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS portal_wishlists (
    agent_id TEXT NOT NULL, athlete_id TEXT NOT NULL, prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (agent_id, athlete_id))`);
}
async function getWishlist(pool, agentId, athleteId) {
  await ensureWishlists(pool);
  const r = await pool.query(`SELECT prefs, updated_at FROM portal_wishlists WHERE agent_id = $1 AND athlete_id = $2`, [agentId, athleteId]);
  return r.rows[0] ? { prefs: r.rows[0].prefs, updatedAt: r.rows[0].updated_at } : { prefs: null, updatedAt: null };
}
async function saveWishlist(pool, agentId, athleteId, body) {
  await ensureWishlists(pool);
  const { prefs, unknown } = cleanPrefs(body);
  const extra = {
    birthDate: /^\d{4}-\d{2}-\d{2}$/.test(String(body.birthDate || '')) ? body.birthDate : null,
    firstEnrollment: /^\d{4}-\d{2}-\d{2}$/.test(String(body.firstEnrollment || '')) ? body.firstEnrollment : null,
    priorTransfers: Math.max(0, Math.min(5, parseInt(body.priorTransfers, 10) || 0)),
  };
  await pool.query(`INSERT INTO portal_wishlists (agent_id, athlete_id, prefs, updated_at) VALUES ($1,$2,$3,NOW())
    ON CONFLICT (agent_id, athlete_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = NOW()`, [agentId, athleteId, JSON.stringify({ ...prefs, ...extra })]);
  return { prefs: { ...prefs, ...extra }, unknownSchools: unknown };
}

function meta() {
  return {
    groups: P.GROUPS.map((g) => ({ key: g, label: P.LABEL[g] })),
    schools: Schools.all().map((s) => ({ name: s.name, level: s.level, conference: s.conference, state: s.state })),
    regions: Object.keys(Schools.REGIONS),
    windows: WINDOWS.football,
  };
}

module.exports = { board, school, enterCheck, getWishlist, saveWishlist, cleanPrefs, meta, rosters, clearCache, WINDOWS, Sweep, Coaching };
