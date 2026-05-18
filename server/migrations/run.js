// server/migrations/run.js
// Migration runner — executes SQL migration files in order.
// Safe to run multiple times (all statements are idempotent).
//
// Usage: node server/migrations/run.js
// Or:    DATABASE_URL=... node server/migrations/run.js

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { Pool } = require('pg');
const fs       = require('fs');
const path     = require('path');

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrations] ERROR: DATABASE_URL not set.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const migrationDir = __dirname;
  const files = fs.readdirSync(migrationDir)
    .filter(f => f.endsWith('.sql'))
    .sort(); // alphabetical = numeric order by filename prefix

  console.log(`[migrations] Found ${files.length} migration file(s).\n`);

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
    console.log(`[migrations] Running: ${file}`);
    try {
      await pool.query(sql);
      console.log(`[migrations] ✅ ${file} — OK\n`);
    } catch (err) {
      console.error(`[migrations] ❌ ${file} — FAILED: ${err.message}\n`);
      await pool.end();
      process.exit(1);
    }
  }

  console.log('[migrations] All migrations complete.');
  await pool.end();
}

run();
