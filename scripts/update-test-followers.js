// scripts/update-test-followers.js
// One-off: set follower counts on the jmcompton04@gmail.com test account.
// Run on an environment that has DATABASE_URL set, e.g.:
//   railway run node scripts/update-test-followers.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set — aborting.');
    process.exit(1);
  }
  const email = 'jmcompton04@gmail.com';
  try {
    const r = await pool.query(
      `UPDATE athletes
         SET instagram_followers = 2000,
             tiktok_followers = 1000,
             twitter_followers = 500,
             updated_at = NOW()
       WHERE email = $1
       RETURNING id, email, instagram_followers, tiktok_followers, twitter_followers`,
      [email]
    );
    if (!r.rows.length) {
      console.error(`No athlete found with email ${email}`);
    } else {
      console.log('Updated:', JSON.stringify(r.rows[0], null, 2));
    }
  } catch (e) {
    console.error('Update failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
