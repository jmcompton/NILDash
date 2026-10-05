'use strict';
// ── A UNIVERSITY'S BUSINESS LIST: LOCAL AND SOCIAL, AND NOTHING ELSE ────────
//
// build(pool, universityId, { budgetUsd }) -- one capped build, in order:
//   1. LOCAL POOL: Places around the campus address (campusPool.deepen), ring
//      by ring, a ring bought only when the cap can cover its worst case.
//   2. THE BLOCK, re-decided for every row (teamScan.recheckPool ->
//      blockedFor): alcohol, cannabis, gambling..., every school and athletic
//      department, collectives, media and rankings (notASponsor), household
//      incumbents (Nike: signingEvidence) and national chain locations
//      (nationalChains) -- the same refusals the agent side applies.
//   3. NAMED DECISION MAKERS: contacts resolved (campusContacts.resolveAndStore,
//      the owner ladder) for the best-fitting businesses within DRIVE_KM of
//      campus, best first, until the cap. A business counts only with a
//      named person and a way to reach them.
//   4. SOCIAL: brands from the social index that sign athletes at this level
//      (a stated tier that takes a small following, verified in the last 12
//      months, a public program to apply to), never an incumbent. No cost.
// Prints, and returns, what it spent against the cap.

const DRIVE_KM = parseFloat(process.env.CAMPUS_DRIVE_KM) || 25;          // ~15 miles
const LEVEL_REACH = parseInt(process.env.CAMPUS_SOCIAL_REACH, 10) || 2500; // a community-college athlete's typical following
const BUILD_RINGS = [8000, 16000, 24000];

async function ensureTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS university_social_brands (
    university_id TEXT NOT NULL, brand TEXT NOT NULL, website TEXT, program_url TEXT, category TEXT,
    tier_min INTEGER, tier_max INTEGER, sports TEXT[], proof_date DATE, offer TEXT, evidence TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (university_id, brand))`);
}

// ── SOCIAL BRANDS THAT SIGN ATHLETES AT THIS LEVEL ──────────────────────────
async function socialList(pool, uni) {
  await ensureTables(pool);
  const SE = require('./signingEvidence');
  const TS = require('./teamScan');
  const sports = (await pool.query(`SELECT DISTINCT LOWER(sport) AS s FROM university_teams WHERE university_id = $1`, [uni.id])).rows.map((r) => r.s).filter(Boolean);
  const rows = (await pool.query(
    `SELECT * FROM social_brands
      WHERE active IS NOT FALSE AND tier_stated = TRUE AND proof_url IS NOT NULL
        AND proof_date >= (CURRENT_DATE - INTERVAL '12 months')
        AND COALESCE(tier_min, 0) <= $1
      ORDER BY proof_date DESC`, [LEVEL_REACH]).catch(() => ({ rows: [] }))).rows;
  const kept = [], refused = [];
  for (const b of rows) {
    if (SE.incumbent(b.brand)) { refused.push({ brand: b.brand, why: 'household incumbent' }); continue; }
    const blk = TS.blockedFor({ name: b.brand });
    if (blk) { refused.push({ brand: b.brand, why: blk.key }); continue; }
    const bs = (b.sports || []).map((s) => String(s).toLowerCase());
    if (bs.length && sports.length && !bs.some((s) => sports.some((t) => t.includes(s) || s.includes(t)))) continue;
    kept.push(b);
  }
  await pool.query(`DELETE FROM university_social_brands WHERE university_id = $1`, [uni.id]);
  for (const b of kept) {
    await pool.query(
      `INSERT INTO university_social_brands (university_id, brand, website, program_url, category, tier_min, tier_max, sports, proof_date, offer, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (university_id, brand) DO NOTHING`,
      [uni.id, b.brand, b.website, b.proof_url, b.category, b.tier_min, b.tier_max, b.sports || null, b.proof_date, b.offer_summary,
        `program takes ${b.tier_min || 0}${b.tier_max ? '-' + b.tier_max : '+'} followers, verified ${String(b.proof_date).slice(0, 10)}: ${b.proof_url}`]);
  }
  return { kept: kept.length, refused };
}

// ── THE BUILD ───────────────────────────────────────────────────────────────
async function build(pool, universityId, opts = {}) {
  const CP = require('./campusPool');
  const TS = require('./teamScan');
  const CC = require('./campusContacts');
  const Q = require('./outreachQueue');
  const budget = Number(opts.budgetUsd) > 0 ? Number(opts.budgetUsd) : 12;
  await CP.ensureTables(pool);
  await TS.ensureTables(pool);
  const uni = await CP.universityOf(pool, universityId);
  if (!uni) return { ok: false, error: `No university "${universityId}".` };
  if (!uni.location || !/\d/.test(uni.location)) return { ok: false, error: `${uni.name} has no campus street address (location is "${uni.location || ''}"): set it with create-university first.` };
  const run = (await pool.query(`INSERT INTO university_market_runs (university_id, kind, summary) VALUES ($1,'build',$2) RETURNING id`,
    [uni.id, { budgetUsd: budget, started: true }])).rows[0].id;
  // 1. The local pool: at most half the cap on Places, the rest on people.
  const poolBudget = Math.min(budget * 0.5, Number(opts.poolBudgetUsd) || Infinity);
  // Default rings (8 km outward) and only the rings not already covered, so a
  // second build never re-buys the first ring.
  const deep = await CP.deepen(pool, uni.id, { budgetUsd: poolBudget, rings: opts.rings, places: opts.places });
  const placesUsd = (deep && deep.costUsd) || 0;
  // 2. The block, for every row (a rule added today reaches last month's rows).
  const re = await TS.recheckPool(pool, uni.marketKey).catch((e) => ({ error: e.message }));
  // 3. Named decision makers, best first, inside driving distance, to the cap.
  await CC.seedRows(pool, uni);
  const todo = (await pool.query(
    `SELECT c.brand, c.place_id FROM university_contacts c
       JOIN university_market_seen m ON m.market_key = c.market_key AND m.brand = c.brand
      WHERE c.university_id = $1 AND m.blocked_reason IS NULL AND (c.status IS NULL OR c.status = 'pending')
        AND (m.distance_m IS NULL OR m.distance_m <= $2)
      ORDER BY m.fit DESC NULLS LAST, m.distance_m ASC NULLS LAST`, [uni.id, DRIVE_KM * 1000])).rows;
  const city = TS.cityOf(uni.location) || uni.location;
  let contactUsd = 0, resolved = 0, reachable = 0, stoppedFor = null;
  const perLookup = CC.perBusinessUsd('high', false).metered;
  for (const row of todo) {
    // A lookup is bought only when the cap can cover a dear one.
    if (placesUsd + contactUsd + perLookup > budget) { stoppedFor = 'budget'; break; }
    const r = await CC.resolveAndStore(pool, uni.id, row, { city, ai: opts.ai, history: false, marketKey: uni.marketKey });
    contactUsd += r.costUsd || 0; resolved++;
    if (r.reachable) reachable++;
  }
  // 4. Social.
  const social = await socialList(pool, uni);
  const r2 = (x) => Math.round(x * 100) / 100;
  const summary = {
    university: uni.name, marketKey: uni.marketKey, budgetUsd: budget,
    spentUsd: r2(placesUsd + contactUsd), placesUsd: r2(placesUsd), contactUsd: r2(contactUsd),
    placesCalls: (deep && deep.placesCalls) || 0, poolSteps: (deep && deep.steps) || [], poolError: deep && !deep.ok ? deep.error : null,
    newlyBlocked: (re && Array.isArray(re.newlyBlocked) ? re.newlyBlocked.length : Number(re && re.newlyBlocked) || 0), blockedTotal: (re && Number(re.blocked)) || 0,
    contactsTried: resolved, contactsFound: reachable, contactsLeft: todo.length - resolved, stoppedFor,
    social: social.kept, socialRefused: social.refused.length, driveKm: DRIVE_KM,
  };
  await pool.query(`UPDATE university_market_runs SET finished_at = NOW(), summary = $2 WHERE id = $1`, [run, summary]);
  console.log(`[campus-build] ${uni.name}: spent $${summary.spentUsd} of $${budget} (Places $${summary.placesUsd}, contacts $${summary.contactUsd}); `
    + `${reachable} of ${resolved} businesses with a named person; ${social.kept} social brands`);
  return { ok: true, ...summary };
}

// ── WHAT A UNIVERSITY HAS, AND WHAT IT STILL NEEDS ──────────────────────────
async function verify(pool, universityId) {
  const CP = require('./campusPool');
  await CP.ensureTables(pool).catch(() => {});
  await ensureTables(pool);
  const uni = await CP.universityOf(pool, universityId);
  if (!uni) return { ok: false, error: `No university "${universityId}".` };
  const row = (await pool.query(`SELECT * FROM universities WHERE id = $1`, [uni.id])).rows[0] || {};
  const one = async (sql, p) => Number(((await pool.query(sql, p).catch(() => ({ rows: [{ n: 0 }] }))).rows[0] || {}).n) || 0;
  const teams = await one(`SELECT COUNT(*)::int n FROM university_teams WHERE university_id = $1`, [uni.id]);
  const athletes = await one(`SELECT COUNT(*)::int n FROM university_athletes WHERE university_id = $1`, [uni.id]);
  const found = await one(`SELECT COUNT(*)::int n FROM university_market_seen WHERE market_key = $1 AND blocked_reason IS NULL`, [uni.marketKey]);
  const blocked = await one(`SELECT COUNT(*)::int n FROM university_market_seen WHERE market_key = $1 AND blocked_reason IS NOT NULL`, [uni.marketKey]);
  const named = await one(`SELECT COUNT(*)::int n FROM university_contacts c JOIN university_market_seen m ON m.market_key = c.market_key AND m.brand = c.brand
                             WHERE c.university_id = $1 AND c.reachable AND m.blocked_reason IS NULL`, [uni.id]);
  const social = await one(`SELECT COUNT(*)::int n FROM university_social_brands WHERE university_id = $1`, [uni.id]);
  const cards = await one(`SELECT COUNT(*)::int n FROM university_drafts WHERE university_id = $1 AND kind = 'pitch'
                             AND night = (SELECT MAX(night) FROM university_drafts WHERE university_id = $1 AND night IS NOT NULL)`, [uni.id]);
  const cardsAll = await one(`SELECT COUNT(*)::int n FROM university_drafts WHERE university_id = $1 AND kind = 'pitch'`, [uni.id]);
  const staff = await one(`SELECT COUNT(*)::int n FROM users WHERE university_id = $1 AND role IN ('university','university_admin')`, [uni.id]);
  const lastBuild = (await pool.query(`SELECT summary, finished_at FROM university_market_runs WHERE university_id = $1 AND kind = 'build' ORDER BY id DESC LIMIT 1`, [uni.id]).catch(() => ({ rows: [] }))).rows[0] || null;
  const lastNight = (await pool.query(`SELECT summary, finished_at FROM university_market_runs WHERE university_id = $1 AND kind = 'nightly' ORDER BY id DESC LIMIT 1`, [uni.id]).catch(() => ({ rows: [] }))).rows[0] || null;
  // What stands between this university and cards, in order.
  const needs = [];
  if (!uni.location || !/\d/.test(uni.location)) needs.push(`a campus street address (location is "${uni.location || ''}"): POST /api/admin/create-university`);
  if (row.lat == null && !(lastBuild && lastBuild.summary && lastBuild.summary.placesCalls)) needs.push('the campus geocoded (create-university does it)');
  if (!teams) needs.push('teams and rosters: POST /api/admin/university-roster-import');
  if (!found) needs.push('a business list: POST /api/admin/university-business-build');
  if (!staff) needs.push('a staff account to sign in: POST /api/admin/create-university-user');
  return { ok: true, university: uni.name, id: uni.id, location: uni.location, marketKey: uni.marketKey,
    center: row.lat != null ? { lat: row.lat, lng: row.lng } : null,
    teams, athletes, businessesFound: found, businessesBlocked: blocked, businessesWithNamedContact: named, socialBrands: social,
    cardsLatestNight: cards, cardsAllTime: cardsAll, staff,
    lastBuild: lastBuild && lastBuild.summary, lastNight: lastNight && lastNight.summary,
    nightlyReady: !!(teams && found), needs };
}

function formatVerify(v) {
  if (!v.ok) return v.error;
  const L = [];
  L.push(`${v.university} (${v.id})  ${v.location || '(no address)'}${v.center ? `  centre ${v.center.lat.toFixed(5)}, ${v.center.lng.toFixed(5)}` : ''}`);
  L.push(`  teams                          ${v.teams}`);
  L.push(`  athletes                       ${v.athletes}`);
  L.push(`  businesses found (local)       ${v.businessesFound}   (${v.businessesBlocked} withdrawn by the block)`);
  L.push(`  with a named contact           ${v.businessesWithNamedContact}`);
  L.push(`  social brands at this level    ${v.socialBrands}`);
  L.push(`  cards, latest night            ${v.cardsLatestNight}   (all time ${v.cardsAllTime})`);
  L.push(`  staff accounts                 ${v.staff}`);
  if (v.lastBuild) L.push(`  last build spent               $${v.lastBuild.spentUsd} of $${v.lastBuild.budgetUsd} (Places $${v.lastBuild.placesUsd}, contacts $${v.lastBuild.contactUsd})${v.lastBuild.stoppedFor ? ', stopped at the cap' : ''}`);
  if (v.lastNight) L.push(`  last night                     ${v.lastNight.cards} of ${v.lastNight.target} cards, $${v.lastNight.costUsd}`);
  L.push(v.needs.length ? '  STILL NEEDS:\n' + v.needs.map((n) => '    - ' + n).join('\n') : '  ready: the nightly will fill its cards');
  return L.join('\n');
}

module.exports = { build, socialList, verify, formatVerify, ensureTables, DRIVE_KM, LEVEL_REACH, BUILD_RINGS };
