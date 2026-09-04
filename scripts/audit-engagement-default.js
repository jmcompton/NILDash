#!/usr/bin/env node
'use strict';
// ── HOW MUCH OF THE ENGAGEMENT DATA IS THE 3.0 DEFAULT ──────────────────────
//
//   node scripts/audit-engagement-default.js              count only
//   node scripts/audit-engagement-default.js --clear      dry run of the clear
//   node scripts/audit-engagement-default.js --clear --apply
//   node scripts/audit-engagement-default.js --revert <journal.json>
//
// COUNTING IS THE DEFAULT AND IS READ ONLY. Nothing is written without --apply.
//
// ── WHAT THE COUNT SAID, AND WHY --clear EXISTS ─────────────────────────────
//
// 31 athletes at exactly 3.0, every one of them undated. The next most common
// value was 6.2, with 6. That is a spike, not a spread: a real distribution of
// hand-measured rates does not put a third of the roster on one value and leave
// the runner-up at a fifth of that. Those 31 are the `parseFloat(v) || 3.0`
// default, and they were reaching media kits as a measured fact.
//
// deal_comps came back clean -- one row, at 5.5 -- so nothing there is touched.
//
// ── WHAT --clear TOUCHES, AND WHAT IT REFUSES TO ────────────────────────────
//
//   exactly 3.0 AND no engagementAsOf   -> engagement removed
//   exactly 3.0 WITH a date             -> LEFT ALONE. Somebody measured it, or
//                                          re-saved it since the fix. A date is
//                                          the evidence that separates them.
//   any other value                     -> LEFT ALONE, dated or not.
//
// Only the three engagement keys are touched. No other field on the athlete is
// read, written, or reordered.
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

const fs = require('fs');
const path = require('path');
const store = require('../server/store');

const args = process.argv.slice(2);
const CLEAR = args.includes('--clear');
const APPLY = args.includes('--apply');
const REVERT = args.indexOf('--revert') !== -1 ? args[args.indexOf('--revert') + 1] : null;
// A guard against a mis-scoped WHERE, not against the known 31. If the match
// count is wildly off what the count reported, that is a reason to stop and look
// rather than to write.
const MAX = parseInt((args.find((a) => a.startsWith('--max=')) || '').split('=')[1], 10) || 200;

const pctOf = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '—');

// THE ROWS THE CLEAR IS ABOUT, and the only definition of them. Used by the dry
// run, the apply and the count so the three cannot describe different sets.
//
// The ~ guard matters: (data->>'engagement')::numeric throws on a non-numeric
// value, and one junk row would take the whole statement down.
const TARGET_SQL = `
  FROM athletes a
  LEFT JOIN users u ON u.id = a.agent_id
 WHERE a.data->>'engagement' ~ '^[0-9]+(\\.[0-9]+)?$'
   AND (a.data->>'engagement')::numeric = 3.0
   AND COALESCE(a.data->>'engagementAsOf', '') = ''`;

async function main() {
  const P = store.pool;
  await new Promise((r) => setTimeout(r, 4000));   // let init settle

  if (REVERT) { await revert(P, REVERT); return; }

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

  if (!CLEAR) {
    console.log('\nNothing was changed. Add --clear to see what a clear would touch.\n');
    await P.end();
    return;
  }

  // ── THE CLEAR ─────────────────────────────────────────────────────────────
  console.log('\n══ CLEAR: exactly 3.0 AND undated ══');
  const targets = (await P.query(
    `SELECT a.id, a.agent_id, a.data->>'name' AS name, a.data->>'school' AS school,
            a.data->>'engagement' AS engagement,
            a.data->>'engagementSource' AS src,
            u.name AS agent_name, u.email AS agent_email
     ${TARGET_SQL}
     ORDER BY u.email NULLS LAST, a.data->>'name'`)).rows;

  if (!targets.length) {
    console.log('  nothing matches. Either it has been run already, or these rows are dated.\n');
    await P.end();
    return;
  }

  let lastAgent = null;
  for (const t of targets) {
    const agent = t.agent_email || t.agent_name || t.agent_id || '(no agent row)';
    if (agent !== lastAgent) { console.log(`\n  ${agent}`); lastAgent = agent; }
    console.log(`    ${String(t.name || t.id).padEnd(28)} ${t.engagement}%`
      + `  ${t.school || '(no school)'}`);
  }
  console.log(`\n  ${targets.length} athlete(s) across `
    + `${new Set(targets.map((t) => t.agent_id)).size} agent(s)`);

  // WHAT IS DELIBERATELY NOT IN THAT LIST, said out loud so the scope is
  // visible rather than trusted.
  const spared = (await P.query(
    `SELECT COUNT(*) FILTER (WHERE (a.data->>'engagement')::numeric = 3.0
                               AND COALESCE(a.data->>'engagementAsOf','') <> '')::int AS dated_three,
            COUNT(*) FILTER (WHERE (a.data->>'engagement')::numeric <> 3.0)::int AS other_values
       FROM athletes a
      WHERE a.data->>'engagement' ~ '^[0-9]+(\\.[0-9]+)?$'`)).rows[0];
  console.log(`  LEFT ALONE: ${spared.dated_three} row(s) at 3.0 that carry a date, `
    + `${spared.other_values} row(s) at any other value`);

  if (targets.length > MAX) {
    console.error(`\n  REFUSING: ${targets.length} matches exceeds the ${MAX} ceiling. `
      + 'That is more than a mis-scoped query should ever be allowed to write. '
      + 'Re-run with --max=<n> once the list above looks right.\n');
    await P.end();
    process.exit(1);
  }

  if (!APPLY) {
    console.log('\n  DRY RUN. Nothing written. Re-run with --apply.\n');
    await P.end();
    return;
  }

  // ── REVERSIBLE, TWO WAYS ──────────────────────────────────────────────────
  //
  // A JOURNAL FILE, which --revert reads back, and a BREADCRUMB on the row
  // itself. Both, because they fail differently: a file can be lost with the
  // machine it was written on, and a breadcrumb cannot be diffed or kept
  // outside the database. engagementClearedFrom is read by nothing, so it
  // changes no behaviour -- it is there so this is undoable from the database
  // alone if the file is gone.
  const stamp = new Date().toISOString();
  const journal = {
    clearedAt: stamp,
    rule: 'engagement exactly 3.0 AND no engagementAsOf',
    rows: targets.map((t) => ({
      athleteId: t.id, agentId: t.agent_id, name: t.name,
      engagement: t.engagement, engagementSource: t.src || null,
    })),
  };
  const jpath = path.join(process.cwd(),
    `engagement-clear-${stamp.replace(/[:.]/g, '-')}.json`);

  const client = await P.connect();
  let n = 0;
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE athletes a
          SET data = (a.data - 'engagement' - 'engagementSource' - 'engagementAsOf')
                     || jsonb_build_object(
                          'engagementClearedFrom', a.data->'engagement',
                          'engagementClearedAt', to_jsonb($2::text)),
              updated_at = NOW()
        WHERE a.id = ANY($1::text[])`,
      [targets.map((t) => t.id), stamp]);
    n = r.rowCount;
    // The journal is written INSIDE the transaction's lifetime and the commit
    // only happens once it is on disk, so there is no window where rows are
    // cleared and nothing records what they held.
    fs.writeFileSync(jpath, JSON.stringify(journal, null, 2) + '\n');
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('\nROLLED BACK, nothing changed: ' + e.message + '\n');
    await P.end();
    process.exit(1);
  }
  client.release();

  console.log(`\n  Cleared ${n} athlete(s).`);
  console.log(`  Journal: ${jpath}`);
  console.log(`  Undo:    node scripts/audit-engagement-default.js --revert ${jpath}`);
  console.log('  The rows also carry engagementClearedFrom, so this is undoable');
  console.log('  from the database alone if that file is lost.\n');
  await P.end();
}

// ── PUTTING THEM BACK ───────────────────────────────────────────────────────
// Restores exactly the value each row held, and only for rows that still look
// cleared. An athlete whose rate has been re-entered since is left alone: their
// new number is better than the one we removed.
async function revert(P, file) {
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = (journal && journal.rows) || [];
  console.log(`\n══ REVERT from ${path.basename(file)} ══`);
  console.log(`  ${rows.length} row(s) recorded, cleared at ${journal.clearedAt}`);

  const client = await P.connect();
  let restored = 0, skipped = 0;
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const res = await client.query(
        `UPDATE athletes a
            SET data = (a.data - 'engagementClearedFrom' - 'engagementClearedAt')
                       || jsonb_build_object('engagement', $2::text)
                       || CASE WHEN $3::text IS NULL THEN '{}'::jsonb
                               ELSE jsonb_build_object('engagementSource', $3::text) END,
                updated_at = NOW()
          WHERE a.id = $1
            AND COALESCE(a.data->>'engagement', '') = ''`,
        [r.athleteId, r.engagement, r.engagementSource]);
      if (res.rowCount) restored++; else skipped++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('  ROLLED BACK, nothing changed: ' + e.message + '\n');
    await P.end();
    process.exit(1);
  }
  client.release();
  console.log(`  Restored ${restored}. Skipped ${skipped} that already carry a rate again.\n`);
  await P.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
