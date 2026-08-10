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

function dumpRecords(rows, contactsBySchool) {
  const bySchool = new Map();
  for (const r of rows) {
    if (!bySchool.has(r.school)) bySchool.set(r.school, []);
    bySchool.get(r.school).push(r);
  }
  for (const [school, recs] of bySchool) {
    console.log('\n' + line('='));
    console.log(school.toUpperCase());
    console.log(line('='));
    const c = (contactsBySchool && contactsBySchool[school]) || null;
    console.log('  PROGRAM CONTACT');
    console.log(`    football office   ${c && c.football_office_phone ? c.football_office_phone : '(none published)'}`);
    if (c && c.football_office_phone_source_url) console.log(`      src             ${c.football_office_phone_source_url}`);
    console.log(`    recruiting email  ${c && c.recruiting_email ? c.recruiting_email : '(none published)'}`);
    if (c && c.recruiting_email_source_url) console.log(`      src             ${c.recruiting_email_source_url}`);
    console.log(`    collective        ${c && c.collective_name ? c.collective_name : '(unknown)'}`);
    console.log(`    collective email  ${c && c.collective_email ? c.collective_email : '(none published)'}`);
    if (c && c.collective_email_source_url) console.log(`      src             ${c.collective_email_source_url}`);

    const byRole = new Map();
    for (const r of recs) {
      if (!byRole.has(r.role)) byRole.set(r.role, []);
      byRole.get(r.role).push(r);
    }
    for (const role of programMap.ROLES) {
      const rs = byRole.get(role.key) || [];
      if (!rs.length) { console.log(`\n  ${role.label}\n    (EMPTY, nothing found)`); continue; }
      const current = rs.filter((r) => r.status === 'current');
      const previous = rs.filter((r) => r.status !== 'current');
      console.log(`\n  ${role.label}${current.length > 1 ? '   *** ' + current.length + ' CONFLICTING ***' : ''}`);
      for (const r of current) {
        console.log(`    name        ${r.name}`);
        console.log(`    title       ${r.title || '(none)'}`);
        console.log(`    sport       ${r.sport || 'unstated'}`);
        console.log(`    confidence  ${String(r.confidence || '').toUpperCase()}   (tier ${r.source_tier || '?'}, source dated ${r.source_date || 'UNDATED'}${r.age_months != null ? ', ' + r.age_months + ' months old' : ''})`);
        if (r.source_tier_note) console.log(`    tier note   ${r.source_tier_note}`);
        console.log(`    email       ${r.email || '(none, never guessed)'}`);
        if (r.email) console.log(`    email src   ${r.email_source_url}`);
        console.log(`    phone       ${r.phone || '(none)'}`);
        console.log(`    linkedin    ${r.linkedin_url || '(none)'}`);
        console.log(`    HOW TO REACH ${r.reach_via || '(none)'}`);
        console.log(`    source      ${r.source_url || '(none)'}`);
        console.log(`    verified_on ${r.verified_on ? String(r.verified_on).slice(0, 10) : '(none)'}`);
        const extra = Array.isArray(r.sources) ? r.sources : [];
        if (extra.length > 1) {
          console.log(`    all sources:`);
          for (const sc of extra) console.log(`      [${sc.tier}] ${sc.lane} ${sc.date || 'undated'}${sc.isFormer ? ' (FORMER)' : ''}: ${sc.url}`);
        }
      }
      for (const r of previous) {
        console.log(`    previously  ${r.name} (${r.title || 'no title'}) dated ${r.source_date || 'undated'} [tier ${r.source_tier}]`);
        console.log(`                ${r.source_url || ''}`);
        if (r.superseded_note) console.log(`                ${r.superseded_note}`);
      }
    }
  }
}

async function run() {
  const args = process.argv.slice(2);
  const dumpOnly = args.includes('--dump');
  const sIdx = args.indexOf('--school');
  const only = sIdx !== -1 ? args[sIdx + 1] : null;

  // --set-url: set the football staff URL BY HAND. A hand-set URL is locked: neither
  // discovery nor redirect-resolution can overwrite it. This is the escape hatch for
  // the schools where discovery guesses a path and 404s.
  //   node server/jobs/programMapPilot.js --set-url --school "LSU" --url "https://..."
  if (args.includes('--set-url')) {
    const uIdx = args.indexOf('--url');
    const url = uIdx !== -1 ? args[uIdx + 1] : null;
    const cIdx = args.indexOf('--contact-url');
    const contactUrl = cIdx !== -1 ? args[cIdx + 1] : null;
    if (!only || !url) {
      console.log('Usage: --set-url --school "LSU" --url "https://lsusports.net/sports/football/coaches/" [--contact-url "https://..."]');
      return;
    }
    if (!/^https?:\/\//i.test(url)) { console.log(`Refusing to store "${url}": not an http(s) URL.`); return; }
    const ok = await store.saveProgramSourceUrl(only, url, 'manual', contactUrl);
    if (!ok) { console.log(`Failed to store the URL for ${only}.`); return; }
    console.log(`SET ${only}\n  football_staff_url = ${url}${contactUrl ? '\n  athletics_contact_url = ' + contactUrl : ''}\n  locked: discovery can no longer overwrite this.`);
    // Fetch it immediately so a typo shows up now rather than on the next full run.
    const res = await programMap.loadFootballStaff(only, store);
    if (res.error) console.log(`  WARNING: fetch failed (${res.error}). The URL is stored; fix it with another --set-url.`);
    else console.log(`  verified: fetched ${res.staff.length} staff via ${res.via} from ${res.url}`);
    return;
  }

  // --urls: show what is stored for every school, and where each URL came from.
  if (args.includes('--urls')) {
    const rows = await store.getProgramSource(null);
    const bySchool = {}; for (const r of rows) bySchool[r.school] = r;
    console.log('school                lock  via                 staff  url');
    console.log(line('-'));
    for (const school of programMap.PILOT_SCHOOLS) {
      const r = bySchool[school];
      if (!r || !r.football_staff_url) { console.log(`${school.padEnd(20)}  -     (none set)`); continue; }
      console.log(`${school.padEnd(20)}  ${r.url_locked ? 'HAND' : 'auto'}  ${String(r.football_staff_url_discovered_via || '?').padEnd(18)}  ${String(r.last_staff_count || 0).padStart(5)}  ${r.football_staff_url}`);
    }
    return;
  }

  // --inspect: report what is ACTUALLY in a page. Answers whether a thin parse is
  // pagination, lazy loading or a parser miss, and whether phone numbers are even
  // published, without guessing at any of it.
  if (args.includes('--inspect')) {
    const staffPage = require('../services/staffPage');
    const targets = only ? [only] : programMap.PILOT_SCHOOLS;
    for (const school of targets) {
      const src = await store.getProgramSource(school);
      const url = (src && src.football_staff_url) || null;
      console.log('\n' + line('='));
      console.log(`${school} PAGE INSPECTION`);
      console.log(line('='));
      if (!url) { console.log('  no URL stored'); continue; }
      const got = await staffPage.fetchStaffPage(url);
      if (!got.ok) { console.log(`  FETCH FAILED ${got.reason}  ${url}`); continue; }
      const i = staffPage.inspectHtml(got.html, got.finalUrl || url);
      const parsed = staffPage.parseStaffHtml(got.html, got.finalUrl || url);
      console.log(`  url            ${i.url}`);
      console.log(`  html bytes     ${i.bytes}   visible text bytes ${i.textBytes}`);
      console.log(`  parsed staff   ${parsed.length}`);
      console.log(`  BLOCKS         tr=${i.trBlocks}  staffLi=${i.staffLi}  staffDiv=${i.staffDiv}`);
      console.log(`  CONTACTS       mailto=${i.mailto}  tel=${i.tel}  phoneLikeText=${i.phoneLikeText}`);
      console.log(`  PAGINATION     pageParam=${i.pagination.pageParam} markup=${i.pagination.paginationMarkup} loadMore=${i.pagination.loadMore} nextLink=${i.pagination.nextLink}`);
      console.log(`  CLIENT RENDER  scripts=${i.clientRendered.scriptTags} scriptBytes=${i.clientRendered.scriptBytes} nextData=${i.clientRendered.nextData} ldJson=${i.clientRendered.ldJson} inlineStaffJson=${i.clientRendered.inlineStaffJson} sidearmApi=${i.clientRendered.sidearmApi}`);
      console.log(`  PHONE IN SLUG  ${i.phoneInUrlSlug || '(none)'}`);
      if (i.sampleMailto) console.log(`  sample mailto  ...${i.sampleMailto}...`);
      if (i.sampleTel) console.log(`  sample tel     ...${i.sampleTel}...`);
      if (i.samplePhoneText) console.log(`  sample phone text  ...${i.samplePhoneText}...`);
      // The read: state it plainly rather than making the human infer it.
      const notes = [];
      if (i.tel === 0 && i.phoneLikeText > 0) notes.push('phones ARE on the page but NOT as tel: links, so the parser must read them from text');
      if (i.tel === 0 && i.phoneLikeText === 0) notes.push('this page publishes no phone numbers at all');
      if (parsed.length < 25 && (i.pagination.pageParam || i.pagination.paginationMarkup || i.pagination.nextLink)) notes.push('thin parse WITH pagination markup: the page is paginated');
      if (parsed.length < 25 && i.clientRendered.scriptBytes > i.textBytes * 3) notes.push('thin parse and script-heavy: content is likely loaded after the initial HTML');
      if (parsed.length < 25 && !i.pagination.pageParam && !i.pagination.paginationMarkup && i.trBlocks > parsed.length * 2) notes.push('thin parse but plenty of rows present: this is a PARSER miss, not the page');
      if (notes.length) { console.log('  READ:'); for (const n of notes) console.log(`    - ${n}`); }
    }
    return;
  }

  // --staff: fetch and print the parsed football staff page for one or more schools
  // WITHOUT building records. This is the "show me Florida and Georgia first" path.
  if (args.includes('--staff')) {
    const targets = only ? [only] : programMap.PILOT_SCHOOLS;
    for (const school of targets) {
      console.log('\n' + line('='));
      console.log(`${school} FOOTBALL STAFF PAGE`);
      console.log(line('='));
      const res = await programMap.loadFootballStaff(school, store, { rediscover: args.includes('--rediscover') });
      if (!res.url) { console.log('  NO STAFF URL. Discovery found nothing; set program_source.football_staff_url by hand.'); continue; }
      console.log(`  url    ${res.url}`);
      console.log(`  parsed ${res.staff.length} staff via ${res.via}`);
      if (res.error) console.log(`  ERROR  ${res.error}`);
      console.log('');
      for (const p of res.staff) {
        console.log(`   ${String(p.name).padEnd(28)} ${String(p.title || '(no title)').padEnd(46)} ${p.email || ''} ${p.phone || ''}`);
      }
      const recs = programMap.recordsFromStaffPage(school, res.staff, res.url);
      const tagged = recs.filter((r) => r.role !== 'staff');
      console.log(`\n  KEY CONTACTS (${tagged.filter((r) => r.is_key_contact).length} roles matched, ${tagged.length} people tagged, ${recs.length} stored in total):`);
      for (const role of programMap.ROLES) {
        const rs = tagged.filter((r) => r.role === role.key).sort((a, b) => a.role_rank - b.role_rank);
        if (!rs.length) { console.log(`   ${role.label.padEnd(32)} (none on this page)`); continue; }
        rs.forEach((r) => console.log(`   ${(r.role_rank === 1 ? role.label : '').padEnd(32)} ${r.role_rank}. ${r.name} - ${r.title || 'no title'}${r.email ? '  ' + r.email : ''}`));
      }
    }
    return;
  }

  // --sweep: try the known Sidearm paths for every school (or one, with --school) and
  // persist the first that returns a real directory. Touches nothing else: no records
  // written, no search, no model calls.
  //   --force       sweep even schools whose URL is hand-set or already working
  //   --all-paths   try EVERY candidate instead of stopping at the first hit, and
  //                 report the count for each. This is how a thin page gets compared
  //                 against a possible separate support-staff page.
  if (args.includes('--sweep')) {
    const schools = only ? [only] : programMap.PILOT_SCHOOLS;
    const sweepOpts = { force: args.includes('--force'), allPaths: args.includes('--all-paths') };
    console.log(`[url-sweep] sweeping ${schools.length} school(s) over ${programMap.STAFF_URL_CANDIDATES.length} known paths`);
    console.log(`[url-sweep] accept threshold: more than ${programMap.MIN_SWEEP_STAFF - 1} parsed staff`);
    if (sweepOpts.allPaths) console.log('[url-sweep] --all-paths: trying every candidate, not stopping at the first hit');
    if (sweepOpts.force) console.log('[url-sweep] --force: hand-set and already-working URLs will ALSO be swept');
    console.log('');

    const results = [];
    for (const school of schools) {
      let r;
      try { r = await programMap.sweepStaffUrl(school, store, sweepOpts); }
      catch (e) { console.log(`[url-sweep] school="${school}" ERROR ${e.message}`); r = { url: null, staffCount: 0, tried: [], via: 'error', error: e.message }; }
      results.push({ school, ...r });
      console.log('');
    }

    console.log(line('-'));
    console.log('school                staff  via       url');
    console.log(line('-'));
    for (const r of results) {
      const cnt = r.staffCount == null ? '  hand' : String(r.staffCount).padStart(5);
      console.log(`${r.school.padEnd(20)} ${cnt}  ${String(r.via).padEnd(8)}  ${r.url || 'NONE'}`);
    }
    console.log(line('-'));

    // --all-paths only: the full per-path grid, which is the evidence for whether a
    // thin page has a fuller sibling.
    if (sweepOpts.allPaths) {
      console.log('\nPER-PATH RESULTS:');
      for (const r of results) {
        if (!r.tried || !r.tried.length) continue;
        console.log(`  ${r.school}:`);
        for (const t of r.tried) {
          const note = t.duplicateOf ? 'duplicate of an earlier path' : `staff=${t.staff}${t.accepted ? ' ACCEPTED' : ''}`;
          console.log(`    ${String(t.path).padEnd(38)} status=${String(t.status).padEnd(8)} ${note}`);
        }
      }
    }

    const stuck = results.filter((r) => !r.url);
    if (stuck.length) {
      console.log(`\nNEEDS ATTENTION (${stuck.length}): no known path worked. Set these by hand:`);
      for (const r of stuck) {
        console.log(`  ${r.school}`);
        console.log(`    node server/jobs/programMapPilot.js --set-url --school "${r.school}" --url "https://..."`);
      }
    } else {
      console.log('\nEvery school has a staff URL.');
    }
    console.log('\nNext: node server/jobs/programMapPilot.js --fetch-all');
    return;
  }

  // --fetch-all: run ONLY the staff-page fetch across every pilot school and print
  // per-school counts. No records written, no search fan-out.
  if (args.includes('--fetch-all')) {
    console.log('school                staff  emails  phones  roles  keyContacts  via      ms     url');
    console.log(line('-'));
    const failures = [];
    let tStaff = 0, tEmail = 0, tPhone = 0;
    for (const school of programMap.PILOT_SCHOOLS) {
      const t0 = Date.now();
      let res;
      try { res = await programMap.loadFootballStaff(school, store, { rediscover: args.includes('--rediscover') }); }
      catch (e) { failures.push({ school, reason: e.message }); console.log(`${school.padEnd(20)} FAILED ${e.message}`); continue; }
      if (!res.url) { failures.push({ school, reason: 'no url discovered' }); console.log(`${school.padEnd(20)} NO URL DISCOVERED`); continue; }
      if (res.error) { failures.push({ school, reason: res.error }); console.log(`${school.padEnd(20)} FETCH FAILED ${res.error}  ${res.url}`); continue; }
      const recs = programMap.recordsFromStaffPage(school, res.staff, res.url);
      const tagged = recs.filter((r) => r.role !== 'staff');
      const emails = res.staff.filter((p) => p.email).length;
      const phones = res.staff.filter((p) => p.phone).length;
      tStaff += res.staff.length; tEmail += emails; tPhone += phones;
      console.log(`${school.padEnd(20)} ${String(res.staff.length).padStart(5)}  ${String(emails).padStart(6)}  ${String(phones).padStart(6)}  ${String(tagged.length).padStart(5)}  ${String(tagged.filter((r) => r.is_key_contact).length).padStart(11)}  ${String(res.via).padEnd(7)} ${String(Date.now() - t0).padStart(5)}  ${res.url}`);
    }
    console.log(line('-'));
    console.log(`TOTAL                ${String(tStaff).padStart(5)}  ${String(tEmail).padStart(6)}  ${String(tPhone).padStart(6)}`);
    if (failures.length) {
      console.log(`\nDISCOVERY / FETCH FAILURES (${failures.length}):`);
      for (const f of failures) console.log(`  ${f.school}: ${f.reason}`);
    } else console.log('\nNo discovery or fetch failures.');
    return;
  }

  if (dumpOnly) {
    const rows = await store.getProgramStaff(only || null);
    if (!rows.length) { console.log('No program_staff records stored yet. Run without --dump first.'); return; }
    const cs = await store.getProgramContact(null);
    const map = {}; for (const x of cs) map[x.school] = x;
    dumpRecords(rows, map);
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
  const nowMs = Date.now();

  // Build every school FIRST. Cross-school dedupe can only run once all programs
  // are in hand, since the whole point is spotting one person claimed by two.
  for (const school of schools) {
    try {
      const out = await programMap.buildProgram(school, nowMs, store);
      perSchool.push(out);
      totalSearches += out.meter.searches;
      totalOut += out.meter.outTokens;
      totalSources += out.meter.sources;
    } catch (e) {
      console.error(`[program-map] school="${school}" FAILED: ${e.message}`);
      perSchool.push({ school, records: [], contacts: null, ms: 0, meter: { searches: 0, outTokens: 0, sources: 0 }, rolesFilled: 0, rolesTotal: programMap.ROLES.length, error: e.message });
    }
  }

  const allDropped = perSchool.flatMap((s2) => s2.droppedWrongSport || []);
  const allRecords = perSchool.flatMap((s2) => s2.records);
  const dedupe = programMap.dedupeAcrossSchools(allRecords);

  // Attach the "how to reach" fallback AFTER dedupe, so a demoted record does not
  // advertise a live phone line as if the person were still there.
  for (const s2 of perSchool) {
    for (const r of s2.records) {
      r.reach_via = r.status === 'current' ? programMap.reachVia(r, s2.contacts) : null;
    }
    await store.saveProgramStaff(s2.school, s2.records);
    if (s2.contacts) await store.saveProgramContact(s2.school, s2.contacts);
  }
  const totalMs = Date.now() - t0;

  // ── The dump ──
  const rows = await store.getProgramStaff(only || null);
  const cs = await store.getProgramContact(null);
  const contactMap = {}; for (const x of cs) contactMap[x.school] = x;
  dumpRecords(rows, contactMap);

  // ── Summary ──
  const searchCost = totalSearches * PRICE_PER_SEARCH;
  const inCost = (totalSources * EST_INPUT_TOKENS_PER_CALL / 1e6) * PRICE_IN_PER_M;
  const outCost = (totalOut / 1e6) * PRICE_OUT_PER_M;
  const emptyByRole = new Map();
  for (const role of programMap.ROLES) emptyByRole.set(role.key, []);
  for (const s of perSchool) {
    const have = new Set(s.records.filter((r) => r.status === 'current').map((r) => r.role));
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

  console.log(`\nSPORT FILTER`);
  console.log(`  records dropped as wrong sport  ${allDropped.length}`);
  if (allDropped.length) {
    const bySport = {};
    for (const d of allDropped) bySport[d.sport] = (bySport[d.sport] || 0) + 1;
    for (const [sp, n] of Object.entries(bySport).sort((a, b) => b[1] - a[1])) console.log(`    ${sp.padEnd(14)} ${n}`);
    console.log(`  dropped detail:`);
    for (const d of allDropped) console.log(`    [${d.sport}] ${d.name} (${d.title}) role=${d.role} via ${d.source}`);
  }
  const downgraded = rows.filter((r) => r.source_tier_note);
  console.log(`  tier A downgraded (dept-wide directory, sport not stated)  ${downgraded.length}`);

  console.log(`\nRECENCY`);
  const cur = rows.filter((r) => r.status === 'current');
  const undated = cur.filter((r) => !r.source_date).length;
  const stale = cur.filter((r) => r.age_months != null && r.age_months > programMap.STALE_MONTHS).length;
  console.log(`  current records        ${cur.length}`);
  console.log(`  previous holders kept  ${rows.length - cur.length}`);
  console.log(`  undated sources        ${undated}`);
  console.log(`  older than ${programMap.STALE_MONTHS} months   ${stale}  (never Confident on their own)`);
  console.log(`  cross-school collisions ${dedupe.collisions}, demoted ${dedupe.demoted}`);

  console.log(`\nCONTACT COVERAGE`);
  const cAll = Object.values(contactMap);
  console.log(`  football office phone  ${cAll.filter((c) => c.football_office_phone).length}/${perSchool.length}`);
  console.log(`  recruiting email       ${cAll.filter((c) => c.recruiting_email).length}/${perSchool.length}`);
  console.log(`  collective email       ${cAll.filter((c) => c.collective_email).length}/${perSchool.length}`);
  console.log(`  records with a direct email  ${cur.filter((r) => r.email).length}`);
  console.log(`  records with a direct phone  ${cur.filter((r) => r.phone).length}`);
  console.log(`  records with only a fallback ${cur.filter((r) => !r.email && !r.phone).length}`);

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
