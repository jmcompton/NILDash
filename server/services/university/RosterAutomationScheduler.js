// server/services/university/RosterAutomationScheduler.js
// Continuously running roster sync scheduler.
//
// DESIGN:
//   Runs inside the server process via setInterval.
//   Uses DB timestamps (not in-memory state) for resilience across restarts.
//   Single tick processes one university to avoid pool exhaustion.
//   Never throws — all errors caught and logged to automation_scheduler_log.
//
// SCHEDULE:
//   Tick:          every 30 minutes
//   Light sync:    if last sync > 6 hours ago
//   Deep sync:     if last deep sync > 24 hours ago (processes ingestion queue too)
//
// FORBIDDEN_DEPS:
//   outreach_logs, brand_match_scores, brand_contacts,
//   company_enrichment, deals, valuation, pricing

'use strict';

const { v4: uuidv4 }      = require('uuid');
const RosterSyncEngine    = require('./RosterSyncEngine');
const IngestionPipeline   = require('./IngestionPipeline');

const TICK_INTERVAL_MS      = 30 * 60 * 1000;   // 30 minutes
const LIGHT_SYNC_THRESHOLD  =  6 * 60 * 60 * 1000;  // 6 hours
const DEEP_SYNC_THRESHOLD   = 24 * 60 * 60 * 1000;  // 24 hours

let _pool       = null;
let _intervalId = null;
let _running    = false;
let _tickCount  = 0;

// ── Start the scheduler ───────────────────────────────────────────────────
function start(pool) {
  if (_intervalId) {
    console.log('[Scheduler] Already running — skipping duplicate start');
    return;
  }
  _pool = pool;

  // Log start
  _log(pool, { eventType: 'start', notes: 'Scheduler started on server boot' }).catch(() => {});

  // Run first tick slightly delayed to let DB migrations settle
  setTimeout(() => tick(pool).catch(() => {}), 15000);

  // Schedule recurring ticks
  _intervalId = setInterval(() => {
    tick(pool).catch(err => {
      console.error('[Scheduler] Tick error (unhandled):', err.message);
    });
  }, TICK_INTERVAL_MS);

  console.log(`[Scheduler] Started — tick every ${TICK_INTERVAL_MS / 60000} minutes`);
}

// ── Stop the scheduler ────────────────────────────────────────────────────
function stop() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  if (_pool) {
    _log(_pool, { eventType: 'stop', notes: 'Scheduler stopped' }).catch(() => {});
  }
  console.log('[Scheduler] Stopped');
}

// ── Single tick ───────────────────────────────────────────────────────────
async function tick(pool) {
  if (_running) {
    console.log('[Scheduler] Tick skipped — previous tick still running');
    return;
  }
  _running  = true;
  _tickCount++;
  const tickStart = Date.now();

  let universitiesProcessed = 0;
  let syncsTriggered        = 0;
  let eventsProcessed       = 0;

  try {
    // Fetch all universities that have athletes
    const univRows = await pool.query(
      `SELECT DISTINCT u.id, u.name,
              MAX(asl.created_at) FILTER (WHERE asl.event_type IN ('light_sync','deep_sync')) AS last_sync_at,
              MAX(asl.created_at) FILTER (WHERE asl.event_type = 'deep_sync')                AS last_deep_sync_at
       FROM universities u
       JOIN athletes a ON a.data->>'university_id' = u.id
       LEFT JOIN automation_scheduler_log asl ON asl.university_id = u.id
       GROUP BY u.id, u.name`
    ).catch(() => ({ rows: [] }));

    const universities = univRows.rows;
    if (!universities.length) {
      await _log(pool, { eventType: 'tick', notes: 'No universities with athletes — idle tick', durationMs: Date.now() - tickStart });
      return;
    }

    // Process one university per tick to avoid overloading the connection pool
    // Round-robin by tick count
    const univ = universities[_tickCount % universities.length];
    universitiesProcessed = 1;

    const now            = Date.now();
    const lastSync       = univ.last_sync_at    ? new Date(univ.last_sync_at).getTime()    : 0;
    const lastDeepSync   = univ.last_deep_sync_at ? new Date(univ.last_deep_sync_at).getTime() : 0;
    const sinceSync      = now - lastSync;
    const sinceDeepSync  = now - lastDeepSync;

    // ── Deep sync: process ingestion queue + full reconciliation ──────
    if (sinceDeepSync > DEEP_SYNC_THRESHOLD) {
      console.log(`[Scheduler] Deep sync for ${univ.name}`);

      // Process any pending ingestion events first
      // Need an agentId — find the university-linked user
      const agentRow = await pool.query(
        'SELECT id FROM users WHERE university_id = $1 LIMIT 1',
        [univ.id]
      ).catch(() => ({ rows: [] }));
      const agentId = agentRow.rows[0]?.id || 'system';

      const qResult = await IngestionPipeline.processQueue(pool, {
        universityId: univ.id,
        agentId,
        limit: 100,
      }).catch(e => ({ processed: 0, error: e.message }));

      eventsProcessed += qResult.processed || 0;

      // Full roster reconciliation
      const syncResult = await RosterSyncEngine.runSync(pool, {
        universityId: univ.id,
        triggeredBy:  'scheduled',
        userId:       agentId,
      }).catch(e => ({ ok: false, error: e.message }));

      if (syncResult.ok) syncsTriggered++;

      await _log(pool, {
        eventType:    'deep_sync',
        universityId: univ.id,
        universitiesProcessed: 1,
        eventsProcessed:       qResult.processed || 0,
        syncsTriggered,
        durationMs: Date.now() - tickStart,
        notes: `Deep sync: ${qResult.processed || 0} events, sync ${syncResult.ok ? 'ok' : 'failed'}`,
      });

    // ── Light sync: reconciliation only ──────────────────────────────
    } else if (sinceSync > LIGHT_SYNC_THRESHOLD) {
      console.log(`[Scheduler] Light sync for ${univ.name}`);

      const agentRow = await pool.query(
        'SELECT id FROM users WHERE university_id = $1 LIMIT 1',
        [univ.id]
      ).catch(() => ({ rows: [] }));
      const agentId = agentRow.rows[0]?.id || 'system';

      const syncResult = await RosterSyncEngine.runSync(pool, {
        universityId: univ.id,
        triggeredBy:  'scheduled',
        userId:       agentId,
      }).catch(e => ({ ok: false, error: e.message }));

      if (syncResult.ok) syncsTriggered++;

      await _log(pool, {
        eventType:    'light_sync',
        universityId: univ.id,
        universitiesProcessed: 1,
        syncsTriggered,
        durationMs: Date.now() - tickStart,
        notes: `Light sync: ${syncResult.ok ? 'ok' : syncResult.error}`,
      });

    } else {
      // Nothing needed this tick
      await _log(pool, {
        eventType: 'tick',
        notes:     `${univ.name} — last sync ${Math.round(sinceSync / 3600000)}h ago, no action needed`,
        durationMs: Date.now() - tickStart,
      });
    }

  } catch (err) {
    console.error('[Scheduler] Tick failed:', err.message);
    await _log(pool, {
      eventType: 'error',
      notes: `Tick error: ${err.message}`,
      durationMs: Date.now() - tickStart,
    }).catch(() => {});
  } finally {
    _running = false;
  }
}

// ── Get scheduler status ──────────────────────────────────────────────────
async function getStatus(pool) {
  try {
    // Recent tick history
    const recentLogs = await pool.query(
      `SELECT event_type, university_id, syncs_triggered, events_processed,
              duration_ms, created_at, error_message
       FROM automation_scheduler_log
       ORDER BY created_at DESC LIMIT 20`
    );

    // University sync health from view
    const univHealth = await pool.query(
      'SELECT * FROM university_sync_health ORDER BY university_name'
    ).catch(() => ({ rows: [] }));

    return {
      isRunning:   !!_intervalId,
      tickCount:   _tickCount,
      tickIntervalMinutes: TICK_INTERVAL_MS / 60000,
      lightSyncThresholdHours: LIGHT_SYNC_THRESHOLD / 3600000,
      deepSyncThresholdHours:  DEEP_SYNC_THRESHOLD  / 3600000,
      recentLogs:  recentLogs.rows,
      universityHealth: univHealth.rows,
    };
  } catch (err) {
    return {
      isRunning: !!_intervalId,
      tickCount: _tickCount,
      error: err.message,
    };
  }
}

// ── Manual force trigger ──────────────────────────────────────────────────
// Runs a deep sync immediately for a specific university.
async function forceTrigger(pool, { universityId, userId }) {
  const agentRow = await pool.query(
    'SELECT id FROM users WHERE university_id = $1 LIMIT 1',
    [universityId]
  ).catch(() => ({ rows: [] }));
  const agentId = agentRow.rows[0]?.id || userId || 'system';

  // Process queue first
  const qResult = await IngestionPipeline.processQueue(pool, {
    universityId,
    agentId,
    limit: 200,
  }).catch(e => ({ processed: 0, error: e.message }));

  // Then sync
  const syncResult = await RosterSyncEngine.runSync(pool, {
    universityId,
    triggeredBy: 'manual',
    userId: agentId,
  });

  await _log(pool, {
    eventType:    'deep_sync',
    universityId,
    eventsProcessed:  qResult.processed || 0,
    syncsTriggered:   syncResult.ok ? 1 : 0,
    notes: `Manual force trigger by ${userId}`,
  }).catch(() => {});

  return { queueResult: qResult, syncResult };
}

// ── Private: log a scheduler event ───────────────────────────────────────
async function _log(pool, {
  eventType,
  universityId       = null,
  universitiesProcessed = 0,
  eventsProcessed    = 0,
  syncsTriggered     = 0,
  durationMs         = null,
  notes              = null,
}) {
  await pool.query(
    `INSERT INTO automation_scheduler_log
       (id, university_id, event_type, universities_processed,
        events_processed, syncs_triggered, duration_ms, error_message, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
    [
      uuidv4(), universityId, eventType, universitiesProcessed,
      eventsProcessed, syncsTriggered, durationMs, notes,
    ]
  );
}

module.exports = { start, stop, tick, getStatus, forceTrigger };
