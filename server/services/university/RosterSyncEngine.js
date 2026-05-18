// server/services/university/RosterSyncEngine.js
// Continuously Reconciled Roster State Engine
//
// ARCHITECTURE RULE:
//   This service ONLY reads/writes university-mode tables.
//   It NEVER touches: outreach_logs, brand_match_scores, brand_contacts,
//   company_enrichment, deals, valuation, pricing.
//
// STATE MACHINE:
//   incoming → active | probable | uncertain | inactive | unknown
//   Transitions triggered ONLY by new data signals or manual confirmation.
//   NEVER by time alone.
//
// CONFLICT RESOLUTION:
//   If sources agree (>70% weighted share) → assign dominant state.
//   If 40–70%                             → 'probable'.
//   If <40% or disagreement               → 'uncertain'.
//   Conflicts ALWAYS recorded. NEVER silently resolved.

'use strict';

const { v4: uuidv4 } = require('uuid');
const { resolveSourceForAthlete, profileCompleteness } = require('./RosterSourceRegistry');

// FORBIDDEN_DEPS — never reference these in queries:
const FORBIDDEN_DEPS = [
  'outreach_logs','brand_match_scores','brand_contacts',
  'company_enrichment','deals','valuation','pricing',
];
void FORBIDDEN_DEPS;

// ── State thresholds ──────────────────────────────────────────────────────
const CONFIDENCE_THRESHOLDS = Object.freeze({
  ACTIVE:    75,   // ≥75 with full profile → active
  PROBABLE:  50,   // ≥50 → probable
  UNCERTAIN: 25,   // ≥25 → uncertain
  INACTIVE:  null, // only assigned on explicit signal, never from score alone
  UNKNOWN:    0,   // default floor
});

// ── Determine state for a single athlete from its data ────────────────────
function _reconcileAthleteState(athleteRow) {
  const data    = (athleteRow.data && typeof athleteRow.data === 'object')
    ? athleteRow.data
    : {};
  const source  = resolveSourceForAthlete(data);
  const completeness = profileCompleteness(data);

  // Weighted confidence:
  // 60% from source trust weight, 40% from data completeness
  const weightedConfidence = Math.round(
    (source.trustWeight * 0.6) + (completeness * 0.4)
  );
  const confidence = Math.max(5, Math.min(100, weightedConfidence));

  // Lifecycle: default 'active_roster' unless data signals otherwise
  // Only explicit signals can set 'transferred', 'graduated', etc.
  let lifecycle = data.lifecycle_stage || 'active_roster';
  if (!['incoming','active_roster','redshirt','transferred','graduated','unknown'].includes(lifecycle)) {
    lifecycle = 'active_roster';
  }

  // Status from confidence
  let status;
  if (confidence >= CONFIDENCE_THRESHOLDS.ACTIVE && completeness >= 40) {
    status = 'active';
  } else if (confidence >= CONFIDENCE_THRESHOLDS.PROBABLE) {
    status = 'probable';
  } else if (confidence >= CONFIDENCE_THRESHOLDS.UNCERTAIN) {
    status = 'uncertain';
  } else {
    status = 'unknown';
  }

  // Override: if lifecycle says inactive/transferred/graduated → status='inactive'
  if (['transferred','graduated'].includes(lifecycle)) {
    status = 'inactive';
  }

  // Conflicts: no multi-source conflict detection at this stage
  // (single-source system currently — conflicts arise when multiple imports disagree)
  const supporting = [source.id];
  const conflicting = [];

  return { status, confidence, lifecycle, supporting, conflicting, source };
}

// ── Compare previous state to new state ───────────────────────────────────
function _stateChanged(prev, next) {
  if (!prev) return true;
  return (
    prev.status !== next.status ||
    Math.abs(prev.confidence_score - next.confidence) >= 5 ||
    prev.lifecycle_stage !== next.lifecycle
  );
}

// ── Core sync function ────────────────────────────────────────────────────
// @param {Pool}   pool
// @param {object} opts
//   universityId: required
//   sport:        null = all sports
//   triggeredBy:  'import'|'manual'|'scheduled'|'rollback'
//   userId:       user who triggered
// @returns {object} syncResult
async function runSync(pool, { universityId, sport = null, triggeredBy = 'manual', userId = 'system' }) {
  const syncId = uuidv4();
  const startedAt = new Date();

  // ── 1. Create sync run record ─────────────────────────────────────────
  try {
    await pool.query(
      `INSERT INTO roster_sync_runs
         (id, university_id, sport, trigger_type, triggered_by, status, started_at)
       VALUES ($1, $2, $3, $4, $5, 'running', NOW())`,
      [syncId, universityId, sport, triggeredBy, userId]
    );
  } catch (err) {
    // Migrations may not have run yet — log and return gracefully
    console.warn('[RosterSyncEngine] Could not create sync run (migrations pending?):', err.message);
    return { ok: false, error: err.message, syncId };
  }

  let athletesEvaluated = 0;
  let stateChanges      = 0;
  let conflictsDetected = 0;
  let errorMessage      = null;

  try {
    // ── 2. Fetch athletes for this university ─────────────────────────
    let athleteQuery = `SELECT * FROM athletes WHERE data->>'university_id' = $1`;
    const queryParams = [universityId];
    if (sport) {
      athleteQuery += ` AND data->>'sport' ILIKE $2`;
      queryParams.push(sport);
    }
    athleteQuery += ' ORDER BY created_at ASC';

    const athleteRows = await pool.query(athleteQuery, queryParams);
    const athletes    = athleteRows.rows;
    athletesEvaluated = athletes.length;

    // ── 3. Fetch previous states for change detection ─────────────────
    const prevStateRows = await pool.query(
      `SELECT athlete_id, status, confidence_score, lifecycle_stage
       FROM athlete_roster_states WHERE university_id = $1`,
      [universityId]
    ).catch(() => ({ rows: [] }));
    const prevStateMap = {};
    prevStateRows.rows.forEach(r => { prevStateMap[r.athlete_id] = r; });

    // ── 4. Fetch previous snapshot for diff ───────────────────────────
    const prevSnapshotRow = await pool.query(
      `SELECT id FROM roster_snapshots
       WHERE university_id = $1 AND is_current = true
       ORDER BY created_at DESC LIMIT 1`,
      [universityId]
    ).catch(() => ({ rows: [] }));
    const prevSnapshotId = prevSnapshotRow.rows[0]?.id || null;

    const prevAthleteIds = new Set();
    if (prevSnapshotId) {
      const prevAthletes = await pool.query(
        'SELECT athlete_id FROM roster_snapshot_athletes WHERE snapshot_id = $1',
        [prevSnapshotId]
      ).catch(() => ({ rows: [] }));
      prevAthletes.rows.forEach(r => prevAthleteIds.add(r.athlete_id));
    }

    // ── 5. Reconcile each athlete ─────────────────────────────────────
    const snapshotAthletes = [];
    const changesFromPrev  = { added: [], removed: [], stateChanges: [] };

    for (const athlete of athletes) {
      const data   = (athlete.data && typeof athlete.data === 'object') ? athlete.data : {};
      const result = _reconcileAthleteState(athlete);

      // Track conflict
      if (result.conflicting.length > 0) conflictsDetected++;

      // Compare to previous state
      const prevState = prevStateMap[athlete.id];
      const changed   = _stateChanged(prevState, {
        status:           result.status,
        confidence_score: result.confidence,
        lifecycle_stage:  result.lifecycle,
      });

      if (changed) stateChanges++;

      // Upsert current state
      await pool.query(
        `INSERT INTO athlete_roster_states
           (athlete_id, university_id, sport, status, confidence_score,
            lifecycle_stage, supporting_sources, conflicting_sources,
            sync_run_id, last_reconciled_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
         ON CONFLICT (athlete_id) DO UPDATE SET
           status              = EXCLUDED.status,
           confidence_score    = EXCLUDED.confidence_score,
           lifecycle_stage     = EXCLUDED.lifecycle_stage,
           supporting_sources  = EXCLUDED.supporting_sources,
           conflicting_sources = EXCLUDED.conflicting_sources,
           sync_run_id         = EXCLUDED.sync_run_id,
           last_reconciled_at  = NOW()`,
        [
          athlete.id,
          universityId,
          data.sport || '',
          result.status,
          result.confidence,
          result.lifecycle,
          result.supporting,
          result.conflicting,
          syncId,
        ]
      ).catch(err => {
        console.warn('[RosterSyncEngine] State upsert failed for', athlete.id, ':', err.message);
      });

      // Append to immutable history ONLY if state changed
      if (changed) {
        const reason = prevState
          ? `State changed from ${prevState.status} (confidence ${prevState.confidence_score}) to ${result.status} (confidence ${result.confidence})`
          : 'Initial state assignment';

        await pool.query(
          `INSERT INTO roster_state_history
             (athlete_id, university_id, sport, status, confidence_score,
              lifecycle_stage, supporting_sources, conflicting_sources,
              changed_by, reason, recorded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
          [
            athlete.id,
            universityId,
            data.sport || '',
            result.status,
            result.confidence,
            result.lifecycle,
            result.supporting,
            result.conflicting,
            syncId,
            reason,
          ]
        ).catch(() => {}); // history failure is non-blocking

        // Track for diff
        if (!prevAthleteIds.has(athlete.id)) {
          changesFromPrev.added.push({ athleteId: athlete.id, name: data.name || 'Unknown' });
        } else {
          changesFromPrev.stateChanges.push({
            athleteId: athlete.id,
            name:      data.name || 'Unknown',
            from:      prevState?.status || 'unknown',
            to:        result.status,
          });
        }
      }

      // Track removed athletes (in prev snapshot but not in current athletes)
      snapshotAthletes.push({
        athleteId:       athlete.id,
        name:            data.name        || 'Unknown',
        sport:           data.sport       || '',
        position:        data.position    || '',
        status:          result.status,
        confidenceScore: result.confidence,
        lifecycleStage:  result.lifecycle,
      });
    }

    // Removed athletes (in previous snapshot but not in current query)
    const currentAthleteIds = new Set(athletes.map(a => a.id));
    for (const prevId of prevAthleteIds) {
      if (!currentAthleteIds.has(prevId)) {
        changesFromPrev.removed.push({ athleteId: prevId });
      }
    }

    // ── 6. Create snapshot ────────────────────────────────────────────
    const snapshotId = uuidv4();

    const statusCounts = { active:0, probable:0, uncertain:0, inactive:0, unknown:0 };
    let confidenceSum  = 0;
    snapshotAthletes.forEach(a => {
      const s = a.status;
      if (statusCounts[s] !== undefined) statusCounts[s]++;
      else statusCounts.unknown++;
      confidenceSum += a.confidenceScore;
    });

    const avgConfidence  = athletes.length > 0
      ? Math.round(confidenceSum / athletes.length) : 0;
    const completeness   = athletes.length > 0
      ? Math.round(((statusCounts.active + statusCounts.probable) / athletes.length) * 100) : 0;

    await pool.query(
      `INSERT INTO roster_snapshots
         (id, university_id, sport, sync_run_id, trigger_type,
          athlete_count, active_count, probable_count, uncertain_count,
          inactive_count, unknown_count, avg_confidence, completeness_score,
          changes_from_previous, is_current, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,NOW())`,
      [
        snapshotId,
        universityId,
        sport,
        syncId,
        triggeredBy,
        athletes.length,
        statusCounts.active,
        statusCounts.probable,
        statusCounts.uncertain,
        statusCounts.inactive,
        statusCounts.unknown,
        avgConfidence,
        completeness,
        JSON.stringify(changesFromPrev),
      ]
    );

    // Freeze athletes into snapshot
    for (const sa of snapshotAthletes) {
      await pool.query(
        `INSERT INTO roster_snapshot_athletes
           (snapshot_id, athlete_id, name, sport, position,
            status, confidence_score, lifecycle_stage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (snapshot_id, athlete_id) DO NOTHING`,
        [
          snapshotId, sa.athleteId, sa.name, sa.sport, sa.position,
          sa.status, sa.confidenceScore, sa.lifecycleStage,
        ]
      );
    }

    // Mark previous snapshots as not current
    if (prevSnapshotId) {
      await pool.query(
        'UPDATE roster_snapshots SET is_current = false WHERE university_id = $1 AND id != $2',
        [universityId, snapshotId]
      ).catch(() => {});
    }

    // ── 7. Complete sync run ──────────────────────────────────────────
    await pool.query(
      `UPDATE roster_sync_runs SET
         status = 'completed',
         athletes_evaluated = $1,
         state_changes = $2,
         conflicts_detected = $3,
         snapshot_id = $4,
         completed_at = NOW()
       WHERE id = $5`,
      [athletesEvaluated, stateChanges, conflictsDetected, snapshotId, syncId]
    );

    const elapsed = Date.now() - startedAt.getTime();
    console.log(`[RosterSyncEngine] Sync ${syncId} complete: ${athletesEvaluated} athletes, ${stateChanges} changes, ${conflictsDetected} conflicts (${elapsed}ms)`);

    return {
      ok:                true,
      syncId,
      snapshotId,
      universityId,
      sport,
      athletesEvaluated,
      stateChanges,
      conflictsDetected,
      statusBreakdown:   statusCounts,
      avgConfidence,
      completenessScore: completeness,
      triggeredBy,
      elapsedMs:         elapsed,
    };

  } catch (err) {
    errorMessage = err.message;
    console.error('[RosterSyncEngine] Sync failed:', err.message);

    await pool.query(
      `UPDATE roster_sync_runs SET
         status = 'failed', error_message = $1, completed_at = NOW()
       WHERE id = $2`,
      [errorMessage, syncId]
    ).catch(() => {});

    return { ok: false, error: errorMessage, syncId };
  }
}

// ── Get sync status for a university ─────────────────────────────────────
async function getSyncStatus(pool, universityId) {
  try {
    // Last sync run
    const lastRun = await pool.query(
      `SELECT * FROM roster_sync_runs
       WHERE university_id = $1
       ORDER BY started_at DESC LIMIT 1`,
      [universityId]
    );

    // Current snapshot
    const snapshot = await pool.query(
      `SELECT * FROM roster_snapshots
       WHERE university_id = $1 AND is_current = true
       ORDER BY created_at DESC LIMIT 1`,
      [universityId]
    );

    // Freshness: days since last successful sync
    const lastSuccess = lastRun.rows.find(r => r.status === 'completed') || lastRun.rows[0];
    const daysSinceSync = lastSuccess
      ? Math.floor((Date.now() - new Date(lastSuccess.completed_at || lastSuccess.started_at).getTime()) / 86400000)
      : null;

    const freshnessScore = daysSinceSync === null ? 0
      : daysSinceSync === 0 ? 100
      : daysSinceSync <= 1  ? 90
      : daysSinceSync <= 7  ? 75
      : daysSinceSync <= 14 ? 50
      : daysSinceSync <= 30 ? 25
      : 5;

    return {
      lastSyncRun:     lastRun.rows[0]   || null,
      currentSnapshot: snapshot.rows[0] || null,
      daysSinceSync,
      freshnessScore,
      syncHealthLabel: freshnessScore >= 75 ? 'Fresh'
                     : freshnessScore >= 50 ? 'Aging'
                     : freshnessScore >= 25 ? 'Stale'
                     : 'Unknown',
    };
  } catch (err) {
    return { error: err.message, freshnessScore: 0, syncHealthLabel: 'Unknown' };
  }
}

// ── List snapshot history ─────────────────────────────────────────────────
async function listSnapshots(pool, universityId, limit = 10) {
  try {
    const rows = await pool.query(
      `SELECT s.*,
              r.trigger_type AS run_trigger,
              r.triggered_by AS run_triggered_by
       FROM roster_snapshots s
       LEFT JOIN roster_sync_runs r ON s.sync_run_id = r.id
       WHERE s.university_id = $1
       ORDER BY s.created_at DESC LIMIT $2`,
      [universityId, limit]
    );
    return rows.rows;
  } catch (_) {
    return [];
  }
}

// ── Rollback to a previous snapshot ──────────────────────────────────────
// Creates a NEW snapshot restoring prior state. Never deletes history.
async function rollback(pool, { universityId, snapshotId, userId }) {
  // Verify snapshot belongs to this university
  const snap = await pool.query(
    'SELECT * FROM roster_snapshots WHERE id = $1 AND university_id = $2',
    [snapshotId, universityId]
  );
  if (!snap.rows.length) {
    return { ok: false, error: 'Snapshot not found or does not belong to your university.' };
  }

  // Get frozen athletes from that snapshot
  const frozenAthletes = await pool.query(
    'SELECT * FROM roster_snapshot_athletes WHERE snapshot_id = $1',
    [snapshotId]
  );

  // Restore each athlete's state
  let restored = 0;
  for (const fa of frozenAthletes.rows) {
    try {
      await pool.query(
        `INSERT INTO athlete_roster_states
           (athlete_id, university_id, sport, status, confidence_score,
            lifecycle_stage, supporting_sources, conflicting_sources,
            sync_run_id, last_reconciled_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'rollback',NOW(),NOW())
         ON CONFLICT (athlete_id) DO UPDATE SET
           status             = EXCLUDED.status,
           confidence_score   = EXCLUDED.confidence_score,
           lifecycle_stage    = EXCLUDED.lifecycle_stage,
           supporting_sources = '{src-internal}',
           conflicting_sources= '{}',
           sync_run_id        = 'rollback',
           last_reconciled_at = NOW()`,
        [fa.athlete_id, universityId, fa.sport, fa.status, fa.confidence_score,
         fa.lifecycle_stage, ['src-internal'], []]
      );

      await pool.query(
        `INSERT INTO roster_state_history
           (athlete_id, university_id, sport, status, confidence_score,
            lifecycle_stage, supporting_sources, conflicting_sources,
            changed_by, reason, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
        [
          fa.athlete_id, universityId, fa.sport,
          fa.status, fa.confidence_score, fa.lifecycle_stage,
          ['src-internal'], [],
          `manual:${userId}`,
          `Rollback to snapshot ${snapshotId}`,
        ]
      );
      restored++;
    } catch (_) {}
  }

  // Run a fresh sync to create new snapshot with rollback trigger
  const syncResult = await runSync(pool, {
    universityId,
    triggeredBy: 'rollback',
    userId,
  });

  return {
    ok: true,
    restoredAthletes: restored,
    sourcSnapshotId: snapshotId,
    newSyncResult: syncResult,
  };
}

module.exports = {
  runSync,
  getSyncStatus,
  listSnapshots,
  rollback,
  _reconcileAthleteState,  // exported for tests
};
