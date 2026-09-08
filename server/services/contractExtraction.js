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

// ── Coerce whatever the model returned into YYYY-MM-DD ────────────────────
// The prompt asks for ISO and mostly gets it, but "June 15, 2026" and
// "6/15/2026" both show up, and isValidDate() rejects them outright. Rejecting a
// date is not neutral: the deliverable survives with due_date NULL, generates no
// calendar event, and is therefore invisible to the reminder digest. A silently
// undated obligation is the failure this tracker exists to prevent, so a date we
// can read unambiguously is read rather than dropped.
//
// Anything genuinely unparseable still returns null. This widens the accepted
// input format; it does not invent a date where there wasn't one.
function normalizeDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.split('T')[0];
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      // UTC components throughout: getMonth()/getDate() would shift the day for
      // any agent west of UTC, turning a deadline into the day before it.
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
        + `-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
  } catch (_) { /* falls through to null */ }
  console.warn('[contractExtraction] could not parse date:', s);
  return null;
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
      model: 'claude-opus-4-8',
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
  const dueDate = normalizeDate(raw.due_date);
  const startDate = normalizeDate(raw.start_date);
  const endDate = normalizeDate(raw.end_date);
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
// `validated` is either the in-memory shape from validateDeliverable() or the
// same shape rebuilt from a stored row (see deliverableRowToShape).
function buildCalendarEvents({ deliverableId, athleteId, agentId, contractId, validated }) {
  const { description, brand, dueDate, rrule, durationMonths, deliverableType } = validated;
  const color = brandColor(brand);
  const events = [];

  const base = {
    athlete_id: athleteId,
    agent_id: agentId,
    deliverable_id: deliverableId,
    contract_id: contractId,
    title: description,
    brand,
    color,
    // The TYPE travels with the dated instance. A post and an appearance need
    // different lead times and read differently in a reminder; carrying it here
    // means the calendar, the digest and the Home pin can all say which one this
    // is without joining back through athlete_deliverables on every row.
    event_type: deliverableType || null,
    status: 'pending',
    is_generated: true,
    manually_modified: false,
  };

  if (rrule && dueDate) {
    // Recurring → generate instances
    const dates = generateDates(rrule, dueDate, { durationMonths });
    for (const date of dates) {
      events.push({ ...base, id: uid('evt-'), event_date: date, recurrence_instance: true });
    }
  } else if (dueDate) {
    // One-time event
    events.push({ ...base, id: uid('evt-'), event_date: dueDate, recurrence_instance: false });
  }
  // Undated deliverables: no calendar event (shown in "Undated" list in UI).
  // They are also unreachable by the reminder digest, which is inherent rather
  // than an oversight -- there is no date to count back five days from.

  return events;
}

// A stored deliverable row → the shape buildCalendarEvents expects. due_date is
// read as text (to_char) by every caller, never as a JS Date: node-pg turns a
// DATE into local midnight, and toISOString() would then shift it a day
// backwards for every agent west of UTC. A deliverable due the 1st must not
// become an event on the 31st.
function deliverableRowToShape(row) {
  return {
    description: row.deliverable_description,
    brand: row.brand,
    dueDate: row.due_date_iso || null,
    rrule: row.recurrence_rule || null,
    durationMonths: null,          // already folded into the stored rule as COUNT
    deliverableType: row.deliverable_type || null,
  };
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
// STAGE ONE: ANALYZE
//
// Reads the file, extracts, validates, and parks the result as DRAFT rows for
// the agent to review. Deliberately writes nothing to the calendar.
//
// WHY THE DRAFT IS IN THE DATABASE AND NOT IN THE BROWSER. The scanner used to
// hand the whole extraction to the page and take it back on save, which meant
// the confidence score the model produced and the score that got stored were
// only related by convention -- and deliverable_type made the round trip and
// was then dropped on the floor by the save route. Anything the server needs to
// be true about a row cannot survive a lap through a form. Parking it as a draft
// also means a closed tab costs the review, not the extraction: the AI call is
// the expensive part and it is already paid for by the time the table renders.
//
// NOTHING DOWNSTREAM MAY READ A DRAFT. Drafts are excluded from the calendar by
// construction (no events exist yet) and must be excluded by status everywhere
// deliverables are read directly.
// ─────────────────────────────────────────────────────────────────────────
async function analyzeContractUpload({ pool, ai, athleteId, agentId, file, brandHint }) {
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
      `SELECT *, to_char(due_date,'YYYY-MM-DD') AS due_date_iso
         FROM athlete_deliverables WHERE contract_id=$1 AND agent_id=$2 ORDER BY sort_order ASC`,
      [c.id, agentId]
    );
    const events = await pool.query(
      `SELECT * FROM athlete_calendar_events WHERE contract_id=$1 AND agent_id=$2 ORDER BY event_date ASC`,
      [c.id, agentId]
    );

    // A RE-UPLOAD OF AN UNREVIEWED CONTRACT RESUMES THE REVIEW rather than
    // reporting a dead end. The agent uploaded, got distracted, closed the tab,
    // and uploaded again -- the honest response is to show them the extraction
    // they already paid for, still awaiting a decision, not "already processed".
    return {
      duplicate: true,
      contractId: c.id,
      brand: c.brand,
      filename: c.filename,
      extractionStatus: c.extraction_status,
      awaitingReview: c.extraction_status === 'awaiting_review',
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
  let draftRows = [];

  try {
    await client.query('BEGIN');

    // Insert contract record. AWAITING_REVIEW, not completed: nothing about this
    // upload reaches the calendar until a person has looked at it.
    await client.query(
      `INSERT INTO athlete_contracts
         (id, athlete_id, agent_id, filename, brand, file_hash, raw_text, start_date, end_date, extraction_status, extraction_attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'awaiting_review',1)`,
      [contractId, athleteId, agentId, originalname, brandName, fileHash,
       rawText.substring(0, 5000), contractStart, contractEnd]
    );

    // Insert deliverables (deduplicated within this batch by description+due_date)
    const seenKeys = new Set();

    for (let i = 0; i < validated.length; i++) {
      const v = validated[i];
      const key = `${v.description}|${v.dueDate || ''}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const r = await client.query(
        `INSERT INTO athlete_deliverables
           (athlete_id, agent_id, contract_id, deliverable_description, due_date, brand,
            status, recurrence, recurrence_rule, ai_confidence_score, source, sort_order,
            deliverable_type)
         VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$10,$11,$12)
         ON CONFLICT DO NOTHING
         RETURNING *, to_char(due_date,'YYYY-MM-DD') AS due_date_iso`,
        [athleteId, agentId, contractId, v.description, v.dueDate,
         v.brand, v.recurrence, v.rrule, v.confidence, v.source, i,
         v.deliverableType]
      );

      if (r.rows.length) {
        draftRows.push(r.rows[0]);
        insertedDeliverables++;
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

  // ── Audit ────────────────────────────────────────────────────────────
  await writeAudit(pool, {
    agentId, athleteId, contractId,
    actionType: 'extraction_analyzed',
    status: 'awaiting_review',
    metadata: {
      filename: originalname,
      brand: brandName,
      deliverableCount: insertedDeliverables,
      lowConfidenceCount: lowConfidence.length,
      rawAICount: rawDeliverables.length,
    },
  });

  return {
    duplicate: false,
    contractId,
    brand: brandName,
    filename: originalname,
    extractionStatus: 'awaiting_review',
    awaitingReview: true,
    deliverableCount: insertedDeliverables,
    calendarEventCount: 0,
    lowConfidenceCount: lowConfidence.length,
    deliverables: draftRows,
    contractStart,
    contractEnd,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// STAGE TWO: CONFIRM
//
// The agent has looked at the extraction and accepted it, possibly after
// dropping rows. Rejected drafts are deleted; the rest become real deliverables
// and generate their calendar events.
//
// REJECTION IS WHAT MAKES THE REVIEW REAL. Showing a confidence score next to a
// row the agent cannot refuse is decoration. `rejectIds` is how a 62%-confidence
// guess at an obligation stops before it becomes a reminder about a thing the
// contract never said.
//
// Idempotent: a second confirm finds no drafts and is a no-op, so a double-click
// or a retried request cannot double-generate a calendar.
// ─────────────────────────────────────────────────────────────────────────
async function confirmContract({ pool, athleteId, agentId, contractId, rejectIds }) {
  const reject = (Array.isArray(rejectIds) ? rejectIds : [])
    .map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n));

  const client = await pool.connect();
  let accepted = 0, rejected = 0, insertedEvents = 0;

  try {
    await client.query('BEGIN');

    // Ownership is checked in the same statement that does the work, so a
    // contract id belonging to another agent cannot be confirmed by guessing it.
    const owns = await client.query(
      `SELECT id FROM athlete_contracts WHERE id=$1 AND agent_id=$2 AND athlete_id=$3`,
      [contractId, agentId, athleteId]);
    if (!owns.rows.length) {
      await client.query('ROLLBACK');
      throw Object.assign(new Error('Contract not found'), { statusCode: 404 });
    }

    if (reject.length) {
      const del = await client.query(
        `DELETE FROM athlete_deliverables
          WHERE contract_id=$1 AND agent_id=$2 AND status='draft' AND id = ANY($3::int[])`,
        [contractId, agentId, reject]);
      rejected = del.rowCount || 0;
    }

    const drafts = await client.query(
      `UPDATE athlete_deliverables
          SET status='pending', reviewed_at=NOW()
        WHERE contract_id=$1 AND agent_id=$2 AND status='draft'
        RETURNING *, to_char(due_date,'YYYY-MM-DD') AS due_date_iso`,
      [contractId, agentId]);
    accepted = drafts.rowCount || 0;

    for (const row of drafts.rows) {
      const events = buildCalendarEvents({
        deliverableId: row.id, athleteId, agentId, contractId,
        validated: deliverableRowToShape(row),
      });
      for (const evt of events) {
        await client.query(
          `INSERT INTO athlete_calendar_events
             (id, athlete_id, agent_id, deliverable_id, contract_id, title, event_date,
              brand, color, status, is_generated, recurrence_instance, manually_modified,
              event_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           -- THE PREDICATE IS NOT OPTIONAL. idx_cal_events_deliv_date is a
           -- PARTIAL unique index (WHERE deliverable_id IS NOT NULL), and
           -- Postgres will only infer a partial index as the conflict arbiter
           -- if the statement repeats its predicate. Without it this raises
           -- 42P10 "no unique or exclusion constraint matching the ON CONFLICT
           -- specification" -- not on the duplicate, on EVERY insert -- which
           -- rolled back the whole transaction and made the per-athlete
           -- contract upload fail for every contract that had a due date.
           ON CONFLICT (deliverable_id, event_date) WHERE deliverable_id IS NOT NULL
           DO NOTHING`,
          [evt.id, evt.athlete_id, evt.agent_id, evt.deliverable_id, evt.contract_id,
           evt.title, evt.event_date, evt.brand, evt.color, evt.status,
           evt.is_generated, evt.recurrence_instance, evt.manually_modified,
           evt.event_type]
        );
        insertedEvents++;
      }
    }

    await client.query(
      `UPDATE athlete_contracts SET extraction_status='completed' WHERE id=$1 AND agent_id=$2`,
      [contractId, agentId]);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    await writeAudit(pool, {
      agentId, athleteId, contractId,
      actionType: 'confirm_failed', status: 'error', errorMessage: e.message,
    });
    throw e;
  } finally {
    client.release();
  }

  await writeAudit(pool, {
    agentId, athleteId, contractId,
    actionType: 'extraction_confirmed',
    status: 'completed',
    metadata: { accepted, rejected, calendarEventCount: insertedEvents },
  });

  return {
    contractId,
    extractionStatus: 'completed',
    deliverableCount: accepted,
    rejectedCount: rejected,
    calendarEventCount: insertedEvents,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// ONE-SHOT: analyze then immediately confirm.
//
// The per-athlete upload on the roster card has no review table, so it accepts
// whatever comes back. It runs through the SAME two stages rather than a second
// code path -- one engine was the point, and a parallel "quick" implementation
// is exactly how the scanner drifted into dropping deliverable_type and losing
// its idempotency check in the first place.
// ─────────────────────────────────────────────────────────────────────────
async function processContractUpload(opts) {
  const analyzed = await analyzeContractUpload(opts);
  if (analyzed.duplicate || !analyzed.awaitingReview) return analyzed;

  const confirmed = await confirmContract({
    pool: opts.pool, athleteId: opts.athleteId, agentId: opts.agentId,
    contractId: analyzed.contractId, rejectIds: [],
  });
  return { ...analyzed, ...confirmed, awaitingReview: false };
}

module.exports = {
  analyzeContractUpload, confirmContract, processContractUpload,
  buildCalendarEvents, deliverableRowToShape, brandColor, writeAudit,
};
