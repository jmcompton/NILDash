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
const replyCapture = require('../services/replyCapture');
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
    // Refused rather than flagged: no draft is created. See pitchGeneration.
    if (pitch && pitch.refused) {
      return res.status(422).json({
        error: 'pitch_refused', reasons: pitch.reasons || [],
        message: pitch.message || 'The writer could not produce this pitch without naming a price or inventing a detail about the athlete, so no draft was written.',
      });
    }

    // Attach the brand-personalized media kit link automatically when one exists
    try {
      const mkR = await pool.query('SELECT slug, variants FROM media_kits WHERE athlete_id=$1', [athleteId]);
      const mk = mkR.rows[0];
      const brandSlug = String(enrichment.brand_name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      if (mk && mk.slug && mk.variants && mk.variants[brandSlug]) {
        const appUrl = process.env.APP_URL || 'https://mynildash.com';
        const kitUrl = `${appUrl}/media-kit/${mk.slug}?for=${brandSlug}`;
        const athleteFirst = String(athlete.data && athlete.data.name || '').split(/\s+/)[0];
        if (!athleteFirst) throw new Error('no athlete name for the media kit line');
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
 * Body: { emailAccountId, toEmail }
 *
 * ── THE BUTTON ANSWERS AT ONCE; THE EMAIL GOES BEHIND IT ─────────────────
 * This used to wait for Gmail / Outlook / SMTP before answering, so a slow
 * provider was a frozen page: an agent gave up on a send that went out nine
 * minutes later. Now the request checks the rules, CLAIMS the draft and
 * answers 202 { state: 'sending' } in milliseconds. The send runs after the
 * response; GET /logs/:id/send-status says sending, sent, or failed with a
 * sentence the agent can act on, and the editor polls it.
 *
 * ── SAFE TO CALL TWICE ────────────────────────────────────────────────────
 * The claim is one UPDATE on a draft nobody is sending (send_claimed_at, the
 * same column the release queue claims with). A second click, a retry, or the
 * release queue reaching the same row cannot get it while the first send is
 * in flight: it is answered with the state of the send already running.
 * It used to read status, send, and only then write 'sent', so two clicks
 * inside a slow send both passed the check and both emailed the business.
 */
const CLAIM_STALE_MINUTES = 15;   // as the release queue: a claim older than this was a crash

// The send itself, swappable by tests that mount this router.
router._sendImpl = (ctx, emailAccountId, toEmail, log) => sendViaEmailService(ctx, emailAccountId, toEmail, log);

// The same classifier the release queue uses, so a failure reads the same.
function failureSentence(e) {
  if (e && e.code === 'CANSPAM_UNCONFIGURED') return { msg: e.message, reason: 'can-spam' };
  const sendGuard = require('../services/sendGuard');
  const c = sendGuard.classifyError(e);
  const mine = /^SCOPE_MISSING: /.test((e && e.message) || '');
  const msg = mine ? e.message.replace(/^SCOPE_MISSING: /, '')
    : (c.kind === 'other' ? ((e && e.message) || 'the send failed') : c.detail);
  return { msg, reason: mine ? 'scope' : c.kind };
}

async function runManualSend(ctx, log, emailAccountId, toEmail) {
  const sendRules = require('../services/sendRules');
  const system = Number(log.touch_no || 1) > 1 ? 'follow-up' : 'manual';
  let sendResult;
  try {
    sendResult = await router._sendImpl(ctx, emailAccountId, toEmail, log);
  } catch (e) {
    const f = failureSentence(e);
    console.error('[outreach/send]', log.id, e && e.message);
    // ON THE DRAFT, where the editor and the card read it. The claim goes, so
    // the agent can fix the cause and press Send again.
    await pool.query(
      `UPDATE outreach_logs SET send_error = $2, send_claimed_at = NULL,
              send_failures = COALESCE(send_failures, 0) + 1, updated_at = NOW()
        WHERE id = $1 AND sent_at IS NULL`, [log.id, ('Not sent: ' + f.msg).slice(0, 300)]).catch(() => {});
    return { ok: false, ...f };
  }
  // It has left. Every write from here on records a fact; none may undo it.
  await sendRules.record(pool, { email: toEmail, subject: log.subject, agentId: ctx.principal.id, refId: log.id, system });
  try {
    await pool.query(
      `UPDATE outreach_logs
       SET status='sent', sent_at=NOW(), email_account_id=$1,
           email_message_id=$2, sent_to_email=$4, message_id=$5,
           reply_to=$6, send_claimed_at=NULL, send_error=NULL, send_hold_reason=NULL, updated_at=NOW()
       WHERE id=$3`,
      // sent_to_email is what the named-address matcher joins on. message_id is
      // the RFC822 id we put on the wire, which a reply echoes in In-Reply-To --
      // the only exact anchor left now that the address carries no token.
      [emailAccountId, sendResult?.providerMessageId || null, log.id,
       String(toEmail).trim().toLowerCase(), sendResult?.messageId || null,
       sendResult?.replyTo || null]
    );
  } catch (e) {
    // The email went and the row could not say so. The claim stays (it goes
    // stale in 15 minutes), so nothing re-sends it in the meantime, and it is
    // an ourFault rather than a log line.
    console.error('[outreach/send] sent but not recorded', log.id, e.message);
    require('../services/ourFault').record('send', `sent ${log.id} but could not mark it sent: ${e.message}`, 'outreach/send');
  }
  pool.query(
    `INSERT INTO workflow_events (run_id, agent_id, event_type, payload) VALUES (NULL,$1,$2,$3)`,
    [ctx.principal.id, 'email_sent', JSON.stringify({ outreachId: log.id, brand: log.brand_name, to: toEmail })]
  ).catch(() => {});
  // Getting Started checklist: first AI outreach email sent
  // The onboarding checklist is an agent artefact; an athlete has no row in it.
  if (ctx.principal.kind === 'agent') markChecklistItem(ctx.principal.id, 'ai_outreach').catch(() => {});
  return { ok: true };
}

// What the editor and the card show. 'sending' while a claim is live (this
// route's, or the release queue's), 'sent' once it has a sent_at, 'failed'
// with the reason once a send failed and nothing is retrying it.
function sendStateOf(row) {
  if (!row) return null;
  const claimFresh = row.send_claimed_at && (Date.now() - new Date(row.send_claimed_at).getTime()) < CLAIM_STALE_MINUTES * 60000;
  if (row.sent_at || row.status === 'sent') return { state: 'sent', sentAt: row.sent_at, to: row.sent_to_email };
  if (claimFresh) return { state: 'sending' };
  if (row.cadence_stopped_at) return { state: 'failed', error: 'Not sent: ' + (row.cadence_stop_reason || 'stopped') };
  if (row.status === 'approved') {
    return row.send_hold_reason ? { state: 'sending', held: true, error: row.send_hold_reason } : { state: 'sending' };
  }
  if (row.send_error) return { state: 'failed', error: row.send_error };
  return { state: row.status || 'draft' };
}

router.get('/logs/:id/send-status', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT status, sent_at, sent_to_email, send_claimed_at, send_error, send_hold_reason, cadence_stopped_at, cadence_stop_reason
         FROM outreach_logs WHERE id = $1 AND agent_id = $2`, [req.params.id, req.principal.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Outreach log not found' });
    res.json({ id: req.params.id, ...sendStateOf(r.rows[0]) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/logs/:id/send', require('../services/sendTimings').middleware('outreach/send', { pool }), async (req, res) => {
  const T = req._T;
  const finish = (status, body, note) => { if (res.locals) res.locals.timingNote = note || null; res.status(status).json(body); };
  try {
    const { emailAccountId, toEmail } = req.body || {};
    const r = await pool.query('SELECT * FROM outreach_logs WHERE id=$1 AND agent_id=$2', [req.params.id, req.principal.id]);
    const log = r.rows[0];
    T.mark('read');
    if (!log) return finish(404, { error: 'Outreach log not found' });
    // ALREADY GONE, OR GOING: the same answer the first click got, not an error.
    // A second click must never read as a failure the agent then "fixes".
    const st = sendStateOf(log);
    if (st.state === 'sent' || (st.state === 'sending' && !st.held)) return finish(200, { ok: true, already: true, ...st }, 'repeat click: ' + st.state);

    if (!emailAccountId || !toEmail) {
      return finish(400, { error: 'emailAccountId and toEmail required' });
    }

    // ── THE SAME RULES AS THE NIGHTLY RELEASE ─────────────────────────────
    // A person clicking Send is still one of the systems that can mail this
    // address. A follow-up is not sent before it is due; nothing is sent to
    // an address on the suppression list, under a subject it already got, or
    // inside four days of anything else we sent it.
    if (log.next_follow_up_at && new Date(log.next_follow_up_at).getTime() > Date.now()) {
      return finish(409, { error: `This follow-up is not due until ${new Date(log.next_follow_up_at).toISOString().slice(0, 10)}. The cadence is 4 and 9 days after the last touch.`, reason: 'not-due' });
    }
    const sendRules = require('../services/sendRules');
    const rule = await sendRules.check(pool, {
      email: toEmail, subject: log.subject, refId: log.id,
      system: Number(log.touch_no || 1) > 1 ? 'follow-up' : 'manual',
    });
    T.mark('rules');
    if (!rule.ok) return finish(409, { error: 'Not sent: ' + rule.reason, reason: rule.kind });

    // ── THE CLAIM: ONE STATEMENT, ONE SENDER ──────────────────────────────
    const claim = await pool.query(
      `UPDATE outreach_logs SET send_claimed_at = NOW(), send_error = NULL, updated_at = NOW()
        WHERE id = $1 AND agent_id = $2 AND sent_at IS NULL AND status <> 'sent'
          AND (send_claimed_at IS NULL OR send_claimed_at < NOW() - ($3 || ' minutes')::interval)
        RETURNING *`, [log.id, req.principal.id, String(CLAIM_STALE_MINUTES)]);
    T.mark('claim');
    if (!claim.rowCount) return finish(200, { ok: true, already: true, state: 'sending' }, 'lost the claim: already sending');

    finish(202, { ok: true, state: 'sending', id: log.id }, 'claimed');
    // Behind the response. Its outcome is on the row (send-status).
    const ctx = { principal: { id: req.principal.id, kind: req.principal.kind } };
    runManualSend(ctx, claim.rows[0], emailAccountId, toEmail)
      .catch((e) => console.error('[outreach/send] background send crashed', log.id, e.message));
  } catch (e) {
    console.error('[outreach/send]', e.message);
    const f = failureSentence(e);
    finish(f.reason === 'scope' || f.reason === 'can-spam' ? 400 : 500, { error: f.msg, reason: f.reason });
  }
});

/**
 * PATCH /api/outreach/logs/:id
 * Update subject/body before sending (user edits the draft).
 */
// Text -> paragraphs, escaped. Home edits the WORDS and sends text, never
// markup, so nothing a page posts can become HTML in an email a business reads.
// Blank lines separate paragraphs, which is the shape pitchWriter already
// produces and what the card preview renders.
function textToHtml(t) {
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return String(t || '').replace(/\r\n/g, '\n').split(/\n\s*\n+/)
    .map((p) => p.trim()).filter(Boolean)
    .map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>')
    .join('');
}

router.patch('/logs/:id', async (req, res) => {
  try {
    const { subject } = req.body;
    // body_text is the Home path; body_html is the existing one. Text wins when
    // both are sent, because the safer contract should not be the one that loses.
    const body_html = (typeof req.body.body_text === 'string')
      ? textToHtml(req.body.body_text)
      : req.body.body_html;
    // AN EDIT IS THE SIGNAL, so it is recorded. Auto mode unlocks on a run of
    // approvals the agent did NOT have to touch; without this flag there is no
    // evidence either way and the offer would be a guess. Only counts as an edit
    // when the text actually changed -- opening a draft and saving it unchanged
    // is not distrust.
    const before = await pool.query(
      `SELECT subject, body_html FROM outreach_logs
        WHERE id=$1 AND agent_id=$2 AND status='draft'`,
      [req.params.id, req.principal.id]);
    const prev = before.rows[0];
    const changed = !!prev && (String(prev.subject || '') !== String(subject || '')
      || String(prev.body_html || '') !== String(body_html || ''));

    const r = await pool.query(
      `UPDATE outreach_logs SET subject=$1, body_html=$2, updated_at=NOW(),
              edited_before_approval = edited_before_approval OR $5,
              -- COALESCE, so the first edit records what the model wrote and no
              -- later edit can overwrite it. $6/$7 are the PRE-edit values read
              -- above, and they are only written when the text actually changed
              -- -- opening a draft and saving it untouched must not stamp an
              -- "original" that is identical to the current text.
              original_subject   = COALESCE(original_subject,   CASE WHEN $5 THEN $6 END),
              original_body_html = COALESCE(original_body_html, CASE WHEN $5 THEN $7 END)
       WHERE id=$3 AND agent_id=$4 AND status='draft'
       RETURNING *`,
      [subject, body_html, req.params.id, req.principal.id, changed,
        (prev && prev.subject) || null, (prev && prev.body_html) || null]
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

/**
 * POST /api/outreach/logs/:id/reply-handled
 * Body: { handled: boolean } (default true).
 *
 * Clears a captured reply out of NEEDS YOU. This is the only thing that does --
 * the shift report's reply query filters on reply_handled_at IS NULL, and the
 * only writer of that column is this route.
 *
 * DELIBERATELY NOT status='closed'. `status` tracks where a message is in the
 * send state machine (draft, approved, sent, replied, expired) and a row can be
 * both 'replied' and handled at once. Overloading status would have made those
 * two facts exclusive.
 *
 * Reversible: handled=false puts it back. Marking something handled by mistake
 * must not hide a real reply forever, which is the failure this whole column
 * exists to end.
 */
router.post('/logs/:id/reply-handled', async (req, res) => {
  try {
    const handled = req.body.handled !== false;
    const r = await pool.query(
      `UPDATE outreach_logs
          SET reply_handled_at = CASE WHEN $3 THEN NOW() ELSE NULL END, updated_at = NOW()
        WHERE id = $1 AND agent_id = $2 AND replied_at IS NOT NULL
        RETURNING id, replied_at, reply_handled_at`,
      [req.params.id, req.principal.id, handled]);
    // A row that never had a reply cannot be handled, and saying so is better
    // than a silent 200 that leaves the item sitting there.
    if (!r.rows[0]) return res.status(404).json({ error: 'No captured reply on this outreach' });
    res.json({ ok: true, ...r.rows[0] });
  } catch (e) {
    console.error('[outreach/reply-handled]', e.message);
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

// The agent's public reply address, assigned once and then never changed --
// it is printed on every email already sent, so a changed local part orphans
// every reply still in flight.
//
// The ladder (johnmark -> johnmarkc -> johnmarkcompton -> johnmark2) is walked
// against a UNIQUE index rather than a pre-flight "is it taken" SELECT, which
// would race two simultaneous signups into the same address. A duplicate-key
// error is the loop's normal exit, not an exception.
async function ensureReplyLocalPart(agentId) {
  const cur = await pool.query('SELECT name, email, reply_local_part FROM users WHERE id=$1', [agentId]);
  const u = cur.rows[0];
  if (!u) return null;
  if (u.reply_local_part) return u.reply_local_part;

  for (const cand of replyCapture.localPartCandidates(u.name, u.email)) {
    const r = await pool.query(
      `UPDATE users SET reply_local_part=$2, updated_at=NOW()
        WHERE id=$1 AND reply_local_part IS NULL RETURNING reply_local_part`,
      [agentId, cand]
    ).catch((e) => (e.code === '23505' ? null : Promise.reject(e)));
    if (r && r.rows[0]) {
      console.log(`[reply-capture] agent=${agentId} assigned ${r.rows[0].reply_local_part}@${replyCapture.REPLY_DOMAIN}`);
      return r.rows[0].reply_local_part;
    }
    if (r && !r.rows[0]) {
      // The row was set by a concurrent request between our SELECT and UPDATE.
      const again = await pool.query('SELECT reply_local_part FROM users WHERE id=$1', [agentId]);
      if (again.rows[0] && again.rows[0].reply_local_part) return again.rows[0].reply_local_part;
    }
  }
  console.error(`[reply-capture] agent=${agentId} could not be assigned a reply address`);
  return null;
}

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

  // ── REFUSE BEFORE GOOGLE DOES ───────────────────────────────────────────
  // No network call: this reads the scope set stored at connect time. Only a
  // KNOWN false blocks -- an account connected before we stored scopes is
  // unknown, not broken, and still goes to the provider, where the classifier
  // below catches it. Blocking on unknown would have emptied every agent's From
  // picker on the deploy that added the column.
  if (emailStore.knownCannotSend(account)) {
    throw new Error('SCOPE_MISSING: ' + (account.email_address || 'This mailbox')
      + ' is connected but did not grant permission to send email. Reconnect Google from '
      + 'Settings and tick "Send email on your behalf".');
  }

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

  // Reply-To routes the business's answer to us, not into the agent's own
  // mailbox, regardless of which provider actually sent this -- that's what lets
  // one webhook cover Gmail, Outlook and IMAP sends alike. null when reply
  // capture is off, so this is a no-op until the DNS/webhook side is verified.
  //
  // The agent's OWN named address, not a token: this is printed on a cold pitch
  // to a business owner and has to read like a person.
  const replyTo = replyCapture.ENABLED
    ? replyCapture.agentReplyAddress(await ensureReplyLocalPart(req.principal.id))
    : null;
  // Minted here, put on the wire below, and returned so the caller can store it.
  // This is the exact anchor the named address no longer provides.
  const messageId = replyCapture.ENABLED ? replyCapture.buildMessageId(log.id) : null;

  // ── THE CAN-SPAM FOOTER, ON THE WIRE ──────────────────────────────────
  // Appended HERE rather than in the draft, so it is on the message that
  // actually ships no matter which screen wrote it, and so an agent editing
  // the draft cannot delete it. Throws when BUSINESS_MAILING_ADDRESS is unset,
  // and the route's catch turns that into a sentence naming the variable.
  // req.principal carries an id and a kind, not a name, so the name for the
  // "why you got this" line is read here. Absent is fine: the line falls back
  // to wording that names nobody rather than printing "undefined" at a
  // business owner.
  const canSpam = require('../services/canSpam');
  const senderName = await pool.query(`SELECT name FROM users WHERE id = $1`, [log.agent_id])
    .then((r) => (r.rows[0] && r.rows[0].name) || null).catch(() => null);
  // The agent's own postal address (canSpam.senderAddress); none before their first send.
  const sa = await canSpam.senderAddress(pool, log.agent_id);
  if (!sa.ok) { const e = new Error(sa.why); e.status = 400; e.code = sa.code; throw e; }
  const bodyHtml = canSpam.appendHtml(log.body_html, toEmail, { senderName, address: sa.address });

  let result;
  const fake = require('../services/providers/fakeSend');
  if (fake.active()) {
    // Tests only (NILDASH_TEST_FAKE_SEND): never a real mailbox.
    result = await fake.sendEmail({ to: [toEmail], subject: log.subject, bodyHtml, replyTo, messageId });
  } else if (account.provider === 'gmail') {
    const gmail = require('../services/providers/gmail');
    result = await gmail.sendEmail(accessToken, refreshToken, {
      to: [toEmail], subject: log.subject, bodyHtml, attachments, replyTo, messageId,
    });
  } else if (account.provider === 'outlook' || account.provider === 'microsoft365') {
    const outlook = require('../services/providers/outlook');
    result = await outlook.sendEmail(accessToken, refreshToken, {
      to: [toEmail], subject: log.subject, bodyHtml, attachments, replyTo, messageId,
    });
  } else {
    const imapProvider = require('../services/providers/imap');
    const imapConfig = refreshToken ? JSON.parse(refreshToken) : {};
    result = await imapProvider.sendEmail(account.email_address, accessToken, imapConfig, {
      to: [toEmail], subject: log.subject, bodyHtml, replyTo, messageId,
    });
  }
  // messageId travels back so the caller stores exactly what went on the wire --
  // and when the provider reports what it actually stamped, that wins over what
  // we minted. Graph can refuse a caller-supplied Message-ID, and storing the id
  // we asked for rather than the id that shipped would silently break reply
  // matching. Gmail and IMAP report no such field, so this is unchanged for them.
  // replyTo travels back too, so the caller records what actually went out.
  return { ...(result || {}), messageId: result && result.messageIdUnknown ? null : ((result && result.messageId) || messageId), replyTo };
}

module.exports = router;
