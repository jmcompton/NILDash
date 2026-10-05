'use strict';
// ── REPLY RATE BY LANE, SIZE BAND AND EVIDENCE ─────────────────────────────
//
// Every card since the signing-evidence bar records the brand's size band
// (local | small | growth | national | incumbent) and the evidence it signs
// athletes like this one (services/signingEvidence). This reads the answer to
// "are national brands a fantasy?" off the cards instead of asserting it:
// per lane and band, how many cards, how many were acted on (an email sent, a
// DM or call marked done), how many got a reply, and the reply rate.
//
//   node scripts/lane-band-report.js [--days 42]
//   /api/admin/scripts/lane-band-report?days=42&text=1
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const i = process.argv.indexOf('--days');
const DAYS = Math.max(1, Math.min(365, parseInt(i > -1 ? process.argv[i + 1] : '42', 10) || 42));

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const rows = (await P.query(`
    SELECT COALESCE(q.lane, '?') AS lane,
           COALESCE(q.size_band, CASE WHEN q.lane = 'local' THEN 'local' ELSE 'not recorded' END) AS band,
           (q.signing_evidence IS NOT NULL) AS evidence,
           COUNT(*)::int AS cards,
           COUNT(*) FILTER (WHERE q.state = 'sent' OR l.sent_at IS NOT NULL)::int AS acted,
           COUNT(*) FILTER (WHERE q.replied_at IS NOT NULL OR l.replied_at IS NOT NULL)::int AS replied
      FROM outreach_queue q LEFT JOIN outreach_logs l ON l.id = q.outreach_log_id
     WHERE q.created_at > NOW() - ($1 || ' days')::interval
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, [String(DAYS)])).rows;
  console.log(`REPLY RATE BY LANE AND SIZE BAND, cards from the last ${DAYS} days  (${new Date().toISOString().slice(0, 10)})\n`);
  console.log('  lane      band          evidence   cards  acted  replied  reply rate');
  for (const r of rows) {
    const rate = r.acted ? `${Math.round((100 * r.replied) / r.acted)}%` : '-';
    console.log(`  ${r.lane.padEnd(9)} ${r.band.padEnd(13)} ${(r.evidence ? 'yes' : 'no').padEnd(9)} ${String(r.cards).padStart(6)} ${String(r.acted).padStart(6)} ${String(r.replied).padStart(8)}  ${rate.padStart(9)}`);
  }
  console.log('\nreply rate = replied / acted. Cards made before the evidence bar shipped read "not recorded"; give it a few weeks of nights before reading the bands.');
}
main()
  .catch((e) => { console.error('lane-band-report FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => { try { await store.pool.end(); } catch (_) {} });
