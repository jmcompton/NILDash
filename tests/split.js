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
// The migration runner, split statement by statement. The splitter is the risky part:
// cut a DO $$ ... $$ block or a quoted string in the wrong place and a migration that
// used to work starts failing. Lifted from source and run against the REAL files.
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };

const SRV = fs.readFileSync(REPO + 'server/index.js', 'utf8');
function lift(name) {
  const start = SRV.indexOf('function ' + name + '(');
  let p = 0, i = SRV.indexOf('(', start);
  for (; i < SRV.length; i++) { if (SRV[i] === '(') p++; else if (SRV[i] === ')') { p--; if (!p) break; } }
  let d = 0, j = SRV.indexOf('{', i);
  for (; j < SRV.length; j++) { if (SRV[j] === '{') d++; else if (SRV[j] === '}') { d--; if (!d) break; } }
  return SRV.slice(start, j + 1);
}
const SRC = lift('splitSqlStatements');
if (!/out\.push\(buf\)/.test(SRC)) { console.log('FIXTURE BROKEN: did not lift the splitter. Aborting.'); process.exit(1); }
const split = new Function(SRC + '\n return splitSqlStatements;')();

console.log('-- the dollar-quoted block in migration 008 survives intact --');
{
  // This is the case a naive semicolon split destroys: the body has its own
  // semicolons, and cutting on them yields fragments that each fail.
  const sql = fs.readFileSync(REPO + 'server/migrations/008_athlete_messages.sql', 'utf8');
  const stmts = split(sql);
  const doBlocks = stmts.filter((s) => /DO \$\$/.test(s));
  ok('the DO block is exactly one statement', doBlocks.length === 1, doBlocks.length);
  const b = doBlocks[0];
  ok('it still has its END $$', /END \$\$/.test(b));
  ok('and both ALTER TABLEs inside it', (b.match(/ALTER TABLE athlete_messages/g) || []).length === 2,
    (b.match(/ALTER TABLE athlete_messages/g) || []).length);
  ok('and the internal semicolons are still there', (b.match(/;/g) || []).length >= 4, (b.match(/;/g) || []).length);
  ok('nothing else was cut out of the middle of it', !stmts.some((s) => s !== b && /END IF/.test(s)));
}

console.log('\n-- semicolons inside strings and comments are not terminators --');
{
  const s1 = split("SELECT 'a;b' AS x;\nSELECT 2;");
  ok('a semicolon in a string literal does not split', s1.length === 2, s1.map((x) => x.trim()));
  ok("and the literal is intact", /'a;b'/.test(s1[0]), s1[0]);

  const s2 = split("-- a comment; with a semicolon\nSELECT 1;\nSELECT 2;");
  ok('a semicolon in a line comment does not split', s2.length === 2, s2.map((x) => x.trim()));

  const s3 = split("SELECT 'it''s a ; test';\nSELECT 2;");
  ok("an escaped '' inside a literal does not end it early", s3.length === 2, s3.map((x) => x.trim()));

  const s4 = split("DO $$ BEGIN RAISE NOTICE 'x;y'; END $$;\nSELECT 1;");
  ok('a string inside a dollar block is handled too', s4.length === 2, s4.map((x) => x.trim()));

  const s5 = split('CREATE TABLE t (a TEXT DEFAULT \'x\');\n');
  ok('a trailing newline does not produce an empty statement', s5.length === 1, s5);
  const s6 = split('SELECT 1;\n-- trailing comment only\n');
  ok('a comment-only tail is not a statement', s6.length === 1, s6.map((x) => x.trim()));
  ok('an empty file yields no statements', split('').length === 0, split(''));
  ok('a whitespace-only file yields no statements', split('  \n\n ').length === 0);
}

console.log('\n-- NOTHING IS LOST: rejoining reproduces every real migration --');
{
  const dir = REPO + 'server/migrations/';
  const files = fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort();
  ok('there are migrations to check', files.length >= 12, files.length);
  for (const file of files) {
    const sql = fs.readFileSync(dir + file, 'utf8');
    const stmts = split(sql);
    // Every non-comment, non-whitespace character must survive the round trip.
    // SEMICOLONS STRIPPED FROM BOTH SIDES. Joining N statements inserts N-1
    // separators where the file has N terminators, so a direct join is off by one in
    // every file -- which is the fixture's arithmetic, not the splitter's behaviour.
    // What actually matters is that no SQL TEXT is lost or duplicated.
    const strip = (s) => s.replace(/--[^\n]*/g, '').replace(/;/g, '').replace(/\s+/g, '');
    ok(file + ': no SQL lost or duplicated', strip(stmts.join(' ')) === strip(sql),
      { got: strip(stmts.join(' ')).length, want: strip(sql).length });
    // And the terminators are accounted for: one per statement, since every
    // statement in these files ends with one.
    const semis = (sql.replace(/--[^\n]*/g, '').match(/;/g) || []).length;
    const inner = stmts.reduce((n, s) => n + (s.replace(/--[^\n]*/g, '').match(/;/g) || []).length, 0);
    ok('  ' + file + `: ${stmts.length} statements account for all ${semis} semicolons`,
      stmts.length + inner === semis, { stmts: stmts.length, inner, semis });
    ok('  ' + file + ': every statement has real SQL in it',
      stmts.every((s) => s.replace(/--[^\n]*/g, '').trim().length > 0));
  }
}

console.log('\n-- the runner uses it, and reports per statement --');
{
  const code = SRV.replace(/^\s*\/\/.*$/gm, '');
  const blk = code.slice(code.indexOf('const migDir = path.join(__dirname'), code.indexOf('// ── Growth Tab DB Tables'));
  ok('it splits before running', /for \(const stmt of splitSqlStatements\(sql\)\)/.test(blk));
  ok('each statement is its own query, so each gets its own transaction',
    /await store\.pool\.query\(stmt\)/.test(blk) && !/await store\.pool\.query\(sql\)/.test(blk));
  ok('a failing statement is caught individually', /catch \(sErr\)/.test(blk));
  ok('and does not abort the file', blk.indexOf('catch (sErr)') < blk.indexOf('if (!failed.length)'), null);
  ok('a failing file still does not abort the loop', /continue;/.test(blk));
  ok('success reports how many statements ran', /\$\{ok\} statements/.test(SRV));
  ok('failure names the statement AND the error', /firstLineOf\(stmt\)\} -> \$\{sErr\.message\}/.test(SRV));
  ok('and counts both sides', /\$\{ok\} ok, \$\{failed\.length\} failed/.test(SRV));
  ok('the whole thing is still non-fatal', /non-fatal, continuing/.test(SRV));
}

console.log('\n-- migration 006 no longer names a column that does not exist --');
{
  const M = fs.readFileSync(REPO + 'server/migrations/006_nil_director_dashboard.sql', 'utf8');
  const code = M.replace(/^\s*--.*$/gm, '');
  ok('the athlete count reads the link table', /FROM university_athlete_links/.test(code));
  ok('and not athletes', !/FROM\s+athletes/.test(code), (code.match(/FROM\s+athletes.*/) || [])[0]);
  ok('scoped to active links, matching the compliance dashboard', /WHERE status = 'active'/.test(code));
  ok('u.state is gone', !/u\.state/.test(code));
  ok('u.location is used instead', /u\.location/.test(code));
  ok('and it is not aliased to state, because it is not one', !/AS\s+state/i.test(code));
  // The columns the view reads must all exist in a table someone actually creates.
  const STORE = fs.readFileSync(REPO + 'server/store.js', 'utf8');
  const uni = STORE.slice(STORE.indexOf('CREATE TABLE IF NOT EXISTS universities ('));
  const cols = uni.slice(0, uni.indexOf(');'));
  ok('universities really has location', /location/.test(cols));
  ok('universities really has conference', /conference/.test(cols));
  ok('universities really has NO state column', !/\bstate\b/.test(cols), (cols.match(/.*state.*/) || [])[0]);
  const links = STORE.slice(STORE.indexOf('CREATE TABLE IF NOT EXISTS university_athlete_links ('));
  ok('university_athlete_links has university_id and status',
    /university_id/.test(links.slice(0, 400)) && /status/.test(links.slice(0, 400)));
}

console.log('\nfailures: ' + f);
process.exit(f ? 1 : 0);
