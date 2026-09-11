#!/usr/bin/env node
'use strict';
// ── CLEAR "NO HANDLE" ANSWERS THAT WERE REALLY ERRORS ────────────────────────
//
//   node scripts/clear-negative-cache.js --city Eugene              dry run
//   node scripts/clear-negative-cache.js --city Eugene --apply
//   node scripts/clear-negative-cache.js --brand "Maxie's Pizza"    one business (ILIKE)
//   node scripts/clear-negative-cache.js --since 7                  every NONE row from the last 7 days
//
// Until cc45a33+1 the Instagram lookup cached NONE ("this business has no
// Instagram") for 30 days whenever its web search returned null -- and the
// search returned null on a timeout, a rate limit, or a missing key exactly as
// it did on a completed search that found nothing. One bad minute at 3am made a
// whole town's businesses "no handle" for a month, and every card for them
// routed to CALL.
//
// The code no longer writes those rows. This clears the ones already written.
// A cleared row costs one search the next time the business is tried; a
// poisoned row costs a month of phone-only cards. The table cannot say which
// NONE rows were errors and which were honest misses, so the filters are by
// place, brand, or recency -- the person running this decides the blast radius.
//
// Deletes ONLY lane='instagram' AND outcome='NONE'. OK rows (a found handle)
// are never touched. Dry run by default.

const store = require('../server/store');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;

process.exitCode = 1;
let settled = false;
process.on('beforeExit', () => { if (!settled) { console.log('clear-negative-cache: main() never settled. Exiting 1.'); process.exit(1); } });
function fail(where, e) { const m = `clear-negative-cache: FAILED (${where}): ${e && e.message ? e.message : e}`; console.log(m); console.error(m); settled = true; process.exit(1); }
function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; }
const APPLY = process.argv.includes('--apply');

function target() {
  const url = process.env.DATABASE_URL;
  if (url) { try { const u = new URL(url); return `DATABASE_URL -> ${u.hostname}${u.pathname} (ssl)`; } catch (_) { return 'DATABASE_URL'; } }
  return `PG* env -> ${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}`;
}

async function main() {
  console.log(`clear-negative-cache: connecting via ${target()}  (${APPLY ? 'APPLY' : 'dry run'})`);
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;

  const city = arg('city', null), brand = arg('brand', null), since = parseInt(arg('since', ''), 10);
  if (!city && !brand && !since) return fail('args', new Error('give --city <town>, --brand <name>, or --since <days>'));

  // The name-keyed rows carry the city inside the key ("name:<brand>@<city> | v2");
  // domain-keyed rows do not, so --city also matches on the brand column when
  // the row recorded one.
  const where = [`lane = 'instagram'`, `outcome = 'NONE'`];
  const params = [];
  if (city) { params.push('%@' + String(city).toLowerCase().replace(/[^a-z0-9]/g, '') + ' |%'); where.push(`brand_key ILIKE $${params.length}`); }
  if (brand) { params.push('%' + brand + '%'); where.push(`brand ILIKE $${params.length}`); }
  if (since) { params.push(String(since)); where.push(`refreshed_at > NOW() - ($${params.length} || ' days')::interval`); }
  const sql = `FROM brand_evidence_cache WHERE ${where.join(' AND ')}`;

  let rows;
  try {
    rows = (await P.query(`SELECT brand_key, brand, refreshed_at ${sql} ORDER BY refreshed_at DESC`, params)).rows;
  } catch (e) { return fail('query', e); }
  console.log(`clear-negative-cache: connected. ${rows.length} instagram NONE row(s) match.`);
  for (const r of rows.slice(0, 60)) console.log(`  ${String(r.refreshed_at).slice(0, 10)}  ${(r.brand || '(no brand)').padEnd(36)} ${r.brand_key}`);
  if (rows.length > 60) console.log(`  ... and ${rows.length - 60} more`);

  if (!rows.length) { console.log('\nNothing to clear. Done.\n'); settled = true; process.exit(0); }
  if (!APPLY) { console.log(`\nDry run: ${rows.length} row(s) would be deleted. Re-run with --apply. Done.\n`); settled = true; process.exit(0); }

  try {
    const del = await P.query(`DELETE ${sql}`, params);
    console.log(`\nDeleted ${del.rowCount} row(s). The next lookup of each business will search again. Done.\n`);
  } catch (e) { return fail('delete', e); }
  settled = true;
  await P.end().catch(() => {});
  process.exit(0);
}
main().catch((e) => fail('main', e));
