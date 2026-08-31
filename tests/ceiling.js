'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// Two fixes, tested against the shipped sweep: the wall-clock bounds that California
// escaped, and the plausibility ceiling that Army, Arkansas and Arizona State walked
// straight through once minKeyRoles dropped to 2.
const aiPath = require.resolve(REPO + 'server/ai.js');
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  runSourceWaves: async () => ({ results: [] }), webSearchJson: async () => ({ text: '' }),
  withTimeout: (p) => p, withDeadline: (p) => p, oneShot: async () => '', MODEL_FAST: 'fast' } };
const staffPage = require(REPO + 'server/services/staffPage.js');
const pm = require(REPO + 'server/services/programMap.js');

let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };

// NATO-alphabet surnames so nothing reads as a real staffer, and so looksLikeName
// accepts them (it rejects digits, which is what broke an earlier fixture).
const SUR = ['Alvarez', 'Bramwell', 'Castellan', 'Delacroix', 'Everly', 'Fairholm', 'Grimaldi',
  'Hollandsworth', 'Ingerson', 'Jorgensen', 'Kilbride', 'Lindqvist', 'Marchetti', 'Norrington',
  'Okonkwo', 'Pemberton', 'Quintanilla', 'Rasmussen', 'Stavros', 'Thackeray', 'Uxbridge',
  'Vandermeer', 'Wetherby', 'Xanthopoulos', 'Yardley', 'Zabriskie'];
const GIV = ['Fixture', 'Sample', 'Placeholder', 'Specimen', 'Exemplar'];
// UNIQUE per i up to 676. The first version collided, so page(393) parsed to 156
// rows after the parser deduped by name, and the test was then measuring the name
// generator rather than the ceiling.
function personName(i) {
  return `${GIV[i % GIV.length]} ${SUR[i % SUR.length]}${SUR[Math.floor(i / SUR.length) % SUR.length]}`;
}

const TITLES = ['Head Coach', 'Assistant Coach', 'Associate Head Coach',
  'Director of Basketball Operations', 'Director of Player Personnel', 'Director of Recruiting',
  'Video Coordinator', 'Strength and Conditioning Coach'];

let _uid = 0;
function rows(n, titles) {
  const t = titles || TITLES;
  let html = '';
  for (let i = 0; i < n; i++, _uid++) {
    html += `<table><tr><td><a href="/bio/${_uid}">${personName(_uid)}</a></td><td>${t[i % t.length]}</td></tr></table>`;
  }
  return html;
}
// A flat page of n rows, no headings: nothing can be cut, which is the shape the
// ceiling exists for.
function page(n, opts = {}) { _uid = 0; return rows(n, opts.titles); }

// A department page with EXPLICIT per-section sizes AND section-appropriate titles.
// Both matter. Equal-sized sections made the basketball slice a quarter of the page
// rather than a staff; and giving every section the basketball title list put
// "Director of Basketball Operations" under ADMINISTRATION, where the title-rescue
// rule then correctly claimed those rows and the test read the rescue as a leak.
const TITLES_BY_SECTION = {
  FOOTBALL: ['Head Football Coach', 'Offensive Coordinator', 'Defensive Coordinator', 'Director of Football Operations'],
  BASEBALL: ['Head Baseball Coach', 'Pitching Coach', 'Director of Baseball Operations'],
  ADMINISTRATION: ['Athletic Director', 'Deputy Athletic Director', 'Senior Associate AD for Compliance', 'Chief Financial Officer'],
};
function deptPage(spec) {
  _uid = 0;
  let html = '';
  for (const [heading, n] of spec) {
    const key = Object.keys(TITLES_BY_SECTION).find((k) => heading.toUpperCase().includes(k));
    html += `<h2>${heading}</h2>` + rows(n, key ? TITLES_BY_SECTION[key] : TITLES);
  }
  return html;
}

// FIXTURE SELF-CHECK. If the generator does not parse to what it claims, every
// assertion below is measuring the fixture rather than the code.
for (const n of [12, 393]) {
  const got = staffPage.parseStaffHtml(page(n), 'https://x.test/p').length;
  if (got !== n) {
    console.log(`FIXTURE BROKEN: page(${n}) parsed to ${got} rows, not ${n}. Aborting.`);
    process.exit(1);
  }
}
{
  const d = staffPage.parseStaffHtml(deptPage([['FOOTBALL', 120], ["BASKETBALL, MEN'S", 18], ['BASEBALL', 40]]), 'https://x.test/d');
  const bb = d.filter((p) => /BASKETBALL, MEN/i.test(p.section || '')).length;
  if (d.length !== 178 || bb !== 18) {
    console.log(`FIXTURE BROKEN: deptPage parsed ${d.length} rows with ${bb} under the basketball heading, expected 178 and 18. Aborting.`);
    process.exit(1);
  }
}

const realFetch = staffPage.fetchStaffPage;
function serve(map) {
  staffPage.fetchStaffPage = async (url) => {
    const hit = Object.keys(map).find((k) => url.includes(k));
    if (!hit) return { ok: false, reason: 'http_404', status: 404, ms: 1 };
    const v = map[hit];
    if (typeof v === 'function') return v(url);
    return { ok: true, html: v, status: 200, finalUrl: url, bytes: v.length, ms: 1 };
  };
}
function mkStore(src) {
  const written = [];
  return {
    written,
    getProgramSource: async () => src || null,
    saveProgramSourceUrl: async (school, url) => { written.push(url); return true; },
  };
}

(async () => {
  console.log('-- the ceiling rejects a department dump --');
  // 393 rows, the Arizona State shape: no per-sport headings, so nothing can be cut.
  serve({ '/sports/mens-basketball/coaches': page(393) });
  let store = mkStore(null);
  let r = await pm.sweepStaffUrl('Arizona State', store, { sport: 'basketball' });
  ok('not accepted', r.url === null, r.url);
  ok('nothing persisted', store.written.length === 0, store.written);
  ok('flagged as over the ceiling', (r.tried || []).some((t) => t.overCeiling));
  ok('the reason names the ceiling and the sport',
    (r.tried || []).some((t) => (t.reasons || []).some((x) => /ceiling 40/.test(x) && /department-wide/.test(x))),
    (r.tried[0] || {}).reasons);

  console.log('\n-- but a real basketball staff of the same shape is accepted --');
  serve({ '/sports/mens-basketball/coaches': page(16) });
  store = mkStore(null);
  r = await pm.sweepStaffUrl('Kentucky', store, { sport: 'basketball' });
  ok('accepted', r.url && /mens-basketball/.test(r.url), r.url);
  ok('16 rows', r.staffCount === 16, r.staffCount);
  ok('persisted once', store.written.length === 1, store.written);

  console.log('\n-- a page that WAS cut to a basketball section is exempt from the ceiling --');
  // 296 rows on the page; 18 of them are the men's basketball section. Well over the
  // ceiling on arrival, comfortably under it after the cut. The count that matters is
  // what survived the cut, not what arrived.
  serve({ '/staff-directory?path=mbball': deptPage([
    ['FOOTBALL', 120], ["BASKETBALL, MEN'S", 18], ["BASKETBALL, WOMEN'S", 18], ['BASEBALL', 40], ['ADMINISTRATION', 100]]) });
  store = mkStore(null);
  r = await pm.sweepStaffUrl('Kentucky', store, { sport: 'basketball' });
  ok('accepted despite the raw page being 296 rows', !!r.url, r.url);
  ok('and only the 18-row basketball section was kept', r.staffCount === 18, r.staffCount);
  ok('no overCeiling flag, because the cut succeeded',
    !(r.tried || []).some((t) => t.overCeiling));

  console.log('\n-- football is deliberately unaffected: no ceiling --');
  ok('maxStaffFor(football) is null', pm.maxStaffFor('football') === null, pm.maxStaffFor('football'));
  ok('maxStaffFor(basketball) is 40', pm.maxStaffFor('basketball') === 40, pm.maxStaffFor('basketball'));
  serve({ '/coaches': page(373, { titles: ['Head Football Coach', 'Director of Football Operations', 'Director of Player Personnel', 'Director of Recruiting', 'General Manager'] }) });
  store = mkStore(null);
  r = await pm.sweepStaffUrl('Missouri', store, { sport: 'football' });
  ok('a 373-row football page is still accepted, as before', !!r.url, r.url);
  ok('no overCeiling flag anywhere on a football sweep',
    !(r.tried || []).some((t) => t.overCeiling));

  console.log('\n-- the sweep is bounded in wall-clock time --');
  // Every candidate stalls. Without a deadline this is the California hang.
  serve({ '': async () => new Promise(() => {}) });
  staffPage.fetchStaffPage = async (url, o) => new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, reason: 'timeout', ms: (o && o.timeoutMs) || 12000 }), (o && o.timeoutMs) || 12000);
  });
  store = mkStore(null);
  const t0 = Date.now();
  r = await pm.sweepStaffUrl('California', store, { sport: 'basketball', schoolCapMs: 1500 });
  const ms = Date.now() - t0;
  ok('returned rather than hanging', r && r.url === null, r && r.url);
  ok(`finished inside its budget (took ${ms}ms against a 1500ms cap)`, ms < 6000, ms);
  ok('reported as timed out', r.timedOut === true, r.timedOut);
  ok('untried candidates are reported as skipped, not as misses',
    (r.tried || []).some((t) => t.status === 'skipped'), (r.tried || []).map((t) => t.status));

  console.log('\n-- each candidate fetch gets a share of the budget, never the full default --');
  const asked = [];
  staffPage.fetchStaffPage = async (url, o) => { asked.push(o && o.timeoutMs); return { ok: false, reason: 'http_404', status: 404, ms: 1 }; };
  store = mkStore(null);
  await pm.sweepStaffUrl('California', store, { sport: 'basketball', schoolCapMs: 5000 });
  ok('every candidate was given an explicit cap', asked.length > 0 && asked.every((x) => Number.isFinite(x)), asked);
  ok('and none exceeded the school budget', asked.every((x) => x <= 5000), asked);
  ok('and none exceeded the 12s per-candidate cap', asked.every((x) => x <= 12000), asked);

  console.log('\n-- a rejected INCUMBENT is reported as still stored, not as merely missing --');
  serve({ 'bad-department-page': page(393) });
  store = mkStore({ staff_url: 'https://asu.test/bad-department-page', football_staff_url: 'https://asu.test/bad-department-page' });
  r = await pm.sweepStaffUrl('Arizona State', store, { sport: 'basketball' });
  ok('no URL returned', r.url === null, r.url);
  ok('the bad stored URL is surfaced', r.incumbentRejected && /bad-department-page/.test(r.incumbentRejected.url), r.incumbentRejected);
  ok('with its row count', r.incumbentRejected && r.incumbentRejected.rows === 393, r.incumbentRejected);
  ok('which is well over the ceiling', r.incumbentRejected && r.incumbentRejected.rows > pm.maxStaffFor('basketball'));
  ok('and it was NOT overwritten or deleted', store.written.length === 0, store.written);

  staffPage.fetchStaffPage = realFetch;
  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})();
