'use strict';
// ── ONE WAY TO CREATE AN ATHLETE ─────────────────────────────────────────────
//
// POST /api/athletes and the assistant's add_athlete tool used to be two
// paths to the same row: the route did the work, and the tool handed the
// browser a directive to call the route. That made the tool's answer to the
// model a promise, not a fact: "done" went back before anything was saved,
// and a seat limit or a missing school failed in the browser where the model
// could not see it. The agent was then told an athlete had been added who
// had not been.
//
// Now the route and the tool call the same function, and the tool's answer is
// what actually happened. Everything the route enforced still holds here, in
// the same order: the school (or a pro's city) is required, the seat rule is
// the plan's or the admin's override, a double-click within ten seconds
// returns the row it already made, and the on-demand fill starts the moment
// the row exists when the queue is enabled.
//
// The field validators live here too, exported for the routes that patch an
// athlete later (PUT /api/athletes/:id, the bulk date-of-birth save).

const store = require('../store');
const Seats = require('./seats');

// Only the seven keys the compliance gate has rules for. Anything else is
// dropped rather than stored: an unrecognised key would sit in the record
// looking like a restriction while matching no category the gate can see.
function _validRestrictions(v) {
  if (!Array.isArray(v)) return [];
  const known = new Set(require('./compliance').CATEGORIES.map((c) => c.key));
  return v.map((x) => String(x || '').trim().toLowerCase()).filter((x) => known.has(x));
}

// ── THE OVER-18 ANSWER ──────────────────────────────────────────────────────
// Three states, and the third is not a "no". An athlete nobody has answered for
// is UNKNOWN, which is what the gate has always held on; only an explicit tick
// or untick is a fact. Coercing undefined to false would mark every existing
// athlete on every roster a minor overnight.
function _validOver18(v) {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}

function _validDob(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  const now = Date.now();
  if (d.getTime() > now) return '';
  if (now - d.getTime() > 120 * 365.25 * 864e5) return '';
  return s;
}

// ── AN ENGAGEMENT RATE WE DO NOT HAVE IS NOT 3% ─────────────────────────────
//
// Both the form and this route read `parseFloat(v) || 3.0`, so a BLANK FIELD was
// stored as 3.0 -- and so was a real 0, because `0 || 3.0` is 3.0. Every athlete
// added without an engagement rate carries an invented one that is
// indistinguishable from a measured one: igStatsSource says 'manual' either way.
// That number then reaches media kits, the older pitch path, draftPrewarm, and
// deal_comps, where other athletes are benchmarked against it.
//
// null means absent, and absent is a thing every reader already handles:
// analyst.pct returns null for it and the kit omits the row.
//
//   undefined  the key was not sent -- leave whatever is on file alone
//   null       sent and empty, or junk -> ABSENT
//   0..100     a real answer, INCLUDING 0
function _validEngagement(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  // THE MINUS SURVIVES THE STRIP. Removing every non-digit turned "-4" into 4 --
  // a rejected value silently becoming an accepted one, which is the same class
  // of bug as the default it replaces.
  const x = typeof v === 'string'
    ? parseFloat(String(v).replace(/[^0-9.\-]/g, '')) : Number(v);
  // Out of range is junk, not a claim. A stored 0 is kept: an agent who types 0
  // means 0, and conflating that with "we never asked" is the bug above.
  if (!Number.isFinite(x) || x < 0 || x > 100) return null;
  return Math.round(x * 10) / 10;
}

// ── IS THIS A HIGH SCHOOL? ──────────────────────────────────────────────────
// A high school athlete is welcome; what changes is that their age matters
// most, so the assistant asks for a date of birth. Decided from the name: a
// school our resolver knows as a college is never a high school, whatever it
// is called; otherwise the words that name a secondary school decide. The
// service academies are colleges that say "Academy" and are named here so
// they are not asked about. A wrong YES costs one question the agent can
// skip; a wrong NO costs nothing that was not already the case.
const HS_WORDS = /\bhigh\s*school\b|\bh\.?\s?s\.?$|\bhigh$|\b(senior|junior)\s+high\b|\bprep\b|\bpreparatory\b|\bacademy\b|\bcollegiate\b|\bcharter\b|\bmagnet\b|\bsecondary\b|\bhomeschool\b|\bhome\s+school\b/i;
const SERVICE_ACADEMY = /\b(naval|military|air\s*force|coast\s*guard|merchant\s*marine)\s+academy\b|\bwest point\b/i;
function isHighSchool(school) {
  const s = String(school || '').trim();
  if (!s) return false;
  if (SERVICE_ACADEMY.test(s)) return false;
  if (!HS_WORDS.test(s)) return false;
  try {
    const { resolveSchool } = require('./schoolResolver');
    const hit = resolveSchool(s);
    if (hit && hit.city && (hit.method === 'exact' || hit.method === 'alias' || (hit.confidence || 0) >= 0.95)) return false;
  } catch (_) { /* the resolver is not the decider; the words are */ }
  return true;
}

// ── IS THIS NAME ALREADY ON THE ROSTER? ─────────────────────────────────────
// The same rule the spreadsheet import applies (services/rosterImport
// sameName: case, spacing and punctuation folded), against this agent's
// roster only. Returns the existing row, or null.
async function findDuplicate(agentId, name) {
  const RImport = require('./rosterImport');
  if (!agentId || !RImport.nameKey(name)) return null;
  const r = await store.pool.query(
    `SELECT id, data->>'name' AS name, data->>'sport' AS sport, data->>'school' AS school,
            data->>'city' AS city, data->>'athleteType' AS athlete_type
       FROM athletes WHERE agent_id = $1 ORDER BY created_at ASC`, [agentId]);
  for (const row of r.rows) if (RImport.sameName(row.name, name)) return row;
  return null;
}

// ── DOES ADDING AN ATHLETE START THEIR FILL NOW? ────────────────────────────
// On-demand fills ride the same enable flag as the nightly job: one switch
// controls every path that can spend on the queue. Overridable for tests.
let _fillNowOverride = null;
function fillOnDemandEnabled() {
  if (_fillNowOverride !== null) return _fillNowOverride;
  try { return require('../jobs/outreachQueue').ENABLED === true; } catch (_) { return false; }
}
function _setFillNowForTests(v) { _fillNowOverride = (v === null || v === undefined) ? null : !!v; }

// Fill the slots for one athlete on this agent's roster. Claimed per athlete
// per day inside fillOnDemand, so calling it again is safe.
async function runOnDemandFill(agentId, athleteId) {
  const job = require('../jobs/outreachQueue');
  const aths = await job.loadAthletesForQueue(store.pool, agentId, athleteId || null);
  for (const ath of aths) {
    await job.fillOnDemand(store.pool, ath).catch((e) =>
      console.error(`[queue/ondemand] athlete=${ath.id} failed: ${e.message}`));
  }
}

// createAthlete(user, body) -> { ok: true, athlete, created: true|false }
//                           |  { ok: false, status, error, code?, field? }
// `created: false` is the double-click guard returning the row it already
// made. Never throws for a bad request; a database failure does throw, and
// the callers say so in their own words.
async function createAthlete(user, body, opts) {
  const b = body || {};
  // opts.allowDuplicate: the caller has already asked the agent whether a
  // second athlete with this name is wanted and been told yes (the assistant's
  // confirmDuplicate), so the double-click guard below must not return the
  // first one.
  const allowDuplicate = !!(opts && opts.allowDuplicate);
  // ── AN ATHLETE WITHOUT A SCHOOL IS A RECORD THE PIPELINE CANNOT USE ──────
  // Enforced HERE and not only in the form, because the form is not the
  // boundary. Cooper Farrall saved with school:'' when AI Lookup came back
  // without one, and every nightly run since has reported no local market and
  // produced zero cards for him. Nothing at the point of saving said a word.
  //
  // The school need not be one we RECOGNISE -- an unmapped school is geocoded to
  // its town (services/schoolGeocode) and the local lane runs there. It must
  // exist, because there is nothing to geocode otherwise.
  if (!String(b.school || '').trim()) {
    return { ok: false, status: 400, field: 'school',
      error: 'A school is required. The nightly run uses it to find local businesses, so an athlete saved without one gets no cards.' };
  }
  const { name, sport, position, school, schoolTier, instagram, tiktok, engagement, notes, year, stats, transferReason, gpa, over18,
          instagramHandle, brandRestrictions, igStatsSource, igStatsFetchedAt, hometown, tags, productWants, email, legal_name, dob,
          schoolRestrictions, athleteType, city, team } = b;
  if (!name || !sport) return { ok: false, status: 400, error: 'name and sport required' };
  // ── COLLEGE OR PRO ──────────────────────────────────────────────────────
  // Stored in `data`, never in the athlete_type column: that column says who
  // manages and pays for the athlete (agent_managed / self_managed) and a pro
  // can be either. A pro has no school and no class year, and those are
  // cleared here whatever the form sent, so a pro cannot carry a stale school
  // into the local lane or a stale "junior" into a pitch.
  const isPro = athleteType === 'pro';

  // ── Seat limit check ─────────────────────────────────────────
  // The plan's limit, unless an admin set one for this account (services/seats).
  const seats = Seats.seatLimitFor(user);
  const seatLimit = seats.limit;
  if (seatLimit !== null) {
    const countR = await store.pool.query(`SELECT COUNT(*) FROM athletes WHERE agent_id=$1`, [user.id]);
    const currentCount = parseInt(countR.rows[0].count, 10);
    if (currentCount >= seatLimit) {
      return { ok: false, status: 403, error: Seats.limitMessage(seats), code: 'SEAT_LIMIT_REACHED',
        seatLimit, seatSource: seats.source, currentCount };
    }
  }

  // ── Duplicate-submit guard ───────────────────────────────────
  // A slow save can let a double-click through and create two identical clients.
  // If this agent already created an athlete with the same name in the last 10
  // seconds, treat it as the same submission and return that existing row instead
  // of inserting a duplicate. A guard failure must never block a legitimate save,
  // so any error here just falls through to the normal insert below.
  if (!allowDuplicate) try {
    const dupR = await store.pool.query(
      `SELECT id FROM athletes
         WHERE agent_id=$1 AND data->>'name'=$2 AND created_at > NOW() - INTERVAL '10 seconds'
         ORDER BY created_at DESC LIMIT 1`,
      [user.id, name]);
    if (dupR.rows.length > 0) {
      const existing = await store.getAthlete(dupR.rows[0].id);
      if (existing) return { ok: true, athlete: existing, created: false };
    }
  } catch (e) {
    console.error('[create-athlete] duplicate guard failed:', e.message);
  }

  const id = 'ath-' + Date.now();
  const athlete = await store.saveAthlete(id, {
    id, agentId: user.id, name, sport, position: position || '',
    athleteType: isPro ? 'pro' : 'college',
    school: isPro ? '' : (school || ''), schoolTier: schoolTier || 'p4-mid',
    // The pro's city ("Denver, CO") is the local lane's town and the state
    // the compliance gate rules on; the team is what the pitch names.
    city: isPro ? String(city || '').trim().slice(0, 120) : '',
    team: isPro ? String(team || '').trim().slice(0, 120) : '',
    instagram: parseInt(instagram) || 0,
    tiktok: parseInt(tiktok) || 0,
    // null when blank or junk. See _validEngagement: 3.0 was an invented number
    // that reached media kits and deal_comps as though it were measured.
    engagement: _validEngagement(engagement) === undefined ? null : _validEngagement(engagement),
    // DATED, like the follower count. reachProvenance.engagementProvenance reads
    // these, and nothing may cite an undated rate.
    engagementSource: _validEngagement(engagement) === null
      || _validEngagement(engagement) === undefined ? null : 'agent',
    engagementAsOf: _validEngagement(engagement) === null
      || _validEngagement(engagement) === undefined ? null : new Date().toISOString().slice(0, 10),
    notes: notes || '',
    year: isPro ? '' : (year || ''),
    stats: stats || '',
    transferReason: transferReason || '',
    gpa: gpa || '',
    // Optional athlete contact email, stored in the athlete data (not the login
    // email column). Used to email the portal invite link. Kept only when it
    // looks like an email so it never becomes an ID-like placeholder.
    email: (email && String(email).includes('@')) ? String(email).trim() : '',
    // Optional full legal name, used only on contracts. Falls back to the display
    // name when blank. Stored in the athlete data, same pattern as email.
    legal_name: (legal_name ? String(legal_name).trim() : ''),
    // Hometown powers the Deal Scan second market ("hometown hero" angle).
    hometown: (hometown ? String(hometown).trim() : ''),
    // DATE OF BIRTH, for the compliance gate and nothing else. Stored ONLY when
    // it parses to a real past date -- a junk value here would resolve minor
    // status wrongly, and a wrong answer is worse than the honest unknown the
    // gate already handles. Empty means not on file, which HOLDS restricted
    // categories rather than assuming an adult.
    dob: _validDob(dob),
    // WHETHER THE AGENT SAYS THIS ATHLETE IS 18+. Requiring a date of birth meant
    // every new athlete was held on every restricted category until somebody went
    // and found a birthday -- a wall between signing a client and working for
    // them. The agent knows whether their own client is eighteen; they do not
    // always know the date. A real dob still wins over this wherever both exist.
    over18: _validOver18(over18),
    // AGENT-SUPPLIED SCHOOL RESTRICTIONS. Filtered to the categories the gate
    // actually knows, so a typo cannot create a rule that blocks everything and
    // matches nothing. This is what the agent says their school restricts; it is
    // never checked with the school and the record says so wherever it appears.
    // The Add Client form no longer collects these -- the compliance agent owns
    // category policy -- but anything already stored is preserved and still read.
    schoolRestrictions: _validRestrictions(schoolRestrictions),
    // Interest tags ("industry:sub" strings) and product wants feed Deal Scan.
    tags: Array.isArray(tags) ? tags.filter((t) => typeof t === 'string').slice(0, 40) : [],
    productWants: (productWants ? String(productWants).trim().slice(0, 300) : ''),
    // Additive social/onboarding fields — default cleanly so the normal Add
    // Client flow (which does not send these) is unchanged.
    instagramHandle: (instagramHandle ? String(instagramHandle).trim().replace(/^@+/, '').toLowerCase() : ''),
    brandRestrictions: Array.isArray(brandRestrictions) ? brandRestrictions : [],
    igStatsSource: ['web_estimate', 'manual', 'instagram_page'].includes(igStatsSource) ? igStatsSource : null,
    igStatsFetchedAt: igStatsFetchedAt || null,
    createdAt: new Date().toISOString(),
  });
  store.markChecklistItem(user.id, 'add_athlete').catch(() => {}); // Getting Started checklist
  // ── A NEW ATHLETE IS FILLED NOW, NOT TONIGHT ────────────────────────────
  // Adding an athlete did not start anything: their first cards arrived with
  // the next nightly run, which could be twenty hours away. The on-demand fill
  // (the same one the queue page runs) starts in the background the moment
  // the row exists, and Home shows "finding businesses" for them until it
  // lands. Claimed per athlete per day inside fillOnDemand, so opening the
  // queue a minute later does not run it twice.
  if (fillOnDemandEnabled()) {
    try { require('./outreachQueue').markFilling(id); } catch (_) {}
    setImmediate(() => { runOnDemandFill(user.id, id).catch((e) => console.error('[queue/ondemand] new athlete', e.message)); });
  }
  return { ok: true, athlete, created: true };
}

module.exports = {
  createAthlete, findDuplicate, isHighSchool, fillOnDemandEnabled, runOnDemandFill,
  _validRestrictions, _validOver18, _validDob, _validEngagement, _setFillNowForTests,
};
