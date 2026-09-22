'use strict';
// Against the local Postgres: the claim is that the LinkedIn export survives
// in the database and the brief reads it from there, which is a claim about
// storage, not about parsing.
//
//   node tests/run.js                  every suite, against the committed baseline
//   node tests/briefconnections.js     just this one
const _tp = require('path');
const fs = require('fs');
const os = require('os');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE BRIEF COULD ONLY EVER RUN ON ONE MAC ────────────────────────────────
//
// prospecting.js read ~/nildash-briefs/Connections.csv. A server has no such
// file, so the brief could not move off the laptop, and the one workaround
// (BRIEFS_CONNECTIONS_URL) puts 1,700 real people's names, employers and
// email addresses behind a URL. The export lives in Postgres now, uploaded
// through an admin page and read wherever the brief runs.

const store = require(REPO + 'server/store');
const BC = require(REPO + 'server/services/briefConnections.js');
const RS = require(REPO + 'tools/briefs/run-slot.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const HEADER = 'First Name,Last Name,URL,Email Address,Company,Position,Connected On';
const GOOD = [
  'Notes:', '"When exporting your connection data, ..."', '',
  HEADER,
  'Ann,Lee,https://www.linkedin.com/in/annlee,ann@x.com,Rise Agency,"Agent, NIL",01 Jan 2024',
  'Bob,Ray,https://www.linkedin.com/in/bobray,,Acme Sports,Player Management,02 Jan 2024',
  'Cy,Ng,https://www.linkedin.com/in/cyng,cy@y.com,Bank,Teller,03 Jan 2024',
].join('\n') + '\n';

async function main() {
  await wait(TEST_INIT_WAIT_MS);
  const pool = store.pool;
  await BC.ensureTable(pool);
  await pool.query(`DELETE FROM brief_connections`);

  // ── THE PARSER, WHICH IS NOW THE ONLY ONE ──────────────────────────────
  OUT.push('-- the parser --');
  const people = BC.parseCsv(GOOD);
  ok('LinkedIn\'s preamble is skipped and the real header found', people.length === 3, people.length);
  ok('  a quoted field containing a comma stays one field', people[0].position === 'Agent, NIL', people[0].position);
  ok('  a withheld email address is empty, not missing', people[1].email === '' && people[1].first === 'Bob');
  ok('  addresses are lower-cased the way the brief matches them', BC.parseCsv(GOOD.replace('ann@x.com', 'ANN@X.com'))[0].email === 'ann@x.com');
  ok('THE BRIEF USES THIS PARSER, not a second copy of it',
    /require\('\.\.\/\.\.\/server\/services\/briefConnections'\)/.test(src('tools/briefs/prospecting.js'))
    && !/^function parseCsv/m.test(src('tools/briefs/prospecting.js')));

  // ── WHAT IS REFUSED, AND WHY, IN WORDS ─────────────────────────────────
  OUT.push('', '-- a bad upload --');
  ok('a good export has no problem', BC.problemWith(GOOD) === null, BC.problemWith(GOOD));
  ok('an empty file is refused', /empty/.test(BC.problemWith('') || ''));
  ok('a JSON file is refused, and told which file to pick', /JSON, not a CSV/.test(BC.problemWith('{"a":1}') || ''));
  ok('a zip is refused, and told to unzip it', /unzip/i.test(BC.problemWith('PK\u0003\u0004rest of a zip') || ''));
  ok('SOME OTHER CSV IS REFUSED: no "First Name" header means it is not the export',
    /First Name/.test(BC.problemWith('name,email\nann,ann@x.com') || ''));
  ok('a truncated export (header, no rows) is refused as truncated',
    /truncated/.test(BC.problemWith(HEADER + '\n') || ''));
  ok('  every refusal is a sentence a person can act on, not a code',
    ['', '{"a":1}', 'name,email\na,b', HEADER + '\n'].every((t) => /[a-z] [a-z]/.test(BC.problemWith(t) || '')));

  // ── STORING IT ─────────────────────────────────────────────────────────
  OUT.push('', '-- the store --');
  const bad = await BC.save(pool, { csv: 'name,email\na,b', filename: 'wrong.csv' });
  ok('a bad file is refused BEFORE anything is written', bad.ok === false && (await BC.latest(pool)) === null, bad);

  const first = await BC.save(pool, { csv: GOOD, filename: 'Connections.csv', uploadedBy: 'jm@x.com' });
  ok('a good export is stored, counted and sized', first.ok === true && first.rows === 3 && first.bytes > 100, first);
  const cur = await BC.latest(pool);
  ok('  and read back whole, byte for byte', cur.csv === GOOD && cur.rows === 3, { rows: cur.rows, same: cur.csv === GOOD });
  ok('  with who uploaded it and when', cur.uploadedBy === 'jm@x.com' && !!cur.uploadedAt);

  // A REJECTED UPLOAD DOES NOT REPLACE A GOOD ONE. This is the whole reason
  // validation happens before the write: a wrong file at 11pm must not take
  // the 6am brief down.
  const bad2 = await BC.save(pool, { csv: 'oops', filename: 'oops.csv' });
  ok('A LATER BAD UPLOAD LEAVES THE GOOD ONE IN PLACE', bad2.ok === false && (await BC.latest(pool)).rows === 3, bad2);

  await wait(10);
  const second = await BC.save(pool, { csv: GOOD + 'Dee,Fox,https://www.linkedin.com/in/deefox,,Collective,Director,04 Jan 2024\n', filename: 'Connections-new.csv' });
  ok('a newer export is stored alongside, not over, the old one', second.ok === true && second.rows === 4);
  const now = await BC.latest(pool);
  ok('  and the NEWEST is the one the brief reads', now.rows === 4 && now.filename === 'Connections-new.csv', now.filename);
  const hist = await BC.history(pool, 10);
  ok('  the history has both, newest first, and carries no CSV body',
    hist.length === 2 && hist[0].rows === 4 && hist[1].rows === 3 && hist.every((h) => h.csv === undefined), hist);

  // ── DELETING AN OLD ONE, NEVER THE LIVE ONE ────────────────────────────
  OUT.push('', '-- deleting --');
  const delLive = await BC.remove(pool, now.id);
  ok('THE EXPORT IN USE CANNOT BE DELETED FROM THE PAGE', delLive.ok === false && /the brief is using/.test(delLive.error), delLive);
  ok('  and it is still there afterwards', (await BC.latest(pool)).id === now.id);
  const delOld = await BC.remove(pool, hist[1].id);
  ok('an older one can be deleted', delOld.ok === true && delOld.removed === 1, delOld);
  ok('  which leaves the live one untouched', (await BC.latest(pool)).rows === 4);
  ok('a delete of something that does not exist is refused, not a crash', (await BC.remove(pool, 'abc')).ok === false);

  // ── A MISSING TABLE IS "NOTHING UPLOADED", NOT A CRASH ─────────────────
  // The Mac runs with no DATABASE_URL at all and must keep working off its
  // own file, so every read here fails soft.
  OUT.push('', '-- failing soft --');
  const brokenPool = { query: async () => { throw new Error('relation "brief_connections" does not exist'); } };
  ok('latest() on a database without the table is null, not a throw', (await BC.latest(brokenPool)) === null);
  ok('history() on the same is empty, not a throw', JSON.stringify(await BC.history(brokenPool, 5)) === '[]');

  const pr = src('tools/briefs/prospecting.js');
  ok('the brief treats a missing DATABASE_URL as "nothing stored" and looks at files',
    /if \(!process\.env\.DATABASE_URL\)/.test(pr) && /return null;/.test(pr));
  ok('  but a database that FAILED is a warning in the brief, because that is a different problem',
    /Could not read the connections export from the database/.test(pr));
  ok('  and the "no CSV" brief names the upload page', /Upload the LinkedIn export at \/admin\/connections/.test(pr));

  // ── THE ADMIN PAGE ─────────────────────────────────────────────────────
  OUT.push('', '-- the admin page --');
  const idx = src('server/index.js');
  ok('there is a page at /admin/connections', /app\.get\('\/admin\/connections', requireAuth/.test(idx));
  ok('  and it is admin-only, like every other admin page',
    /app\.get\('\/admin\/connections'[\s\S]{0,400}?user\.email !== ADMIN_EMAIL/.test(idx));
  for (const [method, route] of [['GET', `app.get('/api/admin/connections'`], ['POST', `app.post('/api/admin/connections'`], ['DELETE', `app.delete('/api/admin/connections/:id'`]]) {
    const at = idx.indexOf(route);
    ok(`  ${method} ${route.match(/'([^']*)'/)[1]} is admin-only too`,
      at > 0 && /user\.email !== ADMIN_EMAIL/.test(idx.slice(at, at + 500)));
  }
  ok('the upload is posted as text, so there is no upload directory and no file on any disk',
    /briefConnectionsJson = express\.json\(/.test(idx) && /readAsText/.test(src('public/admin-connections.html')));
  ok('THE LISTING NEVER RETURNS THE ROWS THEMSELVES, only the counts',
    /res\.json\(\{ current: rows\[0\] \|\| null, history: rows/.test(idx)
    && /SELECT id, filename, rows, bytes, uploaded_by, uploaded_at\s*\n\s*FROM brief_connections/.test(src('server/services/briefConnections.js')));
  const page = src('public/admin-connections.html');
  ok('the page says where to get the file from LinkedIn', /Get a copy of your data/.test(page) && /Connections\.csv/.test(page));
  ok('  and says plainly when nothing is stored, rather than showing a zero',
    /No export stored yet/.test(page) && /0 drafted/.test(page));
  ok('  it offers a test run of the brief against what was just uploaded',
    /scripts\/brief\?which=prospecting/.test(page));

  // ── RUNNING ONE BRIEF ON DEMAND ────────────────────────────────────────
  OUT.push('', '-- the on-demand runner --');
  ok('the four briefs are registered in the admin script runner', /^\s*brief: \{$/m.test(idx) && /tools\/briefs\/run-slot\.js/.test(idx));
  ok('  it goes through run-slot --brief, the same entry point the cron uses', /return \['--brief', which\]/.test(idx));
  ok('AN UNKNOWN BRIEF NAME IS REFUSED, not interpolated into a command line',
    /if \(!names\.includes\(which\)\)/.test(idx) && /e\.status = 400/.test(idx));
  ok('  and the refusal names the four', /which must be one of \$\{names\.join\(', '\)\}/.test(idx));
  ok('a job is remembered by name AND arguments, so two briefs do not share one result',
    /const key = req\.params\.name \+ \(args\.length \? ' ' \+ args\.join\(' '\) : ''\)/.test(idx)
    && /_adminScriptJobs\.set\(key, job\)/.test(idx) && !/_adminScriptJobs\.set\(req\.params\.name/.test(idx));

  ok('only known flags reach the brief', JSON.stringify(RS.briefFlags(['--no-email', '--debug'])) === '["--no-email","--debug"]');
  ok('  anything else is dropped rather than passed to a spawned process',
    JSON.stringify(RS.briefFlags(['; rm -rf /', '--exclude', 'x', '--no-email'])) === '["--no-email"]');
  ok('RUN-SLOT\'S OWN --dry NEVER REACHES A BRIEF: it means "run nothing", not "draft nothing"',
    JSON.stringify(RS.briefFlags(['--dry'])) === '[]');
  ok('  the brief\'s own dry run is --brief-dry, translated on the way in',
    JSON.stringify(RS.briefFlags(['--brief-dry'])) === '["--dry"]' && /q\.dry \? \['--brief-dry'\]/.test(idx));
  ok('  a flag given twice is passed once', JSON.stringify(RS.briefFlags(['--debug', '--debug'])) === '["--debug"]');

  // ── THE SCHEDULE, THE POINT OF ALL OF THIS ─────────────────────────────
  // Every firing of railway.json's cron, in both Central offsets, must land
  // on all four slots exactly once. A schedule that is right in July and
  // wrong in December is a schedule that fails silently at a clock change.
  OUT.push('', '-- 5:30, 5:45, 6:00, 6:15 Central, all year --');
  const cron = JSON.parse(src('tools/briefs/railway.json')).deploy.cronSchedule;
  ok('railway.json fires every fifteen minutes across 10:00-12:59 UTC', cron === '*/15 10-12 * * *', cron);
  for (const [label, off] of [['CDT (UTC-5)', 5], ['CST (UTC-6)', 6]]) {
    const hit = [];
    for (let h = 10; h <= 12; h++) for (const m of [0, 15, 30, 45]) {
      const s = RS.pickSlot(`${String((h - off + 24) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
      if (s) hit.push(s.brief);
    }
    ok(`  ${label}: all four briefs, once each, in order`,
      JSON.stringify(hit) === JSON.stringify(['follow-ups', 'news-watch', 'prospecting', 'strategy-watch']), hit);
  }
  ok('a firing that lands on no slot runs nothing', RS.pickSlot('06:40') === null && RS.pickSlot('04:00') === null);

  await pool.query(`DELETE FROM brief_connections`);
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('briefconnections: FAILED', e); process.exit(1); });
