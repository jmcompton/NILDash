// What does STRIPE_PRICE_ID actually point at?
//
// The athlete plan's price was set in Stripe months ago and nothing in this repo
// records what it is. This asks Stripe directly and prints the answer, including
// the four ways it can be wrong for a $25/month athlete subscription: not
// recurring, not monthly, archived, or in the wrong mode for the key.
//
// Usage (read-only, creates nothing):
//   STRIPE_SECRET_KEY=sk_live_... STRIPE_PRICE_ID=price_... node server/scripts/checkAthletePrice.js
//
// Add STRIPE_AGENT_PRICE_ID to the env to have the agent price checked too.
require('dotenv').config();

const key = (process.env.STRIPE_SECRET_KEY || '').trim();
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set. Nothing to check.');
  process.exit(2);
}

const mode = key.startsWith('sk_live_') ? 'LIVE'
  : key.startsWith('sk_test_') ? 'TEST'
  : key.startsWith('rk_live_') ? 'LIVE (restricted key)'
  : key.startsWith('rk_test_') ? 'TEST (restricted key)'
  : 'UNRECOGNIZED PREFIX';

console.log('Stripe key mode: ' + mode);
console.log('');

const stripe = require('stripe')(key);

async function describe(label, envName) {
  const id = (process.env[envName] || '').trim();
  console.log('── ' + label + '  (' + envName + ') ──');
  if (!id) { console.log('  NOT SET\n'); return; }
  console.log('  id: ' + id);
  let p;
  try {
    p = await stripe.prices.retrieve(id, { expand: ['product'] });
  } catch (e) {
    console.log('  COULD NOT RETRIEVE: ' + e.message);
    if (e.code === 'resource_missing') {
      console.log('  -> This id does not exist in ' + mode + ' mode. A price created in the');
      console.log('     other mode is invisible to this key; that is the usual cause.');
    }
    console.log('');
    return;
  }

  const amount = p.unit_amount != null
    ? '$' + (p.unit_amount / 100).toFixed(2) + ' ' + (p.currency || '').toUpperCase()
    : '(no fixed unit amount — tiered or metered)';
  const recur = p.recurring
    ? 'every ' + (p.recurring.interval_count > 1 ? p.recurring.interval_count + ' ' : '') + p.recurring.interval
      + (p.recurring.interval_count > 1 ? 's' : '')
    : 'ONE-TIME (not a subscription)';

  console.log('  product:  ' + ((p.product && p.product.name) || '(unnamed)'));
  console.log('  amount:   ' + amount);
  console.log('  billing:  ' + recur);
  console.log('  type:     ' + p.type);
  console.log('  livemode: ' + p.livemode);
  console.log('  active:   ' + p.active + (p.product ? '   product active: ' + p.product.active : ''));

  const problems = [
    p.type !== 'recurring'
      && 'Not a subscription price. Checkout runs in mode:"subscription" and Stripe will reject a one-time price.',
    p.recurring && p.recurring.interval !== 'month'
      && 'Billed per ' + p.recurring.interval + ', not per month.',
    p.recurring && p.recurring.interval === 'month' && p.recurring.interval_count !== 1
      && 'Billed every ' + p.recurring.interval_count + ' months, not monthly.',
    p.active === false && 'Archived in Stripe. Checkout will fail.',
    p.product && p.product.active === false && 'Its product is archived. Checkout will fail.',
  ].filter(Boolean);

  if (problems.length) {
    console.log('  PROBLEMS:');
    problems.forEach((x) => console.log('    ! ' + x));
  } else {
    console.log('  OK: recurring, monthly, active — usable as-is.');
  }
  console.log('');
}

(async () => {
  await describe('ATHLETE PRICE', 'STRIPE_PRICE_ID');
  await describe('AGENT PRICE', 'STRIPE_AGENT_PRICE_ID');

  // If the athlete price is missing or wrong, showing what DOES exist is more
  // useful than telling someone to go hunting in the dashboard.
  console.log('── recurring prices visible to this key ──');
  try {
    const list = await stripe.prices.list({ active: true, type: 'recurring', limit: 20, expand: ['data.product'] });
    if (!list.data.length) {
      console.log('  none. Create one: Stripe > Products > Add product, then add a');
      console.log('  recurring monthly price and copy its price_... id into STRIPE_PRICE_ID.');
    }
    list.data.forEach((p) => {
      console.log('  ' + p.id
        + '  $' + ((p.unit_amount || 0) / 100).toFixed(2)
        + '/' + (p.recurring ? p.recurring.interval : '?')
        + '  ' + ((p.product && p.product.name) || '')
        + (p.livemode ? '' : '  [test mode]'));
    });
  } catch (e) {
    console.log('  could not list: ' + e.message);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
