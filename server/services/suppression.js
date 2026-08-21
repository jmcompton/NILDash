'use strict';
// ── A BOUNCE IS A FACT ABOUT THE ADDRESS ─────────────────────────────────────
//
// replyCapture.classifyInbound has always been able to spot a bounce -- it reads
// multipart/report delivery-status, X-Failed-Recipients, mailer-daemon senders
// and bounce-shaped subjects. It stamped last_inbound_kind='bounce' on the row
// and that was the end of it. Nothing stopped the follow-up cadence, and nothing
// stopped the NEXT pitch to the same address for a different athlete.
//
// Repeatedly mailing an address that hard bounced is one of the fastest ways to
// lose sender reputation, which is the single thing the 40-a-night ceiling
// exists to protect. So a bounce suppresses the address for everyone, checked
// before every send.
//
// SOFT VERSUS HARD. A full mailbox or an out-of-office is not a dead address and
// must not be treated as one. Only a hard bounce suppresses; a soft bounce stops
// this cadence and leaves the address alone.
const SOFT_RE = /\b(over quota|quota exceeded|mailbox (is )?full|temporarily|try again|deferred|greylist|4\.\d\.\d)\b/i;

function isHard(reason, text) {
  const s = String(reason || '') + ' ' + String(text || '');
  if (SOFT_RE.test(s)) return false;
  return true;
}

function normalize(email) {
  return String(email || '').trim().toLowerCase() || null;
}

async function suppress(pool, email, opts = {}) {
  const addr = normalize(email);
  if (!addr) return false;
  try {
    await pool.query(
      `INSERT INTO email_suppression (email, reason, kind, agent_id, outreach_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE
         SET hits = email_suppression.hits + 1,
             reason = COALESCE(EXCLUDED.reason, email_suppression.reason)`,
      [addr, String(opts.reason || 'hard bounce').slice(0, 300), opts.kind || 'bounce',
       opts.agentId || null, opts.outreachId || null]);
    return true;
  } catch (e) {
    console.error('[suppression] suppress:', e.message);
    return false;
  }
}

// Checked before every send. Fails CLOSED: if the list cannot be read we do not
// know whether this address bounced, and guessing wrong costs reputation.
async function isSuppressed(pool, email) {
  const addr = normalize(email);
  if (!addr) return { suppressed: true, reason: 'no address to send to' };
  try {
    const r = await pool.query(
      `SELECT reason, kind, first_seen_at FROM email_suppression WHERE email = $1`, [addr]);
    const row = r.rows[0];
    if (!row) return { suppressed: false, reason: null };
    return { suppressed: true, reason: row.reason || 'previously bounced', kind: row.kind };
  } catch (e) {
    console.error('[suppression] isSuppressed:', e.message);
    return { suppressed: true, reason: 'could not check the bounce list, so not sending' };
  }
}

// Filter a batch in one query rather than N. Returns the addresses to avoid.
async function suppressedSet(pool, emails) {
  const list = [...new Set((emails || []).map(normalize).filter(Boolean))];
  if (!list.length) return new Set();
  try {
    const r = await pool.query(
      `SELECT email FROM email_suppression WHERE email = ANY($1::text[])`, [list]);
    return new Set(r.rows.map((x) => x.email));
  } catch (e) {
    console.error('[suppression] suppressedSet:', e.message);
    return new Set(list);   // fail closed
  }
}

// A bounce landed. Suppress the address if it is a hard one, and stop the whole
// cadence for that thread either way -- a second touch to an address that just
// bounced is the worst possible next move.
async function onBounce(pool, logRow, detail = {}) {
  if (!logRow) return { suppressed: false, stopped: false };
  const hard = isHard(detail.reason, detail.text);
  const addr = normalize(logRow.sent_to_email);
  let suppressed = false;
  if (hard && addr) {
    suppressed = await suppress(pool, addr, {
      reason: detail.reason || 'hard bounce', kind: 'bounce',
      agentId: logRow.agent_id, outreachId: logRow.id,
    });
  }
  const stopReason = hard
    ? `the address bounced${detail.reason ? ' (' + detail.reason + ')' : ''}`
    : `the address deferred${detail.reason ? ' (' + detail.reason + ')' : ''}, so the cadence stopped without blocking it`;
  await stopCadence(pool, logRow, stopReason);
  return { suppressed, stopped: true, hard, reason: stopReason };
}

// Stop every unsent touch in this thread. Matched on the thread root so a reply
// or bounce on touch 1 also kills touches 2 and 3.
async function stopCadence(pool, logRow, reason) {
  if (!logRow) return 0;
  const root = logRow.parent_id || logRow.id;
  try {
    const r = await pool.query(
      `UPDATE outreach_logs
          SET cadence_stopped_at = NOW(), cadence_stop_reason = $3, updated_at = NOW()
        WHERE agent_id = $1
          AND (id = $2 OR parent_id = $2)
          AND status <> 'sent'
          AND cadence_stopped_at IS NULL`,
      [logRow.agent_id, root, String(reason || 'stopped').slice(0, 300)]);
    return r.rowCount || 0;
  } catch (e) {
    console.error('[suppression] stopCadence:', e.message);
    return 0;
  }
}

module.exports = { suppress, isSuppressed, suppressedSet, onBounce, stopCadence, isHard, normalize };
