// server/scripts/seed-demo.js
//
// CLI wrapper for the demo-account seeder.
//
//   DATABASE_URL=... node server/scripts/seed-demo.js
//   npm run seed:demo
//
// Idempotent: re-running resets the demo account to the same clean seeded state.
// See server/scripts/seedDemo.js for what gets seeded and the safety rules.

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { Pool } = require('pg');
const { seedDemo } = require('./seedDemo');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('[seed-demo] ERROR: DATABASE_URL not set.');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('127.0.0.1') || process.env.DATABASE_URL.includes('localhost')
      ? { rejectUnauthorized: false }
      : { rejectUnauthorized: false },
  });

  try {
    const result = await seedDemo(pool);
    const appUrl = process.env.APP_URL || 'https://mynildash.com';
    console.log('\n========================================');
    console.log('  NILDash demo account seeded');
    console.log('========================================');
    console.log('  Login email:    ' + result.email);
    console.log('  Login password: ' + result.password);
    console.log('  Media kit URL:  ' + appUrl + result.mediaKitUrl);
    console.log('  (Avery kit):    ' + appUrl + result.averyKitUrl);
    console.log('----------------------------------------');
    console.log('  Seeded: ' + result.counts.athletes + ' athletes, '
      + result.counts.mediaKits + ' media kits, '
      + result.counts.deals + ' deals, '
      + result.counts.kitViews + ' kit views, '
      + result.counts.deliverables + ' deliverables');
    console.log('========================================\n');
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('[seed-demo] FAILED:', e.message);
    console.error(e.stack);
    await pool.end().catch(() => {});
    process.exit(1);
  }
})();
