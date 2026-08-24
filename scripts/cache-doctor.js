#!/usr/bin/env node
// scripts/cache-doctor.js
//
// IS THE CONTACT CACHE ACTUALLY WORKING?
//
// Three runs of ladder-sample.js over the same 20 Birmingham businesses on the
// same day returned a different named person for at least seven of them. That
// should be impossible: getBrandContacts writes every result to
// brand_evidence_cache under `<brand> | <region> | manual` and reads it back for
// 30 days, so run 2 should have been a pure cache read and identical to run 1.
//
// Every cache failure in store.js is CAUGHT AND SWALLOWED -- getBrandEvidence
// returns null on error and saveBrandEvidence only logs -- so a script with no
// reachable database runs every lookup live, three times, and never says so. The
// only tell is a log line scrolling past among hundreds of others.
//
// This says it in one screen, before you spend anything.
//
// Usage:
//   DATABASE_URL=... node scripts/cache-doctor.js
//   DATABASE_URL=... node scripts/cache-doctor.js --brand "Continental Bakery" --city Birmingham --state AL
//
//   --brand <name>   also report what is cached for this business
//   --city  <name>   city for the cache key   (needs --state)
//   --state <XX>     state for the cache key
//   --list           list the newest 20 contacts rows, with age
//
// Read-only apart from one round-trip probe under a reserved key that is deleted
// before it exits.

'use strict';

const PROBE_KEY = '__cache_doctor_probe__ | zz';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : dflt;
}
const has = (name) => process.argv.indexOf('--' + name) > -1;

const ok = (s) => '  ✓ ' + s;
const bad = (s) => '  ✗ ' + s;

// Postgres JSONB does not preserve key order -- it stores keys sorted by length
// then bytewise -- so comparing JSON.stringify of what went in against what came
// back reports a difference that does not exist. Compare canonically instead.
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {});
  }
  return v;
}
const sameJson = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

async function main() {
  const L = [];
  L.push('');
  L.push('CACHE DOCTOR');
  L.push('='.repeat(66));

  // ── 1. Is there a connection string at all? ───────────────────────────────
  // This is the one that explains a fully-live re-run. pg falls back to
  // localhost:5432 when DATABASE_URL is unset, which on a laptop with no local
  // postgres is ECONNREFUSED on every single query -- caught, logged, ignored.
  const url = process.env.DATABASE_URL;
  // PGHOST/PGUSER/... are a legitimate alternative to a connection string, and
  // calling their absence a failure would be a false alarm. The connection probe
  // below is the verdict either way; this section only explains WHY.
  const pgVars = ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE'].filter((k) => process.env[k]);
  L.push('');
  L.push('1. CONNECTION');
  if (!url && !pgVars.length) {
    L.push(bad('DATABASE_URL is NOT set, and no PG* variables either.'));
    L.push('    pg falls back to localhost:5432. Every read misses and every write');
    L.push('    fails, both silently, so a re-run repeats the full live lookup and');
    L.push('    pays for it again. This alone explains three different answers.');
  } else if (!url) {
    L.push(ok('no DATABASE_URL, but PG* is set: ' + pgVars.join(', ')));
  } else {
    // Never print the password.
    let shown = url;
    try {
      const u = new URL(url);
      shown = `${u.protocol}//${u.username ? u.username + ':***@' : ''}${u.host}${u.pathname}`;
    } catch (_) { shown = '(unparseable connection string)'; }
    L.push(ok('DATABASE_URL is set: ' + shown));
  }

  const store = require('../server/store');
  // store.js calls init() at require time and it is fire-and-forget, so give the
  // schema a moment before probing rather than racing it.
  await new Promise((r) => setTimeout(r, 2500));

  let live = false;
  try {
    const r = await store.pool.query('SELECT 1 AS ok');
    live = !!(r.rows[0] && r.rows[0].ok);
    L.push(ok('the database answers'));
  } catch (e) {
    L.push(bad('the database does NOT answer: ' + e.message));
  }

  // ── 2. Does the table exist? ──────────────────────────────────────────────
  L.push('');
  L.push('2. THE TABLE');
  let tableOk = false;
  if (live) {
    try {
      const t = await store.pool.query("SELECT to_regclass('brand_evidence_cache') AS t");
      tableOk = !!(t.rows[0] && t.rows[0].t);
      L.push(tableOk ? ok('brand_evidence_cache exists') : bad('brand_evidence_cache DOES NOT EXIST'));
      if (tableOk) {
        const c = await store.pool.query(
          `SELECT lane, COUNT(*)::int AS n,
                  COUNT(*) FILTER (WHERE refreshed_at > NOW() - INTERVAL '30 days')::int AS fresh
             FROM brand_evidence_cache GROUP BY lane ORDER BY n DESC`);
        if (!c.rows.length) L.push('    the table is EMPTY — nothing has ever been cached');
        for (const row of c.rows) {
          L.push(`    lane=${String(row.lane).padEnd(12)} rows=${String(row.n).padStart(6)}   `
            + `fresh(30d)=${String(row.fresh).padStart(6)}`);
        }
      }
    } catch (e) { L.push(bad('could not inspect the table: ' + e.message)); }
  } else {
    L.push('    skipped, no connection');
  }

  // ── 3. Round trip ─────────────────────────────────────────────────────────
  // The real store functions, not a reimplementation. If this fails, nothing the
  // contact ladder writes will ever come back.
  L.push('');
  L.push('3. ROUND TRIP (write, read, compare)');
  let roundTrip = false;
  if (live && tableOk) {
    const V = 5;
    const payload = { kind: 'contacts', v: V, contacts: [{ name: 'Probe Person', title: 'Owner' }] };
    await store.saveBrandEvidence(PROBE_KEY, 'contacts', 'probe', null, payload, 'OK');
    const back = await store.getBrandEvidence(PROBE_KEY, 'contacts', 30);
    if (!back) {
      L.push(bad('wrote a row and read back NOTHING. The cache is not usable.'));
    } else if (!sameJson(back.evidence, payload)) {
      L.push(bad('read back a DIFFERENT value than was written'));
      L.push('    wrote: ' + JSON.stringify(payload));
      L.push('    read:  ' + JSON.stringify(back.evidence));
    } else {
      roundTrip = true;
      L.push(ok('a write comes back identical — the cache works'));
    }
    await store.pool.query('DELETE FROM brand_evidence_cache WHERE brand_key = $1',
      [PROBE_KEY.toLowerCase()]).catch(() => {});
  } else {
    L.push('    skipped, no usable table');
  }

  // ── 4. What is cached for one business ────────────────────────────────────
  // Uses the SAME key builder the pipeline uses, so a key that looks right here
  // is the key the ladder will ask for.
  const brand = arg('brand', null);
  const city = arg('city', null);
  const state = arg('state', null);
  if (brand && live && tableOk) {
    L.push('');
    L.push('4. THIS BUSINESS');
    const { canonicalRegion } = require('../server/services/regionKey');
    const loc = city && state ? `${city}, ${state}` : '';
    const locKey = canonicalRegion(loc);
    const deepKey = (locKey ? `${brand} | ${locKey}` : brand) + ' | manual';
    const cardKey = (locKey ? `${brand} | ${locKey}` : brand);
    L.push(`    deep key (ladder-sample, AI Outreach): ${JSON.stringify(deepKey)}`);
    L.push(`    card key (scan path):                  ${JSON.stringify(cardKey)}`);
    for (const [label, key] of [['deep', deepKey], ['card', cardKey]]) {
      const row = await store.getBrandEvidence(key, 'contacts', 30);
      if (!row) { L.push(`    ${label}: MISS — the next run will pay for a live lookup`); continue; }
      const ev = row.evidence || {};
      const ageH = ((Date.now() - new Date(row.refreshed_at).getTime()) / 3.6e6).toFixed(1);
      const names = (ev.contacts || []).map((c) => `${c.name}${c.title ? ' (' + c.title + ')' : ''}`);
      L.push(`    ${label}: HIT age=${ageH}h v=${ev.v == null ? 'none' : ev.v} outcome=${row.outcome}`);
      // A version mismatch reads as a HIT here and as a MISS to the pipeline,
      // which is the difference between "cached" and "cached but unusable".
      if (ev.v !== 5) L.push(`      version ${ev.v == null ? 'absent' : ev.v} != 5, so the pipeline treats this as a MISS and re-runs`);
      L.push(`      named: ${names.length ? names.join(', ') : '(none)'}`);
    }
  }

  // ── 5. Newest rows ────────────────────────────────────────────────────────
  if (has('list') && live && tableOk) {
    L.push('');
    L.push('5. NEWEST CONTACTS ROWS');
    const r = await store.pool.query(
      `SELECT brand_key, outcome, evidence->>'v' AS v,
              jsonb_array_length(COALESCE(evidence->'contacts','[]'::jsonb)) AS named,
              ROUND(EXTRACT(EPOCH FROM (NOW() - refreshed_at))/3600.0, 1) AS age_h
         FROM brand_evidence_cache WHERE lane = 'contacts'
        ORDER BY refreshed_at DESC LIMIT 20`);
    if (!r.rows.length) L.push('    none');
    for (const row of r.rows) {
      L.push(`    ${String(row.age_h).padStart(7)}h  v=${String(row.v || '-').padEnd(3)} `
        + `named=${String(row.named).padStart(2)} ${String(row.outcome).padEnd(9)} ${row.brand_key}`);
    }
  }

  // ── The verdict ───────────────────────────────────────────────────────────
  L.push('');
  L.push('='.repeat(66));
  if (!live) {
    L.push('VERDICT: no database. Every lookup runs live and costs money EVERY time,');
    L.push('and two runs of the same list can never agree. Set DATABASE_URL.');
  } else if (!tableOk) {
    L.push('VERDICT: connected, but brand_evidence_cache is missing. Same effect.');
  } else if (!roundTrip) {
    L.push('VERDICT: the table is there but a write did not come back. Nothing the');
    L.push('contact ladder caches will be readable. Treat every run as live.');
  } else {
    L.push('VERDICT: the cache is reachable and round-trips. If two runs of the same');
    L.push('list still disagree, the cause is downstream of the cache — the ranking');
    L.push('tie-break, wave completion order, or model temperature.');
  }
  L.push('');
  console.log(L.join('\n'));
  await store.pool.end().catch(() => {});
  process.exit(live && tableOk && roundTrip ? 0 : 1);
}

main().catch((e) => { console.error('cache-doctor failed:', e.message); process.exit(1); });
