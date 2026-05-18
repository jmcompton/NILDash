// server/scripts/seed-samford.js
// Seeds demo athletes for Samford University program.
//
// Usage: DATABASE_URL=... node server/scripts/seed-samford.js
// Or:    node server/scripts/seed-samford.js  (uses .env)
//
// Safe to run multiple times — uses INSERT ... ON CONFLICT DO NOTHING.
// Will NOT overwrite existing athletes with the same ID.

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { Pool } = require('pg');

async function seed() {
  if (!process.env.DATABASE_URL) {
    console.error('[seed] ERROR: DATABASE_URL not set.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  // Resolve the admin user ID
  const userRes = await pool.query(
    "SELECT id FROM users WHERE email = 'jmcompton04@gmail.com' LIMIT 1"
  );
  if (!userRes.rows.length) {
    console.error('[seed] Admin user not found. Check email.');
    await pool.end(); process.exit(1);
  }
  const agentId = userRes.rows[0].id;
  console.log(`[seed] Found admin user: ${agentId}`);

  // Samford University — realistic FCS/SoCon program athletes
  // Follower counts and ER reflect actual ranges for athletes at this level
  const athletes = [
    {
      id:   'samford-demo-001',
      name: 'Marcus Webb',
      sport: 'Football',
      position: 'Wide Receiver',
      school: 'Samford University',
      schoolTier: 'G5',
      instagram: 18400,
      tiktok: 22100,
      engagement: 5.2,
      stats: '68 rec, 1,024 yds, 9 TD (2024)',
      notes: 'Birmingham native. Business major. Known for training content and fan engagement on social.',
    },
    {
      id:   'samford-demo-002',
      name: 'Jordan Tate',
      sport: 'Basketball',
      position: 'Point Guard',
      school: 'Samford University',
      schoolTier: 'G5',
      instagram: 9800,
      tiktok: 14300,
      engagement: 6.8,
      stats: '17.4 PPG, 6.1 APG, 1.9 SPG (2024-25)',
      notes: 'SoCon All-Conference honorable mention. Known for behind-the-scenes campus content.',
    },
    {
      id:   'samford-demo-003',
      name: 'Ava Hollins',
      sport: "Women's Soccer",
      position: 'Midfielder',
      school: 'Samford University',
      schoolTier: 'G5',
      instagram: 7200,
      tiktok: 5100,
      engagement: 7.4,
      stats: '8 goals, 5 assists (2024)',
      notes: 'Pre-med student. Active in local community volunteering. Strong lifestyle and campus content.',
    },
    {
      id:   'samford-demo-004',
      name: 'Caleb Norris',
      sport: 'Baseball',
      position: 'Pitcher',
      school: 'Samford University',
      schoolTier: 'G5',
      instagram: 4100,
      tiktok: 3600,
      engagement: 4.1,
      stats: '2.87 ERA, 89 K, 7-3 record (2024)',
      notes: 'Junior. Drafted interest expected in 2025. Minimal social posting but high engagement when active.',
    },
    {
      id:   'samford-demo-005',
      name: 'Deja Monroe',
      sport: "Women's Basketball",
      position: 'Small Forward',
      school: 'Samford University',
      schoolTier: 'G5',
      instagram: 12600,
      tiktok: 19800,
      engagement: 8.3,
      stats: '14.2 PPG, 7.8 RPG (2024-25)',
      notes: 'Most followed athlete in the program. Active content creator — training, travel, fashion.',
    },
    {
      id:   'samford-demo-006',
      name: 'Tyler Okafor',
      sport: 'Football',
      position: 'Linebacker',
      school: 'Samford University',
      schoolTier: 'G5',
      instagram: 3200,
      tiktok: 1800,
      engagement: 3.9,
      stats: '88 tackles, 6.5 TFL, 3 sacks (2024)',
      notes: 'Sophomore. Profile incomplete — no bio or notes on file. Social presence developing.',
    },
    {
      id:   'samford-demo-007',
      name: 'Priya Nair',
      sport: 'Track & Field',
      position: 'Sprints / 100m, 200m',
      school: 'Samford University',
      schoolTier: 'G5',
      instagram: 2900,
      tiktok: 6700,
      engagement: 9.1,
      stats: '11.42s 100m PR, SoCon qualifier 2024',
      notes: 'High engagement despite smaller following. Posts consistently — training clips perform well.',
    },
    {
      id:   'samford-demo-008',
      name: 'Cole Hutchins',
      sport: 'Football',
      position: 'Quarterback',
      school: 'Samford University',
      schoolTier: 'G5',
      instagram: 31200,
      tiktok: 28900,
      engagement: 4.7,
      stats: '2,841 pass yds, 24 TD, 7 INT (2024)',
      notes: 'Starting QB and de facto face of the program. Most recognized athlete on campus.',
    },
  ];

  console.log(`[seed] Seeding ${athletes.length} Samford athletes...\n`);

  for (const athlete of athletes) {
    const { id, ...data } = athlete;
    try {
      await pool.query(
        `INSERT INTO athletes (id, agent_id, data, created_at, updated_at, last_updated_at)
         VALUES ($1, $2, $3, NOW(), NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [id, agentId, JSON.stringify(data)]
      );
      console.log(`  ✅ ${athlete.name} (${athlete.sport})`);
    } catch (err) {
      // last_updated_at column may not exist yet on this instance — retry without it
      try {
        await pool.query(
          `INSERT INTO athletes (id, agent_id, data, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (id) DO NOTHING`,
          [id, agentId, JSON.stringify(data)]
        );
        console.log(`  ✅ ${athlete.name} (${athlete.sport}) [without last_updated_at]`);
      } catch (err2) {
        console.error(`  ❌ ${athlete.name} — ${err2.message}`);
      }
    }
  }

  console.log('\n[seed] Done. Samford University demo data is ready.');
  await pool.end();
}

seed();
