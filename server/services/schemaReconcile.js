'use strict';
// ── THE COLUMN THAT ONLY EXISTS ON A FRESH DATABASE ─────────────────────────
//
// CREATE TABLE IF NOT EXISTS is a NO-OP on a table that already exists. Postgres
// reads the name, sees the table, returns success, and never looks at a column.
// So adding a column to a CREATE block is correct on every fresh database --
// every test run, every new environment, every laptop -- and does nothing
// whatsoever to production, where the table was created months ago.
//
// It surfaces days later as `column "x" does not exist`, thrown by a query
// nobody edited, from inside a catch that returns [] -- so it reads as a thin
// market rather than as a broken deploy:
//
//   deal_comps.brand         getTopNilComps threw on every athlete, every run,
//                            for a week; the national lane returned nothing.
//   deal_comps.school        same table, same week, same shape.
//   email_verify_credit_log  the whole table shipped without its migration.
//   market_deepen_log        a composite key added inside the CREATE.
//
// Four instances of one mistake, each found the hard way, one per night.
//
// ── WHY A MANIFEST AND NOT 907 ALTERS ───────────────────────────────────────
//
// 907 columns across 96 tables are declared only inside a CREATE. Hand-writing
// 907 ALTER statements fixes today and nothing else: the 908th column ships
// tomorrow with the same defect, and 907 no-op ALTERs at every boot each take an
// ACCESS EXCLUSIVE lock to do nothing.
//
// This reads the committed manifest (generated from the CREATE blocks by
// scripts/schema-sweep.js), asks information_schema ONCE what actually exists,
// and issues an ALTER only for a column that is genuinely absent. Steady state
// is one SELECT and no writes. A column added to a CREATE block tomorrow is
// picked up with no migration to remember, and tests/schemasweep.js fails the
// build if the manifest and the source ever drift apart.
//
// ── THE GUARDRAILS ──────────────────────────────────────────────────────────
//
// This writes DDL to a live database holding a paying customer's athletes, so:
//
//   TABLES THAT EXIST, ONLY. A table absent from information_schema is left
//   alone -- CREATE TABLE will build it complete. We never create a table here.
//   ADDITIVE, ONLY. ADD COLUMN. Nothing drops, renames, retypes, or backfills.
//   NOT NULL AND PRIMARY KEY ARE STRIPPED by the generator, because neither can
//   be added to a table that already holds rows.
//   A CEILING. Past MAX_ADDS in one boot it refuses and reports instead. A wrong
//   manifest should be a loud startup log, not a hundred silent DDL statements.
//   ONE COLUMN AT A TIME, each in its own statement, each failure logged and
//   survived. A schema fix must never be the reason the process will not start.
//   AN OFF SWITCH. SCHEMA_RECONCILE=off.

const path = require('path');

// Beyond this in a single boot, something is wrong with the manifest rather than
// with the database. 96 tables' worth of genuine drift is not a thing that
// happens between two deploys.
const MAX_ADDS = parseInt(process.env.SCHEMA_RECONCILE_MAX, 10) || 60;

function loadManifest() {
  try {
    // Resolved rather than required by bare name so a bundler or a different cwd
    // cannot silently hand back a different file.
    return require(path.join(__dirname, '..', 'schema-manifest.json'));
  } catch (e) {
    console.error('[schema] manifest unreadable: ' + e.message);
    return null;
  }
}

// { added: [...], missing: [...], failed: [...], skippedTables: [...] }
async function reconcile(pool, opts = {}) {
  const out = { added: [], missing: [], failed: [], skippedTables: [], capped: false };
  if (String(process.env.SCHEMA_RECONCILE || '').toLowerCase() === 'off') {
    console.log('[schema] reconcile disabled by SCHEMA_RECONCILE=off');
    return out;
  }
  const manifest = opts.manifest || loadManifest();
  if (!manifest || !manifest.tables) return out;
  const dryRun = !!opts.dryRun;
  const names = Object.keys(manifest.tables);
  if (!names.length) return out;

  let rows;
  try {
    // ONE QUERY for the whole schema. Asking per table would be 96 round trips
    // at every boot to discover, almost always, that there is nothing to do.
    const r = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1)`, [names]);
    rows = r.rows || [];
  } catch (e) {
    // A reconcile that cannot read the schema reports and steps aside. It is a
    // safety net, not a precondition for the process starting.
    console.error('[schema] could not read information_schema: ' + e.message);
    return out;
  }

  const have = new Map();
  for (const row of rows) {
    if (!have.has(row.table_name)) have.set(row.table_name, new Set());
    have.get(row.table_name).add(row.column_name);
  }

  for (const table of names) {
    const cols = have.get(table);
    // NOT AN ERROR. The table has not been created yet (or not on this
    // deployment); CREATE TABLE will build it with every column.
    if (!cols) { out.skippedTables.push(table); continue; }
    for (const [col, def] of Object.entries(manifest.tables[table])) {
      if (cols.has(col)) continue;
      out.missing.push({ table, column: col, def });
    }
  }

  if (!out.missing.length) {
    console.log(`[schema] reconcile: ${names.length - out.skippedTables.length} table(s) checked, `
      + 'nothing missing');
    return out;
  }

  // THE LOUD PART. Every column this adds is one that a query somewhere was
  // going to fail on, so it is named in the log rather than counted.
  console.warn(`[schema] reconcile: ${out.missing.length} column(s) MISSING from live tables:`);
  for (const m of out.missing) console.warn(`[schema]   ${m.table}.${m.column}  ${m.def}`);

  if (out.missing.length > MAX_ADDS) {
    out.capped = true;
    console.error(`[schema] REFUSING TO APPLY: ${out.missing.length} exceeds the ${MAX_ADDS} ceiling. `
      + 'That many at once is a manifest that does not match this database rather than '
      + 'drift between two deploys. Every missing column is named above. To review them '
      + 'first: scripts/schema-sweep.js --live. To let it proceed once the list looks '
      + `right: SCHEMA_RECONCILE_MAX=${out.missing.length} on one boot.`);
    return out;
  }
  if (dryRun) { console.log('[schema] dry run: nothing applied'); return out; }

  for (const m of out.missing) {
    // Interpolated, not parameterised, because DDL identifiers and type
    // expressions cannot be bound. Both halves come from the committed manifest,
    // which is generated from our own source and never from a request.
    const sql = `ALTER TABLE ${m.table} ADD COLUMN IF NOT EXISTS ${m.column} ${m.def}`;
    try {
      await pool.query(sql);
      out.added.push(m);
      console.warn(`[schema] ADDED ${m.table}.${m.column}`);
    } catch (e) {
      // One column that will not add must not stop the other fifty-nine.
      out.failed.push({ ...m, error: e.message });
      console.error(`[schema] FAILED ${m.table}.${m.column}: ${e.message}`);
    }
  }
  console.warn(`[schema] reconcile complete: ${out.added.length} added, ${out.failed.length} failed`);
  return out;
}

module.exports = { reconcile, loadManifest, MAX_ADDS };
