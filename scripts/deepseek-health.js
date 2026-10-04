'use strict';
// ── IS DEEPSEEK ANSWERING, AND WITH WHAT? ───────────────────────────────────
// 2026-10-04: the lookup's answer came back as tool-call markup
// ("<|DSML|>invoke ...") instead of JSON. Read-only; answers from the database:
//   1. WHICH MODEL SERVED: every DeepSeek response names the model that
//      answered it (ai_call_ledger.model), by day, with output tokens. A
//      floating alias that moved shows up as a new name on a new day.
//   2. UNREADABLE ANSWERS: service_faults recorded as "UNREADABLE ANSWER" or
//      tool-call markup, by day and by where (lookup, discovery, contacts).
//   3. PAYMENT / KEY / QUOTA failures for DeepSeek, by day.
//   4. LAST NIGHT: DeepSeek calls by site in the nightly window (1-5am
//      Central), so "did the night hit it" is a count.
//   /api/admin/scripts/deepseek-health?text=1
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const DS = require(ROOT + 'server/services/deepseek.js');
  const L = [`DEEPSEEK HEALTH   asking for model: ${DS.model()}${process.env.DEEPSEEK_MODEL ? ' (DEEPSEEK_MODEL)' : ' (the default alias; pin with DEEPSEEK_MODEL)'}   routing: ${DS.describeRouting ? DS.describeRouting() : ''}`, ''];
  const q = async (sql, p) => { try { return (await P.query(sql, p || [])).rows; } catch (e) { L.push('  (read failed: ' + e.message + ')'); return []; } };

  L.push('1. MODEL THAT SERVED, by day (Central), last 7 days');
  for (const r of await q(`SELECT (at AT TIME ZONE 'America/Chicago')::date::text AS day, model, COUNT(*)::int AS calls, SUM(output_tokens)::int AS out
      FROM ai_call_ledger WHERE at > NOW() - INTERVAL '7 days' AND provider = 'deepseek'
     GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC`)) L.push(`   ${r.day}  ${String(r.model).padEnd(34)} ${String(r.calls).padStart(6)} call(s)  ${String(r.out || 0).padStart(9)} output tokens`);

  L.push('', '2. UNREADABLE ANSWERS (tool-call markup / not JSON), by day and where');
  const un = await q(`SELECT (at AT TIME ZONE 'America/Chicago')::date::text AS day, COALESCE(context, '?') AS where_, SUM(1 + COALESCE(suppressed, 0))::int AS n,
      (ARRAY_AGG(reason ORDER BY at DESC))[1] AS reason
      FROM service_faults WHERE at > NOW() - INTERVAL '7 days' AND (reason ILIKE '%UNREADABLE%' OR reason ILIKE '%tool-call markup%' OR reason ILIKE '%DSML%')
     GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC`);
  if (!un.length) L.push('   none recorded (recording started with this deploy; earlier nights are not in here)');
  for (const r of un) L.push(`   ${r.day}  ${String(r.where_).padEnd(28)} ${String(r.n).padStart(5)}x  ${String(r.reason).slice(0, 140)}`);

  L.push('', '3. PAYMENT / KEY / QUOTA failures from DeepSeek, by day');
  const bill = await q(`SELECT (at AT TIME ZONE 'America/Chicago')::date::text AS day, kind, SUM(1 + COALESCE(suppressed, 0))::int AS n, MAX(at) AS last
      FROM service_faults WHERE service = 'deepseek' AND kind IS NOT NULL AND at > NOW() - INTERVAL '7 days' GROUP BY 1, 2 ORDER BY 1 DESC`);
  if (!bill.length) L.push('   none recorded');
  for (const r of bill) L.push(`   ${r.day}  ${String(r.kind).padEnd(8)} ${String(r.n).padStart(5)}x  last ${new Date(r.last).toISOString().slice(11, 16)} UTC`);

  L.push('', '4. LAST NIGHT (1-5am Central): DeepSeek calls by site, and what the run placed');
  const night = await q(`SELECT site, COUNT(*)::int AS calls, SUM(output_tokens)::int AS out FROM ai_call_ledger
      WHERE provider = 'deepseek' AND (at AT TIME ZONE 'America/Chicago') >= date_trunc('day', NOW() AT TIME ZONE 'America/Chicago') + INTERVAL '1 hour'
        AND (at AT TIME ZONE 'America/Chicago') < date_trunc('day', NOW() AT TIME ZONE 'America/Chicago') + INTERVAL '5 hours'
     GROUP BY 1 ORDER BY 2 DESC`);
  if (!night.length) L.push('   no DeepSeek calls in last night\'s window');
  for (const r of night) L.push(`   ${String(r.site).padEnd(30)} ${String(r.calls).padStart(5)} call(s)  ${String(r.out || 0).padStart(8)} output tokens`);
  const runs = await q(`SELECT COUNT(*)::int AS agents, COALESCE(SUM(filled), 0)::int AS cards FROM outreach_queue_runs
      WHERE run_date = (NOW() AT TIME ZONE 'America/Chicago')::date AND COALESCE(note, '') NOT LIKE 'skipped:%'`);
  if (runs[0]) L.push(`   the night placed ${runs[0].cards} card(s) across ${runs[0].agents} agent run(s)`);
  console.log(L.join('\n'));
  try { await P.end(); } catch (_) {}
  process.exit(0);
}
if (require.main === module) main().catch((e) => { console.error('deepseek-health: FAILED', e.message); process.exit(1); });
