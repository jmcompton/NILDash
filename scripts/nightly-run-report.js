#!/usr/bin/env node
'use strict';
// ── WHAT LAST NIGHT ACTUALLY DID, ATHLETE BY ATHLETE ────────────────────────
//
//   node scripts/nightly-run-report.js --agent someone@example.com
//   node scripts/nightly-run-report.js --agent someone@example.com --nights 4
//
// For each of the last N nightly runs: how many athletes were tried, how many
// cards were written, THE KEEP RATE (cards approved versus skipped, per night
// and per athlete: services/keepRate), and for every athlete who got nothing,
// the reason the run recorded. "0 tried" on twenty-eight athletes is the question this
// answers; it was previously only recoverable from the process log, which is
// gone by morning.
//
// Read only. Run it on the machine with the database (Railway), or through
// the admin script runner.

const store = require('../server/store');
const KR = require('../server/services/keepRate');
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

  // ── THE KEEP RATE ───────────────────────────────────────────────────────
  // The definition of done: of the cards placed, how many did the agent keep
  // (approve or mark sent) rather than skip. Expired and waiting cards are
  // shown and left out of the rate. Over enough days to cover the nights asked
  // for, plus the time an agent takes to get to a card.
  const keep = KR.summarise(await KR.keepRateRows(pool, u.id, { days: nights + 2 }).catch((e) => {
    console.log('  (keep rate could not be read: ' + e.message + ')'); return [];
  }));
  const keepByNight = new Map(keep.map((k) => [k.night, k]));
  console.log('KEEP RATE (nightly-run cards; kept = approved or marked sent)');
  if (!keep.length) console.log('  no cards placed in this window.');
  else {
    console.log('  night        placed  kept  skipped  expired  waiting  keep rate');
    const all = { placed: 0, kept: 0, skipped: 0, expired: 0, waiting: 0 };
    for (const k of keep) {
      const t = k.nightly;
      for (const f of Object.keys(all)) all[f] += t[f];
      console.log(`  ${k.night}  ${String(t.placed).padStart(6)}  ${String(t.kept).padStart(4)}  ${String(t.skipped).padStart(7)}`
        + `  ${String(t.expired).padStart(7)}  ${String(t.waiting).padStart(7)}  ${KR.pct(t.rate).padStart(9)}`
        + (k.onDemand.placed ? `   + ${k.onDemand.placed} on-demand (keep ${KR.pct(k.onDemand.rate)})` : ''));
    }
    console.log(`  ${'window'.padEnd(10)}  ${String(all.placed).padStart(6)}  ${String(all.kept).padStart(4)}  ${String(all.skipped).padStart(7)}`
      + `  ${String(all.expired).padStart(7)}  ${String(all.waiting).padStart(7)}  ${KR.pct(KR.rate(all.kept, all.skipped)).padStart(9)}`);
  }
  console.log('');

  for (const run of runs) {
    const details = Array.isArray(run.details) ? run.details : [];
    const tried = details.filter((d) => d && (Number(d.tried) > 0 || Number(d.filled) > 0)).length;
    const cards = details.reduce((s, d) => s + (Number(d && d.filled) || 0), 0);
    console.log('='.repeat(78));
    console.log(`NIGHT ${String(run.run_date).slice(0, 10)}   athletes tried ${tried} of ${roster.length}   cards written ${cards}`
      + `${run.filled != null && Number(run.filled) !== cards ? `   (run row says ${run.filled})` : ''}`
      + `${run.finished_at ? '' : '   [UNFINISHED]'}`);
    if (run.note) console.log(`  note: ${short(run.note, 300)}`);
    // This night's keep rate, athlete by athlete.
    // node-pg hands a DATE back as local midnight: read its local parts, since
    // toISOString would move it a day anywhere west of UTC.
    const rd = run.run_date instanceof Date
      ? `${run.run_date.getFullYear()}-${String(run.run_date.getMonth() + 1).padStart(2, '0')}-${String(run.run_date.getDate()).padStart(2, '0')}`
      : String(run.run_date).slice(0, 10);
    const kn = keepByNight.get(rd);
    if (kn && kn.nightly.placed) {
      console.log(`  keep: ${KR.line(kn.nightly)}`);
      for (const a of kn.athletes.sort((x, y) => y.placed - x.placed)) {
        console.log(`    ${short(a.name, 28).padEnd(28)} ${KR.line(a)}`);
      }
    }
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
