'use strict';
// ── HOW MANY CANDIDATES DOES IT TAKE TO REACH FIVE ─────────────────────────
//
// The nightly fill runs until an athlete holds five cards or a ceiling stops
// it (jobs/outreachQueue, the loop). Every athlete's night is on the run row
// (outreach_queue_runs.details[].loop). This reads the last N nights and says:
//
//   - candidates it took to reach five: median, p75, p90, max (the number that
//     sizes the pool and the budget), and over all athletes that reached it
//   - athletes that stopped short, with the count, what stopped them and the
//     rungs tried
//   - candidates and pass rate by lane, and how often each rung fired
//   - what stopped each night: the floor, time, cost, ladder, the agent's cap
//
//   node scripts/floor-report.js              the last 7 nights
//   node scripts/floor-report.js --days 1     last night only
//   /api/admin/scripts/floor-report?text=1&days=1
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarise(rows) {
  const nights = [];
  for (const r of rows) {
    for (const d of (Array.isArray(r.details) ? r.details : [])) {
      if (!d || !d.loop) continue;
      nights.push({ date: String(r.run_date).slice(0, 10), agent: r.agent_name || r.agent_id, athlete: d.athleteName || d.athleteId, ...d.loop });
    }
  }
  const reached = nights.filter((n) => n.candidatesToFloor != null).map((n) => n.candidatesToFloor).sort((a, b) => a - b);
  const short = nights.filter((n) => n.held < n.floor);
  const byLane = {}, rungs = {}, stops = {};
  for (const n of nights) {
    for (const [k, v] of Object.entries(n.byLane || {})) {
      byLane[k] = byLane[k] || { tried: 0, passed: 0 };
      byLane[k].tried += v.tried || 0; byLane[k].passed += v.passed || 0;
    }
    for (const g of (n.rungs || [])) rungs[g] = (rungs[g] || 0) + 1;
    stops[n.stop || 'none'] = (stops[n.stop || 'none'] || 0) + 1;
  }
  const allCands = nights.map((n) => n.candidates || 0);
  return {
    nights, reached, short, byLane, rungs, stops,
    toFloor: { n: reached.length, median: pct(reached, 50), p75: pct(reached, 75), p90: pct(reached, 90), max: reached[reached.length - 1] || null },
    candidatesTotal: allCands.reduce((a, b) => a + b, 0),
    costTotal: Math.round(nights.reduce((a, n) => a + (n.costUsd || 0), 0) * 100) / 100,
  };
}

function format(s, days) {
  const L = [];
  L.push(`THE FLOOR OF FIVE   last ${days} night(s), ${s.nights.length} athlete-night(s) run by the loop`);
  if (!s.nights.length) { L.push('  no athlete-night carries loop metrics yet (the loop records them from its first night)'); return L.join('\n'); }
  const t = s.toFloor;
  L.push(`  reached five: ${t.n} of ${s.nights.length} (${Math.round((100 * t.n) / s.nights.length)}%)`);
  L.push(`  CANDIDATES TO REACH FIVE: median ${t.median ?? '-'}, p75 ${t.p75 ?? '-'}, p90 ${t.p90 ?? '-'}, max ${t.max ?? '-'}`);
  L.push(`  ${s.candidatesTotal} candidate(s) tried in all, $${s.costTotal.toFixed(2)} on athletes`);
  L.push('', '  stopped by: ' + Object.entries(s.stops).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));
  L.push('  rungs fired: ' + Object.entries(s.rungs).map(([k, n]) => `${k} ${n}`).join(', '));
  L.push('', '  BY LANE          tried  passed  pass rate');
  for (const [k, v] of Object.entries(s.byLane).sort((a, b) => b[1].tried - a[1].tried)) {
    L.push(`  ${k.padEnd(16)} ${String(v.tried).padStart(5)}  ${String(v.passed).padStart(6)}  ${v.tried ? Math.round((100 * v.passed) / v.tried) + '%' : '-'}`);
  }
  if (s.short.length) {
    L.push('', `  SHORT OF FIVE: ${s.short.length} athlete-night(s)`);
    for (const n of s.short) {
      L.push(`    ${n.date}  ${n.athlete} (${n.agent}): ${n.held} of ${n.floor} after ${n.candidates} candidate(s), `
        + `${Math.round((n.elapsedMs || 0) / 1000)}s, $${(n.costUsd || 0).toFixed(2)}; stopped by ${n.stop}; rungs ${(n.rungs || []).join(' > ')}`);
    }
  }
  L.push('', '  EVERY ATHLETE-NIGHT');
  for (const n of s.nights) {
    L.push(`    ${n.date}  ${String(n.athlete).padEnd(24)} ${n.held}/${n.floor}  ${String(n.candidates).padStart(3)} cand  `
      + `to-five ${n.candidatesToFloor ?? '-'}  ${n.stop}  ${(n.rungs || []).join('>')}`);
  }
  return L.join('\n');
}

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const i = process.argv.indexOf('--days');
  const days = Math.max(1, parseInt(i >= 0 ? process.argv[i + 1] : '7', 10) || 7);
  const rows = (await store.pool.query(
    `SELECT r.run_date, r.agent_id, u.name AS agent_name, r.details FROM outreach_queue_runs r LEFT JOIN users u ON u.id = r.agent_id
      WHERE r.run_date >= CURRENT_DATE - $1::int ORDER BY r.run_date DESC`, [days - 1])).rows;
  console.log(format(summarise(rows), days));
}

if (require.main === module) {
  main().catch((e) => { console.error('floor-report failed:', e && e.stack || e); process.exitCode = 1; })
    .finally(async () => { try { await store.pool.end(); } catch (_) {} });
}
module.exports = { summarise, format, pct };
