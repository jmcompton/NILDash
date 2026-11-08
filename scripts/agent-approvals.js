'use strict';
// ── ONE AGENT'S APPROVED EMAILS THAT NEVER SENT, AND RELEASING THEM ─────────
//
//   node scripts/agent-approvals.js --agent <email>             the list, nothing changed
//   node scripts/agent-approvals.js --agent <email> --apply     release what can send
//   node scripts/agent-approvals.js --agent <email> --status    what became of the released
//   /api/admin/scripts/agent-approvals?text=1&agent=<email>[&apply=1|&status=1]
//
// Every email the agent approved that has no sent_at: held (send_hold_reason)
// or stopped (cadence_stopped_at), with the athlete, the business, the
// address and the reason. --apply releases each one that can be sent, back to
// the normal release queue (services/closer.releaseDue), which paces it, holds
// it to the agent's daily cap and warm-up (sendGuard), and runs the send gate
// and the send rules on it like any approved email. Nothing is sent from here.
//
// NOT RELEASED, with the reason printed:
//   - no address to send to;
//   - that address already got an email from us (email_sends or a sent
//     outreach_logs row, any agent): no double sends;
//   - an open HARD compliance finding (state law, a school rule, an athlete
//     the law cannot be checked for, a trade the law blocks for a minor).
// Soft compliance holds on a released email are resolved as approved by the
// agent (services/compliance: HARD AND SOFT). Every release is written to
// agent_approval_releases, which --status reads.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const APPLY = argv.includes('--apply');
const STATUS = argv.includes('--status');
const AGENT = String(arg('--agent') || '').trim().toLowerCase();
const d = (v) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) : '-');
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  if (!AGENT) { console.log('Give --agent <email>.'); return; }
  const u = (await P.query(`SELECT id, name, email FROM users WHERE LOWER(email) = $1`, [AGENT])).rows[0];
  if (!u) { console.log(`No agent with the email ${AGENT}.`); return; }
  await P.query(`CREATE TABLE IF NOT EXISTS agent_approval_releases (
    id BIGSERIAL PRIMARY KEY, outreach_log_id TEXT NOT NULL, agent_id TEXT NOT NULL, released_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), was TEXT)`);

  if (STATUS) {
    const r = (await P.query(
      `SELECT DISTINCT ON (x.outreach_log_id) x.outreach_log_id, x.released_at, l.brand_name, l.sent_to_email, l.sent_at, l.status,
              l.send_hold_reason, l.cadence_stop_reason, l.send_failures, a.data->>'name' AS athlete
         FROM agent_approval_releases x JOIN outreach_logs l ON l.id = x.outreach_log_id LEFT JOIN athletes a ON a.id = l.athlete_id
        WHERE x.agent_id = $1 ORDER BY x.outreach_log_id, x.released_at DESC`, [u.id])).rows;
    const sent = r.filter((x) => x.sent_at), stopped = r.filter((x) => !x.sent_at && x.cadence_stop_reason), held = r.filter((x) => !x.sent_at && !x.cadence_stop_reason && x.send_hold_reason);
    const waiting = r.filter((x) => !x.sent_at && !x.cadence_stop_reason && !x.send_hold_reason);
    console.log(`RELEASED FOR ${u.name} <${u.email}>: ${r.length}. Sent ${sent.length}, waiting in the queue ${waiting.length}, held ${held.length}, stopped ${stopped.length}.`);
    for (const x of r) {
      const st = x.sent_at ? `SENT ${d(x.sent_at)}` : x.cadence_stop_reason ? `STOPPED: ${clip(x.cadence_stop_reason, 160)}` : x.send_hold_reason ? `HELD: ${clip(x.send_hold_reason, 160)}` : 'waiting its turn';
      console.log(`  ${clip(x.athlete, 22).padEnd(22)} ${clip(x.brand_name, 40).padEnd(40)} ${clip(x.sent_to_email, 40).padEnd(40)} ${st}`);
    }
    return;
  }

  const rows = (await P.query(
    `SELECT l.id, l.brand_name, l.subject, l.sent_to_email, l.status, l.approved_at, l.cadence_stopped_at, l.cadence_stop_reason,
            l.send_hold_reason, l.athlete_id, l.touch_no, a.data->>'name' AS athlete
       FROM outreach_logs l LEFT JOIN athletes a ON a.id = l.athlete_id
      WHERE l.agent_id = $1 AND l.approved_at IS NOT NULL AND l.sent_at IS NULL
      ORDER BY l.approved_at`, [u.id])).rows;
  const C = require(ROOT + 'server/services/compliance.js');
  console.log(`APPROVED, NEVER SENT, FOR ${u.name} <${u.email}>: ${rows.length}${APPLY ? '  (releasing)' : '  (list only; apply=1 releases)'}`);
  let released = 0;
  const notReleased = {};
  const seenAddr = new Set();
  for (const r of rows) {
    const addr = String(r.sent_to_email || '').trim().toLowerCase();
    const reason = r.cadence_stop_reason || r.send_hold_reason || '(no reason on the row)';
    const state = r.cadence_stopped_at ? 'stopped' : r.send_hold_reason ? 'held' : 'waiting';
    console.log(`- ${clip(r.athlete || '?', 24)} | ${clip(r.brand_name, 90)} | ${addr || '(no address)'} | approved ${d(r.approved_at)} | ${state}: ${clip(reason, 220)}`);
    let why = null;
    if (!addr || !addr.includes('@')) why = 'no address to send to';
    if (!why && seenAddr.has(addr)) why = 'a second approval to the same address in this list';
    // A FOLLOW-UP held on the 4-day gap is not stuck: the release queue
    // sends it when the gap is up. Left as it is.
    if (!why && state === 'held' && /nothing else for \d+ days/.test(reason)) why = 'a follow-up waiting out the 4-day gap after the last email; it sends on its own';
    if (!why) {
      // A first email: any earlier email to that address is a double send.
      // A follow-up: the same subject sent before is (the thread's own
      // earlier touches are not).
      const subj = String(r.subject || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const first = Number(r.touch_no || 1) <= 1;
      const prior = (await P.query(
        `SELECT sent_at FROM email_sends WHERE LOWER(email) = $1 AND ($2 OR LOWER(REGEXP_REPLACE(COALESCE(subject,''), '\\s+', ' ', 'g')) = $3)
         UNION ALL SELECT sent_at FROM outreach_logs WHERE LOWER(sent_to_email) = $1 AND sent_at IS NOT NULL
           AND ($2 OR LOWER(REGEXP_REPLACE(COALESCE(subject,''), '\\s+', ' ', 'g')) = $3)
         ORDER BY sent_at DESC LIMIT 1`, [addr, first, subj]).catch(() => ({ rows: [] }))).rows[0];
      if (prior) why = `${addr} already got ${first ? 'an email' : 'this email'} from us on ${d(prior.sent_at).slice(0, 10)}: no double sends`;
    }
    if (!why) {
      const hard = (await P.query(
        `SELECT rule_key, rule_label, severity, reason, facts FROM compliance_holds WHERE outreach_log_id = $1 AND resolved_at IS NULL`, [r.id])).rows
        .filter((h) => C.isHard({ ruleKey: h.rule_key, severity: h.severity, facts: h.facts }));
      if (hard.length) why = `hard compliance rule: ${hard[0].rule_label}: ${clip(hard[0].reason, 160)}`;
    }
    if (why) {
      console.log(`    not released: ${why}`);
      const k = why.replace(/ \S+@\S+ /, ' ').replace(/on \d{4}-\d{2}-\d{2}/, '').replace(/:.*$/, '').trim();
      notReleased[k] = (notReleased[k] || 0) + 1;
      continue;
    }
    seenAddr.add(addr);
    if (APPLY) {
      await C.resolveSoftForApproved(P, r.id, u.id);
      const up = await P.query(
        `UPDATE outreach_logs
            SET status = 'approved', cadence_stopped_at = NULL, cadence_stop_reason = NULL,
                send_hold_reason = NULL, send_hold_at = NULL, send_claimed_at = NULL, send_failures = 0,
                scheduled_send_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND sent_at IS NULL RETURNING id`, [r.id]);
      if (up.rowCount) {
        await P.query(`INSERT INTO agent_approval_releases (outreach_log_id, agent_id, was) VALUES ($1,$2,$3)`, [r.id, u.id, clip(state + ': ' + reason, 300)]);
        released++;
        console.log('    RELEASED to the send queue');
      }
    } else {
      released++;
      console.log('    would be released');
    }
  }
  console.log('');
  console.log(`${APPLY ? 'Released' : 'Would release'}: ${released} of ${rows.length}.`);
  for (const [k, n] of Object.entries(notReleased)) console.log(`Not released, ${k}: ${n}`);
  if (APPLY && released) console.log('The release queue sends them one at a time, paced, within the agent\'s daily cap. status=1 shows what became of each.');
}

main().catch((e) => { console.error('agent-approvals: FAILED', e); process.exit(1); }).then(() => setTimeout(() => process.exit(0), 200));
