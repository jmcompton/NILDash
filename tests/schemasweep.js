'use strict';
// Runs from a checkout on any machine: repo-relative paths, overridable
// Postgres settings, and a startup wait the runner can shorten once the schema
// has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE MISTAKE THIS SUITE EXISTS TO END ────────────────────────────────────
//
// CREATE TABLE IF NOT EXISTS is a NO-OP on a table that already exists. Postgres
// reads the name, sees the table, returns success, and never looks at a column.
// A column added to a CREATE block therefore reaches every fresh database --
// every run of this suite included -- and never reaches production.
//
// Which is why the tests passed every time. The bug is invisible to a test
// suite that builds its schema from scratch, and that is precisely how it got
// shipped four times:
//
//   deal_comps.brand         a week of getTopNilComps throwing on every athlete
//   deal_comps.school        same table, same week
//   email_verify_credit_log  the table shipped without its migration
//   market_deepen_log        a composite key added inside the CREATE
//
// So this suite does the one thing a fresh-schema suite normally cannot: it
// DROPS a column from a real table and proves the reconciler puts it back. That
// is the production failure reproduced, not simulated.

const fs = require('fs');
const ROOT = REPO;
const S = require(ROOT + 'scripts/lib/schemaScan');
const RC = require(ROOT + 'server/services/schemaReconcile');
const store = require(ROOT + 'server/store');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  console.log('\n-- THE SCANNER READS SQL, NOT JAVASCRIPT --');
  {
    // Every one of these statements lives inside a JS template literal, so the
    // parser has to survive apostrophes in comments, commas inside NUMERIC(10,2)
    // and CHECK (x IN ('a','b')), and the end of the literal itself.
    const body = S.balancedBody("(a TEXT, b NUMERIC(10,2), c TEXT CHECK (c IN ('x','y')))", 0);
    ok('a balanced body is extracted', body === "a TEXT, b NUMERIC(10,2), c TEXT CHECK (c IN ('x','y'))", body);
    const parts = S.splitTopLevel(body);
    ok('  split on TOP-LEVEL commas only, so NUMERIC(10,2) survives',
      parts.length === 3, parts);
    ok('  and so does a CHECK list', /IN \('x','y'\)/.test(parts[2]), parts[2]);
    // AN UNBALANCED STATEMENT MUST NOT SWALLOW THE NEXT ONE. Before the backtick
    // guard, one unterminated quote in a comment made state_category_rules come
    // back with 29 columns, several of them another table's, and one of them the
    // fragment `athleteid || null` lifted out of a query.
    ok('AN UNPARSEABLE STATEMENT RETURNS NULL rather than the rest of the file',
      S.balancedBody('(a TEXT, b TEXT`) more js here', 0) === null);
  }

  console.log('\n-- THE ALTER CARRIES WHAT AN ALTER MAY CARRY --');
  {
    // A column added to a table that already holds rows cannot be NOT NULL
    // without a default and cannot be a PRIMARY KEY. Those belong to the CREATE.
    const a = S.alterFor('t', { name: 'x', def: 'x TEXT NOT NULL DEFAULT \'a\'' });
    ok('NOT NULL is stripped', !/NOT NULL/.test(a), a);
    ok('  but the DEFAULT is kept', /DEFAULT 'a'/.test(a), a);
    ok('PRIMARY KEY is stripped',
      !/PRIMARY KEY/.test(S.alterFor('t', { name: 'id', def: 'id TEXT PRIMARY KEY' })),
      S.alterFor('t', { name: 'id', def: 'id TEXT PRIMARY KEY' }));
    ok('UNIQUE is stripped',
      !/UNIQUE/.test(S.alterFor('t', { name: 'e', def: 'e TEXT UNIQUE' })));
    ok('  and a CHECK is kept, because it can be added',
      /CHECK/.test(S.alterFor('t', { name: 'c', def: "c TEXT CHECK (c IN ('a'))" })));
  }

  console.log('\n-- THE MANIFEST MATCHES THE SOURCE --');
  {
    // THE GUARD. Add a column to a CREATE TABLE block, forget the manifest, and
    // this fails -- which is the whole point. It is the one thing that stops the
    // 908th column repeating the first 907.
    const r = S.scan([ROOT + 'server', ROOT + 'scripts']);
    ok('every CREATE statement parses; none is silently uncovered',
      r.skipped.length === 0, r.skipped);
    const man = JSON.parse(fs.readFileSync(ROOT + 'server/schema-manifest.json', 'utf8'));
    const tables = [...r.creates.keys()].filter((t) => !t.startsWith('_')).sort();
    ok('THE MANIFEST COVERS EVERY TABLE IN THE SOURCE',
      JSON.stringify(Object.keys(man.tables).sort()) === JSON.stringify(tables),
      { manifest: Object.keys(man.tables).length, source: tables.length });
    let missing = [];
    for (const [t, rec] of r.creates) {
      if (t.startsWith('_')) continue;
      for (const c of rec.columns.keys()) {
        if (!man.tables[t] || !(c in man.tables[t])) missing.push(t + '.' + c);
      }
    }
    ok('  AND EVERY COLUMN. Run scripts/schema-sweep.js --write if this fails',
      missing.length === 0, missing.slice(0, 12));
    const n = Object.values(man.tables).reduce((a, c) => a + Object.keys(c).length, 0);
    ok('  which is the whole schema, not a subset', n > 800, n);
    // The ones that were found the hard way, named so they cannot quietly leave.
    for (const [t, c] of [['deal_comps', 'brand'], ['deal_comps', 'school'],
      ['email_verify_credit_log', 'agent_id']]) {
      ok(`  ${t}.${c} is in the manifest`, !!(man.tables[t] && man.tables[t][c]),
        man.tables[t] && Object.keys(man.tables[t]));
    }
    // market_deepen_log.athlete_id is the COUNTER-EXAMPLE and belongs here as
    // one: it was added by a hand-written ALTER rather than inside the CREATE,
    // so it is already safe on an existing database and the manifest correctly
    // does not claim it. The manifest covers what only the CREATE declares; it
    // is not a second copy of the schema.
    ok('  a column that already has its own ALTER is NOT in the manifest',
      !(man.tables.market_deepen_log && man.tables.market_deepen_log.athlete_id),
      man.tables.market_deepen_log);
    ok('    because the ALTER already reaches an existing database',
      (r.alters.get('market_deepen_log') || new Set()).has('athlete_id'), null);

    // ── TWO CREATE BLOCKS FOR ONE TABLE MUST AGREE ──────────────────────────
    // market_deepen_log is declared in store.js AND in services/marketDeepen.js.
    // The scan keeps the first definition it sees, so if the two ever disagree
    // the manifest silently picks one -- and the reconciler would then enforce
    // the wrong shape on production.
    const dupes = [];
    for (const [t, rec] of r.creates) {
      if (rec.sites.length < 2) continue;
      const shapes = new Set();
      for (const site of rec.sites) {
        const src = S.scanCreates([site.file]).get(t);
        if (src) shapes.add([...src.columns.keys()].sort().join(','));
      }
      if (shapes.size > 1) dupes.push({ table: t, shapes: [...shapes] });
    }
    ok('WHERE A TABLE IS DECLARED TWICE, THE TWO BLOCKS AGREE', dupes.length === 0, dupes);
  }

  console.log('\n-- THE PRODUCTION FAILURE, REPRODUCED --');
  {
    // A fresh database gets every column from CREATE TABLE, which is exactly why
    // no test has ever caught this. So: take a real table, drop a real column,
    // and confirm the query that reads it breaks the way production broke.
    // saveComp is the path that actually names `school`, and it is the one that
    // threw in production. It has its own try/catch, so the write simply does
    // not happen: no crash, no alert, no comp.
    const probe = { brand: 'SweepProbe', type: 'ig-post', value: 1000 };
    const ath = { sport: 'football', schoolTier: 'mid-mid', school: 'Bentley University',
      instagram: 1000, tiktok: 0, engagement: 3, year: 'junior' };
    const countProbes = async () => (await P.query(
      `SELECT count(*)::int AS n FROM deal_comps WHERE brand = 'SweepProbe'`)).rows[0].n;

    await P.query(`DELETE FROM deal_comps WHERE brand = 'SweepProbe'`);
    await store.saveComp(probe, ath);
    ok('saveComp writes a comp on a complete table', (await countProbes()) === 1);

    await P.query(`DELETE FROM deal_comps WHERE brand = 'SweepProbe'`);
    await P.query(`ALTER TABLE deal_comps DROP COLUMN IF EXISTS school`);
    await store.saveComp(probe, ath);
    // ── AND IT FAILS SILENTLY, WHICH IS WHY IT LASTED A WEEK ────────────────
    // saveComp catches and logs. So a missing column does not crash anything,
    // page anybody, or reach a status board -- comps simply stop accumulating,
    // and the national lane reads as a thin market rather than a broken deploy.
    ok('DROP THE COLUMN AND THE WRITE VANISHES, exactly as in production',
      (await countProbes()) === 0);
    let threw = false;
    await store.saveComp(probe, ath).catch(() => { threw = true; });
    ok('  SILENTLY -- saveComp does not even reject, so nothing reports it', threw === false);

    // And CREATE TABLE IF NOT EXISTS does NOT fix it. This is the whole defect,
    // asserted rather than described.
    await P.query(`CREATE TABLE IF NOT EXISTS deal_comps (id SERIAL PRIMARY KEY, school TEXT)`);
    const stillBroken = (await P.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='deal_comps' AND column_name='school'`)).rowCount;
    ok('  AND "CREATE TABLE IF NOT EXISTS" DOES NOT PUT IT BACK', stillBroken === 0, stillBroken);

    const res = await RC.reconcile(P);
    ok('THE RECONCILER PUTS IT BACK',
      res.added.some((a) => a.table === 'deal_comps' && a.column === 'school'),
      { added: res.added.length, failed: res.failed });
    await store.saveComp(probe, ath);
    ok('  and the write lands again', (await countProbes()) === 1);
    ok('  with nothing else touched', res.failed.length === 0, res.failed);
    await P.query(`DELETE FROM deal_comps WHERE brand = 'SweepProbe'`);

    // IDEMPOTENT. The steady state is one SELECT and no writes at all -- this
    // runs at every boot and must not take a lock per column to do nothing.
    const second = await RC.reconcile(P);
    ok('a second pass adds nothing', second.added.length === 0 && second.missing.length === 0,
      { added: second.added.length, missing: second.missing.length });
  }

  console.log('\n-- THE GUARDRAILS --');
  {
    // CODE, NOT PROSE. The file's own comments explain the CREATE TABLE defect
    // at length, so grepping the raw text for "CREATE TABLE" matches the
    // explanation rather than a statement. Comments are stripped first.
    const src = fs.readFileSync(ROOT + 'server/services/schemaReconcile.js', 'utf8')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    ok('it never CREATES a table, only ADDs a column', !/CREATE TABLE/.test(src), null);
    ok('  and never drops, renames or retypes one',
      !/DROP COLUMN|RENAME|ALTER COLUMN/.test(src), null);
    ok('  the only DDL it emits is ADD COLUMN IF NOT EXISTS',
      (src.match(/ALTER TABLE/g) || []).length === 1
        && /ADD COLUMN IF NOT EXISTS \$\{m\.column\}/.test(src), null);

    // A table that does not exist here is skipped, not created.
    const res = await RC.reconcile(P, {
      manifest: { tables: { table_that_does_not_exist_xyz: { a: 'TEXT' } } } });
    ok('a table that does not exist is SKIPPED, not created',
      res.skippedTables.length === 1 && res.added.length === 0, res);

    // THE CEILING. A manifest that does not match reality should be a loud log,
    // not a hundred silent DDL statements against a live customer's database.
    const many = { tables: { deal_comps: {} } };
    for (let i = 0; i < RC.MAX_ADDS + 5; i++) many.tables.deal_comps['zz_probe_' + i] = 'TEXT';
    const capped = await RC.reconcile(P, { manifest: many });
    ok('PAST THE CEILING IT REFUSES AND REPORTS',
      capped.capped === true && capped.added.length === 0, {
        capped: capped.capped, added: capped.added.length, missing: capped.missing.length });
    const leaked = (await P.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name='deal_comps' AND column_name LIKE 'zz_probe_%'`)).rows[0].n;
    ok('  and adds NOTHING when it refuses', leaked === 0, leaked);

    // The dry run, for looking before touching.
    await P.query(`ALTER TABLE deal_comps DROP COLUMN IF EXISTS school`);
    const dry = await RC.reconcile(P, { dryRun: true });
    ok('a dry run reports without writing',
      dry.missing.some((m) => m.column === 'school') && dry.added.length === 0, dry.added);
    await RC.reconcile(P);   // put it back for anything that runs after this
    const back = (await P.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='deal_comps' AND column_name='school'`)).rowCount;
    ok('  and the tidy-up restored it', back === 1, back);

    ok('there is an off switch', /SCHEMA_RECONCILE/.test(src), null);
  }

  console.log('\n-- IT RUNS AT STARTUP, AFTER THE TABLES ARE MADE --');
  {
    const st = fs.readFileSync(ROOT + 'server/store.js', 'utf8');
    ok('init calls the reconciler', /schemaReconcile'\)\.reconcile\(pool\)/.test(st), null);
    // SCOPED TO init(), not to the whole file. store.js also defines ensureTable
    // helpers further down that carry their own CREATE TABLE statements, so a
    // whole-file lastIndexOf compares against a statement that is not part of
    // startup at all and fails on correct ordering.
    const body = st.slice(st.indexOf('async function init()'),
      st.indexOf('// USERS'));
    ok('  AFTER every CREATE TABLE in init, so the tables exist to compare against',
      body.lastIndexOf('CREATE TABLE IF NOT EXISTS') < body.indexOf('schemaReconcile'), null);
    ok('  and it is the last thing init does',
      body.indexOf('schemaReconcile') < body.indexOf("console.log('Database tables ready')"), null);
    ok('  and a failure there does not stop the process booting',
      /\[schema\] reconcile skipped: /.test(st), null);
  }

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
