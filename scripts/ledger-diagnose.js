#!/usr/bin/env node
'use strict';
// Zero-cost, READ-ONLY report on why the outreach queue's candidate pool is
// producing rejects, AND on what the last actual nightly/admin run did with
// those candidates. Answers three questions without spending a cent:
//
//   1. What candidates would candidatesFor() hand the filler tonight, and
//      how stale are they (first_shown_at / last_shown_at)?
//   2. Are they already contacted/retired elsewhere in the ledger, or genuinely
//      untouched 'shown' rows the filler just hasn't been able to place?
//   3. What did the LAST RUN actually do for this athlete -- was every
//      candidate tried and rejected (with the real reason), or does this
//      athlete have NO entry at all in that run's outreach_queue_runs.details
//      (see "NOT ATTEMPTED" below -- almost always means the agent's nightly
//      budget cap was hit on an earlier athlete before the loop ever reached
//      this one, not that this athlete was individually considered and found
//      wanting).
//
// This makes NO calls to ai.js, no Places/web-search lookups, no Instagram
// lookups -- only SELECTs against brand_engagement / outreach_queue /
// outreach_queue_runs / athletes. It cannot spend money, and it does not
// write anything.
//
//   node scripts/ledger-diagnose.js                     every agent, every athlete
//   node scripts/ledger-diagnose.js --athlete "Marcus Johnson"
//   node scripts/ledger-diagnose.js --athlete-id ath_xxx
//   node scripts/ledger-diagnose.js --agent <agent_id>
//
// Requires DATABASE_URL in the environment (e.g. `railway run` locally, or
// run this directly on the Railway box/console -- this environment has
// neither, which is why this script exists for the user to run themselves).

const { Pool } = require('pg');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function daysAgo(ts) {
  if (!ts) return null;
  const ms = Date.now() - new Date(ts).getTime();
  return Math.floor(ms / 86400000);
}

function fmtDays(n) {
  if (n === null) return 'never';
  if (n === 0) return 'today';
  if (n === 1) return '1 day ago';
  return n + ' days ago';
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Run this with the production database');
    console.error('connection string in the environment, e.g.:');
    console.error('  railway run node scripts/ledger-diagnose.js');
    console.error('or paste the Railway Postgres DATABASE_URL and run it directly:');
    console.error('  DATABASE_URL="postgres://..." node scripts/ledger-diagnose.js');
    process.exit(1);
  }

  const athleteName = arg('--athlete');
  const athleteId = arg('--athlete-id');
  const agentId = arg('--agent');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  });

  try {
    const where = ['1=1'];
    const params = [];
    if (athleteId) { params.push(athleteId); where.push(`a.id = $${params.length}`); }
    if (athleteName) { params.push('%' + athleteName + '%'); where.push(`a.data->>'name' ILIKE $${params.length}`); }
    if (agentId) { params.push(agentId); where.push(`a.agent_id = $${params.length}`); }

    const athletes = (await pool.query(
      `SELECT a.id, a.agent_id, a.data->>'name' AS name
         FROM athletes a WHERE ${where.join(' AND ')} ORDER BY a.created_at ASC`, params)).rows;

    if (!athletes.length) {
      console.log('No athletes matched that filter.');
      return;
    }

    console.log(`Read-only ledger report -- ${athletes.length} athlete(s). No lookups run, nothing spent.\n`);

    // One "latest run" row per agent, cached so N athletes on the same agent
    // don't re-query it N times.
    const lastRunByAgent = new Map();
    async function lastRunFor(agId) {
      if (lastRunByAgent.has(agId)) return lastRunByAgent.get(agId);
      const r = (await pool.query(
        `SELECT run_date, filled, spent_usd, details FROM outreach_queue_runs
          WHERE agent_id = $1 ORDER BY run_date DESC LIMIT 1`, [agId])).rows[0] || null;
      lastRunByAgent.set(agId, r);
      return r;
    }

    // Tally across every athlete this report covers, so the stale-ledger
    // hypothesis gets a real number instead of a guess.
    const tally = { neverScanned: 0, notAttempted: 0, triedNoneQueued: 0, queued: 0, noRunAtAll: 0 };

    for (const ath of athletes) {
      console.log('='.repeat(72));
      console.log(`${ath.name || ath.id}  (athlete_id=${ath.id}, agent_id=${ath.agent_id})`);

      // ── Part 1: candidate pool, live right now ──────────────────────────
      const stateCounts = (await pool.query(
        `SELECT state, COUNT(*)::int AS n FROM brand_engagement
          WHERE athlete_id = $1 GROUP BY state ORDER BY n DESC`, [ath.id])).rows;
      let candidates = [];
      let neverScanned = false;
      if (!stateCounts.length) {
        console.log('  No brand_engagement rows at all for this athlete -- they have never had a Deal Scan run.');
        neverScanned = true;
      } else {
        console.log('  Ledger state breakdown: ' + stateCounts.map((s) => `${s.state}=${s.n}`).join(', '));

        // The EXACT query candidatesFor() runs -- same table, same filter, same
        // order (most-recently-shown first, NOT oldest-first), same limit shape
        // (slots-open * MAX_ATTEMPTS_PER_SLOT, here shown uncapped for the report).
        candidates = (await pool.query(
          `SELECT be.brand_key, be.brand_name, be.first_shown_at, be.last_shown_at, be.shown_count
             FROM brand_engagement be
            WHERE be.athlete_id = $1
              AND be.state = 'shown'
              AND NOT EXISTS (
                SELECT 1 FROM outreach_queue q
                 WHERE q.athlete_id = be.athlete_id AND q.brand_key = be.brand_key)
            ORDER BY be.last_shown_at DESC NULLS LAST`, [ath.id])).rows;

        if (!candidates.length) {
          const shownTotal = stateCounts.find((s) => s.state === 'shown');
          if (shownTotal) {
            console.log(`  0 usable candidates: all ${shownTotal.n} 'shown' rows are already sitting in`);
            console.log(`  outreach_queue (queued/sent/skipped there already), so candidatesFor() has nothing left to offer.`);
          } else {
            console.log('  0 usable candidates: no rows in state \'shown\' at all (all contacted, retired, or dead).');
          }
        } else {
          console.log(`  ${candidates.length} candidate(s) candidatesFor() would offer tonight, most-recently-shown first:`);
          candidates.forEach((c, i) => {
            const first = daysAgo(c.first_shown_at);
            const last = daysAgo(c.last_shown_at);
            console.log(`    ${i + 1}. ${c.brand_name || c.brand_key}`);
            console.log(`       first shown ${fmtDays(first)}, last shown ${fmtDays(last)}, shown_count=${c.shown_count}`);
          });
          const stale = candidates.filter((c) => (daysAgo(c.last_shown_at) || 0) > 30).length;
          if (stale) {
            console.log(`  NOTE: ${stale} of these were last shown over 30 days ago.`);
          } else {
            console.log('  None of these are stale by last_shown_at -- the candidate pool looks fresh, not scraped from the bottom.');
          }
        }
      }
      if (neverScanned) tally.neverScanned++;   // tracked independently -- see summary note

      // ── Part 2: what the LAST RUN actually did with those candidates ────
      const run = await lastRunFor(ath.agent_id);
      if (!run) {
        console.log('  Last run: NONE -- outreach_queue_runs has no row for this agent at all.');
        console.log('  Either the job has never fired for this agent, or OUTREACH_QUEUE_ENABLED was off every time it tried.');
        tally.noRunAtAll++;
      } else {
        const detail = (run.details || []).find((d) => d.athleteId === ath.id);
        console.log(`  Last run: ${run.run_date} (agent filled=${run.filled}, spent=$${Number(run.spent_usd || 0).toFixed(2)})`);
        if (!detail) {
          console.log('  *** NOT ATTEMPTED THIS RUN *** -- no entry for this athlete in outreach_queue_runs.details.');
          console.log('  This athlete was never even reached in the loop this run, almost certainly because an');
          console.log('  earlier athlete on the SAME agent exhausted the whole $0.50/night budget first (fillAgent');
          console.log('  breaks the athlete loop on cappedOut -- server/jobs/outreachQueue.js:276). This is NOT the');
          console.log('  same thing as "tried and found nothing" -- the front end currently has no way to tell the');
          console.log('  two apart, which is why the card shows the generic "Nothing queued in the run" fallback');
          console.log('  with no tried list, instead of an explicit reason.');
          tally.notAttempted++;
        } else if (detail.filled > 0) {
          console.log(`  Filled ${detail.filled} slot(s). ${detail.tried.length} business(es) tried:`);
          detail.tried.forEach((t) => console.log(`    - ${t.brand}: ${t.result}${t.reason ? ' -- ' + t.reason : ''}`));
          tally.queued++;
        } else {
          console.log(`  Filled 0. note: "${detail.note || '(none)'}"`);
          if (detail.tried.length) {
            console.log(`  ${detail.tried.length} business(es) tried, each rejected:`);
            detail.tried.forEach((t) => console.log(`    - ${t.brand}: ${t.reason || t.result}`));
          } else {
            console.log('  0 businesses tried (consistent with ' + (neverScanned || !candidates.length ? 'having no candidates)' : 'the note above)'));
          }
          tally.triedNoneQueued++;
        }
      }
    }

    console.log('\n' + '='.repeat(72));
    console.log('SUMMARY across all ' + athletes.length + ' athlete(s) in this report:');
    console.log('  ["no run" / "NOT ATTEMPTED" / "tried, nothing passed" / "filled"] partition');
    console.log('  the full set below (they sum to ' + athletes.length + '); "never scanned" is a separate,');
    console.log('  independent fact that can be true of an athlete in ANY of those four buckets.');
    console.log('');
    console.log(`  no run recorded for their agent at all:                    ${tally.noRunAtAll}`);
    console.log(`  NOT ATTEMPTED this run (silently skipped, see *** above):  ${tally.notAttempted}`);
    console.log(`  tried this run but nothing passed the bar:                 ${tally.triedNoneQueued}`);
    console.log(`  filled at least one slot this run:                         ${tally.queued}`);
    console.log(`  (of the above) never scanned -- no brand_engagement at all: ${tally.neverScanned}`);
    console.log('');
    console.log('If "NOT ATTEMPTED" is nonzero, the per-agent nightly budget cap is the leading');
    console.log('explanation for a low fill count across many athletes, not a stale ledger --');
    console.log('candidatesFor() orders freshest-first, so a truly stale ledger would show up');
    console.log('above as 0 usable candidates or old first/last-shown dates, not as a missing');
    console.log('run-details entry. Compare "never scanned" to "NOT ATTEMPTED" above to see which');
    console.log('explanation actually accounts for the athletes with no card.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
