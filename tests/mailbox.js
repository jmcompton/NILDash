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
// The Mailbox column on Agent Activity. Two things to get right: the query must not
// drop agents who have no mailbox (that is the whole population being looked for),
// and it must never select a token. The cell renderer is extracted from admin.html
// and run for real rather than reimplemented.
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };

const SRV = fs.readFileSync(REPO + 'server/index.js', 'utf8');
const ADMIN = fs.readFileSync(REPO + 'public/admin.html', 'utf8');

const routeRaw = SRV.slice(SRV.indexOf("'/api/admin/agent-activity'"), SRV.indexOf("'/api/admin/signup-funnel'"));
// COMMENTS STRIPPED before asserting on the code. The first version searched the raw
// source, so the comment saying "access_token_enc / refresh_token_enc are never
// selected" was itself matched by the search for those names and the suite reported
// a leak that did not exist. Documentation must not be able to fail a code assertion.
const route = routeRaw.replace(/^\s*\/\/.*$/gm, '');

console.log('-- read only, and no credentials leave the server --');
ok('the route runs a single SELECT', (route.match(/store\.pool\.query/g) || []).length === 1);
ok('no INSERT/UPDATE/DELETE anywhere in it', !/\b(INSERT|UPDATE|DELETE)\b/.test(route));
ok('access_token_enc is never selected', !/access_token_enc/.test(route));
ok('refresh_token_enc is never selected', !/refresh_token_enc/.test(route));
ok('no SELECT * from email_accounts', !/SELECT \*\s+FROM email_accounts/i.test(route));
ok('it still requires the admin email', /user\.email !== ADMIN_EMAIL/.test(route));

console.log('\n-- agents with NO mailbox must still appear --');
// An INNER JOIN here would hide exactly the people being looked for: the agents who
// ran scans and had no way to send. That is the same class of bug as the Agent
// Activity role filter that hid Bryce from this very table.
ok('the join is a LEFT JOIN LATERAL', /LEFT JOIN LATERAL/.test(route));
ok('it is ON TRUE, so a user with no accounts still yields a row', /\)\s*ea ON TRUE/.test(route));
ok('no INNER JOIN to email_accounts', !/(?<!LEFT )JOIN email_accounts/.test(route));
ok('the subquery is correlated to the user', /FROM email_accounts WHERE user_id = u\.id/.test(route));

console.log('\n-- the column reports what it claims to --');
ok('counts all accounts', /COUNT\(\*\)::int AS n_accounts/.test(route));
ok('counts gmail specifically', /FILTER \(WHERE provider = 'gmail'\)::int AS n_gmail/.test(route));
ok('reports the EARLIEST connection, not the latest',
  /MIN\(created_at\) AS connected_at/.test(route), null);
ok('carries the status, so a broken account is not read as a working one', /AS status/.test(route));
ok('names a preferred account deterministically (gmail, then active, then oldest)',
  /ORDER BY \(provider = 'gmail'\) DESC, \(status = 'active'\) DESC, created_at/.test(route));

console.log('\n-- the limit is written down where it will be read --');
// This one deliberately reads the RAW text: it is asserting the comment exists.
ok('the endpoint says a "no" cannot rule out a past connection',
  /never connected/.test(routeRaw) && /DELETEs the email_accounts row/.test(routeRaw), null);
ok('the admin page says it too', /cannot tell you they never had one/.test(ADMIN));

console.log('\n-- colspan matches the new column count --');
const headerRow = ADMIN.slice(ADMIN.indexOf('>Agent</th>') - 200, ADMIN.indexOf('Actions</th>') + 20);
const ths = (headerRow.match(/<th /g) || []).length;
ok('9 header cells', ths === 9, ths);
const activityFn = ADMIN.slice(ADMIN.indexOf('async function loadAgentActivity'), ADMIN.indexOf('function mailboxCell'));
const colspans = [...activityFn.matchAll(/colspan="(\d+)"/g)].map((m) => Number(m[1]));
ok('every placeholder row spans all 9', colspans.length > 0 && colspans.every((c) => c === 9), colspans);
ok('the Mailbox header sits between Outreach and Last active',
  headerRow.indexOf('Outreach</th>') < headerRow.indexOf('Mailbox</th>')
  && headerRow.indexOf('Mailbox</th>') < headerRow.indexOf('Last active</th>'));

console.log('\n-- the renderer, run for real --');
// Pull mailboxCell out of admin.html and evaluate it with the two helpers it uses.
const src = ADMIN.slice(ADMIN.indexOf('function mailboxCell'), ADMIN.indexOf('async function archiveUser'));
const mailboxCell = new Function('refEsc', 'relTime', src + '; return mailboxCell;')(
  (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  (t) => (t ? 'about a month ago' : 'never'),
);

const NOW = '2026-07-01T00:00:00Z';
const noMailboxScanned = mailboxCell({ scans: 14, n_accounts: 0 });
const noMailboxIdle = mailboxCell({ scans: 0, n_accounts: 0 });
const active = mailboxCell({ scans: 14, n_accounts: 1, n_gmail: 1, provider: 'gmail', status: 'active', email_address: 'a@b.com', connected_at: NOW });
const broken = mailboxCell({ scans: 14, n_accounts: 1, n_gmail: 1, provider: 'gmail', status: 'error', email_address: 'a@b.com', connected_at: NOW });
const two = mailboxCell({ scans: 3, n_accounts: 2, n_gmail: 1, provider: 'gmail', status: 'active', email_address: 'a@b.com', connected_at: NOW });

ok('THE CASE ASKED ABOUT: scanned, no mailbox, is red and says so',
  /#f87171/.test(noMailboxScanned) && /14 scans/.test(noMailboxScanned), noMailboxScanned);
ok('no mailbox and no scans is NOT red, because they simply never started',
  !/#f87171/.test(noMailboxIdle), noMailboxIdle);
ok('an active mailbox reads as connected, in green', /#84CC16/.test(active) && /Gmail/.test(active), active);
ok('and carries when they connected', /about a month ago/.test(active), active);
ok('an erroring mailbox is amber and NOT green, so it never reads as working',
  /#fbbf24/.test(broken) && !/#84CC16/.test(broken) && /error/.test(broken), broken);
ok('a second mailbox is shown as +1 rather than hidden', /\+1/.test(two), two);
ok('singular scan is not "1 scans"', /1 scan[^s]/.test(mailboxCell({ scans: 1, n_accounts: 0 })), mailboxCell({ scans: 1, n_accounts: 0 }));

console.log('\n-- the cell is escaped: a hostile address cannot break the row --');
const nasty = mailboxCell({
  scans: 2, n_accounts: 1, provider: 'gmail', status: 'active',
  email_address: '"><img src=x onerror=alert(1)>@evil.com', connected_at: NOW,
});
ok('no raw < from the address survives into the cell', !/<img/.test(nasty), nasty.slice(0, 200));
ok('the quote that would close the title attribute is escaped',
  !/title="[^"]*"[^>]*>/.test(nasty.replace(/&quot;/g, '')) || /&quot;/.test(nasty), nasty.slice(0, 200));
const nastyProvider = mailboxCell({ scans: 2, n_accounts: 1, provider: '<script>x</script>', status: 'active', connected_at: NOW });
ok('an unexpected provider value is escaped too', !/<script>/.test(nastyProvider), nastyProvider.slice(0, 160));

console.log('\n-- every row still produces exactly 9 cells --');
for (const [label, u] of [
  ['no mailbox', { scans: 1, n_accounts: 0 }],
  ['active', { scans: 1, n_accounts: 1, provider: 'gmail', status: 'active', connected_at: NOW }],
  ['broken', { scans: 1, n_accounts: 1, provider: 'gmail', status: 'error', connected_at: NOW }],
]) {
  const cells = (mailboxCell(u).match(/<td /g) || []).length;
  ok(`${label} renders exactly one <td>`, cells === 1, cells);
}

console.log('\nfailures: ' + f);
process.exit(f ? 1 : 0);
