#!/usr/bin/env node
'use strict';
// ── CLEAR A CACHED "NOT A SCHOOL" ───────────────────────────────────────────
//
//   node scripts/clear-school-geocode.js "Bentley University"          (dry run)
//   node scripts/clear-school-geocode.js "Bentley University" --apply
//   node scripts/clear-school-geocode.js --all-negatives --apply
//
// TWO LANES, NOT ONE. A school name can be blocked in two independent caches and
// clearing either alone accomplishes nothing:
//
//   brand_evidence_cache (lane 'schoolgeo')  key "school:bentley university"
//       written by services/schoolGeocode -- { found: false }
//   brand_evidence_cache (lane 'places')     key "bentley university | v2"
//       written by services/placesLookup -- { found: false }, 30-day window
//
// schoolGeocode asks placesLookup. If only the schoolgeo row is deleted, the
// next run re-asks, placesLookup serves ITS cached negative without touching
// Google, and schoolGeocode writes the schoolgeo negative straight back. The
// school stays broken and the deletion looks like it did nothing.
//
// So this clears both, and says which rows it found in each.
//
// DRY RUN BY DEFAULT. Nothing is deleted without --apply.

const store = require('../server/store');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALL = args.includes('--all-negatives');
const names = args.filter((a) => !a.startsWith('--'));

// The two key shapes, built by the same rules the writers use so this cannot
// drift from them. placesLookup._key is not exported, so its shape is rebuilt
// here and asserted against a live row rather than assumed.
const schoolgeoKey = (s) => 'school:' + String(s).trim().toLowerCase().replace(/\s+/g, ' ');
const placesKey = (s) => String(s).trim().toLowerCase() + ' | v2';

async function main() {
  const P = store.pool;

  if (!ALL && !names.length) {
    console.log('usage: clear-school-geocode.js "School Name" [--apply]');
    console.log('       clear-school-geocode.js --all-negatives [--apply]');
    process.exit(1);
  }

  // ── WHAT IS ACTUALLY IN THERE ─────────────────────────────────────────────
  // Printed before anything is touched. A negative that is not there is worth
  // knowing about: it means the school failed for a different reason.
  let targets = [];
  if (ALL) {
    const r = await P.query(
      `SELECT brand_key, lane, brand, evidence, outcome, refreshed_at
         FROM brand_evidence_cache
        WHERE lane = 'schoolgeo' AND evidence->>'found' = 'false'
        ORDER BY refreshed_at DESC`);
    targets = r.rows.map((x) => ({ name: x.brand || x.brand_key.replace(/^school:/, ''), row: x }));
    console.log(`\n${targets.length} cached school negative(s) in lane 'schoolgeo':\n`);
    for (const t of targets) {
      const days = ((Date.now() - new Date(t.row.refreshed_at).getTime()) / 86400000).toFixed(1);
      console.log(`  ${String(t.name).padEnd(42)} ${days.padStart(6)}d ago`
        + `  why=${(t.row.evidence && t.row.evidence.why) || 'not recorded'}`);
    }
  } else {
    targets = names.map((n) => ({ name: n, row: null }));
  }

  const keys = [];
  for (const t of targets) {
    keys.push({ name: t.name, lane: 'schoolgeo', key: schoolgeoKey(t.name) });
    keys.push({ name: t.name, lane: 'places', key: placesKey(t.name) });
  }

  console.log('\n-- rows found --');
  let found = 0;
  for (const k of keys) {
    const r = await P.query(
      `SELECT brand_key, lane, evidence, outcome, refreshed_at
         FROM brand_evidence_cache WHERE brand_key = $1 AND lane = $2`, [k.key, k.lane]);
    const row = r.rows[0];
    if (!row) { console.log(`  MISS  ${k.lane.padEnd(10)} ${k.key}`); continue; }
    found++;
    const days = ((Date.now() - new Date(row.refreshed_at).getTime()) / 86400000).toFixed(1);
    const neg = row.evidence && row.evidence.found === false;
    console.log(`  HIT   ${k.lane.padEnd(10)} ${k.key}`);
    console.log(`          ${neg ? 'NEGATIVE' : 'positive'}  age=${days}d  outcome=${row.outcome}`
      + `  ${JSON.stringify(row.evidence).slice(0, 160)}`);
  }

  if (!found) {
    console.log('\nNothing cached for those names. The failure was not a cached negative.');
    await P.end();
    return;
  }

  if (!APPLY) {
    console.log(`\nDRY RUN. ${found} row(s) would be deleted. Re-run with --apply.`);
    await P.end();
    return;
  }

  let deleted = 0;
  for (const k of keys) {
    const r = await P.query(
      `DELETE FROM brand_evidence_cache WHERE brand_key = $1 AND lane = $2`, [k.key, k.lane]);
    deleted += r.rowCount;
  }
  console.log(`\nDeleted ${deleted} row(s). The next nightly run will re-ask Places.`);
  console.log('POSITIVES ARE DELETED TOO, deliberately: a positive written before the '
    + 'school-type check existed may be a car dealership, and re-asking costs one lookup.');
  await P.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
