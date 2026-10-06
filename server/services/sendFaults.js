'use strict';
// ── AN APPROVAL THAT DID NOT SEND IS A FAULT, AND SOMEBODY IS TOLD ──────────
//
// The hard rule: a row an agent approved that has not sent within two hours
// is a fault. Not a log line. Each one produces, once:
//   1. a line on the agent's own Home: "3 approvals did not send. Here is why."
//      with the reason in plain words and what to do about it
//   2. one email to the agent (not a digest line they will miss)
//   3. a line in the admin's morning alert, naming the agent and the count
//
// WHAT IS A FAULT. Every way an approval can end without a send
// (services/closer releaseDue) leaves its trace on the row, and this reads all
// of them; a row with NO trace is the worst case and is caught too:
//   stopped    cadence_stopped_at: no address, bounced, unsubscribed, replied
//              first, the thread says stop -- a fault at once, it will never send
//   held       send_hold_reason: the mailbox is disconnected, the day's ceiling,
//              compliance, the spacing rules -- a fault after two hours
//   failing    send_error: the provider refused, retried on a backoff
//   silent     approved over two hours ago with no hold, no error, no stop: the
//              send queue never picked it up. Ours, and recorded as ours.
// A fault resolves itself when the row sends, or is closed (the backlog
// sweep), and the agent can dismiss the line once they have read it.

const WINDOW_MS = 2 * 60 * 60 * 1000;
// Only a fault from the last three days is emailed; an older one is reported
// on Home and in the morning alert (the backlog sweep re-decides those).
const EMAIL_WITHIN_DAYS = 3;

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS approval_faults (
    log_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, athlete_id TEXT, brand_name TEXT,
    kind TEXT NOT NULL, why TEXT NOT NULL, fix TEXT NOT NULL, ours BOOLEAN NOT NULL DEFAULT FALSE,
    approved_at TIMESTAMPTZ, detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    emailed_at TIMESTAMPTZ, acknowledged_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ, resolution TEXT)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS approval_faults_agent_idx ON approval_faults (agent_id) WHERE resolved_at IS NULL`).catch(() => {});
}

// ── THE REASON, IN PLAIN WORDS, AND WHAT TO DO ──────────────────────────────
function explain(row) {
  const stop = String(row.cadence_stop_reason || '');
  const hold = String(row.send_hold_reason || '');
  const err = String(row.send_error || '');
  const any = (re) => re.test(stop) || re.test(hold) || re.test(err);
  if (stop) {
    if (/no address to send to/i.test(stop)) return { kind: 'no-address', why: 'There was no email address for this business, so there was nothing to send it to.', fix: 'Nothing to send by email. If we have a phone or an Instagram for them it is a call or DM card on Home now.' };
    if (/repl/i.test(stop)) return { kind: 'replied', why: 'They replied before it went out, so it was not sent.', fix: 'Read their reply in your inbox and answer it there.' };
    if (/unsubscrib|opt(ed)? out/i.test(stop)) return { kind: 'unsubscribed', why: 'This address asked not to be emailed.', fix: 'Do not email them again. Call or DM if there is another way to reach them.' };
    if (/bounce/i.test(stop)) return { kind: 'bounced', why: 'This address bounced before, so it was not sent again.', fix: 'Find another address for them, or reach them by phone or Instagram.' };
    if (/could not check/i.test(stop)) return { kind: 'ours', ours: true, why: 'We could not check our bounce list at send time, so it was not sent. That was our fault.', fix: 'Nothing for you to do: we have been alerted and it will be sent once it is checked.' };
    if (/dead|signed|three touches|no longer|stop/i.test(stop)) return { kind: 'thread-stopped', why: `It was stopped before sending: ${stop}.`, fix: 'Nothing to send. The conversation with this business is already settled.' };
    return { kind: 'stopped', why: `It was stopped before sending: ${stop}.`, fix: 'Nothing will send. Approve a fresh email if you still want to reach them.' };
  }
  if (any(/reconnect|mailbox could not send|no connected mailbox|auth|token|invalid_grant/i)) return { kind: 'mailbox', why: 'Your email account is disconnected, so nothing could be sent from it.', fix: 'Reconnect your mailbox in Settings. These send on their own as soon as it is back.' };
  if (any(/ceiling|daily|per day|limit|quota|too many/i)) return { kind: 'limit', why: 'You reached the number of emails your mailbox can send today.', fix: 'Nothing to do: they go out automatically when the limit resets.' };
  if (any(/compliance/i)) return { kind: 'compliance', why: `Held by the compliance check: ${(hold || err).replace(/^compliance:\s*/i, '')}.`, fix: /age|dob|birth|18/i.test(hold + err) ? 'Add the athlete\'s date of birth, or tick "18 or over" on their profile.' : 'Open the Compliance page to see the hold and what clears it.' };
  if (any(/not due|follow-up/i)) return { kind: 'waiting', why: `Waiting: ${hold || err}.`, fix: 'Nothing to do: it sends when it is due.' };
  if (any(/mailing address|can-spam|BUSINESS_MAILING_ADDRESS/i)) return { kind: 'ours', ours: true, why: 'Our footer settings were missing, so nothing could be sent. That was our fault.', fix: 'Nothing for you to do: we have been alerted and it will send once fixed.' };
  if (err || hold) return { kind: 'failing', why: `Your email provider refused it: ${(err || hold).replace(/^the send failed and will be retried:\s*/i, '')}.`, fix: 'We keep retrying. If it is still here tomorrow, reconnect your mailbox in Settings.' };
  return { kind: 'ours', ours: true, why: 'It was approved but our send queue never picked it up. That was our fault.', fix: 'Nothing for you to do: we have been alerted and are sending it.' };
}

// ── DETECT, RESOLVE ─────────────────────────────────────────────────────────
async function sweep(pool, opts = {}) {
  await ensureTable(pool);
  const now = opts.now ? new Date(opts.now) : new Date();
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  const rows = (await pool.query(
    `SELECT l.id, l.agent_id, l.athlete_id, l.brand_name, l.approved_at, l.cadence_stop_reason, l.send_hold_reason, l.send_error,
            l.cadence_stopped_at
       FROM outreach_logs l
      WHERE l.status = 'approved' AND l.sent_at IS NULL AND l.approved_at IS NOT NULL
        AND (l.approved_at < $1 OR l.cadence_stopped_at IS NOT NULL)
        -- STILL IN LINE IS NOT STUCK. The queue sends one email per agent every
        -- 20 to 50 seconds, so a bulk approve of 200 takes over two hours. A row
        -- with no hold, no error and no stop, whose agent's mailbox sent in the
        -- last 15 minutes, is moving and is not a fault yet.
        AND NOT (l.cadence_stopped_at IS NULL AND COALESCE(l.send_hold_reason, '') = '' AND COALESCE(l.send_error, '') = ''
                 AND EXISTS (SELECT 1 FROM outreach_logs s WHERE s.agent_id = l.agent_id AND s.sent_at > $2))`,
    [cutoff, new Date(now.getTime() - 15 * 60 * 1000)])).rows;
  const fresh = [];
  for (const r of rows) {
    const e = explain(r);
    const ins = await pool.query(
      `INSERT INTO approval_faults (log_id, agent_id, athlete_id, brand_name, kind, why, fix, ours, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (log_id) DO UPDATE SET kind = EXCLUDED.kind, why = EXCLUDED.why, fix = EXCLUDED.fix, ours = EXCLUDED.ours, updated_at = NOW(),
         resolved_at = NULL, resolution = NULL
       RETURNING (xmax = 0) AS inserted`, [r.id, r.agent_id, r.athlete_id, r.brand_name, e.kind, e.why, e.fix, !!e.ours, r.approved_at]);
    if (ins.rows[0] && ins.rows[0].inserted) {
      fresh.push({ ...r, ...e });
      if (e.ours) require('./ourFault').record('send-fault', `${r.brand_name}: ${e.why}`, 'sendFaults ' + r.id).catch(() => {});
    }
  }
  // Resolved: it sent, or it is no longer approved (closed by the backlog sweep, skipped).
  const res = await pool.query(
    `UPDATE approval_faults f SET resolved_at = NOW(), updated_at = NOW(),
            resolution = CASE WHEN l.sent_at IS NOT NULL THEN 'sent' ELSE COALESCE(NULLIF(l.cadence_stop_reason, ''), 'no longer approved: ' || l.status) END
       FROM outreach_logs l
      WHERE f.log_id = l.id AND f.resolved_at IS NULL AND (l.sent_at IS NOT NULL OR l.status <> 'approved')
      RETURNING f.log_id`);
  return { open: rows.length, fresh: fresh.length, resolved: res.rowCount, freshRows: fresh };
}

// ── ONE EMAIL TO EACH AGENT, ONCE PER FAULT ─────────────────────────────────
function emailFor(agent, faults) {
  const n = faults.length;
  const subject = `${n} approved ${n === 1 ? 'email' : 'emails'} did not send`;
  const lines = faults.map((f) => `- ${f.brand_name || 'A business'}${f.athlete_name ? ` (for ${f.athlete_name})` : ''}: ${f.why} What to do: ${f.fix}`);
  const text = `Hi ${String(agent.name || '').split(' ')[0] || 'there'},\n\n`
    + `${n === 1 ? 'An email you approved' : `${n} emails you approved`} in NILDash did not go out. Here is why, and what to do:\n\n${lines.join('\n')}\n\n`
    + `You will see the same list at the top of Home until you dismiss it.\n\nNILDash`;
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<p>Hi ${esc(String(agent.name || '').split(' ')[0] || 'there')},</p><p>${n === 1 ? 'An email you approved' : `${n} emails you approved`} in NILDash did not go out. Here is why, and what to do:</p><ul>`
    + faults.map((f) => `<li><b>${esc(f.brand_name || 'A business')}</b>${f.athlete_name ? ` (for ${esc(f.athlete_name)})` : ''}: ${esc(f.why)}<br><i>What to do:</i> ${esc(f.fix)}</li>`).join('')
    + `</ul><p>You will see the same list at the top of Home until you dismiss it.</p><p>NILDash</p>`;
  return { subject, text, html };
}

async function _send(msg) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('./resendChecked').makeResend(process.env.RESEND_API_KEY);
  const r = await resend.emails.send({ from: process.env.ADMIN_ALERT_FROM || process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>',
    to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}

// opts.send injectable (tests). Claims each fault first (emailed_at), so two
// instances never email twice; a failed send hands the claim back.
async function notify(pool, opts = {}) {
  await ensureTable(pool);
  const send = opts.send || _send;
  const pending = (await pool.query(
    `SELECT f.*, u.email AS agent_email, u.name AS agent_name, a.data->>'name' AS athlete_name
       FROM approval_faults f JOIN users u ON u.id = f.agent_id LEFT JOIN athletes a ON a.id = f.athlete_id
      WHERE f.resolved_at IS NULL AND f.emailed_at IS NULL AND f.acknowledged_at IS NULL
        AND (f.approved_at IS NULL OR f.approved_at > NOW() - make_interval(days => $1))
      ORDER BY f.agent_id, f.detected_at`, [EMAIL_WITHIN_DAYS])).rows;
  const byAgent = new Map();
  for (const f of pending) { if (!byAgent.has(f.agent_id)) byAgent.set(f.agent_id, []); byAgent.get(f.agent_id).push(f); }
  const out = { emailed: 0, faults: 0, failed: [] };
  for (const [agentId, faults] of byAgent) {
    const email = faults[0].agent_email;
    if (!email) continue;
    const claim = await pool.query(`UPDATE approval_faults SET emailed_at = NOW() WHERE log_id = ANY($1::text[]) AND emailed_at IS NULL RETURNING log_id`,
      [faults.map((f) => f.log_id)]);
    const mine = faults.filter((f) => claim.rows.some((r) => r.log_id === f.log_id));
    if (!mine.length) continue;
    try {
      await send({ to: email, ...emailFor({ name: faults[0].agent_name }, mine) });
      out.emailed++; out.faults += mine.length;
    } catch (e) {
      await pool.query(`UPDATE approval_faults SET emailed_at = NULL WHERE log_id = ANY($1::text[])`, [mine.map((f) => f.log_id)]).catch(() => {});
      out.failed.push({ agentId, error: e.message });
      require('./ourFault').record('send-fault-email', `could not email ${email} about ${mine.length} unsent approval(s): ${e.message}`, 'sendFaults').catch(() => {});
    }
  }
  return out;
}

// What Home shows the agent: open, not dismissed.
async function forAgent(pool, agentId) {
  await ensureTable(pool);
  const rows = (await pool.query(
    `SELECT f.log_id, f.brand_name, f.kind, f.why, f.fix, f.approved_at, a.data->>'name' AS athlete_name
       FROM approval_faults f LEFT JOIN athletes a ON a.id = f.athlete_id
      WHERE f.agent_id = $1 AND f.resolved_at IS NULL AND f.acknowledged_at IS NULL
      ORDER BY f.detected_at DESC LIMIT 50`, [agentId])).rows;
  return { count: rows.length, rows: rows.map((r) => ({ id: r.log_id, business: r.brand_name, athlete: r.athlete_name, kind: r.kind, why: r.why, fix: r.fix, approvedAt: r.approved_at })) };
}
async function acknowledge(pool, agentId, ids) {
  await ensureTable(pool);
  const r = await pool.query(`UPDATE approval_faults SET acknowledged_at = NOW() WHERE agent_id = $1 AND resolved_at IS NULL
                                AND ($2::text[] IS NULL OR log_id = ANY($2::text[]))`, [agentId, Array.isArray(ids) && ids.length ? ids.map(String) : null]);
  return { ok: true, acknowledged: r.rowCount };
}

// The morning alert's line: every agent with open faults, and the count.
async function byAgentOpen(pool) {
  await ensureTable(pool);
  return (await pool.query(
    `SELECT u.email, u.name, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE f.ours)::int AS ours,
            (ARRAY_AGG(f.kind ORDER BY f.detected_at DESC))[1] AS latest_kind
       FROM approval_faults f JOIN users u ON u.id = f.agent_id
      WHERE f.resolved_at IS NULL GROUP BY 1, 2 ORDER BY n DESC`)).rows;
}

async function tick(pool, opts = {}) {
  const s = await sweep(pool, opts);
  const n = await notify(pool, opts);
  if (s.fresh || n.emailed) console.log(`[send-faults] ${s.fresh} new fault(s), ${s.resolved} resolved, ${s.open} open; emailed ${n.emailed} agent(s)`);
  return { ...s, ...n };
}

module.exports = { sweep, notify, tick, forAgent, acknowledge, byAgentOpen, explain, emailFor, ensureTable, WINDOW_MS, EMAIL_WITHIN_DAYS };
