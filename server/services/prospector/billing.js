'use strict';
// ── PROSPECTOR PLANS, CHECKOUT, CUSTOMERS AND TERRITORIES ───────────────────
//
// Three plans, sold to IT companies with no call: a sample page's "Lock your
// area" button opens Stripe Checkout, the webhook makes the customer, and the
// area is theirs. Annual is ten months of the monthly price (two months free).
//
//   Starter       $299/mo   $2,990/yr    25 a month, leads only, they send
//   Territory     $499/mo   $4,990/yr    100 a month, we send from their mailbox (most popular)
//   Done For You  $1,499/mo $14,990/yr   300 a month, we send and answer replies
//
// Prices live in Stripe under lookup keys (prospector_<plan>_<period>). The
// first checkout creates any that are missing, so nothing has to be pasted
// into Railway. Founder approved creating these products on Nov 1 2026.
//
// ONE IT COMPANY PER AREA. An area ("Birmingham, AL") is a key
// ("birmingham-al"). Checkout refuses an area someone already holds, and the
// webhook claims it. Every plan claims its area.
//
// Kept apart from NILDash's own billing: our metadata is product=prospector
// and prospector_plan, never the "tier" key NILDash's webhook reads.

const crypto = require('crypto');

const PLANS = [
  { key: 'starter', name: 'Starter', monthly: 299, yearly: 2990, perMonth: 25, sends: false,
    blurb: '25 local businesses a month with an email gap, the owner\'s verified email and a written first email. You send them.' },
  { key: 'territory', name: 'Territory', monthly: 499, yearly: 4990, perMonth: 100, sends: true, popular: true, guarantee: true,
    blurb: 'We email 100 local businesses a month for you, from your own mailbox, with follow-ups. Replies land in your inbox.' },
  { key: 'dfy', name: 'Done For You', monthly: 1499, yearly: 14990, perMonth: 300, sends: true, replies: true, guarantee: true,
    blurb: '300 a month, and we answer the replies and book the meetings on your calendar.' },
];
const PERIODS = ['monthly', 'yearly'];
const plan = (k) => PLANS.find((p) => p.key === String(k || '').toLowerCase()) || null;
const validPeriod = (p) => (PERIODS.includes(String(p || '').toLowerCase()) ? String(p).toLowerCase() : null);
const lookupKey = (p, period) => `prospector_${p}_${period}`;
const BRAND = () => String(process.env.PROSPECTOR_BRAND || 'Prospector');

// What a page may show: names, counts, dollars. Never a price id.
function publicPlans() {
  return PLANS.map(({ key, name, monthly, yearly, perMonth, sends, popular, guarantee, replies, blurb }) =>
    ({ key, name, monthly, yearly, perMonth, sends: !!sends, popular: !!popular, guarantee: !!guarantee, replies: !!replies, blurb,
      perLead: Math.round((monthly / perMonth) * 100) / 100 }));
}

// "Birmingham, AL" / "birmingham al" / " Birmingham,  AL " -> "birmingham-al"
function areaKey(area) {
  return String(area || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

let _stripeFactory = null;
function stripe() {
  if (_stripeFactory) return _stripeFactory();
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) throw Object.assign(new Error('Stripe is not configured (STRIPE_SECRET_KEY)'), { status: 503 });
  return require('stripe')(key);
}

let _ensured = false;
async function ensureTables(pool) {
  if (_ensured) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS prospector_customers (
    id SERIAL PRIMARY KEY, token TEXT UNIQUE NOT NULL, email TEXT, company TEXT, sender_name TEXT, about TEXT,
    area TEXT, area_key TEXT, plan TEXT, period TEXT, status TEXT NOT NULL DEFAULT 'pending',
    stripe_customer_id TEXT, stripe_subscription_id TEXT, checkout_session_id TEXT UNIQUE, sample_token TEXT,
    onboarded_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospector_territories (
    area_key TEXT PRIMARY KEY, area TEXT, customer_id INT REFERENCES prospector_customers(id) ON DELETE CASCADE,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  _ensured = true;
}

// Who holds this area, if anyone (a canceled customer releases it).
async function areaHolder(pool, area) {
  await ensureTables(pool);
  const k = areaKey(area);
  if (!k) return null;
  const r = await pool.query(`SELECT t.area_key, t.area, c.id, c.company, c.status FROM prospector_territories t
    JOIN prospector_customers c ON c.id = t.customer_id WHERE t.area_key = $1`, [k]);
  const row = r.rows[0];
  return row && row.status !== 'canceled' ? row : null;
}

// The Stripe price for a plan and period, created on first use.
async function ensurePrice(s, planKey, period) {
  const p = plan(planKey), per = validPeriod(period);
  if (!p || !per) throw Object.assign(new Error('unknown plan or period'), { status: 400 });
  const lk = lookupKey(p.key, per);
  const found = await s.prices.list({ lookup_keys: [lk], active: true, limit: 1 });
  if (found && found.data && found.data[0]) return found.data[0].id;
  const productName = `${BRAND()} ${p.name}`;
  let productId = null;
  const prods = await s.products.search({ query: `metadata['prospector_plan']:'${p.key}'` }).catch(() => null);
  if (prods && prods.data && prods.data[0]) productId = prods.data[0].id;
  if (!productId) {
    const prod = await s.products.create({ name: productName, description: p.blurb, metadata: { product: 'prospector', prospector_plan: p.key } });
    productId = prod.id;
  }
  const price = await s.prices.create({
    product: productId, currency: 'usd', unit_amount: (per === 'yearly' ? p.yearly : p.monthly) * 100,
    recurring: { interval: per === 'yearly' ? 'year' : 'month' }, lookup_key: lk, transfer_lookup_key: true,
    metadata: { product: 'prospector', prospector_plan: p.key, period: per },
  });
  return price.id;
}

// A Stripe Checkout session for one plan in one area. -> { url, id }
async function createCheckout(pool, input, deps = {}) {
  const p = plan(input.plan), per = validPeriod(input.period);
  if (!p || !per) throw Object.assign(new Error('Pick a plan and monthly or yearly.'), { status: 400 });
  const area = String(input.area || '').trim();
  if (!areaKey(area)) throw Object.assign(new Error('Which area is this for?'), { status: 400 });
  const held = await areaHolder(pool, area);
  if (held) throw Object.assign(new Error(`${held.area || area} is already taken by another IT company.`), { status: 409 });
  const s = deps.stripe || stripe();
  const price = await ensurePrice(s, p.key, per);
  const base = String(input.baseUrl || process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, '');
  const md = { product: 'prospector', prospector_plan: p.key, period: per, area: area.slice(0, 200), area_key: areaKey(area),
    sample_token: String(input.sampleToken || '').slice(0, 64), company: String(input.company || '').slice(0, 200) };
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    success_url: `${base}/prospector/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: input.sampleToken ? `${base}/s/${encodeURIComponent(input.sampleToken)}` : `${base}/it`,
    allow_promotion_codes: true,
    customer_email: input.email && /@/.test(input.email) ? String(input.email).trim() : undefined,
    metadata: md,
    subscription_data: { metadata: md },
  });
  return { url: session.url, id: session.id };
}

// checkout.session.completed for a Prospector session: the customer, and the area.
async function onCheckoutCompleted(pool, session) {
  const md = (session && session.metadata) || {};
  if (md.product !== 'prospector') return null;
  await ensureTables(pool);
  const token = crypto.randomBytes(18).toString('base64url');
  const email = (session.customer_details && session.customer_details.email) || session.customer_email || null;
  const r = await pool.query(`INSERT INTO prospector_customers (token, email, company, area, area_key, plan, period, status,
      stripe_customer_id, stripe_subscription_id, checkout_session_id, sample_token)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10,$11)
    ON CONFLICT (checkout_session_id) DO UPDATE SET updated_at = NOW() RETURNING *`,
  [token, email, md.company || null, md.area || null, md.area_key || areaKey(md.area), md.prospector_plan, md.period,
    session.customer || null, session.subscription || null, session.id, md.sample_token || null]);
  const c = r.rows[0];
  if (c.area_key) {
    // Claim the area. If someone else got there between checkout and payment,
    // keep the payment and flag it rather than lose the customer.
    const claim = await pool.query(`INSERT INTO prospector_territories (area_key, area, customer_id) VALUES ($1,$2,$3)
      ON CONFLICT (area_key) DO NOTHING RETURNING area_key`, [c.area_key, c.area, c.id]);
    if (!claim.rows.length) {
      const holder = await pool.query(`SELECT customer_id FROM prospector_territories WHERE area_key = $1`, [c.area_key]);
      if (holder.rows[0] && holder.rows[0].customer_id !== c.id) {
        await pool.query(`UPDATE prospector_customers SET status = 'area-conflict' WHERE id = $1`, [c.id]);
        c.status = 'area-conflict';
      }
    }
  }
  return c;
}

// customer.subscription.* for a Prospector subscription: keep status in step.
async function onSubscription(pool, sub, eventType) {
  const md = (sub && sub.metadata) || {};
  if (md.product !== 'prospector') return null;
  await ensureTables(pool);
  const status = eventType === 'customer.subscription.deleted' ? 'canceled' : (sub.status || 'canceled');
  const r = await pool.query(`UPDATE prospector_customers SET status = CASE WHEN status = 'area-conflict' THEN status ELSE $1 END,
      plan = COALESCE($2, plan), period = COALESCE($3, period), updated_at = NOW() WHERE stripe_subscription_id = $4 RETURNING *`,
  [status, plan(md.prospector_plan) ? md.prospector_plan : null, validPeriod(md.period), sub.id]);
  // A canceled customer releases the area.
  if (status === 'canceled' && r.rows[0]) await pool.query(`DELETE FROM prospector_territories WHERE customer_id = $1`, [r.rows[0].id]);
  return r.rows[0] || null;
}

// The welcome page: the customer by their checkout session (proved with Stripe).
async function byCheckoutSession(pool, sessionId) {
  await ensureTables(pool);
  const r = await pool.query(`SELECT * FROM prospector_customers WHERE checkout_session_id = $1`, [String(sessionId || '')]);
  return r.rows[0] || null;
}

async function onboard(pool, sessionId, body, deps = {}) {
  let c = await byCheckoutSession(pool, sessionId);
  if (!c) {
    // The webhook may not have landed yet: read the session from Stripe.
    const s = deps.stripe || stripe();
    const session = await s.checkout.sessions.retrieve(String(sessionId || ''));
    if (!session || session.status !== 'complete') throw Object.assign(new Error('That checkout is not complete.'), { status: 404 });
    c = await onCheckoutCompleted(pool, session);
    if (!c) throw Object.assign(new Error('Not a Prospector checkout.'), { status: 404 });
  }
  const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n) || null;
  const r = await pool.query(`UPDATE prospector_customers SET company = COALESCE($2, company), sender_name = COALESCE($3, sender_name),
      about = COALESCE($4, about), email = COALESCE($5, email), onboarded_at = COALESCE(onboarded_at, NOW()), updated_at = NOW()
    WHERE id = $1 RETURNING *`, [c.id, clip(body.company, 200), clip(body.senderName, 120), clip(body.about, 500), clip(body.email, 200)]);
  return r.rows[0];
}

async function byToken(pool, token) {
  await ensureTables(pool);
  const r = await pool.query(`SELECT * FROM prospector_customers WHERE token = $1`, [String(token || '')]);
  return r.rows[0] || null;
}

module.exports = { PLANS, publicPlans, plan, validPeriod, lookupKey, areaKey, areaHolder, ensurePrice, createCheckout,
  onCheckoutCompleted, onSubscription, byCheckoutSession, onboard, byToken, ensureTables, BRAND, stripe,
  _setStripeForTests(fn) { _stripeFactory = typeof fn === 'function' ? fn : null; }, _reset() { _ensured = false; } };
