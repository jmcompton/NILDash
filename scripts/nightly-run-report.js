#!/usr/bin/env node
'use strict';
// ── WHAT LAST NIGHT ACTUALLY DID, ATHLETE BY ATHLETE ────────────────────────
//
//   node scripts/nightly-run-report.js --agent someone@example.com
//   node scripts/nightly-run-report.js --agent someone@example.com --nights 4
//
// For each of the last N nightly runs: how many athletes were tried, how many
// cards were written, and for every athlete who got nothing, the reason the
// run recorded. "0 tried" on twenty-eight athletes is the question this
// answers; it was previously only recoverable from the process log, which is
// gone by morning.
//
// Read only. Run it on the machine with the database (Railway), or through
// the admin script runner.

const store = require('../server/store');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 3000;
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

function short(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > (n || 120) ? t.slice(0, (n || 120) - 1) + '…' : t;
}

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const pool = store.pool;
  const email = String(arg('agent', '')).trim().toLowerCase();
  const nights = Math.max(1, Math.min(30, parseInt(arg('nights', '4'), 10) || 4));
  if (!email) { console.log('Usage: --agent someone@example.com [--nights 4]'); process.exit(1); }

  const u = (await pool.query(`SELECT id, name, email FROM users WHERE LOWER(email) = $1`, [email])).rows[0];
  if (!u) { console.log(`No agent with the email ${email}`); process.exit(1); }
  const roster = (await pool.query(
    `SELECT id, data->>'name' AS name, data->>'sport' AS sport, data->>'school' AS school,
            data->>'athleteType' AS type, data->>'city' AS city
       FROM athletes WHERE agent_id = $1 ORDER BY created_at ASC`, [u.id])).rows;
  console.log(`\n${u.name || u.email} <${u.email}>  —  ${roster.length} athletes on the roster\n`);

  const runs = (await pool.query(
    `SELECT run_date, filled, note, details, created_at, finished_at
       FROM outreach_queue_runs WHERE agent_id = $1
      ORDER BY run_date DESC LIMIT $2`, [u.id, nights])).rows;
  if (!runs.length) { console.log('No nightly runs recorded for this agent.'); }

  for (const run of runs) {
    const details = Array.isArray(run.details) ? run.details : [];
    const tried = details.filter((d) => d && (Number(d.tried) > 0 || Number(d.filled) > 0)).length;
    const cards = details.reduce((s, d) => s + (Number(d && d.filled) || 0), 0);
    console.log('='.repeat(78));
    console.log(`NIGHT ${String(run.run_date).slice(0, 10)}   athletes tried ${tried} of ${roster.length}   cards written ${cards}`
      + `${run.filled != null && Number(run.filled) !== cards ? `   (run row says ${run.filled})` : ''}`
      + `${run.finished_at ? '' : '   [UNFINISHED]'}`);
    if (run.note) console.log(`  note: ${short(run.note, 300)}`);
    const byId = new Map(details.filter((d) => d && d.athleteId).map((d) => [d.athleteId, d]));
    const untried = [];
    for (const a of roster) {
      const d = byId.get(a.id);
      const filled = Number(d && d.filled) || 0;
      const t = Number(d && d.tried) || 0;
      if (filled > 0) continue;
      untried.push({
        name: a.name || a.id, tried: t,
        // The run records its own reason per athlete; when it recorded none,
        // say that rather than inventing one.
        why: (d && (d.note || d.reason || d.emptyText || d.skip)) || (d ? 'nothing recorded for this athlete' : 'this athlete is not in the run at all'),
      });
    }
    if (!untried.length) { console.log('  every athlete got at least one card.'); continue; }
    console.log(`  ${untried.length} athlete(s) got no card:`);
    // Grouped by reason, because twenty-eight identical lines is not a report.
    const byWhy = new Map();
    for (const x of untried) {
      const k = short(x.why, 160);
      if (!byWhy.has(k)) byWhy.set(k, []);
      byWhy.get(k).push(`${x.name}${x.tried ? ` (tried ${x.tried})` : ' (0 tried)'}`);
    }
    for (const [why, who] of [...byWhy.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    ${who.length} × ${why}`);
      console.log(`        ${who.slice(0, 8).join(', ')}${who.length > 8 ? `, and ${who.length - 8} more` : ''}`);
    }
  }

  // ── THE WRITER, THE SAME NIGHTS ────────────────────────────────────────
  console.log('\n' + '='.repeat(78));
  console.log('WRITER REFUSALS on those nights (why a draft was thrown away)');
  const refusals = (await pool.query(
    `SELECT DATE(created_at) AS night, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE outcome = 'rejected')::int AS rejected
       FROM outreach_queue_attempts
      WHERE agent_id = $1 AND created_at > NOW() - ($2 || ' days')::interval
      GROUP BY 1 ORDER BY 1 DESC`, [u.id, String(nights + 1)]).catch(() => ({ rows: [] })));
  if (!refusals.rows || !refusals.rows.length) {
    console.log('  no per-attempt rows for this window (the table may not be recorded on this deploy).');
  } else {
    for (const r of refusals.rows) console.log(`  ${String(r.night).slice(0, 10)}  attempts ${r.n}, rejected ${r.rejected}`);
  }
  console.log('');
  try { await pool.end(); } catch (_) {}
  process.exit(0);
}
main().catch((e) => { console.error('nightly-run-report: FAILED', e.message); process.exit(1); });
