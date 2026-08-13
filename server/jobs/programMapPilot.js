'use strict';
// Program Contact Map, PHASE 1 PILOT: 10 SEC programs only.
//
// Run it:            node server/jobs/programMapPilot.js
// Dump what is saved without rebuilding:  node server/jobs/programMapPilot.js --dump
// One school:        node server/jobs/programMapPilot.js --school "Alabama"
// Another sport:     node server/jobs/programMapPilot.js --sweep --sport basketball
//
// EVERY command takes --sport, and every one of them defaults to football, so any
// command that worked before still means exactly what it meant. The sport is carried
// into every read and every write: basketball never fights football over the same
// row, because sport is part of the key on all three tables.
//
// Writes to program_staff (shared, not per agent) and prints a plain readable dump
// of every record with its source URL and confidence, so each one can be checked by
// hand against the school's own staff directory. Nothing here is verified until a
// human has done that check.

const store = require('../store');
const programMap = require('../services/programMap');
const staffPage = require('../services/staffPage');
const ai = require('../ai');

// Wall-clock backstop around ONE school. Nothing in a 135-school run may be able to
// stall the whole thing: the Minnesota search fallback did exactly that, printing
// "falling back to search" and then never returning.
const SCHOOL_CAP_MS = 90000;

// Haiku 4.5 pricing, used only for a cost ESTIMATE in the summary. Input is
// dominated by web-search results, so it is approximated per call rather than
// measured exactly; the search-tool line item is the reliable part.
const PRICE_IN_PER_M = 1.00;
const PRICE_OUT_PER_M = 5.00;
const PRICE_PER_SEARCH = 0.01;   // $10 per 1,000 web searches
const EST_INPUT_TOKENS_PER_CALL = 7000;

function line(ch = '-', n = 78) { return ch.repeat(n); }

function dumpRecords(rows, contactsBySchool, roleList, sportLabel) {
  const roles = roleList || programMap.ROLES;
  const label = (sportLabel || 'Football').toLowerCase();
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
    const officePhone = c && (c.office_phone || c.football_office_phone);
    const officePhoneSrc = c && (c.office_phone_source_url || c.football_office_phone_source_url);
    console.log(`    ${label} office   ${officePhone || '(none published)'}`);
    if (officePhoneSrc) console.log(`      src             ${officePhoneSrc}`);
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
    for (const role of roles) {
      const rs = byRole.get(role.key) || [];
      if (!rs.length) { console.log(`\n  ${role.label}\n    (EMPTY, nothing found)`); continue; }
      const current = rs.filter((r) => r.status === 'current');
      const previous = rs.filter((r) => r.status !== 'current');
      console.log(`\n  ${role.label}${current.length > 1 ? '   *** ' + current.length + ' CONFLICTING ***' : ''}`);
      for (const r of current) {
        console.log(`    name        ${r.name}`);
        console.log(`    title       ${r.title || '(none)'}`);
        console.log(`    sport       ${r.sport || 'unstated'}`);
        if (r.page_section) console.log(`    listed under "${r.page_section}" on the source page`);
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
  // --sport, resolved once. An unknown or unscannable sport stops the run rather
  // than silently falling back to football and writing football rows under a name
  // the operator did not ask for.
  const spIdx = args.indexOf('--sport');
  const sportRaw = spIdx !== -1 ? args[spIdx + 1] : null;
  const sport = sportRaw ? programMap.normalizeSport(sportRaw) : programMap.DEFAULT_SPORT;
  if (sportRaw && !sport) {
    console.log(`Unknown sport "${sportRaw}". Scannable sports: ${programMap.SCANNABLE_SPORTS.join(', ')}`);
    console.log('(Aliases: basketball and mbb both mean mens_basketball.)');
    return;
  }
  const SPORT = programMap.SPORTS[sport];
  const roleList = programMap.rolesFor(sport);
  if (sport !== programMap.DEFAULT_SPORT) console.log(`[program-map] SPORT = ${sport} (${SPORT.label})\n`);
  const dumpOnly = args.includes('--dump');
  const sIdx = args.indexOf('--school');
  const only = sIdx !== -1 ? args[sIdx + 1] : null;
  // --all-schools widens every command from the 10 pilot programs to all of FBS.
  // Opt-in rather than default: a bulk run touches ~135 external sites, and nobody
  // should trigger that by forgetting a flag.
  const allSchools = args.includes('--all-schools');
  const schoolList = () => (allSchools ? programMap.ALL_SCHOOLS : programMap.PILOT_SCHOOLS);
  // --school may be repeated: --school "Arkansas" --school "Tulane". `only` stays
  // the first one so every existing single-school command behaves exactly as before.
  const onlySchools = args.reduce((acc, a, i) => (a === '--school' && args[i + 1] ? acc.concat(args[i + 1]) : acc), []);
  // Schools that have records but no key contact, or no records at all. This is the
  // repair list: refetch what is broken instead of all 135.
  async function zeroKeyContactSchools() {
    // Scoped to THIS sport. A school with a full football staff and no basketball
    // rows must appear on the basketball repair list, not be counted as done.
    const r = await store.pool.query(`
      SELECT school, COUNT(*) FILTER (WHERE is_key_contact)::int AS key_contacts
      FROM program_staff WHERE status = 'current' AND sport = $1 GROUP BY school
    `, [sport]);
    const by = {};
    for (const row of r.rows) by[row.school] = row.key_contacts;
    // Every known school, not schoolList(): a repair list scoped to the pilot ten
    // would silently ignore the broken schools among the other 125, which is the
    // same subset bug that made the coverage block report 9 of 10.
    return programMap.ALL_SCHOOLS.filter((s) => !by[s] || by[s] === 0);
  }

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
      console.log('Usage: --set-url --school "LSU" --url "https://lsusports.net/sports/football/coaches/" [--contact-url "https://..."] [--sport basketball]');
      return;
    }
    if (!/^https?:\/\//i.test(url)) { console.log(`Refusing to store "${url}": not an http(s) URL.`); return; }
    const ok = await store.saveProgramSourceUrl(only, url, 'manual', contactUrl, sport);
    if (!ok) { console.log(`Failed to store the URL for ${only}.`); return; }
    console.log(`SET ${only} (${SPORT.label})\n  staff_url = ${url}${contactUrl ? '\n  athletics_contact_url = ' + contactUrl : ''}\n  locked: discovery can no longer overwrite this.`);
    // Fetch it immediately so a typo shows up now rather than on the next full run.
    const res = await programMap.loadFootballStaff(only, store, { sport });
    if (res.error) console.log(`  WARNING: fetch failed (${res.error}). The URL is stored; fix it with another --set-url.`);
    else console.log(`  verified: fetched ${res.staff.length} staff via ${res.via} from ${res.url}`);
    return;
  }

  // --urls: show what is stored for every school, and where each URL came from.
  if (args.includes('--urls')) {
    const rows = await store.getProgramSource(null, sport);
    const bySchool = {}; for (const r of rows) bySchool[r.school] = r;
    console.log(`STORED URLS for ${SPORT.label}`);
    console.log('school                lock  via                 staff  url');
    console.log(line('-'));
    for (const school of schoolList()) {
      const r = bySchool[school];
      if (!r || !r.staff_url) { console.log(`${school.padEnd(20)}  -     (none set)`); continue; }
      console.log(`${school.padEnd(20)}  ${r.url_locked ? 'HAND' : 'auto'}  ${String(r.staff_url_discovered_via || '?').padEnd(18)}  ${String(r.last_staff_count || 0).padStart(5)}  ${r.staff_url}`);
    }
    return;
  }

  // --inspect: report what is ACTUALLY in a page. Answers whether a thin parse is
  // pagination, lazy loading or a parser miss, and whether phone numbers are even
  // published, without guessing at any of it.
  if (args.includes('--inspect')) {
    const targets = only ? [only] : schoolList();
    for (const school of targets) {
      const src = await store.getProgramSource(school, sport);
      const url = (src && src.staff_url) || null;
      console.log('\n' + line('='));
      console.log(`${school} ${SPORT.label.toUpperCase()} PAGE INSPECTION`);
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

      // --rows: the markup of the first few staff blocks and exactly what the parser
      // pulled out of each. This is what answers "the page parsed 40 names and 0
      // titles" without guessing at the cause.
      if (args.includes('--rows')) {
        const rows = staffPage.inspectRows(got.html, url, 3);
        console.log(`\n  ROW MARKUP (${rows.blocks} blocks found, showing ${rows.samples.length}):`);
        rows.samples.forEach((s, i) => {
          console.log(`\n    --- block ${i + 1} ---`);
          console.log(`    cells (${s.cellCount}): ${JSON.stringify(s.cells)}`);
          console.log(`    inline (${s.inlineCount}): ${JSON.stringify(s.inline)}`);
          if (s.attrs.length) console.log(`    attributes: ${JSON.stringify(s.attrs)}`);
          console.log(`    parser got: name=${JSON.stringify(s.parsedName)} title=${JSON.stringify(s.parsedTitle)}`);
          console.log(`    raw: ${s.rawHtml}`);
        });
        console.log('\n  If cells or inline hold a title the parser missed, that is a parser fix.');
        console.log('  If no cell holds a title at all, the page does not publish one and there is nothing to fix.');
      }
    }
    return;
  }

  // --staff: fetch and print the parsed football staff page for one or more schools
  // WITHOUT building records. This is the "show me Florida and Georgia first" path.
  if (args.includes('--staff')) {
    const targets = only ? [only] : schoolList();
    for (const school of targets) {
      console.log('\n' + line('='));
      console.log(`${school} ${SPORT.label.toUpperCase()} STAFF PAGE`);
      console.log(line('='));
      const res = await programMap.loadFootballStaff(school, store, { rediscover: args.includes('--rediscover'), sport });
      if (!res.url) { console.log('  NO STAFF URL. Discovery found nothing; set program_source.staff_url by hand with --set-url.'); continue; }
      console.log(`  url    ${res.url}`);
      console.log(`  parsed ${res.staff.length} staff via ${res.via}`);
      if (res.error) console.log(`  ERROR  ${res.error}`);
      console.log('');
      for (const p of res.staff) {
        console.log(`   ${String(p.name).padEnd(28)} ${String(p.title || '(no title)').padEnd(46)} ${p.email || ''} ${p.phone || ''}`);
      }
      const recs = programMap.recordsFromStaffPage(school, res.staff, res.url, sport);
      const tagged = recs.filter((r) => r.role !== 'staff');
      console.log(`\n  KEY CONTACTS (${tagged.filter((r) => r.is_key_contact).length} roles matched, ${tagged.length} people tagged, ${recs.length} stored in total):`);
      for (const role of roleList) {
        const rs = tagged.filter((r) => r.role === role.key).sort((a, b) => a.role_rank - b.role_rank);
        if (!rs.length) { console.log(`   ${role.label.padEnd(32)} (none on this page)`); continue; }
        rs.forEach((r) => console.log(`   ${(r.role_rank === 1 ? role.label : '').padEnd(32)} ${r.role_rank}. ${r.name} - ${r.title || 'no title'}${r.email ? '  ' + r.email : ''}`));
      }
    }
    return;
  }

  // --contacts: the product view. Per school, just the five key roles with the ways
  // to reach each one. This is what an agent asking "who runs NIL at Missouri" gets,
  // so it is worth reading as one page rather than inferring from the full dump.
  if (args.includes('--contacts')) {
    const schools = only ? [only] : schoolList();
    const rows = await store.getProgramStaff(only || null, sport);
    const contacts = await store.getProgramContact(null, sport);
    const bySchool = {}; for (const c of contacts) bySchool[c.school] = c;
    if (!rows.length) { console.log(`No ${SPORT.label} records stored yet. Run --fetch-all --sport ${sport} first.`); return; }

    const roleOrder = roleList.map((r) => r.key);
    const gaps = [];
    const blocked = [];
    let filled = 0, reachable = 0;
    for (const school of schools) {
      const mine = rows.filter((r) => r.school === school);
      console.log('\n' + line('='));
      console.log(school.toUpperCase());
      console.log(line('='));
      const office = bySchool[school] || {};
      const officePhone = office.office_phone || office.football_office_phone || null;
      if (officePhone) {
        console.log(`  ${SPORT.label.toLowerCase()} office  ${officePhone}`);
      }
      for (const key of roleOrder) {
        const role = roleList.find((r) => r.key === key) || {};
        // The key contact is the most senior person tagged with the role. Others in
        // the same role are counted so a thin answer does not look like a full one.
        // The sport guard runs again HERE, on the way out. recordsFromStaffPage
        // already blocks these at write time, but a row written before that guard
        // existed is still in the table until its school is re-fetched, and this view
        // is the one a person acts on. Cheap to re-check, expensive to get wrong.
        const inRoleRaw = mine.filter((r) => r.role === key && r.status === 'current');
        const inRole = inRoleRaw.filter((r) => !programMap.sportContradiction({
          email: r.email, section: r.page_section, title: r.title,
        }, sport));
        for (const r of inRoleRaw) {
          if (inRole.includes(r)) continue;
          const bad = programMap.sportContradiction({ email: r.email, section: r.page_section, title: r.title }, sport);
          blocked.push({ school, role: key, name: r.name, sport: bad.sport, kind: bad.kind, evidence: bad.evidence });
        }
        const top = inRole.find((r) => r.is_key_contact) || inRole[0];
        console.log('');
        console.log(`  ${role.label || key}`);
        if (!top) {
          console.log('    (empty)');
          gaps.push({ school, role: role.label || key });
          continue;
        }
        filled++;
        console.log(`    ${top.name}`);
        console.log(`    ${top.title || '(no title)'}`);
        console.log(`    email  ${top.email || '(none published)'}`);
        // A direct number is a direct number. The office line is still a way through,
        // but it must be labelled as one rather than printed as if it were theirs.
        let phoneLine = '(none)';
        if (top.phone) phoneLine = top.phone;
        else if (officePhone) phoneLine = `${officePhone} (office line, ask for ${top.name})`;
        console.log(`    phone  ${phoneLine}`);
        if (top.email || top.phone || officePhone) reachable++;
        if (top.page_section) console.log(`    listed under "${top.page_section}"`);
        if (inRole.length > 1) console.log(`    (+${inRole.length - 1} more in this role, see --dump)`);
      }
    }
    const slots = schools.length * roleOrder.length;
    console.log('\n' + line('-'));
    console.log(`${filled} of ${slots} key-contact slots filled across ${schools.length} school(s). ${reachable} have a way to reach them.`);
    if (blocked.length) {
      console.log(`\nBLOCKED BY THE SPORT GUARD (${blocked.length}). These are stored rows that would have been shown as ${SPORT.label} key contacts:`);
      for (const b of blocked) {
        console.log(`  ${b.school} ${b.role}: ${b.name} rejected because ${b.kind} "${b.evidence}" names ${b.sport}`);
      }
      console.log('  Re-run --fetch-all to clear these out of program_staff for good.');
    }
    if (gaps.length) {
      console.log(`\nEMPTY ROLES (${gaps.length}):`);
      const byRole = {};
      for (const g of gaps) (byRole[g.role] = byRole[g.role] || []).push(g.school);
      for (const [r, ss] of Object.entries(byRole)) console.log(`  ${r}: ${ss.join(', ')}`);
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
    const schools = only ? [only] : schoolList();
    const sweepOpts = { force: args.includes('--force'), allPaths: args.includes('--all-paths'), sport };
    const paths = programMap.candidatePathsFor(sport);
    console.log(`[url-sweep] sweeping ${schools.length} school(s) over ${paths.length} known ${SPORT.label} paths`);
    for (const pth of paths) console.log(`             ${pth}`);
    console.log(`[url-sweep] accept: >= ${programMap.minStaffFor(sport)} staff and >= ${programMap.minKeyRolesFor(sport)} of ${roleList.length} key roles`);
    console.log(`[url-sweep] accept threshold: quality score, not row count`);
    if (sweepOpts.allPaths) console.log('[url-sweep] --all-paths: trying every candidate, not stopping at the first hit');
    if (sweepOpts.force) console.log('[url-sweep] --force: hand-set and already-working URLs will ALSO be swept');
    // Pre-flight estimate. A bulk run is long enough that a number up front is the
    // difference between waiting and assuming it hung. No model calls happen here at
    // all: the sweep parses deterministically, so its only cost is time.
    if (schools.length > 20) {
      const perSchool = sweepOpts.allPaths ? paths.length : Math.min(4, paths.length);   // fetches attempted on average
      const secs = Math.round(schools.length * perSchool * 1.2);
      console.log(`[url-sweep] estimate: about ${perSchool} fetches per school, ~${Math.round(secs / 60)} min total. AI cost: $0, the sweep never calls a model.`);
    }
    console.log('');

    const results = [];
    let done = 0;
    for (const school of schools) {
      done++;
      if (schools.length > 20) console.log(`[url-sweep] --- ${done}/${schools.length} ${school} ---`);
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

  // --fetch-all: run the staff-page fetch across every pilot school, print per-school
  // counts, and WRITE the records. No search fan-out and no model calls.
  //
  // It used to print and discard, which made --contacts read whatever the last full
  // build left behind: stale rows from before the parser learned to read emails and
  // sections. A page can show 68 of 68 emails here while the key-contact view shows
  // none, because the two were looking at different data. Pass --dry-run for the old
  // read-only behavior.
  if (args.includes('--fetch-all')) {
    const dryRun = args.includes('--dry-run');
    console.log(dryRun
      ? '[program-map] --dry-run: parsing and reporting only, nothing will be written'
      : '[program-map] records WILL be written to program_staff (pass --dry-run to skip)');
    // --resume: skip schools whose records were written in the last 24 hours, so a
    // rerun after a stall picks up where it stopped instead of refetching everything
    // already in hand.
    let targets = schoolList();
    let skippedFresh = 0;
    // Explicit schools win over everything: --school A --school B fetches exactly
    // those two. Then --only-zero, the repair list. Then the full list.
    if (onlySchools.length) {
      targets = onlySchools;
      console.log(`[program-map] fetching ${targets.length} named school(s): ${targets.join(', ')}`);
    } else if (args.includes('--only-zero')) {
      targets = await zeroKeyContactSchools();
      console.log(`[program-map] --only-zero: ${targets.length} school(s) with zero key contacts, out of ${programMap.ALL_SCHOOLS.length} known`);
      if (!targets.length) { console.log('[program-map] every school has at least one key contact. Nothing to repair.'); return; }
      for (const s of targets) console.log(`    ${s}`);
      console.log('');
    }
    // --resume is about not refetching what already worked, so it is meaningless
    // once the target list is already a deliberate repair list: every school in it
    // was fetched recently AND is broken, so resume would skip all of them.
    const resumeApplies = args.includes('--resume') && !onlySchools.length && !args.includes('--only-zero');
    if (args.includes('--resume') && !resumeApplies) {
      console.log('[program-map] --resume ignored: the target list is already explicit, and these schools need refetching regardless of when they were last touched.');
    }
    if (resumeApplies) {
      // Scoped to THIS sport: a school whose football rows were written an hour ago
      // has not been touched for basketball, and must not be skipped as fresh.
      const fresh = await store.pool.query(`
        SELECT school FROM program_staff
        WHERE status = 'current' AND sport = $1
        GROUP BY school
        HAVING MAX(updated_at) > NOW() - INTERVAL '24 hours'
      `, [sport]);
      const done = new Set(fresh.rows.map((r) => r.school));
      const before = targets.length;
      targets = targets.filter((s) => !done.has(s));
      skippedFresh = before - targets.length;
      console.log(`[program-map] --resume: skipping ${skippedFresh} school(s) fetched in the last 24h, fetching ${targets.length}`);
      if (!targets.length) { console.log('[program-map] nothing left to fetch. Drop --resume to force a full refetch.'); return; }
    }
    console.log('school                staff  emails  phones  roles  keyContacts  titles  junk  via      ms     url');
    console.log(line('-'));
    const failures = [];
    const suspect = [];
    const timedOut = [];
    let tStaff = 0, tEmail = 0, tPhone = 0;
    let written = 0, withEmailWritten = 0, keyWithEmail = 0;
    let idx = 0;
    for (const school of targets) {
      idx++;
      const t0 = Date.now();
      let res;
      try {
        // BACKSTOP. Every external call inside loadFootballStaff is capped
        // individually, but this bounds the whole school regardless of what stalls
        // inside it, including anything added later. One school can cost 90
        // seconds; it can never cost the run.
        res = await ai.withTimeout(
          programMap.loadFootballStaff(school, store, { rediscover: args.includes('--rediscover'), sport }),
          SCHOOL_CAP_MS, `fetch for ${school}`);
      } catch (e) {
        const isTimeout = /^timeout after/.test(e.message || '');
        if (isTimeout) timedOut.push(school);
        failures.push({ school, reason: e.message });
        console.log(`${school.padEnd(20)} ${isTimeout ? 'TIMED OUT after ' + Math.round(SCHOOL_CAP_MS / 1000) + 's, moving on' : 'FAILED ' + e.message}`);
        continue;
      }
      if (!res.url) { failures.push({ school, reason: 'no url discovered' }); console.log(`${school.padEnd(20)} NO URL DISCOVERED`); continue; }
      if (res.error) { failures.push({ school, reason: res.error }); console.log(`${school.padEnd(20)} FETCH FAILED ${res.error}  ${res.url}`); continue; }
      const recs = programMap.recordsFromStaffPage(school, res.staff, res.url, sport);
      const tagged = recs.filter((r) => r.role !== 'staff');
      const emails = res.staff.filter((p) => p.email).length;
      const phones = res.staff.filter((p) => p.phone).length;
      tStaff += res.staff.length; tEmail += emails; tPhone += phones;
      if (!dryRun) {
        // reach_via is set the same way the full build sets it, so a record written
        // here is not a second-class version of the same row.
        const office = await store.getProgramContact(school, sport);
        for (const r of recs) r.reach_via = programMap.reachVia(r, office);
        const n = await store.saveProgramStaff(school, recs, sport);
        written += n;
        withEmailWritten += recs.filter((r) => r.email).length;
        keyWithEmail += recs.filter((r) => r.is_key_contact && r.email).length;
      }
      // Quality is printed per school so a page that parses navigation instead of
      // staff is visible in the table rather than only in a hand audit of the dump.
      const score = staffPage.scoreStaffPage(res.staff, programMap.keyRolePatternsFor(sport), programMap.minKeyRolesFor(sport));
      const pct = (x) => `${Math.round(x * 100)}%`;
      if (!score.accepted) suspect.push({ school, url: res.url, reasons: score.reasons });
      console.log(`${school.padEnd(20)} ${String(res.staff.length).padStart(5)}  ${String(emails).padStart(6)}  ${String(phones).padStart(6)}  ${String(tagged.length).padStart(5)}  ${String(tagged.filter((r) => r.is_key_contact).length).padStart(11)}  ${pct(score.titleRate).padStart(6)}  ${pct(score.junkRate).padStart(4)}  ${String(res.via).padEnd(7)} ${String(Date.now() - t0).padStart(5)}  ${res.url}`);
    }
    console.log(line('-'));
    console.log(`TOTAL                ${String(tStaff).padStart(5)}  ${String(tEmail).padStart(6)}  ${String(tPhone).padStart(6)}`);
    if (failures.length) {
      console.log(`\nDISCOVERY / FETCH FAILURES (${failures.length}):`);
      for (const f of failures) console.log(`  ${f.school}: ${f.reason}`);
    } else console.log('\nNo discovery or fetch failures.');
    if (suspect.length) {
      console.log(`\nPAGES THAT FAIL THE QUALITY BAR (${suspect.length}). These parsed something, but probably not a staff table:`);
      for (const s of suspect) {
        console.log(`  ${s.school}: ${s.reasons.join('; ')}`);
        console.log(`    ${s.url}`);
      }
    } else console.log('Every page passed the quality bar.');
    if (!dryRun) {
      // The email counts above come from the PARSE. These come from what was written.
      // If they disagree, the gap is between parsing and storage, and saying so here
      // is cheaper than discovering it later in --contacts.
      console.log(`\nWROTE ${written} record(s) to program_staff: ${withEmailWritten} with an email, ${keyWithEmail} of them key contacts.`);
      if (withEmailWritten !== tEmail) {
        console.log(`  NOTE: parsed ${tEmail} emails but stored ${withEmailWritten}. The difference is rows dropped as duplicate names.`);
      }
      console.log('Next: node server/jobs/programMapPilot.js --contacts');
    } else {
      console.log('\n--dry-run: nothing was written. Re-run without it to update program_staff.');
    }

    if (timedOut.length) {
      console.log(`\nTIMED OUT (${timedOut.length}), skipped so the run could continue. Re-run with --resume to retry just these:`);
      for (const s of timedOut) console.log(`  ${s}`);
    }

    // ── The number that actually says whether this is usable ────────────────
    // School count is a vanity metric: 135 schools with no reachable people is
    // worth nothing. Coverage is measured in KEY CONTACTS, read back from the
    // database so it reflects every school including ones --resume skipped.
    if (!dryRun) {
      const cov = await store.pool.query(`
        SELECT school,
          COUNT(*) FILTER (WHERE is_key_contact)::int AS key_contacts,
          COUNT(*) FILTER (WHERE is_key_contact AND email IS NOT NULL)::int AS key_with_email
        FROM program_staff WHERE status = 'current' AND sport = $1 GROUP BY school
      `, [sport]);
      const bySchool = {};
      for (const r of cov.rows) bySchool[r.school] = r;
      // ALWAYS the full universe, never the subset that was just fetched. A scoped
      // run measuring only its own 10 schools reported "9/10" while real coverage
      // was 117/135, which reads as a catastrophe or a triumph depending on which
      // subset you happened to run. The number has to mean the same thing every time.
      const all = programMap.ALL_SCHOOLS;
      // The bar is the sport's own minKeyRoles: football 3, basketball 2. Holding a
      // ten-person basketball staff to football's bar would report a real page as a
      // failure.
      const bar = programMap.minKeyRolesFor(sport);
      const withThree = all.filter((s) => bySchool[s] && bySchool[s].key_contacts >= bar);
      const withEmail = all.filter((s) => bySchool[s] && bySchool[s].key_with_email >= 1);
      const zero = all.filter((s) => !bySchool[s] || bySchool[s].key_contacts === 0);

      console.log('\n' + line('='));
      console.log(`${SPORT.label.toUpperCase()} COVERAGE, across all ${all.length} known school(s), not just the ${targets.length} fetched in this run`);
      console.log(line('='));
      const p = (n) => `${n} (${Math.round((n / all.length) * 100)}%)`;
      console.log(`  at least ${bar} key contacts:              ${p(withThree.length)}`);
      console.log(`  at least 1 key contact with an email: ${p(withEmail.length)}`);
      console.log(`  ZERO key contacts:                    ${p(zero.length)}`);
      if (zero.length) {
        console.log(`\nSCHOOLS WITH ZERO KEY CONTACTS (${zero.length}). These are the ones to fix:`);
        for (const s of zero) {
          const why = !bySchool[s] ? 'no records at all' : 'records exist but no role matched';
          console.log(`  ${s.padEnd(22)} ${why}`);
        }
        console.log('\n  For a school with no records, set its URL by hand:');
        console.log(`    node server/jobs/programMapPilot.js --set-url --school "NAME" --url "https://..."${sport === programMap.DEFAULT_SPORT ? '' : ' --sport ' + sport}`);
      }
    }
    return;
  }

  if (dumpOnly) {
    const rows = await store.getProgramStaff(only || null, sport);
    if (!rows.length) { console.log(`No ${SPORT.label} records stored yet. Run without --dump first.`); return; }
    const cs = await store.getProgramContact(null, sport);
    const map = {}; for (const x of cs) map[x.school] = x;
    dumpRecords(rows, map, roleList, SPORT.label);
    console.log(`\n${rows.length} record(s) stored.`);
    return;
  }

  const schools = only ? [only] : schoolList();
  console.log(`[program-map] PILOT starting: ${schools.length} ${SPORT.label} program(s)`);
  console.log(`[program-map] roles per program: ${roleList.map((r) => r.key).join(', ')}`);
  console.log(`[program-map] source lanes: ${programMap.SOURCE_ORDER.join(', ')}\n`);

  const t0 = Date.now();
  const perSchool = [];
  let totalSearches = 0, totalOut = 0, totalSources = 0;
  const nowMs = Date.now();

  // Build every school FIRST. Cross-school dedupe can only run once all programs
  // are in hand, since the whole point is spotting one person claimed by two.
  for (const school of schools) {
    try {
      const out = await programMap.buildProgram(school, nowMs, store, { sport });
      perSchool.push(out);
      totalSearches += out.meter.searches;
      totalOut += out.meter.outTokens;
      totalSources += out.meter.sources;
    } catch (e) {
      console.error(`[program-map] school="${school}" FAILED: ${e.message}`);
      perSchool.push({ school, sport, records: [], contacts: null, ms: 0, meter: { searches: 0, outTokens: 0, sources: 0 }, rolesFilled: 0, rolesTotal: roleList.length, error: e.message });
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
    await store.saveProgramStaff(s2.school, s2.records, sport);
    if (s2.contacts) await store.saveProgramContact(s2.school, s2.contacts, sport);
  }
  const totalMs = Date.now() - t0;

  // ── The dump ──
  const rows = await store.getProgramStaff(only || null, sport);
  const cs = await store.getProgramContact(null, sport);
  const contactMap = {}; for (const x of cs) contactMap[x.school] = x;
  dumpRecords(rows, contactMap, roleList, SPORT.label);

  // ── Summary ──
  const searchCost = totalSearches * PRICE_PER_SEARCH;
  const inCost = (totalSources * EST_INPUT_TOKENS_PER_CALL / 1e6) * PRICE_IN_PER_M;
  const outCost = (totalOut / 1e6) * PRICE_OUT_PER_M;
  const emptyByRole = new Map();
  for (const role of roleList) emptyByRole.set(role.key, []);
  for (const s of perSchool) {
    const have = new Set(s.records.filter((r) => r.status === 'current').map((r) => r.role));
    for (const role of roleList) if (!have.has(role.key)) emptyByRole.get(role.key).push(s.school);
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
  for (const role of roleList) {
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
  console.log(`  ${SPORT.label.toLowerCase()} office phone  ${cAll.filter((c) => c.office_phone || c.football_office_phone).length}/${perSchool.length}`);
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
