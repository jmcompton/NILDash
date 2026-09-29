'use strict';
// ── ONE TEAM'S SPONSOR SCAN, RUN BY HAND ────────────────────────────────────
//
// Runs services/teamScan for one team and prints what it produced: the
// businesses Places found around the campus, the ones blocked and why, the
// slate with each fit score itemised, and every ask it wrote in full.
//
//   node scripts/team-scan.js --university univ-cypress --team mbb
//   /api/admin/scripts/team-scan?university=univ-cypress&team=mbb&text=1
//
// Options:
//   --limit N        how many businesses to ask (default 5)
//   --no-write       build and print the slate; write no ask and queue nothing
//   --no-discover    skip Places and use the pool already recorded
//
// WHAT IT SPENDS. Places requests (one geocode and up to 3 pages per business
// type, cached nowhere but the university pool) and one claude-sonnet-4-6 call
// per ask, two if the first is refused by the lint. The keys are read from the
// environment (GOOGLE_PLACES_API_KEY, the Anthropic key ai.js uses) and never
// printed.
//
// WHAT IT NEVER DOES. Send. Every ask it writes is left in university_drafts
// as 'awaiting_approval'. It reads and writes university tables only.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const TeamScan = require(ROOT + 'server/services/teamScan.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

function argsOf(argv) {
  const out = { limit: 5, write: true, discover: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-write') out.write = false;
    else if (a === '--no-discover') out.discover = false;
    else if (a === '--university') out.university = argv[++i];
    else if (a === '--team') out.team = argv[++i];
    else if (a === '--limit') out.limit = Math.max(1, Math.min(10, parseInt(argv[++i], 10) || 5));
  }
  return out;
}

const mi = (m) => (m == null ? '-' : (Number(m) / 1609.34).toFixed(1) + ' mi');

async function main() {
  const a = argsOf(process.argv.slice(2));
  if (!a.university || !a.team) {
    console.error('Usage: node scripts/team-scan.js --university <id> --team <id or short id> [--limit N] [--no-write] [--no-discover]');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  await TeamScan.ensureTables(P);
  // "mbb" is accepted for "univ-cypress:mbb", the id the seed gives it.
  let teamId = a.team;
  const direct = (await P.query(`SELECT 1 FROM university_teams WHERE id = $1`, [teamId])).rowCount;
  if (!direct) teamId = `${a.university}:${a.team}`;

  const r = await TeamScan.runTeamScan(P, { universityId: a.university, teamId, limit: a.limit,
    write: a.write, discoverPool: a.discover });
  console.log(`TEAM SPONSOR SCAN  ${new Date().toISOString()}`);
  if (!r.ok) { console.log('\nSTOPPED: ' + r.error); try { await P.end(); } catch (_) {} process.exit(1); }
  console.log(`${r.team.name}, ${r.university.name}   market ${r.marketKey}   campus ${r.university.location}`);
  console.log(a.write ? 'Writes asks: yes (left awaiting approval; nothing is sent)' : 'Writes asks: no (--no-write)');

  if (r.discovery) {
    const d = r.discovery;
    console.log(`\nDISCOVERY  Places around the campus: ${d.found} found, ${d.kept} kept, ${d.blocked.length} blocked, ${d.placesCalls} Places requests`);
    for (const b of d.blocked) console.log(`  blocked  ${String(b.name).padEnd(40)} ${b.key} (${b.why})`);
  }

  // The engine's empty texts are written for an athlete; a team gets its own.
  const TEAM_EMPTY = {
    'no-pool-for-key': 'the university pool has no businesses for this market yet; run without --no-discover',
    'market-exhausted': 'every business in the university pool for this market has already been asked for this team',
    'no-market': 'the team has no market key and the campus address did not give one',
  };
  const empty = r.slate.emptyReason ? (TEAM_EMPTY[r.slate.emptyReason] || r.slate.emptyText) : '';
  console.log(`\nSLATE  ${r.picks.length} business(es)` + (empty ? `  EMPTY: ${empty}` : ''));
  r.picks.forEach((p, i) => {
    console.log(`\n  ${i + 1}. ${p.brand_name}   fit ${p.fit == null ? '-' : p.fit}/100`);
    console.log(`     ${p.category || 'uncategorised'} · ${p.address || 'no address'} · ${mi(p.distance_m)} · rated ${p.rating || '-'} (${p.user_ratings_total || 0} reviews)`);
    console.log(`     fit: ${(p.fitReasons || []).join(', ') || '-'}`);
    console.log(`     ask: ${p.item ? `${p.item.name}, $${(p.item.price_cents / 100).toLocaleString('en-US')}` : 'none available'}`);
  });
  if (r.skipped.length) {
    console.log('\nNOT WRITTEN');
    for (const s of r.skipped) console.log(`  ${s.brand}: ${s.why}`);
  }
  if (r.drafts.length) {
    console.log(`\nASKS WRITTEN  ${r.drafts.length}, all awaiting approval in university_drafts`);
    for (const d of r.drafts) {
      console.log(`\n──── ${d.brand} · ${d.item} · ${d.price} · ${d.status}${d.retried ? ' · rewritten once by the lint' : ''} ────`);
      console.log(`Subject: ${d.subject}\n\n${d.body}`);
    }
  }
  try { await P.end(); } catch (_) {}
  process.exit(0);
}
if (require.main === module) main().catch((e) => { console.error('team-scan: FAILED', e.message); process.exit(1); });
module.exports = { argsOf };
