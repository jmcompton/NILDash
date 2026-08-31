'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
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
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// The sport migration. plan() and rollbackPlan() are run against a stubbed database
// so the real statement-building logic is exercised without a server.
const fs = require('fs');
const mig = require(REPO + 'server/services/programSportMigration.js');
const STORE = fs.readFileSync(REPO + 'server/store.js', 'utf8');
const CLI = fs.readFileSync(REPO + 'server/jobs/migrateProgramSport.js', 'utf8');
const SRV = fs.readFileSync(REPO + 'server/index.js', 'utf8');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}

// A database stub. `shape` says which columns and constraints exist, so both the
// pre-migration and post-migration states can be replayed.
function db(shape) {
  const log = [];
  return {
    log,
    query: async (sql, params) => {
      log.push(sql.replace(/\s+/g, ' ').trim());
      if (/to_regclass/.test(sql)) {
        const t = String(params[0]).replace('public.', '');
        return { rows: [{ t: shape.tables.includes(t) ? t : null }] };
      }
      if (/information_schema\.columns/.test(sql)) {
        const [t, c] = params;
        return { rows: (shape.columns[t] || []).includes(c) ? [{ 1: 1 }] : [] };
      }
      if (/pg_constraint/.test(sql)) {
        const t = String(params[0]).replace('public.', '');
        const type = params[1];
        const rows = (shape.constraints[t] || [])
          .filter((c) => c.type === type)
          .map((c) => ({ conname: c.name, cols: c.cols }));
        return { rows };
      }
      if (/COUNT\(\*\)::int AS n FROM \w+ WHERE sport IS DISTINCT/.test(sql)) {
        return { rows: [{ n: shape.nonFootball || 0 }] };
      }
      if (/COUNT\(\*\)::int AS n FROM/.test(sql)) return { rows: [{ n: 100 }] };
      if (/GROUP BY 1 ORDER BY 1/.test(sql)) return { rows: [{ sport: 'football', n: 100 }] };
      return { rows: [] };
    },
  };
}

const BEFORE = {
  tables: ['program_staff', 'program_source', 'program_contact'],
  columns: {
    program_staff: ['school', 'role', 'name', 'sport'],
    program_source: ['school', 'football_staff_url', 'football_staff_url_discovered_via', 'url_locked'],
    program_contact: ['school', 'football_office_phone', 'football_office_phone_source_url'],
  },
  constraints: {
    program_staff: [{ name: 'program_staff_school_role_name_key', type: 'u', cols: ['school', 'role', 'name'] }],
    program_source: [{ name: 'program_source_pkey', type: 'p', cols: ['school'] }],
    program_contact: [{ name: 'program_contact_pkey', type: 'p', cols: ['school'] }],
  },
};

const AFTER = {
  tables: BEFORE.tables,
  columns: {
    program_staff: ['school', 'role', 'name', 'sport'],
    program_source: ['school', 'sport', 'staff_url', 'staff_url_discovered_via', 'url_locked'],
    program_contact: ['school', 'sport', 'office_phone', 'office_phone_source_url'],
  },
  constraints: {
    program_staff: [{ name: 'program_staff_school_sport_role_name_key', type: 'u', cols: ['school', 'sport', 'role', 'name'] }],
    program_source: [{ name: 'program_source_school_sport_pkey', type: 'p', cols: ['school', 'sport'] }],
    program_contact: [{ name: 'program_contact_school_sport_pkey', type: 'p', cols: ['school', 'sport'] }],
  },
};

(async () => {
  console.log('-- the plan, from the pre-migration state --');
  const { steps } = await mig.plan(db(BEFORE));
  const sql = steps.map((s) => s.sql).join('\n');

  ok('widens the program_staff unique constraint',
    /ADD CONSTRAINT program_staff_school_sport_role_name_key UNIQUE \(school, sport, role, name\)/.test(sql), null);
  ok('drops the old one BY ITS DISCOVERED NAME, not a guessed one',
    /DROP CONSTRAINT "program_staff_school_role_name_key"/.test(sql), null);
  ok('drops before it adds',
    sql.indexOf('DROP CONSTRAINT "program_staff_school_role_name_key"')
      < sql.indexOf('ADD CONSTRAINT program_staff_school_sport_role_name_key'), null);

  console.log('-- composite primary keys --');
  for (const t of ['program_source', 'program_contact']) {
    ok(`${t}: drops PRIMARY KEY (school)`, new RegExp(`ALTER TABLE ${t} DROP CONSTRAINT "${t}_pkey"`).test(sql), null);
    ok(`${t}: adds PRIMARY KEY (school, sport)`,
      new RegExp(`ALTER TABLE ${t} ADD CONSTRAINT ${t}_school_sport_pkey PRIMARY KEY \\(school, sport\\)`).test(sql), null);
  }

  console.log('-- the four renames, exactly as specified --');
  const RENAMES = [
    ['program_source', 'football_staff_url', 'staff_url'],
    ['program_source', 'football_staff_url_discovered_via', 'staff_url_discovered_via'],
    ['program_contact', 'football_office_phone', 'office_phone'],
    ['program_contact', 'football_office_phone_source_url', 'office_phone_source_url'],
  ];
  for (const [t, from, to] of RENAMES) {
    ok(`${from} -> ${to}`, new RegExp(`ALTER TABLE ${t} RENAME COLUMN ${from} TO ${to}`).test(sql), null);
  }
  ok('renames happen BEFORE the pk change, so the pk names a live column',
    sql.indexOf('RENAME COLUMN football_staff_url TO staff_url') < sql.indexOf('program_source_school_sport_pkey'), null);

  console.log('-- the backfill --');
  for (const t of mig.TABLES) {
    ok(`${t}: backfills sport='football'`,
      new RegExp(`UPDATE ${t} SET sport = 'football' WHERE sport IS NULL`).test(sql), null);
    ok(`${t}: only touches NULLs, never overwrites`,
      new RegExp(`UPDATE ${t} SET sport = 'football' WHERE sport IS NULL`).test(sql), null);
    ok(`${t}: makes sport NOT NULL`, new RegExp(`ALTER TABLE ${t} ALTER COLUMN sport SET NOT NULL`).test(sql), null);
  }
  ok('adds the sport column where it is missing',
    /ALTER TABLE program_source ADD COLUMN sport TEXT/.test(sql)
    && /ALTER TABLE program_contact ADD COLUMN sport TEXT/.test(sql), null);
  ok('does NOT re-add it to program_staff, which already has it',
    !/ALTER TABLE program_staff ADD COLUMN sport TEXT/.test(sql), null);

  console.log('-- destructive statements: there are none --');
  for (const bad of ['DROP TABLE', 'DROP COLUMN', 'DELETE FROM', 'TRUNCATE']) {
    ok(`no ${bad}`, !new RegExp(bad).test(sql), bad);
  }
  const updates = sql.match(/^UPDATE .*$/gm) || [];
  ok('every UPDATE is the NULL-only backfill',
    updates.every((u) => /WHERE sport IS NULL$/.test(u)), updates);

  console.log('-- idempotent: re-running against the migrated state is a no-op --');
  const again = await mig.plan(db(AFTER));
  const onlySafe = again.steps.every((s) =>
    /UPDATE \w+ SET sport = 'football' WHERE sport IS NULL/.test(s.sql)
    || /SET DEFAULT/.test(s.sql) || /SET NOT NULL/.test(s.sql) || /CREATE INDEX IF NOT EXISTS/.test(s.sql));
  ok('no constraint or rename statements the second time', onlySafe, again.steps.map((s) => s.sql));
  ok('no rename is replanned', !again.steps.some((s) => /RENAME COLUMN/.test(s.sql)), null);
  ok('no pk is dropped again', !again.steps.some((s) => /DROP CONSTRAINT/.test(s.sql)), null);

  console.log('-- rollback --');
  const rb = await mig.rollbackPlan(db(AFTER));
  const rsql = rb.steps.map((s) => s.sql).join('\n');
  ok('not blocked while everything is football', rb.blockers.length === 0, rb.blockers);
  ok('restores UNIQUE (school, role, name)',
    /ADD CONSTRAINT program_staff_school_role_name_key UNIQUE \(school, role, name\)/.test(rsql), null);
  ok('restores PRIMARY KEY (school) on both tables',
    /program_source ADD CONSTRAINT program_source_pkey PRIMARY KEY \(school\)/.test(rsql)
    && /program_contact ADD CONSTRAINT program_contact_pkey PRIMARY KEY \(school\)/.test(rsql), null);
  ok('reverses all four renames',
    /staff_url TO football_staff_url/.test(rsql)
    && /staff_url_discovered_via TO football_staff_url_discovered_via/.test(rsql)
    && /office_phone TO football_office_phone/.test(rsql)
    && /office_phone_source_url TO football_office_phone_source_url/.test(rsql), null);
  ok('does NOT drop the sport column or its data', !/DROP COLUMN sport/.test(rsql), null);
  ok('makes sport nullable again', /ALTER COLUMN sport DROP NOT NULL/.test(rsql), null);

  console.log('-- rollback REFUSES once a second sport exists --');
  const blocked = await mig.rollbackPlan(db({ ...AFTER, nonFootball: 12 }));
  ok('blocked', blocked.blockers.length > 0, blocked.blockers);
  ok('no statements produced', blocked.steps.length === 0, blocked.steps);
  ok('the reason names the table and the count',
    /program_staff has 12 row\(s\) whose sport is not football/.test(blocked.blockers.join(' ')),
    blocked.blockers);

  console.log('-- the delete in saveProgramStaff --');
  ok('scoped to school AND sport',
    /DELETE FROM program_staff WHERE school = \$1 AND sport = \$2/.test(STORE), null);
  ok('the old school-only delete is gone',
    !/DELETE FROM program_staff WHERE school = \$1',/.test(STORE), null);
  ok('the conflict key is widened',
    /ON CONFLICT \(school, sport, role, name\) DO UPDATE SET/.test(STORE), null);
  ok('a mixed-sport batch is refused rather than half-applied',
    /REFUSED: records mix sports/.test(STORE), null);
  ok('sport is bound from the resolved value, not from each row',
    /r\.reach_via \|\| null, sport, r\.source_tier_note/.test(STORE), null);

  console.log('-- existing callers keep working --');
  ok('getProgramSource defaults to football', /getProgramSource\(school, sport = 'football'\)/.test(STORE), null);
  ok('getProgramContact defaults to football', /getProgramContact\(school, sport = 'football'\)/.test(STORE), null);
  ok('getProgramStaff defaults to football', /getProgramStaff\(school, sport = 'football'\)/.test(STORE), null);
  ok('saveProgramSourceUrl defaults to football', /saveProgramSourceUrl\(school, url, via, contactUrl, sport = 'football'\)/.test(STORE), null);
  ok('saveProgramContact defaults to football', /saveProgramContact\(school, c, sport = 'football'\)/.test(STORE), null);
  ok('snapshot defaults to football', /saveProgramStaffSnapshot\(school, staff, hash, via, sport = 'football'\)/.test(STORE), null);
  ok('old football_staff_url readers still get a value',
    /row\.football_staff_url = row\.staff_url/.test(STORE), null);
  ok('old football_office_phone readers still get a value',
    /row\.football_office_phone = row\.office_phone/.test(STORE), null);
  ok('saveProgramContact still accepts the old key names',
    /c\.office_phone \|\| c\.football_office_phone/.test(STORE), null);

  console.log('-- raw SQL outside the helpers was updated --');
  ok('the Programs tab reads staff_url', /staff_url AS football_staff_url/.test(SRV), null);
  // Was pinned to the literal 'football' by the migration commit. It is now a bound
  // parameter, which is what makes the tab sport-aware. What must NOT come back is an
  // unfiltered query: a Programs query with no sport predicate would mix the two.
  ok('and filters on a bound sport, not a literal', /WHERE ps\.status = 'current' AND ps\.sport = \$1/.test(SRV), null);
  ok('no Programs query selects staff without a sport predicate',
    !/FROM program_staff ps\s+LEFT JOIN[\s\S]{0,200}WHERE ps\.status = 'current'\s+GROUP BY/.test(SRV), null);
  ok('the schools join includes sport, so counts cannot double',
    /LEFT JOIN program_source src ON src\.school = ps\.school AND src\.sport = ps\.sport/.test(SRV), null);
  ok('no raw football_staff_url column reference is left in index.js',
    !/SELECT football_staff_url/.test(SRV), null);

  console.log('-- boot-time safety --');
  ok('store init runs the migration so deploy order cannot matter',
    /programSportMigration'\)\.ensureSchema\(pool\)/.test(STORE), null);
  ok('program_staff CREATE TABLE declares sport, so a fresh DB can build the UNIQUE',
    /CREATE TABLE IF NOT EXISTS program_staff \([\s\S]{0,600}?sport TEXT NOT NULL DEFAULT 'football'[\s\S]{0,900}?UNIQUE \(school, sport, role, name\)/.test(STORE),
    null);
  ok('fresh program_source is composite-keyed',
    /CREATE TABLE IF NOT EXISTS program_source \([\s\S]{0,900}?PRIMARY KEY \(school, sport\)/.test(STORE), null);
  ok('fresh program_contact is composite-keyed',
    /CREATE TABLE IF NOT EXISTS program_contact \([\s\S]{0,900}?PRIMARY KEY \(school, sport\)/.test(STORE), null);

  console.log('-- the CLI --');
  ok('applying requires an explicit flag', /const apply = args\.includes\('--apply'\)/.test(CLI), null);
  ok('a bare run only inspects', /Inspection only\. Nothing was executed\./.test(CLI), null);
  ok('dry run executes then rolls back', /DRY RUN \(will execute then ROLL BACK\)/.test(CLI), null);
  ok('prints before and after counts', /printCounts\('BEFORE'/.test(CLI) && /AFTER \(committed\)/.test(CLI), null);
  ok('checks row counts did not move', /ROW COUNT CHECK/.test(CLI), null);
  ok('and refuses to call it done if they did', /Row counts moved\./.test(CLI), null);
  ok('tells you how to undo', /--rollback/.test(CLI), null);
  ok('apply and rollback cannot be combined', /Pick one: --apply or --rollback/.test(CLI), null);

  console.log('-- run(): commit false rolls back --');
  const d = db(BEFORE);
  const res = await mig.run({ connect: async () => ({ query: d.query, release() {} }) }, steps, { commit: false });
  ok('reports success', res.ok === true, res);
  ok('did NOT commit', res.committed === false, res.committed);
  ok('issued a ROLLBACK, not a COMMIT',
    d.log.includes('ROLLBACK') && !d.log.includes('COMMIT'), d.log.filter((x) => /COMMIT|ROLLBACK|BEGIN/.test(x)));
  ok('wrapped everything in one transaction', d.log[0] === 'BEGIN', d.log[0]);

  console.log('');
  console.log('failures: ' + fails);
  process.exit(fails ? 1 : 0);
})();
