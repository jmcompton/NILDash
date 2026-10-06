'use strict';
// ── WHAT MAKES A CAMPUS BUSINESS LIST WORTH MORE THAN A PLACES SCRAPE ───────
//
// Cypress's first list: 58 contactable businesses, 18 of them dentists and 8
// car dealers, a national chain's store manager, a NASCAR driver as an
// insurer's "decision maker", shared inboxes shown as people, and one cafe
// twice. Every rule for that lives here, shared by the build
// (campusBuild), the night (campusNightly / teamScan) and the contact
// ladder (campusContacts):
//
//   dealPriority     how likely a kind of business is to do an athlete deal.
//                    Ranks; never bans.
//   SHARE_CAP        no single category is more than 15% of the contactable
//                    list. The over-share rows are HELD (held_reason): kept,
//                    resolved, shown lower, never counted or pitched first.
//   refusedTitle     a sponsored athlete, a spokesperson, a creative is not
//                    the decision maker
//   isGenericInbox   info@, customercare@ ... reaches nobody in particular:
//                    it never counts as reaching a named person
//   chainDomain      a contact at a national chain's corporate domain
//                    (bill.m@autozone.com) is a chain location
//   dedupe           one business once: Place ID, then website domain, then
//                    name + address

const SHARE_CAP = 0.15;

// ── HOW LIKELY TO DO AN ATHLETE DEAL ────────────────────────────────────────
// [bucket, priority, test]. First match wins. Priority 1-10.
const BUCKETS = [
  ['sports medicine', 10, /physical therap|physiotherap|sports med|chiropract|orthopedic|sports injury|athletic train|massage|recovery|cryo/],
  ['gym', 10, /\bgym\b|fitness|crossfit|yoga|pilates|martial|boxing|jiu|karate|taekwondo|climb|training|barre|cycle studio|spin/],
  ['smoothie & coffee', 9, /smoothie|juice|coffee|cafe|café|boba|tea house|acai|açaí/],
  ['restaurant', 9, /restaurant|pizza|taco|burger|grill|bbq|barbecue|sushi|ramen|pho|wings|food|diner|deli|sandwich|kitchen|eatery|meal_|bistro|poke|mexican|italian|chinese|thai|korean|vietnamese|indian/],
  ['apparel & sporting', 9, /cloth|apparel|boutique|shoe|sneaker|sporting|sports store|athletic store|bike|surf|skate/],
  ['barber & salon', 8, /barber|hair|salon|nail|lash|brow|spa\b|beauty|tattoo/],
  ['auto', 8, /car_dealer|auto|car dealer|dealership|tire|car wash|car_wash|detail|body shop|motor|collision|car repair|car_repair/],
  ['dessert & bakery', 7, /bakery|dessert|ice cream|donut|doughnut|cookie|cupcake|frozen yogurt|candy|chocolate/],
  ['local retail', 7, /store|shop|retail|market|florist|gift|jewel|pet|book|music|game/],
  ['entertainment', 7, /bowling|arcade|trampoline|cinema|theater|escape|golf|batting|laser tag|amusement|park/],
  ['real estate & insurance & banking', 5, /real estate|realtor|insurance|bank|credit union|mortgage|financial|accountant|tax|law|attorney/],
  ['dentist', 3, /dentist|dental|orthodont/],
  ['medical clinic', 3, /doctor|medical|clinic|urgent care|hospital|health|pharmacy|dermatolog|optomet|eye care|pediatric|physician/],
];
// GOOGLE'S TYPE DECIDES FIRST. The name is only read when Google's type says
// nothing specific: matching names first put "Kids Dental Park" in
// entertainment, "Dentistry at Cypress Market Place" in local retail and
// "Lincoln Ave Dental Spa" with the salons, so 22 dentists never formed one
// category and the 15% cap never had anything to hold.
const PRIORITY = Object.fromEntries(BUCKETS.map(([n, p]) => [n, p]));
const TYPE_BUCKET = [
  [/^(dentist|dental_clinic|orthodontist|endodontist|periodontist|oral_surgeon|dental)/, 'dentist'],
  [/^(physiotherapist|chiropractor|massage|sports_medicine|physical_therap)/, 'sports medicine'],
  [/^(doctor|hospital|medical|medical_clinic|medical_lab|urgent_care|pharmacy|drugstore|health|skin_care_clinic|optometrist|dermatologist|pediatrician|wellness_center)/, 'medical clinic'],
  [/^(gym|fitness_center|yoga_studio|pilates_studio|martial_arts|boxing_gym|sports_club|sports_complex|athletic_field|stadium|swimming_pool)/, 'gym'],
  [/^(cafe|coffee_shop|juice_shop|tea_house|smoothie|acai_shop)/, 'smoothie & coffee'],
  [/^(bakery|dessert_shop|dessert_restaurant|ice_cream_shop|donut_shop|candy_store|chocolate_shop|confectionery)/, 'dessert & bakery'],
  [/(restaurant|^meal_takeaway|^meal_delivery|^fast_food|^food_court|^sandwich_shop|^pizza|^bar_and_grill|^diner|^steak_house|^food$)/, 'restaurant'],
  [/^(clothing_store|shoe_store|sporting_goods_store|bicycle_store|womens_clothing|mens_clothing)/, 'apparel & sporting'],
  [/^(hair_care|hair_salon|barber_shop|beauty_salon|nail_salon|spa|tanning_studio|beautician|makeup_artist|tattoo)/, 'barber & salon'],
  [/^(car_dealer|car_repair|car_wash|auto_parts_store|car_rental|tire_shop|motorcycle_dealer)/, 'auto'],
  [/^(insurance_agency|bank|real_estate_agency|accounting|lawyer|finance|atm|credit_union)/, 'real estate & insurance & banking'],
  [/^(bowling_alley|amusement_park|amusement_center|movie_theater|night_club|tourist_attraction|golf_course|video_arcade|escape_room|trampoline|water_park|park$)/, 'entertainment'],
  [/^(florist|gift_shop|jewelry_store|pet_store|book_store|electronics_store|furniture_store|home_goods_store|hardware_store|department_store|convenience_store|liquor_store|market|store|shopping_mall)/, 'local retail'],
];
const GENERIC_TYPES = new Set(['point_of_interest', 'establishment', 'local', 'premise', 'local_business', 'service', 'store']);
function bucketOf(row) {
  const types = [row.primary_type, ...(Array.isArray(row.types) ? row.types : [])].filter(Boolean).map((t) => String(t).toLowerCase());
  // 1. Google's primary type, then its other types, specific ones first.
  for (const t of types.filter((x) => !GENERIC_TYPES.has(x)).concat(types.filter((x) => GENERIC_TYPES.has(x) && x !== 'store'))) {
    for (const [re, name] of TYPE_BUCKET) if (re.test(t)) return { bucket: name, priority: PRIORITY[name] };
  }
  // 2. Google's own description of it ("Dental clinic"), then our category.
  const described = [row.primary_type_label, row.category].filter(Boolean).join(' ').toLowerCase().replace(/_/g, ' ');
  for (const [name, p, re] of BUCKETS) if (described && re.test(described)) return { bucket: name, priority: p };
  // 3. The name, last.
  const text = String(row.brand || row.brand_name || '').toLowerCase();
  for (const [name, p, re] of BUCKETS) if (text && re.test(text)) return { bucket: name, priority: p };
  if (types.includes('store')) return { bucket: 'local retail', priority: PRIORITY['local retail'] };
  return { bucket: 'other', priority: 5 };
}

// ── THE DECISION MAKER, NOT SOMEONE NEAR IT ─────────────────────────────────
// A sponsored athlete pulled from a state filing (Daniel Suarez, "NASCAR
// driver, sponsorship partner" at Freeway Insurance) is the Phil Knight
// error again. So is a creative or front-line role.
const REFUSED_TITLE = /\b(athlete|driver|player|spokes(person|man|woman)|brand ambassador|ambassador|sponsorship partner|sponsored|endorser|endorsement|influencer|videographer|photographer|content creator|creator|editor|designer|intern|barista|cashier|server|bartender|associate|technician|stylist|receptionist|front desk)\b/i;
function refusedTitle(title) {
  const t = String(title || '');
  if (!t) return null;
  const m = t.match(REFUSED_TITLE);
  if (m) return `"${t}" is not a decision maker (${m[0].toLowerCase()})`;
  try { const tp = require('./ownerNameSearch').titleProblem(t); if (tp) return tp; } catch (_) { /* no helper */ }
  return null;
}
function refusedName(name) {
  const n = String(name || '').trim();
  if (!n) return 'no name';
  if (/^(corporate|headquarters|hq|management|the team|staff|owner|manager|customer (care|service))$/i.test(n)) return `"${n}" is not a person`;
  return null;
}

// ── A SHARED INBOX IS NOT A PERSON ──────────────────────────────────────────
const GENERIC_LOCAL = /^(info|information|customercare|customer\.?care|customerservice|customer\.?service|contact|contactus|contact\.?us|admin|administrator|office|support|service|services|hello|hi|hey|sales|team|inquiries|inquiry|enquiries|enquiry|reservations?|bookings?|booking|events?|mail|email|frontdesk|front\.?desk|reception|care|help|general|marketing|media|press|orders?|careers|jobs|hr|billing|accounts|feedback|webmaster|noreply|no-reply)$/i;
function isGenericInbox(email) {
  const local = String(email || '').toLowerCase().split('@')[0];
  return !!local && GENERIC_LOCAL.test(local.replace(/[+].*$/, ''));
}

// ── A NATIONAL CHAIN'S CORPORATE DOMAIN ─────────────────────────────────────
const FREE = /^(gmail|yahoo|hotmail|outlook|icloud|aol|live|msn|me|proton|protonmail|comcast|att|sbcglobal|verizon)\./;
function domainOf(x) {
  const s = String(x || '').toLowerCase().trim();
  if (!s) return null;
  const d = s.includes('@') ? s.split('@')[1] : s.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  return d && /\./.test(d) ? d : null;
}
function chainDomain(domain) {
  const d = domainOf(domain);
  if (!d || FREE.test(d)) return null;
  const sld = d.split('.').slice(-2, -1)[0] || '';
  const NC = require('./nationalChains');
  const squash = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = NC.NATIONAL_CHAINS.concat(NC.FRANCHISORS || []).find((c) => squash(c).length >= 5 && squash(c) === sld);
  return hit || (/^(confie)$/.test(sld) ? 'confie (Freeway Insurance)' : null);
}

function normName(brand, city) {
  let n = String(brand || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ');
  for (const w of String(city || '').toLowerCase().split(/[^a-z]+/).filter((x) => x.length > 2)) n = n.replace(new RegExp('\\b' + w + '\\b', 'g'), ' ');
  return n.replace(/\b(the|llc|inc|co)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function normAddr(a) {
  return String(a || '').toLowerCase().split(',')[0].replace(/[^a-z0-9 ]/g, ' ').replace(/\b(street|st|avenue|ave|boulevard|blvd|road|rd|suite|ste|unit)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── THE PASSES (all on one university) ──────────────────────────────────────
const WITHDRAWN = 'withdrawn: ';

let _cols = null;
function ensureColumns(pool) {
  if (!_cols) _cols = _ensureColumns(pool).catch((e) => { _cols = null; throw e; });
  return _cols;
}
async function _ensureColumns(pool) {
  await pool.query(`ALTER TABLE university_market_seen ADD COLUMN IF NOT EXISTS deal_priority INTEGER`).catch(() => {});
  await pool.query(`ALTER TABLE university_market_seen ADD COLUMN IF NOT EXISTS deal_bucket TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE university_contacts ADD COLUMN IF NOT EXISTS held_reason TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE university_contacts ADD COLUMN IF NOT EXISTS generic_email TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE university_contacts ADD COLUMN IF NOT EXISTS withdrawn_reason TEXT`).catch(() => {});
}

// Every row's category bucket and priority, stored for sorting.
async function scorePool(pool, marketKey) {
  const rows = (await pool.query(`SELECT brand, category, types, primary_type, primary_type_label, deal_bucket, deal_priority FROM university_market_seen WHERE market_key = $1`, [marketKey])).rows;
  let changed = 0;
  for (const r of rows) {
    const b = bucketOf(r);
    if (r.deal_bucket === b.bucket && Number(r.deal_priority) === b.priority) continue;
    await pool.query(`UPDATE university_market_seen SET deal_bucket = $3, deal_priority = $4 WHERE market_key = $1 AND brand = $2`, [marketKey, r.brand, b.bucket, b.priority]);
    changed++;
  }
  return changed;
}

// Stored contacts re-judged by today's rules. Returns what was withdrawn, by why.
async function recheckContacts(pool, uni) {
  // Only businesses still in the pool: one the block already withdrew is not re-judged (or double-counted).
  // A SHARED INBOX IS A SEND PATH, NOT A PERSON. info@ beside a named person
  // is a way to reach them (the email greets the person by name); it never
  // counts as "a named person's email" and is kept apart as generic_email.
  // A business with a named person and only a shared inbox used to be
  // withdrawn; those come back here.
  await pool.query(
    `UPDATE university_contacts SET reachable = TRUE, status = 'reachable', withdrawn_reason = NULL, updated_at = NOW()
      WHERE university_id = $1 AND NOT reachable AND withdrawn_reason LIKE 'only a shared inbox (%' AND contact_name IS NOT NULL
        AND (COALESCE(generic_email, '') <> '' OR COALESCE(email, '') <> '')`, [uni.id]).catch(() => {});
  const rows = (await pool.query(`SELECT c.* FROM university_contacts c
       JOIN university_market_seen m ON m.market_key = c.market_key AND m.brand = c.brand AND m.blocked_reason IS NULL
      WHERE c.university_id = $1 AND c.reachable`, [uni.id])).rows;
  const out = [];
  for (const c of rows) {
    let email = c.email, generic = c.generic_email;
    if (email && isGenericInbox(email)) { generic = email; email = null; }
    const why = refusedName(c.contact_name) || refusedTitle(c.contact_title)
      || (!c.contact_name ? 'no named person' : null)
      || (!email && !generic && !c.phone && !c.instagram ? `no address, phone or DM for ${c.contact_name}` : null);
    if (why) {
      await pool.query(`UPDATE university_contacts SET reachable = FALSE, status = 'unreachable', withdrawn_reason = $3, email = $4, generic_email = $5, updated_at = NOW()
                         WHERE university_id = $1 AND brand = $2`, [uni.id, c.brand, why, email, generic]);
      out.push({ brand: c.brand, why: /no address, phone or DM/.test(why) ? 'no way to reach them' : /not a person|no name|no named person/.test(why) ? 'not a person' : 'not a decision maker', detail: why });
    } else if (email !== c.email) {
      await pool.query(`UPDATE university_contacts SET email = NULL, generic_email = $3, updated_at = NOW() WHERE university_id = $1 AND brand = $2`, [uni.id, c.brand, generic]);
      out.push({ brand: c.brand, why: 'shared inbox kept apart from the person (still a send path)', detail: generic, kept: true });
    }
  }
  return out;
}

// Rows withdrawn from the pool that blockedFor cannot see (a chain's corporate
// domain, a duplicate). Marked 'withdrawn: ...'; recheckPool keeps them.
async function withdraw(pool, marketKey, brand, why) {
  await pool.query(`UPDATE university_market_seen SET blocked_reason = $3 WHERE market_key = $1 AND brand = $2`, [marketKey, brand, WITHDRAWN + why]);
}

async function chainsByDomain(pool, uni) {
  const rows = (await pool.query(
    `SELECT m.brand, c.email, c.website, c.generic_email FROM university_market_seen m
       JOIN university_contacts c ON c.university_id = $1 AND c.brand = m.brand
      WHERE m.market_key = $2 AND m.blocked_reason IS NULL`, [uni.id, uni.marketKey])).rows;
  const out = [];
  for (const r of rows) {
    const hit = chainDomain(r.email) || chainDomain(r.website) || chainDomain(r.generic_email);
    if (!hit) continue;
    await withdraw(pool, uni.marketKey, r.brand, `national brand: the contact is at ${hit}'s corporate address`);
    out.push({ brand: r.brand, why: 'national chain (corporate address)', detail: hit });
  }
  return out;
}

// One business once: Place ID, then website domain, then name + address.
async function dedupe(pool, uni) {
  const rows = (await pool.query(
    `SELECT m.brand, m.place_id, m.address, m.fit, m.deal_priority, m.user_ratings_total, c.website, c.email, c.generic_email, COALESCE(c.reachable, FALSE) AS reachable
       FROM university_market_seen m LEFT JOIN university_contacts c ON c.university_id = $1 AND c.brand = m.brand
      WHERE m.market_key = $2 AND m.blocked_reason IS NULL`, [uni.id, uni.marketKey])).rows;
  const city = require('./teamScan').cityOf(uni.location) || '';
  const parent = rows.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent[y] = x; };
  const seen = new Map();
  const key = (k, i) => { if (!k) return; if (seen.has(k)) join(seen.get(k), i); else seen.set(k, i); };
  rows.forEach((r, i) => {
    key(r.place_id ? 'p:' + r.place_id : null, i);
    const dom = [r.website, r.email, r.generic_email].map(domainOf).find((d) => d && !FREE.test(d));
    key(dom ? 'd:' + dom : null, i);
    const nn = normName(r.brand, city);
    if (nn && r.address) key('n:' + nn + '|' + normAddr(r.address), i);
  });
  const groups = new Map();
  rows.forEach((r, i) => { const g = find(i); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); });
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (b.reachable - a.reachable) || ((b.deal_priority || 0) - (a.deal_priority || 0)) || ((b.fit || 0) - (a.fit || 0)) || ((b.user_ratings_total || 0) - (a.user_ratings_total || 0)));
    for (const d of g.slice(1)) {
      await withdraw(pool, uni.marketKey, d.brand, `duplicate of ${g[0].brand}`);
      out.push({ brand: d.brand, why: 'duplicate', detail: 'of ' + g[0].brand });
    }
  }
  return out;
}

// ── NO CATEGORY OVER 15% OF THE CONTACTABLE LIST ────────────────────────────
// The list is every business with a named, reachable decision maker, best
// first (priority, then fit). A category over 15% of the list keeps its best
// rows; the rest are HELD (held_reason): kept, not counted, not pitched
// first. Re-run until stable, since holding rows shrinks the list. A
// category may always keep two, so a short list is never emptied.
function capList(rows) {
  let list = rows.slice().sort((a, b) => (b.priority - a.priority) || ((b.fit || 0) - (a.fit || 0)) || String(a.brand).localeCompare(String(b.brand)));
  const held = [];
  for (let pass = 0; pass < 20; pass++) {
    const max = Math.max(2, Math.floor(SHARE_CAP * list.length));
    const count = {}, keep = [];
    let changed = false;
    for (const r of list) {
      count[r.bucket] = (count[r.bucket] || 0) + 1;
      if (count[r.bucket] > max) { held.push({ ...r, why: `${r.bucket} is over ${Math.round(SHARE_CAP * 100)}% of the list` }); changed = true; } else keep.push(r);
    }
    list = keep;
    if (!changed) break;
  }
  return { list, held };
}

async function applyShareCap(pool, uni) {
  await ensureColumns(pool);
  const rows = (await pool.query(
    `SELECT c.brand, m.fit, m.deal_bucket, m.deal_priority, m.category, m.types, m.primary_type, m.primary_type_label FROM university_contacts c
       JOIN university_market_seen m ON m.market_key = c.market_key AND m.brand = c.brand AND m.blocked_reason IS NULL
      WHERE c.university_id = $1 AND c.reachable`, [uni.id])).rows
    .map((r) => { const b = r.deal_bucket ? { bucket: r.deal_bucket, priority: r.deal_priority } : bucketOf(r); return { brand: r.brand, fit: r.fit, bucket: b.bucket, priority: b.priority }; });
  const { list, held } = capList(rows);
  // Only the rows whose state changes are written, so this is cheap enough to
  // run on every read of the list (search, status), not only after a build.
  const heldBy = new Map(held.map((h) => [h.brand, h.why]));
  const now = (await pool.query(`SELECT brand, held_reason FROM university_contacts WHERE university_id = $1 AND (held_reason IS NOT NULL OR reachable)`, [uni.id])).rows;
  for (const r of now) {
    const want = heldBy.get(r.brand) || null;
    if ((r.held_reason || null) !== want) await pool.query(`UPDATE university_contacts SET held_reason = $3 WHERE university_id = $1 AND brand = $2`, [uni.id, r.brand, want]);
  }
  return { contactable: rows.length, listed: list.length, held: held.length, list, heldRows: held };
}

// THE CAP ON EVERY READ. It ran only at the end of a build and the start of a
// night, so a contact found in between was never capped. Search and status
// call this first; it re-scores buckets (scorePool) at most once a minute per
// university and applies the cap.
const _fresh = new Map();
async function ensureCapped(pool, uni, opts = {}) {
  const k = uni.id;
  if (!opts.force && _fresh.has(k) && Date.now() - _fresh.get(k) < 60000) return null;
  _fresh.set(k, Date.now());
  await ensureColumns(pool);
  if (uni.marketKey) await scorePool(pool, uni.marketKey);
  return applyShareCap(pool, uni);
}

// The histogram, for the build's printout: found, contactable, listed.
async function histogram(pool, uni) {
  const rows = (await pool.query(
    `SELECT COALESCE(m.deal_bucket, 'other') AS bucket, MAX(m.deal_priority) AS priority, COUNT(*)::int AS found,
            COUNT(*) FILTER (WHERE c.reachable)::int AS contactable,
            COUNT(*) FILTER (WHERE c.reachable AND c.held_reason IS NULL)::int AS listed
       FROM university_market_seen m LEFT JOIN university_contacts c ON c.university_id = $1 AND c.brand = m.brand
      WHERE m.market_key = $2 AND m.blocked_reason IS NULL GROUP BY 1 ORDER BY 4 DESC, 3 DESC`, [uni.id, uni.marketKey])).rows;
  return rows;
}
function formatHistogram(rows) {
  if (!rows || !rows.length) return '  (no businesses)';
  const listed = rows.reduce((s, r) => s + r.listed, 0) || 1;
  return ['  category                           priority  found  contactable  listed  share of list',
    ...rows.map((r) => `  ${String(r.bucket).padEnd(34)} ${String(r.priority || '').padStart(8)} ${String(r.found).padStart(6)} ${String(r.contactable).padStart(12)} ${String(r.listed).padStart(7)} ${String(Math.round(100 * r.listed / listed) + '%').padStart(14)}`)].join('\n');
}

module.exports = { SHARE_CAP, BUCKETS, bucketOf, refusedTitle, refusedName, isGenericInbox, chainDomain, domainOf, normName, normAddr, WITHDRAWN,
  ensureColumns, scorePool, recheckContacts, withdraw, chainsByDomain, dedupe, capList, applyShareCap, ensureCapped, histogram, formatHistogram };
