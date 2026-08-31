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
//   - Edit is at CARD level, a sibling of the disclosure, not nested inside the
//     panel it opens. That nesting is what made a working feature read as
//     read-only next to a DM card whose box is always visible.
//   - the email panel still starts SHUT. Four expanded bodies is not a queue.
//   - one click from a shut card puts the fields on screen, with the disclosure
//     button's aria-expanded and label telling the truth about it.
//   - the fields are prefilled from what is stored.
//   - saving PATCHes the outreach_logs route with the BARE draft id -- ids are
//     namespaced now ("email:<id>") and posting the namespaced one 404s.
//   - the body goes as TEXT, never markup.
//   - cancel restores rather than keeping the typing.
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

  // The REAL renderer and the REAL handlers, lifted from the shipping page.
  const H = fs.readFileSync(ROOT + 'public/index.html', 'utf8');
  const cut = (a, b) => H.slice(H.indexOf(a), H.indexOf(b));
  // hqRender INCLUDED. The page does not call hqRenderCard directly -- it calls
  // hqRender(), which builds the tabs, the sub-line, the card list and the
  // approve bar and then assigns innerHTML in one go. Testing the card function
  // alone would skip whatever hqRender does around it.
  const js = cut('function hqEscape(s)', 'async function hqLoad(athleteId)')
    + cut('function hqRender()', 'function hqPeek(btn)')
    + cut('function hqPeek(btn)', 'async function hqApprove()');

  const page = `<!doctype html><meta charset="utf-8">
<div id="home-tabs"></div><div id="home-panel"></div>
<div id="home-bar" hidden><button id="home-approve"></button><span id="home-cap"></span></div>
<script>
var API_BASE = '';
var LOG = [];
// Intercept rather than stub the handler: whatever hqSaveEdit decides to send is
// what an agent's click would send.
window.fetch = function (url, opts) {
  LOG.push({ url: String(url), method: (opts && opts.method) || 'GET', body: (opts && opts.body) || null });
  return Promise.resolve({ ok: true, json: function () {
    return Promise.resolve({ subject: 'EDITED SUBJECT', body_html: '<p>EDITED BODY.</p>',
      edited_before_approval: true });
  } });
};
function showToast() {}
// hqRender ends by wiring the approve bar to hqApprove. Not lifted (it is the
// send path, not the edit path), so it is stubbed -- without it hqRender throws
// on the assignment and nothing renders at all.
function hqApprove() {}
window.onerror = function (m) { document.title = 'ERROR: ' + m; };
${js}
var HQ = { data: ${JSON.stringify(payload)}, selected: ${JSON.stringify(ATH)}, busy: false };
// THE REAL ENTRY POINT the page uses after a load.
hqRender();
var i = ${mailIdx};
var R = {};

// 0. WHAT AN AGENT SEES AT A GLANCE, before clicking anything. This is the
//    comparison that matters on a mixed page: a DM card's box is right there,
//    an email card's editing is behind a disclosure.
var dmIdx = HQ.data.cards.findIndex(function (c) { return c.channel === 'dm'; });
R.dmBoxVisibleImmediately = dmIdx !== -1 && !!document.getElementById('hq-dm-' + dmIdx)
  && !document.getElementById('hq-dm-' + dmIdx).closest('[hidden]');
R.emailFieldsBehindDisclosure = !!document.getElementById('hq-esubj-' + i)
  && !!document.getElementById('hq-esubj-' + i).closest('[hidden]');
R.peekBtnPresent = !!document.querySelector('.hq-card.email .hq-peek');
// EDIT IS AT CARD LEVEL: a sibling of the disclosure, not inside the panel it
// opens. Asserted structurally so nesting it again fails here.
var actions = document.querySelector('.hq-card.email .hq-cardactions');
R.editAtCardLevel = !!(actions && actions.querySelector('.hq-editbtn'));
R.editNotInsidePanel = !!document.querySelector('.hq-card.email .hq-editbtn')
  && !document.querySelector('.hq-card.email .hq-editbtn').closest('.hq-mail');
R.editVisibleWithoutOpening = R.editAtCardLevel
  && !actions.querySelector('.hq-editbtn').closest('[hidden]');
R.mailPanelStartsShut = document.getElementById('hq-mail-' + i).hidden === true;
// Every email card starts collapsed -- four open bodies would bury the queue.
R.openPanelsOnLoad = document.querySelectorAll('.hq-mail:not([hidden])').length;

// 0b. the disclosure itself, clicked the way the button does
var peek = document.querySelector('.hq-card.email .hq-peek');
if (peek) hqPeek(peek);
R.afterPeek_mailShown = document.getElementById('hq-mail-' + i).hidden === false;
R.afterPeek_label = peek ? peek.querySelector('.lbl').textContent : null;

// 1. what an agent sees before touching anything
R.editBtnPresent = !!document.querySelector('#hq-read-' + i + ' .hq-editbtn');
R.editPanelHidden = document.getElementById('hq-edit-' + i).hidden === true;
R.readPanelVisible = document.getElementById('hq-read-' + i).hidden === false;

// 1b. EDIT FROM A SHUT CARD. The button is outside the panel now, so this is
//     the path that matters: a fresh page, one click, fields on screen.
hqPeek(peek);                       // shut it again after the 0b probe
R.reShut = document.getElementById('hq-mail-' + i).hidden === true;
hqEdit(i);
R.editFromShut_panelOpened = document.getElementById('hq-mail-' + i).hidden === false;
R.editFromShut_fieldsVisible = !!document.getElementById('hq-esubj-' + i)
  && !document.getElementById('hq-esubj-' + i).closest('[hidden]');
R.editFromShut_peekLabel = peek ? peek.querySelector('.lbl').textContent : null;
R.editFromShut_ariaHonest = peek ? peek.getAttribute('aria-expanded') : null;

// 2. click Edit, exactly as the button does
hqEdit(i);
R.afterEdit_editShown = document.getElementById('hq-edit-' + i).hidden === false;
R.afterEdit_readHidden = document.getElementById('hq-read-' + i).hidden === true;
var si = document.getElementById('hq-esubj-' + i);
var ta = document.getElementById('hq-ebody-' + i);
R.subjectFieldExists = !!si;
R.bodyFieldExists = !!ta;
R.subjectPrefilled = si ? si.value : null;
R.bodyPrefilled = ta ? ta.value : null;

// 3. type, and save
if (si) si.value = 'THE AGENT SUBJECT';
if (ta) ta.value = 'Hi Jeff,\\n\\nTHE AGENT SENTENCE.';
hqSaveEdit(i, null);

setTimeout(function () {
  R.fetches = LOG;
  // 4. cancel restores, rather than leaving a half-typed draft in the box
  hqEdit(i);
  var ta2 = document.getElementById('hq-ebody-' + i);
  if (ta2) ta2.value = 'DISCARD ME';
  hqCancelEdit(i);
  R.afterCancel = document.getElementById('hq-ebody-' + i).value;
  document.title = JSON.stringify(R);
}, 60);
<\/script>`;
  const tmp = path.join(require('os').tmpdir(), 'nildash-editrender.html');
  fs.writeFileSync(tmp, page);
  const dom = execFileSync(CHROMIUM,
    ['--headless', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=4000',
      '--dump-dom', '--allow-file-access-from-files', 'file://' + tmp],
    { encoding: 'utf8', maxBuffer: 4e7, stdio: ['ignore', 'pipe', 'ignore'] });
  const m = dom.match(/<title>([\s\S]*?)<\/title>/);
  const R = m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")) : null;
  check('the page ran', !!R, m && m[1].slice(0, 120));
  if (!R) { console.log('\n0/1 passed'); process.exit(1); }

  console.log('\n0. WHAT THE TWO CARD TYPES LOOK LIKE SIDE BY SIDE');
  check('a DM card\'s message box is visible immediately',
    R.dmBoxVisibleImmediately === true, R.dmBoxVisibleImmediately);
  check('an EMAIL card\'s fields are behind a disclosure',
    R.emailFieldsBehindDisclosure === true, R.emailFieldsBehindDisclosure);
  check('  the disclosure button is there', R.peekBtnPresent === true);
  check('  and clicking it opens the panel', R.afterPeek_mailShown === true);
  check('  relabelling itself', /Hide the email/.test(R.afterPeek_label || ''), R.afterPeek_label);

  console.log('\n1. THE EDIT AFFORDANCE IS ON THE CARD, NOT INSIDE THE DISCLOSURE');
  check('Edit sits beside Read the email at card level', R.editAtCardLevel === true);
  check('  it is NOT nested inside the panel it opens', R.editNotInsidePanel === true);
  check('  so it is visible without opening anything', R.editVisibleWithoutOpening === true);
  check('the panel still starts SHUT', R.mailPanelStartsShut === true);
  check('  and no email body is expanded on load', R.openPanelsOnLoad === 0, R.openPanelsOnLoad);
  check('  the read panel is what shows first', R.readPanelVisible === true);
  check('  and the edit panel starts hidden', R.editPanelHidden === true);

  console.log('\n1b. ONE CLICK FROM A SHUT CARD PUTS THE FIELDS ON SCREEN');
  check('the card was shut again', R.reShut === true);
  check('Edit opens the panel on its way in', R.editFromShut_panelOpened === true);
  check('  and the fields are actually visible, not revealed inside a hidden box',
    R.editFromShut_fieldsVisible === true);
  check('  the disclosure button agrees it is open', R.editFromShut_ariaHonest === 'true',
    R.editFromShut_ariaHonest);
  check('  and relabels itself', /Hide the email/.test(R.editFromShut_peekLabel || ''),
    R.editFromShut_peekLabel);

  console.log('\n2. CLICKING EDIT OPENS THE FIELDS');
  check('the edit panel opens', R.afterEdit_editShown === true);
  check('  and the read panel closes', R.afterEdit_readHidden === true);
  check('the SUBJECT field exists', R.subjectFieldExists === true);
  check('the BODY field exists', R.bodyFieldExists === true);
  check('  the subject is prefilled with what is stored',
    R.subjectPrefilled === 'A partnership idea', R.subjectPrefilled);
  check('  the body is prefilled with the draft',
    /THE MODEL SENTENCE/.test(R.bodyPrefilled || ''), R.bodyPrefilled);

  console.log('\n3. SAVING SENDS THE EDIT TO THE RIGHT PLACE');
  const patch = (R.fetches || []).find((f) => f.method === 'PATCH');
  check('a PATCH was issued', !!patch, JSON.stringify(R.fetches));
  check('  to the outreach_logs route', /\/api\/outreach\/logs\//.test((patch || {}).url || ''),
    (patch || {}).url);
  check('  with the BARE draft id, not the namespaced one',
    /\/api\/outreach\/logs\/er-1$/.test((patch || {}).url || ''), (patch || {}).url);
  const body = patch && patch.body ? JSON.parse(patch.body) : {};
  check('  carrying the typed subject', body.subject === 'THE AGENT SUBJECT', body.subject);
  check('  and the typed body as TEXT, never markup',
    /THE AGENT SENTENCE/.test(body.body_text || '') && !/[<>]/.test(body.body_text || ''),
    body.body_text);

  console.log('\n4. CANCEL PUTS IT BACK');
  check('cancelling restores the stored text rather than keeping the typing',
    /EDITED BODY/.test(R.afterCancel || '') || /THE MODEL SENTENCE/.test(R.afterCancel || ''),
    R.afterCancel);

  const failed = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - failed.length) + '/' + out.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
