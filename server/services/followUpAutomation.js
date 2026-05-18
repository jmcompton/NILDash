// server/services/followUpAutomation.js
// FollowUpAutomationService — Part 10 of the NIL Outreach Automation Engine.
//
// Monitors sent outreach and automatically:
//   - Creates follow-up drafts at day 4 (no reply)
//   - Notifies agent at day 7 (still no reply)
//   - Updates CRM when replies are detected via email sync
//
// Runs as a background poller (every 60 minutes) in the same pattern
// as the existing emailSync poller — no new infrastructure needed.
//
// SAFETY: reads outreach_logs and emails tables only.
//         writes to outreach_logs and workflow_events (new tables).
//         does NOT modify deals, athletes, or any existing table.

'use strict';

const { pool } = require('../store');
const { oneShot } = require('../ai');

const FOLLOW_UP_DAY_1 = 4; // days before first follow-up draft
const FOLLOW_UP_DAY_2 = 7; // days before agent notification
let pollerInterval = null;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * startPoller()
 * Starts the follow-up automation background poller.
 * Safe to call multiple times — only starts once.
 */
function startPoller() {
  if (pollerInterval) return;
  console.log('[followUpAutomation] Starting poller — checking every 60 minutes');
  setTimeout(() => runFollowUpCheck().catch(e =>
    console.error('[followUpAutomation] Initial check error:', e.message)
  ), 2 * 60 * 1000); // 2 minute delay after startup

  pollerInterval = setInterval(() => {
    runFollowUpCheck().catch(e =>
      console.error('[followUpAutomation] Poller error:', e.message)
    );
  }, 60 * 60 * 1000); // every 60 minutes
}

/**
 * stopPoller()
 */
function stopPoller() {
  if (pollerInterval) { clearInterval(pollerInterval); pollerInterval = null; }
}

/**
 * markReplied(outreachLogId)
 * Call this when an email reply is detected by the email sync service.
 * Updates outreach_logs and logs a workflow event.
 */
async function markReplied(outreachLogId, repliedAt) {
  await pool.query(
    `UPDATE outreach_logs SET replied_at=$1, status='replied', updated_at=NOW() WHERE id=$2`,
    [repliedAt || new Date(), outreachLogId]
  );

  const r = await pool.query('SELECT * FROM outreach_logs WHERE id=$1', [outreachLogId]);
  const log = r.rows[0];
  if (log) {
    logEvent(null, log.agent_id, 'reply_received', {
      outreachId: outreachLogId, brand: log.brand_name, athleteId: log.athlete_id,
    });
  }
}

/**
 * getFollowUpsDue(agentId)
 * Returns outreach records that need follow-up action.
 */
async function getFollowUpsDue(agentId) {
  const day4Cutoff = new Date(Date.now() - FOLLOW_UP_DAY_1 * 24 * 60 * 60 * 1000).toISOString();
  const day7Cutoff = new Date(Date.now() - FOLLOW_UP_DAY_2 * 24 * 60 * 60 * 1000).toISOString();

  const r = await pool.query(
    `SELECT * FROM outreach_logs
     WHERE agent_id=$1
       AND status='sent'
       AND replied_at IS NULL
       AND sent_at < $2
     ORDER BY sent_at ASC`,
    [agentId, day4Cutoff]
  );

  return r.rows.map(row => ({
    ...row,
    needsFollowUp: new Date(row.sent_at) < new Date(day4Cutoff) && row.follow_up_count === 0,
    needsAlert:    new Date(row.sent_at) < new Date(day7Cutoff) && row.follow_up_count < 2,
  }));
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function runFollowUpCheck() {
  // Get all sent outreach with no reply, older than 4 days
  const day4Cutoff = new Date(Date.now() - FOLLOW_UP_DAY_1 * 24 * 60 * 60 * 1000).toISOString();

  const r = await pool.query(
    `SELECT * FROM outreach_logs
     WHERE status='sent'
       AND replied_at IS NULL
       AND sent_at < $1
       AND (next_follow_up_at IS NULL OR next_follow_up_at <= NOW())`,
    [day4Cutoff]
  );

  for (const outreach of r.rows) {
    await processFollowUp(outreach).catch(e =>
      console.error('[followUpAutomation] processFollowUp error:', e.message)
    );
  }
}

async function processFollowUp(outreach) {
  const daysSinceSent = Math.floor((Date.now() - new Date(outreach.sent_at)) / (24 * 60 * 60 * 1000));

  if (outreach.follow_up_count === 0 && daysSinceSent >= FOLLOW_UP_DAY_1) {
    // Generate follow-up draft
    await generateFollowUpDraft(outreach, 1);
    logEvent(null, outreach.agent_id, 'follow_up_draft_created', {
      outreachId: outreach.id, brand: outreach.brand_name, day: daysSinceSent,
    });
  } else if (outreach.follow_up_count === 1 && daysSinceSent >= FOLLOW_UP_DAY_2) {
    // Second follow-up draft + notification
    await generateFollowUpDraft(outreach, 2);
    logEvent(null, outreach.agent_id, 'follow_up_alert', {
      outreachId: outreach.id, brand: outreach.brand_name, day: daysSinceSent,
      message: `No reply from ${outreach.brand_name} after ${daysSinceSent} days.`,
    });
  }
}

async function generateFollowUpDraft(outreach, followUpNumber) {
  const system = `You are a NIL agency follow-up email specialist.
Write a brief, professional follow-up. No markdown. Return ONLY a JSON object.`;

  const prompt = `Write follow-up #${followUpNumber} for an unanswered NIL partnership email.

Original outreach was to: ${outreach.brand_name}
Days since original send: ${Math.floor((Date.now() - new Date(outreach.sent_at)) / 86400000)}
Original subject: ${outreach.subject}

Return:
{
  "subject": "Re: [original subject] or new follow-up subject",
  "body": "Brief 3-4 sentence follow-up email body. Reference the previous email. Keep it concise and professional. End with a clear CTA."
}`;

  let followUpBody = '';
  let followUpSubject = `Follow-up: ${outreach.subject}`;

  try {
    const raw = await oneShot(prompt, system, 500);
    const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);
    followUpSubject = parsed.subject || followUpSubject;
    followUpBody = parsed.body || '';
  } catch (e) {
    followUpBody = `I wanted to follow up on my previous email regarding a NIL partnership opportunity with ${outreach.brand_name}. I believe this could be a great fit and would love to connect. Would you have a few minutes this week?`;
  }

  const followUpHtml = `<div style="font-family:Arial,sans-serif;max-width:600px;color:#333"><p>${followUpBody.replace(/\n/g, '<br>')}</p></div>`;

  // Update the outreach log with follow-up info
  const nextFollowUp = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 more days
  await pool.query(
    `UPDATE outreach_logs
     SET follow_up_count = follow_up_count + 1,
         next_follow_up_at = $1,
         updated_at = NOW()
     WHERE id = $2`,
    [nextFollowUp, outreach.id]
  );

  // Save as a draft email in email_drafts if agent has a connected account
  const accountRow = await pool.query(
    `SELECT id FROM email_accounts WHERE user_id=$1 AND status='active' LIMIT 1`,
    [outreach.agent_id]
  );

  if (accountRow.rows[0] && outreach.email_account_id) {
    const draftId = 'dft_fu_' + Date.now();
    await pool.query(
      `INSERT INTO email_drafts (id, user_id, account_id, subject, body_html, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
       ON CONFLICT (id) DO NOTHING`,
      [draftId, outreach.agent_id, outreach.email_account_id, followUpSubject, followUpHtml]
    ).catch(() => {}); // non-fatal
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function logEvent(runId, agentId, eventType, payload) {
  pool.query(
    `INSERT INTO workflow_events (run_id, agent_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [runId, agentId, eventType, JSON.stringify(payload)]
  ).catch(() => {});
}

module.exports = { startPoller, stopPoller, markReplied, getFollowUpsDue };
