#!/usr/bin/env node
'use strict';
// Nightly fill of the morning outreach queue.
//
//   node server/jobs/outreachQueue.js --dry-run        pick and price, write nothing
//   node server/jobs/outreachQueue.js --send           the real nightly run
//   node server/jobs/outreachQueue.js --status         what each agent has queued
//   node server/jobs/outreachQueue.js --send --agent <id> [--force]
//
// Off unless OUTREACH_QUEUE_ENABLED=1, so a deploy cannot start spending by
// surprise. Same shape as the weekly digest, for the same reason.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE.
//
// 1. EMPTY SLOTS ONLY. An agent who never acts is never filled for, so an
//    inactive account costs nothing at all -- not a reduced amount, nothing.
//
// 2. ONE CLAIM PER AGENT PER NIGHT. outreach_queue_runs has PRIMARY KEY
//    (agent_id, run_date) and the row is claimed BEFORE any lookup. A slot freed
//    at 10am waits for tomorrow; an agent skipping three cards in one sitting
//    triggers zero lookups. A crash after the claim costs that agent one night,
//    which is the right way round for money.
//
// 3. THE CAP IS A CAP. $0.50 an agent a night, checked before each lookup against
//    its ceiling. A slot that cannot be filled inside it is LEFT EMPTY and the
//    reason is logged. Never a partial fill that quietly costs more.
//
// Cost: the quality bar needs a named contact, which needs the deep ladder --
// $0.12 to $0.26 a business, and a cached one is free. Cache first, at most
// MAX_ATTEMPTS_PER_SLOT candidates a slot.

const store = require('../store');
const scanMeter = require('../scanMeter');
const ai = require('../ai');
const { buildContactLadder } = require('../services/contactLadder');
const { lookupPlace, lookupPlaceResult } = require('../services/placesLookup');
const { findInstagram } = require('../services/instagramLookup');
const SIG = require('../services/signature');
const SchoolGeo = require('../services/schoolGeocode');
// The same normaliser the Scout and the contact cache key on, so a geocoded
// market lands in the same bucket a mapped one would.
let canonicalRegionOf = (x) => String(x || '').trim().toLowerCase();
try { canonicalRegionOf = require('../services/regionKey').canonicalRegion || canonicalRegionOf; }
catch (_) { try { canonicalRegionOf = require('../ai').canonicalRegion || canonicalRegionOf; } catch (_2) {} }
const AgentName = require('../services/agentName');
const WriterEvidence = require('../services/writerEvidence');
const Q = require('../services/outreachQueue');
const PW = require('../services/pitchWriter');
const BI = require('../services/brandIdentity');
const AR = require('../services/athleteRecord');
const Scout = require('../services/scout');
const Deepen = require('../services/marketDeepen');
const Claims = require('../services/nightlyClaims');
const { resolveSchool } = require('../services/schoolResolver');
// The last door for a contact name (see the local write site).
const ONS = require('../services/ownerNameSearch');
const EVAL = require('../services/emailValidation');
const EF = require('../services/emailFinder');

// ── THE EMAIL FINDER'S SWITCHES (all off unless set) ────────────────────────
//   EMAIL_FINDER_ON=1    the finishing step runs (services/emailFinder)
//   EMAIL_FINDER_MORE=1  and does more when it misses: a check that could not
//                        run is retried later the same night (up to 3 tries),
//                        another named decision maker is tried, and a business
//                        with no website is looked up on Places and Facebook
//   EMAIL_FIVE_ON=1      FIVE VERIFIED EMAILS: only an email card with a
//                        verified address for a named person fills a slot. A
//                        business that cannot get one is dropped and the next
//                        one pulled; no slot is filled with a DM or a call.
//                        Chains and lanes that cannot produce one (national and
//                        social brands) are skipped before anything is spent.
//                        Runs the finishing step whatever EMAIL_FINDER_ON says.
//   EMAIL_SMART_PICK=1   SMART PICK (services/reachability): candidates are
//                        ranked by how often their kind of business turned
//                        into a verified email -- within the same type only,
//                        never across types and never as a filter -- no more
//                        than two of one type in an athlete's five, the
//                        contact order owner > marketing lead > GM/manager,
//                        and, last, a verified general inbox for a business
//                        of about five or fewer people (one per athlete per
//                        night). Runs the finishing step too.
const FINDER = {
  // MARKET_MIX_ON too: a backfilled brand seat takes only a verified named
  // person's email, so the mailbox check must be able to run (services/dealMix).
  // SEND_GATE_ON too: a morning card's address comes only from the finder.
  on: () => process.env.EMAIL_FINDER_ON === '1' || process.env.EMAIL_FIVE_ON === '1' || process.env.EMAIL_SMART_PICK === '1' || process.env.MARKET_MIX_ON === '1'
    || process.env.SEND_GATE_ON === '1',
  more: () => process.env.EMAIL_FINDER_MORE === '1',
  five: () => process.env.EMAIL_FIVE_ON === '1',
  smart: () => process.env.EMAIL_SMART_PICK === '1',
};
// ── WHAT HOLDS ONE OF THE FIVE ──────────────────────────────────────────────
// EMAIL_FIVE_ON: only a verified email card (a named person's address, or the
// one General inbox card) holds a slot. A DM, call, program or unverified email
// card stays on the agent's page until they work it or it expires, but it no
// longer stops tonight's run from placing a verified email beside it. Off:
// every queued card holds its slot, as before.
const holdsUnderFive = (r) => r && r.channel === 'email' && r.email_verified === true;
function openSlotsFor(heldRows) {
  return FINDER.five() ? Q.slotsToFill(heldRows, { holds: holdsUnderFive }) : Q.slotsToFill(heldRows);
}
const HELD_SQL = `SELECT slot, state, channel, email_verified FROM outreach_queue WHERE athlete_id = $1 AND state = 'queued'`;
// ── THE THREE-LANE DEAL MIX (MARKET_MIX_ON) ─────────────────────────────────
// The athlete's Market Score tier (services/marketScore) splits the five slots
// between the local, social and national lanes (services/dealMix), and the
// social and national lanes come back on, under the same bar as local: an
// official application page, or a named partnerships / marketing contact's
// verified address. Off: everything below runs exactly as before, and
// EMAIL_FIVE_ON keeps the slate local only.
const DM = require('../services/dealMix');
const MS = require('../services/marketScore');
const Fit = require('../services/fitReasons');
const BrandContact = require('../services/brandContact');
const HELD_MIX_SQL = `SELECT slot, state, channel, email_verified, lane, program_url FROM outreach_queue WHERE athlete_id = $1 AND state = 'queued'`;
const Reach = require('../services/reachability');
const SG = require('../services/sendGate');
// Tonight's Hunter allowance, and cache mode once it is spent (HUNTER_PACE_ON).
const HP = require('../services/hunterPace');
const TYPE_CAP = 2;
const VERIFY_TRIES = 3;
// Between tries of a check that could not run: long enough for Hunter to
// finish a slow mail server (its 202) or come back from an outage.
const RETRY_GAP_MS = parseInt(process.env.FINDER_RETRY_GAP_MS, 10) || 4 * 60 * 1000;
// Whether a business's card would carry a verified address for the person it
// greets: the email channel, the greeted row's own address, and that address
// passed the mailbox check (services/emailFinder rule 4).
function verifiedNamedEmail(ladder, ig) {
  if (Q.channelFor(ladder, ig) !== 'email') return false;
  const person = Q.greetRowOf(ladder);
  const inbox = Q.inboxOf(ladder);
  return !!(person && inbox && person.email && String(person.email).toLowerCase() === String(inbox.email).toLowerCase()
    && person.emailVerify && person.emailVerify.pass);
}
// ALWAYS ON. OUTREACH_NAME_REQUIRED=0 used to turn the requirement off, and a
// card that greets nobody is not a card whatever the environment says. The
// constant stays so the pre-writer name search keeps its shape; insertCard
// refuses a nameless card regardless of it.
const NAME_REQUIRED = true;

// ── THE LAST DOOR, ONCE PER BUSINESS PER NIGHT ──────────────────────────────
// services/ownerNameSearch, under the contacts.finalname label and the
// metered search. Cached in the process by business and city for a day, so a
// national brand that appears on every athlete's slate is searched once, not
// once per athlete, and a local business tried twice in one run is not paid
// for twice. A CONFIRMED miss is cached too: asking again tonight will not
// find a name that was not there an hour ago. A search that could not run
// throws (services/ourFault) and is never cached: it is not a miss.
const _finalNames = new Map();
const FINAL_NAME_TTL_MS = 24 * 3600000;
// large: a national-lane brand or a social brand sized national -- only its
// partnerships or marketing lead is accepted (ownerNameSearch.titleProblem),
// and that is who is searched for.
async function finalNameFor(brand, city, { agentId, athleteId, say, order, large }) {
  if (large) order = ONS.LARGE_ORDER;
  const key = `${String(brand || '').trim().toLowerCase()}|${String(city || '').trim().toLowerCase()}|${Array.isArray(order) ? order.join(',') : ''}|${large ? 'L' : ''}`;
  const hit = _finalNames.get(key);
  if (hit && Date.now() - hit.at < FINAL_NAME_TTL_MS) return hit.found;
  const found = await scanMeter.label({ site: 'contacts.finalname', agentId, athleteId, brand },
    () => ONS.findOwnerName({ brand, city, search: ai.webSearchJson, say, order, large: !!large }));
  _finalNames.set(key, { found: found || null, at: Date.now() });
  return found || null;
}
// One resolver for the job and the shared record, so a school that resolves
// for the Writer resolves for the Scout too.
const resolveSchoolLoc = (name) => resolveSchool(name);

const ENABLED = process.env.OUTREACH_QUEUE_ENABLED === '1';
const CAP_USD = parseFloat(process.env.OUTREACH_QUEUE_AGENT_CAP_USD) || Q.DEFAULT_AGENT_NIGHTLY_USD;
// The ladder's own ceiling, used to decide whether the NEXT lookup fits. Pricing
// the worst case rather than the average is what makes the cap a cap.
//
// THIS NUMBER IS TIED TO THE SOURCE ORDER, and moved when the order did. $0.26
// priced the OLD full fan-out: up to 7 sources at roughly $0.02 a source (one
// Haiku call with web search at $10/1k searches, plus tokens). The queue now
// runs the lean order -- chamber, site, facebook -- so three sources is the
// true worst case and the ceiling is ~$0.06.
//
// Getting this wrong is not a rounding error: left at $0.26 it silently made
// the $0.15 on-demand cap unspendable, because canSpend($0.26) against a $0.15
// cap is false before the first lookup. On-demand would have claimed its day,
// filled nothing, and reported "budget cap reached" every single time.
const LOOKUP_CEILING_USD = parseFloat(process.env.OUTREACH_QUEUE_LOOKUP_USD) || 0.06;
// ── WHEN A RUN IS THE SUSPECT, NOT THE MARKETS ──────────────────────────────
// Below this many athletes there is no roster-level signal to read: two failing
// out of two is an ordinary Tuesday on a small account. At or above it, a share
// this high means the run failed, not the towns. Deliberately strict -- the cost
// of a false positive is one night nobody is paused.
const SYSTEMIC_MIN_ATHLETES = parseInt(process.env.OUTREACH_QUEUE_SYSTEMIC_MIN, 10) || 3;
const SYSTEMIC_FAIL_SHARE = parseFloat(process.env.OUTREACH_QUEUE_SYSTEMIC_SHARE) || 0.8;

// ── Time, in Central, without a timezone library ─────────────────────────────
// Same trick as server/services/weeklyDigest.js: the server runs UTC and Central
// shifts with DST, so the offset cannot be hardcoded. Intl knows the rules; this
// reads the wall-clock parts back out.
const CENTRAL_TZ = 'America/Chicago';
// The overnight window the scheduler is allowed to fire in. Wide enough that a
// missed tick still catches the window, narrow enough that a daytime deploy or
// restart can never trigger a same-day fill -- "log in tomorrow morning and the
// cards are already there" means the run has to be well before anyone is awake.
const WINDOW_START_HOUR = 1;   // 1am Central
const WINDOW_END_HOUR = 5;     // up to (not including) 5am Central
function centralParts(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: CENTRAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour === '24' ? '0' : p.hour), minute: Number(p.minute),
  };
}
// Today's date in CENTRAL, not UTC -- this is the claimNight() dedupe key, and an
// agent near midnight Central (which can already be tomorrow in UTC) must get the
// same run_date whether the fill comes from the nightly job or the admin button.
function today(ms) {
  const p = centralParts(ms == null ? Date.now() : ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
// Is it currently the overnight window in Central? The scheduler ticks every 15
// min regardless; this is the only gate on whether a given tick actually runs
// anything. Double-fire safety inside the window is claimNight()'s job, not this
// function's -- see the scheduler comment in server/index.js.
function nightlyWindowOpen(ms) {
  const h = centralParts(ms == null ? Date.now() : ms).hour;
  return h >= WINDOW_START_HOUR && h < WINDOW_END_HOUR;
}

// Claim the night. Returns false when this agent has already been filled today,
// which is what stops a freed slot refilling on the spot.
async function claimNight(pool, agentId, runDate, force) {
  if (force) {
    await pool.query(
      `INSERT INTO outreach_queue_runs (agent_id, run_date) VALUES ($1,$2)
       ON CONFLICT (agent_id, run_date) DO UPDATE SET created_at = NOW()`, [agentId, runDate]);
    return true;
  }
  const r = await pool.query(
    `INSERT INTO outreach_queue_runs (agent_id, run_date) VALUES ($1,$2)
     ON CONFLICT (agent_id, run_date) DO NOTHING`, [agentId, runDate]);
  return (r.rowCount || 0) > 0;
}

// ── RETIRE WHAT NOBODY WORKED ───────────────────────────────────────────────
//
// uq_outreach_queue_open is UNIQUE on (athlete_id, slot) WHERE state='queued', so
// a card the agent never touched holds its slot forever. Five untouched cards is
// a permanently full queue reporting "all 5 slots already hold work you have not
// actioned" every morning: correct, and useless.
//
// Run BEFORE the slots are counted, so tonight's fill sees the space this frees
// rather than finding out tomorrow.
//
// NOTHING IS DELETED. The row keeps its brand, its pitch, its contact and its
// reason; only the state moves to 'expired'. The record of what was offered and
// never worked is the evidence for whether seven days is the right number.
async function expireStaleCards(pool, opts = {}) {
  const days = Number(opts.days) || Q.EXPIRE_AFTER_DAYS;
  const scope = opts.agentId ? 'AND agent_id = $2' : '';
  const params = opts.agentId ? [String(days), opts.agentId] : [String(days)];
  const r = await pool.query(
    `UPDATE outreach_queue
        SET state = 'expired', expired_at = NOW(), updated_at = NOW()
      WHERE state = 'queued'
        AND COALESCE(expire_from, created_at) < NOW() - ($1 || ' days')::interval
        ${scope}
      RETURNING athlete_id, brand_name`, params
  ).catch((e) => {
    // Not "every slot is full" (services/ourFault): the caller records a fault.
    console.error('[queue] expireStaleCards:', e.message);
    throw require('../services/ourFault').fault('database', 'could not expire stale cards: ' + e.message);
  });

  if (r.rows.length) {
    const byAthlete = {};
    for (const x of r.rows) byAthlete[x.athlete_id] = (byAthlete[x.athlete_id] || 0) + 1;
    console.log(`[queue] expired ${r.rows.length} card(s) older than ${days} days across `
      + `${Object.keys(byAthlete).length} athlete(s); their slots are free for tonight`);
  }
  return { expired: r.rows.length, rows: r.rows };
}

// ── Backoff state ────────────────────────────────────────────────────────────
// One row per athlete, written only by the two functions below so the pause
// rule lives in exactly one place.
async function athleteState(pool, athleteId) {
  const r = await pool.query(
    `SELECT athlete_id, consecutive_failures, last_attempt_date, paused_at, paused_reason
       FROM outreach_queue_athlete_state WHERE athlete_id = $1`, [athleteId]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

// ── LET A PAUSED ATHLETE BACK IN ────────────────────────────────────────────
// The only statement that cleared paused_at lived inside recordAttempt's
// filled > 0 branch, and a paused athlete returned from fillAthlete before ever
// reaching it -- so the exit condition required doing the thing the pause
// prevented. Six athletes sat at zero for nine days. This is the exit, callable
// from the nightly retry, the agent's Resume button, and the script alike.
//
// consecutive_failures goes back to 0 deliberately: a resumed athlete gets a
// full three nights to prove the market, not one. Re-pausing on the first thin
// night would make the retry theatre.
async function releasePause(pool, athleteId, source) {
  const r = await pool.query(
    `UPDATE outreach_queue_athlete_state
        SET paused_at = NULL, paused_reason = NULL, consecutive_failures = 0,
            released_at = NOW(), release_source = $2, updated_at = NOW()
      WHERE athlete_id = $1 AND paused_at IS NOT NULL
      RETURNING athlete_id`,
    [athleteId, String(source || 'unknown').slice(0, 60)]
  ).catch((e) => { console.error('[queue] releasePause:', e.message); return { rowCount: 0 }; });
  if (r.rowCount) console.log(`[queue] athlete=${athleteId} RESUMED (${source})`);
  return r.rowCount > 0;
}

// Record what an attempt that ACTUALLY SPENT produced. A night with no
// candidates costs nothing and must not count toward the pause, or an athlete
// waiting on their first Deal Scan would be paused for a problem that is not
// theirs. Idempotent per date: re-running the same day cannot double-count.
//
// ── AND A NIGHT THAT FAILED BECAUSE OF US IS NOT THEIR FAILURE ─────────────
// On 2026-08-23 six athletes on one roster tripped this counter inside eight
// minutes. Nothing about their markets changed that night; NIGHTLY_SLOTS was 1,
// the deliverable lint demanded a quantifier, and the sign-off regex \bjohn\b
// could not match "JohnMark" -- so every pitch that agent's roster produced was
// rejected by our own rules, and the backoff wrote it down as six thin markets.
// f1b11aa fixed the rules the next day. The pause outlived the bug by nine days.
//
// `faults` is the count of failures this athlete's night suffered that were OURS
// -- a lookup that threw, a provider outage, a writer that could not run. A
// night whose failures were all faults teaches nothing about the market and is
// not counted.
async function recordAttempt(pool, athleteId, { filled, spent, runDate, faults, tried, systemic }) {
  if (filled > 0) {
    await pool.query(
      `INSERT INTO outreach_queue_athlete_state (athlete_id, consecutive_failures, last_attempt_date, paused_at, paused_reason, updated_at)
         VALUES ($1, 0, $2, NULL, NULL, NOW())
       ON CONFLICT (athlete_id) DO UPDATE SET
         consecutive_failures = 0, last_attempt_date = $2,
         paused_at = NULL, paused_reason = NULL, updated_at = NOW()`,
      [athleteId, runDate]).catch((e) => console.error('[queue] backoff reset failed:', e.message));
    return;
  }
  if (!(spent > 0)) return;   // nothing was spent, so nothing was learned

  // THE RUN ITSELF WAS BROKEN. Decided across the whole roster by fillAgent, not
  // here: one athlete cannot tell a thin market from a systemic failure, but a
  // run where most of the roster failed the same way can. This is the guard that
  // would have stopped 2026-08-23, and it is checked before anything else.
  if (systemic) {
    console.warn(`[queue] athlete=${athleteId} not counted toward the backoff — `
      + 'the run failed across the roster, which is our problem, not this market');
    return;
  }
  // THE RULE (services/ourFault): a failure on our side never counts toward a
  // pause. This used to skip only a night where EVERY attempt was ours; a
  // night with one outage and three honest rejections still counted, and the
  // outage was the reason the other three were all it tried. Any fault now
  // means the night measured us, not their market.
  const triedN = Array.isArray(tried) ? tried.length : 0;
  if (faults > 0) {
    console.warn(`[queue] athlete=${athleteId} not counted toward the backoff — `
      + `${faults} failure(s) tonight were ours${triedN ? ` (${triedN} attempt(s))` : ''}`);
    return;
  }

  const r = await pool.query(
    `INSERT INTO outreach_queue_athlete_state (athlete_id, consecutive_failures, last_attempt_date, updated_at)
       VALUES ($1, 1, $2, NOW())
     ON CONFLICT (athlete_id) DO UPDATE SET
       consecutive_failures = CASE
         WHEN outreach_queue_athlete_state.last_attempt_date = $2
           THEN outreach_queue_athlete_state.consecutive_failures
         ELSE outreach_queue_athlete_state.consecutive_failures + 1 END,
       last_attempt_date = $2, updated_at = NOW()
     RETURNING consecutive_failures`,
    [athleteId, runDate]).catch((e) => { console.error('[queue] backoff bump failed:', e.message); return { rows: [] }; });

  const failures = r.rows[0] ? r.rows[0].consecutive_failures : 0;
  if (failures >= Q.BACKOFF_NIGHTS) {
    await pool.query(
      `UPDATE outreach_queue_athlete_state
          SET paused_at = NOW(), paused_reason = $2, updated_at = NOW()
        WHERE athlete_id = $1 AND paused_at IS NULL`,
      [athleteId, Q.pausedNote(failures)]).catch(() => {});
    console.log(`[queue] athlete=${athleteId} PAUSED after ${failures} nights with nothing that passed the bar`);
  }
}

// Businesses this athlete has seen but nobody has contacted or retired. The
// ledger is keyed (athlete_id, brand_key), so a brand skipped by one athlete is
// still offered to another on the same roster.
async function candidatesFor(pool, athleteId, limit) {
  const r = await pool.query(
    `SELECT be.brand_key, be.brand_name
       FROM brand_engagement be
      WHERE be.athlete_id = $1
        AND be.state = 'shown'
        AND NOT EXISTS (
          SELECT 1 FROM outreach_queue q
           WHERE q.athlete_id = be.athlete_id AND q.brand_key = be.brand_key)
      ORDER BY be.last_shown_at DESC NULLS LAST
      LIMIT $2`, [athleteId, limit]);
  return r.rows;
}

// WHERE THIS ATHLETE'S LOCAL MARKET IS.
//
// This was the expensive bug. fillAgent passed `opts.region`, which run() never
// set, so every nightly lookup got an EMPTY location hint -- Places resolved on
// the brand name alone and could return a same-name business in another state,
// and the source prompts searched with no city in them. The admin button was no
// better: it passed the SCHOOL NAME ("University of Arkansas"), which is not a
// place a business directory understands.
//
// The SCHOOL CITY, and nothing else. The hometown fallback that used to sit
// above this is gone; see regionForAthlete below for why.
// ONE ATHLETE RECORD, shared with the Writer and the market diagnostic. Every
// field is present or explicitly null; nothing here fills a blank.
// ── WHAT THEY POST, NOT WHEN ────────────────────────────────────────────────
// The content line is what a business is actually buying, and it has to be
// schedule-free: agents report that anything anchored on the season or a
// practice calendar is wrong more often than right, and wrong to a business that
// follows the team costs the pitch. Interests and product wants are what we
// already hold that describes CONTENT rather than a date.
function contentThemesOf(row, profile) {
  const r = row || {};
  const p = profile || {};
  const bits = [];
  const tags = Array.isArray(r.tags) ? r.tags : (Array.isArray(p.tags) ? p.tags : []);
  for (const t of tags.slice(0, 6)) {
    // Tags are stored "industry:sub"; the sub-part is the readable half.
    const readable = String(t).split(':').pop().replace(/[-_]+/g, ' ').trim();
    if (readable) bits.push(readable);
  }
  if (r.productWants) bits.push(String(r.productWants).slice(0, 120));
  const sport = r.sport || p.sport;
  // A generic floor, so the line is never empty. Training and day-in-the-life
  // are true of essentially every college athlete and name no date.
  if (!bits.length) return sport ? `training, ${String(sport).toLowerCase()} content, day in the life` : '';
  return bits.join(', ');
}

function athleteProfile(ath) {
  return AR.resolveAthlete(ath, { schoolLocation: resolveSchoolLoc });
}

// THE HOMETOWN FALLBACK IS GONE. It read `hometown` FIRST and the school second,
// so an athlete whose school did not resolve got local businesses in the town
// they grew up in: Brayden Latham at Eastern Kentucky pitched Knoxville, Messiah
// Mickens at Virginia Tech pitched Harrisburg. Both are hometowns, neither is
// where the athlete lives.
//
// An athlete lives where they go to school. If the school does not resolve, the
// local lane has no town to work in and returns NOTHING for that athlete, which
// the run records as a stated reason. It never substitutes another city.
function regionForAthlete(athlete) {
  const rec = AR.resolveAthlete(athlete, { schoolLocation: resolveSchoolLoc });
  return rec.market || '';
}

// ── AND WHEN THE SHIPPED MAP HAS NEVER HEARD OF THEIR SCHOOL ────────────────
// The map holds ~200 names, heavily D1. Bentley University is a real D2 school
// in Waltham and is not on it, so its athletes got no local lane at all. A
// school name is a place; Places can resolve it. The map still wins where it has
// an answer -- this runs only where it had none, which is the case that used to
// produce silence.
async function regionForAthleteAsync(athlete) {
  const direct = regionForAthlete(athlete);
  if (direct) return { region: direct, geocoded: false };
  const school = (athlete && athlete.data && athlete.data.school)
    || (athlete && athlete.school) || '';
  // MORE THAN ONE REAL SCHOOL BY THAT NAME: not looked up, because Places
  // would simply rank one first. The agent picks (Home), then it resolves.
  const amb = require('../services/schoolResolver').ambiguity(school, { state: athlete && athlete.data && athlete.data.state });
  if (amb && amb.candidates) return { region: '', geocoded: false, ambiguous: amb.candidates };
  if (!SchoolGeo.usable(school)) return { region: '', geocoded: false };
  // lookupPlaceResult, not lookupPlace: geocodeSchool WRITES ITS ANSWER DOWN for
  // six months, so it has to be able to tell "there is no such place" from "we
  // could not ask". Handed the bare lookupPlace it refuses to cache anything
  // negative at all, which is safe but re-pays for every unresolved school
  // nightly.
  let hit = null;
  try { hit = await SchoolGeo.geocodeSchool(school, { lookupPlaceResult, store, reportFault: true }); }
  catch (e) { hit = { fault: e.message }; }
  // COULD NOT ASK is not "no school we could match" (services/ourFault).
  if (hit && hit.fault) return { region: '', geocoded: false, fault: `could not look up where ${school} is: ${hit.fault}` };
  if (!hit) return { region: '', geocoded: false };
  return { region: hit.market, geocoded: true, geocodeSource: hit.source };
}

// ── PROGRAM CARDS PLACED PER BRAND, TONIGHT, ACROSS THE ROSTER ──────────────
//
// READ FROM THE DATABASE, not just counted in memory, so the ceiling survives a
// restart mid-run and so an on-demand fill earlier in the day counts against the
// same allowance as the nightly run.
//
// A ~20 HOUR WINDOW rather than a calendar day. The nightly run fires once and
// its exact hour drifts; "today" in which timezone is a question with no good
// answer here, and the thing being limited is how many applications one brand
// receives from one agency in one burst.
// One place to bump it, so the two placement sites cannot count differently.
function _tallyProgram(tally, brandName) {
  const k = Q.programBrandKey(brandName);
  if (tally && k) tally.set(k, (tally.get(k) || 0) + 1);
}

async function loadProgramBrandTally(pool, agentId) {
  const tally = new Map();
  try {
    const r = await pool.query(
      `SELECT brand_name, COUNT(*)::int AS n
         FROM outreach_queue
        WHERE agent_id = $1 AND channel = 'program'
          AND created_at > NOW() - INTERVAL '20 hours'
        GROUP BY brand_name`, [agentId]);
    for (const row of r.rows) {
      const k = Q.programBrandKey(row.brand_name);
      if (k) tally.set(k, (tally.get(k) || 0) + row.n);
    }
  } catch (e) {
    // An unreadable tally must not stop the run. It fails OPEN -- the per-athlete
    // cap still holds, and the worst case is the behaviour we had before.
    console.error('[queue] program brand tally: ' + e.message);
  }
  return tally;
}

// THE REGION AND THE PROFILE HAVE TO AGREE. localCandidates returns nothing when
// athlete.hasLocalMarket is false, and that flag comes from the shipped map --
// so passing a geocoded region while leaving the profile saying "no market"
// would run the local lane against a town the Scout refuses to search. Both are
// resolved here, once, together.
async function localContextFor(ath) {
  let profile = athleteProfile(ath);
  let r = await regionForAthleteAsync(ath);
  // ── IS THE MARKET WHERE THE SCHOOL IS? ────────────────────────────────────
  // A market from the name rules is checked against the school's actual
  // location (services/schoolMarketCheck) before it is used. A geocoded one
  // already came from the school's own address. Wrong by more than 60 km: the
  // school's own town replaces it, everywhere, from now on.
  const _school = (ath && ath.data && ath.data.school) || (ath && ath.school) || '';
  if (!r.geocoded && profile.hasLocalMarket && profile.market && _school) {
    try {
      const v = await require('../services/schoolMarketCheck').checkAndCorrect(store.pool, _school, profile.market);
      if (v.corrected) { profile = athleteProfile(ath); r = { ...r, region: profile.market || v.market }; }
    } catch (e) { console.warn('[queue] school market check failed for ' + _school + ': ' + e.message); }
  }
  if (r.geocoded && r.region) {
    profile.market = r.region;
    profile.marketKey = canonicalRegionOf(r.region);
    profile.hasLocalMarket = true;
    profile.schoolGeocoded = true;
    // The page said "we could not match this school". It can now say what we did
    // about it instead, which is the difference between a dead end and a note.
    profile.localLaneNote = null;
    // The geocode carries the state too, so the profile's state note lifts with
    // the market note. The compliance gate reads the same geocode cache.
    const cs = AR.cityStateFrom(r.region);
    if (cs.state) { profile.stateCode = cs.state; profile.stateNote = null; }
  }
  // VERIFIED INSTAGRAM NUMBERS (services/instagramConnect), connected athletes
  // only: the writer may cite them in one plain line on a local pitch. A
  // failed read leaves the pitch exactly as it was.
  try {
    const athId = (ath && (ath.id || ath.athleteId)) || null;
    if (athId) profile.igVerified = await require('../services/instagramInsights').verifiedFor(store.pool, athId);
  } catch (e) { console.warn('[queue] instagram numbers unavailable: ' + e.message); }
  return { region: r.region, profile, geocoded: !!r.geocoded, fault: r.fault || null };
}

// The rationale the scan already wrote, which is the same sentence that justifies
// the message. No extra model call.
// EVERYTHING the scan already worked out for this pairing. The old version read
// only `reasoning` and the writer then re-derived an ask from nothing; the value
// and the campaign ideas were generated on the Deal Scan card and thrown away at
// exactly the moment a concrete ask needed them.
async function matchFor(pool, agentId, athleteId, brandName) {
  const r = await pool.query(
    `SELECT reasoning, campaign_ideas, compatibility_score
       FROM brand_match_scores
      WHERE agent_id = $1 AND athlete_id = $2 AND LOWER(brand_name) = LOWER($3)
      ORDER BY created_at DESC LIMIT 1`, [agentId, athleteId, brandName]).catch(() => ({ rows: [] }));
  const m = r.rows[0];
  if (!m) return null;
  const ideas = Array.isArray(m.campaign_ideas) ? m.campaign_ideas
    : (typeof m.campaign_ideas === 'string' ? (() => { try { return JSON.parse(m.campaign_ideas); } catch (_) { return []; } })() : []);
  return {
    reasoning: m.reasoning || null,
    campaignIdeas: (ideas || []).map((x) => (typeof x === 'string' ? x : (x && (x.idea || x.title)) || '')).filter(Boolean),
    score: m.compatibility_score != null ? Number(m.compatibility_score) : null,
  };
}

// ONE FILLER, shared by the nightly job and the admin "fill now" button. If the
// button had its own copy, the card an admin sees and the card the job writes
// would drift apart, and the button is exactly where that drift gets noticed last.
//
// onProgress is called with plain sentences so a UI can print them verbatim; the
// job passes console.log and the endpoint pushes them to a poller.
// ONE INSERT FOR EVERY LANE. Both routes -- the local contact ladder and the
// program page -- land here, so a card cannot pick up a column on one path and
// lose it on the other. Returns true only when a row was actually written; the
// partial unique index on (athlete_id, slot) WHERE state='queued' is what makes
// a double-fill a no-op rather than a duplicate.
async function insertCard(pool, { agentId, athleteId, slot, card, marketKey }) {
  // ── A MISSING VALUE DROPS THE LINE (services/placeholders) ────────────────
  // Every path that saves a card comes through here, so this is the backstop
  // for any writer: a line holding "[athlete_handle]" or "{{first_name}}" is
  // removed from the DM, the email body and the subject before anything is
  // stored. The writer already does this; this catches the ones that do not.
  if (card) {
    const PH = require('../services/placeholders');
    for (const f of ['dmText', 'emailBody']) {
      if (typeof card[f] !== 'string') continue;
      const r = PH.dropLines(card[f]);
      if (r.dropped.length) {
        console.log(`[queue] athlete=${athleteId} "${card.brandName}": dropped ${r.dropped.length} placeholder line(s) from ${f}: ${r.dropped.join(' | ').slice(0, 200)}`);
        card = { ...card, [f]: r.text };
      }
    }
    if (typeof card.subject === 'string' && PH.has(card.subject)) {
      console.log(`[queue] athlete=${athleteId} "${card.brandName}": subject held a placeholder; not written`);
      return false;
    }
  }
  // ── NO NAMED PERSON, NO CARD. THE ONE RULE, HERE, FOR EVERY PATH ──────────
  // The nightly fill, the on-demand fill, the admin button, the seed script:
  // everything that saves a card comes through this function, and this is
  // the only place the rule lives (services/outreachQueue.cardNameProblem).
  // A card whose contact is not a real person, or whose message does not
  // open "Hi <their first name>,", is not written, on any lane, whatever the
  // caller believed. No environment switch turns this off. Checked BEFORE the
  // email draft below, so a refused card leaves no draft behind either.
  {
    const problem = Q.cardNameProblem(card);
    if (problem) {
      console.log(`[queue] athlete=${athleteId} slot=${slot} "${card && card.brandName}" not written: ${problem}`);
      return false;
    }
  }
  // THE LAST GATE ON THE BUSINESS NAME. Every path that builds a card refuses
  // a placeholder before spending; this refuses one that somehow still
  // arrives, on any lane, so a card can never say "Local ... (independent)".
  {
    const store = require('../store');
    const ph = store.placeholderReason ? store.placeholderReason(card && card.brandName) : null;
    if (ph) {
      console.log(`[queue] athlete=${athleteId} slot=${slot} "${card && card.brandName}" not written: not a real business name (${ph})`);
      return false;
    }
  }
  // ONE IDENTITY, WRITTEN TO BOTH COLUMNS. outreach_queue.brand_key is NOT NULL,
  // and the market pool now honestly reports that it has no key -- so without
  // this the fix for the lie would simply move the lie into a constraint
  // violation. The identity key is a REAL key (place, domain, or normalised
  // name plus market), which is what brand_key was always supposed to hold and
  // what the display name never was. Downstream readers of brand_key --
  // draftPrewarm's one-draft-per-brand index among them -- get the improvement
  // for free.
  const identity = BI.keyOf(card.identity || card);

  // ── AN EMAIL CARD WRITES A DRAFT, NOT A SECOND SEND PATH ──────────────────
  //
  // outreach_logs already owns sending, and it owns all of it: sendGuard's daily
  // ceiling, the release queue's pacing, releaseDue, the follow-up
  // cadence, reply capture, bounce suppression, the media kit, and the editable
  // draft. Giving outreach_queue its own send would mean two state machines over
  // one business, which is how a brand gets pitched twice.
  //
  // So the card creates the draft and holds its id. The queue row is the slot and
  // the record of the night; the draft is the message that goes out.
  //
  // WRITTEN FIRST, DELIBERATELY. If the draft insert fails we have not yet
  // written a card claiming an address it cannot send to -- the athlete simply
  // gets no card for this business tonight, which is the same outcome as any
  // other failed step and is reported the same way.
  let logId = null;
  let linked = false;
  if (card.channel === 'email' && card.email) {
    // ── CREATE, OR LINK ───────────────────────────────────────────────────
    // idx_outreach_logs_draft_key is UNIQUE on (athlete_id, brand_key) WHERE
    // status='draft': one live draft per athlete per business, which is the
    // right rule and predates this. A Deal Scan may already have written one,
    // and an --undo of the backfill leaves a stopped draft still occupying that
    // slot. Inserting blindly hits the constraint; the answer is not to force a
    // second draft but to point the card at the one that exists.
    const existing = (await pool.query(
      `SELECT id, cadence_stopped_at, source, subject, body_html FROM outreach_logs
        WHERE athlete_id = $1 AND brand_key = $2 AND status = 'draft'
        LIMIT 1`, [athleteId, card.brandKey || identity]).catch(() => ({ rows: [] }))).rows[0];
    if (existing) {
      logId = existing.id;
      linked = true;
      // ── THE DRAFT WE LINK TO MUST GREET THE PERSON ON THIS CARD ───────────
      // Twelve cards reached agents saying "Hi," with a contact name on the
      // card: the card passed the gate above, and then linked to a prewarm
      // draft written before anyone was known (one greeted "Jill" on a card
      // naming LaRae Kraemer). The card's own pitch has just been checked, so
      // when the existing draft fails the same rule its subject and body are
      // replaced with the card's, and the link keeps the slot rule intact.
      const oldProblem = Q.cardNameProblem({ ...card, channel: 'email', emailBody: null, body_html: existing.body_html });
      if (oldProblem && card.emailBody) {
        await pool.query(
          `UPDATE outreach_logs SET subject = COALESCE($2, subject), body_html = $3, updated_at = NOW() WHERE id = $1`,
          [logId, card.subject || null, textToParagraphs(card.emailBody)]).catch((e) => console.error(`[queue] could not rewrite draft ${logId}: ${e.message}`));
        console.log(`[queue] athlete=${athleteId} "${card.brandName}" existing ${existing.source || 'draft'} ${logId} rewritten to the card's pitch: ${oldProblem}`);
      }
      // A draft stopped by an earlier undo or a lost slot race is revived when a
      // card claims it again -- otherwise the card would link to something Home
      // will never show.
      if (existing.cadence_stopped_at) {
        await pool.query(
          `UPDATE outreach_logs SET cadence_stopped_at = NULL, cadence_stop_reason = NULL,
              sent_to_email = COALESCE(NULLIF(sent_to_email,''), $2), updated_at = NOW()
            WHERE id = $1`, [logId, card.email]).catch(() => {});
      }
      // ── THE DRAFT SENDS TO THE CARD'S ADDRESS ───────────────────────────
      // The address on the card is the one the email finder verified tonight
      // for the person the card names. The draft it links to may have been
      // written earlier (a Deal Scan pre-warm) with a scraped or blank
      // address, and the draft is what sends: so a "verified" card went out
      // to an address nobody checked. The verified address wins on any
      // unsent, unapproved draft.
      if (card.emailVerified === true && card.email) {
        await pool.query(
          `UPDATE outreach_logs SET sent_to_email = $2, email_kind = $3, email_tier = $4, email_source_url = $5, updated_at = NOW()
            WHERE id = $1 AND status = 'draft' AND approved_at IS NULL AND sent_at IS NULL
              AND LOWER(COALESCE(sent_to_email, '')) IS DISTINCT FROM LOWER($2)`,
          [logId, String(card.email).trim().toLowerCase(), card.emailKind || null, card.emailTier || null, card.emailSourceUrl || null])
          .catch((e) => console.error(`[queue] could not readdress draft ${logId}: ${e.message}`));
      }
      console.log(`[queue] athlete=${athleteId} "${card.brandName}" linked to the existing draft ${logId}`);
    }
  }
  if (card.channel === 'email' && card.email && !linked) {
    logId = 'oq-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    try {
      await pool.query(
        `INSERT INTO outreach_logs
           (id, agent_id, athlete_id, brand_name, brand_key, subject, body_html, status, source,
            sent_to_email, email_kind, angle, angle_key, category_key, ask, email_tier, email_source_url, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'draft','nightly-queue',$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())`,
        [logId, agentId, athleteId, card.brandName, card.brandKey || identity,
          card.subject, textToParagraphs(card.emailBody),
          card.email, card.emailKind || null,
          card.angle || null, card.angleKey || null, card.categoryKey || null, card.ask || null,
          card.emailTier || null, card.emailSourceUrl || null]);
    } catch (e) {
      console.error(`[queue] athlete=${athleteId} "${card.brandName}" email draft failed: ${e.message}`);
      card._insertFault = 'email draft: ' + e.message;   // ours (services/ourFault)
      return false;
    }
  }

  const ins = await pool.query(
    `INSERT INTO outreach_queue
       (agent_id, athlete_id, slot, brand_key, brand_name, why, contact_name, contact_title,
        source_note, affiliation_scope, instagram, instagram_scope, phone, phone_ask_for,
        dm_text, channel, state, angle, angle_key, category_key, ask, lane, program_url,
        sponsor_signal, sponsor_note, identity_key, email, email_kind, outreach_log_id, email_note,
        business_category, thin, thin_note, email_tier, email_source_url, market_key,
        size_band, signing_evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'queued',$17,$18,$19,$20,
             $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37)
     ON CONFLICT DO NOTHING RETURNING id`,
    [agentId, athleteId, slot, card.brandKey || identity, card.brandName, card.why, card.contactName,
     card.contactTitle, card.sourceNote, card.affiliationScope, card.instagram,
     card.instagramScope, card.phone, card.phoneAskFor, card.dmText, card.channel,
     card.angle, card.angleKey, card.categoryKey, card.ask,
     // NOT `card.lane || 'local'`. A card whose lane was never determined is
     // recorded as unknown (NULL) rather than asserted to be local -- writing
     // 'local' here is how an unknown became a fact in the database, and every
     // reader downstream then believed it.
     card.lane || null, card.programUrl || null,
     card.sponsorSignal || null, card.sponsorNote || null,
     // The identity the unique index enforces. ON CONFLICT DO NOTHING already
     // covers the slot index, so a duplicate business now lands on
     // uq_outreach_queue_identity and returns no row -- the caller sees `false`
     // and reports it, exactly as it does for a taken slot.
     identity, card.email || null, card.emailKind || null, logId,
     // Why email was or was not offered, for the agent (services/emailValidation).
     card.emailNote ? String(card.emailNote).slice(0, 400) : null,
     // WHAT KIND OF BUSINESS, so a skip can be attributed to a category with no
     // second lookup, and THIN, so the card says it filled a slot nothing
     // stronger was left for instead of reading like any other find.
     card.businessCategory || null, card.thin === true,
     card.thin === true ? (card.thinNote || null) : null,
     // The address tier and the page it was stated on (services/emailTier).
     card.emailTier || null, card.emailSourceUrl || null,
     // The market the card was found in: the stagger matches a name within a
     // market, and learning reads replies by kind of business and market.
     card.marketKey || marketKey || null,
     // The brand's size band and the evidence it signs athletes like this one
     // (services/signingEvidence). A local card is 'local' with no evidence.
     card.sizeBand || (card.lane === 'local' ? 'local' : null),
     card.signingEvidence ? JSON.stringify(card.signingEvidence) : null]);
  const wrote = (ins.rowCount || 0) > 0;
  // THE DEAL MIX (MARKET_MIX_ON): the tier the card was placed for, the
  // brand's size, why this athlete fits this brand, and the brand seat a
  // backfilled local card fills.
  if (wrote && card.mixTier && ins.rows[0] && ins.rows[0].id) {
    await DM.ensureColumns(pool).catch(() => {});
    await pool.query(`UPDATE outreach_queue SET market_tier = $2, brand_size = $3, fit_reasons = $4, backfill_for = $5 WHERE id = $1`,
      [ins.rows[0].id, card.mixTier, card.brandSize || null, card.fitReasons ? JSON.stringify(card.fitReasons) : null,
        card.mixBackfill ? card.mixBackfill.seat : null])
      .catch((e) => console.error('[queue] mix fields not recorded: ' + e.message));
  }
  // VERIFIED BY THE EMAIL FINDER: a verified address for the named person.
  // What the five and the 5:30 list count (services/shortOfFive).
  if (wrote && (card.emailVerified === true || card.emailLabel) && ins.rows[0] && ins.rows[0].id) {
    await pool.query(`UPDATE outreach_queue SET email_verified = $2, email_label = $3 WHERE id = $1`,
      [ins.rows[0].id, card.emailVerified === true, card.emailLabel || null])
      .catch((e) => console.error('[queue] email_verified not recorded: ' + e.message));
  }
  if (!wrote) {
    console.log(`[queue] athlete=${athleteId} slot=${slot} "${card.brandName}" not written `
      + `(identity=${identity} already queued, or the slot was taken)`);
    // THE DRAFT GOES WITH IT. A card that lost the slot race must not leave an
    // orphaned draft behind: Home reads outreach_logs directly, so an orphan
    // would appear as an approvable email for a business this athlete is not
    // being shown. Cadence-stopped rather than deleted -- the row and its reason
    // survive, which is the same stance every other retirement in this codebase
    // takes.
    if (logId && !linked) {
      await pool.query(
        `UPDATE outreach_logs SET cadence_stopped_at = NOW(),
            cadence_stop_reason = 'the queue slot was taken before this card was written',
            updated_at = NOW()
          WHERE id = $1`, [logId]).catch((e) =>
        console.error('[queue] could not stop the orphaned draft ' + logId + ': ' + e.message));
    }
  }
  return wrote;
}

// ── THE SLOT, CHECKED AGAIN AFTER THE WRITER RETURNS ─────────────────────────
// The open slots were listed once, before the candidates were worked. A slot
// can be filled by someone else while the writer runs (the on-demand fill from
// the queue page, a resume-on-login fill, the same athlete on another
// worker), and then insertCard's unique index refused the row: Sonnet had
// written a pitch that went straight in the bin, and the run row counted a
// "tried" business that was never offered. So the slot is confirmed
// IMMEDIATELY before the insert, after the writer, at both write sites. A
// slot found taken here is recorded on the run row as "slot taken after
// write" (fillAthlete's slotTaken list) and is NOT a tried business.
async function slotStillOpen(pool, athleteId, slot) {
  const r = await pool.query(
    `SELECT 1 FROM outreach_queue WHERE athlete_id = $1 AND slot = $2 AND state = 'queued' LIMIT 1`,
    [athleteId, slot]);
  return (r.rowCount || 0) === 0;
}
const SLOT_TAKEN_REASON = 'slot taken after write';

// Plain text to the paragraph HTML outreach_logs stores. Same shape the draft
// writer produces, so a nightly draft and a Deal Scan draft render identically
// and the editable-draft round trip (body_html -> text -> body_html) is stable.
function textToParagraphs(text) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(text || '').split(/\n\s*\n+/)
    .map((p) => p.trim()).filter(Boolean)
    .map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>')
    .join('');
}

// ── THE RULE, APPLIED ONCE FOR EVERY WAY A NIGHT CAN END (services/ourFault) ─
// A failure on our side is never recorded as a fact about their market, is
// never cached, and never counts toward a pause. The body below collects each
// of our failures in nightFaults (faultOf) instead of writing it down as a
// rejection, an exhausted market or a missing name. This wrapper then decides,
// for EVERY return path at once:
//   - faults counts them, and recordAttempt refuses to count the night toward
//     the pause if there is even one;
//   - a night that filled nothing and had any fault gets emptyReason 'our-fault'
//     and a note that names our failure, never "worked out" or "below the bar";
//   - nightFaults goes on the run row with the service and the provider's words.
const KEEP_REASON = new Set([Scout.EMPTY.PAUSED, Scout.EMPTY.SLOTS_FULL, Scout.EMPTY.CAPPED]);
function applyFaultRule(r, nightFaults) {
  if (!r) return r;
  const tried = Array.isArray(r.tried) ? r.tried : [];
  const perBusiness = tried.filter((t) => t && t.fault);
  const faults = perBusiness.length + (nightFaults ? nightFaults.length : 0);
  if (!faults) return r;
  const out = { ...r, nightFaults: nightFaults || [], faults };
  if (!(r.filled > 0) && !KEEP_REASON.has(r.emptyReason)) {
    const f = (nightFaults && nightFaults[0])
      || { service: 'lookup', reason: perBusiness[0].reason || 'a lookup failed on our side' };
    out.emptyReason = Scout.EMPTY.FAULT;
    out.note = `nothing tonight because of our failure, not this market: ${f.service}: ${f.reason}`
      + (faults > 1 ? ` (+${faults - 1} more)` : '')
      + (tried.length ? `; ${tried.length} business${tried.length > 1 ? 'es' : ''} tried` : '');
  }
  return out;
}
async function fillAthlete(pool, ctx) {
  const nightFaults = [];
  return applyFaultRule(await _fillAthlete(pool, ctx, nightFaults), nightFaults);
}

async function _fillAthlete(pool, ctx, nightFaults) {
  const { agentId, athleteId, athleteName, budget, region } = ctx;
  ctx._evidenceBar = await require('../services/signingEvidence').barOn(pool);
  // ── WHICH SCHOOL IS THIS? ─────────────────────────────────────────────────
  // A school name that is more than one real school ("Miami") gets no cards at
  // all until the agent picks on Home: a card for the wrong school's town is
  // worse than no card. Nothing is spent.
  {
    const _sch = ctx.athleteRow && ctx.athleteRow.school;
    const _amb = _sch ? require('../services/schoolResolver').ambiguity(_sch, { state: ctx.athleteRow.state }) : null;
    // ...unless the market it already resolved to is producing for them
    // (services/schoolKeep): those keep running.
    if (_amb && _amb.candidates && !require('../services/schoolKeep').keepFor(athleteId)) {
      return { filled: 0, open: 0, tried: [], ambiguousSchool: _amb.candidates,
        note: `"${_sch}" is more than one school (${_amb.candidates.map((c) => c.name).join(', ')}); no cards until the agent picks which on Home` };
    }
  }
  const OF = require('../services/ourFault');
  // One of OUR failures tonight: recorded as a fault, never as a market fact.
  const faultOf = (service, reason, where) => {
    const why = String(reason || 'unknown').slice(0, 300);
    if (!nightFaults.some((f) => f.service === service && f.reason === why)) nightFaults.push({ service, reason: why, where: where || null });
    OF.record(service, why, (where || 'fill') + ' athlete=' + athleteId);
    (ctx.onProgress || (() => {}))(`${athleteName}: OUR FAILURE (${service}): ${why}`);
  };
  // Passed down from the run so it is read once for the whole roster rather than
  // once per business. `has` is what the writer needs; the block itself is
  // appended after the model, never written by it.
  const signature = ctx.signature || { has: false, hasLink: false, text: '', url: '' };
  const say = ctx.onProgress || (() => {});
  const dry = !!ctx.dryRun;
  // Every business actually tried, with the real reason it was or was not
  // queued. This is the answer to "which businesses and why" -- built once,
  // here, rather than reconstructed later from a log line nobody kept.
  const tried = [];
  // Businesses whose pitch was written and then found no slot to land in
  // (see slotStillOpen). Kept apart from `tried` on purpose: the run row shows
  // them, spend-breakdown counts the writer call, and nothing treats them as
  // a business that was offered and failed.
  const slotTaken = [];
  const loseSlot = (brand, slot, lane, pitchObj) => {
    // The 'queued' entry for this business was pushed before the insert; it
    // is withdrawn so the business is not counted as tried.
    for (let i = tried.length - 1; i >= 0; i--) {
      if (tried[i] && tried[i].brand === brand && tried[i].result === 'queued') { tried.splice(i, 1); break; }
    }
    slotTaken.push({ brand, slot, lane: lane || null, reason: SLOT_TAKEN_REASON,
      writerRetried: !!(pitchObj && pitchObj.retried), at: new Date().toISOString() });
  };
  // What each lookup really cost, so the run can report a measured per-athlete
  // figure instead of a ceiling multiplied by a count.
  const spendLog = [];
  // ── THE CEILINGS (Q.ATHLETE_TIME_CEILING_MS, Q.ATHLETE_COST_CEILING_USD) ──
  // Measured from here. The cost is every lookup and scan booked to this
  // athlete in spendLog, except a market refresh, which is the market's and is
  // shared by every athlete in it.
  const _t0 = Date.now();
  // Overridable per call (an on-demand fill, a test); the job's defaults otherwise.
  // 15 minutes under EMAIL_FIVE_ON (Q.FIVE_TIME_CEILING_MS): a verified named
  // address takes a mailbox check, and athletes now run side by side. The
  // $2.50 cost ceiling is unchanged.
  const TIME_CEILING_MS = Number(ctx.timeCeilingMs) > 0 ? Number(ctx.timeCeilingMs) : (FINDER.five() ? Q.FIVE_TIME_CEILING_MS : Q.ATHLETE_TIME_CEILING_MS);
  const COST_CEILING_USD = Number(ctx.costCeilingUsd) > 0 ? Number(ctx.costCeilingUsd) : Q.ATHLETE_COST_CEILING_USD;
  const athleteCost = () => spendLog.reduce((sum, x) => sum + (x && x.lane !== 'market-refresh' ? (Number(x.cost) || 0) : 0), 0);

  // NO NAMES, NO CARDS -- the sender's or the athlete's. The run and the
  // on-demand fill already refuse a nameless agent before calling this; this
  // is the backstop for any other caller, and it spends nothing.
  if (!AgentName.firstNameOrNull(ctx.agentFirstName)) {
    return { filled: 0, open: 0, tried, note: AgentName.NO_AGENT_NAME_REASON, noAgentName: true };
  }
  if (!String(athleteName || '').trim()) {
    return { filled: 0, open: 0, tried, note: 'this athlete has no name on file, so no pitch can be written for them' };
  }

  // PAUSED ATHLETES COST NOTHING. Checked before the slot query, before the
  // candidate query, and long before any lookup -- the whole point is that a
  // repeatedly-failing athlete stops consuming budget entirely.
  // ── WHAT WE MAY CLAIM ABOUT THIS ATHLETE'S PARTNERSHIPS ──────────────────
  // "already has several NIL partnerships and is looking to expand" is a claim
  // about a real athlete made to a real business, so it is grounded in deals we
  // actually hold rather than asserted because it reads well. Read once per
  // athlete, not once per candidate. A failure here means we claim nothing,
  // which is the safe direction.
  let partnershipCount = 0;
  try {
    // ── athlete_self_deals ONLY ──────────────────────────────────────────
    // This also counted athlete_deal_pipeline, which is the LEGACY table: a
    // guarded migration folded it into athlete_self_deals and the comment on
    // /api/athlete/deals/from-scan calls self_deals the single source of truth.
    // Counting both meant reading a table that has been migrated away from --
    // near-empty, contributing nothing, and one more place to keep in step.
    //
    // Counted by STAGE, not by row: a Prospecting row is a brand we intend to
    // pitch, not a partnership. "Already has several NIL partnerships" is a
    // claim made to a real business, so only a deal that actually closed counts.
    const pc = await pool.query(
      `SELECT COUNT(*)::int AS n FROM athlete_self_deals
        WHERE athlete_id = $1 AND stage = ANY($2::text[])`,
      [athleteId, ['Closed', 'Closing']]);
    partnershipCount = Number(pc.rows[0] && pc.rows[0].n) || 0;
  } catch (e) {
    console.warn(`[queue] ${athleteName}: could not count partnerships (${e.message}); `
      + 'the pitch will not claim any');
    partnershipCount = 0;
  }

  const state = await athleteState(pool, athleteId);
  if (state && state.paused_at) {
    // ── A PAUSE IS A "NOT NOW", NEVER A VERDICT ────────────────────────────
    // Markets are not fixed objects: businesses open, a scan widens the radius,
    // the social index grows -- and sometimes the only thing that was broken was
    // us. This used to return unconditionally, and since nothing else in the
    // codebase cleared paused_at, that return was the end of the athlete.
    const rel = Q.pauseRelease(state);
    if (rel.retry) {
      await releasePause(pool, athleteId,
        rel.unreadable ? 'auto:unreadable-timestamp' : `auto:${rel.days}d`);
      say(`${athleteName}: paused ${rel.days} day${rel.days === 1 ? '' : 's'} ago — `
        + 'trying again tonight');
      // Deliberately NOT returning. The whole point is that the night proceeds.
    } else {
      const note = (state.paused_reason || Q.pausedNote(state.consecutive_failures))
        + ' (' + Q.pausedUntilNote(rel) + ')';
      say(`${athleteName}: ${note}`);
      return { filled: 0, open: 0, tried, note, paused: true,
        emptyReason: Scout.EMPTY.PAUSED,
        pausedAt: state.paused_at, pausedDays: rel.days, nextRetryAt: rel.nextRetryAt };
    }
  }

  // NO MARKET SILENCES THE LOCAL LANE, NOT THE ATHLETE. An athlete whose school
  // did not resolve used to fall back to their HOMETOWN and get businesses in a
  // town they do not live in. There is no fallback now.
  //
  // But this binds the LOCAL lane ONLY. Social, DTC and national brands ship
  // product and do not care where the athlete lives, so an unresolved school
  // must not blank the whole night -- it used to return here before the Scout
  // ever ran, which is one of the ways an athlete woke up to nothing. The Scout
  // suppresses the local lane on its own when hasLocalMarket is false; we just
  // carry the reason through so an empty result can still say why.
  if (ctx.regionFault) faultOf('google-places', ctx.regionFault, 'school location');
  const noMarket = !String(region || '').trim();
  const noMarketNote = noMarket
    ? ((ctx.athleteProfile && ctx.athleteProfile.localLaneNote)
       || 'no school we could match, so the local lane has no town to work in')
    : null;
  if (noMarket) say(`${athleteName}: ${noMarketNote} — social and national only`);

  // The same read answers two questions, so it asks both at once: which slots are
  // free, and how many program applications this athlete is ALREADY holding. The
  // second is what caps the lane -- see PROGRAM_SLOT_CAP. Counting only what this
  // run places would let five consecutive nights build five forms.
  // BEFORE THE SLOTS ARE COUNTED. Expiring after would free space tonight's run
  // could not use, and the agent would wait another day for a queue that was
  // already empty.
  // keepStale: the fill that runs the moment a dormant agent signs back in.
  // Their cards were preserved through the weeks they were away; expiring them
  // in the same second they return would hand them an empty page.
  if (!ctx.keepStale) {
    try { await expireStaleCards(pool, { agentId }); }
    catch (e) {
      faultOf(e.service || 'database', e.reason || e.message, 'expireStaleCards');
      return { filled: 0, open: 0, tried, note: null, emptyReason: Scout.EMPTY.FAULT };
    }
  }

  const heldRows = (await pool.query(HELD_SQL, [athleteId])).rows;
  const heldPrograms = heldRows.filter((r) => r && r.channel === 'program').length;
  let programsPlaced = 0;
  // ── HOW MANY PROGRAM CARDS EACH BRAND ALREADY HAS TONIGHT ────────────────
  // Shared across the whole roster, so the same brand cannot be every athlete's
  // program card. fillAgent builds and passes one Map for the run; the on-demand
  // path has no run to share, so it reads the same answer from the database.
  const programBrandTally = ctx.programBrandTally
    || await loadProgramBrandTally(pool, agentId);
  let open = openSlotsFor(heldRows);
  // ── THE DEAL MIX: THE TIER, AND THE SEATS EACH LANE STILL HAS ────────────
  // A program card on an official application page holds a slot beside a
  // verified email (DM.holdsUnderMix); each lane's held cards come off its
  // seats. The score is the stored one when under a week old, else computed
  // now from the record (no news search: that is the weekly job's). A dry run
  // hands its own (ctx.marketScore).
  let _mix = null;
  if (DM.ON()) {
    const mixRows = (await pool.query(HELD_MIX_SQL, [athleteId])).rows;
    open = Q.slotsToFill(mixRows, { holds: (r) => DM.holdsUnderMix(r, { five: FINDER.five() }) });
    let ms = ctx.marketScore || null;
    if (!ms) {
      try { ms = await MS.forAthlete(pool, athleteId, { save: !dry }); }
      catch (e) { faultOf('database', 'market score: ' + e.message, 'market score'); ms = null; }
    }
    const tier = (ms && ms.tier) || 'local_star';
    const held = DM.heldByLane(mixRows, { five: FINDER.five() });
    _mix = { tier, score: ms ? ms.score : null, confidence: ms ? ms.confidence : null, held,
      quota: DM.remaining(tier, held), placed: { local: 0, social: 0, national: 0 }, unscored: !ms,
      // THE BACKFILL (see backfillMix): a social or national seat nobody
      // passed the bar for, moved to the local lane at the end of the pass.
      backfill: { done: false, seats: 0, placed: 0, from: [], entries: [] } };
    _mix.seats = { ..._mix.quota };
    const _seats = _mix.quota.local + _mix.quota.social + _mix.quota.national;
    if (open.length > _seats) open = open.slice(0, _seats);
    say(`${athleteName}: Market Score ${ms ? ms.score : 'not computed (treated as Local Star)'}; ${DM.describe(tier, _mix.quota)}`);
  }
  // Seats each lane can still take tonight. A backfilled brand seat is a
  // local seat.
  const mixSeats = () => (_mix ? { local: _mix.quota.local - _mix.placed.local + (_mix.backfill.seats - _mix.backfill.placed),
    social: _mix.quota.social - _mix.placed.social, national: _mix.quota.national - _mix.placed.national } : null);
  // The next local card fills a backfilled brand seat (the tier's own local
  // seats are all placed).
  const mixBackfillNext = () => !!_mix && (_mix.quota.local - _mix.placed.local) <= 0 && (_mix.backfill.seats - _mix.backfill.placed) > 0;
  // Local businesses passed over only because the local seats were full:
  // first in line if a brand seat is backfilled.
  const _mixHeldLocal = [];
  // A local card placed: one of the tier's local seats, or a backfilled one.
  const mixPlacedLocal = (card, slot) => {
    if (!card.mixBackfill) { _mix.placed.local++; return; }
    _mix.backfill.placed++;
    _mix.backfill.entries.push({ seat: card.mixBackfill.seat, why: card.mixBackfill.why, slot, brand: card.brandName,
      contact: card.contactName || null, email: card.email || null });
  };
  if (!open.length) {
    // Says the real number. It said "three" while SLOTS_PER_ATHLETE was five,
    // which made a full athlete look like a bug in the slot count.
    const msg = FINDER.five()
      ? `all ${Q.SLOTS_PER_ATHLETE} slots already hold verified emails you have not actioned`
      : `all ${Q.SLOTS_PER_ATHLETE} slots already hold work you have not actioned`;
    say(`${athleteName}: ${msg}`);
    return { filled: 0, open: 0, tried, note: msg, emptyReason: Scout.EMPTY.SLOTS_FULL };
  }
  // The night guarantees ONE fresh card so the page is never empty; slots 2-3
  // are built on demand when the agent actually opens this athlete's queue.
  // maxSlots is what makes the same filler serve both callers.
  if (ctx.maxSlots && open.length > ctx.maxSlots) open = open.slice(0, ctx.maxSlots);
  say(`${athleteName}: ${open.length} slot${open.length > 1 ? 's' : ''} to fill`);

  // ── THE SLATE, ACROSS ALL THREE LANES ────────────────────────────────────
  // Was: candidatesFor(), which read ONLY brands a Deal Scan had already shown
  // for this athlete, local only. With no recent scan there were no candidates
  // at all -- which is how eight athletes produced three pitches. The slate now
  // draws from the local market pool (including businesses the scan discovered
  // and passed over), the social index and the national comps AT ONCE, ranked
  // together, with a boost for brands that have done a deal at this athlete's
  // school. The lane is a property of a result, not a separate run.
  const profile = ctx.athleteProfile || { id: athleteId, hasLocalMarket: !!region, school: null };
  // THE PRO LANE (services/proLane): marketing director before owner, and the
  // writer's pro rules. Read from the record's athleteType; a college athlete
  // is unchanged.
  const PL = require('../services/proLane');
  const proLane = PL.isPro(profile) || PL.isPro(ctx.athleteRow || {});
  // A SAME-NIGHT RETRY (fillAgent): the businesses whose mailbox check could
  // not run earlier tonight are the whole slate, and nothing new is drawn.
  const _retrying = Array.isArray(ctx.retryCands) && ctx.retryCands.length > 0;
  let slate = _retrying ? { picks: ctx.retryCands.slice(), laneCounts: { retry: ctx.retryCands.length }, faults: [] } : await Scout.assembleSlate(pool, {
    agentId, athlete: profile, store,
    // FIVE VERIFIED EMAILS: only the local lane can produce one -- unless the
    // deal mix is on, which reaches brands by their program page or a named
    // contact's verified address.
    localOnly: FINDER.five() && !_mix,
    mix: _mix ? { tier: _mix.tier, seats: mixSeats() } : null,
    limit: Math.max(open.length, 1) * Q.MAX_ATTEMPTS_PER_SLOT,
    // The program cap is known before the slate is built. Passing it lets the
    // Scout drop program-only brands that cannot become a card tonight, instead
    // of handing them the athlete's attempts and rejecting them one by one.
    heldPrograms, programCap: Q.PROGRAM_SLOT_CAP,
  });
  for (const f of (slate.faults || [])) faultOf(f.service, f.reason, 'slate');

  // ── REFILL, RATHER THAN GO QUIET ─────────────────────────────────────────
  // The fill no longer stops when the slate is drained. When it needs more
  // candidates it asks here, and this answers in three escalating ways, each
  // only if the one before it produced nothing new for THIS athlete:
  //
  //   1. RE-DRAW. Ask the Scout for a fresh slate, minus anything already
  //      tried tonight. Free. Most nights this is all that is needed once the
  //      pool holds the whole market rather than the page an agent was shown.
  //   2. REFILL FROM THE MARKET. Run the ordinary local scan for this market,
  //      once per market per night, shared across every athlete in that town.
  //      A market scanned in the last 90 days is a cache hit -- it costs the
  //      page scoring, about a cent -- and records the full pool under the key
  //      the Scout reads. A cold market builds from Places and the web passes.
  //   3. WIDEN. The deeper pass into neighbouring towns, gated per athlete per
  //      market (see marketDeepen), once per athlete per night here.
  //
  // 2 and 3 are DISCOVERY and come out of the discovery pot, metered
  // (scanMeter, priced by Q.priceOf, Places included), never the athlete's share
  // and never the lookup cap. The widen used to call getDealRecommendations
  // unmetered -- the most expensive thing in the night, and the cap never saw it.
  //
  // Nothing here writes to `cands` directly: it returns what is new, and the
  // caller appends. `cands` is declared after this closure.
  const athObj = { id: athleteId, ...(ctx.athleteRow || {}) };
  const refilledMarkets = ctx.refilledMarkets || new Set();   // one refill per market per run
  const _refillFaultsLocal = new Map();                        // market -> why its refill failed tonight
  const knownBrands = new Set();                              // every candidate ever handed out tonight
  let widenedTonight = false;
  // THE LADDER (Q.LADDER): which rungs fired tonight, in order. The first is
  // always the athlete's own market at the normal radius.
  const rungsFired = ['local'];
  const fire = (r) => { if (!rungsFired.includes(r)) { rungsFired.push(r); say(`${athleteName}: ladder rung (${r})`); } };
  const slateLimit = Math.max(open.length, 1) * Q.MAX_ATTEMPTS_PER_SLOT;
  const bk = (name) => String(name || '').trim().toLowerCase();

  async function redraw() {
    if (_retrying) return { fresh: slate, added: [] };
    const fresh = await Scout.assembleSlate(pool, {
      agentId, athlete: profile, store, limit: slateLimit * 2, localOnly: FINDER.five() && !_mix,
      mix: _mix ? { tier: _mix.tier, seats: mixSeats() } : null,
      heldPrograms, programCap: Q.PROGRAM_SLOT_CAP,
      // Everything handed out tonight, so the read moves on to rows not yet
      // seen instead of returning the same top of the pool every time.
      exclude: [...knownBrands],
    });
    for (const f of (fresh.faults || [])) faultOf(f.service, f.reason, 'slate redraw');
    const added = (fresh.picks || []).filter((c) => c && !knownBrands.has(bk(c.brand_name)));
    for (const c of added) knownBrands.add(bk(c.brand_name));
    return { fresh, added };
  }

  // Runs one scan under the meter and books it to discovery. Returns the
  // recommendations (or []), or null when the pot could not afford it.
  async function discover(label, estimateUsd, opts) {
    // The widen draws on its own per-athlete allowance, not the share (see
    // Q.newBudget): the share is too small for it on any roster over eight.
    const widen = !!(opts && opts.deepen);
    if (widen ? (typeof budget.canSpendWiden === 'function' ? !budget.canSpendWiden(estimateUsd) : !budget.canSpendDiscovery(estimateUsd))
      : !budget.canSpendDiscovery(estimateUsd)) {
      const why = widen && typeof budget.widenCap === 'function'
        ? `the night's widen allowance is spent ($${budget.widenSpent().toFixed(2)} of $${budget.widenCap().toFixed(2)})`
        : (typeof budget.discoveryRefusal === 'function' ? budget.discoveryRefusal(estimateUsd)
          : `the discovery pot is spent ($${budget.discoverySpent().toFixed(2)} of $${budget.discoveryCap().toFixed(2)})`);
      say(`${athleteName}: not ${label} — ${why}`);
      return null;
    }
    // THE LOOP STOP. However many times this athlete's fill is entered tonight
    // (the nightly run, a resume, an on-demand fill), each discovery scan runs
    // at most MAX_DISCOVERY_PER_ATHLETE_NIGHT times for them. Counted in the
    // database, not in this closure, so a second process cannot restart it.
    const claim = await Claims.claimDiscovery(pool, athleteId, label, ctx.runDate || today());
    if (!claim.ok) {
      say(`${athleteName}: not ${label} — already ran ${claim.n - 1} time(s) for them tonight (cap ${Claims.MAX_DISCOVERY_PER_ATHLETE_NIGHT})`);
      return null;
    }
    const scanMeter = require('../scanMeter');
    let result = null, meter = null;
    try {
      ({ result, meter } = await scanMeter.run(() =>
        scanMeter.label({ site: 'discovery', agentId, athleteId, brand: '[' + label + ']' },
          () => ai.getDealRecommendations(athObj, 'agent', [], 'local', opts))));
    } catch (e) {
      // A scan that threw did not find the market empty (services/ourFault).
      faultOf(e.service || 'discovery', e.message, label);
      await Claims.releaseDiscovery(pool, athleteId, label, ctx.runDate || today());
      return null;
    }
    const cost = Q.priceOf(meter);
    if (cost > 0) {
      if (widen && typeof budget.spendWiden === 'function') budget.spendWiden(cost);
      else budget.spendDiscovery(cost);
    }
    spendLog.push({ brand: `[${label}]`, lane: 'discovery', cost,
      webSearches: meter.webSearches, aiCalls: meter.aiCalls, placesCalls: meter.placesCalls });
    say(`${athleteName}: ${label} cost $${cost.toFixed(3)} `
      + `(${meter.webSearches} searches, ${meter.placesCalls} Places, ${meter.aiCalls} model calls)`);
    // Every search pass failing comes back as an empty tagged _fault: ours, so
    // it is a fault and the claim is handed back, never "the pool is drawn".
    if (result && result._fault) {
      faultOf('discovery', result._fault, label);
      await Claims.releaseDiscovery(pool, athleteId, label, ctx.runDate || today());
      return null;
    }
    return Array.isArray(result) ? result : [];
  }

  // The refill. Returns the candidates that are NEW tonight (possibly none),
  // and updates `slate` so the up-front caller and the notes see the latest.
  async function localRefill(why, opts = {}) {
    // 1. Re-draw -- unless the rate floor sent us here, in which case this
    //    rung is not producing and the next one is tried directly.
    let fresh, added = [];
    if (!opts.skipRedraw) {
      ({ fresh, added } = await redraw());
      slate = fresh;
      if (added.length) { say(`${athleteName}: re-drew ${added.length} new candidate(s) (${why})`); return added; }
    }

    // 2. Refill from the market -- once per market per run.
    const refillFaults = ctx.refillFaults || _refillFaultsLocal;
    if (profile.hasLocalMarket && profile.marketKey && refillFaults.has(profile.marketKey)) {
      // This market's refill failed on our side earlier tonight. Not retried
      // for every athlete, but not silent either: it is a fault for this night.
      faultOf('discovery', `market refill for ${profile.marketKey} failed earlier tonight: ${refillFaults.get(profile.marketKey)}`, 'market refill');
    } else if (profile.hasLocalMarket && profile.marketKey && !refilledMarkets.has(profile.marketKey) && !ctx.noWiden) {
      refilledMarkets.add(profile.marketKey);
      fire('local-wide');
      say(`${athleteName}: slate drained (${why}) — refilling the ${profile.marketKey} pool from the market scan`);
      const _nf = nightFaults.length;
      const got = await discover('market refill', 0.05, {});
      if (nightFaults.length > _nf) refillFaults.set(profile.marketKey, nightFaults[nightFaults.length - 1].reason);
      if (got) {
        ({ fresh, added } = await redraw());
        slate = fresh;
        if (added.length) { say(`${athleteName}: refill produced ${added.length} new candidate(s)`); return added; }
      }
    }

    // 3. Widen -- once per athlete per night, gated per athlete per market.
    if (profile.hasLocalMarket && !widenedTonight && !ctx.noWiden) {
      widenedTonight = true;
      fire('local-wide');
      // The widen ledger is keyed on the school; a pro has none, so their
      // market (the city they play in) is the key instead.
      const widenKey = profile.school || profile.market;
      const gate = await Deepen.canDeepen(pool, widenKey, { athleteId });
      if (!gate.ok) {
        say(`${athleteName}: local pool is spent — not widening (${gate.reason})`);
      } else if (await Deepen.claimDeepen(pool, widenKey, { athleteId, source: 'nightly', throwOnError: true })
        .catch((e) => { faultOf(e.service || 'database', e.reason || e.message, 'widen claim'); return false; })) {
        say(`${athleteName}: local pool is spent — widening the search to neighbouring towns`);
        try {
          const _nf = nightFaults.length;
          const widened = await discover('widen', 0.25, { deepen: true });
          if (nightFaults.length > _nf) {
            // The widen never ran: give it back so the next night can use it.
            await Deepen.releaseDeepen(pool, widenKey, { athleteId });
            return [];
          }
          const brands = (widened || []).map((o) => o && o.brand).filter(Boolean);
          if (profile.marketKey && brands.length) {
            await store.markMarketNewcomers(profile.marketKey, brands)
              .then(() => say(`${athleteName}: recorded ${brands.length} widened business(es) in the ${profile.marketKey} pool`))
              .catch((e) => say(`${athleteName}: could not record the widened pool (${e.message})`));
          } else if (!profile.marketKey) {
            say(`${athleteName}: widened but has no market key, so nothing could be recorded`);
          }
          ({ fresh, added } = await redraw());
          slate = fresh;
          say(`${athleteName}: after widening, ${added.length} new candidate(s) — `
            + Object.keys(slate.laneCounts || {}).map((k) => `${slate.laneCounts[k]} ${k}`).join(', '));
          if (added.length) return added;
        } catch (e) {
          faultOf('discovery', 'widening failed: ' + e.message, 'widen');
        }
      }
    }
    return [];
  }

  const fresh = (list) => {
    const out = [];
    for (const c of (list || [])) {
      if (!c || !c.brand_name || knownBrands.has(bk(c.brand_name))) continue;
      knownBrands.add(bk(c.brand_name)); out.push(c);
    }
    return out;
  };

  // RUNG 3: A FRESH PLACES BUILD OF THIS MARKET, at the next ring out. Once per
  // market per run (shared by every athlete in it), only when the scheduled
  // build (services/marketPools) has not built it in the last few days, and
  // within the run's allowance of refreshes.
  async function placesRefresh() {
    if (!profile.hasLocalMarket || !profile.marketKey || ctx.noWiden) return [];
    const MP = require('../services/marketPools');
    if (!MP.enabled()) return [];
    const done = ctx.placesRefreshed || (ctx.placesRefreshed = new Set());
    const maxRuns = parseInt(process.env.OUTREACH_PLACES_REFRESH_MAX_PER_RUN, 10) || 5;
    if (!done.has(profile.marketKey) && done.size >= maxRuns) {
      say(`${athleteName}: no Places refresh, tonight's allowance of ${maxRuns} is used`);
    } else if (!done.has(profile.marketKey)) {
      // Claimed BEFORE any await: agents run in parallel, and two athletes in
      // one market must not both start a build.
      done.add(profile.marketKey);
      const minDays = parseInt(process.env.OUTREACH_PLACES_REFRESH_MIN_DAYS, 10) || 3;
      let sched = null;
      try {
        await MP.ensureTables(pool);
        sched = (await pool.query(`SELECT last_built_at, last_ok, radius_m FROM market_pool_schedule WHERE market_key = $1`, [profile.marketKey])).rows[0] || null;
      } catch (e) { faultOf('database', 'market schedule read: ' + e.message, 'places refresh'); return []; }
      const ageDays = sched && sched.last_built_at ? (Date.now() - new Date(sched.last_built_at).getTime()) / 86400000 : Infinity;
      if (ageDays < minDays && sched && sched.last_ok) say(`${athleteName}: no Places refresh, the market was built ${ageDays.toFixed(1)} day(s) ago`);
      else {
        const ring = sched && sched.last_ok && sched.radius_m ? (MP.RADII.find((r) => r > sched.radius_m) || sched.radius_m) : MP.RADII[0];
        say(`${athleteName}: refreshing the ${profile.marketKey} pool from Places at ${Math.round(ring / 1000)} km`);
        const b = await MP.buildMarket(pool, { key: profile.marketKey, query: profile.school || profile.market, region: profile.market,
          usable: 0, startRadius: ring }).catch((e) => ({ ok: false, reason: e.message, calls: 0, usable: 0 }));
        const cost = Math.round((b.calls || 0) * Q.USD_PER_PLACES_REQUEST * 1000) / 1000;
        spendLog.push({ brand: '[places refresh]', lane: 'market-refresh', cost, placesCalls: b.calls || 0 });
        if (!b.ok) faultOf('google-places', `Places refresh of ${profile.marketKey} failed: ${b.reason}`, 'places refresh');
        else say(`${athleteName}: Places refresh: ${b.usable} usable business(es) in ${profile.marketKey}, ${b.calls} request(s)`);
      }
    }
    const { added } = await redraw();
    return added;
  }

  // RUNGS 4 AND 5: deeper into the social/DTC index (matched to the athlete's
  // reach by the index itself) and the national brands with disclosed deals.
  async function laneRung(lane) {
    const fn = lane === 'social' ? Scout.socialCandidates : Scout.nationalCandidates;
    let rows = [];
    try { rows = await fn(pool, { athlete: profile, limit: slateLimit * 3, store }); }
    catch (e) { faultOf('database', `${lane} rung: ${e.message}`, lane + ' rung'); return []; }
    if (rows && rows.fault) faultOf('database', rows.fault, lane + ' rung');
    // THE SAME BAR AS THE SLATE (services/signingEvidence): incumbents never,
    // and with the evidence flag on, no evidence no card. A rung emptied by it
    // is simply an empty rung: the ladder climbs on to local-wide, Places and
    // the hometown, so the athlete still reaches five from local.
    if (Array.isArray(rows) && rows.length) {
      const SE = require('../services/signingEvidence');
      const f = await SE.filterAndRank(pool, rows, profile);
      if (f.refused.length) {
        say(`${athleteName}: ${lane} rung refused ${f.refused.length}: ` + f.refused.slice(0, 4).map((r) => r.brand).join(', '));
        for (const r of f.refused) tried.push({ brand: r.brand, lane, result: 'rejected', reason: r.why, evidenceBar: true });
      }
      rows = f.kept;
    }
    return fresh(rows);
  }

  // RUNG 6: THE HOMETOWN. The athlete's hometown market, built from Places if
  // it has no pool. Every card from here says so (cand.hometown), and every
  // lookup is located in that town, not the school's.
  async function hometownRung() {
    const home = profile.hometown || (ctx.athleteRow && ctx.athleteRow.hometown) || null;
    if (!home) return [];
    const hk = canonicalRegionOf(home);
    if (!hk || hk === profile.marketKey) return [];
    const homeProfile = { ...profile, market: home, marketKey: hk, hasLocalMarket: true };
    const draw = async () => {
      const sl = await Scout.assembleSlate(pool, { agentId, athlete: homeProfile, store, limit: slateLimit * 2, heldPrograms, programCap: Q.PROGRAM_SLOT_CAP, exclude: [...knownBrands] });
      return fresh((sl.picks || []).filter((c) => c.lane === 'local'));
    };
    let got = await draw();
    const MP = require('../services/marketPools');
    const done = ctx.placesRefreshed || (ctx.placesRefreshed = new Set());
    const maxRuns = parseInt(process.env.OUTREACH_PLACES_REFRESH_MAX_PER_RUN, 10) || 5;
    if (!got.length && MP.enabled() && !done.has(hk) && done.size < maxRuns) {
      done.add(hk);
      say(`${athleteName}: building the hometown pool (${home}) from Places`);
      await MP.ensureTables(pool).catch(() => {});
      const b = await MP.buildMarket(pool, { key: hk, query: home, region: home, usable: 0, startRadius: MP.RADII[0] })
        .catch((e) => ({ ok: false, reason: e.message, calls: 0 }));
      spendLog.push({ brand: '[hometown build]', lane: 'market-refresh', cost: Math.round((b.calls || 0) * Q.USD_PER_PLACES_REQUEST * 1000) / 1000, placesCalls: b.calls || 0 });
      if (!b.ok) faultOf('google-places', `hometown build for ${home} failed: ${b.reason}`, 'hometown rung');
      got = await draw();
    }
    return got.map((c) => ({ ...c, region: home, hometown: home }));
  }

  // ── THE LADDER ───────────────────────────────────────────────────────────
  // Every call returns the next batch of NEW candidates, from the lowest rung
  // that still has any. The bar is the same on every rung.
  let rung = 0;
  // The free re-draw of the athlete's own pool (which skips everything handed
  // out tonight) always comes first; a rung is climbed only when that is
  // empty. A rung that has run is not run again tonight.
  // ── WHERE A CANDIDATE'S TIME GOES ─────────────────────────────────────────
  // A per-candidate stopwatch: each stage's seconds (places, contacts, email
  // check, instagram, owner search, writer) on that candidate's entry in
  // `tried` (entry.ms), so "44 seconds a candidate" can be read by stage from
  // the run row. The entry holds the stopwatch's own object, so a stage that
  // finishes after the entry is written still lands on it.
  const _sw = {
    cur: null,
    start(c) {
      const now = Date.now();
      if (this.cur) this.cur.ms.total = now - this.cur.t;
      this.cur = c ? { brand: c.brand_name, t: now, last: now, ms: {} } : null;
    },
    lap(stage) {
      if (!this.cur) return;
      const now = Date.now();
      this.cur.ms[stage] = (this.cur.ms[stage] || 0) + (now - this.cur.last);
      this.cur.last = now;
    },
  };
  {
    const _push = tried.push.bind(tried);
    tried.push = (...xs) => {
      for (const x of xs) if (x && _sw.cur && x.brand === _sw.cur.brand && !x.ms) x.ms = _sw.cur.ms;
      return _push(...xs);
    };
  }
  // THE LADDER FOR THIS ATHLETE'S TIER (services/athleteTier): a low-tier
  // athlete never climbs to the social or national lane; mid and high go to
  // the social lane straight after their own pool.
  const tierInfo = require('../services/athleteTier').tierOf(profile || {});
  // Under the deal mix the Market Score tier opens the lanes instead.
  const ladder_ = require('../services/athleteTier').ladderFor(_mix ? { lanes: DM.lanesFor(_mix.tier) } : tierInfo);
  async function refillSlate(why) {
    // A same-night retry draws nothing new: its slate is what was set aside.
    if (_retrying) return [];
    const { fresh: f, added } = await redraw();
    slate = f;
    if (added.length) { say(`${athleteName}: re-drew ${added.length} new candidate(s) from the pool (${why})`); return added; }
    for (;;) {
      if (rung === 0) rung = 1;             // rung 1 is the re-draw above
      const name = ladder_[rung];
      if (!name) break;
      let got = [];
      // Under the mix, a rung whose lane has no seat left tonight is not climbed
      // (and the social and national rungs are, while they have seats).
      if (_mix) { if (mixSeats()[(name === 'social' || name === 'national') ? name : 'local'] <= 0) { rung++; continue; } }
      // Under FIVE, the national and social rungs cannot produce an email card.
      else if (FINDER.five() && (name === 'social' || name === 'national')) { rung++; continue; }
      if (name === 'local-wide') got = await localRefill(why, { skipRedraw: true });
      else if (name === 'places-refresh') { fire(name); got = await placesRefresh(); }
      else if (name === 'social' || name === 'national') { fire(name); got = await laneRung(name); }
      else if (name === 'hometown') { fire(name); got = await hometownRung(); }
      rung++;
      if (got.length) {
        say(`${athleteName}: ${got.length} new candidate(s) from rung ${rung} (${name}) — ${why}`);
        return got;
      }
    }
    return [];
  }

  // ── AN EMPTY BRAND SEAT NEVER LEAVES THE ATHLETE SHORT (MARKET_MIX_ON) ────
  // At the end of the pass -- every source drained -- a social or national
  // seat nobody passed the bar for moves to the local lane, under the
  // verified named-person email rule (no DM, no call, no general inbox, no
  // unverified address, whatever EMAIL_FIVE_ON says). The businesses passed
  // over only because the local seats were full go first; then the ladder is
  // walked again, so the local rungs skipped while the local seats were full
  // can run. Once per pass. Recorded on the run row (loop.mix.backfilled).
  function mixLaneWhy(lane) {
    const SEAT = /seat\(s\) for a .* are taken/;
    // One verdict per brand: its last one tonight, then the slate's refusals
    // of brands never tried.
    const byBrand = new Map();
    for (const x of tried) if (x && x.lane === lane && x.result !== 'queued' && !SEAT.test(String(x.reason || ''))) byBrand.set(x.brand, x);
    for (const r of ((slate && slate.evidenceRefused) || [])) if (r && r.lane === lane && !byBrand.has(r.brand)) byBrand.set(r.brand, { reason: r.why, result: 'rejected' });
    if (!byBrand.size) return `no ${lane} brand was a candidate for a ${DM.TIER_LABEL[_mix.tier]}`;
    const kinds = new Map();
    for (const x of byBrand.values()) {
      const r = String(x.reason || x.result || '');
      const k = /no researched reason/.test(r) ? 'no researched fit'
        : /no verified address/.test(r) ? 'no verified address for the named contact'
        : /not a partnerships, influencer or marketing contact|not a lead who can sign/.test(r) ? 'contact not a partnerships or marketing lead'
        : /does not say why/.test(r) ? 'the pitch stated no fit'
        : /household incumbent/.test(r) ? 'household incumbent'
        : /cannot be matched/.test(r) ? 'size unknown'
        : /seats take|is never pitched a national brand|has no .* seats/.test(r) ? 'wrong size for the tier'
        : x.result === 'no_name' ? 'nobody named'
        : /already researched/.test(r) ? 'already researched tonight'
        : x.result === 'error' ? 'failed on our side'
        : r.replace(/^[^:]*: /, '').slice(0, 60);
      kinds.set(k, (kinds.get(k) || 0) + 1);
    }
    const top = [...kinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([k, n]) => `${n} ${k}`).join(', ');
    return `no ${lane} brand passed the bar: ${byBrand.size} considered (${top})`;
  }
  function backfillMix() {
    if (!_mix || _mix.backfill.done) return false;
    _mix.backfill.done = true;
    const s = mixSeats();
    let moved = 0;
    for (const lane of ['social', 'national']) {
      const n = s[lane];
      if (n <= 0) continue;
      const why = mixLaneWhy(lane);
      for (let i = 0; i < n; i++) _mix.backfill.from.push({ seat: lane, why });
      _mix.backfill.seats += n;
      _mix.quota[lane] -= n;                  // the lane's empty seats are local seats now
      moved += n;
      say(`${athleteName}: ${n} ${lane} seat(s) backfilled from the local lane: ${why}`);
    }
    if (!moved) return false;
    rung = 0;                                 // walk the ladder again for the local lane
    return true;
  }

  // Seed the known set with the first slate, and refill up front when the Scout
  // already says the pool is spent -- same moment the old widen fired.
  for (const c of (slate.picks || [])) knownBrands.add(bk(c.brand_name));
  if (!_retrying && slate.localExhausted && profile.hasLocalMarket && !ctx.noWiden) {
    const added = await refillSlate('pool spent at the start');
    if (added.length) slate = { ...slate, picks: (slate.picks || []).concat(added) };
  }
  // A growing list, not a fixed slate: refillSlate appends new candidates as
  // the fill drains it. Copied so the Scout's own array is never mutated.
  let cands = slate.picks.slice();
  // ── SMART PICK: RANK WITHIN TYPE (services/reachability) ─────────────────
  // The slate keeps its order of TYPES; within a type the more reachable
  // business goes first. Never a filter: every candidate stays.
  const _reachModel = FINDER.smart() ? await Reach.latest(pool).catch(() => null) : null;
  const smartReorder = async (list) => {
    if (!_reachModel || !list.length) return list;
    const sig = await Reach.candidateSignals(pool, list).catch(() => new Map());
    return Reach.smartOrder(list, (c) => Reach.scoreOf(_reachModel, sig.get(String(c.brand_name || '').trim().toLowerCase()) || { type: c.businessCategory || 'unknown' }));
  };
  // What smart pick did to the slate, for the run record (and the tests).
  let _smartSlate = null;
  if (_reachModel) {
    const _before = cands.map((c) => c.brand_name);
    cands = await smartReorder(cands);
    _smartSlate = { before: _before.slice(0, 30), after: cands.map((c) => c.brand_name).slice(0, 30) };
  }
  // ── VARIETY: NO MORE THAN TWO OF ONE TYPE IN THE FIVE ────────────────────
  // Counted from the cards the athlete already holds (the ones that count
  // toward the five) plus tonight's. With five cards and two at most of any
  // type, the five cover three types or more.
  const typeCount = new Map();
  let generalPlaced = 0;
  if (FINDER.smart()) {
    const held = (await pool.query(
      `SELECT business_category FROM outreach_queue WHERE athlete_id = $1 AND state = 'queued'${FINDER.five() ? ' AND email_verified' : ''}`,
      [athleteId]).catch(() => ({ rows: [] }))).rows;
    for (const h of held) if (h.business_category) typeCount.set(h.business_category, (typeCount.get(h.business_category) || 0) + 1);
  }
  if (!cands.length) {
    // NEVER EMPTY WITHOUT A REASON. A silent zero is what we spent a day
    // debugging; the shift report prints this verbatim. When the school is the
    // reason the local lane was silent, say that too -- it is the actionable
    // half, because it is fixable by naming the school correctly.
    const note = noMarket && slate.emptyReason !== Scout.EMPTY.NO_MARKET
      ? `${slate.emptyText} (${noMarketNote})`
      : slate.emptyText;
    say(`${athleteName}: ${note}`);
    return { filled: 0, open: open.length, tried, note,
      emptyReason: slate.emptyReason, noMarket,
      lanes: slate.lanes || null, dropped: slate.dropped || null };
  }
  if (slate.signalCount) {
    say(`${athleteName}: ${slate.signalCount} brand(s) have a deal history at their school`
      + (slate.boosted ? `, ${slate.boosted} on tonight's slate` : ''));
  }
  say(`${athleteName}: slate of ${cands.length} — `
    + Object.keys(slate.laneCounts).map((k) => `${slate.laneCounts[k]} ${k}`).join(', '));
  let ci = 0, filled = 0;
  // Businesses whose mailbox check could not run, set aside for a retry later
  // tonight (EMAIL_FINDER_MORE). fillAgent sends them round again.
  const deferred = [];

  // ── CACHE MODE (services/hunterPace, HUNTER_PACE_ON) ─────────────────────
  // Tonight's Hunter allowance is spent, or Hunter says the plan is out. No
  // new address can be verified, so the night is not spent on businesses
  // that would need one: only a business with an address verified valid in
  // the last 30 days is tried, and those are drawn from the market next in
  // line, so the night is never empty while any is left. The finder takes a
  // verdict no older than 30 days (emailFinder.liveDeps).
  let _cache = null;
  async function enterCache() {
    const brands = await HP.cachedBrands(pool);
    const n = HP.night() || {};
    _cache = { at: new Date().toISOString(), why: n.cacheWhy || 'Hunter credits exhausted', brands, added: 0, skipped: 0 };
    say(`${athleteName}: cache mode (${_cache.why}); ${brands.size} business(es) hold an address verified in the last ${HP.CACHE_DAYS} days`);
    // OURS, NOT THE MARKET'S: a night short because Hunter's credits ran out
    // never counts toward the three-night pause (applyFaultRule). Not recorded
    // as a service fault: the 5:30 email says it once, not once per athlete.
    if (!nightFaults.some((f) => f.service === 'hunter' && f.where === 'cache')) nightFaults.push({ service: 'hunter', reason: 'cache mode: ' + _cache.why, where: 'cache' });
    if (!brands.size || _retrying) return;
    const sl = await Scout.assembleSlate(pool, {
      agentId, athlete: profile, store, limit: slateLimit * 2, localOnly: true, only: [...brands],
      heldPrograms, programCap: Q.PROGRAM_SLOT_CAP, exclude: [...knownBrands],
    }).catch((e) => { faultOf('database', 'cache-mode slate failed: ' + e.message, 'cache'); return { picks: [] }; });
    const added = (sl.picks || []).filter((c) => c && !knownBrands.has(bk(c.brand_name)));
    for (const c of added) knownBrands.add(bk(c.brand_name));
    // Next in line, ahead of anything left on the slate.
    cands.splice(ci, 0, ...added);
    _cache.added = added.length;
  }

  // ── FIVE, OR A REASON ────────────────────────────────────────────────────
  // Not "three attempts a slot". Each open slot keeps drawing until something
  // is placed, refilling the slate as it drains, and stops for exactly one of:
  //   - the money (the existing share/cap check, unchanged, first thing below)
  //   - the rate floor: fewer than 1 in 8 of the last 8 real attempts passed,
  //     the market widened once already, and the rate is still under the floor
  //   - the pool drawn: re-draw, refill and widen all produced nothing new
  // A stop ends the athlete's turn for the night, and the note says which one
  // and what the counts were. The three-nights backoff remains the outer stop.
  // ── WHILE THE ATHLETE HOLDS FEWER THAN FIVE, AND THE CEILINGS ALLOW ─────
  // Every rejection pulls a replacement. The fill stops for exactly one of:
  //   time    Q.ATHLETE_TIME_CEILING_MS on this athlete
  //   cost    Q.ATHLETE_COST_CEILING_USD on this athlete (the next lookup would pass it)
  //   ladder  every rung of Q.LADDER tried and nothing new came back
  //   agent-cap / share   the agent's nightly money (unchanged, below)
  // There is no candidate-count stop and no pass-rate stop: a rung is left
  // only when it has nothing new left to offer.
  let stop = null, capStop = null, candidatesToFloor = null;
  // THE CHANNEL MIX: how each card placed tonight reaches the business
  // (email, dm, call, program). The target is mostly email and DM.
  const channels = [];
  for (const slot of open) {
    let placed = false;
    let slotLost = false;
    for (let attempt = 0; !placed && !stop; attempt++) {
      if (Date.now() - _t0 > TIME_CEILING_MS) { stop = 'time'; break; }
      if (athleteCost() + LOOKUP_CEILING_USD > COST_CEILING_USD + 1e-9) { stop = 'cost'; break; }
      // CACHE MODE: drained means every business with a recently verified
      // address was tried. Nothing new is bought: a business found now could
      // not be verified tonight.
      if (ci >= cands.length && HP.cacheOnly()) {
        if (!_cache) await enterCache();
        if (ci >= cands.length) { stop = 'cache'; break; }
      }
      // Drained: ask the ladder for more before giving up on the slot.
      if (ci >= cands.length) {
        const added = await refillSlate('slate drained');
        // THE DEAL MIX: nothing left in any lane, and a brand seat still empty.
        if (!added.length && _mix && backfillMix()) {
          added.push(..._mixHeldLocal.splice(0));
          if (!added.length) added.push(...(await refillSlate('backfilling an empty brand seat from the local lane')));
        }
        if (!added.length) { stop = 'ladder'; break; }
        cands.push(...(await smartReorder(added)));
      }
      const cand = cands[ci++];
      _sw.start(cand);
      if (HP.cacheOnly()) {
        if (!_cache) await enterCache();
        if (!_cache.brands.has(bk(cand.brand_name))) {
          _cache.skipped++;
          tried.push({ brand: cand.brand_name, result: 'skipped', stage: 'cache',
            reason: `Hunter credits for tonight are spent, and no address at this business was verified in the last ${HP.CACHE_DAYS} days`,
            lane: cand.lane || null, places: { found: false }, risk: 'normal' });
          continue;
        }
        cand._fromCache = true;
      }
      // BEFORE the money, priced at the CEILING. A lookup that would breach the
      // cap is never started, so the cap cannot be overshot by one business.
      if (!budget.canSpend(LOOKUP_CEILING_USD)) {
        const why = Q.slotSkipReason(budget, LOOKUP_CEILING_USD);
        say(`slot ${slot} ${why}`);
        // TWO DIFFERENT STOPS. Running out of this athlete's SHARE ends their
        // turn and leaves the money for the rest of the roster; running out of
        // the agent's CAP ends the night. Reporting both as cappedOut is what
        // made one athlete's spending stop everyone after them.
        const potGone = !budget.canSpendFromPot(LOOKUP_CEILING_USD);
        capStop = { potGone, why };
        stop = potGone ? 'agent-cap' : 'share';
        break;
      }
      // ── RESTRICTED, BY NAME, IN EVERY LANE: no lookup, no card ──────────
      // Before the lanes split, so a social or national brand is checked too
      // (Q.restrictedFor: the send's own classifier and age rule).
      {
        // The candidate's recorded category counts as a description: a social-
        // index brand says "sports betting" in its category even when its
        // name ("Underdog") says nothing.
        const rx = Q.restrictedFor(cand.brand_name, cand.category ? { types: [], primaryTypeDisplayName: cand.category } : null, ctx.athleteRow, undefined, { defer: true });
        if (rx) {
          say(`${cand.brand_name}: not a card, ${rx.why}`);
          tried.push({ brand: cand.brand_name, result: 'rejected', restricted: rx.key, reason: 'restricted: ' + rx.why,
            lane: cand.lane || null, places: { found: false }, risk: 'normal' });
          continue;
        }
      }
      // ── FIVE VERIFIED EMAILS: SKIPPED AT SELECTION, NOT AFTER ────────────
      // Nothing is spent on a business that cannot become a verified email
      // card: a national brand (reached by a programme form or a DM, never a
      // named person's verified address) or a chain location (its domain is
      // the parent company's).
      if (FINDER.five() && !_mix) {
        let _skip = null;
        if (cand.lane && cand.lane !== 'local' && cand.lane !== 'hometown') _skip = `a ${cand.lane} brand, which is reached by a programme or a DM, not a named person's verified email`;
        else {
          const _chain = require('../services/nationalChains').isChainLocation(cand.brand_name);
          if (_chain) _skip = `a national chain location (${_chain}), skipped before any lookup`;
        }
        if (_skip) {
          say(`${cand.brand_name}: skipped, ${_skip}`);
          tried.push({ brand: cand.brand_name, result: 'rejected', stage: 'selection', reason: _skip,
            lane: cand.lane || null, places: { found: false }, risk: 'normal' });
          continue;
        }
      }
      // ── THE DEAL MIX: THE LANE'S SEATS AND THE BRAND'S SIZE, BEFORE MONEY ──
      // _mixBackfill: this local candidate would fill a backfilled brand seat,
      // which takes only a verified named person's email.
      let _mixBackfill = false;
      if (_mix && cand.lane) {
        const _lane = DM.laneOf(cand);
        let _skip = null;
        if (mixSeats()[_lane] <= 0) {
          _skip = `the ${_lane} lane's ${DM.mixFor(_mix.tier)[_lane]} seat(s) for a ${DM.TIER_LABEL[_mix.tier]} are taken`;
          // Not spent on, and first in line if a brand seat is backfilled.
          if (_lane === 'local' && !_mix.backfill.done) {
            _mixHeldLocal.push(cand);
            say(`${cand.brand_name}: held, ${_skip}`);
            tried.push({ brand: cand.brand_name, result: 'skipped', stage: 'mix-seat', reason: _skip, lane: cand.lane || null, places: { found: false }, risk: 'normal' });
            continue;
          }
        } else {
          _mixBackfill = _lane === 'local' && mixBackfillNext();
          const _seat = DM.seatOk(_mix.tier, cand);
          if (!_seat.ok) _skip = _seat.why;
          else if ((FINDER.five() || _mixBackfill) && _lane === 'local') {
            const _chain = require('../services/nationalChains').isChainLocation(cand.brand_name);
            if (_chain) _skip = `a national chain location (${_chain}), skipped before any lookup`;
          }
        }
        if (_skip) {
          say(`${cand.brand_name}: skipped, ${_skip}`);
          tried.push({ brand: cand.brand_name, result: 'rejected', stage: 'mix', reason: _skip,
            lane: cand.lane || null, places: { found: false }, risk: 'normal' });
          continue;
        }
      }
      // ── VARIETY, BEFORE ANYTHING IS SPENT (EMAIL_SMART_PICK) ──────────────
      if (FINDER.smart() && cand.businessCategory && (typeCount.get(cand.businessCategory) || 0) >= TYPE_CAP) {
        const why = `variety: the five already hold ${TYPE_CAP} ${cand.businessCategory} cards`;
        say(`${cand.brand_name}: skipped, ${why}`);
        tried.push({ brand: cand.brand_name, result: 'skipped', stage: 'variety', reason: why, lane: cand.lane || null, places: { found: false }, risk: 'normal' });
        continue;
      }
      // ── THE LANE DECIDES THE ROUTE ──────────────────────────────────────
      // A social or national brand goes nowhere near Places or the contact
      // ladder. Both are the LOCAL lane: they exist to find the owner of a
      // storefront, and pointed at a national brand they resolve it to whatever
      // shop is nearby. That lane costs money per candidate too, so running it
      // on the wrong lane is a wrong answer we pay for.
      // NO LANE, NO ROUTE. The branch below routes on `cand.lane !== 'local'`,
      // so a candidate with no lane used to FALL THROUGH INTO THE LOCAL PATH --
      // a Places lookup on the brand name, which for a national brand resolves
      // its corporate HQ and costs money to get wrong. An undetermined lane is
      // not a local lane; it is a candidate we cannot route, and it is reported
      // rather than guessed at.
      if (!cand.lane) {
        const why = 'no lane recorded for this brand, so it cannot be routed';
        say(`${cand.brand_name}: skipped, ${why}`);
        tried.push({ brand: cand.brand_name, result: 'rejected', reason: why,
          lane: null, places: { found: false }, risk: 'normal' });
        continue;
      }
      if (cand.lane !== 'local') {
        // ── THE DEAL MIX: THE SAME BAR AS THE LOCAL LANE ────────────────────
        // A social or national card is one of two things and only two:
        //   program  the brand's official application page (DM.officialPageOf;
        //            the website fallback is not one)
        //   email    a named partnerships / influencer / marketing contact with
        //            a VALID verified address at the brand's own domain
        //            (services/brandContact)
        // No DM, no guessed address, no desk inbox. A brand past the program
        // caps goes to its named contact instead. And the pitch must say why
        // this athlete fits this brand, from researched facts (services/
        // fitReasons): none found, nothing spent; none stated, no card.
        let _mixRoute = null, _mixFit = null, _mixRouteWhy = null, _mixContact = null;
        if (_mix) {
          const _off = DM.officialPageOf(cand);
          _mixRoute = _off.url ? 'program' : 'email';
          _mixRouteWhy = _off.url ? null : _off.why;
          const _pk = Q.programBrandKey(cand.brand_name);
          if (_mixRoute === 'program' && Q.programCapReached(heldPrograms + programsPlaced)) {
            _mixRoute = 'email'; _mixRouteWhy = `already holding ${heldPrograms + programsPlaced} program application (the cap is ${Q.PROGRAM_SLOT_CAP})`;
          } else if (_mixRoute === 'program' && _pk && Q.programBrandCapReached(programBrandTally.get(_pk) || 0)) {
            _mixRoute = 'email'; _mixRouteWhy = `${cand.brand_name} already has ${programBrandTally.get(_pk)} program application(s) from this roster tonight`;
          }
          // The candidate carries only the page it may use, so the caps and the
          // card below read the same answer.
          cand.programUrl = _mixRoute === 'program' ? _off.url : null;
          // WHY THEY FIT, FROM WHAT WE FOUND. Database reads only: free.
          _mixFit = await Fit.research(pool, { cand, athlete: ctx.athleteProfile || profile,
            athleteId: (ctx.athleteProfile && ctx.athleteProfile.id) || athleteId, agentId });
          if (!Fit.researched(_mixFit)) {
            const why = `no researched reason this athlete fits ${cand.brand_name} (no past campaign, audience range, sport or region fact)`;
            say(`${cand.brand_name}: rejected, ${why}`);
            tried.push({ brand: cand.brand_name, result: 'rejected', stage: 'mix', reason: why, lane: cand.lane, mixTier: _mix.tier, places: { found: false }, risk: 'normal' });
            continue;
          }
        }
        // ── THE CAP, CHECKED BEFORE THE MONEY ───────────────────────────────
        // A candidate that HAS a program page can only ever become a program
        // card, so once the one program slot is spoken for there is nothing to
        // look up and nothing to spend. A candidate WITHOUT one is not capped by
        // this at all -- it can only become a DM -- so it falls through.
        if (cand.programUrl && Q.programCapReached(heldPrograms + programsPlaced)) {
          const why = `already holding ${heldPrograms + programsPlaced} program application`
            + `, which is the cap of ${Q.PROGRAM_SLOT_CAP} per athlete`;
          say(`${cand.brand_name}: skipped, ${why}`);
          tried.push({ brand: cand.brand_name, result: 'rejected', reason: why,
            lane: cand.lane, places: { found: false }, risk: 'normal' });
          continue;
        }
        // ── AND NOT THE SAME BRAND FOR THE WHOLE ROSTER ─────────────────────
        // The per-athlete cap above says nothing about the other athletes. The
        // social and national lanes rank almost identically for everyone on a
        // roster, so the top program brand took the one program slot for all
        // nine athletes on one night. Checked BEFORE the money, like the cap
        // above: a candidate that cannot become this athlete's program card is
        // not worth an Instagram lookup.
        const _pbKey = Q.programBrandKey(cand.brand_name);
        if (cand.programUrl && _pbKey
          && Q.programBrandCapReached(programBrandTally.get(_pbKey) || 0)) {
          const why = `${cand.brand_name} already has `
            + `${programBrandTally.get(_pbKey)} program application(s) from this roster tonight`
            + `, which is the cap of ${Q.PROGRAM_BRAND_NIGHTLY_MAX} per brand per night`;
          say(`${cand.brand_name}: skipped, ${why}`);
          tried.push({ brand: cand.brand_name, result: 'rejected', reason: why,
            lane: cand.lane, places: { found: false }, risk: 'normal' });
          continue;
        }

        // ── THE HANDLE ──────────────────────────────────────────────────────
        // This lane used to spend nothing, which is exactly why it produced
        // nothing but forms: without asking, a brand with no program page was
        // simply dropped. One search, cached 30 days by brand name, and the
        // national brands repeat across the whole roster so the first athlete
        // pays and the rest read it back. No `loc` on purpose -- a DTC brand has
        // no city, and handing one to handleVerdict makes it hunt for a place
        // qualifier that was never going to be there.
        let pig = null, pmeter = null;
        // Not under the deal mix: a brand card there is never a DM.
        if (!_mix) try {
          const m = await scanMeter.run(() => scanMeter.label(
            { site: 'instagram', agentId, athleteId, brand: cand.brand_name },
            () => findInstagram(cand.website || null, {
              brand: cand.brand_name, loc: null, webSearch: ai.webSearchJson, reportFault: true,
            })));
          pig = m.result; pmeter = m.meter;
          _sw.lap('instagram');
        } catch (e) {
          pig = { fault: e.message }; pmeter = null;
        }
        if (pig && pig.fault) {
          // Could not search is not "no account" (services/ourFault).
          say(`${cand.brand_name}: instagram lookup failed on our side (${pig.fault})`);
          tried.push({ brand: cand.brand_name, result: 'error', reason: 'instagram lookup failed: ' + pig.fault, fault: true,
            lane: cand.lane, places: { found: false }, risk: 'normal' });
          OF.record('instagram-search', pig.fault, cand.brand_name);
          continue;
        }
        // Same rule as the local lane: charge what the meter measured, and treat
        // a meter that recorded nothing at all as a broken measurement rather
        // than as free work. The ceiling here is one web search, not $0.06 --
        // this lookup cannot fan out the way the contact ladder does.
        const ptouched = pmeter
          && (pmeter.cacheHits || pmeter.cacheMisses || pmeter.webSearches || pmeter.aiCalls);
        let pcost = Q.priceOf(pmeter);
        if (!ptouched) pcost = Q.USD_PER_WEB_SEARCH;
        if (_mix) pcost = 0;   // no handle lookup ran
        if (pcost > 0) budget.spend(pcost);
        if (!_mix) spendLog.push({ brand: cand.brand_name, lane: cand.lane, cost: pcost,
          cached: !!(ptouched && pmeter.cacheHits && !pmeter.webSearches && !pmeter.aiCalls),
          webSearches: pmeter ? pmeter.webSearches : 0, aiCalls: pmeter ? pmeter.aiCalls : 0,
          cacheHits: pmeter ? pmeter.cacheHits : 0, cacheMisses: pmeter ? pmeter.cacheMisses : 0,
          metered: !!ptouched });

        const pbar = Q.passesProgramBar(cand, pig);
        // Under the deal mix the route was decided above (_mixRoute): an
        // official page, or the named contact's verified address.
        if (!pbar.ok && !_mix) {
          say(`${cand.brand_name}: skipped, ${pbar.reason}`);
          tried.push({ brand: cand.brand_name, result: 'rejected', stage: 'owner', reason: pbar.reason,
            lane: cand.lane, places: { found: false }, risk: 'normal' });
          continue;
        }
        // ── A REAL PERSON'S NAME HERE TOO, OR NO CARD ───────────────────────
        // This lane had no ladder and no name check at all: every DTC and
        // national card was written to nobody and opened "Hi,". The same last
        // door the local lane uses runs here, "[brand] owner" and "[brand]
        // marketing director", cached per brand for the night so a brand
        // that repeats across the roster is searched once. Nothing found means
        // no card, counted on the run row as no_name like any local business.
        let pperson = null;
        // The same once-per-night rule as the local lane: a program brand
        // re-drawn for this athlete tonight is not searched for a name again.
        // ctx.skipBrand (a caller's exclusion, e.g. the cold agent's demo
        // never shows a business any account is working): not researched,
        // not spent on.
        if (ctx.skipBrand && ctx.skipBrand(cand.brand_name)) {
          tried.push({ brand: cand.brand_name, result: 'skipped', reason: 'excluded by the caller', lane: cand.lane, places: { found: false }, risk: 'normal' });
          continue;
        }
        if (!(await Claims.claimResearch(pool, athleteId, cand.brand_name, ctx.runDate || today()))) {
          say(`${cand.brand_name}: skipped, already researched for ${athleteName} tonight`);
          tried.push({ brand: cand.brand_name, result: 'skipped', reason: Claims.RESEARCHED_TONIGHT_REASON, lane: cand.lane, places: { found: false }, risk: 'normal' });
          continue;
        }
        if (NAME_REQUIRED) {
          try {
            pperson = await finalNameFor(cand.brand_name, '', { agentId, athleteId, say, order: proLane ? PL.PRO_QUERY_ORDER : null,
              // EVERY social and national brand: its founder, CEO or corporate
              // office is never the contact, only its partnerships / marketing /
              // athlete-program lead (ownerNameSearch.titleProblem, LARGE_ORDER).
              // With the signing-evidence bar on (services/signingEvidence): every
              // social brand too. Off: as before, national or sized national.
              // Under the deal mix: every social and national brand.
              large: cand.lane === 'national' || cand.brandSize === 'national' || (cand.lane === 'social' && !!ctx._evidenceBar) || !!_mix });
            _sw.lap('ownerSearch');
          } catch (e) {
            say(`${cand.brand_name}: owner search failed on our side (${e.message})`);
            tried.push({ brand: cand.brand_name, result: 'error', reason: 'owner search failed: ' + e.message, fault: true,
              lane: cand.lane, places: { found: false }, risk: 'normal' });
            OF.record(e.service || 'owner-name-search', e.reason || e.message, cand.brand_name);
            continue;
          }
          if (!pperson) {
            const reason = ONS.NO_NAME_REASON;
            say(`${cand.brand_name}: skipped, ${reason}`);
            console.log(`[queue] athlete=${athleteId} "${cand.brand_name}" (${cand.lane}): skipped, no name found (owner and marketing-director searches returned nothing)`);
            tried.push({ brand: cand.brand_name, result: 'no_name', reason, lane: cand.lane, places: { found: false }, risk: 'normal' });
            continue;
          }
          say(`${cand.brand_name}: the ${pperson.query} search found ${pperson.name} (${pperson.title})`);
        }
        // THE EMAIL ROUTE: a partnerships / marketing contact, verified valid.
        if (_mix && _mixRoute === 'email') {
          _mixContact = await BrandContact.verifiedAddress({ pool, person: pperson, cand, agentId, athleteId, more: FINDER.more() });
          _sw.lap('emailFinder');
          if (!_mixContact.ok) {
            if (_mixContact.fault) OF.record('email-finder', _mixContact.fault, cand.brand_name);
            say(`${cand.brand_name}: rejected, ${_mixContact.why}`);
            const f = _mixContact.fin || null;
            tried.push({ brand: cand.brand_name, result: _mixContact.fault ? 'error' : 'rejected', stage: 'mix', reason: _mixContact.why, fault: !!_mixContact.fault,
              route: 'email', routeWhy: _mixRouteWhy, mixTier: _mix.tier, lane: cand.lane, places: { found: false }, risk: 'normal',
              emailCheck: f ? { verify: f.verify, finder: f.finder, website: f.website } : null });
            continue;
          }
        }
        const pgreet = pperson ? Q.greetNameOf((_mixContact && _mixContact.ladder) || ONS.attachToLadder({ tiers: [] }, pperson)) : '';
        const pmatch = await matchFor(pool, agentId, athleteId, cand.brand_name);
        let ppitch = null;
        try {
          ppitch = await PW.writePitch({
            business: {
              name: cand.brand_name, category: cand.category || null,
              address: null, rating: null, userRatingCount: null,
              ownerName: pperson ? pperson.name : null, ownerTitle: pperson ? pperson.title : null,
              greetFirstName: pgreet || null,
              // The programme's own page, and any public evidence, as the
              // ONE thing the message may say about them.
              evidence: WriterEvidence.evidenceFor(cand),
              // Under the deal mix: why this athlete fits this brand, the
              // researched facts (services/fitReasons), in their place.
              ...(_mixFit ? { evidence: _mixFit.lines } : {}),
              isFranchise: false,
              isLocal: false,   // a brand programme: no verified-Instagram local line
            },
            athlete: { ...(ctx.athleteProfile || { name: athleteName }), partnershipCount,
              instagramHandle: (ctx.athleteRow && ctx.athleteRow.instagramHandle) || null,
              contentThemes: contentThemesOf(ctx.athleteRow, ctx.athleteProfile) },
            deal: pmatch,
            agentFirstName: ctx.agentFirstName || null,
            hasSchedulingLink: !!signature.hasLink,
            channel: _mixRoute === 'email' ? 'email' : 'dm',
            learnedAngles: await PW.learnedAngles(pool, PW.playbookFor(cand.category || null).key).catch(() => []),
          }, { oneShot: (p2, sys, mt) => scanMeter.label(
            { site: 'writer', agentId, athleteId, brand: cand.brand_name },
            () => ai.oneShot(p2, sys, mt, ai.MODEL_GEN, { prose: true })) });
        } catch (e) {
          say(`${cand.brand_name}: writer failed (${e.message}), using the plain fallback`);
          OF.record(e.service || 'anthropic', 'writer failed: ' + e.message, cand.brand_name);
          ppitch = null;
        }
        _sw.lap('writer');
        if (ppitch && ppitch.skipped && ppitch.error) {
          // The writer returned nothing usable: ours, not "nothing worth pitching".
          say(`${cand.brand_name}: the writer failed on our side (${ppitch.reason})`);
          tried.push({ brand: cand.brand_name, result: 'error', reason: 'writer: ' + ppitch.reason, fault: true,
            lane: cand.lane, places: { found: false }, risk: 'normal' });
          OF.record('anthropic', 'writer returned nothing usable', cand.brand_name);
          continue;
        }
        if (ppitch && ppitch.skipped) {
          say(`${cand.brand_name}: nothing worth pitching — ${ppitch.reason}`);
          tried.push({ brand: cand.brand_name, result: 'no_angle', reason: ppitch.reason,
            writerRetried: !!ppitch.retried, writerFirstProblems: ppitch.firstProblems || null,
            lane: cand.lane, places: { found: false }, risk: 'normal' });
          continue;
        }
        // NO FILLER (the deal mix): the pitch states one of the fit facts, or
        // it is not a card. A writer that failed leaves no pitch to state one.
        let _mixStates = null;
        if (_mixFit) {
          _mixStates = Fit.statesFit(ppitch, _mixFit);
          if (!_mixStates.ok) {
            say(`${cand.brand_name}: nothing worth pitching — ${_mixStates.why}`);
            tried.push({ brand: cand.brand_name, result: 'no_angle', stage: 'mix', reason: _mixStates.why, mixTier: _mix.tier,
              writerRetried: !!(ppitch && ppitch.retried), lane: cand.lane, places: { found: false }, risk: 'normal' });
            continue;
          }
        }
        // THE GREETING IS CHECKED, NOT TRUSTED. See ensureGreeting: a message the
        // model opened "Hi," under a named person is rewritten to greet them.
        if (ppitch && ppitch.message && NAME_REQUIRED) {
          const g = Q.ensureGreeting(ppitch.message, pgreet);
          if (g.missingName) {
            say(`${cand.brand_name}: no greeting name after the writer; not offered`);
            tried.push({ brand: cand.brand_name, result: 'no_name', reason: ONS.NO_NAME_REASON, lane: cand.lane, places: { found: false }, risk: 'normal' });
            continue;
          }
          if (g.repaired) { say(`${cand.brand_name}: the writer opened "${g.was || '(no greeting)'}"; rewritten to "Hi ${pgreet},"`); ppitch.message = g.message; ppitch.greetingRepaired = true; }
        }
        // The signature is APPENDED, never written by the model. Idempotent, so a
        // regenerated or re-saved draft cannot end up signed twice.
        if (ppitch && ppitch.message) ppitch.message = SIG.appendText(ppitch.message, signature);
        const pcard = Q.buildProgramCard(cand, ppitch, athleteName, pig, pperson);
        // The deal mix's email route: the same pitch, addressed to the named
        // contact's verified address (an email card, not a form).
        if (_mixContact) Object.assign(pcard, Q.buildCard({ brandKey: cand.brand_key, brand: cand.brand_name, rationale: null, athleteName, pitch: ppitch }, _mixContact.ladder, null));
        tried.push({ brand: cand.brand_name, result: 'queued', reason: null,
          writerRetried: !!(ppitch && ppitch.retried), writerFirstProblems: (ppitch && ppitch.firstProblems) || null,
          lane: cand.lane, channel: pcard.channel, places: { found: false }, risk: 'normal' });
        pcard.lane = cand.lane;
        pcard.sponsorSignal = cand.sponsorSignal ? cand.sponsorSignal.kind : null;
        pcard.sponsorNote = cand.sponsorSignal ? cand.sponsorSignal.detail : null;
        // THE EVIDENCE THIS BRAND SIGNS ATHLETES LIKE THIS ONE, and its size
        // band, on the card: what the agent reads, and what reply rate is
        // measured by (services/signingEvidence).
        pcard.sizeBand = cand.sizeBand || null;
        pcard.signingEvidence = cand.signingEvidence || null;
        if (cand.evidenceNote) { pcard.sponsorSignal = pcard.sponsorSignal || 'signs-comparable'; pcard.sponsorNote = pcard.sponsorNote || cand.evidenceNote; }
        // THE DEAL MIX: why they fit, on the card; the tier and the size.
        if (_mix) {
          pcard.why = 'Why they fit: ' + _mixFit.reasons.slice(0, 3).join('; ');
          pcard.fitReasons = _mixFit.reasons;
          pcard.fitLine = _mixStates.line;
          pcard.mixTier = _mix.tier;
          pcard.brandSize = DM.sizeOf(cand).size;
          pcard.emailVerified = !!_mixContact;
        }
        if (dry) {
          // A dry run hands the card it would have queued to the caller.
          if (ctx.onCard) { try { await ctx.onCard({ ...pcard, slot }); } catch (_) { /* the caller's problem */ } }
          say(`slot ${slot}: ${pcard.brandName} (${pcard.channel})`);
          if (pcard.channel === 'program') { programsPlaced++; _tallyProgram(programBrandTally, pcard.brandName); }
          if (_mix) _mix.placed[DM.laneOf(cand)]++;
          placed = true; filled++; channels.push(pcard.channel); break;
        }
        if (!(await slotStillOpen(pool, athleteId, slot))) {
          say(`slot ${slot}: taken by another fill while the writer ran; ${pcard.brandName} not offered`);
          loseSlot(cand.brand_name, slot, cand.lane, ppitch);
          slotLost = true; break;
        }
        const pins = await insertCard(pool, { agentId, athleteId, slot, card: pcard, marketKey: profile && profile.marketKey });
        if (!pins && pcard._insertFault) faultOf('database', 'card not saved: ' + pcard._insertFault, 'insertCard');
        if (pins) {
          // Counted only when the row actually landed, so a card lost to the
          // open-slot unique index does not burn the athlete's one program slot
          // -- nor the brand's allowance across the rest of the roster.
          if (pcard.channel === 'program') { programsPlaced++; _tallyProgram(programBrandTally, pcard.brandName); }
          if (_mix) _mix.placed[DM.laneOf(cand)]++;
          placed = true; filled++; channels.push(pcard.channel); say(`slot ${slot}: ${pcard.brandName} (${pcard.channel})`); break;
        }
        continue;
      }

      // THE CHEAP PASS, BEFORE THE EXPENSIVE ONE. Places is cached 30 days and
      // the deep lookup would call it anyway, so this costs nothing extra --
      // it just moves the call earlier, where its answer can still stop us
      // paying for a business that was never going to produce a contact.
      // ── A REAL BUSINESS NAME, OR NOTHING IS SPENT ──────────────────────
      // A candidate whose "name" is a description ("Local Harrisburg Barber/
      // Salon (independent)") is not looked up, not researched, not written
      // to. Refused by name before the Places call, and recorded so the
      // morning shows the scan that produced it, not a mystery rejection.
      {
        const ph = store.placeholderReason ? store.placeholderReason(cand.brand_name) : null;
        if (ph) {
          const why = `not a real business name (${ph})`;
          say(`${cand.brand_name}: skipped, ${why}`);
          tried.push({ brand: cand.brand_name, result: 'rejected', reason: why, places: { found: false }, risk: 'normal' });
          continue;
        }
      }
      let place = null;
      try {
        const _pr = await lookupPlaceResult(cand.brand_name || cand.brand_key, cand.region || region || '');
        _sw.lap('places');
        place = _pr.place;
        // COULD NOT ASK is not "not on Places" (services/ourFault).
        if (!_pr.ok && _pr.reason !== 'no-query') faultOf('google-places', `lookup unavailable (${_pr.reason})`, 'places lookup');
      } catch (e) { place = null; faultOf('google-places', e.message, 'places lookup'); }
      const pre = Q.prescreen(place);
      const facts = Q.placesFacts(place);
      // ── RESTRICTED, BY WHAT GOOGLE SAYS IT IS: a bar typed as one ──────
      {
        // Not on Places at all is no evidence of a consumer business: a
        // deferred collective is decided here with whatever there is.
        const rx = Q.restrictedFor(cand.brand_name, place || (cand.category ? { types: [], primaryTypeDisplayName: cand.category } : null), ctx.athleteRow);
        if (rx) {
          say(`${cand.brand_name}: not a card, ${rx.why}`);
          tried.push({ brand: cand.brand_name, result: 'rejected', restricted: rx.key, reason: 'restricted: ' + rx.why, places: facts, risk: 'normal' });
          continue;
        }
      }
      if (pre.skip) {
        say(`${cand.brand_name}: skipped before spending — ${pre.reason}`);
        tried.push({ brand: cand.brand_name, result: 'prescreen_skip', reason: pre.reason, places: facts, risk: pre.risk });
        continue;
      }

      // ONCE PER BUSINESS PER ATHLETE PER NIGHT. A second pass tonight (a
      // resume, an on-demand fill, a refill that re-drew the same name) does
      // not research it again: the first pass's answer is on the run row.
      if (ctx.skipBrand && ctx.skipBrand(cand.brand_name)) {
        tried.push({ brand: cand.brand_name, result: 'skipped', reason: 'excluded by the caller', lane: cand.lane, places: facts, risk: pre.risk });
        continue;
      }
      // A SAME-NIGHT RETRY was claimed on its first try and is researched
      // again on purpose: its lookups are cached; only the check is re-asked.
      if (cand._verifyTry) {
        // Retried: claimed on its first try tonight.
      } else if (!(await Claims.claimResearch(pool, athleteId, cand.brand_name, ctx.runDate || today()))) {
        say(`${cand.brand_name}: skipped, already researched for ${athleteName} tonight`);
        tried.push({ brand: cand.brand_name, result: 'skipped', reason: Claims.RESEARCHED_TONIGHT_REASON, lane: cand.lane, places: facts, risk: pre.risk });
        continue;
      }
      say(`looking up ${cand.brand_name}…`);
      let out = null;
      let meter = null;
      try {
        // lean: the queue's cost-tuned source order (chamber+site, then
        // facebook). See LEAN_SOURCE_ORDER in ai.js.
        // MEASURED, NOT ASSUMED. scanMeter counts the real web searches and model
        // calls this lookup made; without it the only "cost" in the system was
        // the worst-case ceiling charged flat on every lookup, which is why
        // nobody could say what a night actually costs.
        const m = await scanMeter.run(() => scanMeter.label(
          { site: 'contacts', agentId, athleteId, brand: cand.brand_name },
          () => ai.getBrandContacts(
            cand.brand_name || cand.brand_key, null,
            cand.region || region || '', ai.deepContactCtx({ market: null, lean: true }))));
        out = m.result;
        meter = m.meter;
        _sw.lap('contacts');
      } catch (e) {
        _sw.lap('contacts');
        say(`${cand.brand_name}: lookup failed (${e.message})`);
        // fault: OUR failure, not this market's. Counted separately so a night of
        // outages cannot pause an athlete whose businesses we never reached.
        tried.push({ brand: cand.brand_name, result: 'error', reason: e.message, fault: true,
          places: facts, risk: pre.risk });
        continue;
      }
      // RESERVED AT THE CEILING, CHARGED AT COST. The affordability check above
      // has to price the worst case or the cap is not a cap; what is DEDUCTED is
      // what the lookup actually used. Charging the ceiling flat is what made
      // $0.50 buy eight lookups no matter how cheap they really were.
      //
      // ── PRICED FROM THE METER, NOT FROM A BOOLEAN ─────────────────────────
      //
      // This read `out.cached ? 0 : Q.priceOf(meter)`, and getBrandContacts did
      // not return `cached` at all -- so the flag was undefined on every lookup.
      // A lookup served entirely from cache took the paid branch, priced at $0
      // from an empty meter, tripped the broken-meter guard below, and was
      // charged the $0.06 CEILING: more than the $0.0422 an average real lookup
      // costs. Cache hits were the most expensive lookups in the system.
      //
      // The meter is the better source even now that the flag is fixed, because
      // one lookup makes SEVERAL cache reads -- contacts, places, siteemail, the
      // ladder's own rows -- and a single per-brand boolean cannot describe a
      // partial hit. priceOf already returns 0 when nothing was called, which is
      // exactly what a full hit looks like, so no special case is needed for it.
      const touched = meter
        && (meter.cacheHits || meter.cacheMisses || meter.webSearches || meter.aiCalls);
      let realCost = Q.priceOf(meter);
      // A LOOKUP THAT TOUCHED NOTHING AT ALL IS A BROKEN METER, NOT A FREE ONE.
      // The meter runs on AsyncLocalStorage; if a call path escapes the context
      // the counts come back empty, and charging that as $0 would silently switch
      // off both the cap AND the backoff -- which only records a night that
      // actually spent. Every real lookup reads the cache at least once, so zero
      // cache reads AND zero calls means the measurement failed, not that the
      // work was free. This is now the only route to the ceiling.
      if (!touched) {
        realCost = LOOKUP_CEILING_USD;
        console.warn(`[queue] ${cand.brand_name}: the meter recorded no cache reads and no `
          + 'calls; charging the ceiling rather than treating the lookup as free');
      }
      if (realCost > 0) budget.spend(realCost);
      spendLog.push({ brand: cand.brand_name,
        // The contacts lane's own answer: did the expensive fan-out re-run.
        cached: !!out.cached,
        cost: realCost,
        webSearches: meter ? meter.webSearches : 0, aiCalls: meter ? meter.aiCalls : 0,
        // THE REAL CACHE MEASUREMENT. scanMeter has counted these all along and
        // this line threw them away, leaving a per-brand boolean as the only
        // record -- which is both too coarse for a multi-read lookup and, until
        // the fix above, always false. Recorded per lookup so a night's hit rate
        // is arithmetic over the run rather than a grep of the logs.
        cacheHits: meter ? meter.cacheHits : 0,
        cacheMisses: meter ? meter.cacheMisses : 0,
        // Said out loud when the meter itself failed, so a ceiling charge is
        // never mistaken for a measurement.
        metered: !!touched });

      const ladder = buildContactLadder(out, {
        // A pro's ladder ranks marketing leadership above the owner (services/proLane).
        rankOf: proLane ? PL.proRankOf(ai.contactAuthorityRank) : ai.contactAuthorityRank, rootDomain: ai.rootDomain,
        category: null, brand: cand.brand_name, instagramScope: out.instagramScope || null,
      });
      // ── NOBODY WHO WOULD NEVER SIGN ─────────────────────────────────────
      // An emeritus, a retired founder, a board chair, a school's president:
      // off the ladder before the bar, the greeting or the writer see them
      // (ownerNameSearch.titleProblem).
      for (const t of (ladder.tiers || [])) {
        if (!Array.isArray(t.rows)) continue;
        t.rows = t.rows.filter((r) => {
          const tp = r && r.name && r.title ? ONS.titleProblem(r.title, { brand: cand.brand_name, city: (region || '').split(',')[0], sourceUrl: r.sourceUrl || r.emailSourceUrl || null }) : null;
          if (tp) say(`${cand.brand_name}: ${r.name} dropped from the contacts: ${tp}`);
          return !tp;
        });
      }
      // ── DOES THE ADDRESS TAKE MAIL? ─────────────────────────────────────
      // Syntax, then an MX lookup, on every address the ladder holds
      // (services/emailValidation). An undeliverable address is marked on
      // its row: the bar and the channel decision below no longer count it,
      // so the business becomes a DM or a call if it has one and is rejected
      // if it has nothing else -- and the card says which address failed and
      // why. Cached per address; a resolver blip is "unverified", not a no.
      try {
        const ev = await EVAL.validateLadder(pool, ladder);
        _sw.lap('emailCheck');
        for (const u of ev.undeliverable) say(`${cand.brand_name}: ${u.email} is undeliverable (${u.reason}); not offered as an email`);
        for (const u of ev.unverified) say(`${cand.brand_name}: ${u.email} could not be checked (${u.reason}); offered, marked unverified`);
      } catch (e) { say(`${cand.brand_name}: email check failed (${e.message}); addresses left unverified`); }
      // ── A UNIVERSITY DEPARTMENT IS NOT A SPONSOR ────────────────────────
      // Known only now, from the address: "UNH PAWS Veterinary Clinic" with
      // colsa.dean@unh.edu is a dean's office (services/notASponsor). Same rule
      // as a collective: not a card.
      {
        const _ib = Q.inboxOf(ladder);
        const _nas = require('../services/notASponsor').detect(cand.brand_name, { email: _ib && _ib.email, website: out.website || null });
        if (_nas && _nas.kind === 'university-department') {
          say(`${cand.brand_name}: ${_nas.why}`);
          tried.push({ brand: cand.brand_name, result: 'rejected', reason: _nas.why, lane: cand.lane, places: facts, risk: pre.risk });
          continue;
        }
      }
      const ig = { instagram: out.instagram || null, instagramScope: out.instagramScope || null };
      // DECIDED BEFORE THE WRITER RUNS, because the writer is told the channel and
      // writes differently for one. buildCard reaches the same answer from the
      // same two inputs further down; this is the same function, called early.
      // `let`: a name found by the owner search below can be given a Tier 2
      // address built from the domain pattern, which changes the channel.
      let channel = Q.channelFor(ladder, ig);
      const bar = Q.passesBar(ladder, ig);

      // ── WHY THIS CARD IS THE CHANNEL IT IS ────────────────────────────────
      //
      // A night of 31 cards produced ZERO email cards while the ladder was
      // holding six real addresses. Tracing it from the outside was impossible:
      // channelFor is a pure function of the ladder, and nothing recorded WHAT
      // THE LADDER HELD. Every candidate looked the same in the log -- a brand
      // name and a channel -- so "the ladder had no address" and "the ladder had
      // one and we routed past it" were indistinguishable.
      //
      // getBrandContacts has always returned `addressLadder`, a step-by-step
      // record of which of the five rungs ran, which hit, and what it found. The
      // job threw it away. It is recorded here, per candidate, into the same
      // run details the shift report reads -- so the next zero-email night is
      // answerable from the database instead of by re-deriving the code.
      const _emailRows = Q.emailRowsOf(ladder);
      const _al = out.addressLadder || null;
      const _why = {
        channel,
        // What the ladder actually held, which is the input channelFor reads.
        ladderEmails: _emailRows.map((r) => ({ tier: r.tier, kind: r.kind })),
        // A kind we refuse to send to is a DIFFERENT answer from no address at
        // all, and the two were previously the same silence.
        refusedKinds: ((ladder.tiers || []).flatMap((t) => (t.rows || [])))
          .filter((r) => r && r.email && !Q.SENDABLE_EMAIL_KINDS.has(r.emailKind || 'published'))
          .map((r) => r.emailKind || 'unknown'),
        // Which rung of the address ladder produced an address, and what each
        // rung did. This is the half the job has never surfaced.
        addressStep: _al ? _al.step : null,
        addressLabel: _al ? _al.label : null,
        addressSteps: _al && Array.isArray(_al.steps)
          ? _al.steps.map((s) => `${s.step}:${s.label}=${s.hit ? 'HIT' : (s.ran ? 'miss' : 'skipped')}`
            + (s.detail ? ` (${String(s.detail).slice(0, 60)})` : ''))
          : [],
        // A dropped website means the site was never scraped, which silences
        // steps 1 and 4 at the source.
        websiteDropped: out.websiteDropped || null,
        website: out.website || null,
        handle: ig.instagram || null,
        cached: !!out.cached,
        // THE ADDRESS TIER (services/emailTier) and, when the only address was
        // a generic mailbox, where the business went instead. The nightly
        // report counts these.
        emailRoute: Q.routeOf(ladder, ig),
      };
      say(`${cand.brand_name}: channel=${channel}`
        + ` ladderEmails=${_emailRows.length}`
        + (_why.refusedKinds.length ? ` refused=${_why.refusedKinds.join(',')}` : '')
        + ` addressStep=${_why.addressStep === null ? 'none' : _why.addressStep}`
        + (out.websiteDropped ? ` websiteDropped=${out.websiteDropped}` : '')
        + (_why.addressSteps.length ? ` [${_why.addressSteps.join(' | ')}]` : ''));

      // ── WHAT THE LEARNING READS (services/reachability) ───────────────────
      // Who the pitch would open to, what kind of business, how big it looks.
      // Recorded on every attempt whatever the switches say: it is data.
      const _placeType = place ? require('../services/businessCategory').categoryOf(place).category : null;
      {
        const _p = Q.greetRowOf(ladder) || Q.namedRows(ladder)[0] || null;
        _why.person = _p ? { name: _p.name, title: _p.title || null, cls: Reach.contactClass(_p.title) } : null;
        _why.type = _placeType || cand.businessCategory || null;
        _why.size = Reach.sizeBucket({ people: Q.namedRows(ladder).length, chain: !!require('../services/nationalChains').isChainLocation(cand.brand_name), type: _why.type });
      }
      if (!bar.ok) {
        // The ladder could not ASK (a source errored or timed out): our failure,
        // not a business with no contact (services/ourFault).
        if (out && (out.outcome === 'ERROR' || out.outcome === 'TIMEOUT')) {
          const why = `contact lookup ${out.outcome === 'TIMEOUT' ? 'timed out' : 'failed'} on our side`;
          say(`${cand.brand_name}: ${why}`);
          tried.push({ brand: cand.brand_name, result: 'error', reason: why, fault: true,
            places: facts, risk: pre.risk, why: _why });
          OF.record('contacts', why, cand.brand_name);
          continue;
        }
        say(`${cand.brand_name}: skipped, ${bar.reason}`);
        tried.push({ brand: cand.brand_name, result: 'rejected', stage: 'owner', reason: bar.reason,
          places: facts, risk: pre.risk, why: _why, emailCheck: ladder.emailCheck || null });
        continue;
      }
      // ── A REAL PERSON'S NAME, OR THE BUSINESS IS NOT WRITTEN TO ─────────
      // A pitch that greets nobody, or "Hi,", goes out under the athlete's
      // name to a real business. So the writer only sees a business once the
      // ladder holds a person the greeting guard would open with (owner,
      // marketing director, manager). When it holds none after every source,
      // one last door: two Haiku searches, "[business] [city] owner" and
      // "[business] [city] marketing director" (services/ownerNameSearch).
      // A person found there joins the ladder as a row; nothing found means
      // the business is skipped, logged, and counted on the run row as
      // result 'no_name' so the morning can read the rate.
      if (NAME_REQUIRED && !Q.greetNameOf(ladder)) {
        let found = null;
        try {
          found = await finalNameFor(cand.brand_name, cand.region || region || (facts && facts.city) || '', { agentId, athleteId, say, order: proLane ? PL.PRO_QUERY_ORDER : null });
          _sw.lap('ownerSearch');
        } catch (e) {
          // Could not search is not "no name found" (services/ourFault).
          say(`${cand.brand_name}: owner search failed on our side (${e.message})`);
          tried.push({ brand: cand.brand_name, result: 'error', reason: 'owner search failed: ' + e.message, fault: true,
            places: facts, risk: pre.risk, why: _why });
          OF.record(e.service || 'owner-name-search', e.reason || e.message, cand.brand_name);
          continue;
        }
        if (found) {
          ONS.attachToLadder(ladder, found);
          // ── THE NAME CAME LATE; THE PATTERN WAS ALREADY HERE ──────────────
          // getBrandContacts could only build an address for people it had
          // named. This person was named after it returned, so when the ladder
          // still has nothing we would email and Hunter gave the domain's
          // pattern, their address is built now -- Tier 2, marked as built.
          if (channel !== 'email' && out.hunterPattern) {
            const _hp = out.hunterPattern;
            const _built = require('../services/emailPattern').construct(_hp.pattern, found.name, _hp.domain);
            const _row = ((ladder.tiers || []).flatMap((t) => t.rows || [])).find((r) => r && r.name === found.name && !r.email);
            if (_built && _row) {
              _row.email = _built; _row.emailKind = 'pattern';
              _row.emailSourceUrl = _hp.exampleSourceUrl || null;
              _row.emailPattern = { pattern: _hp.pattern, from: _hp.from, example: _hp.example || null };
              require('../services/emailTier').annotateLadder(ladder);
              try { await EVAL.validateLadder(pool, ladder); } catch (_) { /* unchecked is still offered, marked */ }
              const _was = channel;
              channel = Q.channelFor(ladder, ig);
              _why.channel = channel;
              _why.emailRoute = Q.routeOf(ladder, ig);
              say(`${cand.brand_name}: built ${_built} for ${found.name} from ${_hp.domain}'s pattern ${_hp.pattern} (Tier 2); channel ${_was} -> ${channel}`);
            }
          }
          say(`${cand.brand_name}: no name from the ladder; the ${found.query} search found ${found.name} (${found.title})`);
          _why.finalName = { name: found.name, title: found.title, query: found.query, sourceUrl: found.sourceUrl || null };
        } else {
          const reason = ONS.NO_NAME_REASON;
          say(`${cand.brand_name}: skipped, ${reason}`);
          console.log(`[queue] athlete=${athleteId} "${cand.brand_name}": skipped, no name found (ladder empty; owner and marketing-director searches returned nothing)`);
          tried.push({ brand: cand.brand_name, result: 'no_name', reason, places: facts, risk: pre.risk, why: _why });
          continue;
        }
      }
      // ── A VERIFIED ADDRESS FOR THE PERSON THE PITCH OPENS TO ───────────
      // services/emailFinder. The business is already chosen and the person
      // known; this decides which address reaches them. The card's address
      // is verified (valid passes; catch-all only when built from a confirmed
      // pattern); with no passing address, the finder reads the domain's
      // pattern, asks Hunter Email Finder, then tries the common formats,
      // each verified. Verification here is charged to the month's pool,
      // never to the per-athlete daily budget, so a budget is not the reason
      // a card is a DM.
      //
      // OFF UNLESS EMAIL_FINDER_ON=1. Shipped dark: the night runs exactly as
      // before until the dry run (admin script email-finder-dryrun, which
      // calls the same finishing step whatever this says) has been read in
      // production and the switch is set on purpose.
      let _verifiedEmail = false;
      if (FINDER.on()) {
        let _fin = null;
        try {
          _fin = await EF.finishLadder({ ladder, out, ig, brand: cand.brand_name, region: cand.region || region || '', place, more: FINDER.more(),
            // SEND_GATE_ON: a named person's valid address only. No general
            // inbox, and a catch-all never passes (the gate would block both).
            smart: FINDER.smart(), allowGeneral: !SG.ON() && generalPlaced < 1, validOnly: SG.ON() || undefined,
            type: _placeType || cand.businessCategory || null },
            EF.liveDeps(pool, { agentId, athleteId, business: cand.brand_name, source: 'nightly' }));
          _sw.lap('emailFinder');
        } catch (e) {
          say(`${cand.brand_name}: the email finder failed on our side (${e.message})`);
          OF.record('email-finder', e.message, cand.brand_name);
        }
        if (!_fin && (FINDER.five() || _mixBackfill)) {
          const why = 'the email finder failed on our side, so no verified address';
          tried.push({ brand: cand.brand_name, result: 'error', stage: 'email', reason: why, fault: true, lane: cand.lane,
            places: facts, risk: pre.risk, why: _why });
          continue;
        }
        if (_fin) {
          const _was = channel;
          channel = Q.channelFor(ladder, ig);
          _why.channel = channel;
          _why.emailRoute = Q.routeOf(ladder, ig);
          _why.finder = { before: _fin.before, after: channel, verify: _fin.verify, website: _fin.website, finder: _fin.finder, credits: _fin.credits };
          const _f = _fin.finder || {};
          say(`${cand.brand_name}: email finder: ${_fin.verify ? `${_fin.verify.email} ${_fin.verify.verdict}${_fin.verify.pass ? ' (passes)' : ' (not used)'}; ` : ''}`
            + (_f.email ? `found ${_f.email} by ${_f.how} (${_f.verdict})` : (_f.stop ? `no address: ${_f.stop}` : 'not needed'))
            + `; channel ${_was} -> ${channel}`);
          _verifiedEmail = verifiedNamedEmail(ladder, ig);
          _why.finder.verifiedNamed = _verifiedEmail;
          // A VERIFIED GENERAL INBOX (EMAIL_SMART_PICK) fills a slot too: one of
          // the five at most, greeting the owner by name.
          const _ib = Q.inboxOf(ladder);
          const _general = FINDER.smart() && !SG.ON() && channel === 'email' && !!(_ib && _ib.general);
          _why.finder.generalInbox = _general || undefined;
          if (_general) _verifiedEmail = true;
          { const _p = Q.greetRowOf(ladder); if (_p) _why.person = { name: _p.name, title: _p.title || null, cls: _general ? 'general' : Reach.contactClass(_p.title) }; }
          // ── A CHECK THAT COULD NOT RUN IS ASKED AGAIN LATER TONIGHT ──────
          // A timeout or Hunter's "still verifying" is not an answer about the
          // business. Set aside, and fillAgent sends it round again after the
          // roster has had its turn: up to VERIFY_TRIES tries in all. On the
          // last try it is decided like any other business.
          const _try = cand._verifyTry || 1;
          _why.finder.try = _try;
          const _couldNotRun = !_verifiedEmail && ((_fin.verify && _fin.verify.verdict === 'not-run') || /could not run/.test(String(_f.stop || '')));
          // Not in cache mode: a check that could not run tonight will not run later tonight either.
          if (FINDER.more() && _couldNotRun && _try < VERIFY_TRIES && !HP.cacheOnly()) {
            const why = `the mailbox check could not run (try ${_try} of ${VERIFY_TRIES}); tried again later tonight`;
            say(`${cand.brand_name}: ${why}`);
            deferred.push({ ...cand, _verifyTry: _try + 1, _deferredAt: Date.now() });
            tried.push({ brand: cand.brand_name, result: 'deferred', stage: 'verify', reason: why, lane: cand.lane,
              places: facts, risk: pre.risk, why: _why });
            continue;
          }
          // ── FIVE VERIFIED EMAILS: ANYTHING ELSE IS DROPPED ───────────────
          // The next business is pulled instead. Never a DM or a call card to
          // make up the five.
          if (FINDER.five() && !_verifiedEmail) {
            const _r = _couldNotRun ? `the mailbox check could not run after ${_try} tr${_try === 1 ? 'y' : 'ies'}`
              : (_f.stop || (_fin.verify && !_fin.verify.pass ? `${_fin.verify.email}: ${_fin.verify.why || _fin.verify.verdict}` : 'no address found'));
            const why = `no verified email for a named person (${_r})`;
            say(`${cand.brand_name}: dropped, ${why}`);
            tried.push({ brand: cand.brand_name, result: 'rejected', stage: 'email', reason: why, lane: cand.lane,
              places: facts, risk: pre.risk, why: _why, emailCheck: ladder.emailCheck || null });
            continue;
          }
          // ── A BACKFILLED BRAND SEAT: A VERIFIED NAMED PERSON'S EMAIL ONLY ─
          // Whatever EMAIL_FIVE_ON says: not a DM, not a call, not a general
          // inbox, not an address that did not verify.
          if (_mixBackfill && !verifiedNamedEmail(ladder, ig)) {
            const _r = _f.stop || (_fin.verify && !_fin.verify.pass ? `${_fin.verify.email}: ${_fin.verify.why || _fin.verify.verdict}` : (_general ? 'only a general inbox' : 'no address found'));
            const why = `a backfilled ${(_mix.backfill.from[_mix.backfill.placed] || {}).seat || 'brand'} seat takes only a verified named person's email (${_r})`;
            say(`${cand.brand_name}: dropped, ${why}`);
            tried.push({ brand: cand.brand_name, result: 'rejected', stage: 'backfill', reason: why, lane: cand.lane,
              places: facts, risk: pre.risk, why: _why, emailCheck: ladder.emailCheck || null });
            continue;
          }
          // A CARD NEEDS A WAY THROUGH. When the only way in was an address
          // that did not pass, and there is no handle or number either, the
          // business is not a card.
          if (channel !== 'email') {
            const _b2 = Q.passesBar(ladder, ig);
            if (!_b2.ok) {
              const why = 'the only address did not pass verification, and there is no phone or Instagram';
              say(`${cand.brand_name}: skipped, ${why}`);
              tried.push({ brand: cand.brand_name, result: 'rejected', stage: 'verify', reason: why,
                places: facts, risk: pre.risk, why: _why, emailCheck: ladder.emailCheck || null });
              continue;
            }
          }
        }
      }
      if (FINDER.smart() && _placeType && (typeCount.get(_placeType) || 0) >= TYPE_CAP) {
        const why = `variety: the five already hold ${TYPE_CAP} ${_placeType} cards`;
        say(`${cand.brand_name}: skipped, ${why}`);
        tried.push({ brand: cand.brand_name, result: 'skipped', stage: 'variety', reason: why, lane: cand.lane, places: facts, risk: pre.risk, why: _why });
        continue;
      }
      tried.push({ brand: cand.brand_name, result: 'queued', reason: null, lane: cand.lane,
        places: facts, risk: pre.risk, why: _why, emailCheck: ladder.emailCheck || null,
        // Placed in cache mode, from an address verified in the last 30 days.
        ...(cand._fromCache ? { cache: true } : {}) });
      // ONE BUSINESS, ONE ENTRY. The writer's verdict below replaces this
      // entry's result rather than adding a second one, so candidates and the
      // per-lane pass counts are not inflated by every refusal.
      const _settle = (fields) => {
        const _te = tried[tried.length - 1];
        if (_te && _te.brand === cand.brand_name && _te.result === 'queued') Object.assign(_te, fields);
        else tried.push({ brand: cand.brand_name, lane: cand.lane, places: facts, risk: pre.risk, ...fields });
      };

      // ── THE WRITER ──────────────────────────────────────────────────────
      // Reads the business and the athlete, decides the angle, then writes. It
      // is allowed to REFUSE: if nothing real connects the two, no pitch is
      // written and the slot moves on to the next candidate rather than being
      // filled with something that reads like a mail merge.
      const match = await matchFor(pool, agentId, athleteId, cand.brand_name);
      let pitch = null;
      try {
        pitch = await PW.writePitch({
          business: {
            name: cand.brand_name,
            category: (place && (place.primaryType || place.category)) || null,
            address: (place && (place.address || place.formattedAddress)) || null,
            rating: place ? place.rating : null,
            userRatingCount: place ? place.userRatingCount : null,
            // THE SAME PERSON IN BOTH LINES. The writer used to be handed the
            // top-ranked named row as "Person to write to" beside a greeting
            // name that could belong to a different, greetable row; shown two
            // people, the model opened with neither. Both now come from the
            // row the greeting guard cleared (Q.greetRowOf).
            ownerName: (Q.greetRowOf(ladder) || Q.namedRows(ladder)[0] || {}).name || null,
            ownerTitle: (Q.greetRowOf(ladder) || Q.namedRows(ladder)[0] || {}).title || null,
            // The verified first name, or ''. Only a contact the greeting guard
            // cleared gets here, so the prompt's instruction and the enforcement
            // that runs after the model cannot disagree.
            greetFirstName: Q.greetNameOf(ladder) || null,
            // WHAT DISCOVERY FOUND, AT LAST. Both fields here were hard-wired
            // to null, so the marketing-activity evidence that ranked this
            // business never reached the pitch. The writer may state one line
            // of it and nothing else about the business; with none, nothing.
            evidence: WriterEvidence.evidenceFor(cand),
            isFranchise: !!(out && out.siteEmail && out.siteEmail.corporate),
            // Rung 6 of the ladder: a business in the athlete's HOMETOWN.
            inHometown: cand.hometown || null,
            // The verified-Instagram line (pitchWriter.igVerifiedLine) is for local businesses only.
            isLocal: !cand.lane || cand.lane === 'local' || cand.lane === 'hometown',
          },
          athlete: { ...(ctx.athleteProfile || { name: athleteName }), partnershipCount,
            instagramHandle: (ctx.athleteRow && ctx.athleteRow.instagramHandle) || null,
            contentThemes: contentThemesOf(ctx.athleteRow, ctx.athleteProfile) },
          deal: match,
          agentFirstName: ctx.agentFirstName || null,
          hasSchedulingLink: !!signature.hasLink,
          // NOT HARDCODED 'dm' ANY MORE. pitchWriter branches on this -- "The
          // channel: email or an Instagram DM" -- so writing an email in DM voice
          // is a real quality difference, not a label. A programme card is still
          // written as a DM because that is what gets pasted into a form.
          channel: channel === 'email' ? 'email' : 'dm',
          learnedAngles: await PW.learnedAngles(pool,
            PW.playbookFor((place && place.primaryType) || null).key).catch(() => []),
        }, { oneShot: (p2, sys, mt) => scanMeter.label(
          { site: 'writer', agentId, athleteId, brand: cand.brand_name },
          () => ai.oneShot(p2, sys, mt, ai.MODEL_GEN, { prose: true })) });
      } catch (e) {
        say(`${cand.brand_name}: writer failed (${e.message}), using the plain fallback`);
        OF.record(e.service || 'anthropic', 'writer failed: ' + e.message, cand.brand_name);
        pitch = null;
      }
      // The 'queued' attempt above was written before the writer ran; mark it
      // with whether the writer needed its second call.
      {
        const _te = tried[tried.length - 1];
        if (_te && _te.brand === cand.brand_name && _te.result === 'queued') {
          _te.writerRetried = !!(pitch && pitch.retried);
          _te.writerFirstProblems = (pitch && pitch.firstProblems) || null;
        }
      }
      _sw.lap('writer');
      if (pitch && pitch.skipped && pitch.error) {
        // The writer returned nothing usable: ours, not "nothing worth pitching".
        say(`${cand.brand_name}: the writer failed on our side (${pitch.reason})`);
        const _te = tried[tried.length - 1];
        if (_te && _te.brand === cand.brand_name && _te.result === 'queued') {
          _te.result = 'error'; _te.reason = 'writer: ' + pitch.reason; _te.fault = true;
        } else tried.push({ brand: cand.brand_name, result: 'error', reason: 'writer: ' + pitch.reason, fault: true, places: facts, risk: pre.risk });
        OF.record('anthropic', 'writer returned nothing usable', cand.brand_name);
        continue;
      }
      if (pitch && pitch.skipped) {
        // A REFUSAL IS A RESULT. Recorded with its reason so "wrote two, both
        // strong" is a claim the log can back up.
        say(`${cand.brand_name}: nothing worth pitching — ${pitch.reason}`);
        _settle({ result: 'no_angle', reason: pitch.reason, writerRetried: !!pitch.retried, writerFirstProblems: pitch.firstProblems || null });
        continue;
      }

      // ── THE GREETING IS CHECKED, NOT TRUSTED ────────────────────────────
      // The prompt asked for "Hi <name>,"; nothing read what came back, and a
      // message the model opened "Hi," under a verified owner shipped as-is.
      // Now the first line must address the verified person or it is rewritten
      // to. And if, whatever the guard above said, there is no name to open
      // with by the time the writer has returned, the business is not offered.
      if (NAME_REQUIRED) {
        const greet = Q.greetNameOf(ladder);
        if (!greet) {
          say(`${cand.brand_name}: no greeting name after the writer; not offered`);
          _settle({ result: 'no_name', reason: ONS.NO_NAME_REASON, why: _why });
          continue;
        }
        if (pitch && pitch.message) {
          const g = Q.ensureGreeting(pitch.message, greet);
          if (g.repaired) {
            say(`${cand.brand_name}: the writer opened "${g.was || '(no greeting)'}"; rewritten to "Hi ${greet},"`);
            pitch.message = g.message; pitch.greetingRepaired = true;
            const _te = tried[tried.length - 1];
            if (_te && _te.brand === cand.brand_name && _te.result === 'queued') _te.greetingRepaired = g.was || '(no greeting)';
          }
        }
      }
      if (pitch && pitch.message) pitch.message = SIG.appendText(pitch.message, signature);
      const card = Q.buildCard({
        brandKey: cand.brand_key, brand: cand.brand_name,
        rationale: (match && match.reasoning) || null,
        athleteName, pitch,
      }, ladder, ig);
      // The lane is a PROPERTY of the result, and the sponsorship signal is why
      // this one outranked the rest. Both recorded, so the card can say "they
      // already did a deal at Auburn" instead of showing a rank.
      // The lane the candidate arrived with, never a default. By the time a
      // candidate reaches here the Scout has justified its lane per pool; if it
      // somehow has none, the guard above this loop has already skipped it.
      card.lane = cand.lane || null;
      card.sponsorSignal = cand.sponsorSignal ? cand.sponsorSignal.kind : null;
      card.sponsorNote = cand.sponsorSignal ? cand.sponsorSignal.detail : null;
      // Verified by the email finder: what the five and the 5:30 list count.
      card.emailVerified = card.channel === 'email' && _verifiedEmail;
      // SEND_GATE_ON: an email card carries the email finder's verified address
      // for a named person, or it is not an email card. The DM or the call
      // instead, with the same pitch; with neither, no card.
      if (SG.ON() && card.channel === 'email' && !(card.emailVerified && verifiedNamedEmail(ladder, ig))) {
        const _alt = card.instagram && card.instagramScope !== 'brand' ? 'dm' : (card.phone ? 'call' : null);
        const _was = card.email || 'no address';
        if (!_alt) {
          const why = `no verified email for a named person (${_was}), and no phone or Instagram`;
          say(`${cand.brand_name}: dropped, ${why}`);
          _settle({ result: 'rejected', stage: 'email', reason: why });
          continue;
        }
        say(`${cand.brand_name}: ${_was} is not a named person's verified address; a ${_alt} card instead`);
        card.channel = _alt;
        card.dmText = _alt === 'dm' ? (card.emailBody || card.dmText) : null;
        card.emailNote = `Not an email card: ${_was} is not a named person's verified address.`;
        card.email = null; card.emailKind = null; card.emailLabel = null; card.emailBody = null; card.subject = null;
        card.emailVerified = false;
      }
      if (SG.ON() && !dry && card.channel === 'email' && card.emailVerified && card.email && card.contactName) {
        await require('../services/finderAddress').remember(pool, { brand: cand.brand_name, name: card.contactName, email: card.email });
      }
      // ── THE KIND, AND WHETHER IT IS A THIN ONE ─────────────────────────
      // The Scout resolved both while ranking. The Places answer is better than
      // anything the slate had, though -- primaryType is a lookup where the
      // candidate's own category may have been read off its name -- so it is
      // preferred when the lookup found one, and the slate's answer is the
      // fallback rather than the other way round.
      {
        const BC = require('../services/businessCategory');
        const fromPlaces = place ? BC.categoryOf(place).category : null;
        card.businessCategory = fromPlaces || cand.businessCategory || null;
        card.thin = cand.thin === true;
        card.thinNote = card.thin ? Scout.THIN_NOTE : null;
      }
      if (_mix) { card.mixTier = _mix.tier; card.brandSize = DM.sizeOf(cand).size; card.fitReasons = Fit.localReasons(cand, ctx.athleteProfile || profile, pitch); }
      // The brand seat this card fills, and why that seat came to the local lane.
      if (_mixBackfill) {
        if (!(card.channel === 'email' && card.emailVerified === true && verifiedNamedEmail(ladder, ig))) {
          const why = 'a backfilled seat takes only a verified named person\'s email, and this card is not one';
          say(`${cand.brand_name}: dropped, ${why}`);
          _settle({ result: 'rejected', stage: 'backfill', reason: why });
          continue;
        }
        const _e = _mix.backfill.from[_mix.backfill.placed] || { seat: 'brand', why: null };
        card.mixBackfill = { seat: _e.seat, why: _e.why };
      }
      if (dry) {
        // A dry run hands the card it would have queued to the caller.
        if (ctx.onCard) { try { await ctx.onCard({ ...card, slot }); } catch (_) { /* the caller's problem */ } }
        if (_mix) mixPlacedLocal(card, slot);
        say(`slot ${slot}: ${card.brandName} (${card.channel})`); placed = true; filled++; channels.push(card.channel);
        if (card.businessCategory) typeCount.set(card.businessCategory, (typeCount.get(card.businessCategory) || 0) + 1);
        if (card.emailLabel === 'General inbox') generalPlaced++;
        break;
      }
      if (!(await slotStillOpen(pool, athleteId, slot))) {
        say(`slot ${slot}: taken by another fill while the writer ran; ${card.brandName} not offered`);
        loseSlot(cand.brand_name, slot, card.lane, pitch);
        slotLost = true; break;
      }
      if (await insertCard(pool, { agentId, athleteId, slot, card, marketKey: cand.hometown ? null : (profile && profile.marketKey) })) {
        placed = true; filled++; channels.push(card.channel);
        if (_mix) mixPlacedLocal(card, slot);
        if (card.businessCategory) typeCount.set(card.businessCategory, (typeCount.get(card.businessCategory) || 0) + 1);
        if (card.emailLabel === 'General inbox') generalPlaced++;
        say(`slot ${slot}: ${card.brandName} — ${card.channel === 'dm' ? 'DM ready' : 'call'}`
          + (card.contactName ? `, ${card.contactName}` : ''));
      } else if (card._insertFault) {
        // Written and then lost to our database: not a business that failed.
        const _te = tried[tried.length - 1];
        if (_te && _te.brand === cand.brand_name) { _te.result = 'error'; _te.reason = 'card not saved: ' + card._insertFault; _te.fault = true; }
        faultOf('database', 'card not saved: ' + card._insertFault, 'insertCard');
      }
      break;
    }
    if (placed && filled === open.length && candidatesToFloor === null) candidatesToFloor = tried.length;
    if (stop) break;
    if (!placed && !slotLost) say(`slot ${slot}: nothing passed the bar`);
  }
  _sw.start(null);   // closes the last candidate's total
  const STOP_TEXT = {
    time: `the time ceiling (${(TIME_CEILING_MS / 60000).toFixed(1)} min) for this athlete`,
    cost: `the cost ceiling ($${COST_CEILING_USD.toFixed(2)}) for this athlete`,
    ladder: 'every rung of the ladder, with nothing new left',
    'agent-cap': "the agent's nightly cap", share: "this athlete's share of the agent's nightly cap",
    cache: `cache mode: Hunter's credits for tonight are spent, and every business with an address verified in the last ${HP.CACHE_DAYS} days was tried`,
  };
  // Seats still empty at the end of the pass: a lane short of its own seats,
  // or a brand seat moved to local that the local lane could not fill.
  function mixShort() {
    const out = [];
    const bfBy = (lane) => _mix.backfill.entries.filter((e) => e.seat === lane).length;
    for (const l of DM.LANES) {
      const seats = _mix.seats[l];
      const got = _mix.placed[l] + (l === 'local' ? 0 : bfBy(l));
      if (got < seats) out.push(`${l} ${got} of ${seats}${l !== 'local' && _mix.backfill.done ? ' (backfill from local found nothing for it either)' : ''}`);
    }
    return out;
  }
  const loop = {
    stop: stop || (filled === open.length ? 'floor' : null),
    candidates: tried.length, candidatesToFloor, rungs: rungsFired.slice(),
    elapsedMs: Date.now() - _t0, costUsd: Math.round(athleteCost() * 1000) / 1000,
    held: Q.SLOTS_PER_ATHLETE - open.length + filled, floor: Q.SLOTS_PER_ATHLETE,
    tier: tierInfo.tier, tierWhy: tierInfo.why, ladder: ladder_.slice(),
    smartSlate: _smartSlate,
    // CACHE MODE: when it began for this athlete, why, and what came of it.
    cache: _cache ? { at: _cache.at, why: _cache.why, cachedBusinesses: _cache.brands.size, drawn: _cache.added, skipped: _cache.skipped,
      placed: tried.filter((t) => t && t.cache && t.result === 'queued').length } : undefined,
    // THE DEAL MIX: the tier, each lane's seats, what was placed, and which
    // lanes came up short (a seat nobody passed the bar for stays empty).
    mix: _mix ? { tier: _mix.tier, score: _mix.score, confidence: _mix.confidence, unscored: _mix.unscored,
      held: _mix.held, seats: _mix.seats, placed: { ..._mix.placed },
      // EACH BACKFILLED SEAT: the brand seat, why it came to the local lane,
      // and the local card that filled it. backfillUnfilled: seats moved to
      // local that the local lane could not fill either.
      backfilled: _mix.backfill.entries.slice(),
      backfillUnfilled: _mix.backfill.seats - _mix.backfill.placed,
      short: mixShort() } : undefined,
    channels: channels.reduce((m, c) => { const k = c || 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {}),
    byLane: tried.reduce((m, t) => {
      const k = (t && t.lane) || 'local';
      m[k] = m[k] || { tried: 0, passed: 0 };
      m[k].tried++; if (t && t.result === 'queued') m[k].passed++;
      return m;
    }, {}),
  };
  say(`${athleteName}: ${loop.held} of ${loop.floor} cards after ${loop.candidates} candidate(s), `
    + `${(loop.elapsedMs / 1000).toFixed(0)}s, $${loop.costUsd.toFixed(2)}; rungs ${loop.rungs.join(' > ')}; `
    + `stopped by ${stop ? STOP_TEXT[stop] || stop : 'the floor: five held'}`);
  // ── SHORT OF FIVE: SHIP WHAT THERE IS, AND SAY SO LOUDLY ─────────────────
  // The bar never moved; the cards that passed are on the agent's screen. The
  // shortfall is an alert (services/ourFault -> service_faults -> the morning
  // alert and the status page) naming the athlete, the count and the rungs.
  // Not a nightFault: it must not change how the pause counts the night.
  // ── ONE REFUSAL ON EVERY BUSINESS IS OUR BUG, NOT THE MARKET ─────────────
  // J'Kai'a Graves: eight businesses with confirmed owners, all eight refused
  // by the writer for the same sentence ("says 'shortstop' but the stored
  // position is 'Infielder / Shortstop'"), zero cards, and nothing said so.
  // When every business that reached the writer was refused for one identical
  // reason, that reason is about the athlete or our check, never the
  // businesses: an alarm (services/ourFault 'writer-refusal'), read by the
  // morning alert, naming the athlete and the reason.
  {
    const atWriter = tried.filter((t) => t && (t.result === 'no_angle' || t.result === 'queued'));
    const refused = atWriter.filter((t) => t.result === 'no_angle');
    const reasons = new Set(refused.map((t) => String(t.reason || '')));
    // Three or more refused alike; OR any number refused alike and the
    // athlete got no card -- a two-candidate night that refuses both for the
    // same reason is the same bug.
    const identical = refused.length >= 1 && refused.length === atWriter.length && reasons.size === 1;
    if (!dry && !_retrying && identical && (refused.length >= 3 || filled === 0)) {
      loop.writerRefusedAll = { count: refused.length, reason: [...reasons][0] };
      say(`${athleteName}: ALARM -- the writer refused all ${refused.length} businesses for one reason: ${[...reasons][0]}`);
      OF.record('writer-refusal', `${athleteName}: the writer refused every business that reached it (${refused.length}) for one identical reason: `
        + `${[...reasons][0]}`.slice(0, 600), 'fill athlete=' + athleteId).catch(() => {});
    }
  }
  // Not again on a same-night retry: the first pass already said so.
  if (loop.held < loop.floor && !dry && !_retrying) {
    OF.record('nightly-floor', `${loop.held === 0 ? 'EMERGENCY, ZERO CARDS. ' : ''}${athleteName}: ${loop.held} of ${loop.floor} cards after ${loop.candidates} candidate(s); `
      + `stopped by ${stop ? STOP_TEXT[stop] || stop : 'unknown'}; rungs tried: ${loop.rungs.join(', ')}`, 'fill athlete=' + athleteId)
      .catch(() => {});
  }
  if (capStop) {
    return { filled, open: open.length, cappedOut: capStop.potGone, shareSpent: !capStop.potGone,
      tried, note: capStop.why, spendLog, emptyReason: filled ? null : Scout.EMPTY.CAPPED,
      faults: tried.filter((t) => t && t.fault).length, loop, stop, deferred };
  }

  // OUR FAILURES, COUNTED. A lookup that threw is not a business that could not
  // be reached; it is a night we could not measure. recordAttempt refuses to
  // pause an athlete whose whole night was this.
  const faults = tried.filter((t) => t && t.fault).length;

  // ── THE HONEST STOP ──────────────────────────────────────────────────────
  // When the night stopped short of five, the note is a sentence with counts:
  // how many businesses this athlete's market has been tried against this
  // week, how many were reachable, how many widens -- and what to do next.
  // Read by the empty tab (homeQueue lastRun) and the shift report verbatim.
  let stopNote = null;
  if (stop === 'ladder' && filled < open.length && !nightFaults.length && !tried.some((t) => t && t.fault)) {
    let triedWeek = tried.length, reachableWeek = tried.filter((t) => t && t.result === 'queued').length, widenedWeek = 0;
    try {
      const prior = await pool.query(
        `SELECT details FROM outreach_queue_runs
          WHERE agent_id = $1 AND run_date >= CURRENT_DATE - 6 AND run_date < CURRENT_DATE`, [agentId]);
      for (const r of prior.rows) for (const d of (Array.isArray(r.details) ? r.details : [])) {
        if (!d || d.athleteId !== athleteId) continue;
        const t = Array.isArray(d.tried) ? d.tried : [];
        triedWeek += t.length; reachableWeek += t.filter((x) => x && x.result === 'queued').length;
      }
      const w = await pool.query(
        `SELECT COALESCE(SUM(deepen_count),0)::int AS n FROM market_deepen_log
          WHERE athlete_id = $1 AND last_deepened_at > NOW() - INTERVAL '7 days'`, [athleteId]).catch(() => ({ rows: [{ n: 0 }] }));
      widenedWeek = (w.rows[0] && w.rows[0].n) || 0;
    } catch (_) { /* counts are best-effort; the sentence still names tonight */ }
    if (widenedTonight && !widenedWeek) widenedWeek = 1;
    stopNote = Q.workedOutNote({ athleteName, market: profile.market || null,
      triedWeek, reachableWeek, widenedWeek, filled, wanted: open.length });
  }

  const note = filled > 0 && !stopNote ? null
    : stopNote
      || (tried.length
        ? `${tried.length} business${tried.length > 1 ? 'es' : ''} tried, none passed the bar`
          + (faults ? ` (${faults} failed on our side, not theirs)` : '')
        : 'no candidates were tried');
  // STRUCTURED, NOT JUST PROSE. emptyReason was computed by the Scout and thrown
  // away before it reached the run row, so every diagnosis had to pattern-match
  // an English sentence -- and a partial fill, which has no note at all, could
  // not be classified from the database whatsoever.
  const emptyReason = filled > 0 ? null
    : faults && faults >= tried.length && tried.length ? Scout.EMPTY.FAULT
      : tried.length ? Scout.EMPTY.BELOW_BAR : Scout.EMPTY.MARKET_EXHAUSTED;
  return { filled, open: open.length, tried, slotTaken, note, spendLog, faults, emptyReason,
    // What each lane returned and what was dropped before ranking, so the
    // morning-after question "why was the slate all social?" is answerable
    // from the run row rather than the process log.
    lanes: slate.lanes || null, dropped: slate.dropped || null,
    // Which stop ended the night, if one did, and the pass rate that decided it.
    stop: stop || null, loop, deferred,
    discoveryUsd: (budget.discoverySpent ? budget.discoverySpent() : 0) + (budget.widenSpent ? budget.widenSpent() : 0) };
}

async function fillAgent(pool, agent, opts) {
  const runDate = opts.runDate || today();
  const dry = !!opts.dryRun;
  if (!dry && !(await claimNight(pool, agent.id, runDate, opts.force))) {
    console.log(`[queue] agent=${agent.id} already filled for ${runDate}, skipping (use --force to re-run)`);
    return { filled: 0, spent: 0, claimed: false };
  }
  // The budget is built AFTER the roster is read, so the discovery pot can be
  // sized from how many athletes it has to cover (services/outreachQueue).
  let budget = null;
  // ── ONE TALLY FOR THE WHOLE ROSTER ────────────────────────────────────────
  // Built once and threaded through every athlete, so a brand that has already
  // taken its allowance of program slots tonight is skipped for the rest of the
  // roster rather than winning all nine. Seeded from the database so a restart
  // mid-run does not reset the ceiling.
  const programBrandTally = await loadProgramBrandTally(pool, agent.id);
  // THE WHOLE ATHLETE, not three fields. Every pitch used to say "a college
  // athlete here in your area", which throws away the only thing being sold.
  const athletes = (await pool.query(
    `SELECT id, data, data->>'name' AS name, data->>'hometown' AS hometown,
            data->>'school' AS school
       FROM athletes WHERE agent_id = $1 ORDER BY created_at ASC`,
    [agent.id])).rows;
  // The sign-off: their "First name for sign-offs" under AGENT_SETUP_ON when
  // set (services/agentName.pitchSignOffName), else their first name.
  const agentFirst = AgentName.pitchSignOffName(agent);
  // ONCE PER RUN. The signature is the same for every card this agent gets, so
  // reading it per business would be 45 identical queries a night.
  const signature = SIG.signatureOf(agent);
  // ── THE POT IS SIZED BY THE ROSTER IT HAS TO COVER ──────────────────────
  // A flat discovery pot handed a 30-athlete agent the same budget as a
  // 3-athlete agent, and the first two athletes spent it. Sized here, where
  // the roster length is finally known, and shared per athlete by openFor.
  // THE CAP COVERS EVERY ATHLETE'S CEILING. The fill now runs until five or
  // until an athlete's own ceiling (Q.ATHLETE_COST_CEILING_USD); a flat $8 for
  // a 30-athlete roster would stop it at the cap long before any ceiling. The
  // cap is still the hard stop, sized as the larger of the configured cap and
  // the roster times the per-athlete ceiling.
  const nightCap = Math.max(CAP_USD, athletes.length * Q.ATHLETE_COST_CEILING_USD);
  budget = Q.newBudget(nightCap, undefined, { rosterSize: athletes.length });
  console.log(`[queue] agent=${agent.id} roster=${athletes.length} discovery pot ${budget.discoveryCap().toFixed(2)} `
    + `(${Q.DISCOVERY_PER_ATHLETE_USD.toFixed(2)} an athlete, floor ${Q.DISCOVERY_CAP_USD.toFixed(2)}), `
    + `widen allowance ${budget.widenCap().toFixed(2)} (${Q.WIDEN_PER_ATHLETE_USD.toFixed(2)} an athlete)`);
  let filled = 0;
  // Banked per athlete, settled once at the end. See the note at the push.
  const attempts = [];
  // ONE ROW PER ATHLETE, even the ones that got nothing. Without this an athlete
  // the job found zero candidates for left no trace anywhere -- not a queued
  // card, not a reason -- so the page had nothing to show but blank space, which
  // reads exactly like the page failing to load rather than like an honest answer.
  const details = [];
  // One market refill per market per run, shared across the roster: nine
  // athletes in one town cost one scan, not nine. See refillSlate.
  const _refilledMarkets = new Set();
  const _placesRefreshed = new Set();
  const _refillFaults = new Map();   // market -> why its refill failed on our side tonight

  // One athlete's fill context, the same for the night's pass and for a
  // same-night retry (extra fields, e.g. retryCands, are merged in).
  const ctxFor = (ath, _ctx, extra) => ({
        agentId: agent.id, athleteId: ath.id, athleteName: ath.name, runDate,
        athleteProfile: _ctx.profile, agentFirstName: agentFirst,
        // The raw stored athlete, for the widened re-scan only. getDealRecommendations
        // reads school/sport/instagram/tiktok off the record itself.
        athleteRow: ath.data || null,
        // Resolved per athlete. Passing opts.region here meant passing undefined.
        budget, region: _ctx.region, dryRun: dry, regionFault: _ctx.fault || null,
        // A DORMANT ACCOUNT'S CARDS DO NOT AGE. The weekly fill only tops up
        // open slots; what is already queued is kept for the agent's return.
        keepStale: !!opts.dormant,
        // FIVE a night now. See NIGHTLY_SLOTS: this is what caps the slate the
        // Scout is asked for, so raising it is what lets the night evaluate
        // dozens of businesses rather than three.
        maxSlots: Q.NIGHTLY_SLOTS, signature,
        refilledMarkets: _refilledMarkets, refillFaults: _refillFaults,
        // Shared by the whole run (run()), so a mid-run Places refresh happens
        // once per market and within the run's allowance.
        placesRefreshed: opts.placesRefreshed || _placesRefreshed,
        // Shared across the roster — see loadProgramBrandTally.
        programBrandTally,
        onProgress: (m) => console.log('[queue] ' + m),
      ...(extra || {}),
  });
  // Businesses set aside tonight because their mailbox check could not run
  // (EMAIL_FINDER_MORE), by athlete, for the retry passes below.
  const deferredBy = new Map();
  // Each athlete's resolved context from the night's pass, reused by a retry.
  const ctxBy = new Map();

  // ── ATHLETES SIDE BY SIDE (EMAIL_FIVE_ON) ──────────────────────────────────
  // One at a time, a 50-athlete roster at the 8-minute ceiling is a 6.7-hour
  // night, and the five rule needs longer per athlete, not shorter. Under
  // EMAIL_FIVE_ON, ATHLETE_CONC athletes of one agent run at once, each on its
  // own lane of the budget (services/outreachQueue newBudget.lane): its own
  // share of what is left, the same pot, the same $2.50 per-athlete ceiling
  // (read from the athlete's own spend log). What they share is safe to share:
  // the once-per-market refills and Places refreshes are claimed before any
  // await, research claims are per athlete in the database, and Hunter's pace
  // is held in one place (services/hunterLookup). Off: one at a time, as before.
  const ATHLETE_CONC = FINDER.five() && !dry ? Math.max(1, parseInt(process.env.OUTREACH_ATHLETE_CONCURRENCY, 10) || 3) : 1;
  // Through the module, so a test can stand in for the fill.
  const _fillAthlete = (...a) => module.exports.fillAthlete(...a);

  // One athlete's pass. b: the budget it spends from (the budget itself one at
  // a time, its own lane side by side); spentSince(): what it has spent.
  const runOne = async (ath, b, spentSince) => {
    // ── ONE ATHLETE'S CRASH COSTS ONE ATHLETE ────────────────────────────────
    // run() already wraps fillAgent so one agent cannot take down the others.
    // This loop had no such wrapper, so a throw anywhere inside fillAthlete --
    // a Places timeout, a malformed athlete row, a null deref in the ladder --
    // ended the night for EVERY athlete after it in the roster. On a roster of
    // forty-five, an exception on the second athlete cost forty-three.
    //
    // The failure is recorded and skipped. NOT retried: a lookup that threw has
    // usually already spent, and running it again spends again for the same
    // answer.
    // Region and profile together, so a geocoded school gives a local lane the
    // Scout will actually search. One Places call, cached 180 days per school.
    const _ctx = await localContextFor(ath);
    ctxBy.set(ath.id, _ctx);
    let r = null;
    try {
      r = await _fillAthlete(pool, ctxFor(ath, _ctx, { budget: b }));
    } catch (e) {
      console.error(`[queue] agent=${agent.id} athlete=${ath.id} (${ath.name}) failed: ${e.message}`);
      details.push({
        athleteId: ath.id, athleteName: ath.name, filled: 0, open: null,
        // `error` is the field the shift report looks for. `note` carries the
        // same thing in words so any older reader that only knows about notes
        // still says something true rather than "no reason recorded".
        error: e.message || String(e),
        note: 'this athlete was skipped: ' + (e.message || String(e)),
        tried: [], paused: false,
        // Whatever it spent before it threw. Dropping this would make the
        // per-night cost read low by exactly the amount the crash wasted.
        spentUsd: Math.round(spentSince() * 10000) / 10000,
        spendLog: [],
      });
      // NO recordAttempt ON AN ERROR, deliberately. That counter feeds the
      // three-strikes backoff that pauses an athlete, and an exception is
      // evidence about OUR code, not about this athlete's market. A bug that
      // threw for everyone would otherwise pause the whole roster in three
      // nights and look like a market problem.
      return { capped: false };
    }

    filled += r.filled;
    if (Array.isArray(r.deferred) && r.deferred.length) deferredBy.set(ath.id, r.deferred);
    details.push({
      athleteId: ath.id, athleteName: ath.name, filled: r.filled, open: r.open,
      note: r.note || null, tried: r.tried || [], paused: !!r.paused,
      // OUR failures tonight, with the service and the provider's words
      // (services/ourFault). Read by the morning alert and the status page.
      nightFaults: r.nightFaults || [],
      // Pitches written and then found no slot (slotStillOpen). Not tried
      // businesses; listed so spend-breakdown can count the writer calls.
      slotTaken: r.slotTaken || [],
      // ── THE STRUCTURED CAUSE, WHICH USED TO BE COMPUTED AND DROPPED ───────
      // The Scout returns a named emptyReason and fillAthlete passes it back;
      // this push listed neither, so every diagnosis had to pattern-match the
      // English in `note` -- and a partial fill has no note at all, so a
      // one-card athlete could not be classified from the database at all.
      emptyReason: r.emptyReason || null,
      noMarket: !!r.noMarket,
      // WHY THE LOCAL LANE HAD NO TOWN, as a code (services/localLaneCheck):
      // no-school, team-in-school, pro-no-city, unresolved. Home shows the
      // agent the same thing with the fix.
      schoolProblem: (require('../services/localLaneCheck').problemFor(ath, { noMarketLastNight: !!r.noMarket }) || {}).code || null,
      // Per-lane row counts and pre-ranking drops. See assembleSlate.
      lanes: r.lanes || null,
      dropped: r.dropped || null,
      // How many of this athlete's attempts failed on OUR side. The number that
      // would have made 2026-08-23 legible the next morning.
      faults: r.faults || 0,
      // Only present when held: how long, and when we come back automatically.
      pausedDays: r.pausedDays || null,
      nextRetryAt: r.nextRetryAt || null,
      // The measured figure for THIS athlete, so "what does a night cost per
      // athlete" is answerable from the run row rather than estimated.
      spentUsd: Math.round(spentSince() * 10000) / 10000,
      spendLog: r.spendLog || [],
      // THE LOOP (see the fill): what stopped it, how many candidates it
      // chewed through, how many it took to reach five, which rungs fired,
      // the time and money on this athlete, and pass rate by lane.
      // scripts/floor-report.js and /admin/scan-rejects read this.
      loop: r.loop || null,
    });
    // ── THE BACKOFF IS DECIDED AFTER THE RUN, NOT DURING IT ────────────────
    // This called recordAttempt inline, so each athlete was judged in isolation
    // -- and in isolation nothing can tell a thin market from a night when our
    // own rules were rejecting everything. On 2026-08-23 six athletes on one
    // roster tripped the three-night counter inside eight minutes, which no
    // per-athlete rule could ever have caught. The attempt is banked here and
    // the whole roster is looked at once the run is done.
    if (!dry && !r.paused) {
      attempts.push({ athleteId: ath.id, filled: r.filled,
        spent: spentSince(), faults: r.faults || 0, tried: r.tried || [] });
    }
    // Only the AGENT'S cap ends the night. An athlete who used their share is
    // done for the evening; the next one still has theirs.
    if (r.cappedOut) {
      return { capped: true };
    }
    return { capped: false };
  
  };

  if (ATHLETE_CONC <= 1) {
    for (let ai2 = 0; ai2 < athletes.length; ai2++) {
      const ath = athletes[ai2];
      const before = budget.spent();
      // EACH ATHLETE GETS A SHARE OF WHAT IS LEFT, recomputed against the number
      // still to come. Last night the first athletes spent the whole cap and the
      // last ones were told "budget cap reached" -- which is not a budget, it is a
      // race decided by the roster's ORDER BY. Unspent share flows forward
      // automatically because this divides the REMAINING pot, not the original.
      budget.openFor(athletes.length - ai2);
      const out = await runOne(ath, budget, () => budget.spent() - before);
      // Only the AGENT'S cap ends the night. An athlete who used their share is
      // done for the evening; the next one still has theirs.
      if (out.capped) { console.log('[queue] nightly cap reached, stopping the run'); break; }
    }
  } else {
    console.log(`[queue] agent=${agent.id} ${athletes.length} athlete(s), ${ATHLETE_CONC} at a time`);
    let next = 0, stop = false;
    await Promise.all(Array.from({ length: Math.min(ATHLETE_CONC, athletes.length) }, async () => {
      while (!stop && next < athletes.length) {
        const ai2 = next++;
        const lane = budget.lane(athletes.length - ai2);
        let out = null;
        try { out = await runOne(athletes[ai2], lane, () => lane.mine()); }
        finally { lane.close(); }
        if (out && out.capped && !stop) { stop = true; console.log('[queue] nightly cap reached, stopping the run'); }
      }
    }));
    // In roster order, as one at a time would have written them.
    const order = new Map(athletes.map((a, i) => [a.id, i]));
    details.sort((x, y) => (order.get(x.athleteId) || 0) - (order.get(y.athleteId) || 0));
    attempts.sort((x, y) => (order.get(x.athleteId) || 0) - (order.get(y.athleteId) || 0));
  }

  // ── SAME-NIGHT RETRIES: A CHECK THAT COULD NOT RUN IS ASKED AGAIN ────────
  // EMAIL_FINDER_MORE. A business whose mailbox check timed out, or that
  // Hunter was still verifying, was set aside rather than decided. Once the
  // roster has had its turn -- and at least RETRY_GAP_MS after it was set
  // aside -- it goes round again with only those businesses as its slate,
  // into whatever slots are still open: VERIFY_TRIES tries in all, and the
  // last try is decided like any other business. Its lookups are cached; only
  // the check is asked again.
  for (let pass = 2; pass <= VERIFY_TRIES && deferredBy.size && !dry; pass++) {
    const due = [...deferredBy.entries()];
    deferredBy.clear();
    const earliest = Math.min(...due.flatMap(([, cs]) => cs.map((c) => c._deferredAt || Date.now())));
    const wait = Math.min(RETRY_GAP_MS, Math.max(0, earliest + RETRY_GAP_MS - Date.now()));
    console.log(`[queue] agent=${agent.id} retry pass ${pass} of ${VERIFY_TRIES}: ${due.reduce((n, [, cs]) => n + cs.length, 0)} business(es) `
      + `for ${due.length} athlete(s)${wait ? `, after ${Math.round(wait / 1000)}s` : ''}`);
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    for (let i = 0; i < due.length; i++) {
      const [athId, cands] = due[i];
      const ath = athletes.find((a) => a.id === athId);
      const d = details.find((x) => x && x.athleteId === athId);
      if (!ath || !d || !ctxBy.get(athId)) continue;
      if (budget.openFor) budget.openFor(due.length - i);
      const before = budget.spent();
      let r2 = null;
      try {
        r2 = await _fillAthlete(pool, ctxFor(ath, ctxBy.get(athId), { retryCands: cands, noWiden: true, keepStale: true }));
      } catch (e) {
        console.error(`[queue] agent=${agent.id} athlete=${athId} retry pass ${pass} failed: ${e.message}`);
        d.retryErrors = (d.retryErrors || []).concat(e.message);
        continue;
      }
      filled += r2.filled;
      d.filled = (d.filled || 0) + r2.filled;
      d.tried = (d.tried || []).concat((r2.tried || []).map((t) => ({ ...t, retryPass: pass })));
      d.spentUsd = Math.round(((d.spentUsd || 0) + (budget.spent() - before)) * 10000) / 10000;
      d.retryPasses = (d.retryPasses || 0) + 1;
      const a = attempts.find((x) => x.athleteId === athId);
      if (a) { a.filled += r2.filled; a.spent += budget.spent() - before; a.tried = a.tried.concat(r2.tried || []); }
      if (Array.isArray(r2.deferred) && r2.deferred.length) deferredBy.set(athId, r2.deferred);
      if (r2.cappedOut) break;
    }
  }

  // ── SETTLE THE BACKOFF ACROSS THE WHOLE ROSTER ────────────────────────────
  //
  // On 2026-08-23 six athletes on one roster hit exactly three consecutive
  // failures within eight minutes of each other. Nothing about six markets
  // changed in eight minutes. NIGHTLY_SLOTS was 1, the deliverable lint demanded
  // a quantifier followed by a noun, and the sign-off regex \bjohn\b could not
  // match "JohnMark" -- so every pitch that agent's roster produced was rejected
  // by our own rules, and the counter recorded six thin markets. f1b11aa fixed
  // the rules the next day; the pause outlived the bug by nine days because
  // nothing could clear it.
  //
  // A per-athlete rule cannot see this. Only the roster can: when nearly every
  // athlete who spent money placed nothing, the run is the suspect, not the
  // markets. Being wrong here is cheap -- nobody is paused tonight and the next
  // night counts normally -- while being wrong the other way removes a third of
  // a customer's roster from the product silently.
  const spentAttempts = attempts.filter((a) => a.spent > 0);
  const failedAttempts = spentAttempts.filter((a) => a.filled === 0);
  const systemic = spentAttempts.length >= SYSTEMIC_MIN_ATHLETES
    && failedAttempts.length / spentAttempts.length >= SYSTEMIC_FAIL_SHARE;
  if (systemic) {
    console.error(`[queue] agent=${agent.id} SYSTEMIC FAILURE: `
      + `${failedAttempts.length} of ${spentAttempts.length} athletes that spent money placed `
      + 'nothing. Not counting tonight toward anyone\'s backoff — a whole roster does not '
      + 'go thin in one night, and the last time this happened it paused six athletes for '
      + 'nine days.');
  }
  for (const a of attempts) {
    await recordAttempt(pool, a.athleteId, {
      filled: a.filled, spent: a.spent, runDate,
      faults: a.faults, tried: a.tried, systemic,
    });
  }

  // THE MEASURED ANSWER TO "WHAT DOES A NIGHT COST". Printed every run, from
  // real search and model counts rather than the ceiling.
  const cost = Q.costSummary(details.map((d) => d.spendLog));
  console.log(`[queue] agent=${agent.id} COST $${cost.totalUsd.toFixed(4)} over `
    + `${cost.lookups} lookup(s) (${cost.paidLookups} paid, ${cost.freeLookups} free) `
    + `= $${cost.perPaidLookupUsd.toFixed(4)}/paid lookup, `
    + `$${cost.perAthleteUsd.toFixed(4)}/athlete across ${cost.athletes} athlete(s)`);
  // THE CACHE, ON ITS OWN LINE AND FROM READS RATHER THAN A FLAG. Every lookup
  // makes several cache reads; this is the ratio over all of them, which is the
  // number any cost projection actually depends on.
  console.log(`[queue] agent=${agent.id} CACHE ${cost.cacheHits}/${cost.cacheReads} reads hit`
    + `${cost.cacheHitPct === null ? '' : ` (${cost.cacheHitPct}%)`}`
    + (cost.unmeteredLookups
      ? ` — WARNING: ${cost.unmeteredLookups} lookup(s) recorded nothing at all and were `
        + 'charged the ceiling; those are failed measurements, not measured costs'
      : ''));

  if (!dry) {
    await pool.query(
      `UPDATE outreach_queue_runs SET filled = $3, spent_usd = $4, details = $5, finished_at = NOW()
        WHERE agent_id = $1 AND run_date = $2`,
      [agent.id, runDate, filled, budget.spent(), JSON.stringify(details)]).catch((e) => {
        console.error('[queue] failed to persist run details:', e.message);
        require('../services/ourFault').record('database', 'run details not saved: ' + e.message, 'fillAgent agent=' + agent.id);
      });
    // ── THE NIGHTLY DIGEST, THE MOMENT THIS AGENT'S FILL IS DONE ──────────
    // Only here: a dormant agent the run skipped never reaches this function,
    // and the on-demand path goes through fillAthlete, not fillAgent. The
    // digest itself skips an agent with no new cards, an unsubscribed agent,
    // and a night already sent. A digest failure never fails the fill.
    if (!opts.noDigest) {
      try {
        const ND = require('../services/nightlyDigest');
        // A NIGHT THAT FOUND NOTHING IS NOT A NIGHT WITH NOTHING TO SAY. When
        // the fill placed cards, the digest is about them. When it placed none
        // but pitches are still sitting unapproved, the same email goes out
        // saying so -- at most once every three days, and never on a night a
        // real digest already went. Silence is what let the queue build up.
        const r = filled > 0
          ? await ND.sendForRun(pool, { agentId: agent.id, runDate, details })
          : await ND.sendWaiting(pool, { agentId: agent.id, runDate });
        if (!r.sent) console.log(`[nightly-digest] agent=${agent.id} not sent: ${r.reason}`);
      } catch (e) { console.error(`[nightly-digest] agent=${agent.id} failed: ${e.message}`); }
    }
  }
  console.log(`[queue] agent=${agent.id} filled=${filled} spent=$${budget.spent().toFixed(2)} of $${CAP_USD.toFixed(2)}`);
  return { filled, spent: budget.spent(), claimed: true, details };
}

// ── ACTIVE AGENTS NIGHTLY, DORMANT AGENTS WEEKLY ──────────────────────────────
// ACTIVE: signed in within INACTIVE_AFTER_DAYS (14). Sessions last seven days
// and do not roll, so anyone using the app signs in at least weekly. Filled
// every night.
//
// DORMANT: no sign-in for longer, or never. Filled ONCE A WEEK, not never: the
// product is waking up to deals, and an agent who drifts away has to come back
// to five of them, not an empty screen. Switching them off was cheap and
// guaranteed they never returned.
//   - Due when this agent's last real fill (any run row whose note is not a
//     "skipped: ..." decision) is DORMANT_EVERY_DAYS (7) or more ago, or there
//     is none. So each dormant account settles on its own weekday.
//   - The other six nights are a run row whose note starts "skipped: " (the
//     morning alert and status page read that prefix as by design) and says
//     when the next fill is.
//   - Their cards DO NOT AGE while they are dormant (keepStale): the weekly
//     fill only fills open slots, so after the first week it spends little or
//     nothing, and what it found is still there when they sign in.
//   - On the sign-in that ends the dormancy, every queued card's seven days
//     restart from that moment (restartCardClock), so the deals that waited
//     get a full week of the agent's attention before they expire.
// Zero athletes: fillAgent has nothing to fill and spends nothing, as before.
// A run for one named agent (--agent, the admin fill) or --force always fills.
const INACTIVE_AFTER_DAYS = parseInt(process.env.OUTREACH_QUEUE_INACTIVE_DAYS, 10) || 14;
const DORMANT_EVERY_DAYS = parseInt(process.env.OUTREACH_QUEUE_DORMANT_EVERY_DAYS, 10) || 7;
// The reason an agent is DORMANT, or null when active. (Was the skip itself.)
function inactiveSkip(agent, now) {
  const ref = now ? new Date(now) : new Date();
  const last = agent && agent.last_login ? new Date(agent.last_login) : null;
  if (last && !isNaN(last.getTime())) {
    const days = Math.floor((ref.getTime() - last.getTime()) / 86400000);
    if (days <= INACTIVE_AFTER_DAYS) return null;
    return `last login ${days} days ago (${last.toISOString().slice(0, 10)})`;
  }
  return 'this agent has never signed in';
}
const _addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const _daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
// Is tonight a dormant agent's weekly fill? -> { due, lastFill, nextFill }
async function dormantCadence(pool, agentId, runDate) {
  const r = await pool.query(
    `SELECT MAX(run_date)::text AS d FROM outreach_queue_runs
      WHERE agent_id = $1 AND run_date < $2::date AND COALESCE(note, '') NOT LIKE 'skipped:%'`, [agentId, runDate]);
  const lastFill = r.rows[0] && r.rows[0].d ? String(r.rows[0].d).slice(0, 10) : null;
  const due = !lastFill || _daysBetween(lastFill, runDate) >= DORMANT_EVERY_DAYS;
  return { due, lastFill, nextFill: due ? runDate : _addDays(lastFill, DORMANT_EVERY_DAYS) };
}
// The agent is back: every queued card's seven days start now.
async function restartCardClock(pool, agentId) {
  const r = await pool.query(
    `UPDATE outreach_queue SET expire_from = NOW(), updated_at = NOW() WHERE agent_id = $1 AND state = 'queued'`, [agentId]);
  if (r.rowCount) console.log(`[queue/resume] agent=${agentId}: ${r.rowCount} waiting card(s) get a fresh ${Q.EXPIRE_AFTER_DAYS} days from today`);
  return r.rowCount || 0;
}

// ── TONIGHT'S HUNTER ALLOWANCE (services/hunterPace, HUNTER_PACE_ON) ────────
// Hunter's account is read before anything spends and tonight's allowance
// fixed; the night is closed after the run with what it spent. A dry run is
// not a night.
async function run(opts = {}) {
  const pool = store.pool;
  const paced = !opts.dryRun && HP.ON()
    ? await HP.beginNight(pool, { runDate: opts.runDate || today(), now: opts.now }).catch((e) => { console.error('[queue] Hunter pace: ' + e.message); return null; })
    : null;
  try { return await runAgents(opts); }
  finally { if (paced) await HP.endNight(pool).catch((e) => console.error('[queue] Hunter pace end: ' + e.message)); }
}

async function runAgents(opts = {}) {
  const pool = store.pool;
  // Every school market corrected so far, before any athlete is resolved; and
  // which ambiguous names are already producing and keep running.
  await require('../services/schoolMarketCheck').load(pool);
  await require('../services/schoolKeep').load(pool);
  const agents = opts.agentId
    // signature_text / scheduling_url travel with the agent so fillAgent can read
    // them once rather than querying per business.
    ? (await pool.query(
      `SELECT id, name, email, sign_first_name, signature_text, scheduling_url, last_login FROM users WHERE id = $1`,
      [opts.agentId])).rows
    : (await pool.query(
      `SELECT id, name, email, sign_first_name, signature_text, scheduling_url, last_login FROM users
        WHERE role IN ('agent','admin') AND archived IS NOT TRUE ORDER BY created_at ASC`)).rows;
  let filled = 0, spent = 0, skipped = 0;
  // Shared by every agent and athlete tonight: a market refreshed from Places
  // mid-run is refreshed once, and the run's allowance of refreshes holds.
  opts = { ...opts, placesRefreshed: opts.placesRefreshed || new Set() };
  // ── AGENTS IN PARALLEL ────────────────────────────────────────────────────
  // The fill now runs each athlete to five, which takes longer than the old
  // batch. One agent after another, a 40-account night could run past the
  // morning. Each agent's fill is self-contained (its own claim, budget and
  // roster), so OUTREACH_QUEUE_AGENT_CONCURRENCY agents run at once.
  const CONC = Math.max(1, parseInt(process.env.OUTREACH_QUEUE_AGENT_CONCURRENCY, 10) || 4);
  const one = async (a) => {
    // NO NAME, NO CARDS. Checked before the inactivity test's bypass, so a
    // forced or single-agent run refuses too: every card this agent could get
    // tonight would be signed by nobody. Recorded as the night's note, so Home
    // says why the queue is empty rather than showing a blank page.
    const nameless = AgentName.pitchSignOffName(a) ? null : AgentName.NO_AGENT_NAME_REASON;
    const runDate = opts.runDate || today();
    const skipRow = async (why) => {
      skipped++;
      console.log(`[queue] agent=${a.id} ${why}`);
      if (opts.dryRun) return;
      // The night is claimed with the reason on it, so nothing else fills
      // this agent tonight and the row reads as a decision, not a gap.
      await pool.query(
        `INSERT INTO outreach_queue_runs (agent_id, run_date, filled, spent_usd, note, details, finished_at)
         VALUES ($1, $2, 0, 0, $3, '[]'::jsonb, NOW())
         ON CONFLICT (agent_id, run_date) DO NOTHING`, [a.id, runDate, why]).catch((e) =>
        console.error('[queue] could not record the skip for ' + a.id + ': ' + e.message));
    };
    if (nameless) return skipRow(nameless);
    let dormant = null;
    if (!opts.agentId && !opts.force) {
      const why = inactiveSkip(a, opts.now);
      if (why) {
        const cad = await dormantCadence(pool, a.id, runDate).catch((e) => {
          console.error(`[queue] agent=${a.id} cadence read failed (${e.message}); filling tonight rather than going dark`);
          return { due: true };
        });
        if (!cad.due) {
          return skipRow(`skipped: dormant, ${why}; dormant accounts are filled once a week, last ${cad.lastFill}, next ${cad.nextFill}`);
        }
        dormant = `weekly fill for a dormant account: ${why}`;
      }
    }
    const fillOpts = dormant ? { ...opts, dormant: true } : opts;
    const r = await fillAgent(pool, a, fillOpts).catch(async (e) => {
      console.error(`[queue] agent=${a.id} failed: ${e.message}`);
      // A run that THREW is still a run that ended. Without this stamp the row
      // stays finished_at NULL forever and every reader has to treat a crashed
      // night as one still in progress -- which would hold the morning email
      // back on a run that is never coming back.
      await pool.query(
        `UPDATE outreach_queue_runs SET finished_at = NOW(), note = COALESCE(note, $3)
          WHERE agent_id = $1 AND run_date = $2 AND finished_at IS NULL`,
        [a.id, opts.runDate || today(), 'the run stopped early: ' + e.message]).catch(() => {});
      return { filled: 0, spent: 0 };
    });
    filled += r.filled; spent += r.spent;
    if (dormant && !opts.dryRun) {
      await pool.query(
        `UPDATE outreach_queue_runs SET note = CASE WHEN note IS NULL THEN $3 ELSE note || ' -- ' || $3 END
          WHERE agent_id = $1 AND run_date = $2`, [a.id, runDate, dormant]).catch(() => {});
    }
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONC, agents.length) }, async () => {
    while (next < agents.length) { const a = agents[next++]; await one(a); }
  }));
  console.log(`[queue] run complete agents=${agents.length} skipped=${skipped} filled=${filled} spent=$${spent.toFixed(2)}`);
  return { agents: agents.length, skipped, filled, spent };
}

// ── On demand, when the agent actually opens the queue ───────────────────────
// The night leaves two slots deliberately empty. This fills them the first time
// someone looks at that athlete -- so the money follows attention instead of
// preceding it.
//
// CLAIMED PER ATHLETE PER DAY, NOT PER OPEN. The claim row goes in BEFORE any
// lookup, exactly like the nightly claim, so an agent flipping between athletes
// all morning triggers at most one paid fill per athlete per day no matter how
// many times they come back. A crash after the claim costs that athlete one
// day's on-demand fill, which is the right way round for money.
const ONDEMAND_CAP_USD = parseFloat(process.env.OUTREACH_QUEUE_ONDEMAND_USD) || Q.DEFAULT_ONDEMAND_USD;

async function fillOnDemand(pool, ath, opts = {}) {
  const runDate = opts.runDate || today();
  // Refused BEFORE the claim, so adding a name later the same day still gets
  // this athlete a fill, and nothing is spent on cards nobody can sign.
  const agentFirstName = AgentName.pitchSignOffName({ name: ath.agent_name, email: ath.agent_email, sign_first_name: ath.agent_sign_first_name });
  if (!agentFirstName) return { filled: 0, spent: 0, claimed: false, reason: AgentName.NO_AGENT_NAME_REASON };
  const claim = await pool.query(
    `INSERT INTO outreach_queue_ondemand (athlete_id, run_date) VALUES ($1,$2)
     ON CONFLICT (athlete_id, run_date) DO NOTHING`, [ath.id, runDate]).catch((e) => ({ rowCount: 0, error: e }));
  // A claim that FAILED is not "already filled today" (services/ourFault).
  if (claim.error) {
    console.error(`[queue/ondemand] athlete=${ath.id} claim failed: ${claim.error.message}`);
    require('../services/ourFault').record('database', 'on-demand claim failed: ' + claim.error.message, 'fillOnDemand athlete=' + ath.id);
    return { filled: 0, spent: 0, claimed: false, fault: true, reason: 'our failure: the claim could not be written (' + claim.error.message + ')' };
  }
  if (!(claim.rowCount > 0)) return { filled: 0, spent: 0, claimed: false, reason: 'already filled today' };

  // opts.budget: a shared budget when several athletes are filled in one go
  // (resumeAgent), so a roster of forty cannot spend forty on-demand caps.
  const budget = opts.budget || Q.newBudget(ONDEMAND_CAP_USD);
  const _t0 = Date.now();
  Q.markFilling(ath.id);
  let r;
  try {
    const _ctx = await localContextFor(ath);
    r = await fillAthlete(pool, {
      agentId: ath.agent_id, athleteId: ath.id, athleteName: ath.name, runDate,
      athleteProfile: _ctx.profile, agentFirstName,
      signature: SIG.signatureOf(ath),
      // The raw record, same as the nightly path. Without it the on-demand fill
      // wrote pitches with no Instagram link and no content line -- a quietly
      // different message depending on which path produced the card.
      athleteRow: ath.data || null,
      budget, region: _ctx.region, regionFault: _ctx.fault || null,
      // ON-DEMAND NEVER WIDENS. This runs while the agent is watching, on a $0.15
      // cap; a deep search pass costs more than the whole on-demand budget and
      // would stall the page. Widening is the night's job.
      noWiden: true,
      // The resume-on-login fill keeps the cards that waited through the break.
      keepStale: !!opts.keepStale,
      onProgress: (m) => console.log('[queue/ondemand] ' + m),
    });
  } finally {
    Q.unmarkFilling(ath.id);
  }
  const ms = Date.now() - _t0;
  // HOW LONG IT TOOK, on the row, so "how long does an on-demand fill take"
  // is a query over real fills rather than an estimate.
  await pool.query(
    `UPDATE outreach_queue_ondemand SET filled = $3, spent_usd = $4, ms = $5 WHERE athlete_id = $1 AND run_date = $2`,
    [ath.id, runDate, r.filled, budget.spent(), ms]).catch(() => {});
  // An on-demand attempt that spent and placed nothing counts toward the same
  // backoff as a night: the athlete is equally unfillable either way.
  if (!r.paused) {
    // One athlete on its own: there is no roster to compare against, so systemic
    // is false by construction. The per-athlete fault rule still applies.
    await recordAttempt(pool, ath.id, { filled: r.filled, spent: budget.spent(), runDate,
      faults: r.faults || 0, tried: r.tried || [], systemic: false });
  }
  console.log(`[queue/ondemand] athlete=${ath.id} filled=${r.filled} spent=$${budget.spent().toFixed(2)} of $${budget.cap().toFixed(2)} took=${(ms / 1000).toFixed(1)}s`);
  return { filled: r.filled, spent: budget.spent(), claimed: true, note: r.note, tried: r.tried, paused: !!r.paused, ms };
}

// The athlete rows the on-demand path needs: the data, the agent's first name
// for the sign-off, and the signature. One loader, used by the queue page, the
// login resume and the add-athlete trigger, so a card built on any of the
// three is signed the same way.
async function loadAthletesForQueue(pool, agentId, athleteId) {
  const r = await pool.query(
    `SELECT a.id, a.agent_id, a.data, a.data->>'name' AS name,
            a.data->>'hometown' AS hometown, a.data->>'school' AS school,
            u.name AS agent_name, u.email AS agent_email, u.sign_first_name AS agent_sign_first_name,
            u.signature_text, u.scheduling_url
       FROM athletes a LEFT JOIN users u ON u.id = a.agent_id
      WHERE a.agent_id = $1 ${athleteId ? 'AND a.id = $2' : ''} ORDER BY a.created_at ASC`,
    athleteId ? [agentId, athleteId] : [agentId]);
  return r.rows || [];
}

// ── A DORMANT AGENT SIGNS BACK IN ────────────────────────────────────────────
// The nightly run filled them weekly and left their cards alone. Now
// they are here, so every athlete with an open slot gets an on-demand fill at
// once, under ONE shared budget the size of a night, with keepStale so the
// cards that waited for them are not expired in the same second. The nightly
// run resumes on its own tonight because last_login has moved.
async function resumeAgent(pool, agentId, opts = {}) {
  const t0 = Date.now();
  const aths = await loadAthletesForQueue(pool, agentId);
  const budget = opts.budget || Q.newBudget(CAP_USD);
  const out = { athletes: aths.length, withOpenSlots: 0, filled: 0, spent: 0, ms: 0 };
  for (const ath of aths) {
    const held = (await pool.query(HELD_SQL, [ath.id]).catch(() => ({ rows: [] }))).rows;
    if (!openSlotsFor(held).length) continue;
    out.withOpenSlots++;
    if (budget.remaining() <= 0) { console.log(`[queue/resume] agent=${agentId}: budget spent, ${ath.name} left for tonight`); continue; }
    const r = await fillOnDemand(pool, ath, { keepStale: true, budget }).catch((e) => {
      console.error(`[queue/resume] athlete=${ath.id} failed: ${e.message}`); return { filled: 0, spent: 0 };
    });
    out.filled += r.filled || 0;
  }
  out.spent = budget.spent();
  out.ms = Date.now() - t0;
  console.log(`[queue/resume] agent=${agentId} athletes=${out.athletes} openSlots=${out.withOpenSlots} filled=${out.filled} spent=$${out.spent.toFixed(2)} took=${(out.ms / 1000).toFixed(1)}s`);
  return out;
}

async function status(pool) {
  const r = await (pool || store.pool).query(
    `SELECT agent_id, state, COUNT(*)::int AS n FROM outreach_queue GROUP BY agent_id, state ORDER BY agent_id`);
  for (const row of r.rows) console.log(`  ${row.agent_id}  ${row.state}  ${row.n}`);
  return r.rows;
}

module.exports = {
  run, fillAgent, fillAthlete, fillOnDemand, regionForAthlete, claimNight, candidatesFor, applyFaultRule,
  athleteState, recordAttempt, releasePause, expireStaleCards,
  insertCard, slotStillOpen, SLOT_TAKEN_REASON, NAME_REQUIRED, textToParagraphs, inactiveSkip, INACTIVE_AFTER_DAYS,
  openSlotsFor, holdsUnderFive,
  DORMANT_EVERY_DAYS, dormantCadence, restartCardClock,
  loadAthletesForQueue, resumeAgent, localContextFor, athleteProfile,
  ENABLED, CAP_USD, LOOKUP_CEILING_USD, ONDEMAND_CAP_USD,
  today, nightlyWindowOpen, WINDOW_START_HOUR, WINDOW_END_HOUR, CENTRAL_TZ,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const opts = {
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
    agentId: argv.includes('--agent') ? argv[argv.indexOf('--agent') + 1] : null,
  };
  const go = async () => {
    if (argv.includes('--status')) return status();
    if (!opts.dryRun && !argv.includes('--send')) {
      console.error('Refusing to run without --send or --dry-run.');
      process.exit(2);
    }
    if (!opts.dryRun && !ENABLED && !opts.agentId) {
      console.error('OUTREACH_QUEUE_ENABLED is not 1. Set it, or pass --agent <id> to fill one agent.');
      process.exit(2);
    }
    return run(opts);
  };
  go().then(() => process.exit(0)).catch((e) => { console.error('[queue] ' + e.message); process.exit(1); });
}
