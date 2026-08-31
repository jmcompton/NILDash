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
// The AI Outreach dead end: no mailbox -> a dropdown option you cannot select, and a
// send button telling you to select it. Plus the silent variant, where a failed
// accounts request leaves the dropdown on "Loading accounts…" forever.
//
// The From-slot renderers and the OAuth return guard are RUN, not described.
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };

const OE = fs.readFileSync(REPO + 'public/outreach-engine.js', 'utf8');

// email.js requires express, which is not installed in this sandbox, so the two
// helpers are extracted from the SHIPPED source and evaluated. Same functions, same
// text: this tests what runs, not a copy of it.
const ROUTE_SRC = fs.readFileSync(REPO + 'server/routes/email.js', 'utf8');
function lift(name) {
  const start = ROUTE_SRC.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('could not find ' + name + ' in email.js');
  let depth = 0, i = ROUTE_SRC.indexOf('{', start);
  const from = i;
  for (; i < ROUTE_SRC.length; i++) {
    if (ROUTE_SRC[i] === '{') depth++;
    else if (ROUTE_SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  return ROUTE_SRC.slice(start, i + 1);
}
const email = new Function(lift('safeReturnTo') + '\n' + lift('withMarker')
  + '\n return { safeReturnTo, withMarker };')();

// ── The open-redirect guard, exercised directly ─────────────────────────────
console.log('-- returnTo cannot be turned into an open redirect --');
const bad = [
  'https://evil.com', 'http://evil.com/x', '//evil.com', '/\\evil.com',
  'javascript:alert(1)', 'JavaScript:alert(1)', '/x\nLocation: https://evil.com',
  '/x\rSet-Cookie: a=b', 'data:text/html,x', '', null, undefined, '   ',
  'evil.com', '/' + 'a'.repeat(600),
];
for (const v of bad) ok(`refused: ${JSON.stringify(v)}`, email.safeReturnTo(v) === null, email.safeReturnTo(v));

const good = ['/', '/#deal-scan', '/?x=1#outreach', '/dashboard', '/#settings?tab=integrations'];
for (const v of good) ok(`allowed: ${v}`, email.safeReturnTo(v) === v, email.safeReturnTo(v));

console.log('\n-- the marker lands where email.js already looks for it --');
ok('appended to a bare path as a query', email.withMarker('/', 'emailConnected=gmail') === '/?emailConnected=gmail', email.withMarker('/', 'emailConnected=gmail'));
ok('appended INSIDE the hash when there is one',
  email.withMarker('/#deal-scan', 'emailConnected=gmail') === '/#deal-scan?emailConnected=gmail',
  email.withMarker('/#deal-scan', 'emailConnected=gmail'));
ok('respects an existing hash query',
  email.withMarker('/#a?b=1', 'emailConnected=gmail') === '/#a?b=1&emailConnected=gmail',
  email.withMarker('/#a?b=1', 'emailConnected=gmail'));
ok('respects an existing path query',
  email.withMarker('/x?y=1', 'emailConnected=gmail') === '/x?y=1&emailConnected=gmail',
  email.withMarker('/x?y=1', 'emailConnected=gmail'));

console.log('\n-- the round trip is validated on the way BACK, not only on the way out --');
const cb = ROUTE_SRC.slice(ROUTE_SRC.indexOf("router.get('/oauth/gmail/callback'"), ROUTE_SRC.indexOf('// ── Outlook OAuth'));
ok('the callback re-runs safeReturnTo on the decoded state',
  /const back = safeReturnTo\(decodedState\.returnTo\)/.test(cb), null);
ok('the success redirect uses it', /res\.redirect\(back \?/.test(cb), null);
ok('the error redirect uses it too', /backErr\s*\?/.test(cb), null);
ok('and still falls back to settings when it is not safe', /'\/#settings\?emailConnected=gmail'/.test(cb), null);

// ── The From slot, rendered for real ────────────────────────────────────────
console.log('\n-- the From slot: three states, three different things --');
const helpers = {
  escHtml: (str) => (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
};
const slotSrc = OE.slice(OE.indexOf('const FROM_SELECT_CSS'), OE.indexOf('// ── The notice, shown BEFORE'));
const { renderFromSlotConnect, renderFromSlotError } =
  new Function('escHtml', 'updateMailboxNotice', 'fetch', 'document',
    slotSrc + '; return { renderFromSlotConnect, renderFromSlotError };')(
    helpers.escHtml, () => {}, () => {}, { getElementById: () => null });

const slotA = { innerHTML: '' }; renderFromSlotConnect(slotA);
ok('zero accounts renders a real BUTTON, not an option', /<button/.test(slotA.innerHTML) && !/<option/.test(slotA.innerHTML), slotA.innerHTML.slice(0, 80));
ok('it says Connect Gmail', /Connect Gmail/.test(slotA.innerHTML));
ok('it calls connectGmail', /window\.outreachEngine\.connectGmail\(\)/.test(slotA.innerHTML));
ok('and it promises the draft survives', /draft is saved/i.test(slotA.innerHTML));
// COMMENTS STRIPPED: the comment explaining the old behaviour quotes the phrase, and
// a documentation string must not be able to fail a code assertion. Scoped to
// outreach-engine too: the Email tab has its own legitimate "No email accounts
// connected yet." empty state, which is a paragraph in a settings list, not an
// unselectable option in a send dropdown, and is not what was broken.
const OE_CODE = OE.replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
ok('the unselectable option is gone from the outreach send panel',
  !/No email accounts connected/.test(OE_CODE), 'still present');

const slotB = { innerHTML: '' }; renderFromSlotError(slotB, 'Error 500');
ok('a failed request renders the ERROR, not a dropdown', /Error 500/.test(slotB.innerHTML) && !/<select/.test(slotB.innerHTML), slotB.innerHTML.slice(0, 120));
ok('with a Retry', /Retry/.test(slotB.innerHTML) && /reloadAccounts/.test(slotB.innerHTML));
ok('and never leaves "Loading accounts" on screen', !/Loading accounts/.test(slotB.innerHTML));

const slotC = { innerHTML: '' }; renderFromSlotError(slotC, '<img src=x onerror=alert(1)>');
ok('the error message is escaped', !/<img/.test(slotC.innerHTML), slotC.innerHTML.slice(0, 160));

console.log('\n-- the loader routes every outcome, including a thrown fetch --');
const loader = OE.slice(OE.indexOf('async function loadEmailAccountsIntoDropdown'), OE.indexOf('function renderFromSlotConnect'));
ok('non-OK response renders the error state', /if \(!r\.ok\)[\s\S]{0,160}renderFromSlotError/.test(loader), null);
ok('a THROWN fetch renders it too, not silence', /catch \(e\) \{[\s\S]{0,300}renderFromSlotError/.test(loader), null);
ok('the old silent early return is gone', !/if \(!r\.ok\) return;/.test(loader), null);
ok('the old blanket silent catch is gone', !/catch \(e\) \{ \/\* silent \*\/ \}/.test(OE), null);
ok('zero accounts routes to the connect button', /!accounts\.length[\s\S]{0,120}renderFromSlotConnect/.test(loader), null);
ok('an unexpected non-array body is treated as zero, not crashed on',
  /!Array\.isArray\(accounts\)/.test(loader), null);
ok('the account options are escaped', /escHtml\(a\.email_address\)/.test(loader), null);

// ── The notice ──────────────────────────────────────────────────────────────
console.log('\n-- the notice appears BEFORE the draft, and knows three answers --');
const noticeSrc = OE.slice(OE.indexOf('function updateMailboxNotice'), OE.indexOf('// ── Connect, and come back'));
let el = { style: {}, innerHTML: '' };
const updateMailboxNotice = new Function('document', noticeSrc + '; return updateMailboxNotice;')(
  { getElementById: (id) => (id === 'outreach-mailbox-notice' ? el : null) });

updateMailboxNotice(false);
ok('no mailbox: shown, red, and offers to connect',
  el.style.display === 'block' && /#f87171/.test(el.innerHTML) && /connectGmail/.test(el.innerHTML), el.style.display);
ok('and it promises the draft survives', /not lose it/i.test(el.innerHTML));
updateMailboxNotice(true);
ok('has a mailbox: nothing shown', el.style.display === 'none' && el.innerHTML === '', el.innerHTML);
updateMailboxNotice(null);
ok('UNKNOWN is its own state, amber, and never claims they have no mailbox',
  el.style.display === 'block' && /#fbbf24/.test(el.innerHTML) && !/No mailbox connected/.test(el.innerHTML), el.innerHTML.slice(0, 140));

ok('the notice element sits ABOVE the body, so a body rewrite cannot wipe it',
  OE.indexOf('id="outreach-mailbox-notice"') < OE.indexOf('id="outreach-modal-body"'), null);
ok('the check runs when the modal OPENS, not at send time',
  /setModalState\('loading', dealResult\.brand\);[\s\S]{0,220}checkMailboxForNotice\(\)/.test(OE), null);
// RUN IT, do not measure the distance between two strings. This asserted that
// 'outreach-mailbox-notice' appeared within 400 characters of
// closeOutreachModal; the clearing code is there and correct, but it sits 438
// characters in, so the suite reported a bug that did not exist. A proximity
// regex fails the moment a line is added above it, which is exactly what
// happened. The rest of this file lifts and executes -- so does this now.
const closeSrc = OE.slice(OE.indexOf('function closeOutreachModal'),
  OE.indexOf('function buildModal'));
const noticeEl = { style: { display: 'block' }, innerHTML: '<b>No mailbox connected</b>' };
const modalEl = { style: { display: 'flex' } };
const State = { pollInterval: 7, activeRunId: 'r1', currentOutreachId: 'o1',
  appliedContactKey: 'k1', currentRunData: { brand: 'X' } };
new Function('document', 'OutreachEngineState', 'clearInterval',
  closeSrc + '; closeOutreachModal();')(
  { getElementById: (id) => (id === 'outreach-mailbox-notice' ? noticeEl
    : id === 'outreach-engine-modal' ? modalEl : null) },
  State, () => {});
ok('closing the modal clears the notice',
  noticeEl.style.display === 'none' && noticeEl.innerHTML === '', noticeEl);
ok('  and a reopen cannot show the last brand\'s stale answer',
  State.currentRunData === null && State.currentOutreachId === null, State);
ok('  the poll is stopped too, not left running behind a hidden modal',
  State.pollInterval === null, State.pollInterval);

// ── The return trip ─────────────────────────────────────────────────────────
console.log('\n-- connect saves first, then leaves --');
const connectSrc = OE.slice(OE.indexOf('async function connectGmail'), OE.indexOf('async function resumeOutreachAfterConnect'));
ok('the draft is PATCHed before navigating', connectSrc.indexOf("outreachAPI.patch('/logs/'") < connectSrc.indexOf('window.location.href'), null);
ok('a failed save ABORTS the navigation rather than losing the edits',
  /catch \(e\) \{[\s\S]{0,200}did not leave the page[\s\S]{0,80}return;/.test(connectSrc), null);
ok('returnTo carries the current location', /returnTo=' \+ encodeURIComponent\(returnTo\)/.test(connectSrc), null);
ok('and it is encoded', /encodeURIComponent/.test(connectSrc), null);
ok('sessionStorage failure does not block the connect (private mode)',
  /catch \(e\) \{ \/\* private mode/.test(connectSrc), null);

console.log('\n-- resume reopens the same draft, from the server --');
const resumeSrc = OE.slice(OE.indexOf('async function resumeOutreachAfterConnect'), OE.indexOf('// ── Helpers'));
ok('the marker is cleared BEFORE use, so a failure cannot loop',
  resumeSrc.indexOf('removeItem') < resumeSrc.indexOf('JSON.parse(raw)'), null);
ok('the draft is re-read from the run, not reconstructed from the browser',
  /outreachAPI\.get\('\/runs\/' \+ saved\.runId\)/.test(resumeSrc), null);
ok('a stale marker is ignored', /OUTREACH_RESUME_TTL_MS/.test(resumeSrc), null);
ok('the deal result is restored, so the post-send brand retire still works',
  /currentDealResult = saved\.dealResult/.test(resumeSrc), null);
ok('the To box is restored but never overwrites a fresh value',
  /if \(to && !to\.value\) to\.value = saved\.toEmail/.test(resumeSrc), null);
ok('a failed reopen says so instead of showing an empty modal',
  /setModalState\('error', 'Could not reopen your draft/.test(resumeSrc), null);
ok('resume is wired to run on load', /DOMContentLoaded', resumeOutreachAfterConnect/.test(OE), null);

console.log('\n-- send no longer asks for something impossible --');
const sendSrc = OE.slice(OE.indexOf('async function sendOutreach'), OE.indexOf('async function saveDraft'));
ok('a missing select is told apart from an empty one', /if \(!sel\) \{/.test(sendSrc), null);
ok('and points at Connect Gmail when that is what is on screen', /Connect Gmail first/.test(sendSrc), null);
ok('and at Retry when the load failed', /Retry above the Send button/.test(sendSrc), null);
ok('"Select a From account" now only fires when there IS something to select',
  sendSrc.indexOf('if (!sel)') < sendSrc.indexOf("'Select a From account'"), null);

console.log('\nfailures: ' + f);
process.exit(f ? 1 : 0);
