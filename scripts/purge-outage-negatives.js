'use strict';
// ── REMOVE NEGATIVES CACHED DURING AN OUTAGE ────────────────────────────────
//
// The rule (services/ourFault) stops a negative that came from an error being
// cached from now on. It cannot tell which negatives already in the cache came
// from one. During the Google Places outage, for example, the contact ladder
// ran without a business's website and cached "no contact" for 30 days.
//
// This deletes NEGATIVE rows (NONE / NO_EVIDENCE / unknown / found:false)
// written inside a window, from the lanes that can be poisoned that way. A
// deleted row only means the next lookup asks again; positives are never
// touched. Prints what it would delete unless --apply.
//
//   node scripts/purge-outage-negatives.js --since 2026-09-16
//   node scripts/purge-outage-negatives.js --since 2026-09-16 --until 2026-09-30 --apply
//   /api/admin/scripts/purge-outage-negatives?since=2026-09-16&text=1   (&apply=1)
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

const LANES = ['contacts', 'siteemail', 'instagram', 'hunter', 'domain', 'personemail', 'places', 'topnil', 'schoolgeo', 'natsearch'];
const NEGATIVE_SQL = `(UPPER(COALESCE(outcome,'')) IN ('NONE','NO_EVIDENCE','NOT_FOUND','NO_MATCH','EMPTY','UNKNOWN')
  OR (evidence->>'found') = 'false')`;

function argsOf(argv) {
  const a = { apply: argv.includes('--apply') };
  const v = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  a.since = v('--since'); a.until = v('--until');
  return a;
}

async function main() {
  const a = argsOf(process.argv.slice(2));
  if (!a.since || !/^\d{4}-\d{2}-\d{2}$/.test(a.since) || (a.until && !/^\d{4}-\d{2}-\d{2}$/.test(a.until))) {
    console.error('Usage: node scripts/purge-outage-negatives.js --since YYYY-MM-DD [--until YYYY-MM-DD] [--apply]');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const until = a.until || '2999-01-01';
  // Lane names actually in the table, so a renamed lane is not silently missed.
  const present = (await P.query(`SELECT lane, COUNT(*)::int n FROM brand_evidence_cache
      WHERE refreshed_at >= $1::date AND refreshed_at < ($2::date + 1) AND ${NEGATIVE_SQL}
      GROUP BY lane ORDER BY n DESC`, [a.since, until])).rows;
  console.log(`NEGATIVE CACHE ROWS written ${a.since} to ${a.until || 'now'}${a.apply ? '' : '  (dry run; add --apply to delete)'}\n`);
  let total = 0;
  for (const r of present) {
    const inScope = LANES.includes(r.lane);
    console.log(`  ${String(r.lane).padEnd(16)} ${String(r.n).padStart(6)}${inScope ? '' : '   (not a lane this purges; left alone)'}`);
    if (inScope) total += r.n;
  }
  if (!present.length) console.log('  none');
  if (a.apply && total) {
    const d = await P.query(`DELETE FROM brand_evidence_cache
      WHERE lane = ANY($3::text[]) AND refreshed_at >= $1::date AND refreshed_at < ($2::date + 1) AND ${NEGATIVE_SQL}`,
    [a.since, until, LANES]);
    console.log(`\nDeleted ${d.rowCount} negative row(s). The next lookup for each business asks again.`);
  } else {
    console.log(`\n${total} row(s) would be deleted.`);
  }
  try { await P.end(); } catch (_) {}
  process.exit(0);
}
if (require.main === module) main().catch((e) => { console.error('purge-outage-negatives: FAILED', e.message); process.exit(1); });
module.exports = { LANES, argsOf };
