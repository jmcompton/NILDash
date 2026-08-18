#!/usr/bin/env node
'use strict';
// Zero-cost, READ-ONLY report on why the outreach queue's candidate pool is
// producing rejects. Answers two questions without spending a cent:
//
//   1. What candidates would candidatesFor() hand the filler tonight, and
//      how stale are they (first_shown_at / last_shown_at)?
//   2. Are they already contacted/retired elsewhere in the ledger, or genuinely
//      untouched 'shown' rows the filler just hasn't been able to place?
//
// This makes NO calls to ai.js, no Places/web-search lookups, no Instagram
// lookups -- only SELECTs against brand_engagement / outreach_queue /
// athletes. It cannot spend money, and it does not write anything.
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

    for (const ath of athletes) {
      console.log('='.repeat(72));
      console.log(`${ath.name || ath.id}  (athlete_id=${ath.id}, agent_id=${ath.agent_id})`);

      // Full state breakdown for this athlete's ledger, so "is it all stale
      // contacted rows" is answered directly rather than inferred.
      const stateCounts = (await pool.query(
        `SELECT state, COUNT(*)::int AS n FROM brand_engagement
          WHERE athlete_id = $1 GROUP BY state ORDER BY n DESC`, [ath.id])).rows;
      if (!stateCounts.length) {
        console.log('  No brand_engagement rows at all for this athlete -- they have never had a Deal Scan run.');
        continue;
      }
      console.log('  Ledger state breakdown: ' + stateCounts.map((s) => `${s.state}=${s.n}`).join(', '));

      // The EXACT query candidatesFor() runs -- same table, same filter, same
      // order (most-recently-shown first, NOT oldest-first), same limit shape
      // (slots-open * MAX_ATTEMPTS_PER_SLOT, here shown uncapped for the report).
      const candidates = (await pool.query(
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
        continue;
      }

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

    console.log('\n' + '='.repeat(72));
    console.log('Reminder: candidatesFor() orders by last_shown_at DESC (freshest first),');
    console.log('not oldest-first, so a stale ledger would show up here as stale candidates,');
    console.log('not as an ordering bug. If candidates above look fresh and named, the most');
    console.log('likely failure was the empty region hint (fixed in b783309) -- rerun the');
    console.log('filler and check outreach_queue_runs.details for real reject reasons.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
