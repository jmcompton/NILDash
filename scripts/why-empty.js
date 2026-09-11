#!/usr/bin/env node
'use strict';
// ── WHY AN ATHLETE GOT ZERO CARDS ────────────────────────────────────────────
//
//   node scripts/why-empty.js "Kaden House"            last 5 runs for that athlete
//   node scripts/why-empty.js "Kaden House" --runs 10
//   node scripts/why-empty.js --agent cs@9091sportsagency.com   every athlete, last run
//
// Report only. Reads outreach_queue_runs; writes nothing.
//
// "12 businesses tried, none passed the bar" is a count, not an answer. The
// nightly job records EVERY attempt -- brand, result, the exact rejection text,
// the Places facts, and (for the local lane) what the contact ladder actually
// held: which addresses it found and of what kind, which rows it refused and
// why, and which rung of the address ladder produced anything. It has written
// that every night. /admin/scan-rejects renders the reason column and none of
// the ladder columns; this prints all of it, per business, and then answers the
// question that decides what to change:
//
//   UNREACHABLE  the ladder found no phone, no inbox, no handle -- the business
//                cannot be pitched by any channel we have. Not a filter's fault.
//   FILTERED     the ladder HELD something and a rule threw it away -- a refused
//                address kind, a dropped website, a prescreen risk. A filter
//                decided; that filter is the thing to look at.
//   NO ANGLE     reachable, but the writer found nothing to say.
//   OUR FAULT    the lookup threw. Says nothing about the business.
//
// It also counts how many of the last N runs tried the SAME business. A
// business that fails the bar leaves no row in any ledger the slate reads, so
// the slate hands back the same top-of-pool businesses every night until the
// athlete is paused. If the repeat count is high, "12 tried" was not twelve
// businesses -- it was the same twelve, again.

const store = require('../server/store');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;

process.exitCode = 1;
let settled = false;
process.on('beforeExit', () => {
  if (!settled) { console.log('why-empty: main() never settled. Exiting 1.'); process.exit(1); }
});
function fail(where, e) {
  const msg = `why-empty: FAILED (${where}): ${e && e.message ? e.message : e}`;
  console.log(msg); console.error(msg); settled = true; process.exit(1);
}
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));

function target() {
  const url = process.env.DATABASE_URL;
  if (url) { try { const u = new URL(url); return `DATABASE_URL -> ${u.hostname}${u.pathname} (ssl)`; } catch (_) { return 'DATABASE_URL'; } }
  return `PG* env -> ${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}`;
}

// The classification. Reads the recorded `why` block when present (local lane,
// since the ladder instrumentation landed) and falls back to the reason text.
function classify(t) {
  if (t.fault || t.result === 'error') return 'OUR FAULT';
  if (t.result === 'queued') return 'QUEUED';
  if (t.result === 'no_angle') return 'NO ANGLE';
  if (t.result === 'prescreen_skip') return 'FILTERED (prescreen)';
  const w = t.why || {};
  const held = (w.ladderEmails && w.ladderEmails.length) || w.handle || (w.addressStep != null && w.addressStep !== 'none');
  const refused = (w.refusedKinds && w.refusedKinds.length) || w.websiteDropped;
  if (held && refused) return 'FILTERED (ladder held something a rule refused)';
  if (held) return 'FILTERED (held something; check the bar)';
  if (/no way to reach them|nothing reachable|nothing found at all/.test(t.reason || '')) return 'UNREACHABLE';
  if (/already|holding|no lane/.test(t.reason || '')) return 'FILTERED (routing rule)';
  return 'REJECTED (see reason)';
}

async function main() {
  console.log(`why-empty: connecting via ${target()}`);
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;

  const who = positional[0] || null;
  const agentArg = arg('agent', null);
  const nRuns = parseInt(arg('runs', '5'), 10) || 5;
  if (!who && !agentArg) return fail('args', new Error('give an athlete name, or --agent <id|email>'));

  let runs;
  try {
    runs = (await P.query(
      `SELECT r.run_date, r.agent_id, u.email AS agent_email, r.filled, r.details, r.finished_at
         FROM outreach_queue_runs r LEFT JOIN users u ON u.id = r.agent_id
        WHERE ($1::text IS NULL OR r.agent_id = $1 OR LOWER(u.email) = LOWER($1))
        ORDER BY r.run_date DESC LIMIT $2`, [agentArg, agentArg ? 1 : nRuns * 4])).rows;
  } catch (e) { return fail('query', e); }
  console.log(`why-empty: connected. ${runs.length} run row(s) read.`);
  if (!runs.length) { console.log('\nNo runs recorded for that agent. Done.\n'); settled = true; process.exit(0); }

  // Flatten to (run, athlete detail) pairs, filtered to the named athlete.
  const pairs = [];
  for (const run of runs) {
    const details = Array.isArray(run.details) ? run.details : [];
    for (const d of details) {
      if (who && !new RegExp(who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(d.athleteName || d.athleteId || '')) continue;
      pairs.push({ run, d });
    }
  }
  const byAthlete = {};
  for (const p of pairs) (byAthlete[p.d.athleteName || p.d.athleteId] = byAthlete[p.d.athleteName || p.d.athleteId] || []).push(p);

  if (!Object.keys(byAthlete).length) {
    console.log(`\nNo run detail matched "${who || agentArg}". The athlete may be paused (no attempt recorded) or named differently. Done.\n`);
    settled = true; process.exit(0);
  }

  for (const [name, list] of Object.entries(byAthlete)) {
    const recent = list.slice(0, nRuns);
    console.log(`\n${'═'.repeat(78)}\n${name}\n${'═'.repeat(78)}`);

    // Repetition across runs: the same brand tried on how many of these nights.
    const seenBrand = {};
    for (const { d } of recent) for (const t of (d.tried || [])) {
      const k = String(t.brand || '').toLowerCase(); if (!k) continue;
      seenBrand[k] = (seenBrand[k] || 0) + 1;
    }
    const repeated = Object.values(seenBrand).filter((n) => n > 1).length;
    const distinct = Object.keys(seenBrand).length;

    for (const { run, d } of recent) {
      const tried = Array.isArray(d.tried) ? d.tried : [];
      console.log(`\n── ${String(run.run_date).slice(0, 10)}  filled=${d.filled ?? '?'}  note: ${d.note || (d.filled ? '(filled)' : '(none)')}`);
      if (d.error) console.log(`   RUN ERROR for this athlete: ${d.error}`);
      if (!tried.length) { console.log('   no attempts recorded'); continue; }
      const tally = {};
      tried.forEach((t, i) => {
        const cls = classify(t); tally[cls] = (tally[cls] || 0) + 1;
        const w = t.why || {};
        console.log(`   ${String(i + 1).padStart(2)}. ${t.brand}${t.lane ? '  [' + t.lane + ']' : ''}  → ${cls}`);
        if (t.reason) console.log(`       reason : ${t.reason}`);
        if (t.why) {
          const emails = (w.ladderEmails || []).map((e) => `t${e.tier}:${e.kind}`).join(', ') || 'none';
          const refused = (w.refusedKinds || []).join(', ') || 'none';
          console.log(`       ladder : addresses held=${emails}; refused kinds=${refused}; handle=${w.handle || 'none'}`);
          console.log(`       address: rung=${w.addressStep ?? 'none'}${w.addressLabel ? ' (' + w.addressLabel + ')' : ''}`
            + `${w.website ? '; site=' + w.website : ''}${w.websiteDropped ? '; SITE DROPPED: ' + w.websiteDropped : ''}${w.cached ? '; (cached)' : ''}`);
          if (Array.isArray(w.addressSteps) && w.addressSteps.length) {
            console.log(`       rungs  : ${w.addressSteps.map((s) => (typeof s === 'string' ? s : `${s.step || s.label || '?'}=${s.result || s.found || s.outcome || '?'}`)).join(' | ')}`);
          }
        } else if (t.result === 'rejected' && (t.lane === 'local' || !t.lane)) {
          console.log('       ladder : (no ladder record on this row — written before the instrumentation, or a pre-ladder rejection)');
        }
        if (t.places && (t.places.rating != null || t.places.reviews != null)) {
          console.log(`       places : rating=${t.places.rating ?? '?'} reviews=${t.places.reviews ?? '?'}${t.risk ? ' risk=' + JSON.stringify(t.risk) : ''}`);
        }
      });
      console.log('   ── ' + Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join('  ·  '));
    }

    console.log(`\n   Across the last ${recent.length} run(s): ${distinct} distinct business(es) tried, `
      + `${repeated} of them tried on more than one night.`
      + (distinct && repeated / distinct >= 0.5
        ? '\n   → MOSTLY REPEATS. The slate is handing back the same businesses each night; the rest of the pool is never reached.'
        : ''));
  }

  console.log('\nDone.\n');
  settled = true;
  await P.end().catch(() => {});
  process.exit(0);
}
main().catch((e) => fail('main', e));
