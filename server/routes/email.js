// server/routes/email.js
// All /api/email/* routes for the email integration feature.
// Mounted in server/index.js with: app.use('/api/email', emailRoutes)
// Uses requireAuth middleware passed in from index.js.
// DOES NOT touch any existing routes, tables, or logic.

'use strict';

const express    = require('express');
const crypto     = require('crypto');
const router     = express.Router();
const emailStore = require('../services/emailStore');
const emailSync  = require('../services/emailSync');
const gmail      = require('../services/providers/gmail');
const outlook    = require('../services/providers/outlook');
const imap       = require('../services/providers/imap');
const { decrypt, encrypt } = require('../services/crypto');

// requireAuth is injected by server/index.js when mounting this router
// so all routes below are already protected.

// ── Account management ───────────────────────────────────────────────────────

/**
 * GET /api/email/accounts
 * Returns all connected email accounts for the logged-in user (no tokens).
 */
router.get('/accounts', async (req, res) => {
  try {
    const accounts = await emailStore.getEmailAccountsByUser(req.session.userId);
    // Attach last sync log to each account
    const enriched = await Promise.all(accounts.map(async acc => {
      const log = await emailStore.getLastSyncLog(acc.id);
      return { ...acc, lastSyncLog: log };
    }));
    res.json(enriched);
  } catch (e) {
    console.error('[email/accounts]', e.message);
    res.status(500).json({ error: 'Failed to load email accounts' });
  }
});

/**
 * DELETE /api/email/accounts/:id
 * Disconnect and remove an email account + all its data.
 */
router.delete('/accounts/:id', async (req, res) => {
  try {
    const account = await emailStore.getEmailAccount(req.params.id);
    if (!account || account.user_id !== req.session.userId) {
      return res.status(404).json({ error: 'Account not found' });
    }
    await emailStore.deleteEmailAccount(req.params.id, req.session.userId);
    res.json({ ok: true });
  } catch (e) {
    console.error('[email/accounts delete]', e.message);
    res.status(500).json({ error: 'Failed to disconnect account' });
  }
});

/**
 * POST /api/email/accounts/:id/sync
 * Trigger an on-demand sync for one account.
 */
router.post('/accounts/:id/sync', async (req, res) => {
  try {
    const { pool } = require('../store');
    const r = await pool.query('SELECT * FROM email_accounts WHERE id=$1 AND user_id=$2',
      [req.params.id, req.session.userId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Account not found' });
    // Fire-and-forget — don't await
    emailSync.syncAccount(r.rows[0]).catch(e =>
      console.error('[email/sync]', e.message)
    );
    res.json({ ok: true, message: 'Sync started' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to start sync' });
  }
});

// ── Gmail OAuth ──────────────────────────────────────────────────────────────

/**
 * GET /api/email/oauth/gmail
 * Redirect user to Google consent screen.
 */
router.get('/oauth/gmail', (req, res) => {
  if (!gmail.isAvailable()) {
    return res.status(501).json({
      error: 'Gmail integration not configured. Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET to environment variables.'
    });
  }
  try {
    const state = encodeState({ userId: req.session.userId, provider: 'gmail' });
    const url = gmail.getAuthUrl(state);
    res.redirect(url);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/email/oauth/gmail/callback
 * Handle Google OAuth callback and save account.
 */
router.get('/oauth/gmail/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    // All Google OAuth flows share this redirect URI (it's the only one registered in GCP).
    // Dispatch based on the `type` field encoded in the state parameter.
    const decodedState = decodeState(state);

    // Athlete Gmail send connect flow
    if (decodedState.type === 'athlete-gmail') {
      const qs = new URLSearchParams(req.query).toString();
      return res.redirect('/auth/google/athlete-gmail/callback?' + qs);
    }

    // Calendar OAuth flows (athlete calendar or agent calendar)
    if (decodedState.type === 'athlete' || decodedState.type === 'agent') {
      const qs = new URLSearchParams(req.query).toString();
      return res.redirect('/auth/google/calendar/callback?' + qs);
    }

    if (error) return res.redirect('/#settings?emailError=' + encodeURIComponent(error));

    const { userId } = decodeState(state);
    if (!userId) return res.status(400).send('Invalid state parameter');

    const tokens = await gmail.exchangeCode(code);
    const accountId = 'ea_' + crypto.randomBytes(8).toString('hex');

    await emailStore.saveEmailAccount(
      accountId, userId, 'gmail',
      tokens.email, tokens.displayName,
      tokens.accessToken, tokens.refreshToken, tokens.expiry
    );

    // Kick off initial sync async
    const { pool } = require('../store');
    const r = await pool.query('SELECT * FROM email_accounts WHERE id=$1', [accountId]);
    if (r.rows[0]) emailSync.syncAccount(r.rows[0]).catch(() => {});

    res.redirect('/#settings?emailConnected=gmail');
  } catch (e) {
    console.error('[gmail callback]', e.message);
    res.redirect('/#settings?emailError=' + encodeURIComponent(e.message));
  }
});

// ── Outlook OAuth ────────────────────────────────────────────────────────────

/**
 * GET /api/email/oauth/outlook
 * Redirect user to Microsoft consent screen.
 */
router.get('/oauth/outlook', async (req, res) => {
  if (!outlook.isAvailable()) {
    return res.status(501).json({
      error: 'Outlook integration not configured. Add OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET to environment variables.'
    });
  }
  try {
    const state = encodeState({ userId: req.session.userId, provider: 'outlook' });
    const url = await outlook.getAuthUrl(state);
    res.redirect(url);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/email/oauth/outlook/callback
 */
router.get('/oauth/outlook/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect('/#settings?emailError=' + encodeURIComponent(error));

    const { userId } = decodeState(state);
    if (!userId) return res.status(400).send('Invalid state parameter');

    const tokens = await outlook.exchangeCode(code);
    const accountId = 'ea_' + crypto.randomBytes(8).toString('hex');

    await emailStore.saveEmailAccount(
      accountId, userId, 'outlook',
      tokens.email, tokens.displayName,
      tokens.accessToken, tokens.refreshToken, tokens.expiry
    );

    const { pool } = require('../store');
    const r = await pool.query('SELECT * FROM email_accounts WHERE id=$1', [accountId]);
    if (r.rows[0]) emailSync.syncAccount(r.rows[0]).catch(() => {});

    res.redirect('/#settings?emailConnected=outlook');
  } catch (e) {
    console.error('[outlook callback]', e.message);
    res.redirect('/#settings?emailError=' + encodeURIComponent(e.message));
  }
});

// ── IMAP / SMTP (generic) ────────────────────────────────────────────────────

/**
 * POST /api/email/connect/imap
 * Body: { emailAddress, password, imapHost?, imapPort?, smtpHost?, smtpPort?, displayName? }
 * Tests connection, saves account.
 */
router.post('/connect/imap', async (req, res) => {
  try {
    if (!imap.isAvailable()) {
      return res.status(501).json({ error: 'IMAP support not installed. Contact support.' });
    }
    const { emailAddress, password, imapHost, imapPort, smtpHost, smtpPort, displayName } = req.body;
    if (!emailAddress || !password) return res.status(400).json({ error: 'Email and password required' });

    // Test connection before saving
    await imap.testConnection(emailAddress, password, imapHost, imapPort, smtpHost, smtpPort);

    const accountId = 'ea_' + crypto.randomBytes(8).toString('hex');
    const imapConfig = { imapHost, imapPort, smtpHost, smtpPort };

    // For IMAP: store password as accessToken, imapConfig as refreshToken (both encrypted)
    await emailStore.saveEmailAccount(
      accountId, req.session.userId, 'imap',
      emailAddress, displayName || emailAddress,
      password,                         // access_token_enc = password (encrypted)
      JSON.stringify(imapConfig),       // refresh_token_enc = config JSON (encrypted)
      null
    );

    res.json({ ok: true, accountId });
  } catch (e) {
    console.error('[email/connect/imap]', e.message);
    res.status(400).json({ error: e.message || 'Connection failed' });
  }
});

/**
 * GET /api/email/imap/presets
 * Returns well-known IMAP/SMTP settings for common providers (no credentials).
 */
router.get('/imap/presets', (req, res) => {
  res.json({
    'yahoo.com':    { imap: { host: 'imap.mail.yahoo.com',  port: 993 }, smtp: { host: 'smtp.mail.yahoo.com',  port: 587 } },
    'icloud.com':   { imap: { host: 'imap.mail.me.com',      port: 993 }, smtp: { host: 'smtp.mail.me.com',    port: 587 } },
    'me.com':       { imap: { host: 'imap.mail.me.com',      port: 993 }, smtp: { host: 'smtp.mail.me.com',    port: 587 } },
    'outlook.com':  { imap: { host: 'outlook.office365.com', port: 993 }, smtp: { host: 'smtp.office365.com',  port: 587 } },
    'hotmail.com':  { imap: { host: 'outlook.office365.com', port: 993 }, smtp: { host: 'smtp.office365.com',  port: 587 } },
    'aol.com':      { imap: { host: 'imap.aol.com',          port: 993 }, smtp: { host: 'smtp.aol.com',        port: 587 } },
  });
});

// ── Inbox / threads ──────────────────────────────────────────────────────────

/**
 * GET /api/email/threads?limit=50&offset=0
 */
router.get('/threads', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    const threads = await emailStore.getThreadsByUser(req.session.userId, limit, offset);
    res.json(threads);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load threads' });
  }
});

/**
 * GET /api/email/threads/:id/messages
 */
router.get('/threads/:id/messages', async (req, res) => {
  try {
    const { pool } = require('../store');
    // Verify thread belongs to user
    const tr = await pool.query('SELECT * FROM email_threads WHERE id=$1 AND user_id=$2',
      [req.params.id, req.session.userId]);
    if (!tr.rows[0]) return res.status(404).json({ error: 'Thread not found' });

    const messages = await emailStore.getEmailsByThread(req.params.id, req.session.userId);
    res.json(messages);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

/**
 * POST /api/email/threads/:id/read
 * Mark all messages in thread as read.
 */
router.post('/threads/:id/read', async (req, res) => {
  try {
    await emailStore.markThreadRead(req.params.id, req.session.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

// ── Athlete email timeline ───────────────────────────────────────────────────

/**
 * GET /api/email/athlete/:athleteId
 * Returns emails associated with a specific athlete (for CRM timeline).
 */
router.get('/athlete/:athleteId', async (req, res) => {
  try {
    const emails = await emailStore.getEmailsByAthlete(req.params.athleteId, req.session.userId);
    const threads = await emailStore.getThreadsByAthlete(req.params.athleteId, req.session.userId);
    res.json({ emails, threads });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load athlete emails' });
  }
});

// ── Send email ───────────────────────────────────────────────────────────────

/**
 * POST /api/email/send
 * Body: { accountId, to[], cc[], subject, bodyHtml, threadId? }
 */
router.post('/send', async (req, res) => {
  try {
    const { accountId, to, cc, subject, bodyHtml, threadId } = req.body;
    if (!accountId || !to || !subject) {
      return res.status(400).json({ error: 'accountId, to, and subject are required' });
    }

    const account = await emailStore.getEmailAccountWithTokens(accountId);
    if (!account || account.user_id !== req.session.userId) {
      return res.status(404).json({ error: 'Account not found' });
    }

    let result;
    if (account.provider === 'gmail') {
      result = await gmail.sendEmail(account.accessToken, account.refreshToken,
        { to, cc, subject, bodyHtml, threadId });
    } else if (account.provider === 'outlook' || account.provider === 'microsoft365') {
      result = await outlook.sendEmail(account.accessToken, account.refreshToken,
        { to, cc, subject, bodyHtml, threadId });
    } else {
      // IMAP — password in accessToken, config in refreshToken
      const imapConfig = account.refreshToken ? JSON.parse(account.refreshToken) : {};
      result = await imap.sendEmail(account.email_address, account.accessToken, imapConfig,
        { to, cc, subject, bodyHtml, threadId });
    }

    // Save sent message locally
    const crm = require('./crmAssociation');
    const athleteEmailMap = await crm.buildAthleteEmailMap(req.session.userId);
    const allAddresses = [...(Array.isArray(to) ? to : [to]), ...(cc || [])];
    let athleteId = null;
    for (const addr of allAddresses) {
      const normalized = addr.replace(/<.+>/, '').trim().toLowerCase();
      if (athleteEmailMap[normalized]) { athleteId = athleteEmailMap[normalized]; break; }
    }

    const msgId = 'msg_sent_' + crypto.randomBytes(8).toString('hex');
    const threadKey = require('../services/emailSync').deriveThreadKey
      ? null
      : ('thr_' + crypto.createHash('sha1').update(accountId + ':' + (result.providerThreadId || msgId)).digest('hex').slice(0, 20));

    // Simple save of sent message
    await emailStore.saveEmail({
      id: msgId,
      threadId: threadKey,
      accountId,
      userId: req.session.userId,
      direction: 'sent',
      fromAddress: account.email_address,
      fromName: account.display_name,
      toAddresses: Array.isArray(to) ? to : [to],
      ccAddresses: cc || [],
      subject,
      bodyText: bodyHtml ? bodyHtml.replace(/<[^>]+>/g, '') : '',
      bodyHtml,
      providerMessageId: result.providerMessageId || msgId,
      providerThreadId:  result.providerThreadId,
      sentAt: new Date(),
      isRead: true,
      hasAttachments: false,
      athleteId,
      dealId: null,
    }).catch(() => {}); // non-fatal if save fails

    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[email/send]', e.message);
    res.status(500).json({ error: e.message || 'Failed to send email' });
  }
});

// ── Drafts ───────────────────────────────────────────────────────────────────

router.get('/drafts', async (req, res) => {
  try {
    const drafts = await emailStore.getDraftsByUser(req.session.userId);
    res.json(drafts);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load drafts' });
  }
});

router.post('/drafts', async (req, res) => {
  try {
    const id = req.body.id || ('dft_' + crypto.randomBytes(8).toString('hex'));
    await emailStore.saveDraft({ id, userId: req.session.userId, ...req.body });
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save draft' });
  }
});

router.delete('/drafts/:id', async (req, res) => {
  try {
    await emailStore.deleteDraft(req.params.id, req.session.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete draft' });
  }
});

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * GET /api/email/search?q=nike&limit=30
 */
router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const results = await emailStore.searchEmails(req.session.userId, q, limit);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── Utility ──────────────────────────────────────────────────────────────────

function encodeState(obj) {
  const json = JSON.stringify(obj);
  return Buffer.from(json).toString('base64url');
}

function decodeState(state) {
  if (!state) return {};
  try {
    return JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch { return {}; }
}

module.exports = router;
