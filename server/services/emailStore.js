// server/services/emailStore.js
// All database operations for the email integration tables.
// Isolated from store.js — never modifies existing tables.
// Uses the same pg Pool from store.js so no second connection is opened.

'use strict';
const { pool } = require('../store');
const { encrypt, decrypt } = require('./crypto');

// ── Email Accounts ──────────────────────────────────────────────────────────

async function saveEmailAccount(id, userId, provider, emailAddress, displayName, accessToken, refreshToken, tokenExpiry) {
  await pool.query(`
    INSERT INTO email_accounts
      (id, user_id, provider, email_address, display_name, access_token_enc, refresh_token_enc, token_expiry, status, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',NOW())
    ON CONFLICT (user_id, email_address) DO UPDATE SET
      provider        = EXCLUDED.provider,
      display_name    = EXCLUDED.display_name,
      access_token_enc  = EXCLUDED.access_token_enc,
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      token_expiry    = EXCLUDED.token_expiry,
      status          = 'active',
      updated_at      = NOW()
  `, [
    id, userId, provider, emailAddress, displayName,
    encrypt(accessToken),
    encrypt(refreshToken),
    tokenExpiry || null,
  ]);
  return getEmailAccount(id);
}

async function getEmailAccount(id) {
  const r = await pool.query('SELECT * FROM email_accounts WHERE id=$1', [id]);
  return r.rows[0] ? sanitizeAccount(r.rows[0]) : null;
}

async function getEmailAccountsByUser(userId) {
  const r = await pool.query('SELECT * FROM email_accounts WHERE user_id=$1 ORDER BY created_at ASC', [userId]);
  return r.rows.map(sanitizeAccount);
}

async function getEmailAccountWithTokens(id) {
  const r = await pool.query('SELECT * FROM email_accounts WHERE id=$1', [id]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    ...sanitizeAccount(row),
    accessToken:  decrypt(row.access_token_enc),
    refreshToken: decrypt(row.refresh_token_enc),
  };
}

async function updateAccountTokens(id, accessToken, refreshToken, tokenExpiry) {
  await pool.query(`
    UPDATE email_accounts SET
      access_token_enc  = $2,
      refresh_token_enc = $3,
      token_expiry      = $4,
      updated_at        = NOW()
    WHERE id = $1
  `, [id, encrypt(accessToken), encrypt(refreshToken), tokenExpiry || null]);
}

async function updateAccountStatus(id, status, lastSync) {
  await pool.query(`
    UPDATE email_accounts SET status=$2, last_sync=$3, updated_at=NOW() WHERE id=$1
  `, [id, status, lastSync || null]);
}

async function updateSyncCursor(id, cursor) {
  await pool.query('UPDATE email_accounts SET sync_cursor=$2, updated_at=NOW() WHERE id=$1', [id, cursor]);
}

async function deleteEmailAccount(id, userId) {
  // Cascade: remove associated emails, threads, drafts, logs for this account
  await pool.query('DELETE FROM email_drafts WHERE account_id=$1 AND user_id=$2', [id, userId]);
  await pool.query('DELETE FROM email_sync_logs WHERE account_id=$1 AND user_id=$2', [id, userId]);
  await pool.query('DELETE FROM emails WHERE account_id=$1 AND user_id=$2', [id, userId]);
  await pool.query('DELETE FROM email_threads WHERE account_id=$1 AND user_id=$2', [id, userId]);
  await pool.query('DELETE FROM email_accounts WHERE id=$1 AND user_id=$2', [id, userId]);
}

// Strip encrypted token columns before returning to callers
function sanitizeAccount(row) {
  const { access_token_enc, refresh_token_enc, ...safe } = row;
  return safe;
}

// ── Emails ──────────────────────────────────────────────────────────────────

async function saveEmail(msg) {
  // msg: { id, threadId, accountId, userId, direction, fromAddress, fromName,
  //        toAddresses[], ccAddresses[], subject, bodyText, bodyHtml,
  //        providerMessageId, providerThreadId, sentAt, isRead, hasAttachments,
  //        athleteId, dealId }
  await pool.query(`
    INSERT INTO emails
      (id, thread_id, account_id, user_id, direction, from_address, from_name,
       to_addresses, cc_addresses, subject, body_text, body_html,
       provider_message_id, provider_thread_id, sent_at, is_read, has_attachments,
       athlete_id, deal_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    ON CONFLICT (account_id, provider_message_id) DO NOTHING
  `, [
    msg.id, msg.threadId, msg.accountId, msg.userId, msg.direction,
    msg.fromAddress, msg.fromName,
    msg.toAddresses || [], msg.ccAddresses || [],
    msg.subject, msg.bodyText, msg.bodyHtml,
    msg.providerMessageId, msg.providerThreadId,
    msg.sentAt, msg.isRead || false, msg.hasAttachments || false,
    msg.athleteId || null, msg.dealId || null,
  ]);
}

async function getEmailsByThread(threadId, userId) {
  const r = await pool.query(`
    SELECT id, thread_id, account_id, direction, from_address, from_name,
           to_addresses, cc_addresses, subject, body_text, body_html,
           sent_at, is_read, has_attachments, athlete_id, deal_id, created_at
    FROM emails WHERE thread_id=$1 AND user_id=$2 ORDER BY sent_at ASC
  `, [threadId, userId]);
  return r.rows;
}

async function getEmailsByAthlete(athleteId, userId, limit = 50) {
  const r = await pool.query(`
    SELECT id, thread_id, account_id, direction, from_address, from_name,
           to_addresses, subject, body_text, sent_at, is_read, created_at
    FROM emails WHERE athlete_id=$1 AND user_id=$2 ORDER BY sent_at DESC LIMIT $3
  `, [athleteId, userId, limit]);
  return r.rows;
}

async function markEmailRead(id, userId) {
  await pool.query('UPDATE emails SET is_read=TRUE WHERE id=$1 AND user_id=$2', [id, userId]);
}

async function searchEmails(userId, query, limit = 30) {
  const r = await pool.query(`
    SELECT id, thread_id, account_id, direction, from_address, from_name,
           to_addresses, subject, body_text, sent_at, is_read, athlete_id, created_at
    FROM emails
    WHERE user_id=$1
      AND (subject ILIKE $2 OR body_text ILIKE $2 OR from_address ILIKE $2 OR from_name ILIKE $2)
    ORDER BY sent_at DESC LIMIT $3
  `, [userId, `%${query}%`, limit]);
  return r.rows;
}

// ── Threads ─────────────────────────────────────────────────────────────────

async function upsertThread(thread) {
  // thread: { id, userId, accountId, subject, participantEmails[], athleteId, dealId, lastMessageAt }
  await pool.query(`
    INSERT INTO email_threads
      (id, user_id, account_id, subject, participant_emails, athlete_id, deal_id,
       last_message_at, message_count, has_unread, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,TRUE,NOW())
    ON CONFLICT (id) DO UPDATE SET
      last_message_at = GREATEST(email_threads.last_message_at, EXCLUDED.last_message_at),
      message_count   = email_threads.message_count + 1,
      has_unread      = TRUE,
      athlete_id      = COALESCE(EXCLUDED.athlete_id, email_threads.athlete_id),
      deal_id         = COALESCE(EXCLUDED.deal_id, email_threads.deal_id),
      updated_at      = NOW()
  `, [
    thread.id, thread.userId, thread.accountId, thread.subject,
    thread.participantEmails || [], thread.athleteId || null, thread.dealId || null,
    thread.lastMessageAt,
  ]);
}

async function getThreadsByUser(userId, limit = 50, offset = 0) {
  const r = await pool.query(`
    SELECT t.*,
           (SELECT COUNT(*) FROM emails e WHERE e.thread_id=t.id AND e.is_read=FALSE) AS unread_count
    FROM email_threads t
    WHERE t.user_id=$1
    ORDER BY t.last_message_at DESC
    LIMIT $2 OFFSET $3
  `, [userId, limit, offset]);
  return r.rows;
}

async function getThreadsByAthlete(athleteId, userId) {
  const r = await pool.query(`
    SELECT * FROM email_threads WHERE athlete_id=$1 AND user_id=$2 ORDER BY last_message_at DESC
  `, [athleteId, userId]);
  return r.rows;
}

async function markThreadRead(threadId, userId) {
  await pool.query('UPDATE emails SET is_read=TRUE WHERE thread_id=$1 AND user_id=$2', [threadId, userId]);
  await pool.query('UPDATE email_threads SET has_unread=FALSE WHERE id=$1 AND user_id=$2', [threadId, userId]);
}

// ── Sync Logs ───────────────────────────────────────────────────────────────

async function logSyncStart(accountId, userId) {
  const r = await pool.query(`
    INSERT INTO email_sync_logs (account_id, user_id, status) VALUES ($1,$2,'running') RETURNING id
  `, [accountId, userId]);
  return r.rows[0].id;
}

async function logSyncFinish(logId, messagesSynced, errorMessage) {
  await pool.query(`
    UPDATE email_sync_logs SET
      status=$2, messages_synced=$3, error_message=$4, finished_at=NOW()
    WHERE id=$1
  `, [logId, errorMessage ? 'error' : 'success', messagesSynced || 0, errorMessage || null]);
}

async function getLastSyncLog(accountId) {
  const r = await pool.query(`
    SELECT * FROM email_sync_logs WHERE account_id=$1 ORDER BY started_at DESC LIMIT 1
  `, [accountId]);
  return r.rows[0] || null;
}

// ── Drafts ───────────────────────────────────────────────────────────────────

async function saveDraft(draft) {
  await pool.query(`
    INSERT INTO email_drafts (id, user_id, account_id, thread_id, to_addresses, cc_addresses, subject, body_html)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (id) DO UPDATE SET
      to_addresses=$5, cc_addresses=$6, subject=$7, body_html=$8, updated_at=NOW()
  `, [
    draft.id, draft.userId, draft.accountId, draft.threadId || null,
    draft.toAddresses || [], draft.ccAddresses || [],
    draft.subject, draft.bodyHtml,
  ]);
}

async function getDraftsByUser(userId) {
  const r = await pool.query('SELECT * FROM email_drafts WHERE user_id=$1 ORDER BY updated_at DESC', [userId]);
  return r.rows;
}

async function deleteDraft(id, userId) {
  await pool.query('DELETE FROM email_drafts WHERE id=$1 AND user_id=$2', [id, userId]);
}

module.exports = {
  // Accounts
  saveEmailAccount, getEmailAccount, getEmailAccountsByUser,
  getEmailAccountWithTokens, updateAccountTokens, updateAccountStatus,
  updateSyncCursor, deleteEmailAccount,
  // Emails
  saveEmail, getEmailsByThread, getEmailsByAthlete, markEmailRead, searchEmails,
  // Threads
  upsertThread, getThreadsByUser, getThreadsByAthlete, markThreadRead,
  // Sync logs
  logSyncStart, logSyncFinish, getLastSyncLog,
  // Drafts
  saveDraft, getDraftsByUser, deleteDraft,
};
