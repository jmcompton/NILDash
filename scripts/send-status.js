'use strict';
// ── HAVE APPROVED EMAILS ACTUALLY BEEN LEAVING? ─────────────────────────────
//
// Approving an email schedules it. It leaves only when the release scheduler
// sends it (jobs/closerRelease), and that scheduler starts only when the
// server's environment has CLOSER_RELEASE_ENABLED=1. If it is off, every
// approval sits at status 'approved' forever and nothing tells the agent.
//
// Run through the admin script runner, this process inherits the RUNNING
// SERVER's environment, so the flag it prints is the one production is using.
// Read-only.
//
//   node scripts/send-status.js
//   /api/admin/scripts/send-status?text=1
//
// HOW A SEND IS TOLD APART. The release job keeps approved_at when it sends
// (services/closer); a manual Send from the Outreach tab never sets it
// (routes/outreach). So sent_at with approved_at is an approved email that
// the scheduler released, and sent_at without it is a hand-sent one.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

const d = (v) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'never');

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const flag = process.env.CLOSER_RELEASE_ENABLED;
  const on = flag === '1';
  console.log('SEND STATUS  ' + new Date().toISOString());
  console.log(`CLOSER_RELEASE_ENABLED = ${flag === undefined ? '(not set)' : JSON.stringify(flag)}  ->  release scheduler ${on ? 'ON' : 'OFF'}`);
  // THE SECOND SWITCH. With the scheduler on, every tick still refuses to send
  // when the CAN-SPAM postal address is missing (jobs/closerRelease).
  const spam = require(ROOT + 'server/services/canSpam.js').problem();
  console.log(`CAN-SPAM postal address  ->  ${spam ? 'MISSING: every release is refused' : 'set'}\n`);

  const t = (await P.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'approved' AND sent_at IS NULL)::int                        AS waiting,
      COUNT(*) FILTER (WHERE status = 'approved' AND sent_at IS NULL
                         AND scheduled_send_at < NOW() - INTERVAL '1 hour')::int                  AS overdue,
      MIN(approved_at) FILTER (WHERE status = 'approved' AND sent_at IS NULL)                     AS oldest_waiting,
      COUNT(*) FILTER (WHERE approved_at IS NOT NULL AND sent_at IS NOT NULL)::int                AS released,
      COUNT(*) FILTER (WHERE approved_at IS NOT NULL AND sent_at > NOW() - INTERVAL '14 days')::int AS released_14d,
      MAX(sent_at) FILTER (WHERE approved_at IS NOT NULL)                                         AS last_released,
      COUNT(*) FILTER (WHERE approved_at IS NULL AND sent_at IS NOT NULL)::int                    AS manual,
      MAX(sent_at) FILTER (WHERE approved_at IS NULL)                                             AS last_manual,
      COUNT(*) FILTER (WHERE approved_at IS NOT NULL)::int                                        AS ever_approved
    FROM outreach_logs`)).rows[0];

  // ── THE ANSWER ──────────────────────────────────────────────────────────
  let verdict;
  if (on && spam) {
    verdict = `NO. The scheduler is ON but the CAN-SPAM postal address is missing, so every tick refuses to send. `
      + `${t.waiting} approved email(s) are waiting` + (t.waiting ? `, the oldest approved ${d(t.oldest_waiting)}` : '') + `. ${spam}`;
  } else if (!on) {
    verdict = `NO. The release scheduler is OFF in this server, so an approved email is never sent. `
      + `${t.waiting} approved email(s) are waiting` + (t.waiting ? `, the oldest approved ${d(t.oldest_waiting)}` : '') + '. '
      + (t.released ? `${t.released} approved email(s) did leave at some point, the last ${d(t.last_released)}: the flag was on then, or they were sent another way after approval.`
        : 'No approved email has ever been sent.');
  } else if (t.released_14d > 0) {
    verdict = `YES. The scheduler is ON and released ${t.released_14d} approved email(s) in the last 14 days, the last ${d(t.last_released)}.`
      + (t.overdue ? ` But ${t.overdue} are more than an hour past their send time: see the per-agent table.` : '');
  } else if (t.overdue > 0) {
    verdict = `ON BUT STUCK. The scheduler is ON, ${t.overdue} approved email(s) are more than an hour past their send time, `
      + `and none has been released in 14 days. Look for "[closer]" lines in the server log (no mailbox, a stopped agent, the CAN-SPAM block).`;
  } else {
    verdict = `ON, NOTHING DUE. The scheduler is ON; nothing approved is past its send time. Released in the last 14 days: ${t.released_14d}.`;
  }
  console.log('Have approved emails been leaving?\n  ' + verdict + '\n');

  console.log('ALL AGENTS');
  console.log(`  approved, waiting to send     ${t.waiting}   (past their send time by over an hour: ${t.overdue})`);
  console.log(`  approved and released         ${t.released}   (last 14 days: ${t.released_14d}; last ${d(t.last_released)})`);
  console.log(`  sent by hand, never approved  ${t.manual}   (last ${d(t.last_manual)})`);
  console.log(`  ever approved                 ${t.ever_approved}\n`);

  const rows = (await P.query(`
    SELECT u.email,
      COUNT(*) FILTER (WHERE l.status = 'approved' AND l.sent_at IS NULL)::int AS waiting,
      COUNT(*) FILTER (WHERE l.status = 'approved' AND l.sent_at IS NULL AND l.scheduled_send_at < NOW() - INTERVAL '1 hour')::int AS overdue,
      COUNT(*) FILTER (WHERE l.approved_at IS NOT NULL AND l.sent_at IS NOT NULL)::int AS released,
      COUNT(*) FILTER (WHERE l.approved_at IS NULL AND l.sent_at IS NOT NULL)::int AS manual,
      MAX(l.sent_at) AS last_sent
    FROM outreach_logs l JOIN users u ON u.id = l.agent_id
    GROUP BY u.email
    HAVING COUNT(*) FILTER (WHERE l.approved_at IS NOT NULL OR l.sent_at IS NOT NULL) > 0
    ORDER BY 2 DESC, 4 DESC`)).rows;
  console.log('PER AGENT (only agents who have approved or sent something)');
  if (!rows.length) console.log('  (none)');
  else {
    console.log('  ' + 'agent'.padEnd(38) + 'waiting  overdue  released  by hand  last sent');
    for (const r of rows) {
      console.log('  ' + String(r.email).slice(0, 36).padEnd(38) + String(r.waiting).padStart(7) + String(r.overdue).padStart(9)
        + String(r.released).padStart(10) + String(r.manual).padStart(9) + '  ' + d(r.last_sent));
    }
  }
  try { await P.end(); } catch (_) {}
  process.exit(0);
}
main().catch((e) => { console.error('send-status: FAILED', e); process.exit(1); });
