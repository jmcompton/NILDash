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
const ai = require('../ai');
const { buildContactLadder } = require('../services/contactLadder');
const { lookupPlace } = require('../services/placesLookup');
const Q = require('../services/outreachQueue');
const PW = require('../services/pitchWriter');
const AR = require('../services/athleteRecord');
const Scout = require('../services/scout');
const { resolveSchool } = require('../services/schoolResolver');
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

// ── Backoff state ────────────────────────────────────────────────────────────
// One row per athlete, written only by the two functions below so the pause
// rule lives in exactly one place.
async function athleteState(pool, athleteId) {
  const r = await pool.query(
    `SELECT athlete_id, consecutive_failures, last_attempt_date, paused_at, paused_reason
       FROM outreach_queue_athlete_state WHERE athlete_id = $1`, [athleteId]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

// Record what an attempt that ACTUALLY SPENT produced. A night with no
// candidates costs nothing and must not count toward the pause, or an athlete
// waiting on their first Deal Scan would be paused for a problem that is not
// theirs. Idempotent per date: re-running the same day cannot double-count.
async function recordAttempt(pool, athleteId, { filled, spent, runDate }) {
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
async function insertCard(pool, { agentId, athleteId, slot, card }) {
  const ins = await pool.query(
    `INSERT INTO outreach_queue
       (agent_id, athlete_id, slot, brand_key, brand_name, why, contact_name, contact_title,
        source_note, affiliation_scope, instagram, instagram_scope, phone, phone_ask_for,
        dm_text, channel, state, angle, angle_key, category_key, ask, lane, program_url,
        sponsor_signal, sponsor_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'queued',$17,$18,$19,$20,
             $21,$22,$23,$24)
     ON CONFLICT DO NOTHING RETURNING id`,
    [agentId, athleteId, slot, card.brandKey, card.brandName, card.why, card.contactName,
     card.contactTitle, card.sourceNote, card.affiliationScope, card.instagram,
     card.instagramScope, card.phone, card.phoneAskFor, card.dmText, card.channel,
     card.angle, card.angleKey, card.categoryKey, card.ask,
     card.lane || 'local', card.programUrl || null,
     card.sponsorSignal || null, card.sponsorNote || null]);
  return (ins.rowCount || 0) > 0;
}

async function fillAthlete(pool, ctx) {
  const { agentId, athleteId, athleteName, budget, region } = ctx;
  const say = ctx.onProgress || (() => {});
  const dry = !!ctx.dryRun;
  // Every business actually tried, with the real reason it was or was not
  // queued. This is the answer to "which businesses and why" -- built once,
  // here, rather than reconstructed later from a log line nobody kept.
  const tried = [];

  // PAUSED ATHLETES COST NOTHING. Checked before the slot query, before the
  // candidate query, and long before any lookup -- the whole point is that a
  // repeatedly-failing athlete stops consuming budget entirely.
  const state = await athleteState(pool, athleteId);
  if (state && state.paused_at) {
    const note = state.paused_reason || Q.pausedNote(state.consecutive_failures);
    say(`${athleteName}: ${note}`);
    return { filled: 0, open: 0, tried, note, paused: true };
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
  const noMarket = !String(region || '').trim();
  const noMarketNote = noMarket
    ? ((ctx.athleteProfile && ctx.athleteProfile.localLaneNote)
       || 'no school we could match, so the local lane has no town to work in')
    : null;
  if (noMarket) say(`${athleteName}: ${noMarketNote} — social and national only`);

  let open = Q.slotsToFill((await pool.query(
    `SELECT slot, state FROM outreach_queue WHERE athlete_id = $1 AND state = 'queued'`,
    [athleteId])).rows);
  if (!open.length) {
    say(`${athleteName}: all three slots already full`);
    return { filled: 0, open: 0, tried, note: 'all three slots already full' };
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
  const slate = await Scout.assembleSlate(pool, {
    agentId,
    athlete: ctx.athleteProfile || { id: athleteId, hasLocalMarket: !!region, school: null },
    store,
    limit: Math.max(open.length, 1) * Q.MAX_ATTEMPTS_PER_SLOT,
  });
  const cands = slate.picks;
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
      emptyReason: slate.emptyReason, noMarket };
  }
  if (slate.signalCount) {
    say(`${athleteName}: ${slate.signalCount} brand(s) have a deal history at their school`
      + (slate.boosted ? `, ${slate.boosted} on tonight's slate` : ''));
  }
  say(`${athleteName}: slate of ${cands.length} — `
    + Object.keys(slate.laneCounts).map((k) => `${slate.laneCounts[k]} ${k}`).join(', '));
  let ci = 0, filled = 0;

  for (const slot of open) {
    let placed = false;
    for (let attempt = 0; attempt < Q.MAX_ATTEMPTS_PER_SLOT && ci < cands.length; attempt++) {
      const cand = cands[ci++];
      // BEFORE the money, priced at the CEILING. A lookup that would breach the
      // cap is never started, so the cap cannot be overshot by one business.
      if (!budget.canSpend(LOOKUP_CEILING_USD)) {
        const why = Q.slotSkipReason(budget, LOOKUP_CEILING_USD);
        say(`slot ${slot} ${why}`);
        return { filled, open: open.length, cappedOut: true, tried, note: why };
      }
      // ── THE LANE DECIDES THE ROUTE ──────────────────────────────────────
      // A social or national brand goes nowhere near Places or the contact
      // ladder. Both are the LOCAL lane: they exist to find the owner of a
      // storefront, and pointed at a national brand they resolve it to whatever
      // shop is nearby. That lane costs money per candidate too, so running it
      // on the wrong lane is a wrong answer we pay for.
      if (cand.lane && cand.lane !== 'local') {
        const pbar = Q.passesProgramBar(cand);
        if (!pbar.ok) {
          say(`${cand.brand_name}: skipped, ${pbar.reason}`);
          tried.push({ brand: cand.brand_name, result: 'rejected', reason: pbar.reason,
            lane: cand.lane, places: { found: false }, risk: 'normal' });
          continue;
        }
        const pmatch = await matchFor(pool, agentId, athleteId, cand.brand_name);
        let ppitch = null;
        try {
          ppitch = await PW.writePitch({
            business: {
              name: cand.brand_name, category: cand.category || null,
              address: null, rating: null, userRatingCount: null,
              ownerName: null, ownerTitle: null,
              siteSummary: cand.offerSummary || null,
              isFranchise: false, sponsorsLocal: null,
            },
            athlete: ctx.athleteProfile || { name: athleteName },
            deal: pmatch,
            agentFirstName: ctx.agentFirstName || null,
            channel: 'dm',
            learnedAngles: await PW.learnedAngles(pool, PW.playbookFor(cand.category || null).key).catch(() => []),
          }, { oneShot: (p2, sys, mt) => ai.oneShot(p2, sys, mt, ai.MODEL_GEN) });
        } catch (e) {
          say(`${cand.brand_name}: writer failed (${e.message}), using the plain fallback`);
          ppitch = null;
        }
        if (ppitch && ppitch.skipped) {
          say(`${cand.brand_name}: nothing worth pitching — ${ppitch.reason}`);
          tried.push({ brand: cand.brand_name, result: 'no_angle', reason: ppitch.reason,
            lane: cand.lane, places: { found: false }, risk: 'normal' });
          continue;
        }
        tried.push({ brand: cand.brand_name, result: 'queued', reason: null,
          lane: cand.lane, places: { found: false }, risk: 'normal' });
        const pcard = Q.buildProgramCard(cand, ppitch, athleteName);
        pcard.lane = cand.lane;
        pcard.sponsorSignal = cand.sponsorSignal ? cand.sponsorSignal.kind : null;
        pcard.sponsorNote = cand.sponsorSignal ? cand.sponsorSignal.detail : null;
        if (dry) { say(`slot ${slot}: ${pcard.brandName} (${pcard.channel})`); placed = true; filled++; break; }
        const pins = await insertCard(pool, { agentId, athleteId, slot, card: pcard });
        if (pins) { placed = true; filled++; say(`slot ${slot}: ${pcard.brandName} (program)`); break; }
        continue;
      }

      // THE CHEAP PASS, BEFORE THE EXPENSIVE ONE. Places is cached 30 days and
      // the deep lookup would call it anyway, so this costs nothing extra --
      // it just moves the call earlier, where its answer can still stop us
      // paying for a business that was never going to produce a contact.
      let place = null;
      try {
        place = await lookupPlace(cand.brand_name || cand.brand_key, region || '');
      } catch (_) { place = null; }
      const pre = Q.prescreen(place);
      const facts = Q.placesFacts(place);
      if (pre.skip) {
        say(`${cand.brand_name}: skipped before spending — ${pre.reason}`);
        tried.push({ brand: cand.brand_name, result: 'prescreen_skip', reason: pre.reason, places: facts, risk: pre.risk });
        continue;
      }

      say(`looking up ${cand.brand_name}…`);
      let out = null;
      try {
        // lean: the queue's cost-tuned source order (chamber+site, then
        // facebook). See LEAN_SOURCE_ORDER in ai.js.
        out = await ai.getBrandContacts(cand.brand_name || cand.brand_key, null,
          region || '', ai.deepContactCtx({ market: null, lean: true }));
      } catch (e) {
        say(`${cand.brand_name}: lookup failed (${e.message})`);
        tried.push({ brand: cand.brand_name, result: 'error', reason: e.message, places: facts, risk: pre.risk });
        continue;
      }
      if (!out.cached) budget.spend(LOOKUP_CEILING_USD);

      const ladder = buildContactLadder(out, {
        rankOf: ai.contactAuthorityRank, rootDomain: ai.rootDomain,
        category: null, brand: cand.brand_name, instagramScope: out.instagramScope || null,
      });
      const ig = { instagram: out.instagram || null, instagramScope: out.instagramScope || null };
      const bar = Q.passesBar(ladder, ig);
      if (!bar.ok) {
        say(`${cand.brand_name}: skipped, ${bar.reason}`);
        tried.push({ brand: cand.brand_name, result: 'rejected', reason: bar.reason, places: facts, risk: pre.risk });
        continue;
      }
      tried.push({ brand: cand.brand_name, result: 'queued', reason: null, places: facts, risk: pre.risk });

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
            ownerName: (Q.namedRows(ladder)[0] || {}).name || null,
            ownerTitle: (Q.namedRows(ladder)[0] || {}).title || null,
            siteSummary: (out && out.siteEmail && out.siteEmail.sourceUrl) ? null : null,
            isFranchise: !!(out && out.siteEmail && out.siteEmail.corporate),
            sponsorsLocal: null,
          },
          athlete: ctx.athleteProfile || { name: athleteName },
          deal: match,
          agentFirstName: ctx.agentFirstName || null,
          channel: 'dm',
          learnedAngles: await PW.learnedAngles(pool,
            PW.playbookFor((place && place.primaryType) || null).key).catch(() => []),
        }, { oneShot: (p2, sys, mt) => ai.oneShot(p2, sys, mt, ai.MODEL_GEN) });
      } catch (e) {
        say(`${cand.brand_name}: writer failed (${e.message}), using the plain fallback`);
        pitch = null;
      }
      if (pitch && pitch.skipped) {
        // A REFUSAL IS A RESULT. Recorded with its reason so "wrote two, both
        // strong" is a claim the log can back up.
        say(`${cand.brand_name}: nothing worth pitching — ${pitch.reason}`);
        tried.push({ brand: cand.brand_name, result: 'no_angle', reason: pitch.reason, places: facts, risk: pre.risk });
        continue;
      }

      const card = Q.buildCard({
        brandKey: cand.brand_key, brand: cand.brand_name,
        rationale: (match && match.reasoning) || null,
        athleteName, pitch,
      }, ladder, ig);
      // The lane is a PROPERTY of the result, and the sponsorship signal is why
      // this one outranked the rest. Both recorded, so the card can say "they
      // already did a deal at Auburn" instead of showing a rank.
      card.lane = cand.lane || 'local';
      card.sponsorSignal = cand.sponsorSignal ? cand.sponsorSignal.kind : null;
      card.sponsorNote = cand.sponsorSignal ? cand.sponsorSignal.detail : null;
      if (dry) { say(`slot ${slot}: ${card.brandName} (${card.channel})`); placed = true; filled++; break; }
      if (await insertCard(pool, { agentId, athleteId, slot, card })) {
        placed = true; filled++;
        say(`slot ${slot}: ${card.brandName} — ${card.channel === 'dm' ? 'DM ready' : 'call'}`
          + (card.contactName ? `, ${card.contactName}` : ''));
      }
      break;
    }
    if (!placed) say(`slot ${slot}: nothing passed the bar in ${Q.MAX_ATTEMPTS_PER_SLOT} attempts`);
  }
  const note = filled > 0 ? null
    : tried.length
      ? `${tried.length} business${tried.length > 1 ? 'es' : ''} tried, none passed the bar`
      : 'no candidates were tried';
  return { filled, open: open.length, tried, note };
}

async function fillAgent(pool, agent, opts) {
  const runDate = opts.runDate || today();
  const dry = !!opts.dryRun;
  if (!dry && !(await claimNight(pool, agent.id, runDate, opts.force))) {
    console.log(`[queue] agent=${agent.id} already filled for ${runDate}, skipping (use --force to re-run)`);
    return { filled: 0, spent: 0, claimed: false };
  }
  const budget = Q.newBudget(CAP_USD);
  // THE WHOLE ATHLETE, not three fields. Every pitch used to say "a college
  // athlete here in your area", which throws away the only thing being sold.
  const athletes = (await pool.query(
    `SELECT id, data, data->>'name' AS name, data->>'hometown' AS hometown,
            data->>'school' AS school
       FROM athletes WHERE agent_id = $1 ORDER BY created_at ASC`,
    [agent.id])).rows;
  const agentFirst = String(agent.name || '').trim().split(/\s+/)[0] || null;
  let filled = 0;
  // ONE ROW PER ATHLETE, even the ones that got nothing. Without this an athlete
  // the job found zero candidates for left no trace anywhere -- not a queued
  // card, not a reason -- so the page had nothing to show but blank space, which
  // reads exactly like the page failing to load rather than like an honest answer.
  const details = [];

  for (const ath of athletes) {
    const before = budget.spent();
    const r = await fillAthlete(pool, {
      agentId: agent.id, athleteId: ath.id, athleteName: ath.name,
      athleteProfile: athleteProfile(ath), agentFirstName: agentFirst,
      // Resolved per athlete. Passing opts.region here meant passing undefined.
      budget, region: regionForAthlete(ath), athleteProfile: athleteProfile(ath), dryRun: dry,
      // ONE card a night. The rest are built when the agent opens the queue,
      // so the night never pays for two cards nobody looks at.
      maxSlots: Q.NIGHTLY_SLOTS,
      onProgress: (m) => console.log('[queue] ' + m),
    });
    filled += r.filled;
    details.push({
      athleteId: ath.id, athleteName: ath.name, filled: r.filled, open: r.open,
      note: r.note || null, tried: r.tried || [], paused: !!r.paused,
    });
    // Only a night that actually spent teaches us anything about this athlete,
    // and a paused one spent nothing by definition.
    if (!dry && !r.paused) {
      await recordAttempt(pool, ath.id, { filled: r.filled, spent: budget.spent() - before, runDate });
    }
    if (r.cappedOut) break;   // the cap is per agent, so one athlete exhausting it stops the rest
  }

  if (!dry) {
    await pool.query(
      `UPDATE outreach_queue_runs SET filled = $3, spent_usd = $4, details = $5
        WHERE agent_id = $1 AND run_date = $2`,
      [agent.id, runDate, filled, budget.spent(), JSON.stringify(details)]).catch((e) =>
        console.error('[queue] failed to persist run details:', e.message));
  }
  console.log(`[queue] agent=${agent.id} filled=${filled} spent=$${budget.spent().toFixed(2)} of $${CAP_USD.toFixed(2)}`);
  return { filled, spent: budget.spent(), claimed: true, details };
}

async function run(opts = {}) {
  const pool = store.pool;
  const agents = opts.agentId
    ? (await pool.query(`SELECT id, name FROM users WHERE id = $1`, [opts.agentId])).rows
    : (await pool.query(
      `SELECT id, name FROM users WHERE role IN ('agent','admin') AND archived IS NOT TRUE ORDER BY created_at ASC`)).rows;
  let filled = 0, spent = 0;
  for (const a of agents) {
    const r = await fillAgent(pool, a, opts).catch((e) => {
      console.error(`[queue] agent=${a.id} failed: ${e.message}`);
      return { filled: 0, spent: 0 };
    });
    filled += r.filled; spent += r.spent;
  }
  console.log(`[queue] run complete agents=${agents.length} filled=${filled} spent=$${spent.toFixed(2)}`);
  return { agents: agents.length, filled, spent };
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
  const claim = await pool.query(
    `INSERT INTO outreach_queue_ondemand (athlete_id, run_date) VALUES ($1,$2)
     ON CONFLICT (athlete_id, run_date) DO NOTHING`, [ath.id, runDate]).catch(() => ({ rowCount: 0 }));
  if (!(claim.rowCount > 0)) return { filled: 0, spent: 0, claimed: false };

  const budget = Q.newBudget(ONDEMAND_CAP_USD);
  const r = await fillAthlete(pool, {
    agentId: ath.agent_id, athleteId: ath.id, athleteName: ath.name,
    athleteProfile: athleteProfile(ath), agentFirstName: ath.agent_first_name || null,
    budget, region: regionForAthlete(ath), athleteProfile: athleteProfile(ath),
    onProgress: (m) => console.log('[queue/ondemand] ' + m),
  });
  await pool.query(
    `UPDATE outreach_queue_ondemand SET filled = $3, spent_usd = $4 WHERE athlete_id = $1 AND run_date = $2`,
    [ath.id, runDate, r.filled, budget.spent()]).catch(() => {});
  // An on-demand attempt that spent and placed nothing counts toward the same
  // backoff as a night: the athlete is equally unfillable either way.
  if (!r.paused) {
    await recordAttempt(pool, ath.id, { filled: r.filled, spent: budget.spent(), runDate });
  }
  console.log(`[queue/ondemand] athlete=${ath.id} filled=${r.filled} spent=$${budget.spent().toFixed(2)} of $${ONDEMAND_CAP_USD.toFixed(2)}`);
  return { filled: r.filled, spent: budget.spent(), claimed: true, note: r.note, tried: r.tried, paused: !!r.paused };
}

async function status(pool) {
  const r = await (pool || store.pool).query(
    `SELECT agent_id, state, COUNT(*)::int AS n FROM outreach_queue GROUP BY agent_id, state ORDER BY agent_id`);
  for (const row of r.rows) console.log(`  ${row.agent_id}  ${row.state}  ${row.n}`);
  return r.rows;
}

module.exports = {
  run, fillAgent, fillAthlete, fillOnDemand, regionForAthlete, claimNight, candidatesFor,
  athleteState, recordAttempt,
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
