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
//
// ── WHY IT CONNECTS THROUGH server/store.js ─────────────────────────────────
// The first version did `new Pool()` with no arguments. That reads PG* env
// vars, which production does not set -- production has DATABASE_URL, and
// needs SSL on it -- so in production it dialled 127.0.0.1:5432, got
// ECONNREFUSED, wrote one bare line to STDERR, and looked exactly like a
// script that had not run. store.js builds the pool the way the app does,
// and requiring it prints the [init] lines every other script prints, which
// is the sign of life a person running this actually looks for.
//
// ── A SCRIPT THAT PRINTS NOTHING IS INDISTINGUISHABLE FROM ONE THAT DID NOT
// RUN. So: the target is printed BEFORE the first query, every section prints
// its count including zero, the last line says Done with totals, failures go
// to stdout as well as stderr, and the exit code starts at 1 and is only
// lowered to 0 after the Done line has been written. A dangling promise -- the
// classic way a Node script exits 0 in silence -- now exits 1 with a message.

const store = require('../server/store');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;

process.exitCode = 1;
let settled = false;
process.on('beforeExit', () => {
  if (!settled) {
    console.log('audit-email-case: main() never settled -- a query or connection hung with no error. Exiting 1.');
    process.exit(1);
  }
});
process.on('unhandledRejection', (e) => { fail('unhandled rejection', e); });

// Where this run is pointed, without printing a password.
function target() {
  const url = process.env.DATABASE_URL;
  if (url) {
    try { const u = new URL(url); return `DATABASE_URL -> ${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname} (ssl)`; }
    catch (_) { return 'DATABASE_URL (unparseable, passed through as-is)'; }
  }
  const h = process.env.PGHOST || 'localhost', p = process.env.PGPORT || '5432', d = process.env.PGDATABASE || process.env.PGUSER || process.env.USER || '(default)';
  return `PG* env -> ${h}:${p}/${d}` + (process.env.PGHOST ? '' : '   [no DATABASE_URL and no PGHOST: this is the libpq default, almost certainly not production]');
}

function fail(where, e) {
  const msg = `audit-email-case: FAILED (${where}): ${e && e.message ? e.message : e}`;
  console.log(msg);            // stdout, so it is seen where the report would have been
  console.error(msg);          // and stderr, for anything that only captures errors
  settled = true;
  process.exit(1);
}

async function main() {
  console.log(`audit-email-case: connecting via ${target()}`);
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));   // let store's init settle, same as sibling scripts
  const P = store.pool;

  let mixed, pairs, athMixed, idx, totals;
  try {
    totals = await P.query(`SELECT (SELECT COUNT(*)::int FROM users) AS users, (SELECT COUNT(*)::int FROM athletes) AS athletes`);
    console.log(`audit-email-case: connected. ${totals.rows[0].users} agent account(s), ${totals.rows[0].athletes} athlete row(s) to scan.`);

    mixed = await P.query(`
      SELECT id, email, role, created_at
        FROM users
       WHERE email <> LOWER(TRIM(email))
       ORDER BY created_at NULLS LAST`);

    pairs = await P.query(`
      SELECT LOWER(TRIM(email)) AS key,
             COUNT(*)::int AS n,
             array_agg(id ORDER BY created_at NULLS LAST) AS ids,
             array_agg(email ORDER BY created_at NULLS LAST) AS emails
        FROM users
       GROUP BY LOWER(TRIM(email))
      HAVING COUNT(*) > 1`);

    athMixed = await P.query(`
      SELECT id, email FROM athletes
       WHERE email IS NOT NULL AND email <> LOWER(TRIM(email))`);

    idx = await P.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_users_email_ci'`);
  } catch (e) {
    return fail('query', e);
  }

  console.log(`\nAgents whose stored email has capitals or whitespace: ${mixed.rowCount}`);
  if (mixed.rowCount) {
    for (const r of mixed.rows) console.log(`  ${String(r.id).padEnd(22)} ${JSON.stringify(r.email)}  (${r.role})`);
    console.log('  These could not log in with the lowercase form before, and can now. No change needed.');
  } else {
    console.log('  None -- every agent email is already lower-case and trimmed.');
  }

  console.log(`\nAthletes whose stored email has capitals or whitespace: ${athMixed.rowCount}`);
  if (athMixed.rowCount) for (const r of athMixed.rows) console.log(`  ${String(r.id).padEnd(22)} ${JSON.stringify(r.email)}`);
  else console.log('  None.');

  console.log(`\nPAIRS of agent accounts that differ only by case/whitespace: ${pairs.rowCount}`);
  if (pairs.rowCount) {
    for (const p of pairs.rows) {
      console.log(`  ${p.key}`);
      p.ids.forEach((id, i) => console.log(`     ${String(id).padEnd(22)} ${JSON.stringify(p.emails[i])}`));
    }
    console.log('\n  ACTION NEEDED. Each pair is one person with two rows, or two people who should');
    console.log('  not share an address. Decide which row is real, then archive or re-address the');
    console.log('  other. Until then lookups return the first row and idx_users_email_ci cannot build.');
  } else {
    console.log('  None. Good.');
  }

  console.log(`\nidx_users_email_ci present: ${idx.rowCount ? 'yes' : 'NO -- it builds on the next boot once pairs are resolved'}`);
  console.log(`\nDone. Scanned ${totals.rows[0].users} agent account(s) and ${totals.rows[0].athletes} athlete row(s). `
    + `${mixed.rowCount} mixed-case agent(s), ${athMixed.rowCount} mixed-case athlete(s), ${pairs.rowCount} pair(s).\n`);

  settled = true;
  await P.end().catch(() => {});
  process.exit(0);
}

main().catch((e) => fail('main', e));
