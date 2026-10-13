'use strict';
// ── A REFUSED MAILBOX IS THE AGENT'S TO RECONNECT ───────────────────────────
//
// The nightly preflight refreshes every connected mailbox. A refused token
// (gmail invalid_grant: the agent changed their password or removed access)
// used to fail the whole preflight and wake the founder at 12:33am, three
// nights running, over a dormant agent with nothing waiting to send, whose
// Gmail no one but that agent can reauthorize.
//
// Now:
//   - the agent who owns the mailbox is emailed a reconnect link, at most once
//     every NOTICE_EVERY_DAYS days per mailbox (mailbox_notices)
//   - the preflight goes red only when it has a consequence: the agent has
//     cards waiting (outreach_queue 'queued') or approved emails not yet sent
//   - every refused mailbox is recorded here and listed in the morning alert,
//     counted, as a notice
const NOTICE_EVERY_DAYS = parseInt(process.env.MAILBOX_NOTICE_EVERY_DAYS, 10) || 7;

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS mailbox_notices (
    account_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email_address TEXT, provider TEXT, reason TEXT,
    queued INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    nights INTEGER NOT NULL DEFAULT 1, emailed_at TIMESTAMPTZ, email_error TEXT)`);
}

// What a refused mailbox holds up: cards waiting and approvals not sent.
async function consequence(pool, userId) {
  const q = (await pool.query(`SELECT COUNT(*)::int n FROM outreach_queue WHERE agent_id = $1 AND state = 'queued'`, [userId]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  const a = (await pool.query(`SELECT COUNT(*)::int n FROM outreach_logs WHERE agent_id = $1 AND status = 'approved' AND sent_at IS NULL`, [userId]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  return { queued: q, approved: a, matters: q + a > 0 };
}

function reconnectUrl(provider) {
  const base = String(process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, '');
  return `${base}/reconnect-mailbox?provider=${encodeURIComponent(provider === 'gmail' ? 'gmail' : 'outlook')}`;
}

function emailFor(agent, acct) {
  const first = String(agent.name || '').trim().split(/\s+/)[0] || 'there';
  const which = acct.provider === 'gmail' ? 'Gmail' : 'Outlook';
  const url = reconnectUrl(acct.provider);
  const subject = `Reconnect your ${which} to NILDash`;
  const text = `Hi ${first},\n\n`
    + `NILDash can no longer send from ${acct.email_address || 'your mailbox'}: ${which} stopped accepting our connection. `
    + `This usually happens after a password change or when access is removed in your Google or Microsoft account.\n\n`
    + `Until you reconnect, emails you approve in NILDash will wait instead of sending. Reconnecting takes a minute:\n\n${url}\n\nNILDash`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<p>Hi ${esc(first)},</p><p>NILDash can no longer send from ${esc(acct.email_address || 'your mailbox')}: ${which} stopped accepting our connection. `
    + `This usually happens after a password change or when access is removed in your Google or Microsoft account.</p>`
    + `<p>Until you reconnect, emails you approve in NILDash will wait instead of sending.</p>`
    + `<p><a href="${esc(url)}">Reconnect ${which}</a></p><p>NILDash</p>`;
  return { subject, text, html, url };
}

async function _send(msg) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('./resendChecked').makeResend(process.env.RESEND_API_KEY);
  const r = await resend.emails.send({ from: process.env.ADMIN_ALERT_FROM || process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>',
    to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}

// One refused mailbox: recorded, its consequence counted, and its agent
// emailed if they have not been in the last NOTICE_EVERY_DAYS days.
// acct: { id, user_id, provider, email_address, name, agent_email }. -> { matters, queued, approved, emailed, error }
async function record(pool, acct, reason, opts = {}) {
  await ensureTable(pool);
  const c = await consequence(pool, acct.user_id);
  const row = (await pool.query(
    `INSERT INTO mailbox_notices (account_id, user_id, email_address, provider, reason, queued, approved)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (account_id) DO UPDATE SET reason = EXCLUDED.reason, queued = EXCLUDED.queued, approved = EXCLUDED.approved,
       nights = mailbox_notices.nights + CASE WHEN mailbox_notices.last_seen_at < NOW() - INTERVAL '12 hours' THEN 1 ELSE 0 END,
       last_seen_at = NOW()
     RETURNING emailed_at`, [String(acct.id), String(acct.user_id), acct.email_address || null, acct.provider || null, String(reason).slice(0, 300), c.queued, c.approved])).rows[0];
  const out = { ...c, emailed: false, error: null };
  const due = !row.emailed_at || (Date.now() - new Date(row.emailed_at).getTime()) > NOTICE_EVERY_DAYS * 86400000;
  if (!due || opts.email === false) return out;
  const to = acct.agent_email;
  if (!to) { out.error = 'the agent has no email address'; return out; }
  // Claim first, so two instances never email twice; a failed send hands it back.
  const claim = await pool.query(`UPDATE mailbox_notices SET emailed_at = NOW(), email_error = NULL WHERE account_id = $1
                                    AND (emailed_at IS NULL OR emailed_at < NOW() - make_interval(days => $2)) RETURNING 1`, [String(acct.id), NOTICE_EVERY_DAYS]);
  if (!claim.rowCount) return out;
  try {
    await (opts.send || _send)({ to, ...emailFor({ name: acct.name }, acct) });
    out.emailed = true;
  } catch (e) {
    out.error = e.message;
    await pool.query(`UPDATE mailbox_notices SET emailed_at = NULL, email_error = $2 WHERE account_id = $1`, [String(acct.id), String(e.message).slice(0, 300)]).catch(() => {});
  }
  return out;
}

// Clear a mailbox that refreshed again (reconnected) or was disconnected.
async function clear(pool, accountId) {
  await ensureTable(pool);
  await pool.query(`DELETE FROM mailbox_notices WHERE account_id = $1`, [String(accountId)]);
}

// For the morning alert: every refused mailbox seen in the last day.
async function recent(pool) {
  await ensureTable(pool);
  return (await pool.query(`SELECT n.*, u.name AS agent_name, u.email AS agent_email FROM mailbox_notices n LEFT JOIN users u ON u.id = n.user_id
                             WHERE n.last_seen_at > NOW() - INTERVAL '26 hours' ORDER BY (n.queued + n.approved) DESC, n.last_seen_at DESC`)).rows;
}

module.exports = { ensureTable, consequence, record, clear, recent, emailFor, reconnectUrl, NOTICE_EVERY_DAYS };
