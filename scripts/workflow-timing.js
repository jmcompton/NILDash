#!/usr/bin/env node
// scripts/workflow-timing.js
//
// Per-step wall clock for recent AI Outreach runs, plus the pre-warm hit rate --
// the two numbers that decide whether the modal is slow because the workflow is
// slow, or slow because it should never have run the workflow at all.
//
// Everything here already exists in the database. executeWorkflow logs
// <step>_started / <step>_complete / <step>_failed into workflow_events with a
// timestamp, and draftPrewarm writes outreach_logs rows stamped source='prewarm'.
// This just reads them.
//
// Usage:
//   DATABASE_URL=... node scripts/workflow-timing.js            # last 15 runs
//   DATABASE_URL=... node scripts/workflow-timing.js 40
//   DATABASE_URL=... node scripts/workflow-timing.js 15 --json

'use strict';

const { Pool } = require('pg');

const LIMIT = parseInt(process.argv[2], 10) || 15;
const AS_JSON = process.argv.includes('--json');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. On Railway: railway run node scripts/workflow-timing.js');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
});

// The seven steps executeWorkflow runs, in order.
const STEPS = ['enrichment', 'contact_discovery', 'brand_match', 'pitch_generation',
  'deck_generation', 'email_draft', 'crm_update'];

const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n).slice(0, n);
const rpad = (s, n) => String(s === null || s === undefined ? '' : s).padStart(n);
const secs = (ms) => (ms === null || ms === undefined) ? '-' : (ms / 1000).toFixed(1);

(async () => {
  const { rows: runs } = await pool.query(
    `SELECT id, agent_id, athlete_id, brand_name, status, started_at, completed_at,
            steps_completed, steps_failed, contact_id, error_message
       FROM automation_runs
      ORDER BY created_at DESC
      LIMIT $1`, [LIMIT]);

  if (!runs.length) {
    console.log('No workflow runs recorded. Every modal open hit a pre-warmed draft, or none has run.');
    await pool.end();
    return;
  }

  const ids = runs.map((r) => r.id);
  const { rows: events } = await pool.query(
    `SELECT run_id, event_type, payload, created_at
       FROM workflow_events
      WHERE run_id = ANY($1)
      ORDER BY created_at ASC`, [ids]);

  const byRun = new Map(ids.map((id) => [id, []]));
  for (const e of events) if (byRun.has(e.run_id)) byRun.get(e.run_id).push(e);

  const report = runs.map((run) => {
    const evs = byRun.get(run.id) || [];
    const at = (type) => {
      const e = evs.find((x) => x.event_type === type);
      return e ? new Date(e.created_at).getTime() : null;
    };
    const steps = {};
    for (const s of STEPS) {
      const t0 = at(s + '_started');
      const t1 = at(s + '_complete');
      const tf = at(s + '_failed');
      steps[s] = {
        ms: (t0 && (t1 || tf)) ? ((t1 || tf) - t0) : null,
        failed: !!tf && !t1,
        ran: !!t0,
      };
    }
    // contact_discovery has two shortcuts that make it near-instant, and they mean
    // very different things: a cache hit is fine, "reused card" means the fan-out
    // was SKIPPED because the card supplied something -- which, when all the card
    // supplied was a business phone, is why the run produced no decision maker.
    const reused = evs.find((e) => e.event_type === 'contact_discovery_reused_card');
    const cacheHit = evs.find((e) => e.event_type === 'contact_discovery_cache_hit');
    const named = reused && reused.payload ? reused.payload.named : null;

    const started = run.started_at ? new Date(run.started_at).getTime() : null;
    const done = run.completed_at ? new Date(run.completed_at).getTime() : null;
    return {
      runId: run.id,
      brand: run.brand_name,
      status: run.status,
      totalMs: (started && done) ? (done - started) : null,
      steps,
      contactShortcut: reused ? ('reused_card(named=' + (named === null ? '?' : named) + ')')
        : (cacheHit ? 'cache_hit' : null),
      producedContact: !!run.contact_id,
      error: run.error_message || null,
      when: run.started_at,
    };
  });

  // ── pre-warm hit rate ──────────────────────────────────────────────────────
  const { rows: pw } = await pool.query(
    `SELECT COALESCE(source,'click') AS source, status, COUNT(*)::int AS n
       FROM outreach_logs
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY 1,2 ORDER BY 3 DESC`);

  // Runs whose brand HAD a warm draft at the time are the interesting failure: the
  // modal should have hit it and did not.
  const { rows: shouldHave } = await pool.query(
    `SELECT ar.id, ar.brand_name, ar.started_at, ol.id AS draft_id, ol.created_at AS draft_at
       FROM automation_runs ar
       JOIN outreach_logs ol
         ON ol.athlete_id = ar.athlete_id
        AND LOWER(ol.brand_name) = LOWER(ar.brand_name)
        AND ol.source = 'prewarm'
      WHERE ar.id = ANY($1)
        AND ol.created_at < ar.started_at
      ORDER BY ar.started_at DESC`, [ids]);

  if (AS_JSON) {
    console.log(JSON.stringify({ runs: report, prewarmCounts: pw, ranDespiteWarmDraft: shouldHave }, null, 2));
    await pool.end();
    return;
  }

  console.log(`\n${report.length} most recent workflow runs (each one is a modal open that MISSED the pre-warm)\n`);
  console.log(pad('BRAND', 24) + rpad('TOTAL', 7) + '  '
    + STEPS.map((s) => rpad(s.split('_')[0].slice(0, 6), 7)).join('') + '  CONTACT');
  console.log('-'.repeat(24 + 7 + 2 + STEPS.length * 7 + 10));
  for (const r of report) {
    console.log(
      pad(r.brand, 24) + rpad(secs(r.totalMs) + 's', 7) + '  '
      + STEPS.map((s) => rpad(r.steps[s].ran ? (secs(r.steps[s].ms) + (r.steps[s].failed ? '!' : '')) : '-', 7)).join('')
      + '  ' + (r.producedContact ? 'yes' : 'NONE') + (r.contactShortcut ? ' ' + r.contactShortcut : ''));
  }

  // Where the time actually goes, across the sample.
  const totals = {};
  for (const s of STEPS) {
    const vals = report.map((r) => r.steps[s].ms).filter((v) => typeof v === 'number');
    totals[s] = vals.length ? { n: vals.length, median: vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)] } : null;
  }
  console.log('\n── median per step (only runs where the step ran) ──');
  for (const s of STEPS) {
    const t = totals[s];
    console.log('  ' + pad(s, 20) + (t ? rpad(secs(t.median) + 's', 8) + '   n=' + t.n : '     never ran'));
  }
  const allTotals = report.map((r) => r.totalMs).filter(Boolean).sort((a, b) => a - b);
  if (allTotals.length) {
    console.log('\n  ' + pad('WHOLE WORKFLOW', 20) + rpad(secs(allTotals[Math.floor(allTotals.length / 2)]) + 's', 8)
      + '   median   (min ' + secs(allTotals[0]) + 's, max ' + secs(allTotals[allTotals.length - 1]) + 's)');
  }

  const noContact = report.filter((r) => !r.producedContact).length;
  const skipped = report.filter((r) => r.contactShortcut && r.contactShortcut.startsWith('reused_card')).length;
  console.log('\n── contact discovery ──');
  console.log(`  runs that produced NO contact record:        ${noContact} / ${report.length}`);
  console.log(`  runs where the fan-out was SKIPPED entirely: ${skipped} / ${report.length}  (contact_discovery_reused_card)`);
  console.log('  A "reused_card(named=0)" run waited for the whole workflow and never looked for a person.');

  console.log('\n── drafts written in the last 7 days ──');
  for (const r of pw) console.log('  ' + pad(r.source, 10) + pad(r.status, 10) + r.n);

  console.log('\n── runs that fired even though a warm draft already existed ──');
  if (!shouldHave.length) {
    console.log('  none — every miss was a genuine miss (no draft had been written yet for that brand)');
  } else {
    for (const s of shouldHave) {
      const lagS = ((new Date(s.started_at) - new Date(s.draft_at)) / 1000).toFixed(0);
      console.log(`  ${pad(s.brand_name, 26)} draft existed ${lagS}s before the run started  (draft ${s.draft_id})`);
    }
    console.log('  These are lookup failures, not races: the draft was there and the modal did not find it.');
  }

  console.log('\nFor the pre-warm side of the story, grep the scan logs:');
  console.log('  railway logs | grep "\\[prewarm\\]"');
  console.log('  -> [prewarm] athlete=… cards=10 drafted=N cached=N failed=N skipped=N ms=NNNN\n');

  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
