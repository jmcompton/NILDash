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
    // Gmail inbox sync off: exclude Gmail accounts in the QUERY rather than looping
    // them and logging a skip line each. With 7 accounts that was 7 identical lines
    // per run, drowning the deploy logs. The state is announced once at startup.
    // 'error' rows come back too, at most once an hour (RETRY_ERROR_MS): a
    // mailbox that failed once is tried again rather than dropped for good.
    // Only a refused login (authFailure) parks a row in 'error' now; it
    // returns to 'active' the moment a sync or the nightly token check works.
    const retryBefore = new Date(Date.now() - RETRY_ERROR_MS);
    const r = await pool.query(
      `SELECT * FROM email_accounts
        WHERE (status = 'active' OR (status = 'error' AND (last_sync IS NULL OR last_sync < $1)))
          ${INBOX_SYNC_ENABLED ? '' : "AND provider <> 'gmail'"}`, [retryBefore]);
    if (!r.rows.length) return; // nothing syncable, say nothing
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
  // A department's staff mailbox is connected only to send from. Its inbox is
  // never read into the agent tables (migrations/007: university data stays
  // in university tables).
  try {
    const { pool } = require('../store');
    const u = (await pool.query(`SELECT role FROM users WHERE id = $1`, [account.user_id])).rows[0];
    if (u && ['university', 'university_admin'].includes(u.role)) return;
  } catch (_) { return; }
  // Gmail inbox sync is disabled — reading messages needs the RESTRICTED
  // gmail.readonly scope we no longer request. Skip Gmail accounts entirely so
  // nothing throws an insufficient-scope error. (Send still works via gmail.send.)
  // Silent skip. syncAccount is also called on demand from the email routes, so
  // logging here fired on every UI-triggered sync as well as every poll. The
  // disabled state is announced ONCE per process in startPoller instead.
  if (account.provider === 'gmail' && !INBOX_SYNC_ENABLED) return;
  // An Outlook mailbox connected send-only (the default) has no permission to
  // read: nothing to sync, and asking would fail every poll. Replies to pitches
  // still arrive through the Reply-To address. Synced once Mail.Read is granted
  // ("also read replies"). Unknown scopes (older rows) are tried as before.
  if ((account.provider === 'outlook' || account.provider === 'microsoft365') && Array.isArray(account.granted_scopes)
    && account.granted_scopes.length && !require('./providers/outlook').canReadFrom(account.granted_scopes)) return;
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
      result = await outlook.fetchMessages(access, refresh, account.sync_cursor, 50, { ownAddress: account.email_address });
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
    errorMsg = describeError(e);
    // Only a refused login means the agent has to reconnect. A Graph 504, a
    // throttle, a timeout or a network blip is ours to retry: the mailbox
    // stays 'active' and the next poll tries again. (Before, any one failure
    // set 'error' and the poller never looked at the mailbox again: one
    // Microsoft 504 on Nov 12 stopped an agent's inbox for good.)
    const auth = authFailure(e);
    if (auth) await emailStore.updateAccountStatus(account.id, 'error', new Date());
    else if (account.status === 'error') await emailStore.updateAccountStatus(account.id, 'error', new Date()); // retry clock
    console.error(`[emailSync] Sync failed for ${account.email_address}:`, errorMsg);
    require('./ourFault').record((account.provider || 'mail') + '-sync',
      auth
        ? `sync refused for ${account.email_address}; the login was refused, so it is retried hourly and the agent must reconnect if it keeps failing: ${errorMsg}`
        : `sync failed for ${account.email_address} (temporary, retried on the next poll): ${errorMsg}`, 'emailSync');
  } finally {
    await emailStore.logSyncFinish(logId, synced, errorMsg);
    syncLocks.delete(account.id);
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

// A failure the agent must fix by reconnecting: the provider refused the
// login itself. Everything else (5xx, 429, timeouts, resets, an empty Graph
// error) is temporary and retried.
const AUTH_REFUSED = /invalid_grant|invalid_client|unauthorized_client|interaction_required|consent_required|AADSTS(?:50076|50079|50173|500133|65001|70000|70008|700082|700084|7000215)|InvalidAuthenticationToken|token (?:has )?expired|token is expired|refresh token|access token is empty|Lifetime validation failed|unauthori[sz]ed|reconnect it/i;
function statusOfError(e) {
  if (!e) return 0;
  const s = Number(e.statusCode || e.status || e.code && /^\d{3}$/.test(String(e.code)) && e.code || 0);
  if (s) return s;
  const m = String(e.message || '').match(/\bHTTP (\d{3})\b/);
  return m ? Number(m[1]) : 0;
}
function authFailure(e) {
  const status = statusOfError(e);
  if (status === 401) return true;
  if (status >= 500 || status === 429 || status === 408) return false;
  const words = [e && e.message, e && e.code, e && e.body && (typeof e.body === 'string' ? e.body : JSON.stringify(e.body))].filter(Boolean).join(' ');
  return AUTH_REFUSED.test(words);
}
// Graph errors often carry an empty message ("UnknownError" with a 504):
// say what we know instead of nothing.
function describeError(e) {
  const msg = String((e && e.message) || '').trim();
  const status = statusOfError(e);
  const code = e && e.code && !/^\d+$/.test(String(e.code)) ? String(e.code) : '';
  const parts = [status ? 'HTTP ' + status : '', code, msg].filter(Boolean);
  return parts.length ? parts.join(': ') : 'no error message from the provider';
}

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
      // Microsoft rotates the refresh token; keep the new one.
      if (r.refreshToken) refreshToken = r.refreshToken;
    }
    // Save refreshed tokens
    await emailStore.updateAccountTokens(account.id, newAccess, refreshToken, newExpiry);
  } catch (e) {
    console.error('[emailSync] Token refresh failed:', e.message);
    // Ours or the provider's, never silent (services/ourFault): the fetch then
    // runs on an expired token and the account drops out of polling.
    require('./ourFault').record(account.provider === 'gmail' ? 'gmail-token' : 'outlook-token',
      'token refresh failed for ' + account.email_address + ': ' + e.message, 'emailSync');
    // A temporary failure at the token endpoint must not turn into a 401 on
    // the expired token and park the mailbox: fail this poll as temporary.
    if (!authFailure(e)) throw e;
  }

  return { access: newAccess, refresh: refreshToken, expiry: newExpiry };
}

// ── Background poller ────────────────────────────────────────────────────────

let pollerHandle = null;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const RETRY_ERROR_MS = 60 * 60 * 1000; // a mailbox in 'error' is retried hourly

function startPoller() {
  if (pollerHandle) return;
  console.log('[emailSync] Background poller started (interval: 5 min)');
  // The one and only line about the disabled state, per process start. Names the
  // REAL env var: the old message said "INBOX_SYNC_ENABLED=false", which is an
  // internal constant, not something anyone can set.
  if (!INBOX_SYNC_ENABLED) {
    console.log('[emailSync] Gmail inbox sync is OFF (set EMAIL_INBOX_SYNC=1 to enable). Gmail accounts are skipped; sending is unaffected.');
  }
  // Initial sync after 30 seconds (let server fully boot first)
  setTimeout(syncAllAccounts, 30 * 1000);
  pollerHandle = setInterval(syncAllAccounts, POLL_INTERVAL_MS);
}

function stopPoller() {
  if (pollerHandle) { clearInterval(pollerHandle); pollerHandle = null; }
}

module.exports = { syncAllAccounts, syncAccount, startPoller, stopPoller, INBOX_SYNC_ENABLED, authFailure, describeError, RETRY_ERROR_MS };
