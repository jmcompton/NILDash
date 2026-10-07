'use strict';
// ── A DEPARTMENT'S NIGHT: TWO CARDS FOR EVERY TEAM ──────────────────────────
//
// Every team gets PER_TEAM cards each morning (two: one social brand, one
// local business): a business in town, the named human
// there and how to reach them, the team, why, and a pitch signed by the
// department's sender. One loop per team, the shared one (teamScan, mode
// 'pitch'): never a lower bar, and a team that comes up short is an ourFault
// 'nightly-floor' alert naming the team, the count and the rungs tried, read by
// the morning alert.
//
// Which universities: every one with teams and a business list (a built
// local pool); see universitiesDue. Once per Central date, in the window below; a restart
// inside the window does not run it twice (university_market_runs 'nightly').
//
//   POST /api/admin/campus/:universityId/nightly   run one now (admin)
const WINDOW_START_HOUR = parseInt(process.env.UNIVERSITY_NIGHT_START_HOUR_CT, 10) || 1;   // 1am Central = 11pm Pacific
const WINDOW_END_HOUR = parseInt(process.env.UNIVERSITY_NIGHT_END_HOUR_CT, 10) || 5;
// TWO A TEAM, NOT FIVE. Cypress, Oct 6: 17 teams x 5 = 85 cards wanted, the
// $5 cap ran out at 41 ($4.87), and the teams at the end of the rotation got
// nothing (Flag Football 0, Beach Volleyball 1 of 5). Two a team (one social
// seat, one local) is 34 cards, what $5 actually sustains, and every team
// gets its cards every night. UNIVERSITY_CARDS_PER_TEAM can set 1-5.
const PER_TEAM = Math.min(5, Math.max(1, parseInt(process.env.UNIVERSITY_CARDS_PER_TEAM, 10) || 2));
// ── THE WHOLE NIGHT HAS ONE CAP ─────────────────────────────────────────────
// Each team stops at its own ceiling (teamScan UNIVERSITY_TEAM_COST_CEILING_USD,
// $1.50: contact lookups and the writer). That alone let fifteen teams spend
// fifteen ceilings, and Places builds were outside every ceiling. Now the
// night has one: Places included, every team's ceiling is the smaller of its
// own and what is left, and a team that would start with too little left does
// not start (it is reported short, 'night-cap').
// HARD $5. The setting can lower it, never raise it: a university night is
// a team-level pass over a list already built and resolved, and $5 covers
// it with room to spare (estimate() below shows the arithmetic).
const NIGHT_HARD_CAP_USD = 5;
const NIGHT_CAP_USD = Math.min(NIGHT_HARD_CAP_USD, parseFloat(process.env.UNIVERSITY_NIGHT_COST_CEILING_USD) || NIGHT_HARD_CAP_USD);
const TEAM_CAP_USD = parseFloat(process.env.UNIVERSITY_TEAM_COST_CEILING_USD) || 1.50;
// A wider ring is one Places build: up to 30 types x 5 calls. Only started
// when the night can still afford the worst case.
const RING_WORST_USD = 30 * 5 * (parseFloat(process.env.USD_PER_PLACES_REQUEST) || 0.032);
const _running = new Set();

function centralNow(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
    .formatToParts(now).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24 };
}

// Every department with staff and teams. It used to require a reachable
// contact already on file, which only a bulk contact build produced; the night
// finds and resolves the contacts for the businesses it picks, like the
// agents' night, so a department without one never started.
// THE CARDS NEED TEAMS AND A BUSINESS LIST, nothing else: a university with
// teams and a built local pool is run whether or not its staff have signed in
// yet, so the first login finds a morning of cards. Nothing is sent by the
// night: every card is a draft.
async function universitiesDue(pool) {
  const unis = (await pool.query(
    `SELECT u.id, u.location FROM universities u
      WHERE EXISTS (SELECT 1 FROM university_teams t WHERE t.university_id = u.id)`)).rows;
  const CP = require('./campusPool');
  const out = [];
  for (const u of unis) {
    const full = await CP.universityOf(pool, u.id).catch(() => null);
    if (!full || !full.marketKey) continue;
    const n = (await pool.query(`SELECT COUNT(*)::int n FROM university_market_seen WHERE market_key = $1 AND blocked_reason IS NULL`, [full.marketKey]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
    if (n > 0) out.push(u.id);
  }
  return out;
}

async function ranTonight(pool, universityId, night) {
  return (await pool.query(`SELECT 1 FROM university_market_runs WHERE university_id = $1 AND kind = 'nightly' AND summary->>'night' = $2`,
    [universityId, night])).rowCount > 0;
}

// ── WHERE THE $5 GOES ───────────────────────────────────────────────────────
// The night used to only SPEND: it read the contacts the build had bought and
// turned them into cards, 85 of 88 in one night, and the next night had
// nothing. Now it works like the agents' night, which finds as it goes:
//   cards      every team's PER_TEAM, up the ladder (teamScan): contacts on file,
//              one social brand, the rest from file, contacts bought for the
//              card, new ground. At most CARDS_USD of the cap.
//   discovery  new ground every night (campusDiscovery: squares and searches
//              never asked before). DISCOVERY_USD, part of it spent by a team
//              short of five (the places-refresh rung), the rest after the cards.
//   contacts   whatever is left: named contacts bought for businesses that have
//              none (campusBuild.buyContacts), best kinds first, for TOMORROW.
//              Stops once the reserve holds RESERVE_TARGET_NIGHTS of cards.
// The cap is hard: nothing is started that the cap cannot cover.
const DISCOVERY_USD = Math.min(NIGHT_HARD_CAP_USD, parseFloat(process.env.UNIVERSITY_NIGHT_DISCOVERY_USD) || 0.75);
const REPLENISH_FLOOR_USD = Math.min(NIGHT_HARD_CAP_USD, parseFloat(process.env.UNIVERSITY_NIGHT_REPLENISH_FLOOR_USD) || 1.00);
const REFRESH_SEARCHES = 6;                 // one team's places-refresh rung: six new searches at most
const RESERVE_TARGET_NIGHTS = parseFloat(process.env.UNIVERSITY_RESERVE_TARGET_NIGHTS) || 10;
const RUNWAY_FAIL_NIGHTS = 3;
// FREE NIGHTS: one budget a night for the SCHOOL (never per team) to buy owner
// names for tonight's best cards that the free sources left nameless. About
// 11 to 15 names at $0.25-0.32 a named owner. Fits under the $5 cap with
// discovery ($0.75) and the writing and listing details (~$0.04 a card).
const NAMES_USD = Math.min(NIGHT_HARD_CAP_USD, parseFloat(process.env.UNIVERSITY_NIGHT_NAMES_USD) || 3.50);

// ── THE RESERVE: named contacts unused and available for tomorrow ──────────
// Reachable, not withdrawn or blocked, not a card in the last PITCH_REST_DAYS,
// never touched by staff, not moved along in the CRM: exactly what tomorrow's
// local rung can draw on without buying anything.
// FREE NIGHTS (teamScan.PAID_CONTACTS_AT_NIGHT off): the supply is every
// business on the list not pitched in PITCH_REST_DAYS and not worked by staff,
// whose free check has not run yet or found a way to reach it. Nothing is
// bought for tomorrow, so the reserve is the list itself.
async function reserve(pool, universityId) {
  const TS = require('./teamScan');
  const CP = require('./campusPool');
  const u = await CP.universityOf(pool, universityId);
  if (!u) return 0;
  if (!TS.PAID_CONTACTS_AT_NIGHT) return (await pool.query(
    `SELECT COUNT(*)::int n FROM university_market_seen m
       LEFT JOIN university_contacts c ON c.university_id = $1 AND c.brand = m.brand
      WHERE m.market_key = $2 AND m.blocked_reason IS NULL AND c.withdrawn_reason IS NULL
        AND (COALESCE(c.status, 'pending') IN ('pending', 'error')
             OR c.reachable OR c.email IS NOT NULL OR c.generic_email IS NOT NULL OR c.phone IS NOT NULL OR c.instagram IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM university_drafts d WHERE d.university_id = $1 AND d.brand_name = m.brand AND d.kind = 'pitch'
                          AND d.created_at > NOW() - make_interval(days => $3))
        AND NOT EXISTS (SELECT 1 FROM university_touches t WHERE t.university_id = $1 AND t.brand = m.brand)
        AND NOT EXISTS (SELECT 1 FROM university_crm r WHERE r.university_id = $1 AND r.brand = m.brand AND (r.stage <> 'not_contacted' OR r.notes IS NOT NULL))`,
    [universityId, u.marketKey, TS.PITCH_REST_DAYS]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  return (await pool.query(
    `SELECT COUNT(*)::int n FROM university_contacts c
       JOIN university_market_seen m ON m.market_key = $2 AND m.brand = c.brand AND m.blocked_reason IS NULL
      WHERE c.university_id = $1 AND c.reachable
        AND NOT EXISTS (SELECT 1 FROM university_drafts d WHERE d.university_id = $1 AND d.brand_name = c.brand AND d.kind = 'pitch'
                          AND d.created_at > NOW() - make_interval(days => $3))
        AND NOT EXISTS (SELECT 1 FROM university_touches t WHERE t.university_id = $1 AND t.brand = c.brand)
        AND NOT EXISTS (SELECT 1 FROM university_crm r WHERE r.university_id = $1 AND r.brand = c.brand AND (r.stage <> 'not_contacted' OR r.notes IS NOT NULL))`,
    [universityId, u.marketKey, TS.PITCH_REST_DAYS]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
}

// THE CARD RATE: named contacts a full night uses -- every team's PER_TEAM
// less its social seat. Not last night's count from file: as the reserve empties
// that count falls with it, and the runway would look longer the closer the
// list came to empty.
async function localRate(pool, universityId) {
  const TS = require('./teamScan');
  const teams = (await pool.query(`SELECT COUNT(*)::int n FROM university_teams WHERE university_id = $1`, [universityId])).rows[0].n;
  const seat = Math.min(PER_TEAM, TS.SOCIAL_PER_TEAM);
  return { rate: teams * (PER_TEAM - seat), from: `${teams} teams x ${PER_TEAM - seat} (${PER_TEAM} a team less the social seat)` };
}

// Unused named contacts, nights of runway at the current card rate, and
// whether that is a failure (under RUNWAY_FAIL_NIGHTS).
async function runway(pool, universityId) {
  const avail = await reserve(pool, universityId);
  const r = await localRate(pool, universityId);
  const nights = r.rate > 0 ? Math.round((avail / r.rate) * 10) / 10 : null;
  const unit = require('./teamScan').PAID_CONTACTS_AT_NIGHT ? 'named contacts unused' : 'businesses left to pitch';
  return { available: avail, unit, perNight: r.rate, rateFrom: r.from, nights, failing: nights !== null && nights < RUNWAY_FAIL_NIGHTS,
    failNights: RUNWAY_FAIL_NIGHTS };
}

// One department, every team. deps pass straight to the team loop (tests).
async function runNight(pool, universityId, deps = {}) {
  if (_running.has(universityId)) return { ok: false, error: 'already running' };
  _running.add(universityId);
  try {
    const CP = require('./campusPool');
    const TS = require('./teamScan');
    await CP.ensureTables(pool);
    await TS.ensureTables(pool);
    const night = deps.night || centralNow().date;
    // WHAT TONIGHT WILL COST, before a cent is spent: logged, and stored on
    // the run so the morning can compare it with what it did spend.
    const projected = await estimate(pool, universityId).catch((e) => ({ ok: false, error: e.message }));
    if (projected.ok) console.log(`[campus-nightly] ${universityId} ${night} PROJECTED: ` + formatEstimate(projected).split('\n').join(' | '));
    const run = (await pool.query(`INSERT INTO university_market_runs (university_id, kind, summary) VALUES ($1,'nightly',$2) RETURNING id`,
      [universityId, { night, started: true, projected }])).rows[0].id;
    const sorted = (await pool.query(`SELECT id, name FROM university_teams WHERE university_id = $1 ORDER BY name`, [universityId])).rows;
    // The first team starts one later each night, so a night that hits its
    // cap shorts a different team each time, never the end of the alphabet.
    const day = Math.floor(Date.parse(String(night).slice(0, 10) + 'T12:00:00Z') / 86400000) || 0;
    const k = sorted.length ? day % sorted.length : 0;
    const teams = sorted.slice(k).concat(sorted.slice(0, k));
    const out = [];
    const Q = require('./outreachQueue');
    const nightCap = Math.min(NIGHT_HARD_CAP_USD, Number(deps.nightCapUsd) > 0 ? Number(deps.nightCapUsd) : NIGHT_CAP_USD);
    const discoveryPot = Math.min(nightCap, deps.discoveryUsd != null ? Number(deps.discoveryUsd) : DISCOVERY_USD);
    const cardsCap = Math.max(0, nightCap - discoveryPot - Math.min(REPLENISH_FLOOR_USD, nightCap - discoveryPot));
    const QC = require('./campusQuality');
    await QC.ensureColumns(pool).catch(() => {});
    const uni = await CP.universityOf(pool, universityId);
    // The 15% category cap re-applied to the contactable list before picking.
    await QC.ensureCapped(pool, uni || { id: universityId }, { force: true }).catch((e) => console.error('[campus-nightly] share cap:', e.message));
    const reserveBefore = await reserve(pool, universityId);
    // ── THE SPEND, BY WHAT IT BOUGHT ────────────────────────────────────────
    const usd = { writing: 0, contactsForCards: 0, discovery: 0, contactsForTomorrow: 0, places: 0, names: 0 };
    const spent = () => usd.writing + usd.contactsForCards + usd.discovery + usd.contactsForTomorrow + usd.places + usd.names;
    const disc = { calls: 0, searches: [], newBusinesses: 0, newUsable: 0, errors: [], left: null, byRefresh: 0 };
    const CD = require('./campusDiscovery');
    const discover = async (budgetUsd, maxCalls) => {
      if (!uni || budgetUsd < Q.USD_PER_PLACES_REQUEST) return { ok: true, usd: 0, newUsable: 0 };
      const d = await CD.run(pool, uni, { budgetUsd, maxCalls, night, places: deps.discoveryPlaces }).catch((e) => ({ ok: false, error: e.message, usd: 0, calls: 0, searches: [] }));
      usd.discovery += Number(d.usd) || 0;
      disc.calls += d.calls || 0; disc.searches.push(...(d.searches || [])); disc.newBusinesses += d.newBusinesses || 0; disc.newUsable += d.newUsable || 0;
      if (d.errors) disc.errors.push(...d.errors);
      if (d.error) disc.errors.push(d.error);
      if (d.left != null) disc.left = d.left;
      if (d.newBusinesses && uni) { await TS.recheckPool(pool, uni.marketKey).catch(() => {}); await QC.scorePool(pool, uni.marketKey).catch(() => {}); }
      return d;
    };
    // No category over 15% of tonight's cards (services/campusQuality); a
    // short night still lets any category have two.
    const shared = { built: false, rings: new Set(), placesCalls: 0, catCount: {},
      catCap: Math.max(2, Math.floor(QC.SHARE_CAP * teams.length * PER_TEAM)), canWiden: () => false };
    // The places-refresh rung: a team that has used everything on file and
    // every lookup the pool offers searches new ground, from the pot.
    const refresh = async () => {
      const left = Math.min(discoveryPot - usd.discovery, nightCap - spent());
      if (left < Q.USD_PER_PLACES_REQUEST) return { ok: true, usd: 0, newUsable: 0 };
      const before = usd.discovery;
      const d = await discover(left, REFRESH_SEARCHES);
      disc.byRefresh += (d.searches || []).length;
      return { ok: d.ok, usd: usd.discovery - before, newUsable: d.newUsable || 0 };
    };
    // FREE NIGHTS SOURCE PER SCHOOL: the first pass gives each team only the
    // businesses it fits better than any other team (teamScan.pitchSlate
    // bestFitOnly); a second pass fills a team still short from the rest.
    const freeNight = !TS.PAID_CONTACTS_AT_NIGHT && deps.paidContacts !== true;
    const passes = freeNight ? [{ bestFitOnly: true }, { bestFitOnly: false }] : [{ bestFitOnly: false }];
    for (const pass of passes) {
    const firstPass = pass === passes[0];
    for (const t of teams) {
      let r;
      const prev = firstPass ? null : out.find((x) => x.teamId === t.id);
      if (prev && prev.cards >= PER_TEAM) continue;
      const left = Math.min(cardsCap - usd.writing - usd.contactsForCards, nightCap - spent());
      // Too little left for a team to place even one card (a contact lookup
      // and the writer): it does not start, and is reported short.
      if (left < 0.25) {
        if (prev) continue;
        out.push({ team: t.name, teamId: t.id, ok: false, cards: 0, error: null, stop: 'night-cap', rungs: [], candidates: 0, costUsd: 0, byLane: {} });
        continue;
      }
      try {
        r = await TS.runTeamScan(pool, { universityId, teamId: t.id, limit: prev ? PER_TEAM - prev.cards : PER_TEAM, mode: 'pitch', discoverPool: deps.discoverPool === true,
          deps: { ...deps, night, nightShare: shared, refresh, bestFitOnly: pass.bestFitOnly, ...(prev ? { socialPerTeam: 0 } : {}),
            costCeilingUsd: Math.min(Number(deps.costCeilingUsd) > 0 ? Number(deps.costCeilingUsd) : TEAM_CAP_USD, left) } });
        if (r.loop) { usd.writing += Number(r.loop.writeUsd) || 0; usd.contactsForCards += Number(r.loop.contactUsd) || 0; }
      } catch (e) {
        require('./ourFault').record('nightly-floor', `${t.name}: the team's night threw: ${e.message}`, 'campusNightly ' + universityId).catch(() => {});
        r = { ok: false, error: e.message };
      }
      const row = { team: t.name, teamId: t.id, ok: r.ok, cards: (r.drafts || []).length, error: r.error || null,
        stop: r.loop && r.loop.stop, rungs: r.loop && r.loop.rungs, candidates: r.loop && r.loop.candidates, costUsd: r.loop ? r.loop.costUsd : 0,
        byLane: (r.loop && r.loop.byLane) || {} };
      if (!prev) { out.push(row); continue; }
      // The fill-in pass adds to the team's first-pass row.
      prev.cards += row.cards; prev.ok = prev.ok || row.ok; prev.stop = row.stop; prev.costUsd = (Number(prev.costUsd) || 0) + (Number(row.costUsd) || 0);
      prev.rungs = (prev.rungs || []).concat(['fill-in'], row.rungs || []); prev.candidates = (prev.candidates || 0) + (row.candidates || 0);
      for (const [k, v] of Object.entries(row.byLane)) prev.byLane[k] = (Number(prev.byLane[k]) || 0) + (Number(v) || 0);
    }
    }
    // ── NAMES FOR TONIGHT'S BEST CARDS: one budget for the school ──────────
    // Not per team: a flat NAMES_USD a night, spent on the free-night cards
    // with no owner's name, best fit first (services/ownerLookup.nameTonight).
    // Whatever it does not reach, staff can ask for with "Find the owner".
    let names = null;
    if (freeNight && deps.names !== false) {
      const pot = Math.max(0, Math.min(NAMES_USD, nightCap - spent() - Math.max(0, discoveryPot - usd.discovery)));
      names = await require('./ownerLookup').nameTonight(pool, universityId, night, pot, { ai: deps.contactsAi, free: deps.freeDeps })
        .catch((e) => ({ error: e.message, tried: 0, found: 0, usd: 0 }));
      usd.names += Number(names.usd) || 0;
    }
    usd.places = shared.placesCalls * Q.USD_PER_PLACES_REQUEST;
    // ── NEW GROUND: the rest of the discovery pot ───────────────────────────
    if (deps.discover !== false) await discover(Math.min(discoveryPot - usd.discovery, nightCap - spent()));
    // ── TOMORROW'S CONTACTS: whatever the cap has left ─────────────────────
    const lane = (k) => out.reduce((a, x) => a + (Number(x.byLane && x.byLane[k]) || 0), 0);
    const byLane = { local: lane('local'), 'local-wide': lane('local-wide'), social: lane('social') };
    let bought = null;
    const reserveMid = await reserve(pool, universityId);
    const ratePerNight = (await localRate(pool, universityId)).rate;
    const reserveTarget = Math.ceil(RESERVE_TARGET_NIGHTS * ratePerNight);
    if (!TS.PAID_CONTACTS_AT_NIGHT && deps.paidContacts !== true) {
      bought = { resolved: 0, reachable: 0, contactUsd: 0, stoppedFor: 'free nights: an owner is looked up when staff ask for one' };
    } else if (deps.resolveContacts !== false && uni) {
      const budget = nightCap - spent();
      const want = Math.max(0, reserveTarget - reserveMid);
      if (want > 0 && budget > 0) {
        bought = await require('./campusBuild').buyContacts(pool, uni, { budgetUsd: budget, ai: deps.contactsAi, stopAtReachable: want })
          .catch((e) => ({ error: e.message, contactUsd: 0, resolved: 0, reachable: 0 }));
        usd.contactsForTomorrow += Number(bought.contactUsd) || 0;
        await QC.ensureCapped(pool, uni, { force: true }).catch(() => {});
      } else bought = { resolved: 0, reachable: 0, contactUsd: 0, stoppedFor: want > 0 ? 'budget' : `the reserve already holds ${RESERVE_TARGET_NIGHTS} nights` };
    }
    const reserveAfter = await reserve(pool, universityId);
    const rw = await runway(pool, universityId).catch(() => null);
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const short = out.filter((x) => x.cards < PER_TEAM);
    const summary = { night, freeNight: !TS.PAID_CONTACTS_AT_NIGHT && deps.paidContacts !== true, teams: out.length, cards: out.reduce((s, x) => s + x.cards, 0), target: out.length * PER_TEAM,
      short: short.map((x) => ({ team: x.team, cards: x.cards, stop: x.stop, rungs: x.rungs, error: x.error })),
      byLane,
      // The whole night against its one cap, by what the money bought.
      costUsd: r3(spent()), nightCapUsd: nightCap,
      names: names && { tried: names.tried || 0, found: names.found || 0, usd: r3(Number(names.usd) || 0), budgetUsd: NAMES_USD, stoppedFor: names.stoppedFor || null, error: names.error || null },
      spend: { namesUsd: r3(usd.names), writingUsd: r3(usd.writing), contactsForCardsUsd: r3(usd.contactsForCards), discoveryUsd: r3(usd.discovery),
        contactsForTomorrowUsd: r3(usd.contactsForTomorrow), placesRingsUsd: r3(usd.places),
        contactsUsd: r3(usd.contactsForCards + usd.contactsForTomorrow) },
      teamUsd: r3(usd.writing + usd.contactsForCards), placesCalls: shared.placesCalls + disc.calls, placesUsd: r3(usd.places + usd.discovery),
      discovery: { searches: disc.searches.length, byRefresh: disc.byRefresh, calls: disc.calls, newBusinesses: disc.newBusinesses, newUsable: disc.newUsable,
        left: disc.left, errors: disc.errors.slice(0, 5), sample: disc.searches.slice(0, 12) },
      replenish: bought && { tried: bought.resolved || 0, found: bought.reachable || 0, usd: r3(Number(bought.contactUsd) || 0), stoppedFor: bought.stoppedFor || null,
        pendingLeft: bought.left != null ? bought.left : null, error: bought.error || null, target: reserveTarget },
      reserve: { before: reserveBefore, afterCards: reserveMid, after: reserveAfter, change: reserveAfter - reserveBefore },
      runway: rw, projected, perTeam: out };
    await pool.query(`UPDATE university_market_runs SET finished_at = NOW(), summary = $2 WHERE id = $1`, [run, summary]);
    console.log(`[campus-nightly] ${universityId} ${night}: ${summary.cards} of ${summary.target} cards (${byLane.local} from file, ${byLane['local-wide']} bought, ${byLane.social} social), `
      + `$${summary.costUsd} (writing $${summary.spend.writingUsd}, discovery $${summary.spend.discoveryUsd}, contacts $${summary.spend.contactsUsd}); `
      + `reserve ${reserveBefore} -> ${reserveAfter}` + (short.length ? `; SHORT: ${short.map((x) => `${x.team} ${x.cards}`).join(', ')}` : ''));
    return { ok: true, ...summary };
  } finally {
    _running.delete(universityId);
  }
}

// The night's printout: cards by rung, the spend by what it bought, what
// discovery found, what was bought for tomorrow, the reserve and the runway.
function formatNight(s) {
  if (!s || !s.night) return '(no night has run)';
  const sp = s.spend || {};
  const L = [`LAST NIGHT (${s.night}): ${s.cards} of ${s.target} cards`
    + (s.byLane ? ` -- ${s.byLane.local || 0} from contacts on file, ${s.byLane['local-wide'] || 0} ${s.freeNight ? 'found free tonight' : 'with a contact bought for the card'}, ${s.byLane.social || 0} social` : '')];
  if (s.freeNight && s.spend) {
    const perCard = s.cards ? (Number(sp.writingUsd) + Number(sp.contactsForCardsUsd)) / s.cards : 0;
    L.push(`  COST FOR THE SCHOOL: $${Number(s.costUsd).toFixed(2)} tonight for ${s.teams} teams (cap $${Number(s.nightCapUsd).toFixed(2)})`,
      `    owner names  $${Number(sp.namesUsd || 0).toFixed(2)}  flat a school, not per team: ${s.names ? `${s.names.found} named of ${s.names.tried} looked up` : 'not run'}`,
      `    discovery    $${Number(sp.discoveryUsd).toFixed(2)}  flat a school`,
      `    cards        $${(Number(sp.writingUsd) + Number(sp.contactsForCardsUsd)).toFixed(2)}  writing and listing details, about $${perCard.toFixed(3)} a card (the only part that grows with teams)`);
  } else if (s.spend) {
    L.push(`  SPENT $${Number(s.costUsd).toFixed(2)} of the $${Number(s.nightCapUsd).toFixed(2)} cap:`,
      `    writing      $${Number(sp.writingUsd).toFixed(2)}`,
      `    discovery    $${Number(sp.discoveryUsd).toFixed(2)}  (${s.discovery ? s.discovery.searches : 0} new searches, ${s.discovery ? s.discovery.byRefresh : 0} of them for a short team)`,
      `    contacts     $${Number(sp.contactsUsd).toFixed(2)}  ($${Number(sp.contactsForCardsUsd).toFixed(2)} bought for tonight's cards, $${Number(sp.contactsForTomorrowUsd).toFixed(2)} for tomorrow)`);
  } else L.push(`  SPENT $${Number(s.costUsd || 0).toFixed(2)} (before the spend was split)`);
  if (s.discovery) L.push(`  DISCOVERY: ${s.discovery.newBusinesses} businesses not in the list before, ${s.discovery.newUsable} usable; ${s.discovery.left == null ? '?' : s.discovery.left} searches never made yet`
    + (s.discovery.errors && s.discovery.errors.length ? `; errors: ${s.discovery.errors[0]}` : ''));
  if (s.replenish) L.push(`  CONTACTS FOR TOMORROW: ${s.replenish.found} named of ${s.replenish.tried} looked up ($${Number(s.replenish.usd).toFixed(2)}); stopped: ${s.replenish.stoppedFor || '-'}`
    + (s.replenish.pendingLeft != null ? `; ${s.replenish.pendingLeft} businesses still without a lookup` : ''));
  if (s.reserve) L.push(`  RESERVE (named contacts unused, ready for tomorrow): ${s.reserve.before} -> ${s.reserve.after} (${s.reserve.change >= 0 ? '+' : ''}${s.reserve.change})`);
  for (const x of s.short || []) L.push(`  SHORT ${x.team}: ${x.cards} cards; stopped by ${x.stop || x.error}; rungs ${(x.rungs || []).join(' > ')}`);
  return L.join('\n');
}

// ── WHAT ONE NIGHT WILL COST, BEFORE IT RUNS (spends nothing) ───────────────
// Cards: every team's PER_TEAM. The social seat (one a team, while the social list
// has brands for it) costs the email only. The rest come from contacts on file
// first (the email only), then contacts bought for the card. Discovery is its
// pot. Contacts for tomorrow take what the cap has left, until the reserve
// holds RESERVE_TARGET_NIGHTS. What a named contact costs is THIS
// university's own history (cost of every lookup / the named people found),
// or the ladder's list price before it has any.
async function estimate(pool, universityId) {
  const Q = require('./outreachQueue');
  const CC = require('./campusContacts');
  const TS = require('./teamScan');
  const CP = require('./campusPool');
  const u = await CP.universityOf(pool, universityId);
  if (!u) return { ok: false, error: `no university "${universityId}"` };
  const teams = (await pool.query(`SELECT COUNT(*)::int n FROM university_teams WHERE university_id = $1`, [universityId])).rows[0].n;
  const ready = await reserve(pool, universityId);
  const known = (await pool.query(`SELECT COUNT(*) FILTER (WHERE reachable)::int AS reachable, COUNT(*)::int AS n,
                                          COUNT(*) FILTER (WHERE status IN ('reachable','unreachable'))::int AS looked,
                                          COALESCE(SUM(cost_usd) FILTER (WHERE status IN ('reachable','unreachable','error')),0)::float AS spent,
                                          COUNT(*) FILTER (WHERE status IS NULL OR status = 'pending')::int AS pending
                                     FROM university_contacts WHERE university_id = $1`, [universityId]).catch(() => ({ rows: [{ reachable: 0, n: 0, looked: 0, spent: 0, pending: 0 }] }))).rows[0];
  const socialBrands = (await pool.query(`SELECT COUNT(*)::int n FROM university_social_brands WHERE university_id = $1`, [universityId]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  const per = { low: CC.perBusinessUsd('low', false).metered, high: CC.perBusinessUsd('high', false).metered };
  const r2 = (x) => Math.round(x * 100) / 100;
  // What a NAMED contact costs here: from history once there are 10 lookups.
  const history = known.looked >= 10 && known.spent > 0;
  const hitRate = history ? known.reachable / known.looked : 0.5;
  const perLookup = history ? known.spent / known.looked : (per.low + per.high) / 2;
  const perNamed = hitRate > 0 ? perLookup / hitRate : per.high * 2;
  const cards = teams * PER_TEAM;
  const social = Math.min(teams * TS.SOCIAL_PER_TEAM, socialBrands * TS.SOCIAL_BRAND_NIGHTLY_MAX);
  if (!TS.PAID_CONTACTS_AT_NIGHT) {
    // FREE NIGHTS: a card costs the writer (two asks with the DM) and at most
    // one Places details call; nothing is bought for tomorrow.
    const local = cards - social;
    const writer = cards * 2 * Q.USD_PER_AI_CALL;
    const places = local * Q.USD_PER_PLACES_REQUEST;
    const names = Math.min(NAMES_USD, Math.max(0, NIGHT_CAP_USD - writer - places - DISCOVERY_USD));
    const namesFound = Math.min(local, Math.floor(names / perNamed));
    const total = Math.min(NIGHT_CAP_USD, writer + places + DISCOVERY_USD + names);
    const rate = Math.max(1, teams * Math.max(0, PER_TEAM - TS.SOCIAL_PER_TEAM));
    return { ok: true, free: true, university: u.name, teams, perTeamTarget: PER_TEAM, cards, socialCards: social, socialBrands, localCards: local,
      readyContacts: ready, writerUsd: r2(writer), placesUsd: r2(places), discoveryUsd: r2(DISCOVERY_USD), totalUsd: [r2(total), r2(total)],
      namesUsd: r2(names), namesFound, perNamedUsd: r2(perNamed), hitRate: Math.round(hitRate * 100) / 100,
      costFrom: history ? `this university's ${known.looked} lookups so far` : 'list price, half assumed to find a named person',
      reserveNow: ready, runwayNightsNow: r2(ready / rate), contactsUsedPerNight: rate, nightCapUsd: NIGHT_CAP_USD, teamCapUsd: TEAM_CAP_USD,
      contactsOnFile: { reachable: known.reachable, n: known.n }, shortfallLikely: ready < local };
  }
  const fromFile = Math.min(ready, cards - social);
  const lookups = cards - social - fromFile;
  const writer = cards * Q.USD_PER_AI_CALL;
  const cardsCap = NIGHT_CAP_USD - DISCOVERY_USD - REPLENISH_FLOOR_USD;
  const forCards = Math.min(lookups * perNamed, Math.max(0, cardsCap - writer));
  const boughtForCards = Math.floor(forCards / perNamed);
  const discovery = DISCOVERY_USD;
  const rate = fromFile + boughtForCards;   // contacts a night uses
  const reserveTarget = Math.ceil(RESERVE_TARGET_NIGHTS * Math.max(1, teams * Math.max(0, PER_TEAM - TS.SOCIAL_PER_TEAM)));
  const afterCards = ready - fromFile;
  const wantTomorrow = Math.max(0, reserveTarget - afterCards);
  const forTomorrowRoom = Math.max(0, NIGHT_CAP_USD - writer - forCards - discovery);
  const forTomorrow = Math.min(forTomorrowRoom, wantTomorrow * perNamed, known.pending * perLookup);
  const foundTomorrow = Math.floor(forTomorrow / perNamed);
  const total = writer + forCards + discovery + forTomorrow;
  const reserveNext = afterCards + foundTomorrow;
  const nextRate = Math.max(1, teams * Math.max(0, PER_TEAM - TS.SOCIAL_PER_TEAM));
  return { ok: true, university: u.name, teams, perTeamTarget: PER_TEAM, cards, readyContacts: ready, socialCards: social, socialBrands,
    cardsFromFile: fromFile, lookupsNeeded: lookups, cardsFromLookups: Math.min(lookups, boughtForCards), cardsShort: Math.max(0, lookups - boughtForCards),
    perContactLookupUsd: [per.low, per.high], perLookupUsd: Math.round(perLookup * 1000) / 1000, hitRate: Math.round(hitRate * 100) / 100, perNamedUsd: r2(perNamed),
    costFrom: history ? `this university's ${known.looked} lookups so far ($${r2(known.spent)}, ${known.reachable} named)` : 'list price (no history yet), half assumed to find a named person',
    writerUsd: r2(writer), discoveryUsd: r2(discovery), contactsForCardsUsd: r2(forCards), contactsForTomorrowUsd: r2(forTomorrow), contactsFoundTomorrow: foundTomorrow,
    placesUsd: r2(discovery), totalUsd: [r2(Math.min(total, NIGHT_CAP_USD)), r2(Math.min(total, NIGHT_CAP_USD))], uncappedUsd: [r2(total), r2(total)],
    reserveNow: ready, reserveAfterCards: afterCards, reserveTomorrow: reserveNext, reserveChange: reserveNext - ready, reserveTarget,
    runwayNightsNow: r2(ready / nextRate), runwayNightsTomorrow: r2(reserveNext / nextRate), contactsUsedPerNight: rate,
    pendingBusinesses: known.pending,
    teamCapUsd: TEAM_CAP_USD, nightCapUsd: NIGHT_CAP_USD, contactsOnFile: { reachable: known.reachable, n: known.n },
    shortfallLikely: lookups > boughtForCards };
}

function formatEstimate(e) {
  if (!e || !e.ok) return (e && e.error) || 'no estimate';
  const d = (x) => `$${Number(x).toFixed(2)}`;
  if (e.free) return [
    `TONIGHT FOR ${e.university}: ${e.teams} teams x ${e.perTeamTarget} cards = ${e.cards} cards (free nights: no contact is bought)`,
    `  social brands (one seat a team, ${e.socialBrands} brands on the list): ${e.socialCards} cards`,
    `  local businesses: ${e.localCards} cards from the free sources (listing, website, Instagram); "Find the owner" buys a name when staff ask`,
    `  owner names for tonight's best cards: ${d(e.namesUsd)} a night for the school -> about ${e.namesFound} named (${d(e.perNamedUsd)} a named owner, from ${e.costFrom})`,
    `PROJECTED: ${d(e.totalUsd[0])} for the school -- names ${d(e.namesUsd)} and discovery ${d(e.discoveryUsd)} (flat), writing ${d(e.writerUsd)} and listing details ${d(e.placesUsd)} (per card)`,
    `SUPPLY: ${e.reserveNow} businesses left to pitch (not pitched in 30 days, reachable or not checked yet)`,
    `RUNWAY: ${e.runwayNightsNow} nights at ${e.contactsUsedPerNight} local cards a night (under ${RUNWAY_FAIL_NIGHTS} is a failure)`,
    `HARD CAP: $${e.nightCapUsd.toFixed(2)} for the whole night`,
  ].join('\n');
  return [
    `TONIGHT FOR ${e.university}: ${e.teams} teams x ${e.perTeamTarget} cards = ${e.cards} cards`,
    `  social brands (one seat a team, ${e.socialBrands} brands on the list): ${e.socialCards} cards`,
    `  named contacts on file, ready to pitch: ${e.readyContacts} -> ${e.cardsFromFile} cards need no lookup`,
    `  the other ${e.lookupsNeeded} need a contact bought: ${e.cardsFromLookups} affordable tonight` + (e.cardsShort ? `, ${e.cardsShort} short` : ''),
    `  a named contact costs ${d(e.perNamedUsd)} here (${d(e.perLookupUsd)} a lookup, ${Math.round(e.hitRate * 100)}% find a named person; from ${e.costFrom})`,
    `PROJECTED: ${d(e.totalUsd[0])} -- writing ${d(e.writerUsd)}, discovery ${d(e.discoveryUsd)}, contacts ${d(e.contactsForCardsUsd + e.contactsForTomorrowUsd)} (${d(e.contactsForCardsUsd)} for tonight's cards, ${d(e.contactsForTomorrowUsd)} for tomorrow: ~${e.contactsFoundTomorrow} named)`,
    `RESERVE: ${e.reserveNow} now -> ${e.reserveAfterCards} after the cards -> ~${e.reserveTomorrow} by morning (${e.reserveChange >= 0 ? '+' : ''}${e.reserveChange}); target ${e.reserveTarget} (${RESERVE_TARGET_NIGHTS} nights); ${e.pendingBusinesses} businesses not looked up yet`,
    `RUNWAY: ${e.runwayNightsNow} nights now, ~${e.runwayNightsTomorrow} by morning (under ${RUNWAY_FAIL_NIGHTS} is a failure)`,
    `HARD CAP: $${e.nightCapUsd.toFixed(2)} for the whole night`,
  ].join('\n');
}

async function tick(pool, now = new Date()) {
  const c = centralNow(now);
  if (c.hour < WINDOW_START_HOUR || c.hour >= WINDOW_END_HOUR) return { ran: [] };
  if (String(process.env.UNIVERSITY_NIGHTLY || 'on').toLowerCase() === 'off') return { ran: [], off: true };
  const ran = [];
  for (const id of await universitiesDue(pool)) {
    if (await ranTonight(pool, id, c.date)) continue;
    ran.push(await runNight(pool, id, { night: c.date }));
  }
  return { ran };
}

module.exports = { NAMES_USD, runNight, tick, centralNow, universitiesDue, ranTonight, estimate, formatEstimate, formatNight, reserve, runway, localRate, DISCOVERY_USD, REPLENISH_FLOOR_USD, RESERVE_TARGET_NIGHTS, RUNWAY_FAIL_NIGHTS, PER_TEAM, WINDOW_START_HOUR, WINDOW_END_HOUR, NIGHT_CAP_USD, NIGHT_HARD_CAP_USD, TEAM_CAP_USD, RING_WORST_USD };
