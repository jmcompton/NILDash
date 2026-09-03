#!/usr/bin/env node
'use strict';
// ── THE MARKET POOL, FILED UNDER A KEY NOTHING READ ─────────────────────────
//
//   node scripts/migrate-market-pool-key.js                 dry run (default)
//   node scripts/migrate-market-pool-key.js --apply
//   node scripts/migrate-market-pool-key.js --apply --geocode
//
// market_business_seen is the pool of businesses a Deal Scan discovered and
// passed over -- the thing scout.js falls back on so a market does not go quiet.
// The Deal Scan wrote it under a slug of the SCHOOL ("auburn-university") and
// the Scout reads it under the canonical TOWN ("auburn, al"). The two have never
// matched, so every row ever written is unreadable where it matters.
//
// f7990da fixed the writers. This moves what they already wrote.
//
// ── HOW A KEY IS TRANSLATED ─────────────────────────────────────────────────
//
// NOT by reversing the slug. "auburn-university" -> "Auburn University" is a
// guess, and a wrong guess here silently moves a market's pool to the wrong
// town. Instead the ATHLETES TABLE is the source of truth: every distinct school
// on the roster is run through the same two functions the old writer and the new
// writer use, which yields an exact old->new pair per school. A key that no
// school produces is left exactly where it is.
//
// Three ways to reach a town, cheapest first:
//   1. the shipped school map          free, instant, ~200 names
//   2. the schoolgeo CACHE             free, already paid for by a nightly run
//   3. a live Places lookup            only with --geocode, only for the rest
//
// ── MERGED, NOT OVERWRITTEN ─────────────────────────────────────────────────
//
// Two schools in one town share a town key, which is the point -- they are the
// same businesses. So the move is an upsert, and where a brand exists under both
// keys the row keeps the EARLIEST first_seen_at. That column is not decoration:
// markMarketNewcomers reads it to decide whether a market is established and
// whether a brand is new to it, so taking the later date would make businesses
// we have known for months read as newcomers.
//
// market_business_rejected moves with it. It carries the same (market_key,
// brand) key, is written by the same function, and the shift report's
// scan-rejects block scopes it with
//   market_key IN (SELECT DISTINCT market_key FROM market_business_seen)
// so leaving the two tables in different key spaces would silently zero it.
//
// ONE TRANSACTION. Either the whole roster's pools move or none of them do.

const store = require('../server/store');
const { marketPoolKey } = require('../server/services/regionKey');
const AR = require('../server/services/athleteRecord');
const { resolveSchool } = require('../server/services/schoolResolver');
const SchoolGeo = require('../server/services/schoolGeocode');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const GEOCODE = args.includes('--geocode');
const TABLES = ['market_business_seen', 'market_business_rejected'];

// The key the OLD writer used: index.js's _deepenMarketKey, copied exactly.
// Copied rather than imported because it lives inside index.js, and requiring
// that file to read one helper would boot the whole server.
function oldKeyOf(school) {
  return String(school || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

// The town, cheapest route first. Returns { market, via } or null.
async function townFor(school) {
  const rec = AR.resolveAthlete({ school }, { schoolLocation: resolveSchool });
  if (rec && rec.market) return { market: rec.market, via: 'shipped-map' };
  // The geocode cache, read with no lookup function at all: geocodeSchool
  // consults the cache first and returns null rather than calling Places when it
  // has no way to ask. Free, and it picks up every school a nightly run has
  // already resolved.
  const cached = await SchoolGeo.geocodeSchool(school, { store }).catch(() => null);
  if (cached && cached.market) return { market: cached.market, via: 'geocode-cache' };
  if (!GEOCODE) return null;
  const { lookupPlaceResult } = require('../server/services/placesLookup');
  const live = await SchoolGeo.geocodeSchool(school, { store, lookupPlaceResult })
    .catch(() => null);
  return live && live.market ? { market: live.market, via: 'geocode-live' } : null;
}

async function countsFor(P, key) {
  const out = {};
  for (const t of TABLES) {
    const r = await P.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE market_key = $1`, [key]);
    out[t] = r.rows[0].n;
  }
  return out;
}

async function main() {
  const P = store.pool;
  await new Promise((r) => setTimeout(r, 4000));   // let store init settle

  const schools = (await P.query(
    `SELECT DISTINCT btrim(data->>'school') AS school
       FROM athletes
      WHERE COALESCE(btrim(data->>'school'), '') <> ''
      ORDER BY 1`)).rows.map((r) => r.school);

  console.log(`\n${schools.length} distinct school(s) on the roster.`);
  if (!GEOCODE) console.log('(--geocode not set: the shipped map and the geocode cache only, '
    + 'no live Places lookups)');

  const plan = [];
  const unresolved = [];
  // The slug of every school we could NOT place. Tracked so the orphan report
  // below does not list them a second time under a different heading -- they
  // have an owner, we just cannot say where that owner is.
  const unresolvedKeys = new Set();
  for (const school of schools) {
    const town = await townFor(school);
    if (!town) { unresolved.push(school); unresolvedKeys.add(oldKeyOf(school)); continue; }
    const from = oldKeyOf(school);
    const to = marketPoolKey(town.market);
    if (!to) {
      unresolved.push(school + ' (town did not canonicalise)');
      unresolvedKeys.add(from);
      continue;
    }
    if (from === to) continue;                       // nothing to do
    plan.push({ school, from, to, via: town.via, market: town.market });
  }

  // ── WHAT IS ACTUALLY THERE ────────────────────────────────────────────────
  const moves = [];
  for (const p of plan) {
    const n = await countsFor(P, p.from);
    const total = TABLES.reduce((a, t) => a + n[t], 0);
    if (!total) continue;                            // no rows under the old key
    moves.push({ ...p, counts: n, total });
  }

  console.log('\n-- WHAT MOVES --');
  if (!moves.length) console.log('  nothing: no rows are filed under a school-slug key');
  for (const m of moves) {
    console.log(`  ${m.school}`);
    console.log(`    "${m.from}" -> "${m.to}"   (${m.via})`);
    console.log(`    ${m.counts.market_business_seen} seen, `
      + `${m.counts.market_business_rejected} rejected`);
  }

  // Two schools in one town is not a problem -- it is the point -- but it is
  // worth saying out loud, because their pools become one.
  const byTo = new Map();
  for (const m of moves) byTo.set(m.to, (byTo.get(m.to) || []).concat(m.school));
  for (const [to, list] of byTo) {
    if (list.length > 1) {
      console.log(`\n  NOTE: ${list.join(' and ')} share the town "${to}", so their pools merge. `
        + 'That is intended: a business is in a town, not at a school.');
    }
  }

  if (unresolved.length) {
    console.log(`\n-- ${unresolved.length} SCHOOL(S) COULD NOT BE RESOLVED TO A TOWN --`);
    for (const s of unresolved) console.log(`  ${s}`);
    console.log('  Their rows are LEFT WHERE THEY ARE. Re-run with --geocode to look these up '
      + 'live, or fix the school name on the athlete.');
  }

  // ── ROWS NO SCHOOL ACCOUNTS FOR ───────────────────────────────────────────
  // A school that has since been corrected, or an athlete since removed. Left
  // alone and reported, because moving them would mean guessing.
  //
  // A school we FOUND but could not place is not an orphan -- it is listed
  // directly above with the reason -- so its key is excluded here rather than
  // being reported twice under two headings that mean different things.
  const known = new Set([...moves.map((m) => m.from), ...moves.map((m) => m.to),
    ...unresolvedKeys]);
  const orphans = (await P.query(
    `SELECT market_key, COUNT(*)::int AS n FROM market_business_seen
      GROUP BY market_key ORDER BY n DESC`)).rows
    .filter((r) => !known.has(r.market_key) && !/,/.test(r.market_key));
  if (orphans.length) {
    console.log(`\n-- ${orphans.length} KEY(S) NO CURRENT SCHOOL ACCOUNTS FOR --`);
    for (const o of orphans.slice(0, 20)) console.log(`  "${o.market_key}"  ${o.n} row(s)`);
    console.log('  Left alone: translating these would mean reversing the slug, which is a guess.');
  }

  const rows = moves.reduce((a, m) => a + m.total, 0);
  if (!moves.length) { await P.end(); return; }

  if (!APPLY) {
    console.log(`\nDRY RUN. ${rows} row(s) across ${moves.length} market(s) would move. `
      + 'Re-run with --apply.');
    await P.end();
    return;
  }

  // ── THE MOVE ──────────────────────────────────────────────────────────────
  const client = await P.connect();
  let moved = 0;
  try {
    await client.query('BEGIN');
    for (const m of moves) {
      // EARLIEST first_seen_at WINS. markMarketNewcomers reads that column to
      // decide whether a market is established and whether a brand is new to it,
      // so taking the later of the two would make long-known businesses read as
      // newcomers and flood the "new in this market" badge.
      const a = await client.query(
        `INSERT INTO market_business_seen (market_key, brand, first_seen_at, last_seen_at)
         SELECT $2, brand, first_seen_at, last_seen_at
           FROM market_business_seen WHERE market_key = $1
         ON CONFLICT (market_key, brand) DO UPDATE
           SET first_seen_at = LEAST(market_business_seen.first_seen_at, EXCLUDED.first_seen_at),
               last_seen_at  = GREATEST(market_business_seen.last_seen_at, EXCLUDED.last_seen_at)`,
        [m.from, m.to]);
      await client.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [m.from]);

      // The reason on the surviving row is the one from whichever sighting is
      // more recent, which is the same rule the live writer uses.
      const b = await client.query(
        `INSERT INTO market_business_rejected (market_key, brand, reason, first_seen_at, last_seen_at)
         SELECT $2, brand, reason, first_seen_at, last_seen_at
           FROM market_business_rejected WHERE market_key = $1
         ON CONFLICT (market_key, brand) DO UPDATE
           SET reason = CASE WHEN EXCLUDED.last_seen_at > market_business_rejected.last_seen_at
                             THEN EXCLUDED.reason ELSE market_business_rejected.reason END,
               first_seen_at = LEAST(market_business_rejected.first_seen_at, EXCLUDED.first_seen_at),
               last_seen_at  = GREATEST(market_business_rejected.last_seen_at, EXCLUDED.last_seen_at)`,
        [m.from, m.to]);
      await client.query(`DELETE FROM market_business_rejected WHERE market_key = $1`, [m.from]);

      moved += a.rowCount + b.rowCount;
      console.log(`  moved ${a.rowCount} seen + ${b.rowCount} rejected: `
        + `"${m.from}" -> "${m.to}"`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nROLLED BACK, nothing changed: ' + e.message);
    client.release();
    await P.end();
    process.exit(1);
  }
  client.release();

  console.log(`\n${moved} row(s) moved. The Scout reads these now.`);
  // PROOF, not a claim. Re-read under the new keys and say what is there.
  for (const [to] of byTo) {
    const n = await countsFor(P, to);
    console.log(`  "${to}": ${n.market_business_seen} business(es) readable by the local lane`);
  }
  await P.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
