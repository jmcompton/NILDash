'use strict';
// Make the program map sport-aware at the schema level.
//
//   node server/jobs/migrateProgramSport.js              inspect only, no changes
//   node server/jobs/migrateProgramSport.js --dry-run    execute everything, then ROLL BACK
//   node server/jobs/migrateProgramSport.js --apply      execute and COMMIT
//   node server/jobs/migrateProgramSport.js --rollback   undo it
//
// The dry run is a real rehearsal: every statement is executed against the real
// database inside a transaction that is then rolled back, and the after-counts are
// read inside that transaction. If a statement would fail, the dry run fails in
// exactly the same place the apply would, with the same message, and nothing is
// written either way.
//
// Applying is deliberately the flag you have to type. Bare invocation only looks.

// This CLI owns its OWN pool and deliberately does NOT require ../store.
//
// It used to require it, which had two consequences, both bad. Requiring store.js
// kicks off its async init() at import time, so the CLI was racing the app's table
// setup. And the CLI's error path called store.pool.end(), ending a pool it did not
// create and that init() was still using: one migration failure produced ~80
// "Cannot use a pool after calling end on the pool" errors from unrelated table
// setup. A failed migration must not be able to take the database away from
// anything else in the process.
//
// Owning the connection also means this script has no side effects beyond the
// migration itself: no table creation, no boot-time work, nothing to race.
const { Pool } = require('pg');
const mig = require('../services/programSportMigration');

function makePool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. This script connects on its own and cannot borrow the app pool.');
  }
  // Same SSL posture as server/store.js, so it connects the same way in every
  // environment this already runs in.
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 2,
  });
}

function line(ch = '-', n = 74) { return ch.repeat(n); }

function printCounts(label, c) {
  console.log(`\n${label}`);
  console.log(line());
  for (const [table, row] of Object.entries(c)) {
    if (!row) { console.log(`  ${table.padEnd(18)} (table does not exist)`); continue; }
    const bySport = row.bySport
      ? row.bySport.map((x) => `${x.sport}=${x.n}`).join(', ')
      : 'no sport column yet';
    console.log(`  ${table.padEnd(18)} ${String(row.rows).padStart(6)} row(s)   ${bySport}`);
  }
}

async function main(pool) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  const rollback = args.includes('--rollback');

  if (apply && rollback) { console.log('Pick one: --apply or --rollback.'); return; }

  const before = await mig.counts(pool);
  printCounts('BEFORE', before);

  const state = await mig.inspect(pool);
  console.log('\nCURRENT SCHEMA');
  console.log(line());
  console.log(`  program_staff  sport column: ${state.program_staff.exists ? (state.program_staff.hasSport ? 'yes' : 'NO') : 'n/a'}`
    + `   unique: ${state.program_staff.newUnique ? '(school, sport, role, name) ALREADY WIDENED' : (state.program_staff.oldUnique || 'none found')}`);
  for (const t of ['program_source', 'program_contact']) {
    if (!state[t].exists) { console.log(`  ${t}  (does not exist)`); continue; }
    console.log(`  ${t}  sport column: ${state[t].hasSport ? 'yes' : 'NO'}`
      + `   pk: ${state[t].newPk ? '(school, sport) ALREADY COMPOSITE' : (state[t].oldPk || 'none found')}`);
    console.log(`  ${' '.repeat(t.length)}  columns: ` + Object.entries({ ...state[t].oldCols, ...state[t].newCols })
      .map(([k, v]) => `${k}=${v ? 'present' : 'absent'}`).join(', '));
  }

  // Every key constraint actually on the table, with the raw driver value beside
  // the parsed one. The first dry run crashed reading this and reported only the
  // symptom; printing both means a type surprise is visible rather than fatal.
  console.log('\nKEY CONSTRAINTS AS THE DATABASE REPORTS THEM');
  console.log(line());
  for (const t of mig.TABLES) {
    const cons = await mig.constraintsFor(pool, t);
    if (!cons.length) { console.log(`  ${t}: none`); continue; }
    for (const c of cons) {
      console.log(`  ${t}: ${c.type} ${c.name} (${c.cols.join(', ') || 'UNPARSED'})`);
      console.log(`      raw cols: ${typeof c.rawCols} ${JSON.stringify(c.rawCols)}`);
    }
  }

  const built = rollback ? await mig.rollbackPlan(pool) : await mig.plan(pool);
  if (rollback && built.blockers.length) {
    console.log('\nCANNOT ROLL BACK:');
    for (const b of built.blockers) console.log(`  ${b}`);
    console.log('\n  Restoring UNIQUE (school, role, name) would fail while two sports share a school.');
    console.log('  Delete the non-football rows first if you really want the old shape back.');
    return;
  }

  const steps = built.steps;
  console.log(`\n${rollback ? 'ROLLBACK' : 'MIGRATION'} PLAN (${steps.length} statement(s))`);
  console.log(line());
  if (!steps.length) {
    console.log('  Nothing to do. The schema is already in the target state.');
    return;
  }
  steps.forEach((s, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${s.why}`);
    console.log(`      ${s.sql}`);
  });

  if (!apply && !dryRun && !rollback) {
    console.log('\nInspection only. Nothing was executed.');
    console.log('  Rehearse it:  node server/jobs/migrateProgramSport.js --dry-run');
    console.log('  Apply it:     node server/jobs/migrateProgramSport.js --apply');
    return;
  }

  const commit = apply || (rollback && !dryRun);
  console.log(`\n${commit ? 'APPLYING (will COMMIT)' : 'DRY RUN (will execute then ROLL BACK)'}`);
  console.log(line());
  const res = await mig.run(pool, steps, { commit });

  if (!res.ok) {
    console.log(`\nFAILED at statement ${res.failedAt + 1} of ${steps.length}: ${res.error}`);
    console.log('The transaction was rolled back. NOTHING was written.');
    if (steps[res.failedAt]) console.log(`  offending statement: ${steps[res.failedAt].sql}`);
    process.exitCode = 1;
    return;
  }

  console.log(`  ${res.executed.length} statement(s) executed successfully.`);
  printCounts(commit ? 'AFTER (committed)' : 'AFTER (inside the rolled-back transaction)', res.after);

  // Row counts must not move. This migration adds a column, fills it, renames
  // columns and widens constraints; it does not create or destroy rows. A changed
  // count means something is wrong regardless of what the statements claimed.
  console.log('\nROW COUNT CHECK');
  console.log(line());
  let drift = 0;
  for (const t of mig.TABLES) {
    const b = before[t] ? before[t].rows : null;
    const a = res.after[t] ? res.after[t].rows : null;
    const same = b === a;
    if (!same) drift++;
    console.log(`  ${t.padEnd(18)} ${String(b)} -> ${String(a)}  ${same ? 'unchanged' : '*** CHANGED, INVESTIGATE ***'}`);
  }
  if (drift) {
    console.log('\n  Row counts moved. That should be impossible here. Do not proceed.');
    process.exitCode = 1;
    return;
  }

  if (commit) {
    console.log('\nCOMMITTED.');
    console.log('  Undo:  node server/jobs/migrateProgramSport.js --rollback');
    console.log('  Then:  node server/jobs/programMapPilot.js --fetch-all --school "Ole Miss" --school "Georgia"');
  } else {
    console.log('\nROLLED BACK. Nothing was written.');
    console.log('  Apply for real:  node server/jobs/migrateProgramSport.js --apply');
  }
}

if (require.main === module) {
  let pool = null;
  (async () => {
    try {
      pool = makePool();
      await main(pool);
    } catch (e) {
      console.error('[migrate] fatal:', e.message);
      if (e && e.stack) console.error(e.stack);
      process.exitCode = 1;
    } finally {
      // Only ever ends the pool THIS script created.
      if (pool) await pool.end().catch(() => {});
    }
  })();
}

module.exports = { main };
