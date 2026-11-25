'use strict';
// ── DONE-FOR-YOU CLIENTS: WHO THEY ARE, AND TELLING THE FOUNDER WHEN ONE GETS A REPLY ──
//
// The founder runs outreach for some agents (services/workAs). The promise to
// those agents is: "I send for you, and I tell you when a business answers."
// So he has to KNOW a business answered, without opening every client's
// account to look.
//
//   users.managed_since     set when he marks an agent done-for-you in Client
//                           accounts; null for everyone else.
//   outreach_logs.founder_alerted_at
//                           one alert per reply, however many times the reply
//                           is seen (the webhook and the mailbox check can
//                           both see the same one).
//
// When a business replies to a managed agent's pitch (the one place every
// reply passes: followUpAutomation.markReplied), one email goes to the admin:
// whose client, which athlete, which business, what they said, and a text he
// can paste to the agent. The agent still gets NILDash's own reply email; this
// is the founder's copy, so he can follow up the same hour.
//
// HE STOPS AT THE REPLY. The alert says so: the agent answers the business.
// He is not a registered agent and does not negotiate or close.

const APP_URL = () => (process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, '');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let _cols = null;
function ensureColumns(pool) {
  if (_cols) return _cols;
  _cols = (async () => {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS managed_since TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS founder_alerted_at TIMESTAMPTZ`);
  })().catch((e) => { _cols = null; throw e; });
  return _cols;
}

// Mark an agent done-for-you, or stop. -> { ok, managed }
async function set(pool, agentId, on) {
  await ensureColumns(pool);
  const r = await pool.query(
    `UPDATE users SET managed_since = CASE WHEN $2 THEN COALESCE(managed_since, NOW()) ELSE NULL END
      WHERE id = $1 AND role = 'agent' RETURNING managed_since`, [String(agentId || ''), !!on]);
  if (!r.rowCount) return { ok: false, status: 404, error: 'That agent account was not found.' };
  return { ok: true, managed: !!r.rows[0].managed_since };
}

// The founder's own words of what the business said: the top of the reply,
// without the quoted pitch underneath it.
function ownWords(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l) || /^On .{4,80}wrote:\s*$/i.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()) || /^From:\s.+/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
const firstName = (s) => { const f = String(s || '').trim().split(/\s+/)[0] || ''; return f ? f.charAt(0).toUpperCase() + f.slice(1) : ''; };

// -> { subject, text, html }
function alertFor(c) {
  const said = ownWords(c.reply).slice(0, 900);
  const ath = c.athlete || 'their athlete';
  const first = firstName(c.agentFirst || c.agentName) || 'there';
  const short = said.replace(/\s+/g, ' ').slice(0, 160);
  // Ready to paste to the agent. Plain, his voice, no question marks needed.
  const paste = `Hey ${first}! ${c.brand} just replied to the email we sent for ${ath}.`
    + (short ? ` They said: "${short}${said.replace(/\s+/g, ' ').length > 160 ? '...' : ''}"` : '')
    + ` NILDash emailed you the full reply.${c.replyFrom ? ' Answer them at ' + c.replyFrom + ' from your own email.' : ' Answer them from your own email.'} You take it from here, let me know how it goes.`;
  const subject = `Reply for ${c.agentName}: ${c.brand} about ${ath}`;
  const text = [
    `${c.brand} replied to a pitch you sent for ${c.agentName} (${ath}).`, '',
    'What they said:', said || '(the reply had no text NILDash could read; open the account to see it)', '',
    'Text this to ' + first + ':', paste, '',
    `${first} answers the business from here. NILDash also emailed ${first} about this reply.`, '',
    `Open NILDash: ${APP_URL()}/app`,
  ].join('\n');
  const html = `<p><b>${esc(c.brand)}</b> replied to a pitch you sent for <b>${esc(c.agentName)}</b> (${esc(ath)}).</p>`
    + `<p style="color:#374151;border-left:3px solid #d1d5db;padding-left:10px;margin:14px 0;white-space:pre-wrap">${esc(said || '(the reply had no text NILDash could read; open the account to see it)')}</p>`
    + `<p style="margin:18px 0 6px"><b>Text this to ${esc(first)}:</b></p>`
    + `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;white-space:pre-wrap">${esc(paste)}</div>`
    + `<p style="color:#6b7280;font-size:13px">${esc(first)} answers the business from here. NILDash also emailed ${esc(first)} about this reply.</p>`
    + `<p><a href="${esc(APP_URL())}/app">Open NILDash</a></p>`;
  return { subject, text, html, paste };
}

async function send(to, msg) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('./resendChecked').makeResend(process.env.RESEND_API_KEY);
  const r = await resend.emails.send({ from: 'NILDash <noreply@mynildash.com>', to, subject: msg.subject, text: msg.text, html: msg.html });
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
}

// A business replied to this pitch. If its agent is a done-for-you client,
// email the admin once. Never throws: a failed alert must not undo the reply.
// -> { alerted } | { skipped: reason }
async function onReply(pool, logId, deps = {}) {
  try {
    await ensureColumns(pool);
    const adminEmail = deps.adminEmail || process.env.ADMIN_EMAIL || 'johnmarkcompton@gmail.com';
    const r = (await pool.query(
      `SELECT l.id, l.brand_name, l.reply_text, l.reply_from, l.last_inbound_kind,
              u.id AS agent_id, u.name AS agent_name, u.sign_first_name, u.email AS agent_email, u.managed_since,
              a.data->>'name' AS athlete
         FROM outreach_logs l JOIN users u ON u.id = l.agent_id
         LEFT JOIN athletes a ON a.id = l.athlete_id
        WHERE l.id = $1`, [logId])).rows[0];
    if (!r) return { skipped: 'no such pitch' };
    if (!r.managed_since) return { skipped: 'not a done-for-you client' };
    if (String(r.agent_email || '').toLowerCase() === String(adminEmail).toLowerCase()) return { skipped: 'his own account' };
    // One alert per reply: the claim is the write.
    const claim = await pool.query(`UPDATE outreach_logs SET founder_alerted_at = NOW() WHERE id = $1 AND founder_alerted_at IS NULL`, [logId]);
    if (!claim.rowCount) return { skipped: 'already alerted' };
    const AN = require('./agentName');
    const msg = alertFor({ brand: r.brand_name || 'A business', athlete: r.athlete, reply: r.reply_text, replyFrom: r.reply_from,
      agentName: AN.displayName({ name: r.agent_name, sign_first_name: r.sign_first_name }) || r.agent_name || r.agent_email, agentFirst: r.sign_first_name || r.agent_name });
    try { await (deps.send || send)(adminEmail, msg); }
    catch (e) {
      // Not sent: give the claim back so the next sight of this reply tries again.
      await pool.query(`UPDATE outreach_logs SET founder_alerted_at = NULL WHERE id = $1`, [logId]).catch(() => {});
      console.error('[managed-clients] alert not sent:', e.message);
      return { skipped: 'send failed: ' + e.message };
    }
    console.log(`[managed-clients] founder alerted: reply for agent=${r.agent_id} pitch=${logId}`);
    return { alerted: true, to: adminEmail };
  } catch (e) { console.error('[managed-clients] onReply:', e.message); return { skipped: 'error: ' + e.message }; }
}

module.exports = { ensureColumns, set, onReply, alertFor, ownWords };
