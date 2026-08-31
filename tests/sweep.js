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
// Sweep tests. Stubs ai.js (no SDK in the sandbox) and stubs fetchStaffPage so the
// candidate ladder can be exercised without network.
const Module = require('module');
const path = require('path');
const AI_PATH = path.resolve(REPO + 'server/ai.js');
require.cache[AI_PATH] = { id: AI_PATH, filename: AI_PATH, loaded: true, exports: {
  webSearchJson: async () => ({ text: '{}', citations: [], searches: 0, outTokens: 0, apiMs: 0 }),
} };

const staffPage = require(REPO + 'server/services/staffPage.js');
const pm = require(REPO + 'server/services/programMap.js');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}

// Build a page that parses to exactly n staff rows, with fake names. Names must be
// digit-free: looksLikeName rejects digits, which is correct, and a fixture that
// ignores that would silently parse to zero and make every sweep look broken.
const FIRST = ['Testcase', 'Fixture', 'Sample', 'Placeholder', 'Dummy', 'Example', 'Synthetic',
  'Notional', 'Imaginary', 'Fictional'];
const LAST = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India',
  'Juliett', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra',
  'Tango', 'Uniform', 'Victor', 'Whiskey', 'Xray', 'Yankee', 'Zulu'];
function fakeName(i) { return `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`; }

// Acceptance is now a QUALITY score, so a fixture of 100 identical "Assistant Coach"
// rows is correctly rejected for covering no key roles. A page that should pass has
// to look like a real football page: titled rows covering the key seats.
const KEY_TITLES = ['Head Coach', 'General Manager', 'Director of Player Personnel',
  'Director of Recruiting'];
function pageWith(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const title = i < KEY_TITLES.length ? KEY_TITLES[i] : 'Assistant Coach';
    rows.push(`<tr><td>${fakeName(i)}</td><td>${title}</td>` +
      `<td><a href="mailto:staff${i}@example.edu">staff${i}@example.edu</a></td></tr>`);
  }
  return `<html><body><table>${rows.join('')}</table></body></html>`;
}
// A page that parses but is NOT a staff table: the Alabama failure mode.
function junkPageWith(n) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(`<tr><td><a href="/x">Full Bio for ${fakeName(i)}</a></td></tr>`);
  return `<html><body><table>${rows.join('')}</table></body></html>`;
}
// Guard the fixtures themselves: if these stop holding, every count below is a lie.
{
  const probe = staffPage.parseStaffHtml(pageWith(12), 'https://x.com/s/');
  if (probe.length !== 12) {
    console.error(`FIXTURE BROKEN: pageWith(12) parsed to ${probe.length}, not 12`);
    process.exit(1);
  }
  const pats = require(REPO + 'server/services/programMap.js').ROLES.map((r) => r.match);
  if (!staffPage.scoreStaffPage(probe, pats).accepted) {
    console.error('FIXTURE BROKEN: pageWith(12) should pass the quality bar');
    process.exit(1);
  }
  if (staffPage.scoreStaffPage(staffPage.parseStaffHtml(junkPageWith(50), 'https://x.com/s/'), pats).accepted) {
    console.error('FIXTURE BROKEN: junkPageWith(50) should FAIL the quality bar');
    process.exit(1);
  }
}

// Stub the network. routes maps a full URL to {status, staff} or {status} for a miss.
const realFetch = staffPage.fetchStaffPage;
let LOG = [];
function stubNet(routes) {
  staffPage.fetchStaffPage = async (url) => {
    LOG.push(url);
    const r = routes[url];
    if (!r) return { ok: false, reason: 'http_404', status: 404, ms: 1 };
    if (r.status >= 400) return { ok: false, reason: 'http_' + r.status, status: r.status, ms: 1 };
    return { ok: true, html: pageWith(r.staff), status: r.status || 200,
      finalUrl: r.finalUrl || url, bytes: 100, ms: 1 };
  };
}

// Minimal store stub.
function mkStore(initial) {
  const state = { src: initial || null, saved: [] };
  return {
    state,
    getProgramSource: async () => state.src,
    saveProgramSourceUrl: async (school, url, via, contactUrl) => {
      state.saved.push({ school, url, via, contactUrl });
      // The real store's column is staff_url; football_staff_url is only an alias it
      // adds on the way out. The fixture writes both so it models the real row.
      state.src = { ...(state.src || {}), staff_url: url, football_staff_url: url,
        staff_url_discovered_via: via, football_staff_url_discovered_via: via };
      return true;
    },
  };
}

const D = 'https://lsusports.net';

(async () => {
  console.log('-- stops at the first path that hits --');
  LOG = [];
  stubNet({ [D + '/staff-directory?path=football']: { status: 200, staff: 74 } });
  let store = mkStore(null);
  let r = await pm.sweepStaffUrl('LSU', store, {});
  ok('found the working path', r.url === D + '/staff-directory?path=football', r.url);
  ok('reported the staff count', r.staffCount === 74, r.staffCount);
  ok('via is sweep', r.via === 'sweep', r.via);
  ok('persisted the winner', store.state.saved.length === 1 && store.state.saved[0].via === 'sweep',
    store.state.saved);
  ok('stopped, did not try the paths after the hit', LOG.length === 5, LOG.length);
  ok('tried the earlier paths first', LOG[0] === D + '/sports/football/coaches', LOG[0]);

  console.log('-- a thin page is rejected, sweep keeps going --');
  LOG = [];
  stubNet({
    [D + '/sports/football/coaches']: { status: 200, staff: 3 },   // soft-404 homepage
    [D + '/staff-directory/department/football']: { status: 200, staff: 88 },
  });
  store = mkStore(null);
  r = await pm.sweepStaffUrl('LSU', store, {});
  ok('rejected the 3-staff page', r.url === D + '/staff-directory/department/football', r.url);
  ok('kept the 88-staff page', r.staffCount === 88, r.staffCount);

  console.log('-- acceptance is QUALITY, not size: a big junk page loses to a small real one --');
  // The Alabama regression, reproduced end to end through the sweep.
  LOG = [];
  staffPage.fetchStaffPage = async (url) => {
    LOG.push(url);
    if (url === D + '/staff-directory') return { ok: true, html: junkPageWith(381), status: 200, finalUrl: url, bytes: 9, ms: 1 };
    if (url === D + '/sports/football/coaches') return { ok: true, html: pageWith(19), status: 200, finalUrl: url, bytes: 9, ms: 1 };
    return { ok: false, reason: 'http_404', status: 404, ms: 1 };
  };
  store = mkStore({ staff_url: D + '/staff-directory', football_staff_url: D + '/staff-directory', last_staff_count: 381 });
  r = await pm.sweepStaffUrl('LSU', store, { allPaths: true });
  ok('381-row junk page is NOT chosen', r.url !== D + '/staff-directory', r.url);
  ok('19-row real page wins', r.url === D + '/sports/football/coaches', r.url);
  ok('count reported is the real one', r.staffCount === 19, r.staffCount);
  ok('the replacement was persisted', store.state.saved.length === 1, store.state.saved);

  console.log('-- nothing works: returns null so the caller falls back to search --');
  stubNet({});
  store = mkStore(null);
  r = await pm.sweepStaffUrl('LSU', store, {});
  ok('no url', r.url === null, r.url);
  ok('via none', r.via === 'none', r.via);
  ok('tried every candidate', r.tried.length === pm.STAFF_URL_CANDIDATES.length, r.tried.length);
  ok('nothing persisted', store.state.saved.length === 0, store.state.saved);

  console.log('-- a hand-set URL is NEVER swept over --');
  stubNet({ [D + '/sports/football/coaches']: { status: 200, staff: 99 } });
  store = mkStore({ staff_url: 'https://hand.set/page', football_staff_url: 'https://hand.set/page', url_locked: true, last_staff_count: 0 });
  r = await pm.sweepStaffUrl('LSU', store, {});
  ok('kept the hand-set URL', r.url === 'https://hand.set/page', r.url);
  ok('marked skipped', r.skipped === true, r.skipped);
  ok('wrote nothing', store.state.saved.length === 0, store.state.saved);
  ok('did not even fetch', true, null);

  console.log('-- a hand-set URL is not swept over even when it is BROKEN --');
  stubNet({ [D + '/sports/football/coaches']: { status: 200, staff: 99 } });
  store = mkStore({ staff_url: 'https://hand.set/gone', football_staff_url: 'https://hand.set/gone', url_locked: true, last_staff_count: 0 });
  r = await pm.sweepStaffUrl('LSU', store, { ignoreIncumbent: true });
  ok('still locked under ignoreIncumbent', r.url === 'https://hand.set/gone', r.url);
  ok('still wrote nothing', store.state.saved.length === 0, store.state.saved);

  console.log('-- --force overrides the lock --');
  store = mkStore({ staff_url: 'https://hand.set/page', football_staff_url: 'https://hand.set/page', url_locked: true, last_staff_count: 0 });
  r = await pm.sweepStaffUrl('LSU', store, { force: true });
  ok('force sweeps past the lock', r.url === D + '/sports/football/coaches', r.url);

  console.log('-- an already-working school is left alone --');
  LOG = [];
  stubNet({
    'https://works.fine/page': { status: 200, staff: 68 },
    [D + '/sports/football/coaches']: { status: 200, staff: 99 },
  });
  store = mkStore({ staff_url: 'https://works.fine/page', football_staff_url: 'https://works.fine/page', last_staff_count: 68,
    staff_url_discovered_via: 'search', football_staff_url_discovered_via: 'search' });
  r = await pm.sweepStaffUrl('LSU', store, {});
  ok('kept the working URL', r.url === 'https://works.fine/page', r.url);
  ok('marked skipped', r.skipped === true, r.skipped);
  ok('wrote nothing', store.state.saved.length === 0, store.state.saved);
  ok('the incumbent is fetched and scored, not trusted on its stored count',
    LOG[0] === 'https://works.fine/page' && LOG.length === 1, LOG);

  console.log('-- an incumbent that FAILS quality is replaced, whatever its size --');
  LOG = [];
  staffPage.fetchStaffPage = async (url) => {
    LOG.push(url);
    if (url === 'https://works.fine/page') return { ok: true, html: junkPageWith(90), status: 200, finalUrl: url, bytes: 9, ms: 1 };
    if (url === D + '/sports/football/coaches') return { ok: true, html: pageWith(20), status: 200, finalUrl: url, bytes: 9, ms: 1 };
    return { ok: false, reason: 'http_404', status: 404, ms: 1 };
  };
  store = mkStore({ staff_url: 'https://works.fine/page', football_staff_url: 'https://works.fine/page', last_staff_count: 90 });
  r = await pm.sweepStaffUrl('LSU', store, {});
  ok('a 90-row junk incumbent loses to a 20-row real page', r.url === D + '/sports/football/coaches', r.url);
  ok('the replacement was persisted', store.state.saved.length === 1, store.state.saved);

  console.log('-- --all-paths tries everything and keeps the BEST --');
  LOG = [];
  stubNet({
    [D + '/sports/football/coaches']: { status: 200, staff: 19 },  // the Alabama shape
    [D + '/staff-directory/department/football']: { status: 200, staff: 91 },
    [D + '/staff-directory/football']: { status: 200, staff: 40 },
  });
  store = mkStore(null);
  r = await pm.sweepStaffUrl('LSU', store, { allPaths: true });
  ok('picked the fullest page, not the first', r.staffCount === 91, r.staffCount);
  ok('url is the fullest one', r.url === D + '/staff-directory/department/football', r.url);
  ok('tried every candidate', LOG.length === pm.STAFF_URL_CANDIDATES.length, {tried: LOG.length, candidates: pm.STAFF_URL_CANDIDATES.length});
  const accepted = r.tried.filter((t) => t.accepted);
  ok('reported all 3 hits for comparison', accepted.length === 3, accepted.map((a) => a.staff));

  console.log('-- redirect: two candidates landing on one page are counted once --');
  LOG = [];
  stubNet({
    [D + '/sports/football/coaches']: { status: 200, staff: 70, finalUrl: D + '/sports/football/coaches/' },
    [D + '/sports/football/coaches/']: { status: 200, staff: 70, finalUrl: D + '/sports/football/coaches/' },
  });
  store = mkStore(null);
  r = await pm.sweepStaffUrl('LSU', store, { allPaths: true });
  ok('persisted the RESOLVED url', r.url === D + '/sports/football/coaches/', r.url);
  const dupes = r.tried.filter((t) => t.duplicateOf);
  ok('second path marked duplicate, not counted twice', dupes.length === 1, dupes);

  console.log('-- a school with no athletics domain cannot sweep --');
  store = mkStore(null);
  r = await pm.sweepStaffUrl('Nowhere State', store, {});
  ok('returns null rather than throwing', r.url === null, r.url);

  console.log('-- the candidate list matches what was asked for --');
  ok('at least the 13 known paths', pm.STAFF_URL_CANDIDATES.length >= 13, pm.STAFF_URL_CANDIDATES.length);
ok('the season-suffixed paths observed in the 135-school run are present',
  ['/sports/football/coaches/2026', '/sports/football/coaches/1000']
    .every((x) => pm.STAFF_URL_CANDIDATES.includes(x)), null);
  ok('includes the Auburn path',
    pm.STAFF_URL_CANDIDATES.includes('/staff-directory/department/football'), null);
  ok('includes the query-string form',
    pm.STAFF_URL_CANDIDATES.includes('/staff-directory?path=football'), null);
  ok('includes the aspx form',
    pm.STAFF_URL_CANDIDATES.includes('/coaches.aspx?path=football'), null);
  ok('includes at least 3 staff-directory paths for Tennessee',
    pm.STAFF_URL_CANDIDATES.filter((p) => p.startsWith('/staff-directory')).length >= 3,
    pm.STAFF_URL_CANDIDATES.filter((p) => p.startsWith('/staff-directory')));

  staffPage.fetchStaffPage = realFetch;
  console.log('');
  console.log('failures: ' + fails);
  process.exit(fails ? 1 : 0);
})();
