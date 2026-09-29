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
const BLOCKED_KEYS = ['alcohol', 'cannabis', 'tobacco', 'firearms', 'gambling', 'adult'];
const PAYDAY_MARKERS = ['payday', 'cash advance', 'check cashing', 'check cashers', 'title loan', 'title loans',
  'car title', 'installment loan', 'installment loans', 'speedy cash', 'advance america', 'ace cash', 'cash store',
  'money tree', 'moneytree', 'check into cash', 'checkmate'];

function _marks(name, markers) {
  const s = String(name || '').toLowerCase();
  return markers.find((mk) => new RegExp('\\b' + mk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\b', 'i').test(s)) || null;
}

// Returns null when the business may be pitched, or { key, why } when it may not.
function blockedFor(c) {
  const { hits } = Compliance.classifyBusiness(c.name || c.brand_name, { types: c.types || [] });
  const hit = hits.find((h) => BLOCKED_KEYS.includes(h.key));
  if (hit) return { key: hit.key === 'gambling' ? 'sports betting' : hit.key, why: hit.basis };
  const pd = _marks(c.name || c.brand_name, PAYDAY_MARKERS);
  if (pd) return { key: 'payday lending', why: `the business name contains "${pd}"` };
  return null;
}

// ── HOW WELL A BUSINESS FITS A TEAM SPONSORSHIP ─────────────────────────────
// Deterministic and itemised, so every score can be read back. It rewards
// what makes a local sponsorship likely -- the kind of business, how close it
// is to the campus, how established it is -- and marks down a chain, where no
// one at the counter can say yes.
const CATEGORY_FIT = {
  dealership: 30, gym: 28, restaurant: 26, wellness: 24, food: 24, auto: 22, insurance: 22,
  realestate: 22, coffee: 22, medspa: 20, apparel: 20, bank: 18, retail: 16, salon: 14,
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
const HIGH = new Set(['dealership', 'realestate', 'insurance', 'bank', 'medspa']);
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
async function discover(pool, { university, marketKey, places }) {
  const P = places || require('./placesMarket');
  const built = await P.buildMarketPoolFromPlaces(university.location, { source: 'team-scan' });
  if (!built.ok) return { ok: false, reason: built.reason || 'places_failed', placesCalls: built.placesCalls || 0 };
  const center = built.geocoded || null;
  const kept = [], blocked = [];
  for (const c of built.candidates || []) {
    const b = blockedFor(c);
    if (b) { blocked.push({ name: c.name, ...b }); continue; }
    const withD = { ...c, distance_m: distanceM(center, c) };
    const f = fitFor(withD);
    kept.push({ ...withD, fit: f.fit, fit_reasons: f.reasons });
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
         (market_key, brand, place_id, category, types, address, distance_m, rating, user_ratings_total, chain, fit, fit_reasons, has_evidence, evidence)
       SELECT $1, u.brand, u.place_id, u.category, u.types::jsonb, u.address, u.distance_m, u.rating, u.nrev, u.chain, u.fit, u.reasons::jsonb, NULL, NULL
         FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::numeric[], $9::int[], $10::boolean[], $11::int[], $12::text[])
           AS u(brand, place_id, category, types, address, distance_m, rating, nrev, chain, fit, reasons)
       ON CONFLICT (market_key, brand) DO UPDATE SET
         place_id = COALESCE(EXCLUDED.place_id, university_market_seen.place_id),
         category = COALESCE(EXCLUDED.category, university_market_seen.category),
         types = EXCLUDED.types, address = EXCLUDED.address, distance_m = EXCLUDED.distance_m,
         rating = EXCLUDED.rating, user_ratings_total = EXCLUDED.user_ratings_total, chain = EXCLUDED.chain,
         fit = EXCLUDED.fit, fit_reasons = EXCLUDED.fit_reasons, last_seen_at = NOW()`,
      [marketKey, kept.map((c) => c.name), kept.map((c) => c.place_id || null), kept.map((c) => c.category || null),
        kept.map((c) => JSON.stringify(c.types || [])), kept.map((c) => c.address || null), kept.map((c) => c.distance_m),
        kept.map((c) => c.rating), kept.map((c) => c.user_ratings_total || 0), kept.map((c) => !!c.chain),
        kept.map((c) => c.fit), kept.map((c) => JSON.stringify(c.fit_reasons))]);
  }
  return { ok: true, found: (built.candidates || []).length, kept: kept.length, blocked, duplicates, placesCalls: built.placesCalls || 0, center };
}

// ── ONE TEAM, ONE NIGHT ─────────────────────────────────────────────────────
// Returns everything the admin script prints. `deps` injects places and the
// writer's ai for tests; production passes nothing.
async function runTeamScan(pool, { universityId, teamId, limit = 5, write = true, discoverPool = true, deps = {} }) {
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

  if (discoverPool) {
    if (!university.location) return { ...out, ok: false, error: `${university.name} has no campus address (universities.location).` };
    out.discovery = await discover(pool, { university, marketKey, places: deps.places });
    if (!out.discovery.ok) return { ...out, ok: false, error: `Places discovery failed: ${out.discovery.reason}` };
  }

  const subject = Scout.teamSubject({ team, university, marketKey });
  const slate = await Scout.assembleSlate(pool, { subject, limit });
  out.slate = { emptyReason: slate.emptyReason, emptyText: slate.emptyText, lanes: slate.lanes, shape: slate.shape };

  const used = new Set();
  const night = new Date().toISOString().slice(0, 10);
  for (const c of slate.picks) {
    const identity = BI.identitiesOf(c, { market: marketKey })[0];
    const brandKey = c.place_id ? 'place:' + c.place_id : (identity ? identity.key : Scout.normBrand(c.brand_name));
    const item = pickItem(c.category || c.businessCategory, items, used);
    const pick = { brand_name: c.brand_name, brandKey, category: c.category || c.businessCategory, address: c.address,
      distance_m: c.distance_m, rating: c.rating, user_ratings_total: c.user_ratings_total,
      fit: Number(c.fitHint) || null, fitReasons: c.fit_reasons || [], slateFit: c.fit, item };
    out.picks.push(pick);
    if (!item) { out.skipped.push({ brand: c.brand_name, why: 'the team has no available inventory item to ask for' }); continue; }
    used.add(item.id);
    if (!write) continue;

    const claim = await pool.query(
      `INSERT INTO university_research_claims (team_id, brand_key, night) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING RETURNING 1`, [team.id, brandKey, night]);
    if (!claim.rowCount) { out.skipped.push({ brand: c.brand_name, why: 'already researched for this team tonight' }); continue; }

    const ask = await TeamWriter.writeAsk({ university, team, business: pick, item }, { ai: deps.ai });
    if (!ask.ok) { out.skipped.push({ brand: c.brand_name, why: ask.error }); continue; }

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
    const id = 'udraft_' + crypto.randomBytes(8).toString('hex');
    await pool.query(
      `INSERT INTO university_drafts (id, university_id, team_id, queue_id, brand_key, brand_name, place_id,
          inventory_id, inventory_name, price_cents, subject, body, model, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'awaiting_approval')`,
      [id, university.id, team.id, q.rows[0].id, brandKey, c.brand_name, c.place_id || null,
        item.id, item.name, item.price_cents, ask.subject, ask.body, ask.model]);
    out.drafts.push({ id, brand: c.brand_name, item: item.name, price: TeamWriter.money(item.price_cents),
      subject: ask.subject, body: ask.body, status: 'awaiting_approval', retried: ask.retried });
  }
  return out;
}

module.exports = { runTeamScan, discover, ensureTables, blockedFor, fitFor, pickItem, distanceM, cityOf,
  BLOCKED_KEYS, PAYDAY_MARKERS, CATEGORY_FIT, MIGRATION };
