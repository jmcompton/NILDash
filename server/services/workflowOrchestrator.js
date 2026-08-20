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
  const { agentId, athlete, dealScanResult, knownContacts } = params;
  // agentId is the OWNER key for everything this run writes, and it is now either an
  // agent's user id or a self-managed athlete's own id. owner says which, for the
  // two places that mean "the human sending this" rather than "who owns the row":
  // the signature on the pitch, and where the resulting deal is filed.
  const owner = params.owner || { kind: 'agent', id: agentId };
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
  setImmediate(() => executeWorkflow(runId, agentId, athlete, dealScanResult, knownContacts, owner).catch(e => {
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

async function executeWorkflow(runId, agentId, athlete, dealScanResult, knownContacts, owner) {
  const brandName = dealScanResult.brand;
  const athleteId = athlete.id;
  const completedSteps = [];
  const failedSteps = [];
  const senderIsAthlete = !!(owner && owner.kind === 'athlete');

  // Who signs the pitch. A self-managed athlete has no agent, and her id is not in
  // the users table -- looking her up there returned nothing and the email went out
  // unsigned. She signs it herself, which is the whole point of self-management.
  const { agentName, agentEmail } = await loadSenderIdentity(agentId, senderIsAthlete, athlete);

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
  // knownContacts is what the CARD already found. When it carries a real answer the
  // second web fan-out is skipped: same resolver, same searches, already paid for.
  const contacts = await step('contact_discovery', () =>
    contactSvc.discoverContacts(agentId, enrichment, knownContacts)
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
  // A REFUSAL ENDS THE RUN. The writer would not produce copy that names a price
  // or invents a fact about the athlete, so there is no draft to deck, store or
  // send. Failing here is the point: the alternative is a flagged draft that
  // gets approved along with the other nine.
  if (pitch && pitch.refused) {
    console.warn(`[workflow] run=${runId} pitch refused: ${(pitch.reasons || []).join('; ')}`);
    await pool.query(
      `UPDATE automation_runs SET status='refused', error_message=$1, completed_at=NOW() WHERE id=$2`,
      [('pitch refused: ' + (pitch.reasons || []).join('; ')).slice(0, 400), runId]).catch(() => {});
    return { runId, refused: true, reasons: pitch.reasons || [] };
  }

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
    buildOutreachDraft(runId, agentId, athleteId, athlete, enrichment, bestContact, pitch, deck, dealScanResult, senderIsAthlete)
  );
  if (outreach) {
    await pool.query('UPDATE automation_runs SET outreach_id=$1 WHERE id=$2', [outreach.id, runId]);
  }

  // ── Step 7: CRM Update ────────────────────────────────────────────────────
  await step('crm_update', () =>
    createCRMDeal(agentId, athleteId, athlete, dealScanResult, enrichment, outreach, senderIsAthlete)
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
  const FONT  = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const BASE  = `${FONT};font-size:15px;line-height:1.6;color:#222222`;
  const MUTED = 'color:#666666;font-size:13px';

  const body = (rawBody || '').replace(/\r\n/g, '\n').trim();

  // Split into paragraphs: blank lines first, fall back to single newlines.
  let paragraphs = body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length <= 1 && body.includes('\n')) {
    paragraphs = body.split(/\n+/).map(p => p.trim()).filter(Boolean);
  }

  // Drop the model's own sign-off and everything after it (we add our own).
  const SIGNOFF = /^(best regards|kind regards|warm regards|sincerely|cheers|regards|best|thanks|thank you)\b/i;
  const bodyParas = [];
  for (const para of paragraphs) {
    if (SIGNOFF.test(para)) break;
    const clean = para.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (clean) bodyParas.push(clean);
  }

  // Gmail strips <p> margins, so build native lines with real blank lines between paragraphs.
  const bodyHtml = bodyParas.map(p => `<div>${p}</div>`).join('<div><br></div>');

  // Closing + signature: agent's real name + email only.
  const sigLines = [
    `<div>Best,</div>`,
    `<div>${agentName || 'NIL Agent'}</div>`,
    agentEmail
      ? `<div><a href="mailto:${agentEmail}" style="color:#1a73e8;text-decoration:none">${agentEmail}</a></div>`
      : '',
  ].filter(Boolean).join('');

  const attachNote = deck?.file_path
    ? `<div><br></div><div style="${MUTED}">Attached: ${athleteData.name} × ${enrichment.brand_name} overview</div>`
    : '';

  return `<div style="${BASE};max-width:560px">
${bodyHtml}
<div><br></div>
${sigLines}
${attachNote}
</div>`;
}

// ── Step Implementations ──────────────────────────────────────────────────────

// The name and address the outreach is signed with. An agent is a users row; a
// self-managed athlete is an athletes row and signs as herself.
async function loadSenderIdentity(ownerId, isAthlete, athleteRow) {
  try {
    if (isAthlete) {
      const r = await pool.query(`SELECT email, data->>'name' AS name FROM athletes WHERE id=$1`, [ownerId]);
      const row = r.rows[0] || {};
      const data = (athleteRow && (athleteRow.data || athleteRow)) || {};
      return { agentName: row.name || data.name || null, agentEmail: row.email || null };
    }
    const r = await pool.query('SELECT name, email FROM users WHERE id=$1', [ownerId]);
    return { agentName: r.rows[0]?.name || null, agentEmail: r.rows[0]?.email || null };
  } catch (e) {
    return { agentName: null, agentEmail: null };   // non-fatal: the pitch falls back
  }
}

async function buildOutreachDraft(runId, agentId, athleteId, athlete, enrichment, contact, pitch, deck, dealScanResult, senderIsAthlete) {
  if (!pitch) return null;

  const id = 'out_' + crypto.randomBytes(8).toString('hex');
  const athleteData = athlete.data || athlete;

  // Load the sender's info for the signature block. Same rule as the pitch: an
  // athlete running this for herself is not in the users table and signs as herself.
  const { agentName, agentEmail } = await loadSenderIdentity(agentId, senderIsAthlete, athlete);

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

async function createCRMDeal(agentId, athleteId, athlete, dealScanResult, enrichment, outreach, senderIsAthlete) {
  // A SELF-MANAGED ATHLETE'S PIPELINE IS NOT THE AGENT DEALS TABLE. Her portal reads
  // athlete_deal_pipeline; writing her a `deals` row keyed on her own id as agent_id
  // would file it where nothing looks, so the brand she just pitched would never
  // appear in her pipeline.
  if (senderIsAthlete) return createAthletePipelineEntry(athleteId, dealScanResult, enrichment, outreach);

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

// The athlete-side equivalent of createCRMDeal. Same shape of guarantee: one entry
// per brand, never a duplicate, and it lands where her Pipeline view reads.
async function createAthletePipelineEntry(athleteId, dealScanResult, enrichment, outreach) {
  const brand = enrichment.brand_name || dealScanResult.brand;
  const existing = await pool.query(
    `SELECT id FROM athlete_deal_pipeline WHERE athlete_id=$1 AND brand_name=$2 LIMIT 1`,
    [athleteId, brand]
  );
  if (existing.rows.length > 0) return existing.rows[0];
  const r = await pool.query(
    `INSERT INTO athlete_deal_pipeline
       (athlete_id, agent_id, brand_name, brand_category, status, pitch_subject, pitch_body, notes, created_at, updated_at)
     VALUES ($1, NULL, $2, $3, 'pitched', $4, $5, $6, NOW(), NOW())
     RETURNING *`,
    [
      athleteId, brand, dealScanResult.category || enrichment.industry || null,
      outreach?.subject || null,
      outreach?.body_html || null,
      `Auto-created by the outreach engine. Fit score: ${dealScanResult.fitScore || 'N/A'}.`,
    ]
  );
  logWorkflowEvent(null, athleteId, 'athlete_pipeline_entry_created', { brand, athleteId });
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
