// server/scripts/verifyReferralStripe.js
//
// End-to-end verification of the referral commission system against Stripe TEST
// MODE using a test clock. NO real money moves and NO live customers are touched.
// It drives the real trial -> paid billing mechanics and runs each generated
// invoice through the SAME code the invoice.payment_succeeded webhook uses
// (store.recordReferralForInvoice), then asserts the referral_commissions rows.
//
// It verifies:
//   1. Trial signup carrying referred_by="pliable" -> $0 trial invoice writes NO
//      commission.
//   2. Advancing the clock past the 7-day trial forces the first paid invoice ->
//      exactly ONE commission row at 20% for partner "pliable".
//   3. Advancing a second billing cycle -> a SECOND commission row (recurring).
//   4. Replaying the same invoice does NOT duplicate (idempotent).
//
// SAFETY
//   - Refuses to run unless STRIPE_SECRET_KEY is a TEST key (sk_test_/rk_test_).
//   - Uses a throwaway test clock, customer, product, and price (all disposable).
//   - Writes one clearly-prefixed "reftest-" user + its commission rows to the DB,
//     prints them, then deletes them (pass --keep to retain for inspection).
//   - Requires --confirm (it writes to the DB and calls the Stripe test API).
//
// Usage:
//   STRIPE_SECRET_KEY=sk_test_... DATABASE_URL=postgres://... \
//     node server/scripts/verifyReferralStripe.js --confirm
'use strict';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

const key = (process.env.STRIPE_SECRET_KEY || '').trim();
if (!/^(sk|rk)_test_/.test(key)) {
  console.error('REFUSING TO RUN: STRIPE_SECRET_KEY must be a TEST key (sk_test_... or rk_test_...).');
  console.error('This verification must never run against live mode. Aborting.');
  process.exit(2);
}
if (!process.env.DATABASE_URL) { console.error('ERROR: set DATABASE_URL (a scratch/staging DB is recommended).'); process.exit(2); }
if (!has('--confirm')) {
  console.error('This writes test rows to DATABASE_URL and calls the Stripe TEST API.');
  console.error('Re-run with --confirm to proceed (add --keep to retain the DB test rows).');
  process.exit(2);
}

const stripe = require('stripe')(key);
const store = require('../store');

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const RATE = 0.20;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  - ' + m); } else { fail++; console.error('  FAIL - ' + m); } };
const usd = (cents) => '$' + (cents / 100).toFixed(2);

async function waitClockReady(clockId) {
  for (let i = 0; i < 60; i++) {
    const c = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (c.status === 'ready') return c;
    if (c.status === 'internal_failure') throw new Error('test clock internal_failure');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('test clock did not become ready in time');
}
async function paidNonZeroInvoices(customerId) {
  const list = await stripe.invoices.list({ customer: customerId, status: 'paid', limit: 100 });
  return list.data.filter((inv) => Number(inv.amount_paid) > 0).sort((a, b) => a.created - b.created);
}

(async () => {
  await store.init(); // idempotent: ensures referral tables + the 'pliable' partner exist

  const partner = await store.getReferralPartner('pliable');
  ok(partner && partner.active && Number(partner.commission_rate) === RATE, `partner "pliable" seeded, active, rate ${RATE}`);
  if (!partner) throw new Error('partner "pliable" not found; run the app once so init() seeds it, or check the DB');

  console.log('\n[1/6] Creating test clock, customer, card, and $99/mo trial subscription (TEST MODE)...');
  const clock = await stripe.testHelpers.testClocks.create({ frozen_time: now });
  const customer = await stripe.customers.create({ test_clock: clock.id, email: `reftest-${now}@example.com`, name: 'Referral E2E Test' });
  const pm = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } });
  await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: pm.id } });
  const product = await stripe.products.create({ name: 'NILDash Referral E2E Test Plan (delete me)' });
  const price = await stripe.prices.create({ product: product.id, unit_amount: 9900, currency: 'usd', recurring: { interval: 'month' } });
  const sub = await stripe.subscriptions.create({
    customer: customer.id, items: [{ price: price.id }], trial_period_days: 7, default_payment_method: pm.id,
  });
  ok(sub.status === 'trialing', `subscription created in trial (status=${sub.status})`);

  const userId = `reftest-${now}`;
  const cleanup = async () => {
    if (has('--keep')) { console.log('\n--keep set: leaving DB test rows and the Stripe test clock in place.'); return; }
    try { await store.pool.query('DELETE FROM referral_commissions WHERE user_id=$1', [userId]); } catch (_) {}
    try { await store.pool.query('DELETE FROM users WHERE id=$1', [userId]); } catch (_) {}
    try { await stripe.testHelpers.testClocks.del(clock.id); } catch (_) {}       // deletes customer + subs + invoices
    try { await stripe.prices.update(price.id, { active: false }); } catch (_) {}
    try { await stripe.products.update(product.id, { active: false }); } catch (_) {}
    console.log('\nCleaned up: DB test rows removed, Stripe test clock + customer deleted.');
  };

  try {
    console.log('\n[2/6] Simulating agent signup: DB user with referred_by="pliable" + this Stripe customer...');
    await store.pool.query(
      `INSERT INTO users (id, name, email, password, role, stripe_customer_id, stripe_subscription_id, subscription_status, referred_by, referred_at, comped)
       VALUES ($1,$2,$3,'x','agent',$4,$5,'trialing','pliable',NOW(),FALSE)
       ON CONFLICT (id) DO UPDATE SET stripe_customer_id=EXCLUDED.stripe_customer_id, referred_by='pliable'`,
      [userId, 'Referral E2E Test', `reftest-${now}@example.com`, customer.id, sub.id]
    );
    const u = await store.getUserByStripeCustomer(customer.id);
    ok(u && u.referred_by === 'pliable' && !u.comped, 'user attributed to "pliable", not comped');

    console.log('\n[3/6] Trial $0 invoice should NOT create a commission...');
    const trialInvoices = await stripe.invoices.list({ customer: customer.id, limit: 10 });
    const zeroInv = trialInvoices.data.find((i) => Number(i.amount_paid) === 0);
    if (zeroInv) {
      const r0 = await store.recordReferralForInvoice(zeroInv);
      ok(!r0.recorded, `trial invoice ${zeroInv.id} produced no commission (${r0.reason})`);
    } else {
      console.log('  (no $0 invoice present yet; fine)');
    }

    console.log('\n[4/6] Advancing test clock past the 7-day trial to force the first paid invoice...');
    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: now + 8 * DAY });
    await waitClockReady(clock.id);
    let paid = await paidNonZeroInvoices(customer.id);
    ok(paid.length >= 1, `first paid invoice generated after trial (found ${paid.length})`);
    const inv1 = paid[0];
    ok(Number(inv1.amount_paid) === 9900, `first paid invoice is ${usd(inv1.amount_paid)} (want $99.00)`);

    console.log('\n[5/6] Running the first paid invoice through the webhook path (store.recordReferralForInvoice)...');
    const c1 = await store.recordReferralForInvoice(inv1);
    ok(c1.recorded, `commission recorded for invoice ${inv1.id}`);
    ok(c1.row && c1.row.commission_amount_cents === Math.round(9900 * RATE), `commission = ${usd(Math.round(9900 * RATE))} (20% of $99.00)`);
    const countAfter1 = (await store.pool.query('SELECT * FROM referral_commissions WHERE user_id=$1 ORDER BY payment_date', [userId])).rows;
    ok(countAfter1.length === 1, `exactly ONE commission row exists (found ${countAfter1.length})`);

    // Idempotency: replay the same invoice.
    const replay = await store.recordReferralForInvoice(inv1);
    ok(!replay.recorded && replay.duplicate, 'replaying the SAME invoice does NOT create a second row (idempotent)');
    const countReplay = (await store.pool.query('SELECT COUNT(*)::int n FROM referral_commissions WHERE user_id=$1', [userId])).rows[0].n;
    ok(countReplay === 1, `still exactly ONE row after replay (found ${countReplay})`);

    console.log('\n[6/6] Advancing a second billing cycle to verify recurring commission...');
    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: now + 40 * DAY });
    await waitClockReady(clock.id);
    paid = await paidNonZeroInvoices(customer.id);
    ok(paid.length >= 2, `a second monthly paid invoice was generated (found ${paid.length})`);
    const inv2 = paid.find((i) => i.id !== inv1.id);
    const c2 = await store.recordReferralForInvoice(inv2);
    ok(c2.recorded, `second-cycle commission recorded for invoice ${inv2.id}`);
    const rows = (await store.pool.query('SELECT * FROM referral_commissions WHERE user_id=$1 ORDER BY payment_date', [userId])).rows;
    ok(rows.length === 2, `TWO commission rows now exist for the recurring subscription (found ${rows.length})`);

    console.log('\n──────────── COMMISSION ROWS WRITTEN ────────────');
    for (const r of rows) {
      console.log(`  partner=${r.partner_code} user=${r.user_id} invoice=${r.stripe_invoice_id} payment=${usd(r.payment_amount_cents)} commission=${usd(r.commission_amount_cents)} rate=${Number(r.commission_rate)} paidOut=${r.paid_out} date=${new Date(r.payment_date).toISOString().slice(0,10)}`);
    }
    console.log('─────────────────────────────────────────────────');
  } finally {
    await cleanup();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await store.pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('\nTHREW:', e && e.message ? e.message : e);
  try { await store.pool.end(); } catch (_) {}
  process.exit(1);
});
