'use strict';
// Program Contact Map, PHASE 1 PILOT: 10 SEC programs only.
//
// Run it:            node server/jobs/programMapPilot.js
// Dump what is saved without rebuilding:  node server/jobs/programMapPilot.js --dump
// One school:        node server/jobs/programMapPilot.js --school "Alabama"
//
// Writes to program_staff (shared, not per agent) and prints a plain readable dump
// of every record with its source URL and confidence, so each one can be checked by
// hand against the school's own staff directory. Nothing here is verified until a
// human has done that check.

const store = require('../store');
const programMap = require('../services/programMap');

// Haiku 4.5 pricing, used only for a cost ESTIMATE in the summary. Input is
// dominated by web-search results, so it is approximated per call rather than
// measured exactly; the search-tool line item is the reliable part.
const PRICE_IN_PER_M = 1.00;
const PRICE_OUT_PER_M = 5.00;
const PRICE_PER_SEARCH = 0.01;   // $10 per 1,000 web searches
const EST_INPUT_TOKENS_PER_CALL = 7000;

function line(ch = '-', n = 78) { return ch.repeat(n); }

function dumpRecords(rows) {
  const bySchool = new Map();
  for (const r of rows) {
    if (!bySchool.has(r.school)) bySchool.set(r.school, []);
    bySchool.get(r.school).push(r);
  }
  for (const [school, recs] of bySchool) {
    console.log('\n' + line('='));
    console.log(school.toUpperCase());
    console.log(line('='));
    const byRole = new Map();
    for (const r of recs) {
      if (!byRole.has(r.role)) byRole.set(r.role, []);
      byRole.get(r.role).push(r);
    }
    for (const role of programMap.ROLES) {
      const rs = byRole.get(role.key) || [];
      if (!rs.length) { console.log(`\n  ${role.label}\n    (EMPTY, nothing found)`); continue; }
      console.log(`\n  ${role.label}${rs.length > 1 ? '   *** ' + rs.length + ' CONFLICTING RECORDS ***' : ''}`);
      for (const r of rs) {
        console.log(`    name        ${r.name}`);
        console.log(`    title       ${r.title || '(none)'}`);
        console.log(`    confidence  ${String(r.confidence || '').toUpperCase()}   (source tier ${r.source_tier || '?'})`);
        console.log(`    email       ${r.email || '(none, never guessed)'}`);
        if (r.email) console.log(`    email src   ${r.email_source_url}`);
        console.log(`    phone       ${r.phone || '(none)'}`);
        console.log(`    linkedin    ${r.linkedin_url || '(none)'}`);
        console.log(`    source      ${r.source_url || '(none)'}`);
        console.log(`    verified_on ${r.verified_on ? String(r.verified_on).slice(0, 10) : '(none)'}`);
        const extra = Array.isArray(r.sources) ? r.sources : [];
        if (extra.length > 1) {
          console.log(`    all sources:`);
          for (const s of extra) console.log(`      [${s.tier}] ${s.lane}: ${s.url}`);
        }
        if (rs.length > 1) console.log(`    ${line('.', 40)}`);
      }
    }
  }
}

async function run() {
  const args = process.argv.slice(2);
  const dumpOnly = args.includes('--dump');
  const sIdx = args.indexOf('--school');
  const only = sIdx !== -1 ? args[sIdx + 1] : null;

  if (dumpOnly) {
    const rows = await store.getProgramStaff(only || null);
    if (!rows.length) { console.log('No program_staff records stored yet. Run without --dump first.'); return; }
    dumpRecords(rows);
    console.log(`\n${rows.length} record(s) stored.`);
    return;
  }

  const schools = only ? [only] : programMap.PILOT_SCHOOLS;
  console.log(`[program-map] PILOT starting: ${schools.length} program(s)`);
  console.log(`[program-map] roles per program: ${programMap.ROLES.map((r) => r.key).join(', ')}`);
  console.log(`[program-map] source lanes: ${programMap.SOURCE_ORDER.join(', ')}\n`);

  const t0 = Date.now();
  const perSchool = [];
  let totalSearches = 0, totalOut = 0, totalSources = 0;

  // Sequential across schools on purpose: each school already fans out internally,
  // and running ten of those at once would hammer the search tool and make the
  // per-program timings meaningless.
  for (const school of schools) {
    try {
      const out = await programMap.buildProgram(school);
      await store.saveProgramStaff(school, out.records);
      perSchool.push(out);
      totalSearches += out.meter.searches;
      totalOut += out.meter.outTokens;
      totalSources += out.meter.sources;
    } catch (e) {
      console.error(`[program-map] school="${school}" FAILED: ${e.message}`);
      perSchool.push({ school, records: [], ms: 0, meter: { searches: 0, outTokens: 0, sources: 0 }, rolesFilled: 0, rolesTotal: programMap.ROLES.length, error: e.message });
    }
  }
  const totalMs = Date.now() - t0;

  // ── The dump ──
  const rows = await store.getProgramStaff(only || null);
  dumpRecords(rows);

  // ── Summary ──
  const searchCost = totalSearches * PRICE_PER_SEARCH;
  const inCost = (totalSources * EST_INPUT_TOKENS_PER_CALL / 1e6) * PRICE_IN_PER_M;
  const outCost = (totalOut / 1e6) * PRICE_OUT_PER_M;
  const emptyByRole = new Map();
  for (const role of programMap.ROLES) emptyByRole.set(role.key, []);
  for (const s of perSchool) {
    const have = new Set(s.records.map((r) => r.role));
    for (const role of programMap.ROLES) if (!have.has(role.key)) emptyByRole.get(role.key).push(s.school);
  }
  const tierAByLane = new Map();
  for (const r of rows) {
    if (r.source_tier !== 'A') continue;
    for (const src of (Array.isArray(r.sources) ? r.sources : [])) {
      if (src.tier !== 'A') continue;
      tierAByLane.set(src.lane, (tierAByLane.get(src.lane) || 0) + 1);
    }
  }

  console.log('\n' + line('='));
  console.log('PILOT SUMMARY');
  console.log(line('='));
  console.log(`programs run            ${perSchool.length}`);
  console.log(`records written         ${rows.length}`);
  console.log(`total wall time         ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`avg time per program    ${(totalMs / Math.max(1, perSchool.length) / 1000).toFixed(1)}s`);
  console.log(`source lookups          ${totalSources}`);
  console.log(`web searches            ${totalSearches}`);
  console.log(`output tokens           ${totalOut}`);
  console.log(`\nESTIMATED COST`);
  console.log(`  web search tool       $${searchCost.toFixed(3)}  (${totalSearches} x $${PRICE_PER_SEARCH})`);
  console.log(`  Haiku input (est)     $${inCost.toFixed(3)}  (~${EST_INPUT_TOKENS_PER_CALL} tok x ${totalSources} calls)`);
  console.log(`  Haiku output          $${outCost.toFixed(3)}  (${totalOut} tok)`);
  console.log(`  TOTAL (est)           $${(searchCost + inCost + outCost).toFixed(3)}`);
  console.log(`  per program           $${((searchCost + inCost + outCost) / Math.max(1, perSchool.length)).toFixed(3)}`);

  console.log(`\nROLE COVERAGE (empty = nothing found)`);
  for (const role of programMap.ROLES) {
    const empties = emptyByRole.get(role.key);
    console.log(`  ${role.label.padEnd(30)} filled ${perSchool.length - empties.length}/${perSchool.length}${empties.length ? '   EMPTY: ' + empties.join(', ') : ''}`);
  }

  console.log(`\nCONFIDENCE MIX`);
  for (const c of ['confident', 'likely', 'conflicting', 'unverified']) {
    console.log(`  ${c.padEnd(14)} ${rows.filter((r) => r.confidence === c).length}`);
  }

  console.log(`\nWHICH LANES PRODUCED TIER A HITS`);
  if (!tierAByLane.size) console.log('  none');
  for (const [lane, n] of [...tierAByLane.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${lane.padEnd(22)} ${n}`);

  console.log(`\nNOT VERIFIED. Check each record above against the school's own staff`);
  console.log(`directory before trusting it. Tier A records cite that directory directly.`);
}

module.exports = { run, dumpRecords };

if (require.main === module) {
  run().then(() => process.exit(0)).catch((e) => { console.error('[program-map] fatal:', e.message, e.stack); process.exit(1); });
}
