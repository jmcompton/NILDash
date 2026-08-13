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

const store = require('../store');
const mig = require('../services/programSportMigration');

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

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  const rollback = args.includes('--rollback');

  if (apply && rollback) { console.log('Pick one: --apply or --rollback.'); return; }

  const before = await mig.counts(store.pool);
  printCounts('BEFORE', before);

  const state = await mig.inspect(store.pool);
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

  const built = rollback ? await mig.rollbackPlan(store.pool) : await mig.plan(store.pool);
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
  const res = await mig.run(store.pool, steps, { commit });

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
  main()
    .catch((e) => { console.error('[migrate] fatal:', e.message); process.exitCode = 1; })
    .finally(() => { if (store.pool && store.pool.end) store.pool.end().catch(() => {}); });
}

module.exports = { main };
