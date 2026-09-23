'use strict';
// ── ARE APPROVED EMAILS LEAVING? ────────────────────────────────────────────
//
// Approve means send: the release queue (jobs/closerRelease) runs whenever the
// server runs, with no switch and no send window, and sends each agent's
// approved emails one at a time, 20 to 50 seconds apart. This reports whether
// that is happening: what is sending now, what is held and why, and what went
// out in the last hour and day.
//
// Run through the admin script runner, this process inherits the RUNNING
// SERVER's environment, so the CAN-SPAM line is production's. Read-only.
//
//   node scripts/send-status.js
//   /api/admin/scripts/send-status?text=1
//
// HOW A SEND IS TOLD APART. The release queue keeps approved_at when it sends
// (services/closer); a manual Send from the Outreach tab never sets it
// (routes/outreach). So sent_at with approved_at went out through approval,
// and sent_at without it was sent by hand.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

const d = (v) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'never');

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  console.log('SEND STATUS  ' + new Date().toISOString());
  // The one thing that still stops every send, because the law requires it.
  // When it is missing, every waiting email carries it as its hold reason.
  const spam = require(ROOT + 'server/services/canSpam.js').problem();
  console.log(`CAN-SPAM postal address  ->  ${spam ? 'MISSING: nothing can send until it is set' : 'set'}\n`);

  const t = (await P.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'approved' AND sent_at IS NULL AND cadence_stopped_at IS NULL)::int AS approved_unsent,
      COUNT(*) FILTER (WHERE status = 'approved' AND sent_at IS NULL AND cadence_stopped_at IS NULL
                         AND send_hold_reason IS NULL)::int                                                AS sending,
      COUNT(*) FILTER (WHERE status = 'approved' AND sent_at IS NULL AND cadence_stopped_at IS NULL
                         AND send_hold_reason IS NOT NULL)::int                                            AS held,
      MIN(approved_at) FILTER (WHERE status = 'approved' AND sent_at IS NULL AND cadence_stopped_at IS NULL
                         AND send_hold_reason IS NULL)                                                     AS oldest_sending,
      COUNT(*) FILTER (WHERE approved_at IS NOT NULL AND sent_at > NOW() - INTERVAL '1 hour')::int        AS sent_hour,
      COUNT(*) FILTER (WHERE approved_at IS NOT NULL AND sent_at > NOW() - INTERVAL '24 hours')::int      AS sent_day,
      MAX(sent_at) FILTER (WHERE approved_at IS NOT NULL)                                                  AS last_sent,
      COUNT(*) FILTER (WHERE approved_at IS NULL AND sent_at IS NOT NULL)::int                             AS by_hand
    FROM outreach_logs`)).rows[0];

  // ── THE ANSWER ──────────────────────────────────────────────────────────
  // "Stuck" means something approved and not held has waited far longer than
  // the queue's pace explains. Ten minutes covers a bulk approve's first rows.
  const stuckMs = t.oldest_sending ? Date.now() - new Date(t.oldest_sending).getTime() : 0;
  let verdict;
  if (spam) {
    verdict = `NO. The CAN-SPAM postal address is missing, so nothing can send; `
      + `${t.approved_unsent} approved email(s) are held and say so on their cards. ${spam}`;
  } else if (t.sending && stuckMs > 30 * 60 * 1000 && !t.sent_hour) {
    verdict = `STUCK. ${t.sending} approved email(s) are waiting with no hold reason, the oldest approved ${d(t.oldest_sending)}, `
      + `and nothing has been sent in the last hour. Look for "[closer]" lines in the server log; the release queue should log "release queue started" at boot.`;
  } else if (t.sending) {
    verdict = `YES, SENDING. ${t.sending} approved email(s) are in the queue now; ${t.sent_hour} went out in the last hour, ${t.sent_day} in the last day.`;
  } else {
    verdict = `YES. Nothing is waiting to send. ${t.sent_hour} went out in the last hour, ${t.sent_day} in the last day (last ${d(t.last_sent)}).`;
  }
  console.log('Are approved emails leaving?\n  ' + verdict + '\n');

  console.log('ALL AGENTS');
  console.log(`  sending now (approved, not held)   ${t.sending}   (oldest approved ${d(t.oldest_sending)})`);
  console.log(`  held, with a reason on the card    ${t.held}`);
  console.log(`  sent after approval, last hour     ${t.sent_hour}`);
  console.log(`  sent after approval, last day      ${t.sent_day}   (last ${d(t.last_sent)})`);
  console.log(`  sent by hand, never approved       ${t.by_hand}\n`);

  const holds = (await P.query(`
    SELECT send_hold_reason AS why, COUNT(*)::int AS n
      FROM outreach_logs
     WHERE status = 'approved' AND sent_at IS NULL AND cadence_stopped_at IS NULL AND send_hold_reason IS NOT NULL
     GROUP BY 1 ORDER BY 2 DESC LIMIT 12`)).rows;
  console.log('HELD, BY REASON');
  if (!holds.length) console.log('  (none)');
  for (const h of holds) console.log(`  ${String(h.n).padStart(4)}  ${String(h.why).slice(0, 150)}`);
  console.log('');

  const rows = (await P.query(`
    SELECT u.email,
      COUNT(*) FILTER (WHERE l.status = 'approved' AND l.sent_at IS NULL AND l.cadence_stopped_at IS NULL AND l.send_hold_reason IS NULL)::int AS sending,
      COUNT(*) FILTER (WHERE l.status = 'approved' AND l.sent_at IS NULL AND l.cadence_stopped_at IS NULL AND l.send_hold_reason IS NOT NULL)::int AS held,
      COUNT(*) FILTER (WHERE l.approved_at IS NOT NULL AND l.sent_at > NOW() - INTERVAL '24 hours')::int AS sent_day,
      COUNT(*) FILTER (WHERE l.approved_at IS NULL AND l.sent_at IS NOT NULL)::int AS by_hand,
      MAX(l.sent_at) AS last_sent
    FROM outreach_logs l JOIN users u ON u.id = l.agent_id
    GROUP BY u.email
    HAVING COUNT(*) FILTER (WHERE l.approved_at IS NOT NULL OR l.sent_at IS NOT NULL) > 0
    ORDER BY 2 DESC, 3 DESC, 4 DESC`)).rows;
  console.log('PER AGENT (only agents who have approved or sent something)');
  if (!rows.length) console.log('  (none)');
  else {
    console.log('  ' + 'agent'.padEnd(38) + 'sending  held  sent (24h)  by hand  last sent');
    for (const r of rows) {
      console.log('  ' + String(r.email).slice(0, 36).padEnd(38) + String(r.sending).padStart(7) + String(r.held).padStart(6)
        + String(r.sent_day).padStart(12) + String(r.by_hand).padStart(9) + '  ' + d(r.last_sent));
    }
  }
  try { await P.end(); } catch (_) {}
  process.exit(0);
}
main().catch((e) => { console.error('send-status: FAILED', e); process.exit(1); });
