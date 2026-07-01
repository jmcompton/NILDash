// server/services/emailSync.js
// Email sync orchestrator — normalizes, deduplicates, threads, and persists emails.
// Runs on a setInterval poller (started by server/index.js) — never blocks the event loop.
// Calls provider adapters and emailStore; never touches existing CRM tables directly.

'use strict';

const crypto      = require('crypto');
const emailStore  = require('./emailStore');
const crm         = require('./crmAssociation');
const gmail       = require('./providers/gmail');
const outlook     = require('./providers/outlook');
const imap        = require('./providers/imap');

// Inbox reading (gmail.users.messages.list/get) requires the RESTRICTED
// gmail.readonly scope, which NILDash no longer requests (Google verification
// declares only gmail.send / calendar.events / userinfo.email). Keep this OFF so
// no background sync or on-connect sync attempts a Gmail read and throws an
// insufficient-scope error after users reconnect with the narrower grant. Flip
// back on only after a future restricted-scope verification (CASA); the code path
// is preserved. Set env EMAIL_INBOX_SYNC=1 to force-enable in a dev/test project.
const INBOX_SYNC_ENABLED = process.env.EMAIL_INBOX_SYNC === '1';

// Active sync lock: accountId → true — prevents overlapping sync jobs
const syncLocks = new Set();

// ── Entry point called by the background poller ──────────────────────────────

/**
 * Sync all connected accounts for all users.
 * Called every N minutes by setInterval in server/index.js.
 */
async function syncAllAccounts() {
  try {
    const { pool } = require('../store');
    const r = await pool.query(`SELECT * FROM email_accounts WHERE status='active'`);
    for (const account of r.rows) {
      syncAccount(account).catch(e =>
        console.error(`[emailSync] Account ${account.id} sync error:`, e.message)
      );
    }
  } catch (e) {
    console.error('[emailSync] syncAllAccounts error:', e.message);
  }
}

/**
 * Sync a single account.  Exported so routes can trigger an on-demand sync.
 */
async function syncAccount(account) {
  if (syncLocks.has(account.id)) return; // already syncing
  // Gmail inbox sync is disabled — reading messages needs the RESTRICTED
  // gmail.readonly scope we no longer request. Skip Gmail accounts entirely so
  // nothing throws an insufficient-scope error. (Send still works via gmail.send.)
  if (account.provider === 'gmail' && !INBOX_SYNC_ENABLED) {
    console.log('[emailSync] Gmail inbox sync disabled (INBOX_SYNC_ENABLED=false) — skipping', account.email_address);
    return;
  }
  syncLocks.add(account.id);

  const logId = await emailStore.logSyncStart(account.id, account.user_id);
  let synced = 0;
  let errorMsg = null;

  try {
    // Decrypt tokens
    const { decrypt } = require('./crypto');
    const accessToken  = decrypt(account.access_token_enc);
    const refreshToken = decrypt(account.refresh_token_enc);

    // Check if token needs refresh
    const { access, refresh, expiry } = await maybeRefreshToken(
      account, accessToken, refreshToken
    );

    // Build CRM email map for this user (for association)
    const athleteEmailMap = await crm.buildAthleteEmailMap(account.user_id);

    // Fetch based on provider
    let result;
    if (account.provider === 'gmail') {
      result = await gmail.fetchMessages(access, refresh, account.sync_cursor);
    } else if (account.provider === 'outlook' || account.provider === 'microsoft365') {
      result = await outlook.fetchMessages(access, refresh, account.sync_cursor);
    } else {
      // IMAP — password stored in access_token_enc, config in sync_cursor field
      const cfg = account.sync_cursor && account.sync_cursor.startsWith('{')
        ? JSON.parse(account.sync_cursor) : {};
      result = await imap.fetchMessages(
        account.email_address, access, cfg.imapConfig || null, cfg.cursor || null
      );
    }

    // Persist each message
    for (const msg of result.messages) {
      try {
        await persistMessage(msg, account, athleteEmailMap);
        synced++;
      } catch (e) {
        // Skip duplicate or malformed — don't abort whole sync
        if (!e.message.includes('duplicate')) {
          console.error('[emailSync] persistMessage error:', e.message);
        }
      }
    }

    // Update cursor and last_sync
    if (result.nextCursor) await emailStore.updateSyncCursor(account.id, result.nextCursor);
    await emailStore.updateAccountStatus(account.id, 'active', new Date());

  } catch (e) {
    errorMsg = e.message;
    await emailStore.updateAccountStatus(account.id, 'error', new Date());
    console.error(`[emailSync] Sync failed for ${account.email_address}:`, e.message);
  } finally {
    await emailStore.logSyncFinish(logId, synced, errorMsg);
    syncLocks.delete(account.id);
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function persistMessage(msg, account, athleteEmailMap) {
  // Determine direction-based association
  const allAddresses = [
    msg.fromAddress,
    ...(msg.toAddresses || []),
    ...(msg.ccAddresses || []),
  ].filter(Boolean);

  // CRM association — find matching athlete
  let athleteId = null;
  for (const addr of allAddresses) {
    if (addr && athleteEmailMap[addr.toLowerCase()]) {
      athleteId = athleteEmailMap[addr.toLowerCase()];
      break;
    }
  }

  // Build/find thread ID
  const threadKey = deriveThreadKey(account.id, msg.providerThreadId || msg.providerMessageId);
  const threadId  = `thr_${threadKey}`;

  // Upsert thread
  await emailStore.upsertThread({
    id:               threadId,
    userId:           account.user_id,
    accountId:        account.id,
    subject:          msg.subject,
    participantEmails: allAddresses,
    athleteId,
    lastMessageAt:    msg.sentAt,
  });

  // Save email
  const emailId = `msg_${account.id}_${Buffer.from(msg.providerMessageId || '').toString('hex').slice(0, 24)}`;
  await emailStore.saveEmail({
    id:               emailId,
    threadId,
    accountId:        account.id,
    userId:           account.user_id,
    direction:        msg.direction,
    fromAddress:      msg.fromAddress,
    fromName:         msg.fromName,
    toAddresses:      msg.toAddresses,
    ccAddresses:      msg.ccAddresses,
    subject:          msg.subject,
    bodyText:         (msg.bodyText || '').slice(0, 50000), // cap at 50K chars
    bodyHtml:         (msg.bodyHtml || '').slice(0, 200000),
    providerMessageId: msg.providerMessageId,
    providerThreadId:  msg.providerThreadId,
    sentAt:           msg.sentAt,
    isRead:           msg.isRead,
    hasAttachments:   msg.hasAttachments,
    athleteId,
    dealId:           null, // deal association reserved for future AI tagging
  });
}

function deriveThreadKey(accountId, providerThreadId) {
  return crypto
    .createHash('sha1')
    .update(accountId + ':' + (providerThreadId || 'solo'))
    .digest('hex')
    .slice(0, 20);
}

async function maybeRefreshToken(account, accessToken, refreshToken) {
  const now = new Date();
  const expiry = account.token_expiry ? new Date(account.token_expiry) : null;
  const needsRefresh = expiry && (expiry.getTime() - now.getTime() < 5 * 60 * 1000); // within 5 min

  if (!needsRefresh) return { access: accessToken, refresh: refreshToken, expiry };

  let newAccess = accessToken;
  let newExpiry = expiry;

  try {
    if (account.provider === 'gmail' && gmail.isAvailable()) {
      const r = await gmail.refreshAccessToken(refreshToken);
      newAccess  = r.accessToken;
      newExpiry  = r.expiry;
    } else if ((account.provider === 'outlook' || account.provider === 'microsoft365') && outlook.isAvailable()) {
      const r = await outlook.refreshAccessToken(refreshToken);
      newAccess  = r.accessToken;
      newExpiry  = r.expiry;
    }
    // Save refreshed tokens
    await emailStore.updateAccountTokens(account.id, newAccess, refreshToken, newExpiry);
  } catch (e) {
    console.error('[emailSync] Token refresh failed:', e.message);
  }

  return { access: newAccess, refresh: refreshToken, expiry: newExpiry };
}

// ── Background poller ────────────────────────────────────────────────────────

let pollerHandle = null;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

function startPoller() {
  if (pollerHandle) return;
  console.log('[emailSync] Background poller started (interval: 5 min)');
  // Initial sync after 30 seconds (let server fully boot first)
  setTimeout(syncAllAccounts, 30 * 1000);
  pollerHandle = setInterval(syncAllAccounts, POLL_INTERVAL_MS);
}

function stopPoller() {
  if (pollerHandle) { clearInterval(pollerHandle); pollerHandle = null; }
}

module.exports = { syncAllAccounts, syncAccount, startPoller, stopPoller, INBOX_SYNC_ENABLED };
