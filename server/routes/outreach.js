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

// ── Workflow ───────────────────────────────────────────────────────────────────

/**
 * POST /api/outreach/run
 * Kick off the full automation workflow for one deal scan result.
 * Body: { athleteId, dealScanResult: { brand, campaign, category, ... } }
 * Returns: { runId } immediately — poll /runs/:runId for status.
 */
router.post('/run', async (req, res) => {
  try {
    const { athleteId, dealScanResult } = req.body;
    if (!athleteId || !dealScanResult?.brand) {
      return res.status(400).json({ error: 'athleteId and dealScanResult.brand required' });
    }

    // Load athlete
    const ar = await pool.query(
      'SELECT * FROM athletes WHERE id=$1 AND agent_id=$2',
      [athleteId, req.session.userId]
    );
    if (!ar.rows[0]) return res.status(404).json({ error: 'Athlete not found' });

    const athlete = { ...ar.rows[0], ...ar.rows[0].data };

    const { runId } = await orchestrator.runOutreachWorkflow({
      agentId: req.session.userId,
      athlete,
      dealScanResult,
    });

    res.json({ runId, status: 'running', message: 'Outreach workflow started' });
  } catch (e) {
    console.error('[outreach/run]', e.message);
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
    if (data.run.agent_id !== req.session.userId) return res.status(403).json({ error: 'Forbidden' });
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
    const runs = await orchestrator.listRunsForAgent(req.session.userId, 20);
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
    const result = await enrichmentSvc.enrich(req.session.userId, brandName, hintData || {});
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
    const results = await enrichmentSvc.listForAgent(req.session.userId);
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
    if (!enrichment || enrichment.agent_id !== req.session.userId) {
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
      pool.query('SELECT * FROM athletes WHERE id=$1 AND agent_id=$2', [athleteId, req.session.userId]),
      enrichmentSvc.getById(enrichmentId),
    ]);
    if (!ar.rows[0]) return res.status(404).json({ error: 'Athlete not found' });
    if (!enrichment || enrichment.agent_id !== req.session.userId) return res.status(404).json({ error: 'Enrichment not found' });

    const athlete = ar.rows[0];
    const matchScore = await matchSvc.matchAthleteToBrand(req.session.userId, athlete, enrichment);
    const contact = contactId ? await contactSvc.getById(contactId) : await contactSvc.getBestContact(req.session.userId, enrichmentId);

    const agentRow = await pool.query('SELECT name, email FROM users WHERE id=$1', [req.session.userId]);
    const agentName  = agentRow.rows[0]?.name  || null;
    const agentEmail = agentRow.rows[0]?.email || null;

    const pitch = await pitchSvc.generatePitch({ athlete, enrichment, matchScore, contact, dealScanData: {}, agentName, agentEmail });
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
    if (!deck || deck.agent_id !== req.session.userId) {
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
      [req.session.userId]
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
    const r = await pool.query('SELECT * FROM outreach_logs WHERE id=$1 AND agent_id=$2', [req.params.id, req.session.userId]);
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
    const r = await pool.query('SELECT * FROM outreach_logs WHERE id=$1 AND agent_id=$2', [req.params.id, req.session.userId]);
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
      [req.session.userId, 'email_sent', JSON.stringify({ outreachId: log.id, brand: log.brand_name, to: toEmail })]
    ).catch(() => {});

    // Getting Started checklist: first AI outreach email sent
    markChecklistItem(req.session.userId, 'ai_outreach').catch(() => {});

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
      [subject, body_html, req.params.id, req.session.userId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Draft not found or already sent' });
    res.json(r.rows[0]);
  } catch (e) {
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
    const due = await followUpSvc.getFollowUpsDue(req.session.userId);
    res.json(due);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Internal helper: delegate email send to existing service ──────────────────

async function sendViaEmailService(req, emailAccountId, toEmail, log) {
  const emailStore = require('../services/emailStore');
  const account = await emailStore.getEmailAccountWithTokens(emailAccountId);
  if (!account || account.user_id !== req.session.userId) throw new Error('Email account not found');

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
