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

// ── MOVING A POOL NOBODY COULD READ ─────────────────────────────────────────
//
// market_business_seen was written under a slug of the SCHOOL and read under the
// canonical TOWN, so every row ever written was unreadable where it mattered.
// f7990da fixed the writers; scripts/migrate-market-pool-key.js moves what they
// already wrote.
//
// This suite runs that script against a real database, because the two things
// that can go wrong here are both invisible to a unit test:
//
//   THE MERGE. Two schools in one town share a key, so the move is an upsert.
//   first_seen_at decides whether markMarketNewcomers calls a market
//   established and a brand new to it, so the EARLIEST date has to survive --
//   taking the later one would make businesses we have known for months read as
//   newcomers.
//
//   THE BLAST RADIUS. A key no school accounts for must be left exactly where it
//   is, because translating it would mean reversing a slug, which is a guess.

const { execFileSync } = require('child_process');
const ROOT = REPO;
const store = require(ROOT + 'server/store');
const { marketPoolKey } = require(ROOT + 'server/services/regionKey');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

const AG = 'mpk-agent';
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'unknown';

// Auburn and Bentley are the two the shipped map and the geocode cache cover
// between them; "Nowhere State" is the school that resolves to nothing.
const AUBURN = 'Auburn University';
const ALT = 'Auburn University at Montgomery';   // a second school, same slug family
const NOWHERE = 'Nowhere State Directional College';

function run(extra) {
  return execFileSync(process.execPath,
    [ROOT + 'scripts/migrate-market-pool-key.js'].concat(extra || []),
    { cwd: ROOT, encoding: 'utf8', env: process.env, maxBuffer: 8 * 1024 * 1024 });
}

async function seed(P, key, rows) {
  for (const r of rows) {
    await P.query(
      `INSERT INTO market_business_seen (market_key, brand, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (market_key, brand) DO UPDATE
         SET first_seen_at = EXCLUDED.first_seen_at, last_seen_at = EXCLUDED.last_seen_at`,
      [key, r.brand, r.first, r.last]);
  }
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  const AUB_KEY = marketPoolKey(
    require(ROOT + 'server/services/athleteRecord')
      .resolveAthlete({ school: AUBURN },
        { schoolLocation: require(ROOT + 'server/services/schoolResolver').resolveSchool }).market);
  ok('the shipped map resolves Auburn to a town', !!AUB_KEY && /,/.test(AUB_KEY), AUB_KEY);

  const KEYS = [slug(AUBURN), slug(ALT), slug(NOWHERE), AUB_KEY, 'a-market-no-school-owns'];
  const wipe = async () => {
    for (const t of ['market_business_seen', 'market_business_rejected']) {
      await P.query(`DELETE FROM ${t} WHERE market_key = ANY($1::text[])`, [KEYS]);
    }
    await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]);
    await P.query(`DELETE FROM users WHERE id = $1`, [AG]);
  };
  await wipe();
  await P.query(
    `INSERT INTO users (id,name,email,password,role) VALUES ($1,'MPK','mpk@x.example','x','agent')`,
    [AG]);
  const addAthlete = (id, school) => P.query(
    `INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
    [id, AG, JSON.stringify({ name: id, school })]);
  await addAthlete('mpk-a1', AUBURN);
  await addAthlete('mpk-a2', NOWHERE);

  const old = new Date('2026-01-10T00:00:00Z').toISOString();   // long known
  const recent = new Date('2026-08-30T00:00:00Z').toISOString();

  console.log('\n-- 1. THE DRY RUN LOOKS BEFORE IT TOUCHES --');
  {
    await seed(P, slug(AUBURN), [
      { brand: "Trev's Sports Bar", first: old, last: recent },
      { brand: 'Downtown AC', first: old, last: old },
    ]);
    await P.query(
      `INSERT INTO market_business_rejected (market_key, brand, reason)
       VALUES ($1,'Local PT (or similar near campus)','placeholder')
       ON CONFLICT (market_key, brand) DO NOTHING`, [slug(AUBURN)]);
    await seed(P, slug(NOWHERE), [{ brand: 'Unreachable Cafe', first: old, last: old }]);
    await seed(P, 'a-market-no-school-owns', [{ brand: 'Orphan Diner', first: old, last: old }]);

    const out = run([]);
    ok('it names the move', out.includes(`"${slug(AUBURN)}" -> "${AUB_KEY}"`), null);
    ok('  and says how many rows', /2 seen, 1 rejected/.test(out), null);
    ok('  it reports the school it could not resolve', out.includes(NOWHERE), null);
    ok('  and the key no school accounts for',
      out.includes('a-market-no-school-owns'), null);
    ok('  it is a DRY RUN by default', /DRY RUN/.test(out), null);
    const still = await P.query(
      `SELECT COUNT(*)::int AS n FROM market_business_seen WHERE market_key = $1`, [slug(AUBURN)]);
    ok('  AND NOTHING MOVED', still.rows[0].n === 2, still.rows[0].n);
  }

  console.log('\n-- 2. THE MOVE --');
  {
    const out = run(['--apply']);
    ok('it reports what it moved', /moved 2 seen \+ 1 rejected/.test(out), null);
    const from = await P.query(
      `SELECT COUNT(*)::int AS n FROM market_business_seen WHERE market_key = $1`, [slug(AUBURN)]);
    ok('the old key is empty', from.rows[0].n === 0, from.rows[0].n);
    // THE READ THE SCOUT ACTUALLY MAKES. Not a count under a key we chose --
    // the query from scout.js localCandidates, which is the thing that has never
    // returned a row.
    const scoutRead = await P.query(
      `SELECT m.brand AS brand_name FROM market_business_seen m
        WHERE m.market_key = $1 ORDER BY m.last_seen_at DESC`, [AUB_KEY]);
    ok('THE SCOUT\'S OWN QUERY NOW RETURNS THEM', scoutRead.rowCount === 2,
      scoutRead.rows.map((r) => r.brand_name));
    const rej = await P.query(
      `SELECT COUNT(*)::int AS n FROM market_business_rejected WHERE market_key = $1`, [AUB_KEY]);
    ok('  and the rejected names moved with them, so the shift report still joins',
      rej.rows[0].n === 1, rej.rows[0].n);

    // LEFT ALONE, both of them.
    const nowhere = await P.query(
      `SELECT COUNT(*)::int AS n FROM market_business_seen WHERE market_key = $1`, [slug(NOWHERE)]);
    ok('an unresolvable school\'s rows are untouched', nowhere.rows[0].n === 1, nowhere.rows[0].n);
    const orphan = await P.query(
      `SELECT COUNT(*)::int AS n FROM market_business_seen WHERE market_key = $1`,
      ['a-market-no-school-owns']);
    ok('  and so is a key no school accounts for', orphan.rows[0].n === 1, orphan.rows[0].n);
  }

  console.log('\n-- 3. RUN IT TWICE --');
  {
    const out = run(['--apply']);
    ok('a second run finds nothing to move', /nothing: no rows are filed/.test(out), out.slice(-200));
    const n = await P.query(
      `SELECT COUNT(*)::int AS n FROM market_business_seen WHERE market_key = $1`, [AUB_KEY]);
    ok('  and nothing is duplicated or lost', n.rows[0].n === 2, n.rows[0].n);
  }

  console.log('\n-- 4. THE MERGE KEEPS THE EARLIEST first_seen_at --');
  {
    // The same brand under both keys, with the OLD key holding the earlier date.
    // markMarketNewcomers reads first_seen_at to decide whether a market is
    // established and whether a brand is new to it, so if the later date won,
    // a business we have known since January would read as a newcomer.
    await P.query(`DELETE FROM market_business_seen WHERE market_key = ANY($1::text[])`,
      [[slug(AUBURN), AUB_KEY]]);
    await seed(P, AUB_KEY, [{ brand: 'Shared Cafe', first: recent, last: recent }]);
    await seed(P, slug(AUBURN), [{ brand: 'Shared Cafe', first: old, last: old }]);
    run(['--apply']);
    const r = await P.query(
      `SELECT first_seen_at, last_seen_at FROM market_business_seen
        WHERE market_key = $1 AND brand = 'Shared Cafe'`, [AUB_KEY]);
    ok('one row survives, not two', r.rowCount === 1, r.rowCount);
    ok('  THE EARLIEST first_seen_at WINS',
      new Date(r.rows[0].first_seen_at).getTime() === new Date(old).getTime(),
      r.rows[0].first_seen_at);
    ok('  and the LATEST last_seen_at wins',
      new Date(r.rows[0].last_seen_at).getTime() === new Date(recent).getTime(),
      r.rows[0].last_seen_at);
    // And the newcomer test that column feeds actually behaves.
    const newcomers = await store.markMarketNewcomers(AUB_KEY, ['Shared Cafe', 'Brand New Place']);
    ok('  SO A LONG-KNOWN BUSINESS IS NOT REPORTED AS NEW',
      !newcomers.has('Shared Cafe'), [...newcomers]);
    ok('  while a genuinely new one is', newcomers.has('Brand New Place'), [...newcomers]);
  }

  console.log('\n-- 5. TWO SCHOOLS IN ONE TOWN SHARE ONE POOL --');
  {
    // Not a collision to be avoided -- the point. The businesses are the same
    // businesses. Said out loud by the script rather than done silently.
    await P.query(`DELETE FROM market_business_seen WHERE market_key = ANY($1::text[])`,
      [[slug(AUBURN), slug(ALT), AUB_KEY]]);
    await addAthlete('mpk-a3', ALT);
    await seed(P, slug(AUBURN), [{ brand: 'Toomers Corner', first: old, last: old }]);
    await seed(P, slug(ALT), [{ brand: 'Second School Cafe', first: old, last: old }]);
    const dry = run([]);
    const altKey = marketPoolKey(
      require(ROOT + 'server/services/athleteRecord').resolveAthlete({ school: ALT },
        { schoolLocation: require(ROOT + 'server/services/schoolResolver').resolveSchool }).market);
    if (altKey === AUB_KEY) {
      ok('the script SAYS the two pools will merge', /their pools merge/.test(dry), null);
      run(['--apply']);
      const n = await P.query(
        `SELECT COUNT(*)::int AS n FROM market_business_seen WHERE market_key = $1`, [AUB_KEY]);
      ok('  and both schools\' businesses are in the one town pool', n.rows[0].n === 2, n.rows[0].n);
    } else {
      // The map gives them different towns, which is also correct. Assert the
      // separation rather than skipping, so this is a recorded answer either way.
      run(['--apply']);
      const a = await P.query(
        `SELECT COUNT(*)::int AS n FROM market_business_seen WHERE market_key = $1`, [AUB_KEY]);
      ok('the two schools resolve to DIFFERENT towns, so the pools stay apart',
        a.rows[0].n === 1, { AUB_KEY, altKey, n: a.rows[0].n });
    }
  }

  console.log('\n-- 6. IT NEVER TOUCHES A ROW ALREADY UNDER A TOWN KEY --');
  {
    const src = require('fs').readFileSync(ROOT + 'scripts/migrate-market-pool-key.js', 'utf8');
    ok('only keys a school actually produces are moved',
      /const from = oldKeyOf\(school\)/.test(src) && /if \(from === to\) continue;/.test(src), null);
    ok('  the slug is never reversed into a school name',
      /NOT by reversing the slug/.test(src), null);
    ok('  and the whole move is one transaction',
      /await client\.query\('BEGIN'\)/.test(src) && /ROLLBACK/.test(src), null);
    ok('  with a dry run as the default', /const APPLY = args\.includes\('--apply'\)/.test(src), null);
    ok('  and live Places lookups behind their own flag',
      /const GEOCODE = args\.includes\('--geocode'\)/.test(src), null);
  }

  // Tidy up so the suite can run twice.
  for (const t of ['market_business_seen', 'market_business_rejected']) {
    await P.query(`DELETE FROM ${t} WHERE market_key = ANY($1::text[])`, [KEYS]);
  }
  await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM users WHERE id = $1`, [AG]);

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
