#!/usr/bin/env node
'use strict';
// ── HOW MUCH OF THE ENGAGEMENT DATA IS THE 3.0 DEFAULT ──────────────────────
//
//   node scripts/audit-engagement-default.js
//
// READ ONLY. This script has no --apply and writes nothing. It exists to answer
// "how many, and where" before anybody decides what to do about it.
//
// THE DEFECT IT MEASURES. Both the Add Client form and POST /api/athletes read
//   engagement: parseFloat(v) || 3.0
// so a BLANK field stored 3.0, and so did a real 0 (`0 || 3.0` is 3.0). The
// stored value is indistinguishable from a measured one -- igStatsSource reads
// 'manual' either way, and until now nothing dated it.
//
// From there it reached:
//   media kits          analyst.composeKit prints an Engagement row
//   the older pitches   pitchGeneration put it in the prompt AND in fallback copy
//   draft prewarm       "Engagement rate: 3%" in the writer's context
//   deal_comps          saveComp writes it as MARKET DATA, which is what makes
//                       this worth counting: other athletes are benchmarked
//                       against it by getComps / getTopNilComps.
//
// ── WHAT 3.0 CAN AND CANNOT TELL US ─────────────────────────────────────────
//
// 3.0 is a plausible real engagement rate. Some rows will be genuine. There is
// no stored flag separating them, so this reports the population and the
// evidence either way rather than pretending to a certainty it does not have:
//
//   EXACTLY 3.0 and no engagement date   almost certainly the default
//   EXACTLY 3.0 with a date              measured, or re-saved since the fix
//   any other value                      not the default
//
// The comparison rows -- how many distinct values exist, and how 3.0 sits
// against them -- are what make the answer judgeable. If a third of the table is
// exactly 3.0 and nothing else clusters, that is the default. If 3.0 is one
// value among a smooth spread, it is not.

const store = require('../server/store');

const pctOf = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '—');

async function main() {
  const P = store.pool;
  await new Promise((r) => setTimeout(r, 4000));   // let init settle

  console.log('\n══ ATHLETES ══');
  const ath = (await P.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE data->>'engagement' IS NOT NULL
                               AND data->>'engagement' <> '')::int AS with_value,
            COUNT(*) FILTER (WHERE (data->>'engagement')::numeric = 3.0)::int AS exactly_three,
            COUNT(*) FILTER (WHERE (data->>'engagement')::numeric = 3.0
                               AND COALESCE(data->>'engagementAsOf','') = '')::int AS three_undated,
            COUNT(*) FILTER (WHERE COALESCE(data->>'engagementAsOf','') <> '')::int AS dated
       FROM athletes
      WHERE data->>'engagement' ~ '^[0-9.]+$' OR data->>'engagement' IS NULL`)).rows[0];
  console.log(`  ${ath.total} athlete(s), ${ath.with_value} with an engagement value`);
  console.log(`  EXACTLY 3.0:            ${ath.exactly_three}  (${pctOf(ath.exactly_three, ath.with_value)} of those with a value)`);
  console.log(`    of which UNDATED:     ${ath.three_undated}  <- the ones that look like the default`);
  console.log(`  carrying a date at all: ${ath.dated}`);

  const spread = (await P.query(
    `SELECT (data->>'engagement')::numeric AS v, COUNT(*)::int AS n
       FROM athletes
      WHERE data->>'engagement' ~ '^[0-9.]+$'
      GROUP BY 1 ORDER BY n DESC, v LIMIT 12`)).rows;
  console.log('\n  most common values (is 3.0 a spike or part of a spread?)');
  for (const r of spread) console.log(`    ${String(r.v).padStart(6)}  ${r.n}`);

  console.log('\n══ deal_comps ══');
  // saveComp writes one row per closed deal. A comp carrying the default is a
  // fabricated data point OTHER athletes are compared against.
  const dc = (await P.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE engagement IS NOT NULL)::int AS with_value,
            COUNT(*) FILTER (WHERE engagement = 3.0)::int AS exactly_three,
            COUNT(DISTINCT engagement)::int AS distinct_values
       FROM deal_comps`)).rows[0];
  console.log(`  ${dc.total} comp(s), ${dc.with_value} with an engagement value, `
    + `${dc.distinct_values} distinct value(s)`);
  console.log(`  EXACTLY 3.0:            ${dc.exactly_three}  (${pctOf(dc.exactly_three, dc.with_value)} of those with a value)`);

  const bySource = (await P.query(
    `SELECT COALESCE(source,'(none)') AS source, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE engagement = 3.0)::int AS three
       FROM deal_comps GROUP BY 1 ORDER BY n DESC LIMIT 10`)).rows;
  console.log('\n  by source (agent-close rows are the ones saveComp wrote)');
  for (const r of bySource) {
    console.log(`    ${String(r.source).padEnd(16)} ${String(r.n).padStart(5)} rows, `
      + `${String(r.three).padStart(5)} at exactly 3.0`);
  }

  const dcSpread = (await P.query(
    `SELECT engagement AS v, COUNT(*)::int AS n FROM deal_comps
      WHERE engagement IS NOT NULL GROUP BY 1 ORDER BY n DESC, v LIMIT 12`)).rows;
  console.log('\n  most common values');
  for (const r of dcSpread) console.log(`    ${String(r.v).padStart(6)}  ${r.n}`);

  console.log('\n══ WHO READS deal_comps.engagement ══');
  console.log('  store.getComps / getTopNilComps -> the national lane and the');
  console.log('  comps shown to agents. A 3.0 row is a benchmark nobody measured.');
  console.log('\nNothing was changed. This script has no --apply.\n');

  await P.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
