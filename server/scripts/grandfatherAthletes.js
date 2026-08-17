// Stamp every athlete who exists TODAY as free-before-billing, so turning
// BILLING_ENABLED on cannot lock out somebody who was told the portal was free.
//
// Why it is needed even though athleteHasAccess already grants on
// subscription_status='free': that column is Stripe's to write. One
// customer.subscription.updated moves a row off 'free' forever and the fact that
// the account predates billing is gone. free_before_billing is write-once and
// Stripe never touches it.
//
// Run this BEFORE setting BILLING_ENABLED=true. It is idempotent -- COALESCE means
// running it twice does not move a stamp that already exists.
//
//   DATABASE_URL=postgres://... node server/scripts/grandfatherAthletes.js          # preview
//   DATABASE_URL=postgres://... node server/scripts/grandfatherAthletes.js --write  # apply
require('dotenv').config();
const store = require('../store');

const WRITE = process.argv.includes('--write');

(async () => {
  // store does not export its initialiser, and this may be run before the deploy
  // that adds the columns. Both are IF NOT EXISTS, so this is a no-op afterwards.
  await store.pool.query(`ALTER TABLE athletes ADD COLUMN IF NOT EXISTS comped BOOLEAN DEFAULT FALSE`);
  await store.pool.query(`ALTER TABLE athletes ADD COLUMN IF NOT EXISTS free_before_billing TIMESTAMPTZ`);

  const before = await store.pool.query(
    `SELECT athlete_type,
            subscription_status,
            COUNT(*)::int AS n,
            COUNT(free_before_billing)::int AS already_stamped
       FROM athletes
      GROUP BY athlete_type, subscription_status
      ORDER BY athlete_type, subscription_status`
  );

  console.log('Athletes today:');
  console.table(before.rows);

  // Who would be refused if the flag were flipped right now, using the same rule
  // as athleteHasAccess.
  const risk = await store.pool.query(
    `SELECT id, email, subscription_status
       FROM athletes
      WHERE athlete_type = 'self_managed'
        AND comped IS NOT TRUE
        AND free_before_billing IS NULL
        AND subscription_status NOT IN ('active','trialing','free')`
  );
  console.log('\nWould be LOCKED OUT if BILLING_ENABLED were on right now: ' + risk.rows.length);
  risk.rows.forEach((r) => console.log('  ' + r.id + '  ' + r.email + '  ' + r.subscription_status));

  if (!WRITE) {
    console.log('\nPreview only. Re-run with --write to stamp every current athlete as grandfathered.');
    process.exit(0);
  }

  const r = await store.pool.query(
    `UPDATE athletes
        SET free_before_billing = COALESCE(free_before_billing, NOW())
      WHERE athlete_type = 'self_managed'
      RETURNING id`
  );
  console.log('\nStamped ' + r.rowCount + ' self-managed athlete(s) as free-before-billing.');
  console.log('Agent-managed athletes are not stamped: their agent already pays for them,');
  console.log('and athleteHasAccess exempts them by athlete_type rather than by stamp.');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
