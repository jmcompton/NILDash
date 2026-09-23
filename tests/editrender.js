'use strict';
// ── THE ONE TEST THAT OPENS A BROWSER ───────────────────────────────────────
//
// Editable card emails shipped, then the two-table Home rewrite replaced the
// card renderer, and the question "does an agent still have a subject box and a
// body box" had no test that could answer it. The suite that covers editing --
// editsend -- passes 33/33 with the renderer drawing nothing at all, because
// every one of its assertions is a direct function call: editDraft, buildHome's
// PAYLOAD, approveBatch, releaseDue. None of them is a page.
//
// So this one is a page. It loads the shipping public/index.html, lifts the real
// hqRender() and its handlers into real Chromium, clicks what an agent clicks,
// and intercepts fetch to see exactly what a save would send.
//
// WHAT IT PROTECTS, in the order the agent meets it:
//   - one line per pitch, collapsed by default, about 68px, with Approve and
//     Skip at the same x on every row and a chevron saying the row opens.
//   - no Mark done, and no "Email checked / MX record found" line.
//   - a click anywhere on the row opens it in place; a second click closes it;
//     only one row is open at a time; Approve and Skip never open it.
//   - each button calls the endpoint its channel always used.
//   - Edit opens the row on its way to the fields, prefilled from what is
//     stored; saving PATCHes with the BARE draft id and TEXT, never markup;
//     cancel restores rather than keeping the typing.
//
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const Home = require(ROOT + 'server/services/homeQueue.js');

const out = [];
const check = (n, c, d) => { out.push({ n, ok: !!c }); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d !== undefined ? '   ' + d : '')); };

const AG = 'er-agent', ATH = 'er-ath';

(async () => {
  await new Promise((r) => setTimeout(r, 6000));
  const P = store.pool;
  for (const t of ['outreach_logs', 'outreach_queue']) {
    await P.query(`DELETE FROM ${t} WHERE agent_id=$1`, [AG]).catch(() => {});
  }
  await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'J','er@x.com','x','agent')`, [AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
    [ATH, AG, JSON.stringify({ name: 'Amber Bretton', school: 'Alabama', dob: '2004-06-01' })]);
  await P.query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email)
     VALUES ('er-1',$1,$2,'Trak Shak','A partnership idea',
             '<p>Hi Jeff,</p><p>THE MODEL SENTENCE.</p>','draft','jeff@trakshak.com')`, [AG, ATH]);
  // A DM card too, so the page under test is the mixed queue and not an
  // email-only page that happens to work.
  await P.query(
    `INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,why,dm_text,instagram)
     VALUES ($1,$2,1,'name:hoover cycles','Hoover Cycles','dm','queued','Two miles from campus.','Hi — quick idea.','hoovercycles')`,
    [AG, ATH]);

  const payload = await Home.buildHome(P, AG, { athleteId: ATH });
  const mailIdx = payload.cards.findIndex((c) => c.channel === 'email');
  check('the payload has an email card', mailIdx !== -1,
    JSON.stringify(payload.cards.map((c) => c.channel)));
  check('  carrying the subject', payload.cards[mailIdx].subject === 'A partnership idea');
  check('  and the body as editable text', /THE MODEL SENTENCE/.test(payload.cards[mailIdx].bodyText || ''));

  // The REAL renderer and the REAL handlers, lifted from the shipping page,
  // with the page's REAL stylesheets -- the row height and the button column
  // are layout, and layout needs the CSS.
  const H = fs.readFileSync(ROOT + 'public/index.html', 'utf8');
  const cut = (a, b) => H.slice(H.indexOf(a), H.indexOf(b));
  // hqRender INCLUDED. The page does not call hqRenderCard directly -- it calls
  // hqRender(), which builds the tabs, the sub-line, the rows and the approve
  // bar and then assigns innerHTML in one go.
  const js = cut('function hqEscape(s)', 'async function hqLoad(athleteId)')
    + cut('function hqRender()', 'async function hqApprove()');
  const css = (H.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('\n');

  // THE DIAGNOSTIC LINE IS ON THE PAYLOAD AND MUST NOT REACH THE PAGE.
  payload.cards[mailIdx].emailNote = 'Email checked: jeff@trakshak.com (the domain accepts mail (MX record found))';

  const page = `<!doctype html><meta charset="utf-8">${css}
<div style="width:900px"><div id="home-tabs"></div><div id="home-panel"></div></div>
<div id="home-bar" hidden><button id="home-approve"></button><span id="home-cap"></span></div>
<script>
var API_BASE = '';
var LOG = [];
// Intercept rather than stub the handlers: whatever a click decides to send is
// what an agent's click would send.
window.fetch = function (url, opts) {
  LOG.push({ url: String(url), method: (opts && opts.method) || 'GET', body: (opts && opts.body) || null });
  return Promise.resolve({ ok: true, json: function () {
    return Promise.resolve({ subject: 'EDITED SUBJECT', body_html: '<p>EDITED BODY.</p>',
      edited_before_approval: true, scheduled: 1 });
  } });
};
function showToast() {}
// The send path and the reload are not what this page tests; stubbed so a
// click that ends in a reload does not throw.
function hqApprove() {}
var RELOADS = 0;
function hqLoad() { RELOADS++; }
window.onerror = function (m) { document.title = 'ERROR: ' + m; };
${js}
var HQ = { data: ${JSON.stringify(payload)}, selected: ${JSON.stringify(ATH)}, busy: false, openId: null };
hqRender();
var i = ${mailIdx};
var dmIdx = HQ.data.cards.findIndex(function (c) { return c.channel === 'dm'; });
var rows = function () { return Array.prototype.slice.call(document.querySelectorAll('.hq-cards .hq-row')); };
var openRows = function () { return rows().filter(function (r) { return !r.querySelector('.hq-x').hidden; }).length; };
var rowOf = function (k) { return rows()[k]; };
var R = {};

// 0. COLLAPSED, EVERY ROW
R.rowCount = rows().length;
R.openOnLoad = openRows();
R.heights = rows().map(function (r) { return Math.round(r.querySelector('.hq-rowhead').getBoundingClientRect().height); });
R.everyRowHasApproveAndSkip = rows().every(function (r) {
  var b = r.querySelectorAll('.hq-rowbtns button');
  return b.length === 2 && b[0].textContent === 'Approve' && b[1].textContent === 'Skip';
});
R.approveRights = rows().map(function (r) { return Math.round(r.querySelectorAll('.hq-rowbtns button')[0].getBoundingClientRect().right); });
R.approveLefts = rows().map(function (r) { return Math.round(r.querySelectorAll('.hq-rowbtns button')[0].getBoundingClientRect().left); });
R.badges = rows().map(function (r) { return r.querySelector('.hq-chan').textContent; });
R.biz = rows().map(function (r) { return r.querySelector('.hq-rowbiz').textContent; });
R.chevrons = rows().every(function (r) { return !!r.querySelector('.hq-rowhead .hq-chev'); });
R.markDone = /Mark done/.test(document.getElementById('home-panel').innerHTML);
R.mxLine = /MX record|Email checked/.test(document.getElementById('home-panel').innerHTML);
R.barKept = !document.getElementById('home-bar').hidden && /Approve 1 email/.test(document.getElementById('home-approve').textContent);
R.textHiddenWhenShut = !!document.getElementById('hq-esubj-' + i).closest('[hidden]');

// 1. CLICKING ANYWHERE ON THE ROW OPENS IT, IN PLACE
rowOf(i).querySelector('.hq-rowbiz').click();
R.clickOpens = !rowOf(i).querySelector('.hq-x').hidden && openRows() === 1;
R.ariaOpen = rowOf(i).querySelector('.hq-rowtoggle').getAttribute('aria-expanded');
R.fullTextShown = /THE MODEL SENTENCE/.test(rowOf(i).querySelector('.hq-x').textContent)
  && !document.getElementById('hq-read-' + i).closest('[hidden]');
R.editInOpenRow = Array.prototype.some.call(rowOf(i).querySelectorAll('.hq-x button'), function (b) { return b.textContent === 'Edit'; });
// clicking the padding of the row head, not the toggle, counts too
rowOf(i).querySelector('.hq-rowhead').click();
R.clickAgainCloses = rowOf(i).querySelector('.hq-x').hidden && openRows() === 0;
R.ariaShut = rowOf(i).querySelector('.hq-rowtoggle').getAttribute('aria-expanded');

// 2. ONLY ONE ROW OPEN AT A TIME
rowOf(i).querySelector('.hq-rowhead').click();
rowOf(dmIdx).querySelector('.hq-rowhead').click();
R.oneAtATime = openRows() === 1 && !rowOf(dmIdx).querySelector('.hq-x').hidden && rowOf(i).querySelector('.hq-x').hidden;
R.dmHasCopy = /Copy DM &amp; open Instagram/.test(rowOf(dmIdx).querySelector('.hq-x').innerHTML);
R.dmHasEdit = Array.prototype.some.call(rowOf(dmIdx).querySelectorAll('.hq-x button'), function (b) { return b.textContent === 'Edit'; });
R.dmTextShown = /Hi — quick idea\./.test(document.getElementById('hq-dmread-' + dmIdx).textContent);
hqEdit(dmIdx);
R.dmEditShowsBox = !document.getElementById('hq-dm-' + dmIdx).hidden && document.getElementById('hq-dmread-' + dmIdx).hidden;
rowOf(dmIdx).querySelector('.hq-rowhead').click();
R.dmClosed = openRows() === 0;

// 3. THE BUTTONS ACT, AND DO NOT OPEN THE ROW
LOG = [];
rowOf(dmIdx).querySelectorAll('.hq-rowbtns button')[0].click();   // Approve, DM
R.approveDidNotOpen = openRows() === 0;
rowOf(dmIdx).querySelectorAll('.hq-rowbtns button')[1].click();   // Skip, DM
rowOf(i).querySelectorAll('.hq-rowbtns button')[0].click();       // Approve, email
rowOf(i).querySelectorAll('.hq-rowbtns button')[1].click();       // Skip, email
R.skipDidNotOpen = openRows() === 0;

setTimeout(function () {
  R.actionFetches = LOG.slice();
  R.reloads = RELOADS;
  // 4. EDIT, from a shut row: the row opens on its way to the fields
  LOG = [];
  hqEdit(i);
  R.editFromShut_rowOpened = !rowOf(i).querySelector('.hq-x').hidden;
  R.editFromShut_fieldsVisible = !document.getElementById('hq-esubj-' + i).closest('[hidden]');
  R.editFromShut_ariaHonest = rowOf(i).querySelector('.hq-rowtoggle').getAttribute('aria-expanded');
  R.afterEdit_readHidden = document.getElementById('hq-read-' + i).hidden === true;
  var si = document.getElementById('hq-esubj-' + i);
  var ta = document.getElementById('hq-ebody-' + i);
  R.subjectPrefilled = si ? si.value : null;
  R.bodyPrefilled = ta ? ta.value : null;
  if (si) si.value = 'THE AGENT SUBJECT';
  if (ta) ta.value = 'Hi Jeff,\\n\\nTHE AGENT SENTENCE.';
  hqSaveEdit(i, null);
  setTimeout(function () {
    R.saveFetches = LOG.slice();
    // the save re-renders; the same pitch stays open
    R.stillOpenAfterSave = !rowOf(i).querySelector('.hq-x').hidden && openRows() === 1;
    hqEdit(i);
    var ta2 = document.getElementById('hq-ebody-' + i);
    if (ta2) ta2.value = 'DISCARD ME';
    hqCancelEdit(i);
    R.afterCancel = document.getElementById('hq-ebody-' + i).value;
    document.title = JSON.stringify(R);
  }, 60);
}, 60);
<\/script>`;
  const tmp = path.join(require('os').tmpdir(), 'nildash-editrender.html');
  fs.writeFileSync(tmp, page);
  const dom = execFileSync(CHROMIUM,
    ['--headless', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=4000', '--window-size=1100,900',
      '--dump-dom', '--allow-file-access-from-files', 'file://' + tmp],
    { encoding: 'utf8', maxBuffer: 4e7, stdio: ['ignore', 'pipe', 'ignore'] });
  const m = dom.match(/<title>([\s\S]*?)<\/title>/);
  let R = null;
  try {
    R = m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")) : null;
  } catch (_) { R = null; }
  check('the page ran', !!R, m && m[1].slice(0, 160));
  if (!R) { console.log('\n0/1 passed'); process.exit(1); }

  console.log('\n0. ONE LINE PER PITCH, COLLAPSED BY DEFAULT');
  check('two rows drew', R.rowCount === 2, R.rowCount);
  check('EVERY ROW STARTS COLLAPSED', R.openOnLoad === 0, R.openOnLoad);
  check('  a collapsed row is about 68px tall', R.heights.every((h) => h >= 64 && h <= 76), JSON.stringify(R.heights));
  check('every row has Approve then Skip', R.everyRowHasApproveAndSkip === true);
  check('  IN THE SAME POSITION ON EVERY ROW', new Set(R.approveRights).size === 1 && new Set(R.approveLefts).size === 1,
    JSON.stringify({ right: R.approveRights, left: R.approveLefts }));
  check('the badge says EMAIL or DM', JSON.stringify(R.badges.slice().sort()) === '["DM","Email"]', JSON.stringify(R.badges));
  check('  and the row names the business', R.biz.indexOf('Trak Shak') !== -1 && R.biz.indexOf('Hoover Cycles') !== -1, JSON.stringify(R.biz));
  check('a chevron on every row says it opens', R.chevrons === true);
  check('NO Mark done button anywhere', R.markDone === false);
  check('NO "Email checked / MX record" line, although the payload carries it', R.mxLine === false);
  check('the approve-all bar is still there', R.barKept === true);
  check('the pitch is not on screen while the row is shut', R.textHiddenWhenShut === true);

  console.log('\n1. A CLICK ON THE ROW OPENS IT IN PLACE; ANOTHER CLOSES IT');
  check('clicking the row opens it', R.clickOpens === true);
  check('  the toggle says so', R.ariaOpen === 'true', R.ariaOpen);
  check('  showing the full pitch', R.fullTextShown === true);
  check('  with Edit', R.editInOpenRow === true);
  check('clicking again collapses it', R.clickAgainCloses === true);
  check('  and the toggle says that too', R.ariaShut === 'false', R.ariaShut);

  console.log('\n2. ONE ROW OPEN AT A TIME');
  check('opening a second row closes the first', R.oneAtATime === true);
  check('an open DM row has Copy DM & open Instagram', R.dmHasCopy === true);
  check('  and Edit', R.dmHasEdit === true);
  check('  and shows the DM text', R.dmTextShown === true);
  check('  Edit puts the DM in its box, which is what Copy DM copies', R.dmEditShowsBox === true);
  check('  and the row collapses on a second click', R.dmClosed === true);

  console.log('\n3. APPROVE AND SKIP CALL THE ENDPOINTS THEY ALWAYS DID');
  const A = R.actionFetches || [];
  const has = (fn) => A.some(fn);
  check('pressing Approve or Skip does not open the row', R.approveDidNotOpen === true && R.skipDidNotOpen === true);
  check('DM Approve records it as sent by DM (what Mark done posted)',
    has((f) => f.method === 'POST' && /\/api\/agent\/outreach-queue\/\d+\/sent$/.test(f.url) && JSON.parse(f.body).via === 'dm'),
    JSON.stringify(A));
  check('DM Skip is the queue skip', has((f) => f.method === 'POST' && /\/api\/agent\/outreach-queue\/\d+\/skip$/.test(f.url)));
  check('email Approve is the same approve call as the bar, for this one id',
    has((f) => f.method === 'POST' && f.url === '/api/agent/closer/approve'
      && JSON.stringify(JSON.parse(f.body).ids) === '["email:er-1"]'));
  check('email Skip is the closer skip, with the BARE draft id',
    has((f) => f.method === 'PATCH' && /\/api\/agent\/closer\/draft\/er-1$/.test(f.url) && JSON.parse(f.body).skip === true));
  check('each action reloads the queue', R.reloads === 4, R.reloads);

  console.log('\n4. EDITING AN EMAIL');
  check('Edit from a shut row opens the row', R.editFromShut_rowOpened === true);
  check('  and the fields are actually visible', R.editFromShut_fieldsVisible === true);
  check('  and the toggle agrees it is open', R.editFromShut_ariaHonest === 'true', R.editFromShut_ariaHonest);
  check('  the read view gives way to the fields', R.afterEdit_readHidden === true);
  check('  the subject is prefilled with what is stored', R.subjectPrefilled === 'A partnership idea', R.subjectPrefilled);
  check('  the body is prefilled with the draft', /THE MODEL SENTENCE/.test(R.bodyPrefilled || ''), R.bodyPrefilled);
  const patch = (R.saveFetches || []).find((f) => f.method === 'PATCH');
  check('saving PATCHes the outreach_logs route with the BARE draft id',
    /\/api\/outreach\/logs\/er-1$/.test((patch || {}).url || ''), (patch || {}).url);
  const body = patch && patch.body ? JSON.parse(patch.body) : {};
  check('  carrying the typed subject', body.subject === 'THE AGENT SUBJECT', body.subject);
  check('  and the typed body as TEXT, never markup',
    /THE AGENT SENTENCE/.test(body.body_text || '') && !/[<>]/.test(body.body_text || ''), body.body_text);
  check('the same pitch is still open after the save re-renders', R.stillOpenAfterSave === true);
  check('cancelling restores the stored text rather than keeping the typing',
    /EDITED BODY/.test(R.afterCancel || '') || /THE MODEL SENTENCE/.test(R.afterCancel || ''), R.afterCancel);

  const failed = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - failed.length) + '/' + out.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
