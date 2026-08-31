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
// THE ENDPOINTS AND THE PAGE, not just the services. The batch UI is the whole
// interaction, so the assertions are on the real handler output and the real
// markup rather than on what the service returns in isolation.
const fs = require('fs');
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const Closer = require(ROOT + 'server/services/closer.js');
const G = require(ROOT + 'server/services/sendGuard.js');
const shiftReport = require(ROOT + 'server/services/shiftReport.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'cr-agent';
const SRC = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
const HTML = fs.readFileSync(ROOT + 'public/index.html', 'utf8');

// Lift a route handler out of index.js and run it for real.
function handlerFor(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  const end = SRC.indexOf(endMarker, start);
  if (start < 0 || end < 0) return null;
  const body = SRC.slice(SRC.indexOf('{', SRC.indexOf('async (req, res)', start)), end);
  return new Function('store', 'Closer', 'req', 'res',
    'return (async (req,res)=>' + body.slice(0, body.lastIndexOf('}') + 1) + ')(req,res);');
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await G.ensureTable(P);
  const clean = async () => {
    await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM agent_send_budget WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM agent_auto_mode WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM email_suppression WHERE email LIKE '%@cr.example'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'A','cr@x.com','x','agent','America/Chicago')`, [AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('cr-a0',$1,$2::jsonb)`,
    [AG, JSON.stringify({ name: 'Client Zero', school: 'Auburn University' })]);
  for (let i = 0; i < 4; i++) {
    await P.query(
      `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,touch_no)
       VALUES ($1,$2,'cr-a0',$3,'Hi','<p>x</p>','draft',$4,1)`,
      ['cr-l' + i, AG, 'Brand ' + i, `x${i}@cr.example`]);
  }

  // ── THE BATCH ENDPOINT ───────────────────────────────────────────────────
  const batchH = handlerFor("app.get('/api/agent/closer/batch'", "app.post('/api/agent/closer/approve'");
  ok('the batch endpoint exists', !!batchH);
  let got = null;
  const res = { json: (v) => { got = v; return res; }, status: () => res };
  await batchH(store, Closer, { session: { userId: AG } }, res);
  ok('  it returns tonight\'s batch', got && got.batch && got.batch.length === 4, got && got.batch && got.batch.length);
  ok('  with the ceiling alongside it', got.budget && got.budget.cap === 40, got.budget);

  // ── THE APPROVE ENDPOINT ─────────────────────────────────────────────────
  // The end marker is the NEXT route, whatever it is. A new endpoint was added
  // between approve and auto-mode, and slicing to auto-mode swallowed it whole --
  // the lifted "handler" then never called res.json and the suite threw on null.
  const apprH = handlerFor("app.post('/api/agent/closer/approve'", "\n// PATCH /api/agent/closer/draft/:id");
  ok('the approve endpoint exists', !!apprH);
  const ids = got.batch.map((b) => b.id);
  let out = null;
  const res2 = { json: (v) => { out = v; return res2; }, status: () => res2 };
  await apprH(store, Closer, { session: { userId: AG }, body: { ids, skip: [ids[0]] } }, res2);
  ok('  approving schedules the batch minus what was unchecked',
    out.scheduled === 3 && out.skipped === 1, out);

  // NO PER-MESSAGE SEND ENDPOINT was added for the Closer path.
  ok('THERE IS NO PER-MESSAGE CLOSER SEND ROUTE',
    SRC.indexOf("/api/agent/closer/send") === -1, 'a per-message send route exists');
  ok('  and approve takes no send time from the client',
    !/closer\/approve[\s\S]{0,900}req\.body\.(scheduledSendAt|sendAt|when)/.test(SRC), null);

  // ── AUTO MODE REFUSES A GLOBAL SCOPE AT THE ROUTE ────────────────────────
  // The end marker is whatever route comes NEXT in index.js. It was "// The
  // detail page behind"; the compliance endpoints now sit between, and slicing
  // past them swallowed three handlers into this one. Same breakage as when the
  // draft PATCH route was added -- a lifted slice has to end at the real
  // boundary, not at a landmark that used to be adjacent.
  const autoH = handlerFor("app.post('/api/agent/closer/auto-mode'", "\n// \u2500\u2500 COMPLIANCE");
  ok('the auto-mode endpoint exists', !!autoH);
  let autoOut = null, code = 200;
  const res3 = { json: (v) => { autoOut = v; return res3; }, status: (c) => { code = c; return res3; } };
  await autoH(store, Closer, { session: { userId: AG },
    body: { scopeKind: 'global', scopeId: 'all', enabled: true } }, res3);
  ok('  a global scope is rejected with 400', code === 400, { code, autoOut });
  ok('  saying it is per athlete or per lane', /per athlete or per lane/.test(autoOut.error), autoOut);

  // ── THE SHIFT REPORT CARRIES THE CLOSER BLOCK ────────────────────────────
  const rep = await shiftReport.buildShiftReport(P, AG);
  ok('the shift report includes the closer block', !!rep.closer, Object.keys(rep));
  ok('  with the ceiling stated in words', /of 40 emails used today/.test(rep.closer.line), rep.closer.line);
  ok('  the count waiting on one decision', rep.closer.pendingApproval === 1, rep.closer.pendingApproval);
  ok('  and how many are scheduled', rep.closer.scheduled === 3, rep.closer.scheduled);
  ok('  plus the auto-mode progress', !!rep.closer.auto, rep.closer.auto);

  // A BLOCKED AGENT SAYS SO ON THE PAGE.
  await G.blockForDay(P, AG, 'the mail provider refused on quota');
  const rep2 = await shiftReport.buildShiftReport(P, AG);
  ok('a stopped agent is stated, not silently empty',
    /Sending is stopped for today/.test(rep2.closer.line), rep2.closer.line);
  ok('  naming the reason', /quota/.test(rep2.closer.line), rep2.closer.line);

  // ── THE PAGE ─────────────────────────────────────────────────────────────
  // THE MOUNT POINT MOVED, DELIBERATELY. #sr-closer was the ready-to-send list
  // on the old Home; Home is now athlete tabs, cards and one approve, and the
  // cards ARE the queue -- printing both gave the page two counts of one pile.
  // The assertion follows the structure rather than pinning the old one.
  ok('the page has a mount point for the cards', /id="home-panel"/.test(HTML));
  ok('  and one approve button', /id="home-approve"/.test(HTML));
  ok('  the approve posts the batch, scoped to one athlete',
    /closer\/approve[\s\S]{0,500}athleteId: d\.selected/.test(HTML), null);
  ok('  and Home no longer carries the old ready-to-send list', !/id="sr-closer"/.test(HTML));
  ok('  there is ONE approve button, not one per row',
    (HTML.match(/onclick="srApprove\(\)"/g) || []).length === 1,
    (HTML.match(/onclick="srApprove\(\)"/g) || []).length);
  ok('  the page never offers a send time',
    !/id="sr-send-time"|name="scheduledSendAt"/.test(HTML), null);
  ok('  it says who decides the timing instead',
    /You do not pick the time/.test(HTML), null);
  ok('  the cap message says DMs and calls are unaffected',
    /not affected by this/.test(HTML), null);
  ok('  auto mode is shown as progress toward an offer',
    /approved without an edit/.test(HTML), null);
  ok('  and never as a global switch',
    !/auto mode for (all|every)/i.test(HTML), null);

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
