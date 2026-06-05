// server/services/contractExtraction.js
// Production-grade NIL contract extraction pipeline.
//
// PIPELINE:
//   1. Hash file (SHA256) → idempotency check
//   2. Extract raw text (PDF via Anthropic native API, DOCX via mammoth)
//   3. AI extraction (Claude Opus 4) → structured deliverables with confidence scores
//   4. Validation layer (dates, confidence, brands)
//   5. Atomic DB transaction (contract + deliverables + calendar events + audit log)
//
// RETRY: AI step retries up to 3× with exponential backoff (1s → 5s → 15s)
// IDEMPOTENCY: file_hash UNIQUE constraint → returns existing on duplicate
// SECURITY: all inserts write agent_id from session (never from client)

'use strict';

const crypto   = require('crypto');
const mammoth  = require('mammoth');
const Anthropic = require('@anthropic-ai/sdk');
const { toRRule, generateDates, describeRRule } = require('./calendarRecurrence');

const MAX_RETRIES   = 3;
const RETRY_DELAYS  = [1000, 5000, 15000]; // ms
const MIN_CONFIDENCE = 70; // below this → flagged as low-confidence
const MAX_TEXT_CHARS = 14000; // chars sent to AI (token-safe)

// ── Brand color palette (deterministic hash → CSS color) ─────────────────
const BRAND_COLORS = [
  '#6366f1','#8b5cf6','#ec4899','#ef4444','#f97316',
  '#eab308','#22c55e','#14b8a6','#06b6d4','#3b82f6',
];
function brandColor(brand) {
  if (!brand) return BRAND_COLORS[0];
  let h = 0;
  for (let i = 0; i < brand.length; i++) h = (h * 31 + brand.charCodeAt(i)) >>> 0;
  return BRAND_COLORS[h % BRAND_COLORS.length];
}

// ── Nanoid-style TEXT PK generator ───────────────────────────────────────
function uid(prefix = '') {
  return prefix + crypto.randomBytes(8).toString('hex');
}

// ── Sleep helper ─────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Validate an ISO date string ───────────────────────────────────────────
function isValidDate(str) {
  if (!str) return false;
  const d = new Date(str);
  return !isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}$/.test(str);
}

// ── Normalize brand name ──────────────────────────────────────────────────
function normalizeBrand(raw) {
  if (!raw || typeof raw !== 'string') return null;
  return raw.trim().replace(/\s+/g, ' ').replace(/["""]/g, '').trim() || null;
}

// ── Hash file buffer (SHA256, hex) ────────────────────────────────────────
function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ── Extract text from uploaded file ──────────────────────────────────────
async function extractText(buffer, mimetype) {
  if (mimetype === 'application/pdf') {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({
      model: 'claude-opus-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
          },
          { type: 'text', text: 'Extract all text from this document verbatim. Return only the raw text.' },
        ],
      }],
    });
    return resp.content[0]?.text || '';
  }

  // DOCX / DOC
  const result = await mammoth.extractRawText({ buffer });
  return result.value || '';
}

// ── AI extraction with retry + exponential backoff ────────────────────────
async function extractDeliverablesFromText(ai, contractText, brandHint) {
  const text = contractText.substring(0, MAX_TEXT_CHARS);

  const currentYear = new Date().getFullYear();
  const prompt = `You are a senior sports attorney and contract analyst specializing in NIL (Name, Image, Likeness) agreements.

Read this NIL contract and extract EVERY obligation, deliverable, and payment milestone.

CONTRACT TEXT:
${text}

TODAY'S DATE: ${new Date().toISOString().split('T')[0]} (current year is ${currentYear})

For EACH deliverable extract:
- description: exact obligation (what the athlete must do)
- brand: the sponsoring brand/company name
- due_date: ISO date YYYY-MM-DD (null if unclear or open-ended)
- start_date: ISO date YYYY-MM-DD (null if not specified)
- end_date: ISO date YYYY-MM-DD (null if not specified)
- recurrence: "monthly" | "weekly" | "biweekly" | "quarterly" | "daily" | "one-time" | null
- contract_duration_months: integer (infer from start/end dates, or null)
- deliverable_type: "social_post" | "story" | "appearance" | "content_creation" | "payment_milestone" | "other"
- confidence_score: 0-100 (how confident you are this is a real contractual obligation)

RULES:
- Include social posts, appearances, content creation, exclusivity periods, AND payment milestones
- For recurring items (e.g. "2 posts/month for 6 months"), return ONE entry with recurrence="monthly" and contract_duration_months=6
- Confidence ≥85 = clear contractual obligation. 70-84 = probable. Below 70 = flag only.
- If the brand is obvious from context, use it even if not repeated on each line
- If no due_date exists, return null — do NOT fabricate dates
- IMPORTANT: All dates must use the actual year from the contract. If the contract does not specify a year, use ${currentYear}. Never output dates with year ${currentYear - 1} unless the contract explicitly states that year.
- Return ONLY a valid JSON array, no markdown, no commentary

OUTPUT FORMAT (example using current year ${currentYear}):
[
  {
    "description": "Post 2 Instagram Reels featuring product during campaign",
    "brand": "Nike",
    "due_date": "${currentYear}-09-01",
    "start_date": "${currentYear}-06-01",
    "end_date": "${currentYear}-12-31",
    "recurrence": "monthly",
    "contract_duration_months": 6,
    "deliverable_type": "social_post",
    "confidence_score": 92
  }
]`;

  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[contractExtraction] AI retry ${attempt + 1}/${MAX_RETRIES}`);
        await sleep(RETRY_DELAYS[attempt - 1]);
      }

      const raw = await ai.oneShot(
        prompt,
        'You are a legal contract analyst. Return ONLY valid JSON arrays. Never fabricate obligations. Never return markdown.',
        3000
      );

      const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
      const si = cleaned.indexOf('[');
      const ei = cleaned.lastIndexOf(']');
      if (si === -1 || ei <= si) throw new Error('AI returned non-array response');

      const parsed = JSON.parse(cleaned.substring(si, ei + 1));
      if (!Array.isArray(parsed)) throw new Error('AI output is not a JSON array');

      return parsed; // success
    } catch (e) {
      lastErr = e;
      console.warn(`[contractExtraction] AI attempt ${attempt + 1} failed: ${e.message}`);
    }
  }

  throw new Error(`AI extraction failed after ${MAX_RETRIES} attempts: ${lastErr?.message}`);
}

// ── Validate and sanitize a single AI deliverable ─────────────────────────
function validateDeliverable(raw, fallbackBrand) {
  const issues = [];
  const currentYear = new Date().getFullYear();

  const description = (raw.description || raw.deliverable_description || '').trim();
  if (!description) return { valid: false, issues: ['missing description'] };

  const brand = normalizeBrand(raw.brand) || normalizeBrand(fallbackBrand) || 'Unknown Brand';
  const dueDate = isValidDate(raw.due_date) ? raw.due_date : null;
  const startDate = isValidDate(raw.start_date) ? raw.start_date : null;
  const endDate = isValidDate(raw.end_date) ? raw.end_date : null;
  const confidence = Math.max(0, Math.min(100, parseInt(raw.confidence_score || raw.confidence || 0, 10)));
  const recurrence = raw.recurrence || null;
  const durationMonths = raw.contract_duration_months ? parseInt(raw.contract_duration_months, 10) : null;
  const deliverableType = raw.deliverable_type || 'other';

  // Log raw dates from AI so we can verify year correctness
  console.log('[contractExtraction] raw AI dates:', {
    description: description.substring(0, 60),
    due_date: raw.due_date || null,
    start_date: raw.start_date || null,
    end_date: raw.end_date || null,
  });

  // Warn if AI returned a past year — this indicates the prompt bias bug
  [dueDate, startDate, endDate].forEach(d => {
    if (d) {
      const yr = parseInt(d.split('-')[0], 10);
      if (yr < currentYear) {
        console.warn(`[contractExtraction] ⚠️  Date ${d} is in a past year (${yr}). Current year is ${currentYear}. Check AI prompt or contract text.`);
        issues.push(`date in past year: ${d}`);
      }
    }
  });

  if (!dueDate && !startDate) issues.push('no date specified');
  if (confidence < MIN_CONFIDENCE) issues.push(`low confidence: ${confidence}`);

  const source = confidence >= MIN_CONFIDENCE ? 'ai_extracted' : 'ai_low_confidence';
  const rrule = toRRule(recurrence, durationMonths);

  return {
    valid: true,
    description, brand, dueDate, startDate, endDate,
    confidence, recurrence, durationMonths, deliverableType,
    rrule, source, issues,
  };
}

// ── Build calendar event rows from a deliverable ──────────────────────────
function buildCalendarEvents({ deliverableId, athleteId, agentId, contractId, validated }) {
  const { description, brand, dueDate, rrule, durationMonths } = validated;
  const color = brandColor(brand);
  const events = [];

  if (rrule && dueDate) {
    // Recurring → generate instances
    const dates = generateDates(rrule, dueDate, { durationMonths });
    for (const date of dates) {
      events.push({
        id: uid('evt-'),
        athlete_id: athleteId,
        agent_id: agentId,
        deliverable_id: deliverableId,
        contract_id: contractId,
        title: description,
        event_date: date,
        brand,
        color,
        status: 'pending',
        is_generated: true,
        recurrence_instance: true,
        manually_modified: false,
      });
    }
  } else if (dueDate) {
    // One-time event
    events.push({
      id: uid('evt-'),
      athlete_id: athleteId,
      agent_id: agentId,
      deliverable_id: deliverableId,
      contract_id: contractId,
      title: description,
      event_date: dueDate,
      brand,
      color,
      status: 'pending',
      is_generated: true,
      recurrence_instance: false,
      manually_modified: false,
    });
  }
  // Undated deliverables: no calendar event (shown in "Undated" list in UI)

  return events;
}

// ── Audit logger ─────────────────────────────────────────────────────────
async function writeAudit(pool, { agentId, athleteId, contractId, actionType, status, metadata, errorMessage }) {
  try {
    await pool.query(
      `INSERT INTO contract_audit_log (agent_id, athlete_id, contract_id, action_type, status, metadata, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [agentId, athleteId || null, contractId || null, actionType, status || null,
       JSON.stringify(metadata || {}), errorMessage || null]
    );
  } catch (e) {
    console.error('[audit] write failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT
// processContractUpload({ pool, ai, athleteId, agentId, file, brandHint })
// ─────────────────────────────────────────────────────────────────────────
async function processContractUpload({ pool, ai, athleteId, agentId, file, brandHint }) {
  const { originalname, mimetype, buffer } = file;
  const fileHash = hashBuffer(buffer);

  // ── STEP 1: Idempotency check ──────────────────────────────────────────
  const existing = await pool.query(
    `SELECT id, athlete_id, agent_id, filename, brand, extraction_status, uploaded_at
     FROM athlete_contracts WHERE file_hash = $1`,
    [fileHash]
  );

  if (existing.rows.length > 0) {
    const c = existing.rows[0];
    // Security: ensure this agent owns the contract
    if (c.agent_id !== agentId) {
      throw Object.assign(new Error('Forbidden: contract belongs to another agent'), { statusCode: 403 });
    }

    await writeAudit(pool, {
      agentId, athleteId, contractId: c.id,
      actionType: 'upload_duplicate',
      status: 'skipped',
      metadata: { fileHash, filename: originalname, existingId: c.id },
    });

    const deliverables = await pool.query(
      `SELECT * FROM athlete_deliverables WHERE contract_id=$1 AND agent_id=$2 ORDER BY sort_order ASC`,
      [c.id, agentId]
    );
    const events = await pool.query(
      `SELECT * FROM athlete_calendar_events WHERE contract_id=$1 AND agent_id=$2 ORDER BY event_date ASC`,
      [c.id, agentId]
    );

    return {
      duplicate: true,
      contractId: c.id,
      brand: c.brand,
      filename: c.filename,
      extractionStatus: c.extraction_status,
      deliverableCount: deliverables.rows.length,
      calendarEventCount: events.rows.length,
      deliverables: deliverables.rows,
    };
  }

  // ── STEP 2: Text extraction ────────────────────────────────────────────
  const contractId = uid('contract-');

  await writeAudit(pool, {
    agentId, athleteId, contractId,
    actionType: 'upload_started',
    status: 'pending',
    metadata: { filename: originalname, fileHash, mimetype },
  });

  let rawText = '';
  try {
    rawText = await extractText(buffer, mimetype);
  } catch (e) {
    await pool.query(
      `INSERT INTO athlete_contracts (id, athlete_id, agent_id, filename, brand, file_hash, raw_text, extraction_status, extraction_attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual_review_required',1)`,
      [contractId, athleteId, agentId, originalname, brandHint || 'Unknown Brand', fileHash, '']
    );
    await writeAudit(pool, {
      agentId, athleteId, contractId,
      actionType: 'text_extraction_failed',
      status: 'manual_review_required',
      errorMessage: e.message,
      metadata: { filename: originalname },
    });
    return { contractId, extractionStatus: 'manual_review_required', error: 'Could not extract text from file', deliverableCount: 0 };
  }

  if (!rawText || rawText.trim().length < 50) {
    await pool.query(
      `INSERT INTO athlete_contracts (id, athlete_id, agent_id, filename, brand, file_hash, raw_text, extraction_status, extraction_attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual_review_required',1)`,
      [contractId, athleteId, agentId, originalname, brandHint || 'Unknown Brand', fileHash, rawText]
    );
    await writeAudit(pool, {
      agentId, athleteId, contractId,
      actionType: 'text_too_short',
      status: 'manual_review_required',
      metadata: { textLength: rawText.length },
    });
    return { contractId, extractionStatus: 'manual_review_required', error: 'File appears empty or unreadable', deliverableCount: 0 };
  }

  // ── STEP 3: AI extraction with retry ─────────────────────────────────
  let rawDeliverables;
  try {
    rawDeliverables = await extractDeliverablesFromText(ai, rawText, brandHint);
  } catch (aiErr) {
    await pool.query(
      `INSERT INTO athlete_contracts (id, athlete_id, agent_id, filename, brand, file_hash, raw_text, extraction_status, extraction_attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual_review_required',$8)`,
      [contractId, athleteId, agentId, originalname, brandHint || 'Unknown Brand', fileHash, rawText.substring(0, 2000), MAX_RETRIES]
    );
    await writeAudit(pool, {
      agentId, athleteId, contractId,
      actionType: 'ai_extraction_failed',
      status: 'manual_review_required',
      errorMessage: aiErr.message,
      metadata: { attempts: MAX_RETRIES },
    });
    return { contractId, extractionStatus: 'manual_review_required', error: 'AI extraction failed — queued for manual review', deliverableCount: 0 };
  }

  // ── STEP 4: Validate + sanitize deliverables ─────────────────────────
  const fallbackBrand = brandHint || rawDeliverables[0]?.brand || 'Unknown Brand';
  const validated = [];
  const lowConfidence = [];

  for (const raw of rawDeliverables) {
    const v = validateDeliverable(raw, fallbackBrand);
    if (!v.valid) continue;
    if (v.source === 'ai_low_confidence') {
      lowConfidence.push(v);
    }
    validated.push(v);
  }

  // Infer contract-level metadata from validated deliverables
  const allStartDates = validated.map(v => v.startDate).filter(Boolean).sort();
  const allEndDates   = validated.map(v => v.endDate).filter(Boolean).sort();
  const contractStart = allStartDates[0] || null;
  const contractEnd   = allEndDates[allEndDates.length - 1] || null;
  const brandName     = normalizeBrand(fallbackBrand) || 'Unknown Brand';

  // ── STEP 5: Atomic transaction ───────────────────────────────────────
  const client = await pool.connect();
  let insertedDeliverables = 0;
  let insertedEvents = 0;

  try {
    await client.query('BEGIN');

    // Insert contract record
    await client.query(
      `INSERT INTO athlete_contracts
         (id, athlete_id, agent_id, filename, brand, file_hash, raw_text, start_date, end_date, extraction_status, extraction_attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed',1)`,
      [contractId, athleteId, agentId, originalname, brandName, fileHash,
       rawText.substring(0, 5000), contractStart, contractEnd]
    );

    // Insert deliverables (deduplicated within this batch by description+due_date)
    const seenKeys = new Set();
    const deliverableIds = [];

    for (let i = 0; i < validated.length; i++) {
      const v = validated[i];
      const key = `${v.description}|${v.dueDate || ''}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const r = await client.query(
        `INSERT INTO athlete_deliverables
           (athlete_id, agent_id, contract_id, deliverable_description, due_date, brand,
            status, recurrence, recurrence_rule, ai_confidence_score, source, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [athleteId, agentId, contractId, v.description, v.dueDate,
         v.brand, v.recurrence, v.rrule, v.confidence, v.source, i]
      );

      if (r.rows.length) {
        deliverableIds.push({ id: r.rows[0].id, validated: v });
        insertedDeliverables++;
      }
    }

    // Generate and insert calendar events
    for (const { id: deliverableId, validated: v } of deliverableIds) {
      const events = buildCalendarEvents({
        deliverableId, athleteId, agentId, contractId, validated: v,
      });

      for (const evt of events) {
        await client.query(
          `INSERT INTO athlete_calendar_events
             (id, athlete_id, agent_id, deliverable_id, contract_id, title, event_date,
              brand, color, status, is_generated, recurrence_instance, manually_modified)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (deliverable_id, event_date) DO NOTHING`,
          [evt.id, evt.athlete_id, evt.agent_id, evt.deliverable_id, evt.contract_id,
           evt.title, evt.event_date, evt.brand, evt.color, evt.status,
           evt.is_generated, evt.recurrence_instance, evt.manually_modified]
        );
        insertedEvents++;
      }
    }

    await client.query('COMMIT');
  } catch (txErr) {
    await client.query('ROLLBACK');
    // Mark as pending so it can be retried
    await pool.query(
      `UPDATE athlete_contracts SET extraction_status='pending' WHERE id=$1`,
      [contractId]
    ).catch(() => {});
    await writeAudit(pool, {
      agentId, athleteId, contractId,
      actionType: 'transaction_failed',
      status: 'error',
      errorMessage: txErr.message,
    });
    throw txErr;
  } finally {
    client.release();
  }

  // ── Audit success ────────────────────────────────────────────────────
  await writeAudit(pool, {
    agentId, athleteId, contractId,
    actionType: 'extraction_completed',
    status: 'completed',
    metadata: {
      filename: originalname,
      brand: brandName,
      deliverableCount: insertedDeliverables,
      calendarEventCount: insertedEvents,
      lowConfidenceCount: lowConfidence.length,
      rawAICount: rawDeliverables.length,
    },
  });

  return {
    duplicate: false,
    contractId,
    brand: brandName,
    filename: originalname,
    extractionStatus: 'completed',
    deliverableCount: insertedDeliverables,
    calendarEventCount: insertedEvents,
    lowConfidenceCount: lowConfidence.length,
    contractStart,
    contractEnd,
  };
}

module.exports = { processContractUpload, brandColor, writeAudit };
