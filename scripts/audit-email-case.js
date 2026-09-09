#!/usr/bin/env node
'use strict';
// ── WHICH ACCOUNTS WERE LOCKED OUT BY THEIR OWN EMAIL ───────────────────────
//
//   node scripts/audit-email-case.js
//
// Report only. Reads users and athletes; writes nothing.
//
// The email lookup on login and forgot-password used to be byte-exact, and
// signup stored the address exactly as typed. This lists every account whose
// stored address has capitals or surrounding whitespace -- the ones that could
// not log in with the lowercase form -- and, separately, any PAIR of accounts
// that differ only by case or whitespace.
//
// The pairs matter beyond curiosity. Lookups are now case-insensitive, so a
// pair is ambiguous, and the unique index that prevents new pairs
// (idx_users_email_ci) will refuse to build while one exists. Deciding which
// row of a pair is the real customer is a human call; nothing here guesses.

const { Pool } = require('pg');
const pool = new Pool();

async function main() {
  const mixed = await pool.query(`
    SELECT id, email, role, created_at
      FROM users
     WHERE email <> LOWER(TRIM(email))
     ORDER BY created_at NULLS LAST`);

  const pairs = await pool.query(`
    SELECT LOWER(TRIM(email)) AS key,
           COUNT(*)::int AS n,
           array_agg(id ORDER BY created_at NULLS LAST) AS ids,
           array_agg(email ORDER BY created_at NULLS LAST) AS emails
      FROM users
     GROUP BY LOWER(TRIM(email))
    HAVING COUNT(*) > 1`);

  const athMixed = await pool.query(`
    SELECT id, email FROM athletes
     WHERE email IS NOT NULL AND email <> LOWER(TRIM(email))`);

  const idx = await pool.query(`
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_users_email_ci'`);

  console.log(`\nAgents whose stored email has capitals or whitespace: ${mixed.rowCount}`);
  for (const r of mixed.rows) console.log(`  ${r.id.padEnd(22)} ${JSON.stringify(r.email)}  (${r.role})`);
  console.log('  These could not log in with the lowercase form before, and can now. No change needed.');

  console.log(`\nAthletes whose stored email has capitals or whitespace: ${athMixed.rowCount}`);
  for (const r of athMixed.rows) console.log(`  ${r.id.padEnd(22)} ${JSON.stringify(r.email)}`);

  console.log(`\nPAIRS of agent accounts that differ only by case/whitespace: ${pairs.rowCount}`);
  if (pairs.rowCount) {
    for (const p of pairs.rows) {
      console.log(`  ${p.key}`);
      p.ids.forEach((id, i) => console.log(`     ${id.padEnd(22)} ${JSON.stringify(p.emails[i])}`));
    }
    console.log('\n  ACTION NEEDED. Each pair is one person with two rows, or two people who should');
    console.log('  not share an address. Decide which row is real, then archive or re-address the');
    console.log('  other. Until then lookups return the first row and idx_users_email_ci cannot build.');
  } else {
    console.log('  None. Good.');
  }

  console.log(`\nidx_users_email_ci present: ${idx.rowCount ? 'yes' : 'NO -- it builds on the next boot once pairs are resolved'}\n`);
  await pool.end();
}

main().catch(async (e) => { console.error(e.message); try { await pool.end(); } catch (_) {} process.exit(1); });
