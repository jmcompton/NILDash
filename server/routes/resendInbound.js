'use strict';
// POST /api/webhooks/resend-inbound — Resend fires this on every email.received
// event for the reply.mynildash.com subdomain, regardless of who the sender is
// or whether they have any mailbox connected to NILDash. See
// server/services/replyCapture.js for why this exists instead of Gmail scopes.
//
// Mounted with express.raw() in server/index.js, BEFORE the global express.json()
// parser -- signature verification needs the exact bytes Resend signed, and
// parsing/re-serializing JSON does not reproduce them byte-for-byte.
//
// ALWAYS 200s once the signature checks out, even for an event this route does
// nothing with (unknown address, no matching outreach_logs row, a bounce/auto-
// reply). Resend/Svix retries on a non-2xx, and none of those cases are worth a
// retry storm -- they're logged and left alone.

const express = require('express');
const router = express.Router();
const { pool } = require('../store');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const replyCapture = require('../services/replyCapture');
const followUpSvc = require('../services/followUpAutomation');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

router.post('/', async (req, res) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[resend-inbound] RESEND_WEBHOOK_SECRET not set — refusing to process');
    return res.status(503).json({ error: 'not configured' });
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const verified = replyCapture.verifyResendSignature({
    payload: rawBody,
    headers: {
      'svix-id': req.get('svix-id'),
      'svix-timestamp': req.get('svix-timestamp'),
      'svix-signature': req.get('svix-signature'),
    },
    secret,
  });
  if (!verified) {
    console.warn('[resend-inbound] signature verification failed');
    return res.status(400).json({ error: 'invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    console.warn('[resend-inbound] unparseable payload:', e.message);
    return res.status(400).json({ error: 'invalid json' });
  }

  // Acknowledge now — everything past this point is best-effort processing
  // that must never turn into a Resend retry no matter what it finds.
  res.status(200).json({ ok: true });
  processEvent(event).catch((e) => console.error('[resend-inbound] processing failed:', e.message));
});

async function processEvent(event) {
  if (event.type !== 'email.received') {
    console.log('[resend-inbound] ignoring event type=' + event.type);
    return;
  }
  const data = event.data || {};
  const toList = Array.isArray(data.to) ? data.to : [data.to].filter(Boolean);
  const rcpt = toList.map((addr) => replyCapture.classifyRecipient(addr)).find(Boolean);
  if (!rcpt) {
    console.log('[resend-inbound] no address we own in to=' + JSON.stringify(toList));
    return;
  }

  // The domain is catch-all, so this webhook sees EVERY message to every
  // address on it -- including mail to noreply@ and to humans. Anything that
  // does not resolve to an agent is not ours and is dropped quietly.
  let logRow = null;
  let match = { precision: 'token', ambiguous: false, reason: null };

  if (rcpt.kind === 'token') {
    // Legacy: exact by construction. Kept so replies to already-sent token
    // addresses keep working.
    logRow = (await pool.query(
      `SELECT ol.*, a.data->>'name' AS athlete_name
         FROM outreach_logs ol LEFT JOIN athletes a ON a.id = ol.athlete_id
        WHERE ol.id = $1`, [rcpt.logId])).rows[0] || null;
    if (!logRow) {
      console.log('[resend-inbound] token decoded to id=' + rcpt.logId + ' but no outreach_logs row exists');
      return;
    }
  } else {
    const agent = (await pool.query(
      'SELECT id, email FROM users WHERE reply_local_part = $1', [rcpt.localPart])).rows[0];
    if (!agent) {
      console.log(`[resend-inbound] "${rcpt.localPart}@" is not an agent address — not ours, ignoring`);
      return;
    }
    // Every outreach this agent has sent. The matcher, not SQL, decides which
    // one this reply belongs to, so the precision ladder lives in one testable
    // place rather than in a WHERE clause.
    const rows = (await pool.query(
      `SELECT ol.*, a.data->>'name' AS athlete_name
         FROM outreach_logs ol LEFT JOIN athletes a ON a.id = ol.athlete_id
        WHERE ol.agent_id = $1 AND ol.sent_to_email IS NOT NULL AND ol.status IN ('sent','replied')`,
      [agent.id])).rows;
    match = replyCapture.matchOutreach(rows, data.from);
    logRow = match.row;
    if (!logRow) {
      console.log(`[resend-inbound] agent=${agent.id} got a reply from ${data.from} but ${match.reason}`);
      return;
    }
    console.log(`[resend-inbound] matched by ${match.precision} from=${data.from} -> ${logRow.id}`
      + (match.ambiguous ? ` [AMBIGUOUS: ${match.reason}]` : ''));
  }

  // Metadata only in the webhook payload -- headers and body require the
  // separate Receiving API call.
  let full = null;
  try {
    const got = await resend.emails.receiving.get(data.email_id);
    full = got && got.data ? got.data : got;
  } catch (e) {
    console.error('[resend-inbound] receiving.get(' + data.email_id + ') failed:', e.message);
  }
  const headers = (full && full.headers) || null;
  const text = (full && full.text) || '';
  const html = (full && full.html) || '';

  const classification = replyCapture.classifyInbound({ headers, subject: data.subject, from: data.from });
  console.log(`[resend-inbound] outreach=${logRow.id} brand="${logRow.brand_name}" from=${data.from} `
    + `classified=${classification.kind}${classification.reason ? ' (' + classification.reason + ')' : ''}`);

  await pool.query(
    `UPDATE outreach_logs SET last_inbound_at = NOW(), last_inbound_kind = $1, updated_at = NOW() WHERE id = $2`,
    [classification.kind, logRow.id]
  ).catch((e) => console.error('[resend-inbound] failed to record last_inbound:', e.message));

  // Bounces and auto-replies arrive within minutes and look exactly like
  // engagement if you only check "did mail come back" -- they must never reach
  // markReplied, and never generate a notification.
  if (classification.kind !== 'reply') return;

  await pool.query(
    `UPDATE outreach_logs SET reply_text = $1, reply_html = $2, reply_from = $3, reply_subject = $4, updated_at = NOW()
      WHERE id = $5`,
    [text, html, data.from || null, data.subject || null, logRow.id]
  ).catch((e) => console.error('[resend-inbound] failed to store reply content:', e.message));

  await followUpSvc.markReplied(logRow.id, new Date(event.created_at || Date.now()));

  // A notification, not a forward -- see replyCapture.js for why. Best-effort:
  // a failed notify must never undo the markReplied above.
  notifyAgentOfReply(logRow, text, match).catch((e) => console.error('[resend-inbound] notify failed:', e.message));
}

async function notifyAgentOfReply(logRow, text, match) {
  const agentRow = (await pool.query('SELECT email FROM users WHERE id = $1', [logRow.agent_id])).rows[0];
  if (!agentRow || !agentRow.email) return;

  const appUrl = process.env.APP_URL || 'https://mynildash.com';
  const snippet = String(text || '').trim().slice(0, 240);
  const who = logRow.athlete_name ? ` for ${escapeHtml(logRow.athlete_name)}` : '';

  await resend.emails.send({
    from: 'NILDash <noreply@mynildash.com>',
    to: agentRow.email,
    subject: `Reply from ${logRow.brand_name}`,
    html: `<p><strong>${escapeHtml(logRow.brand_name)}</strong> replied to your outreach${who}.</p>`
      + (snippet
        ? `<p style="color:#555;border-left:3px solid #ddd;padding-left:10px;margin:14px 0">`
          + `${escapeHtml(snippet)}${text.length > 240 ? '…' : ''}</p>`
        : '')
      // AN AMBIGUOUS MATCH MUST NOT READ AS A CERTAIN ONE. Without a token in
      // the address, a business that has been pitched twice by the same agent
      // sends a reply that genuinely cannot be attributed from its content --
      // so the agent is told, rather than shown a confident wrong answer.
      + (match && match.ambiguous
        ? `<p style="color:#92400e;background:#fef3c7;padding:9px 11px;border-radius:6px;font-size:13px">`
          + `Heads up: ${escapeHtml(match.reason)}. Check which pitch this answers before replying.</p>`
        : '')
      + `<p><a href="${appUrl}/">Open NILDash</a> to see the full reply.</p>`,
  });
}

module.exports = router;
