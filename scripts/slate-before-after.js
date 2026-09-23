#!/usr/bin/env node
'use strict';
// ── THE SAME NIGHT, RANKED BOTH WAYS ────────────────────────────────────────
//
//   railway run node scripts/slate-before-after.js --athlete <id or name>
//   railway run node scripts/slate-before-after.js --agent cs@9091sportsagency.com
//   node scripts/slate-before-after.js --athlete ath_amari --json
//
// Read-only. It builds ONE slate and prints the five it would place under the
// rules that shipped tonight, next to the five the old rules would have placed
// from the same candidates — so "what actually moved" is a diff rather than an
// argument.
//
// ── WHY THE "BEFORE" IS A RECONSTRUCTION, AND WHAT THAT COSTS ──────────────
//
// There is no second copy of the ranker to run. The before column is rebuilt
// from the same candidate list by undoing exactly the three things that
// changed, and nothing else:
//
//   1. the skip penalties are added back (each candidate carries the amount
//      subtracted, so this is exact, not an estimate)
//   2. the evidence sort key is dropped, leaving pure fit order
//   3. selection is the old one: rank order under a soft cap of three per lane,
//      then top up past the cap
//
// A business the new rules EXCLUDED outright because the agent skipped it is
// added back to the before column, where it was eligible. That is the one part
// the slate has to be asked for (opts.explain) rather than derived.
//
// What this canNOT reconstruct is a market pool row whose category or evidence
// was never recorded: those columns are new, so rows written before them read
// as UNKNOWN in both columns and neither ranking can use them. On a market that
// has not been rescanned since the change, expect the two columns to look
// similar and the report to say so.

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'unused';
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes('--' + n);

const LANE_CAP = 3;

function beforeOrder(considered, excluded) {
  // Undo the penalties; drop the evidence key. Everything else is untouched.
  const all = considered.concat(excluded).map((c) => ({
    ...c,
    beforeFit: c.fit + (c.skipPenalty ? (c.skipPenalty.athlete || 0) + (c.skipPenalty.agent || 0) : 0),
  }));
  all.sort((a, b) => b.beforeFit - a.beforeFit);
  return all;
}

function beforePicks(all, limit) {
  const picks = [], seen = new Set(), perLane = {};
  for (const c of all) {
    if (picks.length >= limit) break;
    perLane[c.lane] = perLane[c.lane] || 0;
    if (perLane[c.lane] >= LANE_CAP) continue;
    perLane[c.lane]++; picks.push(c); seen.add(c);
  }
  for (const c of all) {
    if (picks.length >= limit) break;
    if (seen.has(c)) continue;
    seen.add(c); picks.push(c);
  }
  return picks;
}

const pad = (s, n) => String(s == null ? '' : s).slice(0, n).padEnd(n);

async function one(pool, store, Scout, AR, R, athRow, limit) {
  const profile = AR.resolveAthlete(athRow, { schoolLocation: R.resolveSchool });
  const data = athRow.data || {};
  profile.instagram = Number(data.instagram) || 0;
  profile.tiktok = Number(data.tiktok) || 0;
  const sl = await Scout.assembleSlate(pool, {
    agentId: athRow.agent_id, athlete: profile, store, limit, explain: true,
  });
  const considered = sl.considered || [];
  const excluded = sl.excludedBySkip || [];
  const all = beforeOrder(considered, excluded);
  const before = beforePicks(all, limit);
  const after = considered.filter((c) => c.picked);

  console.log(`\n${'='.repeat(100)}`);
  console.log(`${data.name || athRow.id}  (${data.school || 'no school'})  agent=${athRow.agent_id}`);
  console.log(`  market=${profile.marketKey || '(none)'}  reach=${profile.instagram + profile.tiktok}`
    + `  candidates=${considered.length}${excluded.length ? ` (+${excluded.length} excluded by a skip)` : ''}`);
  if (sl.emptyReason) { console.log(`  EMPTY: ${sl.emptyText}`); return { moved: 0, athlete: data.name || athRow.id }; }

  const row = (i, c, fitKey) => `  ${String(i + 1).padStart(2)}. ${pad(c.brand, 30)} ${pad(c.lane, 8)} `
    + `${pad(c.category || '(unknown)', 12)} fit ${String(Math.round((c[fitKey] ?? c.fit) * 10) / 10).padStart(6)}`
    + `${c.thin ? '  THIN' : ''}${c.signal ? '  ' + c.signal : ''}${c.nilActive ? '  nil-active' : ''}`
    + `${c.excluded ? '  <- ' + c.excluded : ''}`;

  console.log('\n  BEFORE (fit order, soft cap 3 a lane, no skip memory, evidence only a nudge)');
  before.forEach((c, i) => console.log(row(i, c, 'beforeFit')));
  console.log('\n  AFTER (skips read back, evidence sorted above fit, spread across kinds)');
  after.forEach((c, i) => console.log(row(i, c, 'fit')));

  const bn = before.map((c) => c.brand), an = after.map((c) => c.brand);
  const gone = bn.filter((b) => !an.includes(b));
  const added = an.filter((b) => !bn.includes(b));
  const catsB = new Set(before.map((c) => c.category).filter(Boolean));
  const catsA = new Set(after.map((c) => c.category).filter(Boolean));
  console.log('\n  WHAT MOVED');
  console.log(`    dropped out : ${gone.length ? gone.join(', ') : '(nothing)'}`);
  console.log(`    came in     : ${added.length ? added.join(', ') : '(nothing)'}`);
  console.log(`    categories  : ${catsB.size} -> ${catsA.size}`
    + `  [${[...catsB].join(', ') || '-'}] -> [${[...catsA].join(', ') || '-'}]`);
  console.log(`    thin picks  : ${before.filter((c) => c.thin).length} -> ${after.filter((c) => c.thin).length}`);
  console.log(`    social seat : ${sl.shape.socialEligible ? (sl.shape.socialSeat || 'ELIGIBLE, none available') : 'not eligible (reach under ' + sl.weights.socialMinReach + ')'}`);
  if (excluded.length) console.log(`    skipped out : ${excluded.map((c) => c.brand).join(', ')}`);
  const unknown = after.filter((c) => !c.category).length;
  if (unknown) {
    console.log(`    NOTE: ${unknown} pick(s) have no recorded category, so the spread rule could not `
      + 'use them. Market pool rows written before the category column exists read as unknown until '
      + 'that market is rescanned.');
  }
  return { moved: gone.length, athlete: data.name || athRow.id, catsB: catsB.size, catsA: catsA.size };
}

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const store = require('../server/store');
  const Scout = require('../server/services/scout');
  const AR = require('../server/services/athleteRecord');
  const R = require('../server/services/schoolResolver');
  const P = store.pool;
  const limit = parseInt(arg('limit', '5'), 10) || 5;

  const who = arg('athlete', '');
  const agent = arg('agent', '');
  let rows = [];
  if (who) {
    rows = (await P.query(
      `SELECT id, agent_id, data FROM athletes
        WHERE id = $1 OR LOWER(data->>'name') = LOWER($1) LIMIT 5`, [who])).rows;
    if (!rows.length) { console.log(`No athlete matches ${JSON.stringify(who)}.`); process.exit(1); }
  } else if (agent) {
    rows = (await P.query(
      `SELECT a.id, a.agent_id, a.data FROM athletes a JOIN users u ON u.id = a.agent_id
        WHERE LOWER(TRIM(u.email)) = LOWER(TRIM($1)) ORDER BY a.created_at ASC
        LIMIT $2`, [agent, parseInt(arg('max', '5'), 10) || 5])).rows;
    if (!rows.length) { console.log(`No athletes for ${agent}.`); process.exit(1); }
  } else {
    console.log('Name one: --athlete <id or name>, or --agent <email>.');
    process.exit(1);
  }

  const summary = [];
  for (const r of rows) summary.push(await one(P, store, Scout, AR, R, r, limit));
  if (flag('json')) console.log('\n' + JSON.stringify(summary, null, 2));
  else {
    console.log(`\n${'='.repeat(100)}\nSUMMARY`);
    for (const s of summary) {
      console.log(`  ${pad(s.athlete, 30)} ${s.moved} of ${limit} card(s) changed`
        + (s.catsA != null ? `, categories ${s.catsB} -> ${s.catsA}` : ''));
    }
  }
  try { await P.end(); } catch (_) {}
  process.exit(0);
}
main().catch((e) => { console.error('slate-before-after: FAILED', e); process.exit(1); });
