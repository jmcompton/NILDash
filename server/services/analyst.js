'use strict';
// ── THE ANALYST ──────────────────────────────────────────────────────────────
//
// It keeps ONE excellent media kit per athlete, current, in the Media Kit tab.
// The agent hits copy link and sends it wherever they like. It does not touch
// email or outreach.
//
// WHY IT REPORTED NOTHING EVERY NIGHT. The shift report counted
// athlete_activity_log rows of type 'media_kit_built'. Exactly one thing in the
// tree ever wrote that row: assistantActions, when an agent explicitly asked the
// assistant to build a kit. So the "Analyst" was a counter of a manual action
// nobody performs at 3am. There was no Analyst. There is one now, and this is
// it: a nightly pass that decides whether each kit still tells the truth and
// rebuilds the ones that do not.
//
// EVERY NUMBER TRACES TO A STORED FIELD. Same rule the Writer works under, for
// the same reason: this is opened by a business owner, and a follower count we
// made up is a lie told on the athlete's behalf. If the data is thin the kit is
// SHORTER. It is never padded.
//
// WHAT IS ON IT: photo, school, sport, position, year, total reach, real
// engagement, and local audience only when local is the point.
//
// WHAT IS NOT: deliverables, prices, packages. What gets done and for how much
// is the agent's negotiation. A kit that opens with a rate card has made the
// first offer before the agent has said hello.

// A refresh is worth doing when something a reader would notice has changed.
// Below this, a follower count moving is noise -- rebuilding a kit because
// somebody gained eleven followers is churn that makes "refreshed" meaningless
// in the shift report.
const FOLLOWER_DRIFT_PCT = 5;
const FOLLOWER_DRIFT_MIN = 250;
// Even with nothing changed, a kit that has sat for a season is suspect.
const MAX_AGE_DAYS = 90;

// Data URLs run to megabytes, so the comparison is over a digest, never the
// image itself.
function photoHash(url) {
  if (!url) return null;
  try {
    return require('crypto').createHash('sha256').update(String(url)).digest('hex').slice(0, 16);
  } catch (_) { return null; }
}

function n(v) {
  const x = typeof v === 'string' ? parseInt(v.replace(/[^0-9-]/g, ''), 10) : v;
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : null;
}

// Engagement is stored as either a number or a string like "4.2%". Both are
// read; anything unparseable is ABSENT rather than zero, because 0% engagement
// is a claim and a missing value is not.
//
// ── AND 0 IS STILL NOT PRINTED, WHICH IS A DISPLAY DECISION ────────────────
// Storage now tells a real 0 apart from a blank field -- see _validEngagement in
// index.js -- and that distinction is worth having. It does NOT follow that the
// kit should print "Engagement: 0%" on a document going to a brand under the
// agent's name. `x <= 0` stays, deliberately, and tests/analyst.js records it.
function pct(v) {
  if (v === null || v === undefined || v === '') return null;
  const x = typeof v === 'string' ? parseFloat(v.replace(/[^0-9.]/g, '')) : Number(v);
  if (!Number.isFinite(x) || x <= 0 || x > 100) return null;
  return Math.round(x * 10) / 10;
}

function fmt(v) {
  if (v === null) return null;
  if (v >= 1000000) return (v / 1000000).toFixed(v % 1000000 === 0 ? 0 : 1) + 'M';
  if (v >= 10000) return Math.round(v / 1000) + 'K';
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(v);
}

// ── LOCATION IS CONDITIONAL, AND TODAY IT IS ALWAYS OMITTED ──────────────────
//
// The spec: lead with local reach when a local business is the reader AND the
// followers are genuinely nearby; leave it out when the audience is scattered;
// ignore it entirely for social and national brands.
//
// WE CANNOT ANSWER THE MIDDLE QUESTION. Nothing in this product stores where an
// athlete's followers are. Follower counts are typed in by hand (see the
// athlete profile save in index.js) -- there is no API pull of any kind, and no
// Instagram connection exists anywhere in the tree.
//
// Instagram exposes audience location ONLY through the Graph API, ONLY for a
// business or creator account that has itself authorized the app, and it is
// suppressed entirely below Meta's reporting minimum. It cannot be read for a
// third party from a username. So it requires the ATHLETE to connect their own
// account, which is a product decision and not mine to make.
//
// Therefore: this returns 'omit' with a reason, for every athlete, until real
// audience data exists. The shape is here so that when it does, only the data
// source changes. What it will NOT do is guess -- inferring "her followers are
// local because she goes to Auburn" is exactly the invented statistic the
// honesty rule forbids, and it is the one a business owner would test first.
function decideLocation(athlete, audience, opts = {}) {
  const reader = opts.reader || null;      // 'local' | 'social' | 'national' | null

  // For a social or DTC brand, location is not a selling point at all -- they
  // ship product and do not care where the audience lives.
  if (reader && reader !== 'local') {
    return { show: false, reason: 'the reader is a ' + reader
      + ' brand, so where the audience lives is not the point', lead: null };
  }
  if (!audience || !audience.nearby || !audience.nearby.count) {
    return { show: false, lead: null,
      reason: 'we hold no audience-location data for this athlete, and guessing '
        + 'it from their school would be inventing a statistic' };
  }
  const share = audience.total ? audience.nearby.count / audience.total : 0;
  // Scattered is a real answer, not a failure. A national audience is a fine
  // thing to have; it is just not the thing to lead a coffee shop with.
  if (share < (opts.minLocalShare || 0.25)) {
    return { show: false, lead: null,
      reason: `only ${Math.round(share * 100)}% of the audience is nearby, so the `
        + 'local angle would be the weakest thing on the page' };
  }
  return {
    show: true,
    lead: `${fmt(audience.nearby.count)} followers within ${audience.nearby.radiusMiles} miles`,
    share,
    reason: `${Math.round(share * 100)}% of the audience is inside `
      + `${audience.nearby.radiusMiles} miles, so local is the strongest fact we have`,
  };
}

// ── The kit ──────────────────────────────────────────────────────────────────
// Composed from stored fields ONLY. Anything absent is left off; there is no
// default, no placeholder and no "N/A" row -- an empty field on a kit teaches a
// business owner that the numbers are decoration.
function composeKit(athlete, opts = {}) {
  const a = athlete || {};
  const ig = n(a.instagram);
  const tt = n(a.tiktok);
  const tw = n(a.twitter);
  // "Total reach ACROSS PLATFORMS" means every platform we hold, not just the
  // two the athlete record happens to name first.
  const reach = (ig || 0) + (tt || 0) + (tw || 0) || null;
  const eng = pct(a.engagement);

  const facts = [];
  const add = (key, label, value, source) => {
    if (value === null || value === undefined || value === '') return;
    facts.push({ key, label, value, source });
  };

  add('school', 'School', a.school || null, 'athletes.data.school');
  add('sport', 'Sport', a.sport || null, 'athletes.data.sport');
  add('position', 'Position', a.position || null, 'athletes.data.position');
  add('year', 'Year', a.year || null, 'athletes.data.year');
  // DATED, NOT BARE. A follower count is right on the day it is typed and wrong
  // from then on, and an undated one on a document that gets forwarded reads as
  // current. The caveat disappears on its own when the number starts coming from
  // a connected Instagram -- see services/reachProvenance.
  const RP = require('./reachProvenance');
  const prov = RP.reachProvenance(a, opts.now);
  add('reach', 'Total reach', reach === null ? null : RP.withAsOf(fmt(reach), a, opts.now),
    'instagram + tiktok + twitter');
  // ── DATED, LIKE REACH, OR NOT SHOWN AT ALL ──────────────────────────────
  //
  // `add` already omits a null, so an absent rate has never printed -- but
  // until the storage fix every athlete carried an invented 3.0 and this row
  // printed it as a measured fact on a document that gets forwarded to brands.
  //
  // The rows written before that fix are still 3.0 with no date. An undated rate
  // is now shown WITH its caveat rather than bare, which is the same treatment
  // the follower count gets and which makes a laundered default visible to the
  // person reading the kit instead of invisible.
  const engProv = RP.engagementProvenance(a, opts.now);
  add('engagement', 'Engagement',
    eng === null ? null : eng + '%' + (engProv.label ? ` (${engProv.label})` : ''),
    'athletes.data.engagement');

  const audience = opts.audience || null;
  const loc = decideLocation(a, audience, opts);
  if (loc.show) add('local', 'Local audience', loc.lead, 'audience.nearby');

  return {
    athleteId: a.id || null,
    name: a.name || null,
    photo: a.photo || a.photoUrl || null,
    facts,
    // The lead line, when local is genuinely the point. Null otherwise, and the
    // kit leads with reach instead.
    lead: loc.show ? loc.lead
      : (reach !== null ? RP.withAsOf(fmt(reach) + ' total reach', a, opts.now) : null),
    location: loc,
    // The kit renders this in its footer, so a reader can see who supplied the
    // numbers and when without reading the fact rows.
    reachProvenance: prov,
    // So the kit footer can say who supplied the RATE and when, separately from
    // the follower count -- they move independently.
    engagementProvenance: engProv,
    // What a reader can verify, and what we deliberately left off.
    reach, engagement: eng, instagram: ig, tiktok: tt, twitter: tw,
    thin: facts.length < 3,
  };
}

// ── HONESTY, ENFORCED NOT REQUESTED ──────────────────────────────────────────
// Same shape as the Writer's fact check: every number on the kit has to trace
// to a field we actually hold. Asking nicely is not enforcement, so this reads
// the composed kit back and fails it if a figure appears that the athlete
// record cannot account for.
function lintKit(kit, athlete) {
  const problems = [];
  const a = athlete || {};
  const ig = n(a.instagram), tt = n(a.tiktok), tw = n(a.twitter);
  const reach = (ig || 0) + (tt || 0) + (tw || 0) || null;
  const eng = pct(a.engagement);

  for (const f of kit.facts) {
    if (f.value === null || f.value === undefined || f.value === '') {
      problems.push(`${f.label} is on the kit with no value`);
    }
  }
  const has = (k) => kit.facts.some((f) => f.key === k);
  if (has('reach') && reach === null) problems.push('reach is shown but no follower count is stored');
  if (has('engagement') && eng === null) problems.push('engagement is shown but none is stored');
  if (has('local') && !(kit.location && kit.location.show)) {
    problems.push('a local audience figure is shown without audience data behind it');
  }
  // THE PRICE BAN. Deliverables and rates are the agent's negotiation; a kit
  // that names a number has opened it for them.
  const text = JSON.stringify(kit.facts);
  if (/\$\s?\d|\bper post\b|\bpackage\b|\brate\b|\bfee\b/i.test(text)) {
    problems.push('the kit names a price or a deliverable, which is the agent\'s negotiation and not the kit\'s job');
  }
  return { ok: problems.length === 0, problems };
}

// ── Is this kit still true? ──────────────────────────────────────────────────
// The agent should never build one, so something has to notice when it has gone
// stale. Each reason is named, because "refreshed 4 kits" is only useful if the
// report can say why.
function stalenessOf(kit, athlete, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const reasons = [];
  if (!kit) return { stale: true, reasons: ['no kit exists yet'], first: true };

  const storedIg = n(athlete.instagram);
  const kitIg = n(kit.instagram_followers);
  if (storedIg !== null && kitIg !== null) {
    const drift = Math.abs(storedIg - kitIg);
    const pctDrift = kitIg ? (drift / kitIg) * 100 : 100;
    if (drift >= FOLLOWER_DRIFT_MIN || pctDrift >= FOLLOWER_DRIFT_PCT) {
      reasons.push(`follower count moved from ${fmt(kitIg)} to ${fmt(storedIg)}`);
    }
  } else if (storedIg !== null && kitIg === null) {
    reasons.push('a follower count is on file now and the kit has none');
  }

  const storedTt = n(athlete.tiktok);
  const kitTt = n(kit.tiktok_followers);
  if (storedTt !== null && kitTt === null) reasons.push('a TikTok following is on file now');
  else if (storedTt !== null && kitTt !== null && Math.abs(storedTt - kitTt) >= FOLLOWER_DRIFT_MIN) {
    reasons.push(`TikTok following moved from ${fmt(kitTt)} to ${fmt(storedTt)}`);
  }

  const storedEng = pct(athlete.engagement);
  const kitEng = pct(kit.instagram_engagement);
  if (storedEng !== null && storedEng !== kitEng) {
    reasons.push(kitEng === null ? 'an engagement rate is on file now'
      : `engagement moved from ${kitEng}% to ${storedEng}%`);
  }

  // A NEW PHOTO IS THE WHOLE KIT -- it is the thing carrying the page, so a new
  // one is always worth a rebuild. The photo is ATHLETE-UPLOADED and lives on
  // media_kits.headshot_url as a data URL; the Analyst never writes it, it only
  // notices that it changed, by hash.
  const nowHash = kit.photoHash || photoHash(kit.headshot_url);
  if (nowHash && !kit.photo_hash_at_build) reasons.push('a photo was added');
  else if (nowHash && kit.photo_hash_at_build && nowHash !== kit.photo_hash_at_build) {
    reasons.push('a new photo was added');
  }

  // Stats and the season. A kit built in March that still says "sophomore" in
  // October is the kind of small wrongness a business owner notices.
  if (athlete.year && kit.year_at_build && athlete.year !== kit.year_at_build) {
    reasons.push(`year changed to ${athlete.year}`);
  }
  if (athlete.position && kit.position_at_build && athlete.position !== kit.position_at_build) {
    reasons.push(`position changed to ${athlete.position}`);
  }
  if (athlete.school && kit.school_at_build && athlete.school !== kit.school_at_build) {
    reasons.push(`school changed to ${athlete.school}`);
  }

  const built = kit.updated_at ? new Date(kit.updated_at) : null;
  const ageDays = built ? (now.getTime() - built.getTime()) / 86400000 : null;
  if (ageDays !== null && ageDays > (opts.maxAgeDays || MAX_AGE_DAYS)) {
    reasons.push(`it has not been rebuilt in ${Math.round(ageDays)} days`);
  }

  return { stale: reasons.length > 0, reasons, first: false, ageDays };
}

// ── The nightly pass ─────────────────────────────────────────────────────────
// Reads every athlete, decides, rebuilds what is stale, and returns what it did
// in words so the shift report can say something true.
async function refreshAll(pool, agentId, opts = {}) {
  const AR = require('./athleteRecord');
  const { resolveSchool } = require('./schoolResolver');

  // headshot_url is a data URL and can be megabytes, so it is NOT selected --
  // only whether one exists and its hash, computed in SQL. Pulling 45 base64
  // images into memory nightly to answer "did the photo change" would be a
  // self-inflicted outage.
  const rows = (await pool.query(
    `SELECT a.id, a.data, a.instagram_followers, a.tiktok_followers,
            k.id AS kit_id, k.instagram_followers AS kit_ig, k.tiktok_followers AS kit_tt,
            k.instagram_engagement AS kit_eng, k.updated_at AS kit_updated,
            k.slug, k.year_at_build, k.position_at_build, k.school_at_build,
            k.photo_hash_at_build,
            CASE WHEN k.headshot_url IS NULL THEN NULL
                 ELSE substr(encode(sha256(k.headshot_url::bytea), 'hex'), 1, 16) END AS photo_hash
       FROM athletes a
       LEFT JOIN media_kits k ON k.athlete_id = a.id
      WHERE a.agent_id = $1
      ORDER BY a.created_at ASC`, [agentId])).rows;

  const out = { checked: rows.length, refreshed: 0, built: 0, skipped: 0,
    failed: 0, details: [], thin: [] };

  for (const r of rows) {
    const rec = AR.resolveAthlete(
      { id: r.id, data: r.data, instagram_followers: r.instagram_followers,
        tiktok_followers: r.tiktok_followers },
      { schoolLocation: resolveSchool });
    rec.twitter = (r.data && (r.data.twitter || r.data.twitter_followers)) || null;
    rec.hasPhoto = !!r.photo_hash;

    const kit = r.kit_id ? {
      id: r.kit_id, instagram_followers: r.kit_ig, tiktok_followers: r.kit_tt,
      instagram_engagement: r.kit_eng, updated_at: r.kit_updated,
      slug: r.slug, year_at_build: r.year_at_build,
      position_at_build: r.position_at_build, school_at_build: r.school_at_build,
      photoHash: r.photo_hash, photo_hash_at_build: r.photo_hash_at_build,
    } : null;

    const st = stalenessOf(kit, rec, opts);
    if (!st.stale) { out.skipped++; continue; }

    // AUDIENCE DATA IS PASSED IN, NEVER INVENTED. Today nothing supplies it, so
    // decideLocation omits location and says why.
    const composed = composeKit(rec, { audience: opts.audience ? opts.audience(rec) : null });
    const lint = lintKit(composed, rec);
    if (!lint.ok) {
      out.failed++;
      out.details.push({ athleteId: r.id, name: rec.name, result: 'failed',
        why: lint.problems.join('; ') });
      console.error(`[analyst] ${rec.name || r.id} kit failed the honesty check: ${lint.problems.join('; ')}`);
      continue;
    }
    if (composed.thin) {
      out.thin.push({ athleteId: r.id, name: rec.name,
        have: composed.facts.map((f) => f.label) });
    }

    if (opts.dryRun) {
      out.details.push({ athleteId: r.id, name: rec.name,
        result: st.first ? 'would-build' : 'would-refresh', why: st.reasons.join('; ') });
      if (st.first) out.built++; else out.refreshed++;
      continue;
    }

    const saved = await saveKit(pool, r.id, composed, rec, kit).catch((e) => {
      console.error(`[analyst] could not save kit for ${r.id}: ${e.message}`);
      return null;
    });
    if (!saved) { out.failed++; continue; }
    if (st.first) out.built++; else out.refreshed++;
    out.details.push({ athleteId: r.id, name: rec.name, slug: saved.slug,
      result: st.first ? 'built' : 'refreshed', why: st.reasons.join('; ') });

    // The one row the shift report has always counted and nothing ever wrote.
    await pool.query(
      `INSERT INTO athlete_activity_log (athlete_id, agent_id, activity_type, metadata)
       VALUES ($1,$2,'media_kit_built',$3::jsonb)`,
      [r.id, agentId, JSON.stringify({ reasons: st.reasons, auto: true })]
    ).catch(() => {});
  }
  return out;
}

function slugFor(name, athleteId) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const tail = String(athleteId || '').replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase();
  return (base || 'athlete') + (tail ? '-' + tail : '');
}

async function saveKit(pool, athleteId, kit, athlete, existing) {
  const slug = (existing && existing.slug) || slugFor(kit.name, athleteId);
  // THE PHOTO IS NOT IN THIS STATEMENT. headshot_url and action_shot_data are
  // uploaded by the athlete and the Analyst has no business overwriting them --
  // a nightly job that wiped an athlete's headshot because it had none of its
  // own would be the single most destructive thing in this file. It records the
  // HASH so it can notice the next change, and touches nothing else.
  const r = await pool.query(
    `INSERT INTO media_kits
       (athlete_id, instagram_handle, instagram_followers, instagram_engagement,
        tiktok_handle, tiktok_followers, slug, theme,
        year_at_build, position_at_build, school_at_build, photo_hash_at_build,
        built_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'nildash',$8,$9,$10,$11,'analyst',NOW())
     ON CONFLICT (athlete_id) DO UPDATE SET
       instagram_handle = COALESCE(EXCLUDED.instagram_handle, media_kits.instagram_handle),
       instagram_followers = EXCLUDED.instagram_followers,
       instagram_engagement = EXCLUDED.instagram_engagement,
       tiktok_handle = COALESCE(EXCLUDED.tiktok_handle, media_kits.tiktok_handle),
       tiktok_followers = EXCLUDED.tiktok_followers,
       slug = COALESCE(media_kits.slug, EXCLUDED.slug),
       year_at_build = EXCLUDED.year_at_build,
       position_at_build = EXCLUDED.position_at_build,
       school_at_build = EXCLUDED.school_at_build,
       photo_hash_at_build = EXCLUDED.photo_hash_at_build,
       built_by = 'analyst',
       updated_at = NOW()
     RETURNING slug`,
    [athleteId, athlete.instagramHandle || null, kit.instagram, kit.engagement,
     athlete.tiktokHandle || null, kit.tiktok, slug,
     athlete.year || null, athlete.position || null, athlete.school || null,
     (existing && existing.photoHash) || null]);
  return { slug: (r.rows[0] && r.rows[0].slug) || slug };
}

module.exports = {
  composeKit, lintKit, stalenessOf, decideLocation, refreshAll, saveKit, slugFor,
  fmt, pct, n,
  FOLLOWER_DRIFT_PCT, FOLLOWER_DRIFT_MIN, MAX_AGE_DAYS,
};
