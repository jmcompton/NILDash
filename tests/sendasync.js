'use strict';
// Runs against the local test Postgres and a real server process. No real
// mail: the server runs with NILDASH_TEST_FAKE_SEND (providers/fakeSend), a
// provider that takes 20 seconds and refuses any address containing "bounce".
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/sendasync.js      just this one
//
// ── THE BUTTON ANSWERS AT ONCE; THE EMAIL GOES BEHIND IT ──────────────────
// An agent gave up on a send that went out nine minutes later: the request
// waited for the mail provider. The definition of done, as a test:
//   a send that takes 20 seconds still answers the button in under a second
//   a card shows Sending, then Sent, without a refresh
//   a double click sends once
//   a send that fails says so on the card, with the reason
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.BUSINESS_MAILING_ADDRESS = process.env.BUSINESS_MAILING_ADDRESS || '1 Main St, Auburn, AL 36830';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const store = require(REPO + 'server/store.js');
const emailStore = require(REPO + 'server/services/emailStore.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const AG = 'sa-agent', ATH = 'sa-ath', PASS = 'sa-pass-123456';
const DELAY_MS = 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { return new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); }); }

async function main() {
  await sleep(TEST_INIT_WAIT_MS);
  const P = store.pool;
  const clean = async () => {
    for (const t of ['outreach_logs', 'outreach_queue', 'agent_send_budget', 'compliance_holds', 'email_sends', 'pitch_actions', 'send_request_timings']) {
      await P.query(`DELETE FROM ${t} WHERE agent_id = $1`, [AG]).catch(() => {});
    }
    await P.query(`DELETE FROM brand_evidence_cache WHERE brand_key LIKE 'sa:%'`).catch(() => {});
    await P.query(`DELETE FROM email_accounts WHERE user_id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz,plan_tier,subscription_status)
                 VALUES ($1,'Sam Agent','sa@sa.test',$2,'agent','America/Chicago','unlimited','active')`, [AG, await bcrypt.hash(PASS, 8)]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,'{"name":"Tess Court","school":"Auburn University","sport":"Tennis","dob":"2003-01-01"}')`, [ATH, AG]);
  await emailStore.saveEmailAccount('sa-mbox', AG, 'gmail', 'sam@sa.test', 'Sam Agent', 'tok', 'refresh', new Date(Date.now() + 3600e3), null, true);

  let n = 0;
  const draft = async (email) => {
    const id = 'sa-' + (++n);
    const brand = 'Court Shop ' + n;
    await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,brand_key,subject,body_html,status,sent_to_email,touch_no)
                   VALUES ($1,$2,$3,$4,$5,$6,'<p>Hi Dana, a short note.</p>','draft',$7,1)`,
      [id, AG, ATH, brand, brand.toLowerCase(), 'Tess and ' + brand, email]);
    await P.query(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at)
                   VALUES ($1,'places',$2,$3::jsonb,'OK',NOW()) ON CONFLICT (brand_key, lane) DO NOTHING`,
      ['sa:' + n, brand, JSON.stringify({ found: true, types: ['sporting_goods_store'], primaryType: 'sporting_goods_store', name: brand })]);
    await P.query(`INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,outreach_log_id,contact_name)
                   VALUES ($1,$2,$3,$4,$5,'email','queued',$6,'Dana Kessler')`, [AG, ATH, n, 'sa card ' + n, brand, id]);
    return { id, brand, email };
  };
  const editorOk = await draft('owner1@sa1.test');
  const editorBad = await draft('bounce@sa2.test');
  const homeOk = await draft('owner3@sa3.test');
  const homeBad = await draft('bounce@sa4.test');

  // ── 0. TWO APPROVES OF ONE DRAFT AT THE SAME MOMENT ──────────────────────
  // Two tabs, or a click and its retry. Each ran SELECT-then-UPDATE and the
  // UPDATE matched on id alone, so both "approved" it -- and the later one
  // cleared the release queue's claim on an email it could be sending.
  OUT.push('-- two approves of one draft at once --');
  const Closer = require(REPO + 'server/services/closer.js');
  const race = await draft('owner0@sa0.test');
  const both = await Promise.all([1, 2, 3].map(() => Closer.approveBatch(P, AG, { ids: ['email:' + race.id], athleteId: ATH })));
  ok('three approves at once schedule it once', both.reduce((x, b) => x + b.scheduled, 0) === 1, both.map((b) => b.scheduled));
  await P.query(`UPDATE outreach_logs SET send_claimed_at = NOW() WHERE id = $1`, [race.id]);
  const late = await Closer.approveBatch(P, AG, { ids: ['email:' + race.id], athleteId: ATH });
  const claim = (await P.query(`SELECT send_claimed_at FROM outreach_logs WHERE id = $1`, [race.id])).rows[0];
  ok('  a late approve while the queue is sending it leaves the claim alone', late.scheduled === 0 && !!claim.send_claimed_at, { late, claim });
  await P.query(`DELETE FROM outreach_logs WHERE id = $1`, [race.id]);
  await P.query(`DELETE FROM outreach_queue WHERE outreach_log_id = $1`, [race.id]);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const sendLog = _tp.join(os.tmpdir(), `sa-sends-${process.pid}.log`);
  try { fs.unlinkSync(sendLog); } catch (_) {}
  const sendsTo = (addr) => { try { return fs.readFileSync(sendLog, 'utf8').split('\n').filter((l) => l.includes(addr)).length; } catch (_) { return 0; } };
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'sa-secret', RESEND_API_KEY: 're_test_dummy',
      CYPRESS_SEED_ON_BOOT: 'off', NILDASH_TEST_FAKE_SEND: JSON.stringify({ delayMs: DELAY_MS, failTo: 'bounce', logFile: sendLog,
        failMessage: 'Mailbox unavailable: the recipient server refused the message (550)' }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', (d) => { srvLog += d; }); srv.stderr.on('data', (d) => { srvLog += d; });
  let browser = null;
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/'); break; } catch (_) { await sleep(1000); } }
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'sa@sa.test', password: PASS }) });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    ok('the agent signs in', login.ok && !!cookie, login.status);
    const call = async (method, path, body) => {
      const t0 = Date.now();
      const r = await fetch(base + path, { method, headers: Object.assign({ Cookie: cookie }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, body: j, ms: Date.now() - t0 };
    };
    const statusOf = (id) => call('GET', `/api/outreach/logs/${id}/send-status`);
    const waitFor = async (id, states, maxMs) => {
      const t0 = Date.now();
      for (;;) { const s = await statusOf(id); if (states.includes(s.body.state) || Date.now() - t0 > maxMs) return s; await sleep(1000); }
    };

    // ── 1. THE EDITOR'S SEND ───────────────────────────────────────────────
    OUT.push('', '-- the outreach editor\'s Send, with a provider that takes 20 seconds --');
    const body = (d) => ({ emailAccountId: 'sa-mbox', toEmail: d.email });
    const s1 = await call('POST', `/api/outreach/logs/${editorOk.id}/send`, body(editorOk));
    ok('Send answers in under a second although the provider takes 20', s1.ms < 1000 && s1.status === 202 && s1.body.state === 'sending', { ms: s1.ms, status: s1.status, body: s1.body });
    // The impatient agent: two more clicks while it is going.
    const again = await Promise.all([call('POST', `/api/outreach/logs/${editorOk.id}/send`, body(editorOk)), call('POST', `/api/outreach/logs/${editorOk.id}/send`, body(editorOk))]);
    ok('  a second and third click are answered "already sending", not a second send and not an error',
      again.every((a) => a.status === 200 && a.body.already && a.body.state === 'sending' && a.ms < 1000), again.map((a) => [a.status, a.body, a.ms]));
    ok('  the status says sending while it goes', (await statusOf(editorOk.id)).body.state === 'sending');
    const bad1 = await call('POST', `/api/outreach/logs/${editorBad.id}/send`, body(editorBad));
    ok('  a send that will fail also answers at once', bad1.ms < 1000 && bad1.status === 202, { ms: bad1.ms, status: bad1.status });

    // ── 2. HOME, IN A BROWSER ──────────────────────────────────────────────
    OUT.push('', '-- Home: Approve, in a browser --');
    let chromium = null;
    try { chromium = require('playwright').chromium; } catch (_) {
      chromium = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright').chromium;
    }
    browser = await chromium.launch({ executablePath: CHROMIUM });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
    const [cn, cv] = cookie.split('=');
    await ctx.addCookies([{ name: cn, value: decodeURIComponent(cv), url: base }]);
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    let approvePosts = 0;
    page.on('request', (r) => { if (/\/api\/agent\/closer\/approve$/.test(r.url()) && r.method() === 'POST') approvePosts++; });
    await page.route('**/*', (r) => (new URL(r.request().url()).host !== `127.0.0.1:${port}` ? r.fulfill({ status: 204, body: '' }) : r.continue()));
    await page.goto(base + '/');
    await page.waitForTimeout(2500);
    await page.evaluate(() => { if (typeof showView === 'function') showView('home'); });
    await page.waitForFunction(() => document.querySelectorAll('#home-panel .hq-row .hm-btn.primary').length >= 2, null, { timeout: 20000 }).catch(() => {});
    const rowBtn = (brand) => page.locator('#home-panel .hq-row', { hasText: brand }).locator('.hm-btn.primary', { hasText: /Approve|Sending/ }).first();
    ok('Home shows both email cards with Approve', await rowBtn(homeOk.brand).count() === 1 && await rowBtn(homeBad.brand).count() === 1,
      await page.evaluate(() => (document.getElementById('home-panel') || {}).innerText || '').catch(() => null));

    // A double click on Approve.
    const tClick = Date.now();
    await rowBtn(homeOk.brand).dblclick();
    const sawSending = await page.waitForFunction((b) => {
      const rows = Array.from(document.querySelectorAll('#home-panel .hq-row')).filter((r) => r.innerText.includes(b));
      return rows.some((r) => /Sending/.test(r.innerText));
    }, homeOk.brand, { timeout: 1000 }).then(() => true).catch(() => false);
    ok('the row says Sending within a second of the click', sawSending && Date.now() - tClick < 1500, Date.now() - tClick);
    await page.waitForTimeout(800);
    ok('  a double click posts one approve', approvePosts === 1, approvePosts);
    await rowBtn(homeBad.brand).click();

    // Nothing reloads the page from here on: the card has to turn over by itself.
    const navs = []; page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push(f.url()); });
    const outState = (brand) => page.evaluate((b) => {
      const r = Array.from(document.querySelectorAll('#home-panel .hq-out')).find((x) => x.innerText.includes(b));
      return r ? r.innerText.replace(/\s+/g, ' ') : null;
    }, brand);
    await page.waitForTimeout(3000);
    const mid = await outState(homeOk.brand);
    ok('  then an Approved row reading Sending…', /Sending/.test(mid || '') && !/Sent \d/.test(mid || ''), mid);
    // The fake provider takes 20s, the queue spaces one mailbox's sends 20-50s.
    let fin = null;
    for (let i = 0; i < 120; i++) { fin = await outState(homeOk.brand); if (/Sent \d/.test(fin || '')) break; await sleep(1000); }
    ok('  and Sent, with the time, without a refresh', /Sent \d/.test(fin || '') && navs.length === 0, { fin, navs });
    let failRow = null;
    for (let i = 0; i < 120; i++) { failRow = await outState(homeBad.brand); if (/Send failed/.test(failRow || '')) break; await sleep(1000); }
    ok('a send that fails after the button returned says so on the card, with the reason', /Send failed/.test(failRow || '') && /refused/.test(failRow || ''), failRow);
    ok('  no script error on Home', !errs.length, errs);

    // ── 3. THE OUTCOMES ────────────────────────────────────────────────────
    OUT.push('', '-- what actually went out --');
    const eOk = await waitFor(editorOk.id, ['sent', 'failed'], 30000);
    ok('the editor send finished as sent', eOk.body.state === 'sent' && eOk.body.to === editorOk.email, eOk.body);
    const eBad = await waitFor(editorBad.id, ['sent', 'failed'], 30000);
    ok('  the failing one as failed, with the provider\'s reason in a sentence', eBad.body.state === 'failed' && /refused/.test(eBad.body.error || ''), eBad.body);
    const after = await call('POST', `/api/outreach/logs/${editorOk.id}/send`, body(editorOk));
    ok('  Send on a sent draft answers "sent", it does not send again', after.status === 200 && after.body.state === 'sent', after.body);
    ok('EACH BUSINESS GOT EXACTLY ONE EMAIL: three clicks in the editor, a double click on Home',
      sendsTo(editorOk.email) === 1 && sendsTo(homeOk.email) === 1, { editor: sendsTo(editorOk.email), home: sendsTo(homeOk.email) });
    ok('  and the failing ones none', sendsTo(editorBad.email) === 0 && sendsTo(homeBad.email) === 0);
    const tm = (await P.query(`SELECT route, ms, status FROM send_request_timings WHERE agent_id = $1 ORDER BY at`, [AG])).rows;
    ok('every Send and Approve request is timed in send_request_timings, all under a second',
      tm.filter((r) => r.route === 'outreach/send').length >= 5 && tm.some((r) => r.route === 'closer/approve') && tm.every((r) => r.ms < 1000), tm);
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill('SIGTERM');
    if (F) OUT.push('', '--- server log (tail) ---', srvLog.split('\n').filter((l) => /error|fail|closer|send/i.test(l)).slice(-25).join('\n'));
    try { fs.unlinkSync(sendLog); } catch (_) {}
  }
  await clean();
  OUT.push('', 'failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}

main().catch(async (e) => { OUT.push('FAIL threw: ' + (e && e.stack)); console.log(OUT.join('\n')); process.exit(1); });
