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
// Phase 23 tests: phoneFromUrl + inspectHtml signal detection.
const sp = require(REPO + 'server/services/staffPage.js');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}

console.log('-- phoneFromUrl --');
ok('South Carolina slug phone',
  sp.phoneFromUrl('https://gamecocksonline.com/staff-directory/football-803-777-4271/') === '803-777-4271',
  sp.phoneFromUrl('https://gamecocksonline.com/staff-directory/football-803-777-4271/'));
ok('date path is not a phone',
  sp.phoneFromUrl('https://x.com/sports/2023/12/11/coach-named.aspx') === null,
  sp.phoneFromUrl('https://x.com/sports/2023/12/11/coach-named.aspx'));
ok('plain staff dir has no phone',
  sp.phoneFromUrl('https://rolltide.com/staff-directory') === null,
  sp.phoneFromUrl('https://rolltide.com/staff-directory'));
ok('area code cannot start with 0 or 1',
  sp.phoneFromUrl('https://x.com/dir/football-103-777-4271/') === null,
  sp.phoneFromUrl('https://x.com/dir/football-103-777-4271/'));
ok('query string is ignored (path only)',
  sp.phoneFromUrl('https://x.com/dir?ref=555-123-4567') === null,
  sp.phoneFromUrl('https://x.com/dir?ref=555-123-4567'));
ok('garbage input does not throw',
  sp.phoneFromUrl('not a url at all') === null,
  sp.phoneFromUrl('not a url at all'));

console.log('-- inspectHtml: a page with emails and no tel links --');
const emailsNoPhones = `
<html><body>
<table>
<tr><td>Testcase Alpha</td><td>Head Coach</td><td><a href="mailto:alpha@example.edu">alpha@example.edu</a></td></tr>
<tr><td>Testcase Bravo</td><td>General Manager</td><td><a href="mailto:bravo@example.edu">bravo@example.edu</a></td></tr>
</table>
<p>Football Office: (555) 867-5309</p>
</body></html>`;
const i1 = sp.inspectHtml(emailsNoPhones, 'https://example.edu/staff-directory/football/');
ok('counts mailto links', i1.mailto === 2, i1.mailto);
ok('reports zero tel links', i1.tel === 0, i1.tel);
ok('still finds phone-shaped TEXT', i1.phoneLikeText >= 1, i1.phoneLikeText);
ok('counts table rows', i1.trBlocks === 2, i1.trBlocks);
ok('no pagination signal',
  i1.pagination.paginationMarkup === false && i1.pagination.loadMore === false
    && i1.pagination.nextLink === false && i1.pagination.pageParam === false,
  i1.pagination);

console.log('-- inspectHtml: a paginated page --');
const paginated = `
<html><body>
<div class="staff-member">Testcase Charlie</div>
<nav class="pagination"><a href="?page=2">2</a><a href="?page=3">3</a>
<a class="next" href="/staff-directory/football/?page=2">Next</a></nav>
</body></html>`;
const i2 = sp.inspectHtml(paginated, 'https://example.edu/staff-directory/football/');
ok('detects page param', i2.pagination.pageParam === true, i2.pagination.pageParam);
ok('detects pagination markup', i2.pagination.paginationMarkup === true, i2.pagination.paginationMarkup);
ok('detects a class="next" link', i2.pagination.nextLink === true, i2.pagination.nextLink);
const relNext = sp.inspectHtml('<a rel="next" href="/p/2">2</a>', 'https://x.com/s/');
ok('detects rel=next too', relNext.pagination.nextLink === true, relNext.pagination.nextLink);
const noNext = sp.inspectHtml('<a class="nextel-sponsor" href="/x">Sponsor</a>', 'https://x.com/s/');
ok('does not fire on a word containing next', noNext.pagination.nextLink === false,
  noNext.pagination.nextLink);

console.log('-- inspectHtml: a load-more page --');
const loadMore = `<html><body><div class="staff-card">Testcase Delta</div>
<button class="btn-load-more" data-action="load more">Load More</button></body></html>`;
const i3 = sp.inspectHtml(loadMore, 'https://example.edu/staff/');
ok("detects a load-more control", i3.pagination.loadMore === true, i3.pagination.loadMore);

console.log('-- inspectHtml: a client-rendered page --');
const clientSide = `
<html><body><div id="__next"></div>
<script id="__NEXT_DATA__" type="application/json">{"props":{"staff":[{"name":"Testcase Echo"}]}}</script>
<script src="/bundle.js"></script>
</body></html>`;
const i4 = sp.inspectHtml(clientSide, 'https://example.edu/staff/');
ok("detects __NEXT_DATA__", i4.clientRendered.nextData === true, i4.clientRendered.nextData);
ok('counts script tags', i4.clientRendered.scriptTags >= 2, i4.clientRendered.scriptTags);
ok('no staff blocks in the served HTML', i4.trBlocks === 0 && i4.staffLi === 0, {
  tr: i4.trBlocks, li: i4.staffLi,
});

console.log('-- inspectHtml: tel links present --');
const withTel = `<html><body><table>
<tr><td>Testcase Foxtrot</td><td>Director of Player Personnel</td>
<td><a href="tel:5558675309">555-867-5309</a></td></tr>
</table></body></html>`;
const i5 = sp.inspectHtml(withTel, 'https://example.edu/staff/');
ok('counts tel links', i5.tel === 1, i5.tel);
ok('sample tel captured', !!i5.sampleTel, i5.sampleTel);

console.log('-- inspectHtml carries the slug phone through --');
const i6 = sp.inspectHtml('<html><body></body></html>',
  'https://gamecocksonline.com/staff-directory/football-803-777-4271/');
ok('phoneInUrlSlug surfaced', i6.phoneInUrlSlug === '803-777-4271', i6.phoneInUrlSlug);

console.log('');
console.log('failures: ' + fails);
process.exit(fails ? 1 : 0);
