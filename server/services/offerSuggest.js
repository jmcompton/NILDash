'use strict';
// ── THE SUGGESTED OFFER (OFFER_ON) ──────────────────────────────────────────
//
// Every business card says what to offer, in dollars, as a starting point the
// agent can change: "Suggested offer: $250". Two tiers, read from signals we
// already hold about the business, never guessed:
//
//   $250  a small mom-and-pop business
//   $500  a mid-range business or a well-known local institution:
//           a chain location, or
//           250 or more Google reviews, or
//           a price level of $$$ or $$$$, or
//           a price level of $$ with 100 or more reviews
//
// A restaurant or other food business also gets a menu item named after the
// athlete as an add-on ("The Torres Burger").
//
// THE MONEY RULES. Always dollars: never a percentage, never free product on
// its own. A product deal carries a dollar value: "$500 in product".
//
// Pure. The card, the Deal Scan result and the pitch all read it from here.

const ON = () => process.env.OFFER_ON === '1';
const TIERS = { small: 250, mid: 500 };
const REVIEWS_WELL_KNOWN = 250;
const REVIEWS_MID_RANGE = 100;
const MAX_AMOUNT = 100000;

// Google's price level, either API's shape -> 0..4, or null when not given.
function priceLevelOf(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(4, Math.round(v)));
  const s = String(v).toUpperCase();
  const words = { FREE: 0, INEXPENSIVE: 1, MODERATE: 2, EXPENSIVE: 3, VERY_EXPENSIVE: 4 };
  const k = s.replace(/^PRICE_LEVEL_/, '');
  if (k in words) return words[k];
  if (/^\$+$/.test(String(v))) return String(v).length;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(4, Math.round(n))) : null;
}
const dollarsSign = (lvl) => (lvl ? '$'.repeat(lvl) : 'free');

// ── FOOD, AND THE DISH TO NAME ──────────────────────────────────────────────
// First match wins: the more specific trade before the general one.
const DISHES = [
  [/\bpizz/i, 'Pizza'],
  [/\bburger/i, 'Burger'],
  [/\b(boba|bubble tea|tea house|teahouse)\b/i, 'Boba'],
  [/\b(coffee|cafe|café|espresso|roaster)/i, 'Latte'],
  [/\b(smoothie|juice)/i, 'Smoothie'],
  [/\b(ice cream|frozen yogurt|froyo|gelato|creamery|custard)\b/i, 'Sundae'],
  [/\b(donut|doughnut)/i, 'Donut'],
  [/\b(bakery|cookie|cupcake|bake shop)\b/i, 'Cookie'],
  [/\b(taco|taqueria|mexican|tex-mex|burrito)/i, 'Taco'],
  [/\b(bbq|barbecue|smokehouse)\b/i, 'Plate'],
  [/\b(wing|wings)\b/i, 'Wings'],
  [/\b(chicken)\b/i, 'Chicken Sandwich'],
  [/\b(sandwich|deli|sub shop|hoagie)\b/i, 'Sandwich'],
  [/\b(breakfast|brunch|diner|pancake|waffle)\b/i, 'Breakfast'],
  [/\b(sushi|ramen|poke)\b/i, 'Bowl'],
  [/\b(restaurant|grill|bistro|eatery|kitchen|food|bar|pub|tavern|cafeteria|meal|takeaway|dining)\b/i, 'Special'],
];
const FOOD_TYPES = /\b(restaurant|cafe|coffee_shop|bakery|bar|meal_takeaway|meal_delivery|food|ice_cream_shop|pizza_restaurant|fast_food_restaurant|sandwich_shop|juice_shop|dessert_shop|donut_shop|steak_house|brunch_restaurant|breakfast_restaurant)\b/i;

// The dish for a food business, or null when it is not one.
function dishFor({ category, types, name } = {}) {
  const typeText = (Array.isArray(types) ? types : [types]).filter(Boolean).join(' ');
  const text = [category, typeText.replace(/_/g, ' '), name].filter(Boolean).join(' ');
  if (!text.trim()) return null;
  const food = FOOD_TYPES.test(typeText) || DISHES.some(([re]) => re.test(String(category || '') + ' ' + typeText.replace(/_/g, ' ')));
  if (!food) return null;
  for (const [re, dish] of DISHES) if (re.test(text)) return dish;
  return 'Special';
}

// "The Torres Burger": the athlete's last name, or their only name.
function menuItemFor(athleteName, dish) {
  if (!dish) return null;
  const parts = String(athleteName || '').trim().replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, '').split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const n = parts[parts.length - 1].replace(/[^A-Za-z'\-]/g, '');
  if (!n) return null;
  return `The ${n.charAt(0).toUpperCase()}${n.slice(1)} ${dish}`;
}

// ── THE SUGGESTION ──────────────────────────────────────────────────────────
// in: { chain, national, reviews (userRatingCount), priceLevel, category, types, name, athleteName }
// national: a national brand (Deal Scan's Top NIL and social lanes).
// -> { amount, kind: 'cash', tier: 'small' | 'mid', why, menuItem, label }
function suggest(b = {}) {
  const reviews = Number.isFinite(Number(b.reviews)) && b.reviews !== null && b.reviews !== '' ? Number(b.reviews) : null;
  const lvl = priceLevelOf(b.priceLevel);
  const said = [];
  let tier = 'small';
  if (b.national) { tier = 'mid'; said.push('a national brand'); }
  else if (b.chain) { tier = 'mid'; said.push('a chain location'); }
  if (reviews !== null && reviews >= REVIEWS_WELL_KNOWN) { tier = 'mid'; said.push(`well known locally (${reviews.toLocaleString('en-US')} reviews)`); }
  if (lvl !== null && lvl >= 3) { tier = 'mid'; said.push(`a ${dollarsSign(lvl)} price level`); }
  if (tier === 'small' && lvl === 2 && reviews !== null && reviews >= REVIEWS_MID_RANGE) { tier = 'mid'; said.push(`mid-range (${dollarsSign(lvl)}, ${reviews.toLocaleString('en-US')} reviews)`); }
  if (tier === 'small') {
    const bits = [];
    if (reviews !== null) bits.push(`${reviews.toLocaleString('en-US')} reviews`);
    if (lvl !== null) bits.push(`${dollarsSign(lvl)} price level`);
    if (b.chain === false) bits.push('not a chain');
    said.push('a small local business' + (bits.length ? ` (${bits.join(', ')})` : ''));
  }
  // A national brand does not name a menu item after a college athlete.
  const menuItem = b.national ? null : menuItemFor(b.athleteName, dishFor(b));
  const amount = TIERS[tier];
  return { amount, kind: 'cash', tier, why: said.join('; '), menuItem, label: labelOf(amount, 'cash') };
}

// ── WHAT THE AGENT TYPES ────────────────────────────────────────────────────
// "$300", "300", "$1,200" -> 1200. A percentage, a range or no number at all
// is refused, with why. kind: 'cash' | 'product' (a product deal still names
// its dollar value).
function parseOffer(input, kind) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, why: 'Enter a dollar amount.' };
  if (/%|percent/i.test(raw)) return { ok: false, why: 'An offer is a dollar amount, never a percentage.' };
  if (/\d\s*(-|to|–)\s*\$?\d/i.test(raw)) return { ok: false, why: 'One dollar amount, not a range.' };
  const m = raw.replace(/[,\s]/g, '').match(/^\$?(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return { ok: false, why: 'Enter a dollar amount, like 250.' };
  const amount = Math.round(Number(m[1] + (m[2] ? '.' + m[2] : '')));
  if (!(amount > 0)) return { ok: false, why: 'The amount has to be more than $0.' };
  if (amount > MAX_AMOUNT) return { ok: false, why: `The amount has to be $${MAX_AMOUNT.toLocaleString('en-US')} or less.` };
  const k = kind === 'product' ? 'product' : 'cash';
  return { ok: true, amount, kind: k, label: labelOf(amount, k) };
}

// "$250", "$500 in product".
function labelOf(amount, kind) {
  const a = '$' + Number(amount).toLocaleString('en-US');
  return kind === 'product' ? `${a} in product` : a;
}

// ── FROM WHAT GOOGLE SAYS ABOUT THE BUSINESS ────────────────────────────────
// The Places record the night or the scan already holds, plus the chain test.
function forBusiness({ name, place, category, athleteName, franchise } = {}) {
  const pl = place || {};
  let chain = !!franchise;
  try { chain = chain || !!require('./nationalChains').isChainLocation(name); } catch (_) { /* no chain list */ }
  return suggest({
    chain, reviews: pl.userRatingCount != null ? pl.userRatingCount : (pl.user_ratings_total != null ? pl.user_ratings_total : null),
    priceLevel: pl.priceLevel != null ? pl.priceLevel : (pl.price_level != null ? pl.price_level : null),
    category: category || pl.category || pl.primaryType || pl.primary_type || null,
    types: pl.types || null, name, athleteName,
  });
}

// ── DEAL SCAN ───────────────────────────────────────────────────────────────
// Every scan card gets its offer (OFFER_ON). A local card reads the Places
// signals the scan kept (user_ratings_total, price_level, types); a Top NIL or
// social card is a national brand. Recomputed on every serve, so a cached scan
// gets it too. Off: the cards are untouched.
function attachToScan(cards, { athleteName, lane } = {}) {
  if (!ON() || !Array.isArray(cards)) return cards;
  for (const c of cards) {
    if (!c || !(c.brand || c.brand_name)) continue;
    const name = c.brand || c.brand_name;
    const local = c.isLocal === true || (c.lane || lane) === 'local';
    c.offer = local
      ? forBusiness({ name, place: { user_ratings_total: c.user_ratings_total, price_level: c.price_level, types: c.types }, category: c.category,
          athleteName, franchise: c.isFranchise === true || c.chain === true })
      : suggest({ national: true, name, category: c.category, athleteName });
  }
  return cards;
}

// A card's offer as the browser sent it back (Deal Scan, AI Outreach), checked
// again here: the amount by the same rules as an edit, the label rebuilt from
// it. Off, missing or junk -> null.
function fromCard(o) {
  if (!ON() || !o || o.amount == null) return null;
  const p = parseOffer(o.amount, o.kind);
  if (!p.ok) return null;
  const s = Number(o.suggested);
  return { amount: p.amount, kind: p.kind, label: p.label, suggested: Number.isFinite(s) && s > 0 ? Math.round(s) : p.amount,
    menuItem: o.menuItem ? String(o.menuItem).slice(0, 80) : null, why: o.why ? String(o.why).slice(0, 300) : null };
}

// ── ON THE CARD AND ITS DRAFT ───────────────────────────────────────────────
const COLS = 'offer_suggested = $2, offer_amount = $3, offer_kind = $4, offer_menu_item = $5, offer_why = $6';
async function record(pool, { queueId = null, logId = null, offer }) {
  if (!offer || !offer.amount) return;
  const vals = [offer.suggested != null ? offer.suggested : offer.amount, offer.amount, offer.kind || 'cash', offer.menuItem || null, offer.why ? String(offer.why).slice(0, 300) : null];
  if (queueId) await pool.query(`UPDATE outreach_queue SET ${COLS} WHERE id = $1`, [queueId, ...vals])
    .catch((e) => console.error('[offer] card ' + queueId + ': ' + e.message));
  if (logId) await pool.query(`UPDATE outreach_logs SET ${COLS} WHERE id = $1`, [logId, ...vals])
    .catch((e) => console.error('[offer] draft ' + logId + ': ' + e.message));
}

// What a card or draft row carries, for Home. Null when it has none.
function payloadOf(r) {
  if (!r || r.offer_amount == null) return null;
  const amount = Number(r.offer_amount), kind = r.offer_kind === 'product' ? 'product' : 'cash';
  const suggested = r.offer_suggested == null ? null : Number(r.offer_suggested);
  return { amount, kind, label: labelOf(amount, kind), suggested, suggestedLabel: suggested == null ? null : labelOf(suggested, 'cash'),
    edited: suggested !== amount || kind !== 'cash', menuItem: r.offer_menu_item || null, why: r.offer_why || null };
}

// The draft's words follow the offer: the old figure, exactly as the writer
// was told to name it, becomes the new one. Never part of a bigger number.
function swapIn(text, from, to) {
  if (!text || !from || from === to) return { text, changed: false };
  const re = new RegExp(String(from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\d|[,.]\\d)', 'g');
  const out = String(text).replace(re, to);
  return { text: out, changed: out !== text };
}

// ── THE AGENT CHANGES IT ────────────────────────────────────────────────────
// cardId: Home's 'email:<id>' or 'queue:<id>'. The card and its draft both
// take the new amount, and a figure the draft already names is rewritten.
// Never anything sent. -> { ok, offer, rewritten } | { ok:false, status, error }
async function setOffer(pool, agentId, cardId, input, kind) {
  const p = parseOffer(input, kind);
  if (!p.ok) return { ok: false, status: 400, error: p.why };
  const m = /^(email|queue):(.+)$/.exec(String(cardId || ''));
  if (!m) return { ok: false, status: 400, error: 'Which card?' };
  let queue = null, log = null;
  if (m[1] === 'queue') {
    queue = (await pool.query(`SELECT * FROM outreach_queue WHERE id = $1 AND agent_id = $2`, [Number(m[2]) || 0, agentId])).rows[0] || null;
    if (!queue) return { ok: false, status: 404, error: 'That card is not one of yours.' };
    if (queue.outreach_log_id) log = (await pool.query(`SELECT * FROM outreach_logs WHERE id = $1 AND agent_id = $2`, [queue.outreach_log_id, agentId])).rows[0] || null;
  } else {
    log = (await pool.query(`SELECT * FROM outreach_logs WHERE id = $1 AND agent_id = $2`, [m[2], agentId])).rows[0] || null;
    if (!log) return { ok: false, status: 404, error: 'That card is not one of yours.' };
    queue = (await pool.query(`SELECT * FROM outreach_queue WHERE outreach_log_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT 1`, [log.id, agentId])).rows[0] || null;
  }
  if ((queue && (queue.sent_at || queue.state === 'sent')) || (log && log.sent_at)) return { ok: false, status: 409, error: 'This one has gone out already.' };
  const before = payloadOf(log && log.offer_amount != null ? log : queue);
  const fromLabel = before ? before.label : null;
  let rewritten = false;
  if (log) {
    const b = swapIn(log.body_html, fromLabel, p.label);
    rewritten = rewritten || b.changed;
    await pool.query(`UPDATE outreach_logs SET offer_suggested = COALESCE(offer_suggested, $2), offer_amount = $2, offer_kind = $3,
                             body_html = $4, updated_at = NOW() WHERE id = $1 AND sent_at IS NULL`,
      [log.id, p.amount, p.kind, b.text]);
    // A suggestion it never had: the agent's figure is the first one.
    if (log.offer_suggested == null) await pool.query(`UPDATE outreach_logs SET offer_suggested = $2 WHERE id = $1`, [log.id, before ? before.suggested : p.amount]);
  }
  if (queue) {
    const d = swapIn(queue.dm_text, fromLabel, p.label);
    rewritten = rewritten || d.changed;
    await pool.query(`UPDATE outreach_queue SET offer_suggested = COALESCE(offer_suggested, $2), offer_amount = $2, offer_kind = $3,
                             dm_text = $4, updated_at = NOW() WHERE id = $1 AND sent_at IS NULL`,
      [queue.id, p.amount, p.kind, d.text]);
    if (queue.offer_suggested == null && before && before.suggested != null) await pool.query(`UPDATE outreach_queue SET offer_suggested = $2 WHERE id = $1`, [queue.id, before.suggested]);
  }
  const after = log
    ? (await pool.query(`SELECT offer_suggested, offer_amount, offer_kind, offer_menu_item, offer_why FROM outreach_logs WHERE id = $1`, [log.id])).rows[0]
    : (await pool.query(`SELECT offer_suggested, offer_amount, offer_kind, offer_menu_item, offer_why FROM outreach_queue WHERE id = $1`, [queue.id])).rows[0];
  return { ok: true, offer: payloadOf(after), rewritten };
}

module.exports = { ON, TIERS, REVIEWS_WELL_KNOWN, REVIEWS_MID_RANGE, priceLevelOf, dishFor, menuItemFor, suggest, parseOffer, labelOf,
  forBusiness, attachToScan, fromCard, record, payloadOf, swapIn, setOffer };
