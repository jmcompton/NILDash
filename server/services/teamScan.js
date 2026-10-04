'use strict';
// ── A TEAM'S SPONSOR SCAN ───────────────────────────────────────────────────
//
// The agent scan, pointed at a university team instead of an athlete. Same
// engine (services/scout.assembleSlate), a different SUBJECT
// (Scout.teamSubject), and the subject decides what the engine may read:
//
//   its own tables      university_market_seen, university_brand_engagement,
//                       university_outreach_queue, university_research_claims,
//                       university_drafts (migration 014). Never an agent table.
//   no sponsor signals  HARD OFF. The agent signals are an agent's closed deals,
//                       an agent's replies (read out of their Gmail or Outlook)
//                       and deal_comps. None of it is the university's, and
//                       inbox data stays with the agent it came from.
//   no cross-agent      services/brandFlags reads every agent's deals and
//     NIL flags         replies. Off for the same reason.
//   local lane only     social and national are athlete-audience lanes
//                       (national reads deal_comps). A team sells signage and
//                       game nights to businesses near the campus.
//
// DISCOVERY is Google Places around the campus address, into the university's
// own pool. The agent pool (market_business_seen) is not read: its rows can
// exist because an agent typed a business into Add Business for an athlete.
//
// BLOCKED CATEGORIES never enter the pool: alcohol, cannabis, tobacco,
// firearms, sports betting, payday lending, adult. For a team these are blocks
// at any age, not holds.
//
// IT ENDS AT A WRITTEN ASK, AWAITING APPROVAL. Nothing here sends, and nothing
// reads university_drafts to send. The university mailbox is a later step.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Scout = require('./scout');
const BI = require('./brandIdentity');
const Compliance = require('./compliance');
const TeamWriter = require('./teamWriter');
const { marketPoolKey } = require('./regionKey');

const MIGRATION = path.join(__dirname, '..', 'migrations', '014_university_sponsor_scan.sql');

// ── BLOCKED FOR A TEAM, AT ANY AGE ──────────────────────────────────────────
// Six of the seven are compliance.js categories, reused so a marker added
// there is added here. Payday lending is not a compliance category (it is not
// an age question for an athlete), so its markers live here.
const BLOCKED_KEYS = ['alcohol', 'cannabis', 'tobacco', 'firearms', 'gambling', 'adult', 'collective', 'not-a-sponsor'];
const PAYDAY_MARKERS = ['payday', 'cash advance', 'check cashing', 'check cashers', 'title loan', 'title loans',
  'car title', 'installment loan', 'installment loans', 'speedy cash', 'advance america', 'ace cash', 'cash store',
  'money tree', 'moneytree', 'check into cash', 'checkmate'];

function _marks(name, markers) {
  const s = String(name || '').toLowerCase();
  return markers.find((mk) => new RegExp('\\b' + mk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\b', 'i').test(s)) || null;
}

// Returns null when the business may be pitched, or { key, why } when it may not.
//
// THE NAME AND WHAT IT ACTUALLY IS, not the Google type alone. Los Alamitos
// Race Course was typed `restaurant` (it has one inside) and reached a
// basketball team's slate. So three things are checked: the name, the types,
// and Google's own description of the place (primaryType and its display
// name, "Race Course"). Anything Google describes as a bar is alcohol for a
// team, whatever else it serves.
function blockedFor(c) {
  const name = c.name || c.brand_name;
  const evidence = { types: c.types || [], primaryType: c.primary_type || c.primaryType || null,
    primaryTypeDisplayName: c.primary_type_label || c.primaryTypeDisplayName || null };
  const { hits } = Compliance.classifyBusiness(name, evidence);
  const hit = hits.find((h) => BLOCKED_KEYS.includes(h.key));
  if (hit) return { key: hit.key === 'gambling' ? 'gambling' : hit.key, why: hit.basis };
  const BC = require('./businessCategory');
  const kind = BC.normalise(evidence.primaryType) || BC.normalise(evidence.primaryTypeDisplayName);
  if (kind === 'bar') {
    return { key: 'alcohol', why: `Google describes it as "${evidence.primaryTypeDisplayName || evidence.primaryType}"` };
  }
  const pd = _marks(c.name || c.brand_name, PAYDAY_MARKERS);
  if (pd) return { key: 'payday lending', why: `the business name contains "${pd}"` };
  return null;
}

// ── HOW WELL A BUSINESS FITS A TEAM SPONSORSHIP ─────────────────────────────
// Deterministic and itemised, so every score can be read back. It rewards
// what makes a local sponsorship likely -- the kind of business, how close it
// is to the campus, how established it is -- and marks down a chain, where no
// one at the counter can say yes.
//
// WEIGHTED FOR A SPORTS TEAM, not for an athlete's feed. Restaurant was +26,
// above almost everything, and in a town with 300 restaurants that put five
// of them on every slate. A team's natural sponsors are the businesses that
// serve athletes and the families in the stands: training, physical therapy
// and sports medicine, orthodontists and dentists, the credit union students
// bank with, dealerships and insurers with a real marketing budget. A
// restaurant is still a good sponsor; it is no longer the best one by default.
const CATEGORY_FIT = {
  gym: 30, health: 30, bank: 28, dealership: 28, insurance: 24, wellness: 22, realestate: 22,
  apparel: 20, auto: 18, restaurant: 16, food: 14, coffee: 14, medspa: 14, retail: 14,
  education: 14, entertainment: 12, services: 12, salon: 10, pet: 10,
};
function fitFor(c) {
  const reasons = [];
  let fit = 30;
  const catPts = CATEGORY_FIT[c.category] || 12;
  fit += catPts; reasons.push(`${c.category || 'local business'} +${catPts}`);
  if ((c.types || []).includes('sporting_goods_store')) { fit += 8; reasons.push('sporting goods +8'); }
  const d = Number(c.distance_m);
  if (Number.isFinite(d)) {
    const p = d <= 1500 ? 15 : d <= 3000 ? 10 : d <= 5000 ? 5 : 0;
    if (p) { fit += p; reasons.push(`${(d / 1609.34).toFixed(1)} mi from campus +${p}`); }
  }
  const n = Number(c.user_ratings_total) || 0;
  const est = n >= 500 ? 10 : n >= 150 ? 6 : n >= 50 ? 3 : 0;
  if (est) { fit += est; reasons.push(`${n} reviews +${est}`); }
  const r = Number(c.rating) || 0;
  const rp = r >= 4.5 ? 5 : r >= 4.0 ? 2 : 0;
  if (rp) { fit += rp; reasons.push(`rated ${r} +${rp}`); }
  if (c.chain) { fit -= 12; reasons.push('national chain -12'); }
  return { fit: Math.max(0, Math.min(100, fit)), reasons };
}

// ── WHICH ITEM TO ASK FOR ───────────────────────────────────────────────────
// The team's own available items first; department-wide items only when the
// team has none. A business with a bigger marketing budget is asked for a
// bigger item. Spread across the run so five businesses are not all asked for
// the same thing.
const HIGH = new Set(['dealership', 'realestate', 'insurance', 'bank', 'medspa', 'health']);
const LOW = new Set(['coffee', 'food', 'salon', 'retail']);
function pickItem(category, items, used) {
  const avail = (items || []).filter((i) => i.status === 'available');
  const own = avail.filter((i) => i.team_id);
  const list = (own.length ? own : avail).slice().sort((a, b) => a.price_cents - b.price_cents);
  if (!list.length) return null;
  let order;
  if (HIGH.has(category)) order = list.slice().reverse();
  else if (LOW.has(category)) order = list;
  else {
    const mid = Math.floor((list.length - 1) / 2);
    order = list.slice().sort((a, b) => Math.abs(list.indexOf(a) - mid) - Math.abs(list.indexOf(b) - mid));
  }
  return order.find((i) => !used.has(i.id)) || order[0];
}

function distanceM(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

function splitStatements(sql) {
  return sql.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
}
async function ensureTables(pool) {
  for (const s of splitStatements(fs.readFileSync(MIGRATION, 'utf8'))) await pool.query(s);
}

// The city a campus is in, from its address ("9200 Valley View St, Cypress, CA
// 90630" -> "Cypress, CA"), for the market key.
function cityOf(address) {
  const parts = String(address || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const st = (parts[parts.length - 1].match(/\b([A-Z]{2})\b/) || [])[1];
  const city = parts[parts.length - 2];
  return st && city ? `${city}, ${st}` : null;
}

// ── DISCOVERY: Places around the campus address, into the university pool ──
// `places` is injectable for tests; the default is placesMarket, which reads
// GOOGLE_PLACES_API_KEY from the environment (never passed or printed here).
async function discover(pool, { university, marketKey, places, radiusM }) {
  const P = places || require('./placesMarket');
  // radiusM: the team loop widens the campus pool ring by ring (MP.RADII).
  const built = await P.buildMarketPoolFromPlaces(university.location, { source: 'team-scan', ...(radiusM ? { radiusM } : {}) });
  if (!built.ok) return { ok: false, reason: built.reason || 'places_failed', placesCalls: built.placesCalls || 0 };
  const center = built.geocoded || null;
  // A BLOCKED BUSINESS IS KEPT IN THE POOL, MARKED. It used to be dropped here,
  // which meant a business the block learned about later (a new marker) was
  // already in the pool unmarked and stayed there. Now every row carries
  // blocked_reason, recheckPool re-decides it on every scan, and the slate
  // never reads a blocked row.
  const kept = [], blocked = [];
  for (const c of built.candidates || []) {
    const b = blockedFor(c);
    if (b) blocked.push({ name: c.name, ...b });
    const withD = { ...c, distance_m: distanceM(center, c) };
    const f = fitFor(withD);
    kept.push({ ...withD, fit: f.fit, fit_reasons: f.reasons, blocked_reason: b ? `${b.key}: ${b.why}` : null });
  }
  // ONE ROW PER NAME before the upsert. The pool is keyed (market_key, brand)
  // and Places can return two places with the same display name (two branches
  // of one business); Postgres refuses to upsert the same row twice in one
  // statement, which lost the whole Cypress rebuild. The better fit is kept.
  const BD = require('./batchDedupe');
  const dd = BD.dedupeBy(kept, (c) => c.name, BD.betterPlace);
  const duplicates = dd.collisions.map((c) => ({ brand: c.key,
    kept: { place_id: c.kept.place_id, address: c.kept.address, fit: c.kept.fit, reviews: c.kept.user_ratings_total },
    dropped: { place_id: c.dropped.place_id, address: c.dropped.address, fit: c.dropped.fit, reviews: c.dropped.user_ratings_total } }));
  if (duplicates.length) {
    console.log(`[teamScan] ${duplicates.length} name(s) shared by more than one place; kept one each: `
      + duplicates.slice(0, 10).map((d) => `"${d.brand}" (${d.kept.address} over ${d.dropped.address})`).join('; '));
  }
  kept.length = 0; kept.push(...dd.rows);
  if (kept.length) {
    await pool.query(
      `INSERT INTO university_market_seen
         (market_key, brand, place_id, category, types, address, distance_m, rating, user_ratings_total, chain, fit, fit_reasons, has_evidence, evidence,
          primary_type, primary_type_label, blocked_reason)
       SELECT $1, u.brand, u.place_id, u.category, u.types::jsonb, u.address, u.distance_m, u.rating, u.nrev, u.chain, u.fit, u.reasons::jsonb, NULL, NULL,
              u.ptype, u.plabel, u.blocked
         FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::numeric[], $9::int[], $10::boolean[], $11::int[], $12::text[],
                     $13::text[], $14::text[], $15::text[])
           AS u(brand, place_id, category, types, address, distance_m, rating, nrev, chain, fit, reasons, ptype, plabel, blocked)
       ON CONFLICT (market_key, brand) DO UPDATE SET
         place_id = COALESCE(EXCLUDED.place_id, university_market_seen.place_id),
         -- The category is what the place IS now (placesMarket.categoryFor), so
         -- a fresh answer replaces the old search-type guess rather than
         -- deferring to it.
         category = COALESCE(EXCLUDED.category, university_market_seen.category),
         primary_type = COALESCE(EXCLUDED.primary_type, university_market_seen.primary_type),
         primary_type_label = COALESCE(EXCLUDED.primary_type_label, university_market_seen.primary_type_label),
         blocked_reason = EXCLUDED.blocked_reason,
         types = EXCLUDED.types, address = EXCLUDED.address, distance_m = EXCLUDED.distance_m,
         rating = EXCLUDED.rating, user_ratings_total = EXCLUDED.user_ratings_total, chain = EXCLUDED.chain,
         fit = EXCLUDED.fit, fit_reasons = EXCLUDED.fit_reasons, last_seen_at = NOW()`,
      [marketKey, kept.map((c) => c.name), kept.map((c) => c.place_id || null), kept.map((c) => c.category || null),
        kept.map((c) => JSON.stringify(c.types || [])), kept.map((c) => c.address || null), kept.map((c) => c.distance_m),
        kept.map((c) => c.rating), kept.map((c) => c.user_ratings_total || 0), kept.map((c) => !!c.chain),
        kept.map((c) => c.fit), kept.map((c) => JSON.stringify(c.fit_reasons)),
        kept.map((c) => c.primary_type || null), kept.map((c) => c.primary_type_label || null), kept.map((c) => c.blocked_reason || null)]);
  }
  return { ok: true, found: (built.candidates || []).length, kept: kept.length - blocked.length, blocked, duplicates, placesCalls: built.placesCalls || 0, center };
}

// ── RE-DECIDE THE BLOCK FOR EVERY ROW IN THE POOL ───────────────────────────
// Runs before every slate, with or without discovery, so a marker added today
// reaches a business discovered last month. Returns what changed: rows newly
// blocked (these are the ones that were slipping through) and rows cleared.
async function recheckPool(pool, marketKey, opts = {}) {
  const rows = (await pool.query(
    `SELECT brand, types, category, primary_type, primary_type_label, blocked_reason
       FROM university_market_seen WHERE market_key = $1`, [marketKey])).rows;
  const newlyBlocked = [], cleared = [];
  for (const r of rows) {
    const b = blockedFor({ name: r.brand, types: r.types || [], primary_type: r.primary_type, primary_type_label: r.primary_type_label });
    const reason = b ? `${b.key}: ${b.why}` : null;
    if (reason === r.blocked_reason) continue;
    if (!opts.dryRun) await pool.query(`UPDATE university_market_seen SET blocked_reason = $3 WHERE market_key = $1 AND brand = $2`, [marketKey, r.brand, reason]);
    if (reason && !r.blocked_reason) newlyBlocked.push({ brand: r.brand, category: r.category, reason });
    else if (!reason) cleared.push({ brand: r.brand, was: r.blocked_reason });
  }
  const total = rows.filter((r) => r.blocked_reason).length - cleared.length + newlyBlocked.length;
  return { checked: rows.length, blocked: total, newlyBlocked, cleared };
}

// ── ONE TEAM, ONE NIGHT ─────────────────────────────────────────────────────
// Returns everything the admin script prints. `deps` injects places and the
// writer's ai for tests; production passes nothing.
// ── PITCH MODE: THE DEPARTMENT'S NIGHTLY CARD ───────────────────────────────
// The Cypress product has no pricing packages, so a card is a pitch, not an
// ask for an item: a business, the named human there and how to reach them,
// the team, why, and a pitch signed by a staff member. Same loop as an ask
// (five, or a ceiling, never a lower bar); a different pool read: only a
// business with a reachable contact (services/campusContacts), that fits this
// team, that no one on staff has touched (the CRM's hard rule), and that was
// not already a card for any team in the last PITCH_REST_DAYS days.
const PITCH_REST_DAYS = parseInt(process.env.UNIVERSITY_PITCH_REST_DAYS, 10) || 30;
const PITCH_FIT_MIN = 10;
// BUSINESSES FIRST, CONTACTS SECOND. The team night used to read only
// businesses whose contact was already resolved, and when there were none it
// resolved contacts in alphabetical order until the budget was gone: Cypress
// spent $1.96 and considered zero businesses. Now every usable business is a
// candidate, ranked by its fit for this team (computed from the business when
// no contact row holds it yet); a resolved-unreachable one is out; and the
// contact is resolved only for the business picked, one at a time
// (writePitch), so the money goes on the businesses worth pitching.
async function pitchSlate(pool, { universityId, teamId, marketKey, exclude = [], limit = 10 }) {
  const team = (await pool.query(`SELECT id, name, sport FROM university_teams WHERE id = $1`, [teamId])).rows[0];
  const rows = (await pool.query(
    `SELECT * FROM (
       SELECT m.brand AS brand_name, m.place_id, m.types, m.category, m.primary_type, m.primary_type_label, m.address, m.distance_m,
              m.rating, m.user_ratings_total, c.contact_name, c.contact_title, c.email, c.phone, c.instagram, c.athlete_history_note,
              COALESCE(c.reachable, FALSE) AS reachable, COALESCE(c.status, 'pending') AS contact_status, c.attempts,
              (SELECT (x->>'score')::int FROM jsonb_array_elements(COALESCE(c.team_fit,'[]'::jsonb)) x WHERE x->>'team_id' = $3) AS fit_score,
              (SELECT x->>'why' FROM jsonb_array_elements(COALESCE(c.team_fit,'[]'::jsonb)) x WHERE x->>'team_id' = $3) AS fit_why
         FROM university_market_seen m
         LEFT JOIN university_contacts c ON c.university_id = $1 AND c.brand = m.brand
        WHERE m.market_key = $2 AND m.blocked_reason IS NULL
          AND COALESCE(c.status, 'pending') <> 'unreachable'
          AND NOT (COALESCE(c.status, '') = 'error' AND COALESCE(c.attempts, 0) >= 3)
          AND NOT EXISTS (SELECT 1 FROM university_crm r WHERE r.university_id = $1 AND r.brand = m.brand AND (r.stage <> 'not_contacted' OR r.notes IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM university_touches t WHERE t.university_id = $1 AND t.brand = m.brand)
          AND NOT EXISTS (SELECT 1 FROM university_drafts d WHERE d.university_id = $1 AND d.brand_name = m.brand AND d.kind = 'pitch'
                            AND d.created_at > NOW() - make_interval(days => $4))
          AND NOT (lower(m.brand) = ANY($5::text[]))) z`,
    [universityId, marketKey, teamId, PITCH_REST_DAYS, exclude.map((x) => String(x).toLowerCase())])).rows;
  const CC = require('./campusContacts');
  for (const r of rows) {
    if (r.fit_score === null || r.fit_score === undefined) {
      const f = team ? CC.teamFit({ brand: r.brand_name, category: r.category, types: r.types || [], primary_type_label: r.primary_type_label,
        distance_m: r.distance_m }, [team])[0] : null;
      r.fit_score = f ? f.score : 0; r.fit_why = f ? f.why : null; r.team_fit_row = f;
    }
  }
  const picks = rows.filter((r) => Number(r.fit_score) >= PITCH_FIT_MIN)
    // Best fit first; at equal fit a business already known reachable, then the nearest.
    .sort((a, b) => (b.fit_score - a.fit_score) || ((b.reachable ? 1 : 0) - (a.reachable ? 1 : 0))
      || ((a.distance_m == null ? 1e12 : a.distance_m) - (b.distance_m == null ? 1e12 : b.distance_m)) || String(a.brand_name).localeCompare(String(b.brand_name)))
    .slice(0, limit);
  return { picks };
}

async function runTeamScan(pool, { universityId, teamId, limit = 5, write = true, discoverPool = true, mode = 'ask', deps = {} }) {
  const pitchMode = mode === 'pitch';
  const university = (await pool.query(`SELECT id, name, short_name, location FROM universities WHERE id = $1`, [universityId])).rows[0];
  if (!university) return { ok: false, error: `No university with id "${universityId}".` };
  const team = (await pool.query(
    `SELECT id, university_id, name, sport, season, roster_size, venue, home_dates, market_key
       FROM university_teams WHERE id = $1 AND university_id = $2`, [teamId, universityId])).rows[0];
  if (!team) return { ok: false, error: `No team "${teamId}" at ${university.name}.` };
  const items = (await pool.query(
    `SELECT id, team_id, name, price_cents, status FROM university_inventory
      WHERE university_id = $1 AND (team_id = $2 OR team_id IS NULL)`, [universityId, teamId])).rows;

  const marketKey = team.market_key || marketPoolKey(cityOf(university.location)) || null;
  const out = { ok: true, university, team, marketKey, discovery: null, picks: [], drafts: [], skipped: [] };

  // deps.nightShare (campusNightly): the department's night shares ONE Places build
  // of the campus across all its teams, and builds each wider ring at most
  // once. Without it every team rebuilt the same pool: fifteen identical
  // builds a night, $1-5 each.
  const shared = deps.nightShare || null;
  if (discoverPool && !(shared && shared.built)) {
    if (!university.location) return { ...out, ok: false, error: `${university.name} has no campus address (universities.location).` };
    out.discovery = await discover(pool, { university, marketKey, places: deps.places });
    if (!out.discovery.ok) return { ...out, ok: false, error: `Places discovery failed: ${out.discovery.reason}` };
    if (shared) { shared.built = true; shared.placesCalls += out.discovery.placesCalls || 0; }
  }

  // Every row re-decided before the slate is built (see recheckPool).
  if (marketKey) out.poolRecheck = await recheckPool(pool, marketKey);

  const subject = Scout.teamSubject({ team, university, marketKey });
  const nextSlate = (exclude, n) => (pitchMode
    ? pitchSlate(pool, { universityId, teamId, marketKey, exclude, limit: n })
    : Scout.assembleSlate(pool, { subject, limit: n, exclude }));
  const slate = pitchMode ? await nextSlate([], limit * 2) : await Scout.assembleSlate(pool, { subject, limit });
  const sender = pitchMode ? (deps.sender || await require('./campusMarket').defaultSender(pool, universityId)) : null;
  out.slate = { emptyReason: slate.emptyReason, emptyText: slate.emptyText, lanes: slate.lanes, shape: slate.shape };

  const used = new Set();
  const night = new Date().toISOString().slice(0, 10);
  let noItem = false;
  // PITCH MODE: one business, a pitch written to its named human (true), or
  // the reason it was not (false).
  const writePitch = async (c, pick, brandKey) => {
    if (!write) return true;
    const claim = await pool.query(
      `INSERT INTO university_research_claims (team_id, brand_key, night) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING 1`, [team.id, brandKey, night]);
    if (!claim.rowCount) { out.skipped.push({ brand: c.brand_name, why: 'already researched for this team tonight' }); return false; }
    // One card per business per night across the department's teams.
    const other = (await pool.query(`SELECT 1 FROM university_drafts WHERE university_id = $1 AND brand_name = $2 AND kind = 'pitch' AND night = $3`,
      [university.id, c.brand_name, night])).rowCount;
    if (other) { out.skipped.push({ brand: c.brand_name, why: 'already a card for another team tonight' }); return false; }
    // THE CONTACT, FOR THIS BUSINESS ONLY, NOW THAT IT IS PICKED.
    if (!c.reachable) {
      const est = require('./campusContacts').perBusinessUsd('high', false).metered;
      if (cost() + est + Qs.USD_PER_AI_CALL > COST_CEILING_USD + 1e-9) {
        await pool.query(`DELETE FROM university_research_claims WHERE team_id = $1 AND brand_key = $2 AND night = $3`, [team.id, brandKey, night]).catch(() => {});
        out.skipped.push({ brand: c.brand_name, why: 'the cost ceiling leaves nothing to look up its contact', stage: 'owner', ceiling: true });
        return 'cost';
      }
      const CP = require('./campusPool');
      const u = await CP.universityOf(pool, university.id);
      const r = await require('./campusContacts').resolveAndStore(pool, university.id, { brand: c.brand_name, place_id: c.place_id },
        { city: cityOf(university.location) || university.location, ai: deps.contactsAi, history: false, marketKey: u && u.marketKey,
          teamFit: c.team_fit_row ? [c.team_fit_row] : null });
      resolveUsd += r.costUsd; contactsResolved++;
      if (r.error) { out.skipped.push({ brand: c.brand_name, why: 'contact lookup failed on our side: ' + r.error, fault: true, stage: 'owner' }); return false; }
      if (!r.reachable) { out.skipped.push({ brand: c.brand_name, why: 'no named person and no way to reach them after every source', stage: 'owner' }); return false; }
      contactsReachable++;
      const o = r.out;
      Object.assign(c, { reachable: true, contact_name: o.contact_name, contact_title: o.contact_title, email: o.email, phone: o.phone,
        instagram: o.instagram, athlete_history_note: o.athlete_history_note || c.athlete_history_note });
    }
    asks++;
    const w = await TeamWriter.writeAsk({ university, team, business: pick, contactName: c.contact_name, sender }, { ai: deps.ai });
    if (!w.ok) {
      await pool.query(`DELETE FROM university_research_claims WHERE team_id = $1 AND brand_key = $2 AND night = $3`, [team.id, brandKey, night]).catch(() => {});
      const fault = /^model:/.test(String(w.error || ''));
      if (fault) require('./ourFault').record('anthropic', 'team pitch: ' + w.error, 'teamScan ' + team.id);
      out.skipped.push({ brand: c.brand_name, why: w.error, fault });
      return false;
    }
    {
      const PH = require('./placeholders');
      const r = PH.dropLines(w.body);
      if (r.dropped.length) w.body = r.text;
      if (PH.has(w.subject)) w.subject = String(w.subject).replace(/\s*(\[[^\]]*\]|\{\{?[^}]*\}\}?)\s*/g, ' ').trim();
    }
    await pool.query(
      `INSERT INTO university_brand_engagement (university_id, team_id, brand_key, brand_name, place_id, lane, state, first_shown_at, last_shown_at)
       VALUES ($1,$2,$3,$4,$5,'local','shown',NOW(),NOW())
       ON CONFLICT (team_id, brand_key) DO UPDATE SET last_shown_at = NOW(), updated_at = NOW()`,
      [university.id, team.id, brandKey, c.brand_name, c.place_id || null]);
    const id = 'udraft_' + crypto.randomBytes(8).toString('hex');
    await pool.query(
      `INSERT INTO university_drafts (id, university_id, team_id, brand_key, brand_name, place_id, subject, body, model, status, kind, why,
          contact_name, contact_title, contact_email, contact_phone, contact_instagram, sender_user_id, sender_email, night)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_approval','pitch',$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, university.id, team.id, brandKey, c.brand_name, c.place_id || null, w.subject, w.body, w.model, c.fit_why || null,
        c.contact_name || null, c.contact_title || null, c.email || null, c.phone || null, c.instagram || null,
        sender ? String(sender.userId) : null, sender ? sender.email : null, night]);
    out.drafts.push({ id, brand: c.brand_name, contact: c.contact_name, email: c.email || null, phone: c.phone || null, instagram: c.instagram || null,
      why: c.fit_why || null, subject: w.subject, body: w.body, status: 'awaiting_approval', retried: w.retried });
    return true;
  };

  // One business: an ask written (true), or the reason it was not (false).
  const handle = async (c) => {
    const identity = BI.identitiesOf(c, { market: marketKey })[0];
    const brandKey = c.place_id ? 'place:' + c.place_id : (identity ? identity.key : Scout.normBrand(c.brand_name));
    const item = pitchMode ? null : pickItem(c.category || c.businessCategory, items, used);
    // THE LAST CHECK, at the ask. The slate never reads a blocked row, so this
    // should never fire; if it does, the ask is not written and it says so.
    const lateBlock = blockedFor({ name: c.brand_name, types: c.types || [], primary_type: c.primary_type, primary_type_label: c.primary_type_label });
    if (lateBlock) {
      console.error(`[teamScan] BLOCKED AT THE ASK (the slate should have excluded it): ${c.brand_name} -- ${lateBlock.key}: ${lateBlock.why}`);
      out.skipped.push({ brand: c.brand_name, why: `blocked for a team: ${lateBlock.key} (${lateBlock.why})` });
      return false;
    }
    const pick = { brand_name: c.brand_name, brandKey, category: c.category || c.businessCategory,
      kindLabel: c.primary_type_label || null, address: c.address,
      distance_m: c.distance_m, rating: c.rating, user_ratings_total: c.user_ratings_total,
      fit: Number(c.fitHint) || (pitchMode ? Number(c.fit_score) || null : null), fitReasons: c.fit_reasons || (pitchMode && c.fit_why ? [c.fit_why] : []),
      slateFit: c.fit, item, evidence: c.athlete_history_note || null };
    out.picks.push(pick);
    if (pitchMode) return writePitch(c, pick, brandKey);
    if (!item) { out.skipped.push({ brand: c.brand_name, why: 'the team has no available inventory item to ask for' }); noItem = true; return false; }
    used.add(item.id);
    if (!write) return true;

    const claim = await pool.query(
      `INSERT INTO university_research_claims (team_id, brand_key, night) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING 1`, [team.id, brandKey, night]);
    if (!claim.rowCount) { out.skipped.push({ brand: c.brand_name, why: 'already researched for this team tonight' }); return false; }

    asks++;   // a writer call, for the cost ceiling
    const ask = await TeamWriter.writeAsk({ university, team, business: pick, item }, { ai: deps.ai });
    if (!ask.ok) {
      // No ask was written, so the business was not used up tonight: the claim
      // is handed back. A model that could not run is our fault
      // (services/ourFault), recorded and marked as one.
      await pool.query(`DELETE FROM university_research_claims WHERE team_id = $1 AND brand_key = $2 AND night = $3`,
        [team.id, brandKey, night]).catch(() => {});
      const fault = /^model:/.test(String(ask.error || ''));
      if (fault) require('./ourFault').record('anthropic', 'team ask: ' + ask.error, 'teamScan ' + team.id);
      out.skipped.push({ brand: c.brand_name, why: ask.error, fault });
      return false;
    }

    await pool.query(
      `INSERT INTO university_brand_engagement (university_id, team_id, brand_key, brand_name, place_id, lane, state, first_shown_at, last_shown_at)
       VALUES ($1,$2,$3,$4,$5,'local','shown',NOW(),NOW())
       ON CONFLICT (team_id, brand_key) DO UPDATE SET last_shown_at = NOW(), updated_at = NOW()`,
      [university.id, team.id, brandKey, c.brand_name, c.place_id || null]);
    const q = await pool.query(
      `INSERT INTO university_outreach_queue (university_id, team_id, brand_key, brand_name, identity_key, place_id, inventory_id, fit, why)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [university.id, team.id, brandKey, c.brand_name, identity ? identity.key : null, c.place_id || null, item.id,
        pick.fit, pick.fitReasons.join('; ')]);
    // A MISSING VALUE DROPS THE LINE (services/placeholders), as for agents.
    {
      const PH = require('./placeholders');
      const r = PH.dropLines(ask.body);
      if (r.dropped.length) {
        console.log(`[teamScan] ${c.brand_name}: dropped ${r.dropped.length} placeholder line(s): ${r.dropped.join(' | ').slice(0, 200)}`);
        ask.body = r.text;
      }
      if (PH.has(ask.subject)) ask.subject = String(ask.subject).replace(/\s*(\[[^\]]*\]|\{\{?[^}]*\}\}?)\s*/g, ' ').trim();
    }
    const id = 'udraft_' + crypto.randomBytes(8).toString('hex');
    await pool.query(
      `INSERT INTO university_drafts (id, university_id, team_id, queue_id, brand_key, brand_name, place_id,
          inventory_id, inventory_name, price_cents, subject, body, model, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'awaiting_approval')`,
      [id, university.id, team.id, q.rows[0].id, brandKey, c.brand_name, c.place_id || null,
        item.id, item.name, item.price_cents, ask.subject, ask.body, ask.model]);
    out.drafts.push({ id, brand: c.brand_name, item: item.name, price: TeamWriter.money(item.price_cents),
      subject: ask.subject, body: ask.body, status: 'awaiting_approval', retried: ask.retried });
    return true;
  };

  // ── FIVE, OR A CEILING (the same loop as the agents' night) ───────────────
  // This wrote one slate of `limit` and stopped: every business refused at the
  // ask (blocked, already researched, the writer declined) was a seat lost.
  // Now a refusal pulls a replacement until the team holds `limit` asks,
  // stopping only for the time or cost ceiling, the ladder, or inventory:
  //   rung 1  the team's pool, re-drawn past everything tried tonight
  //   rung 2+ a fresh Places build of the campus at the next ring out
  // (A team has one lane, local; there is no social, national or hometown.)
  const MP = require('./marketPools');
  const Qs = require('./outreachQueue');
  const TIME_CEILING_MS = Number(deps.timeCeilingMs) > 0 ? Number(deps.timeCeilingMs)
    : (parseInt(process.env.UNIVERSITY_TEAM_TIME_CEILING_MS, 10) || 10 * 60 * 1000);
  const COST_CEILING_USD = Number(deps.costCeilingUsd) > 0 ? Number(deps.costCeilingUsd)
    : (parseFloat(process.env.UNIVERSITY_TEAM_COST_CEILING_USD) || 1.50);
  const t0 = Date.now();
  const triedKeys = new Set();
  const triedNames = new Set();   // as the pool stores them, for the re-draw's exclusion
  const rungs = ['local'];
  let ringIdx = 0, placesCalls = (out.discovery && out.discovery.placesCalls) || 0, asks = 0, candidates = 0, stop = null, toFloor = null;
  // The ceiling counts the writer calls. A Places build is the campus
  // market's, not this team's night, and is reported separately (placesCalls),
  // as a market refresh is for agents.
  const cost = () => asks * Qs.USD_PER_AI_CALL + resolveUsd;
  const have = () => (write ? out.drafts.length : out.picks.filter((p) => p.item || pitchMode).length);
  let resolveUsd = 0, contactsResolved = 0, contactsReachable = 0;
  let picks = slate.picks;
  for (;;) {
    for (const c of picks) {
      if (have() >= limit) break;
      if (Date.now() - t0 > TIME_CEILING_MS) { stop = 'time'; break; }
      if (cost() + Qs.USD_PER_AI_CALL > COST_CEILING_USD + 1e-9) { stop = 'cost'; break; }
      const k = Scout.normBrand(c.brand_name);
      if (triedKeys.has(k)) continue;
      triedKeys.add(k); candidates++;
      triedNames.add(String(c.brand_name || '').trim().toLowerCase());
      const h = await handle(c);
      if (h === 'cost') { stop = 'cost'; break; }
      if (have() >= limit && toFloor === null) toFloor = candidates;
      if (!pitchMode && noItem && items.every((it) => used.has(it.id))) { stop = 'inventory'; break; }
    }
    if (stop || have() >= limit) break;
    const next = await nextSlate([...triedNames], limit * 2);
    picks = (next.picks || []).filter((c) => !triedKeys.has(Scout.normBrand(c.brand_name)));
    if (picks.length) continue;
    const nextRing = MP.RADII[ringIdx + 1];
    if (discoverPool && nextRing && university.location) {
      ringIdx++;
      rungs.push(`places-${Math.round(nextRing / 1000)}km`);
      if (shared && shared.rings.has(nextRing)) {
        // Another team already widened to this ring tonight: its businesses
        // are in the pool; read them, do not pay for them again.
      } else if (shared && !shared.canWiden()) {
        stop = 'night-cap'; break;
      } else {
        const d = await discover(pool, { university, marketKey, places: deps.places, radiusM: nextRing });
        placesCalls += d.placesCalls || 0;
        if (shared) { shared.rings.add(nextRing); shared.placesCalls += d.placesCalls || 0; }
        if (!d.ok) require('./ourFault').record('google-places', `team pool widen to ${nextRing} m failed: ${d.reason}`, 'teamScan ' + team.id);
      }
      if (marketKey) await recheckPool(pool, marketKey);
      picks = [];
      continue;
    }
    stop = 'ladder'; break;
  }
  const held = have();
  out.loop = { stop: stop || (held >= limit ? 'floor' : null), candidates, candidatesToFloor: toFloor, rungs,
    held, floor: limit, elapsedMs: Date.now() - t0, costUsd: Math.round(cost() * 1000) / 1000, placesCalls,
    // Pitch mode: contacts looked up for the businesses picked, and how many
    // of those had a named, reachable person.
    contactsResolved, contactsReachable };
  if (held < limit && write) {
    require('./ourFault').record('nightly-floor', `${university.name} ${team.name}: ${held} of ${limit} ${pitchMode ? 'cards' : 'asks'} after ${candidates} candidate(s); `
      + `stopped by ${out.loop.stop}; rungs tried: ${rungs.join(', ')}`, 'teamScan ' + team.id).catch(() => {});
  }
  return out;
}

module.exports = { runTeamScan, pitchSlate, PITCH_REST_DAYS, discover, recheckPool, ensureTables, blockedFor, fitFor, pickItem, distanceM, cityOf,
  BLOCKED_KEYS, PAYDAY_MARKERS, CATEGORY_FIT, MIGRATION };
