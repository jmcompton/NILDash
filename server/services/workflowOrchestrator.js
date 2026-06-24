// server/services/workflowOrchestrator.js
// WorkflowOrchestrator — Part 8 of the NIL Outreach Automation Engine.
//
// Coordinates all services in the correct sequence:
//   Deal Scan result → Enrichment → Contact Discovery → Match → Pitch → Deck → Email Draft → CRM
//
// All steps run async, non-blocking, with full error isolation.
// Each step logs to automation_runs and workflow_events tables.
// Partial failures are captured and reported — never throw on recoverable errors.
//
// SAFETY: orchestrates NEW services only.
//         reads athletes and deals tables (read-only on existing).
//         writes to automation_runs, workflow_events, outreach_logs (all new tables).
//         creates deal in deals table (same as existing "+ Pipeline" button).

'use strict';

const crypto = require('crypto');
const { pool } = require('../store');
const enrichmentSvc  = require('./companyEnrichment');
const contactSvc     = require('./contactDiscovery');
const matchSvc       = require('./athleteBrandMatch');
const pitchSvc       = require('./pitchGeneration');
const deckSvc        = require('./deckGeneration');

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * runOutreachWorkflow(params)
 *
 * params: {
 *   agentId:     string
 *   athlete:     athlete DB row
 *   dealScanResult: single deal scan recommendation object
 * }
 *
 * Returns: { runId, enrichment, contacts, matchScore, pitch, deck, outreachDraft }
 *
 * Non-blocking: caller gets runId immediately; poll /api/outreach/runs/:runId for status.
 */
async function runOutreachWorkflow(params) {
  const { agentId, athlete, dealScanResult } = params;
  const brandName = dealScanResult.brand;
  const athleteId = athlete.id;

  // Create the automation run record
  const runId = 'run_' + crypto.randomBytes(8).toString('hex');
  await pool.query(
    `INSERT INTO automation_runs (id, agent_id, athlete_id, brand_name, status, started_at, created_at)
     VALUES ($1,$2,$3,$4,'running',NOW(),NOW())`,
    [runId, agentId, athleteId, brandName]
  );

  // Run workflow in background — return runId immediately
  setImmediate(() => executeWorkflow(runId, agentId, athlete, dealScanResult).catch(e => {
    console.error('[workflowOrchestrator] Unhandled error in run', runId, e.message);
    markRunFailed(runId, e.message);
  }));

  return { runId };
}

/**
 * getRunStatus(runId)
 * Returns the full automation_runs record with all step IDs.
 */
async function getRunStatus(runId) {
  const r = await pool.query('SELECT * FROM automation_runs WHERE id=$1', [runId]);
  if (!r.rows[0]) return null;

  const run = r.rows[0];

  // Attach enrichment, contact, match, deck, outreach data if available
  const [enrichment, contact, matchScore, deck, outreach] = await Promise.all([
    run.enrichment_id ? enrichmentSvc.getById(run.enrichment_id) : null,
    run.contact_id    ? contactSvc.getById(run.contact_id)       : null,
    run.match_score_id ? matchSvc.getMatchById(run.match_score_id) : null,
    run.deck_id       ? deckSvc.getDeckById(run.deck_id)         : null,
    run.outreach_id   ? getOutreachLog(run.outreach_id)          : null,
  ]);

  return { run, enrichment, contact, matchScore, deck, outreach };
}

/**
 * listRunsForAgent(agentId, limit)
 */
async function listRunsForAgent(agentId, limit = 20) {
  const r = await pool.query(
    `SELECT * FROM automation_runs WHERE agent_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [agentId, limit]
  );
  return r.rows;
}

// ── Workflow Execution ────────────────────────────────────────────────────────

async function executeWorkflow(runId, agentId, athlete, dealScanResult) {
  const brandName = dealScanResult.brand;
  const athleteId = athlete.id;
  const completedSteps = [];
  const failedSteps = [];

  // Load agent profile so pitches are signed with a real name
  let agentName = null;
  let agentEmail = null;
  try {
    const agentRow = await pool.query('SELECT name, email FROM users WHERE id=$1', [agentId]);
    agentName  = agentRow.rows[0]?.name  || null;
    agentEmail = agentRow.rows[0]?.email || null;
  } catch (e) { /* non-fatal — pitch will use fallback */ }

  async function step(name, fn) {
    try {
      logWorkflowEvent(runId, agentId, name + '_started', { brand: brandName });
      const result = await fn();
      completedSteps.push(name);
      logWorkflowEvent(runId, agentId, name + '_complete', { brand: brandName });
      return result;
    } catch (e) {
      console.error(`[workflowOrchestrator] Step "${name}" failed:`, e.message);
      failedSteps.push({ step: name, error: e.message });
      logWorkflowEvent(runId, agentId, name + '_failed', { brand: brandName, error: e.message });
      return null;
    }
  }

  // ── Step 1: Company Enrichment ─────────────────────────────────────────────
  const enrichment = await step('enrichment', () =>
    enrichmentSvc.enrich(agentId, brandName, {
      category:         dealScanResult.category,
      dealType:         dealScanResult.dealType,
      rationale:        dealScanResult.rationale,
      isLocal:          dealScanResult.isLocal,
    })
  );
  if (!enrichment) { await markRunFailed(runId, 'Enrichment failed'); return; }

  await pool.query('UPDATE automation_runs SET enrichment_id=$1 WHERE id=$2', [enrichment.id, runId]);

  // ── Step 2: Contact Discovery ──────────────────────────────────────────────
  const contacts = await step('contact_discovery', () =>
    contactSvc.discoverContacts(agentId, enrichment)
  );

  const bestContact = contacts?.[0] || null;
  if (bestContact) {
    await pool.query('UPDATE automation_runs SET contact_id=$1 WHERE id=$2', [bestContact.id, runId]);
  }

  // ── Step 3: Athlete-Brand Match ────────────────────────────────────────────
  const matchScore = await step('brand_match', () =>
    matchSvc.matchAthleteToBrand(agentId, athlete, enrichment)
  );
  if (matchScore) {
    await pool.query('UPDATE automation_runs SET match_score_id=$1 WHERE id=$2', [matchScore.id, runId]);
  }

  // ── Step 4: Pitch Generation ───────────────────────────────────────────────
  const pitch = await step('pitch_generation', () =>
    pitchSvc.generatePitch({
      athlete,
      enrichment,
      matchScore,
      contact: bestContact,
      dealScanData: dealScanResult,
      agentName,
      agentEmail,
    })
  );

  // ── Step 5: Deck Generation ────────────────────────────────────────────────
  const deck = await step('deck_generation', () =>
    deckSvc.generateDeck({
      agentId, athleteId,
      athlete, enrichment, matchScore,
      pitch: pitch || {},
    })
  );
  if (deck) {
    await pool.query('UPDATE automation_runs SET deck_id=$1 WHERE id=$2', [deck.id, runId]);
  }

  // ── Step 6: Build Email Draft ──────────────────────────────────────────────
  const outreach = await step('email_draft', () =>
    buildOutreachDraft(runId, agentId, athleteId, athlete, enrichment, bestContact, pitch, deck, dealScanResult)
  );
  if (outreach) {
    await pool.query('UPDATE automation_runs SET outreach_id=$1 WHERE id=$2', [outreach.id, runId]);
  }

  // ── Step 7: CRM Update ────────────────────────────────────────────────────
  await step('crm_update', () =>
    createCRMDeal(agentId, athleteId, athlete, dealScanResult, enrichment, outreach)
  );

  // ── Mark Complete ──────────────────────────────────────────────────────────
  await pool.query(
    `UPDATE automation_runs
     SET status='complete', steps_completed=$1, steps_failed=$2, completed_at=NOW()
     WHERE id=$3`,
    [JSON.stringify(completedSteps), JSON.stringify(failedSteps), runId]
  );

  logWorkflowEvent(runId, agentId, 'workflow_complete', {
    brand: brandName, steps: completedSteps.length, failed: failedSteps.length
  });
}

// ── Email Renderer ────────────────────────────────────────────────────────────

/**
 * Converts the AI-generated plain-text email body into proper HTML.
 * Splits on blank lines, renders each paragraph as <p>, detects the
 * sign-off line and replaces the AI signature with a proper block.
 */
function renderProfessionalEmail(rawBody, agentName, agentEmail, deck, athleteData, enrichment) {
  const BASE = 'font-family:Georgia,"Times New Roman",serif;font-size:14px;line-height:1.75;color:#1a1a1a';
  const PARA = 'margin:0 0 18px 0';
  const MUTED = 'color:#555;font-size:13px';

  // Normalise and split into paragraphs
  const paragraphs = rawBody
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);

  const htmlParts = [];
  let signoffFound = false;

  for (const para of paragraphs) {
    if (signoffFound) break; // drop AI-generated name lines after "Best,"

    const isSignoff = /^(Best regards|Kind regards|Warm regards|Best|Regards|Sincerely|Thanks|Cheers)\s*,/i.test(para.trim());
    if (isSignoff) {
      signoffFound = true;
      htmlParts.push(`<p style="${PARA}">Best,</p>`);
      break;
    }

    // Opening salutation — render in normal weight (Dear X,)
    const isGreeting = htmlParts.length === 0 && /^(Dear|Hi|Hello)\s/i.test(para);
    if (isGreeting) {
      htmlParts.push(`<p style="${PARA}">${para}</p>`);
      continue;
    }

    // Body paragraph — replace single newlines with spaces so they flow
    htmlParts.push(`<p style="${PARA}">${para.replace(/\n/g, ' ')}</p>`);
  }

  // If no sign-off was found in the AI output, add one
  if (!signoffFound) htmlParts.push(`<p style="${PARA}">Best,</p>`);

  // Professional signature block
  const sig = [
    `<p style="margin:6px 0 0 0;font-weight:700">${agentName || 'NIL Agent'}</p>`,
    `<p style="margin:2px 0;${MUTED}">NIL Partnerships</p>`,
    `<p style="margin:2px 0;${MUTED}">NILDash</p>`,
    agentEmail ? `<p style="margin:2px 0"><a href="mailto:${agentEmail}" style="color:#BA0C2F;text-decoration:none">${agentEmail}</a></p>` : '',
  ].filter(Boolean).join('\n');

  // Attachment note (plain, below signature)
  const attachNote = deck?.file_path
    ? `<p style="margin:24px 0 0 0;${MUTED};border-top:1px solid #e0e0e0;padding-top:12px">Pitch deck attached: ${athleteData.name} × ${enrichment.brand_name}</p>`
    : '';

  return `<div style="${BASE};max-width:600px;padding:0">
${htmlParts.join('\n')}
${sig}
${attachNote}
</div>`;
}

// ── Step Implementations ──────────────────────────────────────────────────────

async function buildOutreachDraft(runId, agentId, athleteId, athlete, enrichment, contact, pitch, deck, dealScanResult) {
  if (!pitch) return null;

  const id = 'out_' + crypto.randomBytes(8).toString('hex');
  const athleteData = athlete.data || athlete;

  // Load agent info for the signature block
  let agentName = null, agentEmail = null;
  try {
    const ar = await pool.query('SELECT name, email FROM users WHERE id=$1', [agentId]);
    agentName  = ar.rows[0]?.name  || null;
    agentEmail = ar.rows[0]?.email || null;
  } catch (_) {}

  // Build professional HTML email body
  const bodyHtml = renderProfessionalEmail(pitch.full_email_body || '', agentName, agentEmail, deck, athleteData, enrichment);

  const r = await pool.query(
    `INSERT INTO outreach_logs (
       id, agent_id, athlete_id, brand_name, contact_id, enrichment_id,
       deck_id, subject, body_html, status, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',NOW(),NOW())
     RETURNING *`,
    [
      id, agentId, athleteId, enrichment.brand_name,
      contact?.id || null, enrichment.id, deck?.id || null,
      pitch.subject_line || `NIL Partnership — ${athleteData.name || 'Athlete'} × ${enrichment.brand_name}`,
      bodyHtml,
    ]
  );

  return r.rows[0];
}

async function createCRMDeal(agentId, athleteId, athlete, dealScanResult, enrichment, outreach) {
  // Only create if no existing Prospecting deal for this brand+athlete
  const existing = await pool.query(
    `SELECT id FROM deals
     WHERE agent_id=$1 AND athlete_id=$2 AND data->>'brand'=$3 AND data->>'stage'='Prospecting'
     LIMIT 1`,
    [agentId, athleteId, dealScanResult.brand]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const dealId = 'deal-' + Date.now();
  const r = await pool.query(
    `INSERT INTO deals (id, athlete_id, agent_id, data, created_at)
     VALUES ($1,$2,$3,$4,NOW()) RETURNING *`,
    [
      dealId, athleteId, agentId,
      JSON.stringify({
        brand:       dealScanResult.brand,
        campaign:    dealScanResult.campaign,
        stage:       'Prospecting',
        dealType:    dealScanResult.dealType,
        source:      'outreach_engine',
        notes:       `Auto-created by Outreach Engine. Fit score: ${dealScanResult.fitScore || 'N/A'}. Enrichment ID: ${enrichment.id}. Outreach ID: ${outreach?.id || 'N/A'}.`,
        createdAt:   new Date().toISOString(),
      }),
    ]
  );

  logWorkflowEvent(null, agentId, 'crm_deal_created', {
    dealId, brand: dealScanResult.brand, athleteId,
  });

  return r.rows[0];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function markRunFailed(runId, errorMessage) {
  await pool.query(
    `UPDATE automation_runs SET status='failed', error_message=$1, completed_at=NOW() WHERE id=$2`,
    [errorMessage, runId]
  ).catch(() => {});
}

async function getOutreachLog(id) {
  const r = await pool.query('SELECT * FROM outreach_logs WHERE id=$1', [id]);
  return r.rows[0] || null;
}

function logWorkflowEvent(runId, agentId, eventType, payload) {
  pool.query(
    `INSERT INTO workflow_events (run_id, agent_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [runId, agentId, eventType, JSON.stringify(payload)]
  ).catch(() => {});
}

module.exports = { runOutreachWorkflow, getRunStatus, listRunsForAgent };
