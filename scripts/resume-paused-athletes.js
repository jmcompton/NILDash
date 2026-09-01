#!/usr/bin/env node
'use strict';
// ── LET THEM BACK IN ────────────────────────────────────────────────────────
//
// Six athletes hit exactly three consecutive_failures on 2026-08-23 within an
// eight-minute window and have produced nothing since. Simultaneity that tight
// is not six thin markets; it is one run failing the same way six times, and the
// commit history says which run:
//
//   2026-08-19  64ea280  the three-night backoff is added
//   2026-08-20  3d4f834  the Scout is rebuilt; the hometown fallback is removed
//   2026-08-24  f1b11aa  "Stop our own rules rejecting good work" -- NIGHTLY_SLOTS
//                        was 1 so only three businesses were evaluated a night;
//                        the deliverable lint rejected 5; the sign-off regex
//                        \bjohn\b did not match "JohnMark" and rejected 2; the
//                        bar demanded a NAMED person and rejected 11, every one
//                        of them reachable.
//
// The sign-off bug is agent-scoped -- it rejects every pitch signed with that
// agent's name -- which is exactly how six athletes on one roster, processed
// back to back in the same fillAgent loop, fail inside eight minutes.
//
// So these athletes were paused by OUR defect, the defect was fixed the next
// day, and nothing has ever cleared paused_at. This clears it.
//
// DRY RUN BY DEFAULT. --apply is required to write. Nothing is deleted, no card
// is created, no money is spent: it clears paused_at, clears paused_reason, and
// resets consecutive_failures so the athlete gets a full three nights again
// rather than re-pausing on the first thin one.
//
//   node scripts/resume-paused-athletes.js                 # show who is stuck
//   node scripts/resume-paused-athletes.js --apply         # resume all of them
//   node scripts/resume-paused-athletes.js --athlete <id> --apply
//   node scripts/resume-paused-athletes.js --agent <id> --apply

const store = require('../server/store');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; };
const APPLY = has('--apply');
const ONE_ATHLETE = val('--athlete');
const ONE_AGENT = val('--agent');
const INIT_WAIT_MS = parseInt(process.env.SCRIPT_INIT_WAIT_MS, 10) || 2500;

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;

  const where = ['s.paused_at IS NOT NULL'];
  const params = [];
  if (ONE_ATHLETE) { params.push(ONE_ATHLETE); where.push(`s.athlete_id = $${params.length}`); }
  if (ONE_AGENT) { params.push(ONE_AGENT); where.push(`a.agent_id = $${params.length}`); }

  const rows = (await P.query(
    `SELECT s.athlete_id, s.consecutive_failures, s.paused_at, s.paused_reason,
            s.last_attempt_date,
            a.data->>'name' AS athlete_name, a.agent_id,
            u.name AS agent_name,
            (SELECT COUNT(*) FROM outreach_queue q
              WHERE q.athlete_id = s.athlete_id AND q.state = 'queued') AS queued_now
       FROM outreach_queue_athlete_state s
       JOIN athletes a ON a.id = s.athlete_id
       LEFT JOIN users u ON u.id = a.agent_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.paused_at, a.data->>'name'`, params)).rows;

  if (!rows.length) {
    console.log('\nNo paused athletes' + (ONE_AGENT || ONE_ATHLETE ? ' matching that filter' : '') + '.\n');
    await P.end();
    return;
  }

  console.log(`\n${rows.length} paused athlete(s)${APPLY ? '' : '   — DRY RUN, nothing will be written'}\n`);
  console.log('  ' + 'ATHLETE'.padEnd(24) + 'AGENT'.padEnd(20) + 'PAUSED'.padEnd(13)
    + 'DAYS'.padEnd(6) + 'FAILS'.padEnd(7) + 'CARDS');
  console.log('  ' + '-'.repeat(78));

  const byDay = {};
  for (const r of rows) {
    const day = r.paused_at ? new Date(r.paused_at).toISOString().slice(0, 10) : '?';
    const days = r.paused_at
      ? Math.floor((Date.now() - new Date(r.paused_at).getTime()) / 86400000) : '?';
    byDay[day] = (byDay[day] || 0) + 1;
    console.log('  ' + String(r.athlete_name || r.athlete_id).slice(0, 22).padEnd(24)
      + String(r.agent_name || r.agent_id || '?').slice(0, 18).padEnd(20)
      + day.padEnd(13) + String(days).padEnd(6)
      + String(r.consecutive_failures).padEnd(7) + String(r.queued_now));
  }

  // ── SIMULTANEITY IS THE TELL ───────────────────────────────────────────────
  // A market going thin is a slow, per-athlete thing. Several athletes tripping
  // a three-night counter on the same day means one run failed the same way for
  // all of them, and the counter recorded our failure as theirs.
  const clustered = Object.entries(byDay).filter(([, n]) => n >= 2);
  if (clustered.length) {
    console.log('\n  Paused on the same day — that pattern is a systemic failure, not a thin market:');
    for (const [day, n] of clustered) console.log(`    ${day}: ${n} athletes`);
  }

  // Precise timing, because "within eight minutes" is the difference between a
  // bad night and six unrelated ones.
  const spread = (await P.query(
    `SELECT s.paused_at::date AS day,
            COUNT(*) AS n,
            MIN(s.paused_at) AS first_at,
            MAX(s.paused_at) AS last_at,
            ROUND(EXTRACT(EPOCH FROM (MAX(s.paused_at) - MIN(s.paused_at)))/60) AS spread_minutes
       FROM outreach_queue_athlete_state s
      WHERE s.paused_at IS NOT NULL
      GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY 1`)).rows;
  for (const s of spread) {
    console.log(`\n  ${s.day.toISOString().slice(0, 10)}: ${s.n} athletes paused within `
      + `${s.spread_minutes} minute(s) of each other.`);
  }

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to clear paused_at for these athletes.');
    console.log('They resume on the next nightly run, or immediately when their agent');
    console.log('next opens the queue (the on-demand fill picks them up).\n');
    await P.end();
    return;
  }

  const r = await P.query(
    `UPDATE outreach_queue_athlete_state s
        SET paused_at = NULL, paused_reason = NULL,
            consecutive_failures = 0,
            released_at = NOW(), release_source = 'script:resume-paused-athletes',
            updated_at = NOW()
       FROM athletes a
      WHERE a.id = s.athlete_id AND ${where.join(' AND ')}
      RETURNING s.athlete_id`, params);

  console.log(`\nResumed ${r.rowCount} athlete(s).`);
  console.log('consecutive_failures reset to 0, so each gets a full three nights');
  console.log('again rather than re-pausing on the first thin one.\n');
  await P.end();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('THREW', e);
  process.exit(1);
});
