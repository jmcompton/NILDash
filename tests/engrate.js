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

// ── AN ENGAGEMENT RATE WE DO NOT HAVE IS NOT 3% ─────────────────────────────
//
// Both the Add Client form and POST /api/athletes read `parseFloat(v) || 3.0`.
// So a blank field stored 3.0 -- and so did a real 0, because `0 || 3.0` is 3.0.
// The stored number was indistinguishable from a measured one: igStatsSource
// said 'manual' either way and nothing dated it.
//
// It then reached media kits, the older pitch path (in the prompt AND in
// hardcoded fallback copy), draft prewarm, and deal_comps -- where other
// athletes are benchmarked against it.
//
// Nothing computes an engagement rate anywhere in the product. The Instagram
// page scrape returns followers and posts and never a rate; only the web-search
// fallback can produce one, and its own prompt tells it that null is the right
// answer for a normal college account. It is hand-entered or it is absent.

const fs = require('fs');
const ROOT = REPO;
const RP = require(ROOT + 'server/services/reachProvenance');
const AN = require(ROOT + 'server/services/analyst');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

const idx = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
const html = fs.readFileSync(ROOT + 'public/index.html', 'utf8');

// The server helper, exercised through its own source since index.js boots a
// server on require. Pulled out and evaluated rather than copied, so the test
// cannot drift from the implementation.
const _ve = (() => {
  const m = idx.match(/function _validEngagement\(v\) \{[\s\S]*?\n\}/);
  if (!m) return null;
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '; return _validEngagement;')();
})();

function main() {
  console.log('\n-- 1. BLANK STAYS ABSENT, A REAL 0 STAYS 0 --');
  {
    ok('the server has a validator at all', typeof _ve === 'function');
    ok('THE 3.0 DEFAULT IS GONE FROM THE SERVER',
      !/engagement: parseFloat\(engagement\) \|\| 3\.0/.test(idx), null);
    ok('  and from the form',
      !/parseFloat\(document\.getElementById\('a_eng'\)\.value\) \|\| 3\.0/.test(html), null);

    ok('blank -> absent', _ve('') === null, _ve(''));
    ok('null -> absent', _ve(null) === null, _ve(null));
    ok('junk -> absent', _ve('banana') === null, _ve('banana'));
    ok('out of range -> absent', _ve('250') === null && _ve('-4') === null,
      [_ve('250'), _ve('-4')]);
    // THE CASE THE `||` ATE.
    ok('A REAL 0 STAYS 0, not 3.0', _ve('0') === 0 && _ve(0) === 0, [_ve('0'), _ve(0)]);
    ok('  and is told apart from absent', _ve(0) !== _ve(''), [_ve(0), _ve('')]);
    ok('a real value survives', _ve('4.2') === 4.2 && _ve(6) === 6, [_ve('4.2'), _ve(6)]);
    ok('  and "4.2%" is read', _ve('4.2%') === 4.2, _ve('4.2%'));
    // undefined is "the key was not sent", which must not overwrite a stored value.
    ok('undefined means UNANSWERED, not absent', _ve(undefined) === undefined);
    ok('  and the patch drops the key rather than writing it',
      /if \(e === undefined\) \{ delete patch\.engagement; \}/.test(idx), null);
  }

  console.log('\n-- 2. DATED, LIKE THE FOLLOWER COUNT --');
  {
    const NOW = new Date('2026-09-04T00:00:00Z');
    const undated = RP.engagementProvenance({ engagement: 3.0 }, NOW);
    ok('an undated rate is NOT citable', undated.citable === false, undated);
    ok('  and says so in words', /date and source not recorded/.test(undated.label), undated.label);

    const dated = RP.engagementProvenance(
      { engagement: 4.2, engagementSource: 'agent', engagementAsOf: '2026-08-14' }, NOW);
    ok('a dated rate IS citable', dated.citable === true, dated);
    ok('  and carries the date to print', dated.asOfText === '14 Aug 2026', dated.asOfText);
    ok('  with the same wording reach uses', dated.label === 'as of 14 Aug 2026', dated.label);

    const old = RP.engagementProvenance(
      { engagementSource: 'agent', engagementAsOf: '2025-01-01' }, NOW);
    ok('  and an old one is flagged stale', old.stale === true, old);

    // ITS OWN FIELDS. A follower count refreshed today says nothing about when
    // the rate was measured, and sharing reachAsOf would let a fetch that
    // returned NO rate re-date the old one.
    const reachOnly = RP.engagementProvenance(
      { reachSource: 'agent', reachAsOf: '2026-09-01' }, NOW);
    ok('THE REACH DATE DOES NOT DATE THE RATE', reachOnly.citable === false, reachOnly);
    ok('  and the rate date does not date the reach',
      RP.reachProvenance({ engagementAsOf: '2026-09-01' }, NOW).asOf === null);

    ok('the citation detector finds a rate in copy',
      RP.citesEngagement('a 4.2% engagement rate') && RP.citesEngagement('4.2% engagement'),
      null);
    ok('  and does not fire on a follower count',
      !RP.citesEngagement('128,400 followers'), null);
  }

  console.log('\n-- 3. THE WRITE PATHS STAMP IT --');
  {
    ok('create stamps a source and a date', /engagementSource: _validEngagement\(engagement\)/.test(idx)
      && /engagementAsOf: _validEngagement\(engagement\)/.test(idx), null);
    ok('the stats fetch stamps one too', /merged\.engagementAsOf = fetchedAt\.slice\(0, 10\)/.test(idx), null);
    // RE-SAVING A PROFILE MUST NOT RE-DATE A RATE NOBODY RE-MEASURED. That would
    // launder an old number into a fresh one, which is the whole failure the
    // dating exists to prevent.
    ok('THE DATE ONLY MOVES WHEN THE NUMBER DOES',
      /if \(before !== e\) \{/.test(idx) && /patch\.engagementAsOf = new Date\(\)/.test(idx), null);
    ok('  and clearing the rate clears its date',
      /if \(e === null\) \{ patch\.engagementSource = null; patch\.engagementAsOf = null; \}/.test(idx), null);
  }

  console.log('\n-- 4. THE MEDIA KIT --');
  {
    const NOW = new Date('2026-09-04T00:00:00Z');
    const base = { name: 'Amari Allen', school: 'Auburn', sport: 'football',
      position: 'WR', instagram: 40000 };
    const row = (kit) => kit.facts.find((f) => f.key === 'engagement');

    const absent = AN.composeKit({ ...base }, { now: NOW });
    ok('AN ABSENT RATE IS OMITTED, not shown as a number', !row(absent), absent.facts.map((f) => f.key));
    ok('  and the kit still lints clean', AN.lintKit(absent, { ...base }).ok !== false,
      AN.lintKit(absent, { ...base }).problems);

    const dated = AN.composeKit(
      { ...base, engagement: 4.2, engagementSource: 'agent', engagementAsOf: '2026-08-14' },
      { now: NOW });
    ok('a dated rate is shown WITH its date', row(dated) && /4\.2%/.test(row(dated).value)
      && /as of 14 Aug 2026/.test(row(dated).value), row(dated));

    // The rows written before the storage fix are still 3.0 with no date. Shown
    // with the caveat rather than bare, so a laundered default is visible to the
    // person reading the kit instead of invisible.
    const legacy = AN.composeKit({ ...base, engagement: 3.0 }, { now: NOW });
    ok('AN UNDATED LEGACY 3.0 IS NOT PRINTED AS A BARE FACT',
      row(legacy) && /date and source not recorded/.test(row(legacy).value), row(legacy));

    // ── STORAGE TELLS 0 FROM BLANK. THE KIT STILL DOES NOT PRINT 0%. ──────
    // Those are different questions and only the first one changed. Printing
    // "Engagement: 0%" on a document going to a brand under the agent's name is
    // self-harm, and tests/analyst.js has recorded that decision all along.
    ok('THE KIT STILL REFUSES TO PRINT 0%',
      !row(AN.composeKit({ ...base, engagement: 0 }, { now: NOW })), null);
    ok('  while storage keeps the distinction that matters', _ve(0) === 0 && _ve('') === null,
      [_ve(0), _ve('')]);
    ok('  and junk is absent either way', AN.composeKit({ ...base, engagement: 'banana' },
      { now: NOW }).engagement === null);
    ok('the kit exposes the rate provenance separately from reach',
      !!dated.engagementProvenance && dated.engagementProvenance !== dated.reachProvenance, null);
  }

  console.log('\n-- 5. NOTHING CITES AN UNDATED RATE TO A MODEL --');
  {
    // CODE, NOT COMMENTS. The helper's own comment quotes the line it replaced,
    // so a raw grep matches the explanation rather than a statement.
    const pgRaw = fs.readFileSync(ROOT + 'server/services/pitchGeneration.js', 'utf8');
    const pg = pgRaw.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    ok('the prompt no longer states "Engagement: 0%"',
      !/- Engagement: \$\{athleteData\.engagement \|\| 0\}%/.test(pg), null);
    ok('  it withholds an undated rate entirely',
      /if \(!ep\.citable\) return '';/.test(pg), null);
    ok('THE FALLBACK COPY NAMES NO RATE, because no model is involved to refuse it',
      !/\$\{athleteData\.engagement \|\| 0\}% engagement/.test(pg)
        && !/\$\{athleteData\.engagement \|\| 0\}% engagement rate/.test(pg), null);
    const dp = fs.readFileSync(ROOT + 'server/services/draftPrewarm.js', 'utf8');
    ok('draft prewarm withholds one too',
      /const ep = RP\.engagementProvenance\(a\)/.test(dp) && /hasRate && ep\.citable/.test(dp), null);
    // The live pitch path never had one, and this records that rather than
    // leaving it to be rediscovered.
    const pw = fs.readFileSync(ROOT + 'server/services/pitchWriter.js', 'utf8');
    ok('THE LIVE PITCH WRITER STILL DOES NOT MENTION ENGAGEMENT AT ALL',
      !/engagement/i.test(pw), null);
  }

  console.log('\n-- 6. THE AUDIT SCRIPT: COUNT, THEN CLEAR, REVERSIBLY --');
  {
    const sc = fs.readFileSync(ROOT + 'scripts/audit-engagement-default.js', 'utf8');
    ok('counting is the default and writes nothing',
      /if \(!CLEAR\) \{/.test(sc) && /Nothing was changed/.test(sc), null);
    ok('  it separates a dated 3.0 from an undated one',
      /three_undated/.test(sc), null);
    ok('  and reports the spread, so 3.0 can be judged a spike or not',
      /most common values/.test(sc), null);
    ok('  covering deal_comps, which is what benchmarks other athletes',
      /FROM deal_comps/.test(sc), null);

    // ── THE SCOPE OF THE CLEAR, WHICH IS THE WHOLE RISK ─────────────────────
    // 31 rows across a live roster. What it must NOT touch matters more than
    // what it does.
    ok('THE TARGET IS EXACTLY 3.0 AND UNDATED, defined once',
      /const TARGET_SQL = /.test(sc)
        && /\(a\.data->>'engagement'\)::numeric = 3\.0/.test(sc)
        && /COALESCE\(a\.data->>'engagementAsOf', ''\) = ''/.test(sc), null);
    ok('  a numeric guard, so one junk row cannot take the statement down',
      /a\.data->>'engagement' ~ '\^\[0-9\]\+\(\\\\\.\[0-9\]\+\)\?\$'/.test(sc), null);
    ok('  ONLY the three engagement keys are written',
      /- 'engagement' - 'engagementSource' - 'engagementAsOf'/.test(sc), null);
    ok('  and the dry run names the athletes AND their agents',
      /u\.email AS agent_email/.test(sc) && /DRY RUN\. Nothing written/.test(sc), null);
    ok('  it says out loud what it is sparing',
      /LEFT ALONE: /.test(sc), null);
    ok('A CEILING, against a mis-scoped WHERE rather than against the known 31',
      /targets\.length > MAX/.test(sc) && /REFUSING: /.test(sc), null);
    ok('  and the whole clear is one transaction',
      /await client\.query\('BEGIN'\)/.test(sc) && /ROLLBACK/.test(sc), null);

    // ── REVERSIBLE TWO WAYS, BECAUSE THEY FAIL DIFFERENTLY ──────────────────
    ok('a journal file records what every row held',
      /fs\.writeFileSync\(jpath/.test(sc) && /engagementSource: t\.src/.test(sc), null);
    ok('  written BEFORE the commit, so there is no window with no record',
      sc.indexOf('fs.writeFileSync(jpath') < sc.indexOf("client.query('COMMIT')"), null);
    ok('  and a breadcrumb on the row, for when the file is gone',
      /'engagementClearedFrom', a\.data->'engagement'/.test(sc), null);
    ok('THERE IS A --revert THAT READS THE JOURNAL BACK',
      /async function revert\(P, file\)/.test(sc) && /if \(REVERT\)/.test(sc), null);
    ok('  restoring the exact prior value, not a re-derived one',
      /jsonb_build_object\('engagement', \$2::text\)/.test(sc), null);
    ok('  AND REFUSING TO CLOBBER A RATE ENTERED SINCE',
      /AND COALESCE\(a\.data->>'engagement', ''\) = ''/.test(sc), null);
    ok('  clearing the breadcrumb as it goes',
      /- 'engagementClearedFrom' - 'engagementClearedAt'/.test(sc), null);
    // The breadcrumb must be inert: if anything READ it, clearing would change
    // behaviour rather than just removing a number.
    const srv = fs.readdirSync(ROOT + 'server/services')
      .filter((f) => f.endsWith('.js'))
      .map((f) => fs.readFileSync(ROOT + 'server/services/' + f, 'utf8')).join('\n');
    ok('  and nothing in the product reads the breadcrumb',
      !/engagementClearedFrom/.test(srv) && !/engagementClearedFrom/.test(idx), null);
  }

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main();
