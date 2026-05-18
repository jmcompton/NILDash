// server/services/university/IngestionPipeline.js
// Standardized data ingestion pipeline — ALL athlete data enters here.
//
// DESIGN RULE:
//   Every data source (bulk import, API, manual, seed, scheduled job)
//   must produce an IngestionEvent. Events are immutable once created.
//   Resolution and commitment happen separately.
//
// FORBIDDEN_DEPS:
//   outreach_logs, brand_match_scores, brand_contacts,
//   company_enrichment, deals, valuation, pricing

'use strict';

const { v4: uuidv4 } = require('uuid');
const { normalizeSchoolName, normalizeSport } = require('./BulkImportService');
const { resolve }                             = require('./AthleteEntityResolutionEngine');

// Source confidence defaults by source type
const SOURCE_CONFIDENCE = {
  bulk_import: 70,
  api_feed:    80,
  webhook:     75,
  manual:      90,
  scheduler:   60,
  seed:        85,
};

// ── Content hash for deduplication ───────────────────────────────────────
// Prevents processing the same athlete record twice from the same source.
function contentHash(data) {
  const name   = (data.name   || '').toLowerCase().trim();
  const sport  = normalizeSport(data.sport   || '').toLowerCase();
  const school = normalizeSchoolName(data.school || '').toLowerCase();
  return `${name}|${sport}|${school}`;
}

// ── Normalize a raw payload ───────────────────────────────────────────────
function normalizePayload(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name  = (raw.name || raw.full_name || raw.athlete_name || '').trim();
  const sport = normalizeSport(raw.sport || raw.sport_name || '');
  const school = normalizeSchoolName(raw.school || raw.university || raw.institution || '');

  return {
    name,
    sport,
    school,
    position:    (raw.position || raw.pos || '').trim(),
    schoolTier:  (raw.schoolTier || raw.school_tier || raw.tier || 'G5').trim(),
    instagram:   parseInt(String(raw.instagram || raw.ig || '0').replace(/,/g, '')) || 0,
    tiktok:      parseInt(String(raw.tiktok || raw.tt || '0').replace(/,/g, '')) || 0,
    engagement:  parseFloat(raw.engagement || raw.engagement_rate || 0) || 0,
    stats:       (raw.stats || raw.stat_line || raw.statistics || '').trim(),
    notes:       (raw.notes || raw.bio || raw.description || '').trim(),
    university_id: raw.university_id || null,
    lifecycle_stage: raw.lifecycle_stage || 'active_roster',
  };
}

// ── Ingest a single record ────────────────────────────────────────────────
// Creates an ingestion_event row. Does NOT write to athletes table yet.
// @returns { eventId, status, contentHash, isDuplicate }
async function ingest(pool, {
  sourceType,
  sourceId     = 'src-unknown',
  rawPayload,
  universityId = null,
  userId       = 'system',
}) {
  const eventId   = uuidv4();
  const normalized = normalizePayload(rawPayload);
  const hash       = normalized ? contentHash(normalized) : null;
  const confidence = SOURCE_CONFIDENCE[sourceType] || 50;

  // ── Deduplication check ────────────────────────────────────────────
  // If an event with the same content hash was committed in the last 24h, skip.
  if (hash) {
    try {
      const existing = await pool.query(
        `SELECT id FROM ingestion_events
         WHERE content_hash = $1
           AND status = 'committed'
           AND created_at > NOW() - INTERVAL '24 hours'
         LIMIT 1`,
        [hash]
      );
      if (existing.rows.length > 0) {
        // Log the duplicate event but mark it as such
        await pool.query(
          `INSERT INTO ingestion_events
             (id, university_id, source_type, source_id, raw_payload, normalized,
              status, ingestion_confidence, content_hash, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,'duplicate',$7,$8,NOW())`,
          [eventId, universityId, sourceType, sourceId,
           JSON.stringify(rawPayload), JSON.stringify(normalized),
           confidence, hash]
        );
        return { eventId, status: 'duplicate', contentHash: hash, isDuplicate: true };
      }
    } catch (_) { /* dedup check is non-blocking */ }
  }

  // ── Create ingestion event ─────────────────────────────────────────
  try {
    await pool.query(
      `INSERT INTO ingestion_events
         (id, university_id, source_type, source_id, raw_payload, normalized,
          status, ingestion_confidence, content_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,NOW())`,
      [
        eventId, universityId, sourceType, sourceId,
        JSON.stringify(rawPayload),
        normalized ? JSON.stringify(normalized) : null,
        confidence, hash,
      ]
    );
    return { eventId, status: 'pending', contentHash: hash, isDuplicate: false };
  } catch (err) {
    console.warn('[IngestionPipeline] Event creation failed:', err.message);
    return { eventId: null, status: 'failed', error: err.message };
  }
}

// ── Ingest a batch ────────────────────────────────────────────────────────
// Creates ingestion events for an array of raw records.
// This wraps BulkImportService — all imports enter through here.
async function ingestBatch(pool, {
  records,
  sourceType,
  sourceId   = 'src-import',
  universityId,
  userId     = 'system',
}) {
  const results = { total: records.length, queued: 0, duplicates: 0, failed: 0, eventIds: [] };

  for (const raw of records) {
    const result = await ingest(pool, { sourceType, sourceId, rawPayload: raw, universityId, userId });
    if (result.isDuplicate)          results.duplicates++;
    else if (result.status === 'failed') results.failed++;
    else { results.queued++; if (result.eventId) results.eventIds.push(result.eventId); }
  }

  return results;
}

// ── Process pending ingestion queue ──────────────────────────────────────
// Resolves pending events → writes to athletes table → marks committed.
// Called by scheduler and after bulk import.
// @returns ProcessResult
async function processQueue(pool, { universityId, agentId, limit = 50 }) {
  const processResult = {
    processed: 0, committed: 0, skipped: 0, failed: 0,
    newEntities: 0, exactMatches: 0, probableMatches: 0, conflicts: 0,
  };

  // Fetch pending events for this university
  let pending = [];
  try {
    const rows = await pool.query(
      `SELECT * FROM ingestion_events
       WHERE university_id = $1
         AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT $2`,
      [universityId, limit]
    );
    pending = rows.rows;
  } catch (err) {
    console.warn('[IngestionPipeline] Queue fetch failed:', err.message);
    return processResult;
  }

  for (const event of pending) {
    processResult.processed++;

    // Mark as resolving
    await pool.query(
      `UPDATE ingestion_events SET status = 'resolving', resolved_at = NOW() WHERE id = $1`,
      [event.id]
    ).catch(() => {});

    const normalized = event.normalized;
    if (!normalized || !normalized.name) {
      await _markFailed(pool, event.id, 'No normalized name after normalization pass');
      processResult.failed++;
      continue;
    }

    // ── Entity resolution ──────────────────────────────────────────
    let resolution;
    try {
      resolution = await resolve(pool, normalized, universityId);
    } catch (err) {
      await _markFailed(pool, event.id, `Resolution error: ${err.message}`);
      processResult.failed++;
      continue;
    }

    // Log resolution decision
    await pool.query(
      `INSERT INTO athlete_entity_links
         (ingestion_event_id, athlete_id, match_type, match_score,
          conflict_flags, resolution_reason, resolved_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'system',NOW())`,
      [
        event.id,
        resolution.matchedAthleteId,
        resolution.matchType,
        resolution.matchScore,
        resolution.conflictFlags,
        resolution.resolutionReason,
      ]
    ).catch(() => {});

    // ── Commit decision based on match type ────────────────────────
    if (resolution.matchType === 'conflict') {
      // Conflict: mark event as partial, don't write to athletes
      await pool.query(
        `UPDATE ingestion_events SET status = 'partial', committed_at = NOW() WHERE id = $1`,
        [event.id]
      ).catch(() => {});
      processResult.conflicts++;
      processResult.skipped++;
      continue;
    }

    if (resolution.matchType === 'exact') {
      // Exact match: update existing athlete's data fields (non-destructive)
      await _updateExistingAthlete(pool, resolution.matchedAthleteId, normalized, universityId);
      processResult.exactMatches++;
    } else if (resolution.matchType === 'probable') {
      // Probable: insert as new athlete with lower confidence (don't overwrite)
      // — safer than silently merging uncertain matches
      await _insertNewAthlete(pool, normalized, universityId, agentId, 'probable');
      processResult.probableMatches++;
      processResult.newEntities++;
    } else {
      // new_entity: insert
      await _insertNewAthlete(pool, normalized, universityId, agentId, 'new');
      processResult.newEntities++;
    }

    // Mark committed
    await pool.query(
      `UPDATE ingestion_events SET status = 'committed', committed_at = NOW() WHERE id = $1`,
      [event.id]
    ).catch(() => {});
    processResult.committed++;
  }

  return processResult;
}

// ── Private: update existing athlete (non-destructive merge) ─────────────
async function _updateExistingAthlete(pool, athleteId, normalized, universityId) {
  try {
    // Only update fields that are missing or empty in existing record
    const existing = await pool.query('SELECT data FROM athletes WHERE id = $1', [athleteId]);
    if (!existing.rows.length) return;

    const current = existing.rows[0].data || {};
    const merged  = { ...normalized };

    // Non-destructive: preserve existing values, only fill in blanks
    Object.keys(current).forEach(k => {
      if (current[k] !== null && current[k] !== '' && current[k] !== 0) {
        merged[k] = current[k];
      }
    });

    // Always stamp university_id
    merged.university_id = universityId || current.university_id;

    await pool.query(
      `UPDATE athletes SET data = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(merged), athleteId]
    );
  } catch (err) {
    console.warn('[IngestionPipeline] Update athlete failed:', athleteId, err.message);
  }
}

// ── Private: insert new athlete ───────────────────────────────────────────
async function _insertNewAthlete(pool, normalized, universityId, agentId, matchContext) {
  try {
    const athleteId  = `auto-${uuidv4()}`;
    const athleteData = {
      ...normalized,
      university_id: universityId,
      _ingestion_context: matchContext,
    };

    await pool.query(
      `INSERT INTO athletes (id, agent_id, data, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [athleteId, agentId || 'system', JSON.stringify(athleteData)]
    );
  } catch (err) {
    console.warn('[IngestionPipeline] Insert athlete failed:', err.message);
  }
}

// ── Private: mark event failed ────────────────────────────────────────────
async function _markFailed(pool, eventId, message) {
  await pool.query(
    `UPDATE ingestion_events SET status = 'failed', error_message = $1 WHERE id = $2`,
    [message, eventId]
  ).catch(() => {});
}

// ── Get queue status for a university ─────────────────────────────────────
async function getQueueStatus(pool, universityId) {
  try {
    const rows = await pool.query(
      `SELECT
         status,
         COUNT(*)::int AS count,
         MIN(created_at) AS oldest,
         MAX(created_at) AS newest
       FROM ingestion_events
       WHERE university_id = $1
       GROUP BY status
       ORDER BY status`,
      [universityId]
    );

    const byStatus = {};
    rows.rows.forEach(r => { byStatus[r.status] = { count: r.count, oldest: r.oldest, newest: r.newest }; });

    return {
      universityId,
      byStatus,
      pendingCount:    byStatus.pending?.count   || 0,
      committedCount:  byStatus.committed?.count || 0,
      failedCount:     byStatus.failed?.count    || 0,
      conflictCount:   byStatus.partial?.count   || 0,
      duplicateCount:  byStatus.duplicate?.count || 0,
    };
  } catch (err) {
    return { universityId, error: err.message, pendingCount: 0 };
  }
}

// ── Get recent ingestion events ───────────────────────────────────────────
async function getRecentEvents(pool, universityId, limit = 20) {
  try {
    const rows = await pool.query(
      `SELECT e.id, e.source_type, e.status, e.ingestion_confidence,
              e.created_at, e.committed_at, e.error_message,
              e.normalized->>'name'   AS athlete_name,
              e.normalized->>'sport'  AS athlete_sport,
              l.match_type, l.match_score, l.conflict_flags, l.athlete_id
       FROM ingestion_events e
       LEFT JOIN athlete_entity_links l ON l.ingestion_event_id = e.id
       WHERE e.university_id = $1
       ORDER BY e.created_at DESC
       LIMIT $2`,
      [universityId, limit]
    );
    return rows.rows;
  } catch (_) {
    return [];
  }
}

module.exports = {
  ingest,
  ingestBatch,
  processQueue,
  getQueueStatus,
  getRecentEvents,
  contentHash,
  normalizePayload,
};
