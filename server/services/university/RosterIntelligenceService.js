// server/services/university/RosterIntelligenceService.js
// Orchestrates the full Roster Intelligence pipeline:
//   1. Create/track a discovery job in roster_discovery_jobs
//   2. Discover source URLs via RosterSourceDiscovery
//   3. Fetch + AI-extract athletes via WebExtractionService
//   4. Cross-source validation + confidence scoring
//   5. Route each athlete:
//        ≥ 95 → auto-import via IngestionPipeline
//        70–94 → roster_review_queue for human review
//        < 70  → skip (logged)
//   6. Update job status and counters throughout
//
// CONFIDENCE FORMULA:
//   base       = source.trustWeight (Tier 1 = 90, Tier 2 = 65, etc.)
//   completeness = fields present / max fields (0–100)
//   confidence = Math.round(base * 0.6 + completeness * 0.4)
//   cross_source_bonus: +5 if confirmed by ≥2 independent sources
//
// THREADING: Jobs run async after HTTP response. Poll /discovery/:jobId for status.

'use strict';

const { v4: uuidv4 }          = require('uuid');
const RosterSourceDiscovery   = require('./RosterSourceDiscovery');
const { fetchAndExtractAll }  = require('./WebExtractionService');
const IngestionPipeline       = require('./IngestionPipeline');

// ── Confidence thresholds ─────────────────────────────────────────────────
const AUTO_IMPORT_THRESHOLD = 95;
const REVIEW_THRESHOLD      = 70;

// ── Field completeness weights ─────────────────────────────────────────────
const COMPLETENESS_FIELDS = ['name', 'position', 'year', 'height', 'weight', 'hometown', 'high_school'];
const COMPLETENESS_MAX    = COMPLETENESS_FIELDS.length;

function computeCompleteness(athlete) {
  const present = COMPLETENESS_FIELDS.filter(f => athlete[f] != null && String(athlete[f]).trim() !== '').length;
  return Math.round((present / COMPLETENESS_MAX) * 100);
}

// ── Confidence scoring ─────────────────────────────────────────────────────
function scoreAthlete(athlete, source, crossSourceConfirmed = false) {
  const completeness = computeCompleteness(athlete);
  const base         = source.trustWeight || 60;
  let confidence     = Math.round(base * 0.6 + completeness * 0.4);

  if (crossSourceConfirmed) confidence = Math.min(100, confidence + 5);

  return {
    confidence,
    scoreBreakdown: {
      sourceTrustWeight:   base,
      sourceTier:          source.tier,
      completeness,
      crossSourceBonus:    crossSourceConfirmed ? 5 : 0,
    },
  };
}

// ── Cross-source dedup key ────────────────────────────────────────────────
// Same as IngestionPipeline content hash logic
function athleteKey(athlete) {
  return `${(athlete.name || '').toLowerCase().trim()}`;
}

// ── Update job status in DB ───────────────────────────────────────────────
async function _updateJob(pool, jobId, fields) {
  const sets   = [];
  const values = [];
  let   idx    = 1;

  for (const [key, val] of Object.entries(fields)) {
    sets.push(`${key} = $${idx}`);
    values.push(val);
    idx++;
  }
  values.push(jobId);
  await pool.query(
    `UPDATE roster_discovery_jobs SET ${sets.join(', ')} WHERE id = $${idx}`,
    values
  ).catch(e => console.error('[RosterIntelligence] Job update error:', e.message));
}

// ── Log a source attempt ──────────────────────────────────────────────────
async function _logSource(pool, jobId, source, result) {
  await pool.query(
    `INSERT INTO roster_discovery_sources
       (job_id, url, source_tier, source_label, fetch_status, http_status,
        athletes_extracted, fetch_ms, error_message, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
    [
      jobId,
      source.url,
      source.tier,
      source.label,
      result.ok ? (result.athletes.length > 0 ? 'fetched' : 'empty') : 'failed',
      result.status,
      result.athletes ? result.athletes.length : 0,
      result.fetchMs,
      result.error || result.extractionNotes || null,
    ]
  ).catch(() => {});
}

// ── Log an intelligence action ────────────────────────────────────────────
async function _logAction(pool, jobId, { athleteName, sport, action, confidence, details }) {
  await pool.query(
    `INSERT INTO roster_intelligence_log (job_id, athlete_name, sport, action, confidence, details, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
    [jobId, athleteName, sport, action, confidence || null, details ? JSON.stringify(details) : null]
  ).catch(() => {});
}

// ── Route a scored athlete: auto-import | review queue | skip ─────────────
async function _routeAthlete(pool, {
  jobId, athlete, confidence, scoreBreakdown, sourceUrls,
  universityId, universityName, sport, agentId,
}) {
  if (confidence >= AUTO_IMPORT_THRESHOLD) {
    // Auto-import via IngestionPipeline
    const payload = {
      name:        athlete.name,
      sport,
      school:      universityName,
      position:    athlete.position,
      year:        athlete.year,
      height:      athlete.height,
      weight:      athlete.weight,
      hometown:    athlete.hometown,
      high_school: athlete.high_school,
      major:       athlete.major,
      university_id: universityId,
    };

    await IngestionPipeline.ingest(pool, {
      source:       'roster_intelligence',
      universityId,
      agentId:      agentId || 'system',
      athleteData:  payload,
    }).catch(e => console.warn('[RosterIntelligence] Ingest error:', e.message));

    await _logAction(pool, jobId, {
      athleteName: athlete.name, sport, action: 'auto_imported', confidence,
      details: { scoreBreakdown, sourceUrls },
    });

    return 'imported';
  }

  if (confidence >= REVIEW_THRESHOLD) {
    // Queue for human review
    await pool.query(
      `INSERT INTO roster_review_queue
         (job_id, university_id, university_name, sport, athlete_data,
          confidence_score, score_breakdown, source_urls, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',NOW())`,
      [
        jobId,
        universityId,
        universityName,
        sport,
        JSON.stringify({
          ...athlete,
          university_id: universityId,
          school: universityName,
          sport,
        }),
        confidence,
        JSON.stringify(scoreBreakdown),
        sourceUrls,
      ]
    ).catch(e => console.warn('[RosterIntelligence] Review queue insert error:', e.message));

    await _logAction(pool, jobId, {
      athleteName: athlete.name, sport, action: 'queued', confidence,
      details: { scoreBreakdown, sourceUrls },
    });

    return 'queued';
  }

  // Skip
  await _logAction(pool, jobId, {
    athleteName: athlete.name, sport, action: 'skipped', confidence,
    details: { scoreBreakdown, reason: 'confidence below threshold' },
  });

  return 'skipped';
}

// ── Main: start a discovery job (async — returns immediately) ─────────────
// Returns the jobId. Caller polls GET /discovery/:jobId for status.
async function startDiscoveryJob(pool, { universityId, universityName, sport, triggeredBy, agentId }) {
  const jobId = uuidv4();

  // Create the job record
  await pool.query(
    `INSERT INTO roster_discovery_jobs
       (id, university_id, university_name, sport, triggered_by, status, started_at)
     VALUES ($1,$2,$3,$4,$5,'queued',NOW())`,
    [jobId, universityId, universityName, sport, triggeredBy || 'manual']
  );

  // Run the pipeline in the background — do not await
  _runPipeline(pool, {
    jobId, universityId, universityName, sport, agentId,
  }).catch(async err => {
    console.error(`[RosterIntelligence] Pipeline error for job ${jobId}:`, err.message);
    await _updateJob(pool, jobId, {
      status: 'failed',
      error_message: err.message,
      completed_at: new Date(),
    });
  });

  return jobId;
}

// ── Pipeline (async background execution) ────────────────────────────────
async function _runPipeline(pool, { jobId, universityId, universityName, sport, agentId }) {
  try {
    // Phase 1: Discover sources
    await _updateJob(pool, jobId, { status: 'discovering', progress_message: 'Discovering roster sources...' });

    const sources = RosterSourceDiscovery.discoverSources(universityName, sport);

    await _updateJob(pool, jobId, {
      sources_found:    sources.length,
      progress_message: `Found ${sources.length} sources — fetching...`,
    });

    // Phase 2: Fetch + extract
    await _updateJob(pool, jobId, { status: 'extracting' });

    const context = { universityName, sport, sourceUrl: '' };
    const fetchResults = await fetchAndExtractAll(
      sources,
      context,
      { stopEarlyOnTier1: true }
    );

    // Log each source attempt and count fetched
    let sourcesFetched = 0;
    for (const fr of fetchResults) {
      await _logSource(pool, jobId, fr.source, fr);
      if (fr.ok) sourcesFetched++;
    }

    await _updateJob(pool, jobId, {
      sources_fetched: sourcesFetched,
      progress_message: `Fetched ${sourcesFetched}/${sources.length} sources — validating athletes...`,
    });

    // Phase 3: Merge athletes across sources + cross-source tracking
    // Build map: athleteKey → { athlete, sources: [{source, result}] }
    await _updateJob(pool, jobId, { status: 'validating' });

    const athleteMap = new Map();

    for (const fr of fetchResults) {
      if (!fr.ok || !fr.athletes?.length) continue;

      for (const athlete of fr.athletes) {
        const key = athleteKey(athlete);
        if (!athleteMap.has(key)) {
          athleteMap.set(key, { athlete, sources: [] });
        }
        athleteMap.get(key).sources.push({ source: fr.source, result: fr });
      }
    }

    const totalFound = athleteMap.size;
    await _updateJob(pool, jobId, {
      athletes_found:   totalFound,
      progress_message: `Found ${totalFound} unique athletes — scoring and importing...`,
    });

    // Phase 4: Score + route each athlete
    await _updateJob(pool, jobId, { status: 'importing' });

    let imported = 0;
    let queued   = 0;
    let skipped  = 0;

    for (const [, { athlete, sources: athleteSources }] of athleteMap) {
      // Use the highest-trust source for scoring
      const bestEntry = athleteSources.sort((a, b) => (b.source.trustWeight || 0) - (a.source.trustWeight || 0))[0];
      const crossSourceConfirmed = athleteSources.length >= 2;
      const { confidence, scoreBreakdown } = scoreAthlete(athlete, bestEntry.source, crossSourceConfirmed);
      const sourceUrls = athleteSources.map(e => e.source.url);

      const outcome = await _routeAthlete(pool, {
        jobId, athlete, confidence, scoreBreakdown, sourceUrls,
        universityId, universityName, sport, agentId,
      });

      if (outcome === 'imported') imported++;
      else if (outcome === 'queued') queued++;
      else skipped++;
    }

    // Phase 5: Complete
    await _updateJob(pool, jobId, {
      status:             'completed',
      athletes_imported:  imported,
      athletes_queued:    queued,
      athletes_skipped:   skipped,
      progress_message:   `Done — ${imported} imported, ${queued} in review queue, ${skipped} skipped`,
      completed_at:       new Date(),
    });

    console.log(`[RosterIntelligence] Job ${jobId} complete: ${imported} imported, ${queued} queued, ${skipped} skipped`);

  } catch (err) {
    throw err;  // Caught by caller
  }
}

// ── Get job status ─────────────────────────────────────────────────────────
async function getJobStatus(pool, jobId) {
  const jobRow = await pool.query(
    `SELECT * FROM roster_discovery_jobs WHERE id = $1`,
    [jobId]
  );
  if (!jobRow.rows.length) return null;

  const job = jobRow.rows[0];

  // Also get source details
  const sourcesRow = await pool.query(
    `SELECT url, source_tier, source_label, fetch_status, http_status,
            athletes_extracted, fetch_ms, error_message
     FROM roster_discovery_sources WHERE job_id = $1 ORDER BY id`,
    [jobId]
  ).catch(() => ({ rows: [] }));

  return { ...job, sources: sourcesRow.rows };
}

// ── Get review queue ───────────────────────────────────────────────────────
async function getReviewQueue(pool, { universityId, status = 'pending', limit = 50 }) {
  const rows = await pool.query(
    `SELECT id, job_id, university_name, sport, athlete_data, confidence_score,
            score_breakdown, source_urls, status, created_at
     FROM roster_review_queue
     WHERE university_id = $1 AND status = $2
     ORDER BY confidence_score DESC, created_at ASC
     LIMIT $3`,
    [universityId, status, limit]
  );
  return rows.rows;
}

// ── Approve a review queue item ────────────────────────────────────────────
async function approveReviewItem(pool, { reviewId, reviewedBy, agentId }) {
  const row = await pool.query(
    'SELECT * FROM roster_review_queue WHERE id = $1',
    [reviewId]
  );
  if (!row.rows.length) throw new Error('Review item not found');

  const item = row.rows[0];
  if (item.status !== 'pending') throw new Error(`Item already ${item.status}`);

  // Import via IngestionPipeline
  const result = await IngestionPipeline.ingest(pool, {
    source:       'review_approved',
    universityId: item.university_id,
    agentId:      agentId || reviewedBy || 'system',
    athleteData:  typeof item.athlete_data === 'string' ? JSON.parse(item.athlete_data) : item.athlete_data,
  });

  // Mark as approved
  await pool.query(
    `UPDATE roster_review_queue
     SET status = 'approved', reviewed_by = $1, reviewed_at = NOW(),
         athlete_id = $2
     WHERE id = $3`,
    [reviewedBy, result?.athleteId || null, reviewId]
  );

  return { ok: true, athleteId: result?.athleteId };
}

// ── Reject a review queue item ─────────────────────────────────────────────
async function rejectReviewItem(pool, { reviewId, reviewedBy }) {
  await pool.query(
    `UPDATE roster_review_queue
     SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW()
     WHERE id = $2 AND status = 'pending'`,
    [reviewedBy, reviewId]
  );
  return { ok: true };
}

// ── List recent jobs for a university ─────────────────────────────────────
async function listJobs(pool, { universityId, limit = 10 }) {
  const rows = await pool.query(
    `SELECT id, university_name, sport, status, sources_found, sources_fetched,
            athletes_found, athletes_imported, athletes_queued, athletes_skipped,
            progress_message, error_message, started_at, completed_at
     FROM roster_discovery_jobs
     WHERE university_id = $1
     ORDER BY started_at DESC
     LIMIT $2`,
    [universityId, limit]
  );
  return rows.rows;
}

module.exports = {
  startDiscoveryJob,
  getJobStatus,
  getReviewQueue,
  approveReviewItem,
  rejectReviewItem,
  listJobs,
};
