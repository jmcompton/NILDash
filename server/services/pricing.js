'use strict';
// ── TIERED AGENT PRICING (PRICING_V2_ON) ─────────────────────────────────────
//
// Four plans, priced by how many athletes the agent runs. Every plan has every
// feature; only the athlete count differs. Yearly is ten months of the monthly
// price (two months free).
//
//   Starter  up to 10 athletes   $149/month   $1,490/year
//   Growth   up to 20 athletes   $249/month   $2,490/year   (most popular)
//   Pro      up to 30 athletes   $349/month   $3,490/year
//   Agency   up to 50 athletes   $499/month   $4,990/year
//            plus $8 per athlete per month over 50 ($80/year on yearly)
//
// OFF UNTIL THE FOUNDER TURNS IT ON. ON() needs PRICING_V2_ON truthy AND every
// tier's monthly and yearly Stripe price id in the env. Until then checkout
// sells the one $99 plan (STRIPE_AGENT_PRICE_ID) exactly as before.
//
// LEGACY SUBSCRIBERS ARE GRANDFATHERED. users.plan_tier existed before this
// file with older values ('basic', 'pro', 'unlimited', ...) and a default of
// 'basic' on every row, so plan_tier alone cannot say "on a v2 plan". A user is
// on a v2 plan only when plan_period is set too, and plan_period is written
// only by a v2 checkout, a v2 plan change or the webhook reading v2 metadata.
// Anyone else (Chris Sarver at $99, for one) is never limited by a tier.
//
// No price id ever leaves this module through publicTiers(): the page gets
// names, counts and dollars, nothing else.

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());

const TIERS = [
  { key: 'starter', name: 'Starter', athletes: 10, monthly: 149, yearly: 1490 },
  { key: 'growth', name: 'Growth', athletes: 20, monthly: 249, yearly: 2490, popular: true },
  { key: 'pro', name: 'Pro', athletes: 30, monthly: 349, yearly: 3490 },
  { key: 'agency', name: 'Agency', athletes: 50, monthly: 499, yearly: 4990, extra: { monthly: 8, yearly: 80 } },
];
const TIER_KEYS = TIERS.map((t) => t.key);
const PERIODS = ['monthly', 'yearly'];
const AGENCY_INCLUDED = 50;

const tier = (key) => TIERS.find((t) => t.key === String(key || '').toLowerCase()) || null;
const validTier = (key) => (tier(key) ? tier(key).key : null);
const validPeriod = (p) => (PERIODS.includes(String(p || '').toLowerCase()) ? String(p).toLowerCase() : null);

// STRIPE_PRICE_<TIER>_<PERIOD>, read fresh each time so a test (or a redeploy
// with new env) is seen without a restart of this module.
function priceId(tierKey, period) {
  const t = validTier(tierKey), p = validPeriod(period);
  if (!t || !p) return '';
  return String(process.env[`STRIPE_PRICE_${t.toUpperCase()}_${p.toUpperCase()}`] || '').trim();
}
function extraPriceId(period) {
  const p = validPeriod(period);
  if (!p) return '';
  return String(process.env[`STRIPE_PRICE_AGENCY_EXTRA_${p.toUpperCase()}`] || '').trim();
}

function ON() {
  if (!truthy(process.env.PRICING_V2_ON)) return false;
  return TIERS.every((t) => PERIODS.every((p) => !!priceId(t.key, p)));
}

// The smallest plan that fits this many athletes. Over 50 is Agency.
function tierFor(count) {
  const n = Math.max(0, parseInt(count, 10) || 0);
  return (TIERS.find((t) => n <= t.athletes) || TIERS[TIERS.length - 1]).key;
}

// The next plan up, or null from Agency.
function nextTier(tierKey) {
  const i = TIER_KEYS.indexOf(validTier(tierKey));
  return i >= 0 && i < TIERS.length - 1 ? TIERS[i + 1] : null;
}

// Stripe line items for a plan. Agency adds the per-athlete price with the
// number of athletes over 50; nothing is added when that number is 0. A
// missing price id throws: a checkout that silently drops the extra charge
// would undercharge, and one with an empty price would fail at Stripe anyway.
function lineItems(tierKey, period, athleteCount) {
  const t = validTier(tierKey), p = validPeriod(period);
  if (!t || !p) throw new Error('Unknown plan: ' + tierKey + ' / ' + period);
  const base = priceId(t, p);
  if (!base) throw new Error(`The ${tier(t).name} ${p} price is not set.`);
  const items = [{ price: base, quantity: 1 }];
  if (t === 'agency') {
    const over = Math.max(0, (parseInt(athleteCount, 10) || 0) - AGENCY_INCLUDED);
    if (over > 0) {
      const ex = extraPriceId(p);
      if (!ex) throw new Error(`The Agency extra athlete ${p} price is not set.`);
      items.push({ price: ex, quantity: over });
    }
  }
  return items;
}

// On a v2 plan: plan_period set and plan_tier one of the four keys.
function isV2(user) {
  return !!(user && validPeriod(user.plan_period) && validTier(user.plan_tier));
}

function isAdmin(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const admin = String(process.env.ADMIN_EMAIL || 'johnmarkcompton@gmail.com').trim().toLowerCase();
  return String(user.email || '').trim().toLowerCase() === admin;
}

// The athlete ceiling a v2 plan sets, whatever the switch says (services/seats
// reads it too). null: no ceiling. Agency has none while its extra price for
// the agent's period is set (each athlete over 50 is billed); without it,
// Agency stops at 50 rather than adding athletes nobody is charged for.
function tierLimit(user) {
  if (!isV2(user)) return null;
  const t = tier(user.plan_tier);
  if (t.key === 'agency') return extraPriceId(user.plan_period) ? null : AGENCY_INCLUDED;
  return t.athletes;
}

// What the Add Athlete gate enforces: null for legacy subscribers, admins and
// whenever pricing is off.
function limitFor(user) {
  if (!ON() || !isV2(user) || isAdmin(user)) return null;
  return tierLimit(user);
}

// The sentence an agent sees at the limit.
function limitMessage(tierKey) {
  const t = tier(tierKey);
  if (!t) return 'You have reached the athlete limit on your plan.';
  const up = nextTier(t.key);
  if (!up) return `Your ${t.name} plan covers ${t.athletes} athletes. Email contact@mynildash.com to add more.`;
  const upTo = up.key === 'agency' ? `${up.athletes} athletes, plus $${up.extra.monthly} a month for each one after that` : `up to ${up.athletes}`;
  return `Your ${t.name} plan covers ${t.athletes} athletes. Move to ${up.name} for ${upTo}.`;
}

// For GET /api/pricing and the assistant. No price ids.
function publicTiers() {
  return TIERS.map((t) => ({
    key: t.key, name: t.name, athletes: t.athletes, monthly: t.monthly, yearly: t.yearly,
    extra: t.extra ? { monthly: t.extra.monthly, yearly: t.extra.yearly, over: AGENCY_INCLUDED } : null,
    popular: !!t.popular,
  }));
}

// ── THE STRIPE CLIENT ───────────────────────────────────────────────────────
// One place the agent billing routes get Stripe from, so a test can hand in a
// stand-in and never touch the network.
let _stripeFactory = null;
function stripe() {
  if (_stripeFactory) return _stripeFactory();
  return require('stripe')(String(process.env.STRIPE_SECRET_KEY || '').trim());
}
function _setStripeForTests(fn) { _stripeFactory = typeof fn === 'function' ? fn : null; }

// ── THE COLUMNS ─────────────────────────────────────────────────────────────
// plan_tier already exists (store.js); the ALTER is a no-op there and kept so
// this file says everything it needs.
async function ensureColumns(pool) {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_tier TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_period TEXT`);
}

async function athleteCount(pool, userId) {
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM athletes WHERE agent_id = $1`, [userId]);
  return r.rows[0] ? r.rows[0].n : 0;
}

// ── AGENCY: KEEP THE EXTRA-ATHLETE QUANTITY RIGHT ───────────────────────────
// After an athlete is added past 50 on Agency, the per-athlete item on the
// subscription is set to the number over 50 (added when missing). Best effort:
// the caller never waits on it and a failure is only logged.
async function syncAgencyExtra(pool, user, deps = {}) {
  if (!ON() || !isV2(user) || validTier(user.plan_tier) !== 'agency' || !user.stripe_subscription_id) return { skipped: true };
  const extra = extraPriceId(user.plan_period);
  if (!extra) return { skipped: true };
  const s = deps.stripe || stripe();
  const count = await athleteCount(pool, user.id);
  const want = Math.max(0, count - AGENCY_INCLUDED);
  const sub = await s.subscriptions.retrieve(user.stripe_subscription_id);
  const items = (sub && sub.items && sub.items.data) || [];
  const cur = items.find((i) => i && i.price && i.price.id === extra);
  const have = cur ? (cur.quantity || 0) : 0;
  if (have === want) return { unchanged: true, quantity: want };
  let item;
  if (cur && want === 0) item = { id: cur.id, deleted: true };
  else if (cur) item = { id: cur.id, quantity: want };
  else item = { price: extra, quantity: want };
  await s.subscriptions.update(user.stripe_subscription_id, { items: [item], proration_behavior: 'create_prorations' });
  return { updated: true, quantity: want };
}

// ── CHANGE PLAN ─────────────────────────────────────────────────────────────
// { ok, status, error } in plain words, or { ok: true, tier, period }.
async function changePlan(pool, user, body, deps = {}) {
  const b = body || {};
  if (!ON()) return { ok: false, status: 400, error: 'Plan changes are not available right now.' };
  if (!user) return { ok: false, status: 404, error: 'User not found' };
  const t = validTier(b.tier), p = validPeriod(b.period || user.plan_period || 'monthly');
  if (!t || !p) return { ok: false, status: 400, error: 'Pick Starter, Growth, Pro or Agency, monthly or yearly.' };
  if (!isV2(user)) {
    return { ok: false, status: 400, error: 'You are on the founding plan, which stays at the price you signed up at. Email contact@mynildash.com to change it.' };
  }
  if (!user.stripe_subscription_id || !['active', 'trialing'].includes(user.subscription_status)) {
    return { ok: false, status: 400, error: 'There is no active subscription to change. Subscribe first.' };
  }
  if (t === user.plan_tier && p === user.plan_period) return { ok: false, status: 400, error: 'You are already on that plan.' };
  const count = await athleteCount(pool, user.id);
  const target = tier(t);
  if (t !== 'agency' && count > target.athletes) {
    const fits = tier(tierFor(count));
    return { ok: false, status: 400,
      error: `You have ${count} athletes and ${target.name} covers ${target.athletes}. Pick ${fits.name} or larger, or remove athletes first.` };
  }
  let items;
  try { items = lineItems(t, p, count); } catch (e) { return { ok: false, status: 400, error: e.message }; }
  const s = deps.stripe || stripe();
  const sub = await s.subscriptions.retrieve(user.stripe_subscription_id);
  const old = ((sub && sub.items && sub.items.data) || []).map((i) => ({ id: i.id, deleted: true }));
  await s.subscriptions.update(user.stripe_subscription_id, {
    items: [...old, ...items],
    proration_behavior: 'create_prorations',
    metadata: { ...((sub && sub.metadata) || {}), user_id: user.id, tier: t, period: p },
  });
  await pool.query(`UPDATE users SET plan_tier = $1, plan_period = $2 WHERE id = $3`, [t, p, user.id]);
  return { ok: true, tier: t, period: p };
}

module.exports = {
  TIERS, TIER_KEYS, PERIODS, AGENCY_INCLUDED,
  ON, tier, validTier, validPeriod, priceId, extraPriceId, tierFor, nextTier, lineItems,
  isV2, isAdmin, tierLimit, limitFor, limitMessage, publicTiers,
  stripe, _setStripeForTests, ensureColumns, athleteCount, syncAgencyExtra, changePlan,
};
