'use strict';
// ── TIERED AGENT PRICING (services/pricing, PRICING_V2_ON) ──────────────────
// Local test Postgres. Stripe is a stand-in: the real server is started with a
// preload that hands services/pricing a fake client, so nothing reaches the
// network and every call Stripe would have received is written to a log.
//
//   - ON() only with the flag AND every tier's monthly and yearly price id;
//   - tierFor at the boundaries, lineItems with the Agency extra;
//   - checkout sells the right price, with tier and period in the metadata,
//     and the 14-day trial still rides along;
//   - legacy subscribers are never limited by a tier;
//   - the 11th athlete on Starter is a 402 naming Growth;
//   - change-plan refuses a plan smaller than the roster;
//   - /api/pricing carries no price ids;
//   - off: checkout is the one STRIPE_AGENT_PRICE_ID plan, as before.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('tierpricingtest', { schema: true });
require('./helpers/offlineDns').install();

const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const store = require(REPO + 'server/store.js');
const Pricing = require(REPO + 'server/services/pricing.js');
const Seats = require(REPO + 'server/services/seats.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const P = () => store.pool;
const PASS = 'tier-pass-123';
const EMAIL = (id) => id + '@tier-test.test';
const ADMIN = 'tp-admin@tier-test.test';

// Every price id the founder will set, as test values.
const IDS = {};
for (const t of ['STARTER', 'GROWTH', 'PRO', 'AGENCY']) for (const p of ['MONTHLY', 'YEARLY']) IDS[`STRIPE_PRICE_${t}_${p}`] = `price_tp_${t.toLowerCase()}_${p.toLowerCase()}`;
IDS.STRIPE_PRICE_AGENCY_EXTRA_MONTHLY = 'price_tp_agency_extra_monthly';
IDS.STRIPE_PRICE_AGENCY_EXTRA_YEARLY = 'price_tp_agency_extra_yearly';
const setEnv = (on, ids) => {
  for (const k of Object.keys(IDS)) delete process.env[k];
  delete process.env.PRICING_V2_ON;
  if (on) process.env.PRICING_V2_ON = on;
  Object.assign(process.env, ids || {});
};

// ── THE STRIPE STAND-IN (preloaded into the server) ─────────────────────────
const DIR = '/tmp/pgtest';
fs.mkdirSync(DIR, { recursive: true });
const LOG = DIR + '/tierpricing-stripe.log';
const SESSION = DIR + '/tierpricing-session.json';
const SUB = DIR + '/tierpricing-sub.json';
const PRELOAD = DIR + '/tierpricing-preload.js';
fs.writeFileSync(PRELOAD, `
const fs = require('fs');
const rec = (op, args) => fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ op, args }) + '\\n');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
let n = 0;
const fake = {
  customers: { create: async (a) => { rec('customers.create', a); return { id: 'cus_tp_' + (++n) }; } },
  checkout: { sessions: {
    create: async (a) => { rec('checkout.create', a); return { id: 'cs_tp_' + (++n), url: 'https://checkout.stripe.test/cs_tp_' + n }; },
    retrieve: async (id) => { rec('checkout.retrieve', id); return readJ(${JSON.stringify(SESSION)}, {}); },
  } },
  subscriptions: {
    retrieve: async (id) => { rec('subscriptions.retrieve', id); return readJ(${JSON.stringify(SUB)}, { id, status: 'active', items: { data: [] }, metadata: {} }); },
    update: async (id, a) => { rec('subscriptions.update', { id, a }); return { id }; },
  },
};
require(${JSON.stringify(REPO + 'server/services/pricing.js')})._setStripeForTests(() => fake);
`);
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastCall = (op) => calls().filter((c) => c.op === op).pop();
const clearLog = () => fs.writeFileSync(LOG, '');

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mkUser(id, extra = {}) {
  await P().query(`INSERT INTO users (id, name, email, password, role, plan_tier, plan_period, subscription_status, stripe_customer_id, stripe_subscription_id, seat_override, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
  [id, extra.name || 'Tara Tier', extra.email || EMAIL(id), await bcrypt.hash(PASS, 6), extra.role || 'agent',
    extra.tier || 'basic', extra.period || null, extra.status || 'active', extra.customer || null, extra.sub || null,
    extra.override === undefined ? null : extra.override]);
}
async function roster(agentId, n) {
  for (let i = 0; i < n; i++) {
    await P().query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1, $2, $3::jsonb)`,
      [`${agentId}-a${i}`, agentId, JSON.stringify({ name: `Player ${agentId} ${i}`, school: 'Auburn University', sport: 'Tennis' })]);
  }
}
const countOf = async (id) => (await P().query(`SELECT COUNT(*)::int AS n FROM athletes WHERE agent_id = $1`, [id])).rows[0].n;
const userRow = async (id) => (await P().query(`SELECT * FROM users WHERE id = $1`, [id])).rows[0];

async function boot(extraEnv) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'tier-test', DATABASE_URL: '',
    ADMIN_EMAIL: ADMIN, FOUNDER_EMAILS: '', RESEND_API_KEY: 're_test_dummy', STRIPE_SECRET_KEY: 'sk_test_tierpricing',
    STRIPE_AGENT_PRICE_ID: 'price_tp_legacy_99', STRIPE_WEBHOOK_SECRET: '', SALES_TRIAL_ON: '1', ...extraEnv };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const srv = spawn(process.execPath, ['-r', PRELOAD, REPO + 'server/index.js'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; srv.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
  let up = false;
  for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/api/health')).ok; } catch (_) {} if (!up) await sleep(1000); }
  const login = async (id) => {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL(id), password: PASS }) });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    return (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  };
  return { srv, base, up, err: () => err, login };
}
const post = (call, path, body) => call(path, { method: 'POST', body: JSON.stringify(body || {}) });
const ADD = { name: 'New Player', sport: 'Tennis', school: 'Auburn University' };

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));
  await Pricing.ensureColumns(P());

  // ── THE SWITCH ────────────────────────────────────────────────────────
  OUT.push('-- the switch --');
  setEnv(null, IDS);
  ok('every id set, flag off: off', Pricing.ON() === false);
  const missing = { ...IDS }; delete missing.STRIPE_PRICE_PRO_YEARLY;
  setEnv('1', missing);
  ok('flag on, one tier price missing: off', Pricing.ON() === false);
  setEnv('true', { ...IDS, STRIPE_PRICE_AGENCY_EXTRA_MONTHLY: undefined, STRIPE_PRICE_AGENCY_EXTRA_YEARLY: undefined });
  delete process.env.STRIPE_PRICE_AGENCY_EXTRA_MONTHLY; delete process.env.STRIPE_PRICE_AGENCY_EXTRA_YEARLY;
  ok('flag on, all eight tier prices set: on (extra ids not required)', Pricing.ON() === true);
  setEnv('1', IDS);
  ok('flag on with every id: on', Pricing.ON() === true);

  // ── THE TABLE ─────────────────────────────────────────────────────────
  OUT.push('-- the table --');
  const tf = [[0, 'starter'], [1, 'starter'], [10, 'starter'], [11, 'growth'], [20, 'growth'], [21, 'pro'], [30, 'pro'], [31, 'agency'], [50, 'agency'], [80, 'agency']];
  const badTf = tf.filter(([n, k]) => Pricing.tierFor(n) !== k);
  ok('tierFor: 10 starter, 11 growth, 20 growth, 21 pro, 30 pro, 31 agency, 80 agency', badTf.length === 0, badTf);
  const T = Pricing.TIERS.map((t) => [t.key, t.athletes, t.monthly, t.yearly].join(':')).join(' ');
  ok('the approved prices', T === 'starter:10:149:1490 growth:20:249:2490 pro:30:349:3490 agency:50:499:4990', T);
  ok('yearly is two months free on every tier', Pricing.TIERS.every((t) => t.yearly === t.monthly * 10));
  ok('Agency extra: $8 a month, $80 a year', Pricing.tier('agency').extra.monthly === 8 && Pricing.tier('agency').extra.yearly === 80);
  const li1 = Pricing.lineItems('starter', 'monthly', 4);
  ok('lineItems starter monthly: one item, the starter monthly price', li1.length === 1 && li1[0].price === 'price_tp_starter_monthly' && li1[0].quantity === 1, li1);
  const li2 = Pricing.lineItems('growth', 'yearly', 15);
  ok('lineItems growth yearly: the yearly price', li2.length === 1 && li2[0].price === 'price_tp_growth_yearly', li2);
  const li3 = Pricing.lineItems('agency', 'monthly', 50);
  ok('lineItems agency at 50: no extra item', li3.length === 1 && li3[0].price === 'price_tp_agency_monthly', li3);
  const li4 = Pricing.lineItems('agency', 'monthly', 57);
  ok('lineItems agency at 57: the extra price, quantity 7', li4.length === 2 && li4[1].price === 'price_tp_agency_extra_monthly' && li4[1].quantity === 7, li4);
  const li5 = Pricing.lineItems('agency', 'yearly', 51);
  ok('lineItems agency yearly at 51: the yearly extra, quantity 1', li5.length === 2 && li5[1].price === 'price_tp_agency_extra_yearly' && li5[1].quantity === 1, li5);
  delete process.env.STRIPE_PRICE_AGENCY_EXTRA_MONTHLY;
  let threw = null; try { Pricing.lineItems('agency', 'monthly', 60); } catch (e) { threw = e.message; }
  ok('agency over 50 with no extra price: refused, not undercharged', /extra athlete monthly price is not set/.test(threw || ''), threw);
  setEnv('1', IDS);
  ok('limit message, word for word', Pricing.limitMessage('starter') === 'Your Starter plan covers 10 athletes. Move to Growth for up to 20.', Pricing.limitMessage('starter'));
  ok('no dashes or exclamation marks in any limit message', ['starter', 'growth', 'pro', 'agency'].every((k) => !/[!—–]/.test(Pricing.limitMessage(k))));

  // ── WHO IS LIMITED ────────────────────────────────────────────────────
  OUT.push('-- who is limited --');
  const legacy = { id: 'x', email: 'chris@agency.test', role: 'agent', plan_tier: 'basic', plan_period: null };
  const legacyPro = { ...legacy, plan_tier: 'pro' };
  ok('legacy (plan_tier basic, no period): not a v2 plan, no tier limit', !Pricing.isV2(legacy) && Pricing.limitFor(legacy) === null);
  ok('legacy plan_tier "pro" with no period: still legacy, no tier limit', !Pricing.isV2(legacyPro) && Pricing.limitFor(legacyPro) === null);
  ok('legacy seat rule unchanged (basic 10, old pro 20)', Seats.seatLimitFor(legacy).limit === 10 && Seats.seatLimitFor(legacyPro).limit === 20);
  const st = { ...legacy, plan_tier: 'starter', plan_period: 'monthly' };
  ok('v2 starter: limit 10', Pricing.limitFor(st) === 10 && Seats.seatLimitFor(st).limit === 10);
  ok('v2 growth: limit 20 (not the old ten-seat default)', Seats.seatLimitFor({ ...st, plan_tier: 'growth' }).limit === 20);
  ok('v2 pro: 30, not the old pro 20', Seats.seatLimitFor({ ...st, plan_tier: 'pro', plan_period: 'yearly' }).limit === 30);
  ok('v2 agency: no ceiling (extra billed)', Pricing.limitFor({ ...st, plan_tier: 'agency' }) === null && Seats.seatLimitFor({ ...st, plan_tier: 'agency' }).limit === null);
  ok('admin on a v2 plan: not limited', Pricing.limitFor({ ...st, email: 'johnmarkcompton@gmail.com' }) === null && Pricing.limitFor({ ...st, role: 'admin' }) === null);
  setEnv(null, IDS);
  ok('pricing off: nobody is tier-limited', Pricing.limitFor(st) === null);
  setEnv('1', IDS);
  const pub = JSON.stringify(Pricing.publicTiers());
  ok('publicTiers: four tiers, Growth most popular, no price ids', Pricing.publicTiers().length === 4 && Pricing.publicTiers()[1].popular === true && !/price_/.test(pub), pub);

  // ── THE REAL SERVER, PRICING ON ──────────────────────────────────────
  OUT.push('-- the server, pricing on --');
  await mkUser('tp-growth', { customer: 'cus_tp_growth', status: 'inactive' });
  await roster('tp-growth', 12);
  await mkUser('tp-agency', { customer: 'cus_tp_agency', status: 'inactive' });
  await roster('tp-agency', 55);
  await mkUser('tp-starter10', { tier: 'starter', period: 'monthly', customer: 'cus_tp_s10', sub: 'sub_tp_s10' });
  await roster('tp-starter10', 10);
  await mkUser('tp-starter9', { tier: 'starter', period: 'monthly', customer: 'cus_tp_s9', sub: 'sub_tp_s9' });
  await roster('tp-starter9', 9);
  await mkUser('tp-legacy', { tier: 'basic', customer: 'cus_tp_legacy', sub: 'sub_tp_legacy', override: 0 });
  await roster('tp-legacy', 12);
  await mkUser('tp-legacy10', { tier: 'basic', customer: 'cus_tp_legacy10', sub: 'sub_tp_legacy10' });
  await roster('tp-legacy10', 10);
  await mkUser('tp-agencyfull', { tier: 'agency', period: 'monthly', customer: 'cus_tp_af', sub: 'sub_tp_af' });
  await roster('tp-agencyfull', 50);

  clearLog();
  const S = await boot({ PRICING_V2_ON: '1', ...IDS });
  try {
    ok('the server boots', S.up, S.err().slice(-500));
    const pr = await (await fetch(S.base + '/api/pricing')).json();
    ok('GET /api/pricing: on, four tiers with key, name, athletes, monthly, yearly, extra', pr.on === true && pr.tiers.length === 4
      && ['key', 'name', 'athletes', 'monthly', 'yearly', 'extra'].every((k) => k in pr.tiers[0]) && pr.tiers[3].extra.monthly === 8, pr);
    ok('GET /api/pricing: no price id anywhere in it', !/price_|STRIPE/.test(JSON.stringify(pr)));

    // Checkout.
    const g = await S.login('tp-growth');
    let r = await post(g, '/api/agent/create-checkout', {});
    let j = await r.json();
    let c = lastCall('checkout.create');
    ok('checkout, nothing picked, 12 athletes: Growth monthly', r.status === 200 && j.tier === 'growth' && j.period === 'monthly'
      && c && c.args.line_items.length === 1 && c.args.line_items[0].price === 'price_tp_growth_monthly', [r.status, j, c && c.args.line_items]);
    ok('  tier and period in the session metadata and the subscription metadata', c.args.metadata.user_id === 'tp-growth'
      && c.args.metadata.tier === 'growth' && c.args.metadata.period === 'monthly'
      && c.args.subscription_data && c.args.subscription_data.metadata.tier === 'growth' && c.args.subscription_data.metadata.period === 'monthly', c.args);
    ok('  no trial unless asked', !('trial_period_days' in (c.args.subscription_data || {})));
    r = await post(g, '/api/agent/create-checkout', { tier: 'pro', period: 'yearly' });
    c = lastCall('checkout.create');
    ok('checkout, Pro yearly picked: the Pro yearly price', r.status === 200 && c.args.line_items[0].price === 'price_tp_pro_yearly' && c.args.metadata.tier === 'pro' && c.args.metadata.period === 'yearly', c.args.line_items);
    const before = calls().filter((x) => x.op === 'checkout.create').length;
    r = await post(g, '/api/agent/create-checkout', { tier: 'starter', period: 'monthly' });
    j = await r.json();
    ok('checkout, Starter picked with 12 athletes: refused in plain words, no session', r.status === 400
      && j.error === 'You have 12 athletes and Starter covers 10. Pick Growth or larger.'
      && calls().filter((x) => x.op === 'checkout.create').length === before, [r.status, j]);
    r = await post(g, '/api/agent/create-checkout', { tier: 'gold' });
    j = await r.json();
    ok('checkout, a tier that does not exist: refused', r.status === 400 && /Pick Starter, Growth, Pro or Agency/.test(j.error), j);
    r = await post(g, '/api/agent/create-checkout', { tier: 'growth', period: 'weekly' });
    ok('checkout, a period that does not exist: refused', r.status === 400);

    const a = await S.login('tp-agency');
    r = await post(a, '/api/agent/create-checkout', { tier: 'agency', period: 'monthly' });
    c = lastCall('checkout.create');
    ok('checkout, Agency with 55 athletes: base plus 5 extra athletes', r.status === 200 && c.args.line_items.length === 2
      && c.args.line_items[0].price === 'price_tp_agency_monthly' && c.args.line_items[1].price === 'price_tp_agency_extra_monthly'
      && c.args.line_items[1].quantity === 5, c && c.args.line_items);

    // Back from Stripe.
    fs.writeFileSync(SESSION, JSON.stringify({ id: 'cs_x', subscription: 'sub_tp_growth', metadata: { user_id: 'tp-growth', tier: 'growth', period: 'yearly' } }));
    fs.writeFileSync(SUB, JSON.stringify({ id: 'sub_tp_growth', status: 'active', items: { data: [{ id: 'si_g1', price: { id: 'price_tp_growth_yearly' }, quantity: 1 }] }, metadata: { tier: 'growth', period: 'yearly' } }));
    r = await g('/api/agent/stripe-complete?session_id=cs_x');
    let u = await userRow('tp-growth');
    ok('stripe-complete stores plan_tier and plan_period from the metadata', r.status === 302 && u.plan_tier === 'growth' && u.plan_period === 'yearly'
      && u.stripe_subscription_id === 'sub_tp_growth' && u.subscription_status === 'active', [r.status, u.plan_tier, u.plan_period, u.subscription_status]);

    // The athlete limit.
    const s10 = await S.login('tp-starter10');
    r = await post(s10, '/api/athletes', ADD);
    j = await r.json();
    ok('the 11th athlete on Starter: 402', r.status === 402, [r.status, j]);
    ok('  in plain words', j.error === 'Your Starter plan covers 10 athletes. Move to Growth for up to 20.', j.error);
    ok('  with {upgrade: {tier, monthly}}', j.upgrade && j.upgrade.tier === 'growth' && j.upgrade.monthly === 249 && j.code === 'PLAN_LIMIT', j.upgrade);
    ok('  and nothing was added', (await countOf('tp-starter10')) === 10);
    const s9 = await S.login('tp-starter9');
    r = await post(s9, '/api/athletes', ADD);
    ok('the 10th athlete on Starter: added', r.status === 201 && (await countOf('tp-starter9')) === 10, r.status);

    const lg = await S.login('tp-legacy');
    r = await post(lg, '/api/athletes', ADD);
    ok('a legacy $99 subscriber with 12 athletes: added, never tier-limited', r.status === 201 && (await countOf('tp-legacy')) === 13, r.status);
    const lg10 = await S.login('tp-legacy10');
    r = await post(lg10, '/api/athletes', ADD);
    j = await r.json();
    ok('a legacy subscriber at the old seat rule: the old answer, not a 402', r.status === 403 && j.code === 'SEAT_LIMIT_REACHED', [r.status, j.code]);
    r = await post(lg, '/api/agent/change-plan', { tier: 'pro', period: 'monthly' });
    j = await r.json();
    ok('change-plan for a legacy subscriber: refused, the founding price stays', r.status === 400 && /founding plan/.test(j.error), j);

    // Agency past 50.
    clearLog();
    fs.writeFileSync(SUB, JSON.stringify({ id: 'sub_tp_af', status: 'active', items: { data: [{ id: 'si_af1', price: { id: 'price_tp_agency_monthly' }, quantity: 1 }] }, metadata: {} }));
    const af = await S.login('tp-agencyfull');
    r = await post(af, '/api/athletes', ADD);
    ok('the 51st athlete on Agency: added, no 402', r.status === 201 && (await countOf('tp-agencyfull')) === 51, r.status);
    let up = null;
    for (let i = 0; i < 20 && !up; i++) { await sleep(200); up = lastCall('subscriptions.update'); }
    ok('  and the extra-athlete item goes on the subscription, quantity 1, prorated', up && up.args.id === 'sub_tp_af'
      && up.args.a.items.length === 1 && up.args.a.items[0].price === 'price_tp_agency_extra_monthly' && up.args.a.items[0].quantity === 1
      && up.args.a.proration_behavior === 'create_prorations', up);

    // Change plan.
    clearLog();
    await P().query(`UPDATE users SET plan_tier = 'growth', plan_period = 'monthly', subscription_status = 'active' WHERE id = 'tp-growth'`);
    fs.writeFileSync(SUB, JSON.stringify({ id: 'sub_tp_growth', status: 'active', items: { data: [{ id: 'si_g1', price: { id: 'price_tp_growth_monthly' }, quantity: 1 }] }, metadata: { user_id: 'tp-growth', tier: 'growth', period: 'monthly' } }));
    r = await post(g, '/api/agent/change-plan', { tier: 'starter', period: 'monthly' });
    j = await r.json();
    ok('change-plan to a plan smaller than the roster: refused in plain words', r.status === 400
      && j.error === 'You have 12 athletes and Starter covers 10. Pick Growth or larger, or remove athletes first.', [r.status, j]);
    ok('  and Stripe was not touched', !lastCall('subscriptions.update'));
    ok('  nor the plan', (await userRow('tp-growth')).plan_tier === 'growth');
    r = await post(g, '/api/agent/change-plan', { tier: 'growth', period: 'monthly' });
    ok('change-plan to the plan already held: refused', r.status === 400);
    r = await post(g, '/api/agent/change-plan', { tier: 'pro', period: 'yearly' });
    j = await r.json();
    up = lastCall('subscriptions.update');
    ok('change-plan to Pro yearly: done', r.status === 200 && j.ok === true && j.tier === 'pro' && j.period === 'yearly', [r.status, j]);
    ok('  the old item removed, the Pro yearly item added, prorated', up && up.args.id === 'sub_tp_growth'
      && up.args.a.items.some((i) => i.id === 'si_g1' && i.deleted === true)
      && up.args.a.items.some((i) => i.price === 'price_tp_pro_yearly' && i.quantity === 1)
      && up.args.a.proration_behavior === 'create_prorations', up && up.args);
    ok('  the subscription metadata names the new plan', up.args.a.metadata.tier === 'pro' && up.args.a.metadata.period === 'yearly');
    u = await userRow('tp-growth');
    ok('  and the users columns follow', u.plan_tier === 'pro' && u.plan_period === 'yearly', [u.plan_tier, u.plan_period]);

    // The webhook keeps the columns in step.
    const hook = (ev) => fetch(S.base + '/api/athlete/stripe-webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev) });
    await hook({ type: 'customer.subscription.updated', data: { object: { id: 'sub_tp_s9', customer: 'cus_tp_s9', status: 'active', metadata: { tier: 'growth', period: 'yearly' } } } });
    u = await userRow('tp-starter9');
    ok('webhook: subscription metadata sets plan_tier and plan_period', u.plan_tier === 'growth' && u.plan_period === 'yearly', [u.plan_tier, u.plan_period]);
    await hook({ type: 'customer.subscription.updated', data: { object: { id: 'sub_tp_legacy', customer: 'cus_tp_legacy', status: 'active', metadata: {} } } });
    u = await userRow('tp-legacy');
    ok('webhook: a legacy subscription (no metadata) stays legacy', u.plan_tier === 'basic' && u.plan_period === null, [u.plan_tier, u.plan_period]);

    // The 14-day trial with tiers.
    clearLog();
    r = await fetch(S.base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Trial Tom', email: 'tp-trial-on@tier-test.test', password: PASS, role: 'agent', trial: '14', tier: 'growth', period: 'yearly' }) });
    j = await r.json();
    c = lastCall('checkout.create');
    ok('14-day trial signup, pricing on: trial kept, the picked plan sold', r.status === 200 && !!j.checkoutUrl && c
      && c.args.subscription_data.trial_period_days === 14 && c.args.line_items[0].price === 'price_tp_growth_yearly'
      && c.args.subscription_data.metadata.tier === 'growth' && c.args.subscription_data.metadata.trial_days === '14', c && c.args);
  } finally {
    S.srv.kill('SIGTERM');
    await sleep(500);
  }

  // ── THE REAL SERVER, PRICING OFF ─────────────────────────────────────
  OUT.push('-- the server, pricing off: as before --');
  await mkUser('tp-off', { customer: 'cus_tp_off', status: 'inactive' });
  await roster('tp-off', 12);
  clearLog();
  const O = await boot({ PRICING_V2_ON: undefined, ...Object.fromEntries(Object.keys(IDS).map((k) => [k, undefined])) });
  try {
    ok('the server boots', O.up, O.err().slice(-500));
    const pr = await (await fetch(O.base + '/api/pricing')).json();
    ok('GET /api/pricing: off, no tiers', pr.on === false && Array.isArray(pr.tiers) && pr.tiers.length === 0, pr);
    const o = await O.login('tp-off');
    const r = await post(o, '/api/agent/create-checkout', { tier: 'pro', period: 'yearly' });
    const j = await r.json();
    const c = lastCall('checkout.create');
    ok('checkout: the one STRIPE_AGENT_PRICE_ID plan, whatever was picked', r.status === 200 && !!j.url && c
      && JSON.stringify(c.args.line_items) === JSON.stringify([{ price: 'price_tp_legacy_99', quantity: 1 }]), c && c.args.line_items);
    ok('  metadata exactly as before: user_id only, no subscription_data', JSON.stringify(c.args.metadata) === JSON.stringify({ user_id: 'tp-off' })
      && !('subscription_data' in c.args), c.args);
    fs.writeFileSync(SESSION, JSON.stringify({ id: 'cs_off', subscription: 'sub_tp_off', metadata: { user_id: 'tp-off' } }));
    fs.writeFileSync(SUB, JSON.stringify({ id: 'sub_tp_off', status: 'active', items: { data: [] } }));
    await o('/api/agent/stripe-complete?session_id=cs_off');
    const u = await userRow('tp-off');
    ok('stripe-complete: active, and no plan_period (a $99 subscriber stays legacy)', u.subscription_status === 'active' && u.plan_period === null, [u.subscription_status, u.plan_period]);
    const cp = await post(o, '/api/agent/change-plan', { tier: 'pro', period: 'monthly' });
    ok('change-plan is not available', cp.status === 400);
    clearLog();
    const sr = await fetch(O.base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Trial Tia', email: 'tp-trial-off@tier-test.test', password: PASS, role: 'agent', trial: '14' }) });
    const tc = lastCall('checkout.create');
    ok('14-day trial signup, pricing off: the $99 price with the 14-day trial, as before', sr.status === 200 && tc
      && tc.args.line_items[0].price === 'price_tp_legacy_99' && tc.args.subscription_data.trial_period_days === 14
      && JSON.stringify(tc.args.subscription_data.metadata) === JSON.stringify({ trial_days: '14' }), tc && tc.args);
  } finally {
    O.srv.kill('SIGTERM');
    await sleep(300);
  }

  // ── THE PAGE AND THE ASSISTANT ──────────────────────────────────────
  OUT.push('-- the page and the assistant --');
  const H = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('the homepage keeps its $99 text for when pricing is off', /<div class="cost">\$99<span>\/month<\/span><\/div>/.test(H) && /<div class="price">\$99<span>\/month<\/span><\/div>/.test(H));
  ok('a hidden plans section with the monthly/yearly toggle', /<section id="agent-plans" class="pricing" style="display:none">/.test(H)
    && /data-period="monthly"/.test(H) && /data-period="yearly"/.test(H));
  ok('the approved lines', H.includes('Every plan includes every feature: daily pitches for every athlete, automatic sending, your own pitch script, the CRM and media kits.')
    && H.includes('Less than one local deal a month.') && H.includes('Most popular'));
  ok('the page reads /api/pricing, and the subscribe button sends tier and period', /\/api\/pricing/.test(H)
    && /body: JSON\.stringify\(pricingOn\(\) \? \{ tier: tier, period: period \|\| 'monthly' \} : \{\}\)/.test(H));
  ok('the picker preselects the smallest plan that fits', /__pickTier = pricingTierFor\(count\)/.test(H));
  ok('a 402 PLAN_LIMIT opens the move-up prompt', /data\.code === 'PLAN_LIMIT'\) showPlanLimitModal\(data\)/.test(H));
  const blk = H.slice(H.indexOf('// ── TIERED AGENT PRICING'), H.indexOf('(function () {\n  if (window.__nilSubGuard) return;'));
  const newCopy = blk.split('\n').filter((l) => !/\$99\/mo/.test(l) && !/^\s*\/\//.test(l) && !/FOUNDING ACCESS|founding rate|Founding rate/.test(l));
  ok('new copy: no em or en dashes', !newCopy.some((l) => /[—–]/.test(l)), newCopy.filter((l) => /[—–]/.test(l)).slice(0, 2));
  ok('new copy: no exclamation marks in text', !newCopy.some((l) => /'[^']*[A-Za-z.]![^=][^']*'/.test(l)));
  const AK = require(REPO + 'server/services/assistantKnowledge.js');
  setEnv(null, IDS);
  ok('assistant, pricing off: the $99 wording', /\$99 a month per agent/.test(AK.pricingText()));
  setEnv('1', IDS);
  const on = AK.pricingText();
  ok('assistant, pricing on: the four plans', /Starter: up to 10 athletes, \$149 a month or \$1,490 a year/.test(on)
    && /Agency: up to 50 athletes, \$499 a month or \$4,990 a year, plus \$8 a month/.test(on) && !/price_/.test(on), on);

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); console.log(OUT.join('\n')); process.exit(1); });
