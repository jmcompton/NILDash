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
function bucketOf(row) {
  const text = [row.category, row.primary_type, row.primary_type_label, ...(Array.isArray(row.types) ? row.types : []), row.brand || row.brand_name]
    .filter(Boolean).join(' ').toLowerCase().replace(/_/g, ' ');
  for (const [name, p, re] of BUCKETS) if (re.test(text)) return { bucket: name, priority: p };
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
  const rows = (await pool.query(`SELECT brand, category, types, primary_type, primary_type_label FROM university_market_seen WHERE market_key = $1`, [marketKey])).rows;
  for (const r of rows) {
    const b = bucketOf(r);
    await pool.query(`UPDATE university_market_seen SET deal_bucket = $3, deal_priority = $4 WHERE market_key = $1 AND brand = $2`, [marketKey, r.brand, b.bucket, b.priority]);
  }
  return rows.length;
}

// Stored contacts re-judged by today's rules. Returns what was withdrawn, by why.
async function recheckContacts(pool, uni) {
  // Only businesses still in the pool: one the block already withdrew is not re-judged (or double-counted).
  const rows = (await pool.query(`SELECT c.* FROM university_contacts c
       JOIN university_market_seen m ON m.market_key = c.market_key AND m.brand = c.brand AND m.blocked_reason IS NULL
      WHERE c.university_id = $1 AND c.reachable`, [uni.id])).rows;
  const out = [];
  for (const c of rows) {
    let email = c.email, generic = c.generic_email;
    if (email && isGenericInbox(email)) { generic = email; email = null; }
    const why = refusedName(c.contact_name) || refusedTitle(c.contact_title)
      || (!email && !c.phone && !c.instagram ? `only a shared inbox (${generic || 'none'}), no direct address, phone or DM for ${c.contact_name}` : null);
    if (why) {
      await pool.query(`UPDATE university_contacts SET reachable = FALSE, status = 'unreachable', withdrawn_reason = $3, email = $4, generic_email = $5, updated_at = NOW()
                         WHERE university_id = $1 AND brand = $2`, [uni.id, c.brand, why, email, generic]);
      out.push({ brand: c.brand, why: /inbox/.test(why) ? 'shared inbox only' : /not a person|no name/.test(why) ? 'not a person' : 'not a decision maker', detail: why });
    } else if (email !== c.email) {
      await pool.query(`UPDATE university_contacts SET email = NULL, generic_email = $3, updated_at = NOW() WHERE university_id = $1 AND brand = $2`, [uni.id, c.brand, generic]);
      out.push({ brand: c.brand, why: 'shared inbox moved off the person (reached by phone)', detail: generic, kept: true });
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
  await pool.query(`UPDATE university_contacts SET held_reason = NULL WHERE university_id = $1`, [uni.id]);
  for (const h of held) await pool.query(`UPDATE university_contacts SET held_reason = $3 WHERE university_id = $1 AND brand = $2`, [uni.id, h.brand, h.why]);
  return { contactable: rows.length, listed: list.length, held: held.length, list, heldRows: held };
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
  ensureColumns, scorePool, recheckContacts, withdraw, chainsByDomain, dedupe, capList, applyShareCap, histogram, formatHistogram };
