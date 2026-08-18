// server/routes/outreach.js
// All /api/outreach/* endpoints for the NIL Outreach Automation Engine.
// Mounted in server/index.js after all existing routes.
// All routes protected by requireAuth (injected at mount point).
//
// SAFETY: does not modify or import any existing route files.
//         does not alter athletes, deals, or email routes.

'use strict';

const express      = require('express');
const router       = express.Router();
const { pool, markChecklistItem } = require('../store');
const orchestrator = require('../services/workflowOrchestrator');
const enrichmentSvc = require('../services/companyEnrichment');
const contactSvc   = require('../services/contactDiscovery');
const matchSvc     = require('../services/athleteBrandMatch');
const pitchSvc     = require('../services/pitchGeneration');
const deckSvc      = require('../services/deckGeneration');
const followUpSvc  = require('../services/followUpAutomation');
const path         = require('path');
const fs           = require('fs');

// ── Feature flag ──────────────────────────────────────────────────────────────
function checkEnabled(req, res, next) {
  if (process.env.OUTREACH_ENGINE_ENABLED === 'false') {
    return res.status(503).json({ error: 'Outreach engine is disabled.' });
  }
  next();
}
router.use(checkEnabled);

// Who is calling. An agent arrives with a session cookie; a self-managed athlete
// arrives with the same JWT the rest of her portal uses. Everything below reads
// req.principal rather than req.session.userId, so no handler can quietly assume
// the caller is an agent -- which is exactly what /run did.
function requirePrincipal(req, res, next) {
  if (req.session && req.session.userId) {
    req.principal = { kind: 'agent', id: req.session.userId };
    return next();
  }
  if (req.athletePrincipalId) {
    req.principal = { kind: 'athlete', id: req.athletePrincipalId };
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
}
router.use(requirePrincipal);

// Resolve the athlete this request is about.
//
// AN ATHLETE IS THE SUBJECT, NOT A PARAMETER. When the caller is an athlete she is
// the athlete, whatever the body says: a body athleteId naming someone else is
// ignored, and omitting it is fine. An agent must still name one, and must still
// own it -- that isolation is unchanged.
async function resolveAthleteFor(principal, bodyAthleteId) {
  if (principal.kind === 'athlete') {
    if (bodyAthleteId && String(bodyAthleteId) !== String(principal.id)) {
      console.warn(`[outreach] athlete=${principal.id}: body named athleteId ${bodyAthleteId}, using the caller's own id`);
    }
    const r = await pool.query('SELECT * FROM athletes WHERE id=$1', [principal.id]);
    return r.rows[0] || null;
  }
  if (!bodyAthleteId) return null;
  const r = await pool.query('SELECT * FROM athletes WHERE id=$1 AND agent_id=$2', [bodyAthleteId, principal.id]);
  return r.rows[0] || null;
}

// Whitelist the fields of a client-supplied contact ladder. This value comes from
// the browser, and it ends up in brand_contacts, so it is copied field by field
// rather than passed through: never an email that is not an email, never a name
// long enough to be a payload, never an extra column smuggled in.
function _safeKnownContacts(v) {
  if (!v || typeof v !== 'object') return null;
  const str = (x, max) => {
    const s = (x == null) ? '' : String(x).trim();
    return s && s.length <= max ? s : null;
  };
  const email = (x) => {
    const s = str(x, 200);
    return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.toLowerCase() : null;
  };
  const contacts = (Array.isArray(v.contacts) ? v.contacts : []).slice(0, 10).map((c) => ({
    name:  str(c && c.name, 120),
    title: str(c && c.title, 160),
    email: email(c && c.email),
    phone: str(c && c.phone, 40),
    linkedinUrl: (() => { const s = str(c && c.linkedinUrl, 300); return s && /^https?:\/\//i.test(s) ? s : null; })(),
    sourceUrl:   (() => { const s = str(c && c.sourceUrl, 400);   return s && /^https?:\/\//i.test(s) ? s : null; })(),
  })).filter((c) => c.name || c.email || c.phone);
  const out = {
    contacts,
    businessPhone: str(v.businessPhone, 40),
    genericInbox: email(v.genericInbox),
  };
  return (out.contacts.length || out.businessPhone) ? out : null;
}

// ── Workflow ───────────────────────────────────────────────────────────────────

/**
 * POST /api/outreach/run
 * Kick off the full automation workflow for one deal scan result.
 * Body: { athleteId, dealScanResult: { brand, campaign, category, ... } }
 * Returns: { runId } immediately — poll /runs/:runId for status.
 */
router.post('/run', async (req, res) => {
  try {
    const { athleteId, dealScanResult, knownContacts } = req.body;
    if (!dealScanResult?.brand) {
      return res.status(400).json({ error: 'dealScanResult.brand required' });
    }
    // An agent still has to say who this is for; an athlete is already the answer.
    if (req.principal.kind === 'agent' && !athleteId) {
      return res.status(400).json({ error: 'athleteId and dealScanResult.brand required' });
    }

    const row = await resolveAthleteFor(req.principal, athleteId);
    if (!row) return res.status(404).json({ error: 'Athlete not found' });

    const athlete = { ...row, ...row.data };

    const { runId } = await orchestrator.runOutreachWorkflow({
      // The OWNER key for everything this run writes. For an agent it is his user
      // id, exactly as before; for a self-managed athlete it is her own id, so her
      // runs, contacts and drafts are scoped to her and no agent can read them.
      agentId: req.principal.id,
      owner: req.principal,
      athlete,
      dealScanResult,
      // The contact ladder the card already resolved. Sent by the client so the
      // workflow does not re-run the same 6-source fan-out the expand just paid
      // for. Shape-checked rather than trusted: only the three fields the
      // resolver produces are forwarded, so an odd client payload cannot become
      // a contact record.
      knownContacts: _safeKnownContacts(knownContacts),
    });

    res.json({ runId, status: 'running', message: 'Outreach workflow started' });
  } catch (e) {
    console.error('[outreach/run]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/outreach/draft?athleteId=&brandKey=&brand=
 * The pre-warmed draft for one athlete + business, or 404.
 *
 * This is what makes AI Outreach instant: the modal asks here FIRST and renders
 * immediately on a hit. A miss is not an error condition, it is the normal path for
 * a card whose pre-warm has not finished (or failed the specificity check), and the
 * modal falls straight through to POST /run exactly as it did before.
 *
 * brandKey is preferred; brand name is accepted as a fallback so a card that lost
 * its key can still find its draft.
 */
router.get('/draft', async (req, res) => {
  try {
    const athleteId = String(req.query.athleteId || '').trim();
    const brandKey  = String(req.query.brandKey || '').trim();
    const brand     = String(req.query.brand || '').trim();
    if (!athleteId || (!brandKey && !brand)) {
      return res.status(400).json({ error: 'athleteId and brandKey (or brand) required' });
    }
    // Scoped to the signed-in agent as well as the athlete: a draft is an agent's
    // own work and must not be readable by another agent who happens to know the
    // athlete id.
    const r = brandKey
      ? await pool.query(
          `SELECT * FROM outreach_logs
           WHERE agent_id=$1 AND athlete_id=$2 AND brand_key=$3 AND status='draft'
           ORDER BY created_at DESC LIMIT 1`, [req.principal.id, athleteId, brandKey])
      : await pool.query(
          `SELECT * FROM outreach_logs
           WHERE agent_id=$1 AND athlete_id=$2 AND LOWER(brand_name)=LOWER($3) AND status='draft'
           ORDER BY created_at DESC LIMIT 1`, [req.principal.id, athleteId, brand]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'no draft yet' });
    res.json({
      id: row.id, subject: row.subject, body_html: row.body_html,
      brand_name: row.brand_name, brand_key: row.brand_key,
      source: row.source || null, created_at: row.created_at,
    });
  } catch (e) {
    console.error('[outreach/draft]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/outreach/runs/:runId
 * Poll for workflow status + all generated artifacts.
 */
router.get('/runs/:runId', async (req, res) => {
  try {
    const data = await orchestrator.getRunStatus(req.params.runId);
    if (!data) return res.status(404).json({ error: 'Run not found' });
    if (data.run.agent_id !== req.principal.id) return res.status(403).json({ error: 'Forbidden' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/outreach/runs
 * List recent workflow runs for the agent.
 */
router.get('/runs', async (req, res) => {
  try {
    const runs = await orchestrator.listRunsForAgent(req.principal.id, 20);
    res.json(runs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Enrichment ────────────────────────────────────────────────────────────────

/**
 * POST /api/outreach/enrich
 * Body: { brandName, hintData? }
 */
router.post('/enrich', async (req, res) => {
  try {
    const { brandName, hintData } = req.body;
    if (!brandName) return res.status(400).json({ error: 'brandName required' });
    const result = await enrichmentSvc.enrich(req.principal.id, brandName, hintData || {});
    res.json(result);
  } catch (e) {
    console.error('[outreach/enrich]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/outreach/enrichments
 * List all enrichments for the agent.
 */
router.get('/enrichments', async (req, res) => {
  try {
    const results = await enrichmentSvc.listForAgent(req.principal.id);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Contacts ──────────────────────────────────────────────────────────────────

/**
 * GET /api/outreach/contacts/:enrichmentId
 * Returns discovered contacts for an enrichment record.
 */
router.get('/contacts/:enrichmentId', async (req, res) => {
  try {
    const enrichment = await enrichmentSvc.getById(req.params.enrichmentId);
    if (!enrichment || enrichment.agent_id !== req.principal.id) {
      return res.status(404).json({ error: 'Enrichment not found' });
    }
    const contacts = await contactSvc.getByEnrichmentId(req.params.enrichmentId);
    res.json(contacts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Pitch ──────────────────────────────────────────────────────────────────────

/**
 * POST /api/outreach/pitch
 * Generate a pitch on-demand (outside of full workflow).
 * Body: { athleteId, enrichmentId, contactId? }
 */
router.post('/pitch', async (req, res) => {
  try {
    const { athleteId, enrichmentId, contactId } = req.body;
    if (!athleteId || !enrichmentId) return res.status(400).json({ error: 'athleteId and enrichmentId required' });

    const [ar, enrichment] = await Promise.all([
      resolveAthleteFor(req.principal, athleteId),
      enrichmentSvc.getById(enrichmentId),
    ]);
    if (!ar) return res.status(404).json({ error: 'Athlete not found' });
    if (!enrichment || enrichment.agent_id !== req.principal.id) return res.status(404).json({ error: 'Enrichment not found' });

    const athlete = ar;
    const matchScore = await matchSvc.matchAthleteToBrand(req.principal.id, athlete, enrichment);
    const contact = contactId ? await contactSvc.getById(contactId) : await contactSvc.getBestContact(req.principal.id, enrichmentId);

    // An athlete pitching for herself is not in the users table; she signs it.
    const senderRow = req.principal.kind === 'athlete'
      ? await pool.query(`SELECT data->>'name' AS name, email FROM athletes WHERE id=$1`, [req.principal.id])
      : await pool.query('SELECT name, email FROM users WHERE id=$1', [req.principal.id]);
    const agentName  = senderRow.rows[0]?.name  || null;
    const agentEmail = senderRow.rows[0]?.email || null;

    const pitch = await pitchSvc.generatePitch({ athlete, enrichment, matchScore, contact, dealScanData: {}, agentName, agentEmail });

    // Attach the brand-personalized media kit link automatically when one exists
    try {
      const mkR = await pool.query('SELECT slug, variants FROM media_kits WHERE athlete_id=$1', [athleteId]);
      const mk = mkR.rows[0];
      const brandSlug = String(enrichment.brand_name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      if (mk && mk.slug && mk.variants && mk.variants[brandSlug]) {
        const appUrl = process.env.APP_URL || 'https://mynildash.com';
        const kitUrl = `${appUrl}/media-kit/${mk.slug}?for=${brandSlug}`;
        const athleteFirst = String(athlete.data && athlete.data.name || '').split(/\s+/)[0] || 'the athlete';
        const psLine = `<p>P.S. Here is ${athleteFirst}'s media kit, put together for ${enrichment.brand_name}: <a href="${kitUrl}">${kitUrl}</a></p>`;
        if (pitch && typeof pitch.body_html === 'string') pitch.body_html += psLine;
        else if (pitch && typeof pitch.body === 'string') pitch.body += `\n\nP.S. Here is ${athleteFirst}'s media kit, put together for ${enrichment.brand_name}: ${kitUrl}`;
        if (pitch) pitch.kitUrl = kitUrl;
      }
    } catch (kitErr) { /* attach is best-effort, never blocks the pitch */ }

    res.json(pitch);
  } catch (e) {
    console.error('[outreach/pitch]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Decks ──────────────────────────────────────────────────────────────────────

/**
 * GET /api/outreach/decks/:deckId/download
 * Download a generated PDF deck.
 */
router.get('/decks/:deckId/download', async (req, res) => {
  try {
    const deck = await deckSvc.getDeckById(req.params.deckId);
    if (!deck || deck.agent_id !== req.principal.id) {
      return res.status(404).json({ error: 'Deck not found' });
    }
    if (!deck.file_path || !fs.existsSync(deck.file_path)) {
      return res.status(404).json({ error: 'PDF file not available (ephemeral storage may have been cleared)' });
    }
    const filename = `${deck.brand_name.replace(/[^a-z0-9]/gi, '_')}_NilPitch_v${deck.version}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    fs.createReadStream(deck.file_path).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Outreach logs ─────────────────────────────────────────────────────────────

/**
 * GET /api/outreach/logs
 * List all outreach logs for the agent.
 */
router.get('/logs', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ol.*, bc.name as contact_name, bc.email as contact_email
       FROM outreach_logs ol
       LEFT JOIN brand_contacts bc ON ol.contact_id = bc.id
       WHERE ol.agent_id=$1
       ORDER BY ol.created_at DESC LIMIT 50`,
      [req.principal.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/outreach/logs/:id
 */
router.get('/logs/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM outreach_logs WHERE id=$1 AND agent_id=$2', [req.params.id, req.principal.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/outreach/logs/:id/send
 * Mark outreach as sent and trigger the actual email via the existing email system.
 * Body: { emailAccountId, toEmail }
 */
router.post('/logs/:id/send', async (req, res) => {
  try {
    const { emailAccountId, toEmail } = req.body;
    const r = await pool.query('SELECT * FROM outreach_logs WHERE id=$1 AND agent_id=$2', [req.params.id, req.principal.id]);
    const log = r.rows[0];
    if (!log) return res.status(404).json({ error: 'Outreach log not found' });
    if (log.status === 'sent') return res.status(400).json({ error: 'Already sent' });

    if (!emailAccountId || !toEmail) {
      return res.status(400).json({ error: 'emailAccountId and toEmail required' });
    }

    // Call the existing /api/email/send endpoint logic (reuse without importing — call via fetch)
    // We delegate to the existing email service to avoid any coupling
    const sendResult = await sendViaEmailService(req, emailAccountId, toEmail, log);

    await pool.query(
      `UPDATE outreach_logs
       SET status='sent', sent_at=NOW(), email_account_id=$1,
           email_message_id=$2, updated_at=NOW()
       WHERE id=$3`,
      [emailAccountId, sendResult?.providerMessageId || null, log.id]
    );

    // Log workflow event
    pool.query(
      `INSERT INTO workflow_events (run_id, agent_id, event_type, payload) VALUES (NULL,$1,$2,$3)`,
      [req.principal.id, 'email_sent', JSON.stringify({ outreachId: log.id, brand: log.brand_name, to: toEmail })]
    ).catch(() => {});

    // Getting Started checklist: first AI outreach email sent
    // The onboarding checklist is an agent artefact; an athlete has no row in it.
    if (req.principal.kind === 'agent') markChecklistItem(req.principal.id, 'ai_outreach').catch(() => {});

    res.json({ ok: true, message: 'Email sent successfully' });
  } catch (e) {
    console.error('[outreach/send]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/outreach/logs/:id
 * Update subject/body before sending (user edits the draft).
 */
router.patch('/logs/:id', async (req, res) => {
  try {
    const { subject, body_html } = req.body;
    const r = await pool.query(
      `UPDATE outreach_logs SET subject=$1, body_html=$2, updated_at=NOW()
       WHERE id=$3 AND agent_id=$4 AND status='draft'
       RETURNING *`,
      [subject, body_html, req.params.id, req.principal.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Draft not found or already sent' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/outreach/logs/:id/replied
 * Manual reply tracking. Body: { replied: boolean }.
 * replied=true sets replied_at + status='replied' (via the existing markReplied),
 * which the follow-up poller already respects (it only nudges rows with
 * replied_at IS NULL), so nudges stop once an outreach is marked replied.
 * replied=false reverts to 'sent' so a mistaken mark can be undone.
 */
router.post('/logs/:id/replied', async (req, res) => {
  try {
    const replied = req.body.replied !== false; // default true
    // Ownership + must already be sent.
    const r = await pool.query(
      'SELECT id, status FROM outreach_logs WHERE id=$1 AND agent_id=$2',
      [req.params.id, req.principal.id]
    );
    const log = r.rows[0];
    if (!log) return res.status(404).json({ error: 'Outreach not found' });
    if (replied) {
      if (log.status === 'draft') return res.status(400).json({ error: 'Send this outreach before marking it replied' });
      await followUpSvc.markReplied(log.id);
    } else {
      // Undo: clear the reply and return the row to sent so the agent can track it again.
      await pool.query(
        `UPDATE outreach_logs SET replied_at=NULL, status='sent', updated_at=NOW() WHERE id=$1 AND agent_id=$2`,
        [log.id, req.principal.id]
      );
    }
    const out = await pool.query('SELECT * FROM outreach_logs WHERE id=$1', [log.id]);
    res.json(out.rows[0]);
  } catch (e) {
    console.error('[outreach/replied]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Follow-ups ────────────────────────────────────────────────────────────────

/**
 * GET /api/outreach/follow-ups
 * Returns outreach records that need follow-up attention.
 */
router.get('/follow-ups', async (req, res) => {
  try {
    const due = await followUpSvc.getFollowUpsDue(req.principal.id);
    res.json(due);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Internal helper: delegate email send to existing service ──────────────────

async function sendViaEmailService(req, emailAccountId, toEmail, log) {
  // KNOWN GAP, stated rather than hidden. An athlete's mailbox is gmail_refresh_token
  // ON HER athletes row, not a row in email_accounts (that table keys on user_id).
  // Generating and drafting now work for her; SENDING through this route does not
  // yet, and would otherwise fail as a confusing "Email account not found".
  if (req.principal.kind === 'athlete') {
    throw new Error('Sending from the outreach engine is not wired to athlete mailboxes yet. Copy the draft and send it from your own email, or use the Instagram DM above.');
  }
  const emailStore = require('../services/emailStore');
  const account = await emailStore.getEmailAccountWithTokens(emailAccountId);
  if (!account || account.user_id !== req.principal.id) throw new Error('Email account not found');

  const accessToken  = account.accessToken  || null;
  const refreshToken = account.refreshToken || null;

  // ── Load deck PDF as attachment if available ──────────────────────────────
  let attachments = [];
  if (log.deck_id) {
    try {
      const deckSvc = require('../services/deckGeneration');
      const deck = await deckSvc.getDeckById(log.deck_id);
      if (deck?.file_path && fs.existsSync(deck.file_path)) {
        const pdfData = fs.readFileSync(deck.file_path).toString('base64');
        const safeName = `${(log.brand_name || 'NIL').replace(/[^a-z0-9]/gi, '_')}_PitchDeck.pdf`;
        attachments = [{ filename: safeName, mimeType: 'application/pdf', data: pdfData }];
        console.log('[outreach/send] Attaching deck PDF:', safeName);
      } else {
        console.warn('[outreach/send] Deck file not found on disk (ephemeral storage cleared?)');
      }
    } catch (e) {
      console.warn('[outreach/send] Could not load deck for attachment:', e.message);
    }
  }

  let result;
  if (account.provider === 'gmail') {
    const gmail = require('../services/providers/gmail');
    result = await gmail.sendEmail(accessToken, refreshToken, {
      to: [toEmail], subject: log.subject, bodyHtml: log.body_html, attachments,
    });
  } else if (account.provider === 'outlook' || account.provider === 'microsoft365') {
    const outlook = require('../services/providers/outlook');
    result = await outlook.sendEmail(accessToken, refreshToken, {
      to: [toEmail], subject: log.subject, bodyHtml: log.body_html, attachments,
    });
  } else {
    const imapProvider = require('../services/providers/imap');
    const imapConfig = refreshToken ? JSON.parse(refreshToken) : {};
    result = await imapProvider.sendEmail(account.email_address, accessToken, imapConfig, {
      to: [toEmail], subject: log.subject, bodyHtml: log.body_html,
    });
  }
  return result;
}

module.exports = router;
