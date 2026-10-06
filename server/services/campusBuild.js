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
// From the social index (social_brands), a brand counts when:
//   its program page was verified in the last 12 months (proof_url, proof_date)
//   it takes a small following: its stated minimum, if it states one, is at
//     or under LEVEL_REACH. Most ambassador programs state no number
//     (tier_stated false): that is "open to anyone who applies", not a no.
//   it fits a team: sports 'all' (what discovery writes when a program names
//     none) or empty matches every team
//   never a household incumbent, never anything the campus block refuses
// The funnel is returned so a 0 says which step emptied it.
async function socialList(pool, uni) {
  await ensureTables(pool);
  const SE = require('./signingEvidence');
  const TS = require('./teamScan');
  const teamSports = (await pool.query(`SELECT DISTINCT LOWER(COALESCE(sport, name)) AS s FROM university_teams WHERE university_id = $1`, [uni.id])).rows.map((r) => r.s).filter(Boolean);
  const all = (await pool.query(`SELECT * FROM social_brands`).catch(() => ({ rows: [] }))).rows;
  const funnel = { inIndex: all.length, inactive: 0, noProgramPage: 0, staleOver12Months: 0, minimumTooHigh: 0, noSportMatch: 0, incumbent: 0, blocked: 0, kept: 0 };
  const cutoff = Date.now() - 365 * 86400000;
  const kept = [], refused = [];
  for (const b of all) {
    if (b.active === false) { funnel.inactive++; continue; }
    if (!b.proof_url) { funnel.noProgramPage++; continue; }
    if (!b.proof_date || new Date(b.proof_date).getTime() < cutoff) { funnel.staleOver12Months++; continue; }
    if (b.tier_stated && Number(b.tier_min) > LEVEL_REACH) { funnel.minimumTooHigh++; continue; }
    const bs = (b.sports || []).map((x) => String(x).toLowerCase().trim()).filter(Boolean);
    const anySport = !bs.length || bs.includes('all') || bs.includes('any');
    if (!anySport && teamSports.length && !bs.some((x) => teamSports.some((t) => t.includes(x) || x.includes(t)))) { funnel.noSportMatch++; continue; }
    if (SE.incumbent(b.brand)) { funnel.incumbent++; refused.push({ brand: b.brand, why: 'household incumbent' }); continue; }
    const blk = TS.blockedFor({ name: b.brand });
    if (blk) { funnel.blocked++; refused.push({ brand: b.brand, why: blk.key }); continue; }
    kept.push(b);
  }
  funnel.kept = kept.length;
  await pool.query(`DELETE FROM university_social_brands WHERE university_id = $1`, [uni.id]);
  for (const b of kept) {
    await pool.query(
      `INSERT INTO university_social_brands (university_id, brand, website, program_url, category, tier_min, tier_max, sports, proof_date, offer, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (university_id, brand) DO NOTHING`,
      [uni.id, b.brand, b.website, b.proof_url, b.category, b.tier_min, b.tier_max, b.sports || null, b.proof_date, b.offer_summary,
        `${b.tier_stated ? `program states ${b.tier_min || 0}+ followers` : 'program states no minimum'}, verified ${String(b.proof_date).slice(0, 10)}: ${b.proof_url}`]);
  }
  return { kept: kept.length, refused, funnel };
}

function formatFunnel(f) {
  if (!f) return '';
  return `${f.inIndex} in the social index; out: ${f.inactive} inactive, ${f.noProgramPage} no program page, ${f.staleOver12Months} not verified in 12 months, `
    + `${f.minimumTooHigh} minimum above a ${LEVEL_REACH.toLocaleString()}-follower athlete, ${f.noSportMatch} no sport match, ${f.incumbent} household incumbents, ${f.blocked} blocked; kept ${f.kept}`;
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
  // 2. The block, for every row (a rule added today reaches last month's rows),
  //    then the passes the name check cannot see (services/campusQuality):
  //    stored contacts re-judged, a chain's corporate address, duplicates.
  const QC = require('./campusQuality');
  await QC.ensureColumns(pool);
  const withdrawn = [];
  const re = await TS.recheckPool(pool, uni.marketKey).catch((e) => ({ error: e.message }));
  for (const b of (re && re.newlyBlocked) || []) withdrawn.push({ brand: b.brand, why: String(b.reason || '').split(':')[0] || 'blocked', detail: b.reason });
  await QC.scorePool(pool, uni.marketKey);
  const passes = async () => {
    withdrawn.push(...(await QC.recheckContacts(pool, uni)).filter((x) => !x.kept));
    withdrawn.push(...await QC.chainsByDomain(pool, uni));
    withdrawn.push(...await QC.dedupe(pool, uni));
  };
  await passes();
  // 3. Named decision makers inside driving distance, to the cap: the kinds of
  //    business most likely to do an athlete deal first, and no lookup spent
  //    on a category that already holds its 15% share of the contactable list.
  await CC.seedRows(pool, uni);
  const todo = (await pool.query(
    `SELECT c.brand, c.place_id, COALESCE(m.deal_bucket, 'other') AS bucket FROM university_contacts c
       JOIN university_market_seen m ON m.market_key = c.market_key AND m.brand = c.brand
      WHERE c.university_id = $1 AND m.blocked_reason IS NULL AND (c.status IS NULL OR c.status = 'pending')
        AND (m.distance_m IS NULL OR m.distance_m <= $2)
      ORDER BY m.deal_priority DESC NULLS LAST, m.fit DESC NULLS LAST, m.distance_m ASC NULLS LAST`, [uni.id, DRIVE_KM * 1000])).rows;
  const have = {};
  for (const r of (await pool.query(`SELECT COALESCE(m.deal_bucket, 'other') AS bucket, COUNT(*)::int n FROM university_contacts c
       JOIN university_market_seen m ON m.market_key = c.market_key AND m.brand = c.brand AND m.blocked_reason IS NULL
      WHERE c.university_id = $1 AND c.reachable GROUP BY 1`, [uni.id])).rows) have[r.bucket] = r.n;
  const totalHave = () => Object.values(have).reduce((a, b) => a + b, 0);
  const shareFull = (b) => (have[b] || 0) >= Math.max(3, Math.ceil(QC.SHARE_CAP * Math.max(20, totalHave())));
  const city = TS.cityOf(uni.location) || uni.location;
  let contactUsd = 0, resolved = 0, reachable = 0, stoppedFor = null, skippedForShare = 0;
  const perLookup = CC.perBusinessUsd('high', false).metered;
  for (const row of todo) {
    if (shareFull(row.bucket)) { skippedForShare++; continue; }
    // A lookup is bought only when the cap can cover a dear one.
    if (placesUsd + contactUsd + perLookup > budget) { stoppedFor = 'budget'; break; }
    const r = await CC.resolveAndStore(pool, uni.id, row, { city, ai: opts.ai, history: false, marketKey: uni.marketKey });
    contactUsd += r.costUsd || 0; resolved++;
    if (r.reachable) { reachable++; have[row.bucket] = (have[row.bucket] || 0) + 1; }
  }
  // The passes again for what the lookups just found, then the 15% cap.
  await passes();
  const cap = await QC.applyShareCap(pool, uni);
  const hist = await QC.histogram(pool, uni);
  // 4. Social.
  const social = await socialList(pool, uni);
  const r2 = (x) => Math.round(x * 100) / 100;
  const summary = {
    university: uni.name, marketKey: uni.marketKey, budgetUsd: budget,
    spentUsd: r2(placesUsd + contactUsd), placesUsd: r2(placesUsd), contactUsd: r2(contactUsd),
    placesCalls: (deep && deep.placesCalls) || 0, poolSteps: (deep && deep.steps) || [], poolError: deep && !deep.ok ? deep.error : null,
    newlyBlocked: (re && Array.isArray(re.newlyBlocked) ? re.newlyBlocked.length : Number(re && re.newlyBlocked) || 0), blockedTotal: (re && Number(re.blocked)) || 0,
    contactsTried: resolved, contactsFound: reachable, contactsLeft: todo.length - resolved - skippedForShare, stoppedFor, skippedForShare,
    contactable: cap.contactable, listed: cap.listed, heldForShare: cap.held, histogram: hist,
    withdrawn: withdrawn.map((w) => ({ brand: w.brand, why: w.why, detail: w.detail })),
    withdrawnByWhy: withdrawn.reduce((o, w) => { o[w.why] = (o[w.why] || 0) + 1; return o; }, {}),
    social: social.kept, socialRefused: social.refused.length, socialFunnel: social.funnel, driveKm: DRIVE_KM,
  };
  // LOCAL AND SOCIAL ARE THE WHOLE MODEL. Either at 0 is a failed build, said
  // as one, with the step that emptied it.
  summary.failures = [];
  const localUsable = (await pool.query(`SELECT COUNT(*)::int n FROM university_market_seen WHERE market_key = $1 AND blocked_reason IS NULL`, [uni.marketKey])).rows[0].n;
  summary.localFound = localUsable;
  if (!localUsable) summary.failures.push('0 local businesses' + (summary.poolError ? `: ${summary.poolError}` : ''));
  else if (!reachable && !(await pool.query(`SELECT 1 FROM university_contacts WHERE university_id = $1 AND reachable LIMIT 1`, [uni.id])).rowCount) summary.failures.push('0 local businesses with a named contact');
  if (!social.kept) summary.failures.push('0 social brands: ' + formatFunnel(social.funnel));
  await pool.query(`UPDATE university_market_runs SET finished_at = NOW(), summary = $2 WHERE id = $1`, [run, summary]);
  console.log(`[campus-build] ${uni.name}: spent $${summary.spentUsd} of $${budget} (Places $${summary.placesUsd}, contacts $${summary.contactUsd}); `
    + `${reachable} of ${resolved} businesses with a named person; ${cap.listed} listed (${cap.held} held over a category's share); ${withdrawn.length} withdrawn; ${social.kept} social brands`
    + (summary.failures.length ? `; FAILED: ${summary.failures.join('; ')}` : ''));
  return { ok: !summary.failures.length, ...summary };
}

// The build's printout: spend, the category histogram, what was withdrawn
// and why, the contactable count, the social funnel, and any failure.
function formatBuild(b) {
  if (!b) return '';
  if (b.ok === false && !b.university) return 'BUILD FAILED: ' + (b.error || 'unknown');
  const QC = require('./campusQuality');
  const L = [];
  L.push(`BUILD ${b.university}: spent $${b.spentUsd} of $${b.budgetUsd} (Places $${b.placesUsd}, contacts $${b.contactUsd})${b.stoppedFor ? ', stopped at the cap' : ''}`);
  L.push(`  contact lookups: ${b.contactsTried} tried, ${b.contactsFound} found a named person; ${b.skippedForShare || 0} skipped (category at its share); ${b.contactsLeft} left for next time`);
  L.push(`  CONTACTABLE: ${b.contactable} businesses with a named, reachable decision maker; LISTED ${b.listed} (${b.heldForShare} held: their category is over ${Math.round(QC.SHARE_CAP * 100)}%)`);
  L.push('  CATEGORY HISTOGRAM');
  L.push(QC.formatHistogram(b.histogram || []));
  const by = b.withdrawnByWhy || {};
  L.push(`  WITHDRAWN this build: ${(b.withdrawn || []).length}` + (Object.keys(by).length ? ' (' + Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ') + ')' : ''));
  for (const w of (b.withdrawn || []).slice(0, 60)) L.push(`    ${String(w.brand).padEnd(34)} ${w.why}${w.detail && w.detail !== w.why ? ': ' + String(w.detail).slice(0, 110) : ''}`);
  L.push(`  SOCIAL: ${b.social} brands. ${formatFunnel(b.socialFunnel)}`);
  if (b.failures && b.failures.length) L.push('  FAILED:\n' + b.failures.map((f) => '    - ' + f).join('\n'));
  return L.join('\n');
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
  await require('./campusQuality').ensureColumns(pool).catch(() => {});
  // A named, reachable decision maker: a direct address or a phone, never a
  // shared inbox (campusQuality). "Listed": within its category's 15% share.
  const contactable = await one(`SELECT COUNT(*)::int n FROM university_contacts c JOIN university_market_seen m ON m.market_key = c.market_key AND m.brand = c.brand
                             WHERE c.university_id = $1 AND c.reachable AND m.blocked_reason IS NULL`, [uni.id]);
  const named = await one(`SELECT COUNT(*)::int n FROM university_contacts c JOIN university_market_seen m ON m.market_key = c.market_key AND m.brand = c.brand
                             WHERE c.university_id = $1 AND c.reachable AND c.held_reason IS NULL AND m.blocked_reason IS NULL`, [uni.id]);
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
  // A FAILURE, not a gap: local and social are the whole model.
  const failures = [];
  if (teams && !found && lastBuild) failures.push('0 local businesses after a build');
  if (found && !named && lastBuild) failures.push('0 local businesses with a named contact');
  if (lastBuild && !social) failures.push('0 social brands: ' + (lastBuild.summary && lastBuild.summary.socialFunnel ? formatFunnel(lastBuild.summary.socialFunnel) : 'rebuild to see why'));
  return { ok: true, university: uni.name, id: uni.id, location: uni.location, marketKey: uni.marketKey,
    center: row.lat != null ? { lat: row.lat, lng: row.lng } : null,
    teams, athletes, businessesFound: found, businessesBlocked: blocked, businessesWithNamedContact: named, contactableBeforeShareCap: contactable, socialBrands: social,
    cardsLatestNight: cards, cardsAllTime: cardsAll, staff,
    lastBuild: lastBuild && lastBuild.summary, lastNight: lastNight && lastNight.summary,
    nightlyReady: !!(teams && found), needs, failures };
}

function formatVerify(v) {
  if (!v.ok) return v.error;
  const L = [];
  L.push(`${v.university} (${v.id})  ${v.location || '(no address)'}${v.center ? `  centre ${v.center.lat.toFixed(5)}, ${v.center.lng.toFixed(5)}` : ''}`);
  L.push(`  teams                          ${v.teams}`);
  L.push(`  athletes                       ${v.athletes}`);
  L.push(`  businesses found (local)       ${v.businessesFound}   (${v.businessesBlocked} withdrawn by the block)`);
  L.push(`  with a named contact           ${v.businessesWithNamedContact}${v.contactableBeforeShareCap !== v.businessesWithNamedContact ? `   (${v.contactableBeforeShareCap} before the 15% category cap)` : ''}`);
  L.push(`  social brands at this level    ${v.socialBrands}`);
  L.push(`  cards, latest night            ${v.cardsLatestNight}   (all time ${v.cardsAllTime})`);
  L.push(`  staff accounts                 ${v.staff}`);
  if (v.lastBuild) L.push(`  last build spent               $${v.lastBuild.spentUsd} of $${v.lastBuild.budgetUsd} (Places $${v.lastBuild.placesUsd}, contacts $${v.lastBuild.contactUsd})${v.lastBuild.stoppedFor ? ', stopped at the cap' : ''}`);
  if (v.lastNight) L.push(`  last night                     ${v.lastNight.cards} of ${v.lastNight.target} cards, $${v.lastNight.costUsd}`);
  if (v.failures && v.failures.length) L.push('  FAILED:\n' + v.failures.map((n) => '    - ' + n).join('\n'));
  L.push(v.needs.length ? '  STILL NEEDS:\n' + v.needs.map((n) => '    - ' + n).join('\n') : (v.failures && v.failures.length ? '  the nightly will still fill local cards' : '  ready: the nightly will fill its cards'));
  return L.join('\n');
}

module.exports = { build, formatBuild, socialList, formatFunnel, verify, formatVerify, ensureTables, DRIVE_KM, LEVEL_REACH, BUILD_RINGS };
