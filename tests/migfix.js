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
// The two dry-run bugs: the cols type crash, and the shared-pool poisoning.
const fs = require('fs');
const mig = require(REPO + 'server/services/programSportMigration.js');
const CLI = fs.readFileSync(REPO + 'server/jobs/migrateProgramSport.js', 'utf8');
const MIGSRC = fs.readFileSync(REPO + 'server/services/programSportMigration.js', 'utf8');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}

console.log('-- BUG 1: the exact value that crashed --');
// name[] arrives from node-postgres as this literal string, not an array.
ok('a postgres array literal parses',
  mig._colNames('{school,role,name}').join(',') === 'school,role,name',
  mig._colNames('{school,role,name}'));
ok('and does not throw', (() => { try { mig._colNames('{a,b}'); return true; } catch (_) { return false; } })(), null);
ok('a real JS array still works',
  mig._colNames(['school', 'sport']).join(',') === 'school,sport', null);
ok('quoted identifiers are unquoted',
  mig._colNames('{"School Name",role}').join('|') === 'School Name|role',
  mig._colNames('{"School Name",role}'));
ok('an empty literal is an empty list', mig._colNames('{}').length === 0, mig._colNames('{}'));
ok('null is an empty list, not a crash', mig._colNames(null).length === 0, null);
ok('undefined is an empty list', mig._colNames(undefined).length === 0, null);
ok('a single column parses', mig._colNames('{school}').join(',') === 'school', null);
// The thing that actually blew up: .slice on a non-array.
let threw = false;
try { mig._colNames(12345); } catch (_) { threw = true; }
ok('an unexpected type does NOT throw', threw === false, null);
ok('an unexpected type returns empty rather than a wrong answer',
  mig._colNames(12345).length === 0, null);

console.log('-- the query now casts, so the driver parses it --');
ok('attname is cast to text', /a\.attname::text/.test(MIGSRC), null);
ok('the array itself is cast to text[]', /\)::text\[\] AS cols/.test(MIGSRC), null);
ok('both constraint queries cast',
  (MIGSRC.match(/\)::text\[\] AS cols/g) || []).length === 2,
  (MIGSRC.match(/\)::text\[\] AS cols/g) || []).length);
ok('the raw value is logged when the type is unrecognised',
  /unexpected constraint column type[\s\S]{0,200}?JSON\.stringify\(raw\)/.test(MIGSRC), null);

console.log('-- constraint discovery works against the STRING form end to end --');
// Replay the pre-migration database, but returning cols the way the driver did
// when it crashed. Discovery must still find the constraint.
function dbStringCols() {
  return {
    query: async (sql, params) => {
      if (/to_regclass/.test(sql)) return { rows: [{ t: String(params[0]).replace('public.', '') }] };
      if (/information_schema\.columns/.test(sql)) {
        const [t, c] = params;
        const cols = {
          program_staff: ['school', 'role', 'name', 'sport'],
          program_source: ['school', 'football_staff_url', 'football_staff_url_discovered_via'],
          program_contact: ['school', 'football_office_phone', 'football_office_phone_source_url'],
        };
        return { rows: (cols[t] || []).includes(c) ? [{ 1: 1 }] : [] };
      }
      if (/pg_constraint/.test(sql)) {
        const t = String(params[0]).replace('public.', '');
        const type = params[1];
        const all = {
          program_staff: [{ conname: 'program_staff_school_role_name_key', contype: 'u', cols: '{name,role,school}' }],
          program_source: [{ conname: 'program_source_pkey', contype: 'p', cols: '{school}' }],
          program_contact: [{ conname: 'program_contact_pkey', contype: 'p', cols: '{school}' }],
        };
        const rows = (all[t] || []).filter((c) => !type || c.contype === type);
        return { rows };
      }
      if (/COUNT/.test(sql)) return { rows: [{ n: 8527 }] };
      return { rows: [] };
    },
  };
}
(async () => {
  const d = dbStringCols();
  const found = await mig.constraintOn(d, 'program_staff', ['school', 'role', 'name'], 'u');
  ok('finds the old unique constraint despite the string form',
    found === 'program_staff_school_role_name_key', found);
  ok('column ORDER does not matter, the set does', found !== null, found);

  const { steps } = await mig.plan(d);
  const sql = steps.map((s) => s.sql).join('\n');
  ok('the plan builds without throwing', steps.length > 0, steps.length);
  ok('and drops the constraint it discovered',
    /DROP CONSTRAINT "program_staff_school_role_name_key"/.test(sql), null);

  const cons = await mig.constraintsFor(d, 'program_staff');
  ok('constraintsFor parses the string form too',
    cons[0] && cons[0].cols.join(',') === 'name,role,school', cons[0]);
  ok('and keeps the raw value for printing', cons[0] && cons[0].rawCols === '{name,role,school}', cons[0]);

  console.log('-- BUG 2: the CLI owns its pool --');
  ok('it does NOT require ../store', !/require\('\.\.\/store'\)/.test(CLI), null);
  ok('no store.pool reference remains outside comments',
    !/^[^/]*store\.pool/m.test(CLI.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')), null);
  ok('it constructs its own Pool', /const \{ Pool \} = require\('pg'\)/.test(CLI), null);
  ok('from DATABASE_URL', /connectionString: process\.env\.DATABASE_URL/.test(CLI), null);
  ok('it refuses to run without DATABASE_URL rather than borrowing one',
    /DATABASE_URL is not set\./.test(CLI), null);
  ok('main takes the pool as a parameter, it does not reach for a global',
    /async function main\(pool\)/.test(CLI), null);
  ok('only the pool it created is ended',
    /Only ever ends the pool THIS script created/.test(CLI), null);
  ok('the end is guarded on that pool existing', /if \(pool\) await pool\.end\(\)/.test(CLI), null);
  ok('a fatal error prints the stack so the next crash is diagnosable',
    /if \(e && e\.stack\) console\.error\(e\.stack\)/.test(CLI), null);
  ok('it uses a small pool, it is a one-shot script', /max: 2/.test(CLI), null);

  console.log('-- boot path cannot take the server down --');
  const STORE = fs.readFileSync(REPO + 'server/store.js', 'utf8');
  ok('ensureSchema is wrapped in a catch at the call site',
    /ensureSchema\(pool\)\.catch\(/.test(STORE), null);
  ok('ensureSchema catches internally too', /catch \(e\) \{\s*console\.error\('\[programSport\] schema migration error/.test(MIGSRC), null);
  ok('ensureSchema NEVER ends the pool it was handed', !/pool\.end\(\)/.test(MIGSRC), null);
  ok('the migration module never calls process.exit', !/process\.exit/.test(MIGSRC), null);
  // A failing plan must degrade, not throw into store init.
  const boom = { query: async () => { throw new Error('boom'); } };
  const res = await mig.ensureSchema(boom);
  ok('a totally broken database returns instead of throwing', res && res.applied === 0, res);
  ok('and reports the error', !!(res && res.error), res);

  console.log('');
  console.log('failures: ' + fails);
  process.exit(fails ? 1 : 0);
})();
