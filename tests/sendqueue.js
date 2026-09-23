'use strict';
// Runs against the local test Postgres. No network: the provider is a recorder.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/sendqueue.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.BUSINESS_MAILING_ADDRESS = process.env.BUSINESS_MAILING_ADDRESS || '1 Main St, Auburn, AL 36830';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── APPROVE MEANS SEND ──────────────────────────────────────────────────────
// There was a Tuesday-to-Thursday send window and a release switch
// (CLOSER_RELEASE_ENABLED) that production never set, so 41 approved emails
// sat unsent for days with nothing on screen to say so. Both are gone: an
// approved email is due at once and the release queue sends each agent's
// emails one at a time, 20 to 50 seconds apart. Held ones say why. A card
// says Sending until its email has a sent_at.
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const Closer = require(REPO + 'server/services/closer.js');
const Job = require(REPO + 'server/jobs/closerRelease.js');
const Home = require(REPO + 'server/services/homeQueue.js');
const MB = require(REPO + 'server/services/myBrands.js');
const G = require(REPO + 'server/services/sendGuard.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const A = 'sq-agent-a', B = 'sq-agent-b', ATH_A = 'sq-ath-a', ATH_B = 'sq-ath-b';
const P = () => store.pool;

function recorder() {
  const sent = [];
  return { sent, fn: async (log) => { sent.push({ id: log.id, agent: log.agent_id }); return { providerMessageId: 'm' + sent.length }; } };
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  await G.ensureTable(P());
  const clean = async () => {
    for (const t of ['outreach_logs', 'outreach_queue', 'agent_send_budget', 'compliance_holds', 'email_sends']) {
      await P().query(`DELETE FROM ${t} WHERE agent_id = ANY($1)`, [[A, B]]).catch(() => {});
    }
    await P().query(`DELETE FROM brand_evidence_cache WHERE brand_key LIKE 'sq:%'`).catch(() => {});
    await P().query('DELETE FROM athletes WHERE agent_id = ANY($1)', [[A, B]]).catch(() => {});
    await P().query('DELETE FROM users WHERE id = ANY($1)', [[A, B]]).catch(() => {});
    Job._nextAt.clear();
  };
  await clean();
  await P().query(`INSERT INTO users (id,name,email,password,role,report_tz) VALUES
    ($1,'Kay Reed','sq-a@x.com','x','agent','America/Chicago'),($2,'Lee Park','sq-b@x.com','x','agent','America/Chicago')`, [A, B]);
  await P().query(`INSERT INTO athletes (id,agent_id,data) VALUES
    ($1,$2,'{"name":"Amari Allen","school":"Alabama","sport":"Football","dob":"2003-01-01"}'),
    ($3,$4,'{"name":"Jo Doe","school":"Auburn University","sport":"Basketball","dob":"2002-05-05"}')`, [ATH_A, A, ATH_B, B]);

  let n = 0;
  // An approvable draft (and its card), for an ordinary shop Places knows.
  const draft = async (agent, opts = {}) => {
    const id = 'sq-' + (++n);
    const brand = (opts.brand || 'Shop') + ' ' + n;
    await P().query(
      `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,brand_key,subject,body_html,status,sent_to_email,touch_no)
       VALUES ($1,$2,$3,$4,$5,$6,'<p>Hi Dana, a short note.</p>','draft',$7,1)`,
      [id, agent, agent === A ? ATH_A : ATH_B, brand, brand.toLowerCase(), opts.subject || ('A note ' + n), opts.email || `owner${n}@sq${n}.example`]);
    await P().query(
      `INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at)
       VALUES ($1,'places',$2,$3::jsonb,'OK',NOW()) ON CONFLICT (brand_key, lane) DO NOTHING`,
      ['sq:' + n, brand, JSON.stringify({ found: true, types: ['clothing_store'], primaryType: 'clothing_store', name: brand })]);
    await P().query(
      `INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,outreach_log_id,contact_name)
       VALUES ($1,$2,$3,$4,$5,'email','queued',$6,'Dana Kessler')`,
      [agent, agent === A ? ATH_A : ATH_B, n, 'sq card ' + n, brand, id]);
    return id;
  };

  // ── 1. THE SWITCH AND THE WINDOW ARE GONE ─────────────────────────────────
  OUT.push('-- no switch, no window --');
  const srv = ['server/index.js', 'server/jobs/closerRelease.js', 'server/services/closer.js']
    .map((f) => stripComments(read(f))).join('\n');
  ok('CLOSER_RELEASE_ENABLED is read nowhere', !/CLOSER_RELEASE_ENABLED/.test(srv));
  ok('the send window module is deleted', !fs.existsSync(REPO + 'server/services/sendWindow.js'));
  ok('  and nothing requires it', !/require\([^)]*sendWindow/.test(srv + stripComments(read('server/routes/outreach.js'))));
  ok('the server starts the release queue unconditionally', /require\('\.\/jobs\/closerRelease'\)\.start\(\);/.test(read('server/index.js')));
  ok('  and wakes it after every approval', (read('server/index.js').match(/if \(out\.scheduled\) kickRelease\(\);/g) || []).length === 3);

  // ── 2. APPROVE: DUE NOW, AND THE CARD SAYS SENDING ────────────────────────
  OUT.push('', '-- approval --');
  const a1 = await draft(A);
  const before = Date.now();
  const ap = await Closer.approveBatch(P(), A, { ids: ['email:' + a1] });
  ok('approving schedules it', ap.scheduled === 1, ap);
  const row = (await P().query('SELECT status, scheduled_send_at FROM outreach_logs WHERE id=$1', [a1])).rows[0];
  ok('  DUE NOW: not a Tuesday slot', row.status === 'approved' && new Date(row.scheduled_send_at).getTime() <= Date.now()
    && new Date(row.scheduled_send_at).getTime() >= before - 5000, row);
  const card = (await P().query('SELECT state, sent_at FROM outreach_queue WHERE outreach_log_id=$1', [a1])).rows[0];
  ok('THE CARD SAYS SENDING, not Sent', card.state === 'sending' && card.sent_at === null, card);
  let home = await Home.buildHome(P(), A, { athleteId: ATH_A });
  let ob = (home.outbox || []).find((o) => o.id === 'email:' + a1);
  ok('  Home shows it as a Sending row', ob && ob.status === 'sending' && !ob.sentAt, home.outbox);
  let mb = MB.buildRows(await MB.loadRaw(P(), A));
  ok('  and My Brands says sending, not pitched', (mb.find((r) => /Shop 1/.test(r.brand)) || {}).status === 'sending', mb.map((r) => r.status));

  // ── 3. IT SENDS, AND ONLY THEN SAYS SENT ──────────────────────────────────
  OUT.push('', '-- the queue sends it --');
  const rec = recorder();
  const t0 = new Date();
  let out = await Job.runOnce({ send: rec.fn, now: t0, rnd: () => 0.5, sleep: async () => {} });
  ok('one tick sends it', out.sent === 1 && rec.sent.length === 1 && rec.sent[0].id === a1, out);
  const sentRow = (await P().query('SELECT status, sent_at, send_hold_reason FROM outreach_logs WHERE id=$1', [a1])).rows[0];
  ok('  it has a sent_at', sentRow.status === 'sent' && !!sentRow.sent_at, sentRow);
  const card2 = (await P().query('SELECT state, sent_at FROM outreach_queue WHERE outreach_log_id=$1', [a1])).rows[0];
  ok('  and the card now says Sent', card2.state === 'sent' && !!card2.sent_at, card2);
  home = await Home.buildHome(P(), A, { athleteId: ATH_A });
  ob = (home.outbox || []).find((o) => o.id === 'email:' + a1);
  ok('  Home shows Sent with the time', ob && ob.status === 'sent' && !!ob.sentAt, ob);
  mb = MB.buildRows(await MB.loadRaw(P(), A));
  ok('  and My Brands says pitched', (mb.find((r) => /Shop 1/.test(r.brand)) || {}).status === 'pitched');

  // ── 4. ONE MAILBOX NEVER BURSTS ──────────────────────────────────────────
  OUT.push('', '-- pacing --');
  Job._nextAt.clear();
  const aIds = [], bIds = [];
  for (let i = 0; i < 4; i++) aIds.push(await draft(A));
  for (let i = 0; i < 2; i++) bIds.push(await draft(B));
  await Closer.approveBatch(P(), A, { ids: aIds.map((x) => 'email:' + x) });
  await Closer.approveBatch(P(), B, { ids: bIds.map((x) => 'email:' + x) });
  const rec2 = recorder();
  // A MINUTE AHEAD. Agent A sent for real a moment ago (section 3), and the
  // queue's restart floor -- last_send_at plus the minimum gap, read from the
  // database -- rightly holds A until that has passed.
  const T = Date.now() + 60000;
  out = await Job.runOnce({ send: rec2.fn, now: new Date(T), rnd: () => 0.5, sleep: async () => {} });
  ok('A BULK APPROVE DOES NOT FIRE AT ONCE: one per agent per tick', out.sent === 2
    && rec2.sent.filter((s) => s.agent === A).length === 1 && rec2.sent.filter((s) => s.agent === B).length === 1, rec2.sent);
  out = await Job.runOnce({ send: rec2.fn, now: new Date(T + 5000), rnd: () => 0.5, sleep: async () => {} });
  ok('  five seconds later, nothing: the gap has not passed', out.sent === 0 && out.waiting >= 3, out);
  const gap = Job._nextAt.get(A) - T;
  ok('  the gap is inside 20 to 50 seconds', gap >= Job.MIN_GAP_MS && gap <= Job.MAX_GAP_MS, gap);
  out = await Job.runOnce({ send: rec2.fn, now: new Date(T + gap + 1), rnd: () => 0.5, sleep: async () => {} });
  ok('  once it has, the next one from each goes', out.sent === 2 && rec2.sent.length === 4, rec2.sent.length);
  ok('  in approval order', rec2.sent.filter((s) => s.agent === A).map((s) => s.id).join() === aIds.slice(0, 2).join());
  // Drain the rest.
  let clock = T + gap + 1;
  for (let i = 0; i < 6; i++) { clock += Job.MAX_GAP_MS + 1; await Job.runOnce({ send: rec2.fn, now: new Date(clock), rnd: () => 0.5, sleep: async () => {} }); }
  ok('  everything approved goes, none twice', rec2.sent.length === 6 && new Set(rec2.sent.map((s) => s.id)).size === 6, rec2.sent.length);

  // ── 5. 150 APPROVED: AN HOUR OR TWO, NOT A SECOND, AND NOT A DAY ──────────
  OUT.push('', '-- a bulk approve of 150 --');
  Job._nextAt.clear();
  const big = [];
  for (let i = 0; i < 150; i++) big.push(await draft(A, { brand: 'Bulk' }));
  await Closer.approveBatch(P(), A, { ids: big.map((x) => 'email:' + x), overflowOk: true });
  // approveBatch caps a batch; approve in chunks until all 150 are approved.
  for (let k = 0; k < 10; k++) {
    const left = (await P().query(`SELECT id FROM outreach_logs WHERE id = ANY($1) AND status = 'draft'`, [big])).rows.map((r) => 'email:' + r.id);
    if (!left.length) break;
    await Closer.approveBatch(P(), A, { ids: left });
  }
  const approvedN = (await P().query(`SELECT COUNT(*)::int AS n FROM outreach_logs WHERE id = ANY($1) AND status = 'approved'`, [big])).rows[0].n;
  ok('all 150 approved', approvedN === 150, approvedN);
  const rec3 = recorder();
  const start = Date.now() + 10 * 60 * 1000;
  let now3 = start, first = null, last = null;
  for (let tick = 0; tick < 400 && rec3.sent.length < 150; tick++) {
    const before3 = rec3.sent.length;
    await Job.runOnce({ send: rec3.fn, now: new Date(now3), sleep: async () => {} });
    if (rec3.sent.length > before3) { if (first === null) first = now3; last = now3; }
    // Jump the clock to this agent's next turn, the way the 5-second tick would reach it.
    now3 = Math.max(now3 + Job.TICK_MS, Job._nextAt.get(A) || 0);
  }
  const minutes = (last - first) / 60000;
  ok('ALL 150 SEND', rec3.sent.length === 150, rec3.sent.length);
  ok(`  spread over an hour or two (${minutes.toFixed(0)} minutes), never a burst and never a day`,
    minutes >= 50 && minutes <= 130, minutes);
  ok('  the first went at once', first === start);
  const capNow = (await G.status(P(), A)).cap;
  ok('  and the daily ceiling did not stop them (it is Google\'s 500, not 40)', capNow >= 150 && G.DEFAULT_DAILY_CAP === 500, capNow);

  // ── 6. HELD SAYS WHY, AND IS NOT RE-EXAMINED EVERY TICK ───────────────────
  OUT.push('', '-- holds --');
  Job._nextAt.clear();
  // The 4-day rule: the address had an email a day ago.
  const four = await draft(B, { email: 'repeat@sq.example', subject: 'Second note' });
  const T6 = Date.now() + 5 * 3600 * 1000;
  await require(REPO + 'server/services/sendRules.js').record(P(),
    { email: 'repeat@sq.example', subject: 'First note', system: 'closer', agentId: B, refId: 'x', now: new Date(T6 - 86400000) });
  await Closer.approveBatch(P(), B, { ids: ['email:' + four] });
  // A provider that fails.
  const fail = await draft(A, { brand: 'Failing' });
  await Closer.approveBatch(P(), A, { ids: ['email:' + fail] });
  const failing = async () => { const e = new Error('Service unavailable'); e.code = 503; throw e; };
  await Job.runOnce({ send: failing, now: new Date(T6), sleep: async () => {}, rnd: () => 0.5 });
  const h4 = (await P().query('SELECT send_hold_reason, scheduled_send_at, status FROM outreach_logs WHERE id=$1', [four])).rows[0];
  ok('THE 4-DAY RULE HOLDS IT, and says so on the row', h4.status === 'approved' && /nothing else for 4 days/.test(h4.send_hold_reason || ''), h4);
  ok('  not looked at again until the four days are up', new Date(h4.scheduled_send_at).getTime() > T6 + 2 * 86400000, h4.scheduled_send_at);
  const hf = (await P().query('SELECT send_hold_reason, scheduled_send_at, send_failures, status FROM outreach_logs WHERE id=$1', [fail])).rows[0];
  ok('A FAILED SEND says so on the row and backs off', hf.status === 'approved' && /send failed/.test(hf.send_hold_reason || '')
    && hf.send_failures === 1 && new Date(hf.scheduled_send_at).getTime() > T6, hf);
  home = await Home.buildHome(P(), A, { athleteId: ATH_A });
  ob = (home.outbox || []).find((o) => o.id === 'email:' + fail);
  ok('  and Home shows it as Sending, held, with that reason', ob && ob.status === 'sending' && /send failed/.test(ob.holdReason || ''), ob);

  // ── 7. ONE SENDER PER EMAIL ───────────────────────────────────────────────
  OUT.push('', '-- the claim --');
  Job._nextAt.clear();
  const cl = await draft(A, { brand: 'Claimed' });
  await Closer.approveBatch(P(), A, { ids: ['email:' + cl] });
  await P().query('UPDATE outreach_logs SET send_claimed_at = NOW() WHERE id=$1', [cl]);
  const rec7 = recorder();
  const T7 = Date.now() + 6 * 3600 * 1000;
  await Job.runOnce({ send: rec7.fn, now: new Date(T7), sleep: async () => {} });
  ok('an email another server has claimed is not sent twice', !rec7.sent.some((s) => s.id === cl), rec7.sent);
  await P().query(`UPDATE outreach_logs SET send_claimed_at = NOW() - INTERVAL '20 minutes' WHERE id=$1`, [cl]);
  Job._nextAt.clear();
  await Job.runOnce({ send: rec7.fn, now: new Date(T7 + 60000), sleep: async () => {} });
  ok('  but a claim left by a crash goes stale and it is sent', rec7.sent.some((s) => s.id === cl), rec7.sent);

  // ── 8. NO SILENT STOP: THE CAN-SPAM ADDRESS ───────────────────────────────
  OUT.push('', '-- the one thing that still stops every send --');
  Job._nextAt.clear();
  const cs = await draft(A, { brand: 'Canspam' });
  await Closer.approveBatch(P(), A, { ids: ['email:' + cs] });
  const addr = process.env.BUSINESS_MAILING_ADDRESS;
  delete process.env.BUSINESS_MAILING_ADDRESS;
  const rec8 = recorder();
  const T8 = Date.now() + 7 * 3600 * 1000;
  const o8 = await Job.runOnce({ send: rec8.fn, now: new Date(T8), sleep: async () => {} });
  const h8 = (await P().query('SELECT send_hold_reason FROM outreach_logs WHERE id=$1', [cs])).rows[0];
  ok('without the postal address nothing sends', rec8.sent.length === 0 && !!o8.blocked, o8);
  ok('  AND EVERY WAITING EMAIL SAYS WHY, on its card', /BUSINESS_MAILING_ADDRESS is not set/.test(h8.send_hold_reason || ''), h8);
  process.env.BUSINESS_MAILING_ADDRESS = addr;
  Job._nextAt.clear();
  await Job.runOnce({ send: rec8.fn, now: new Date(T8 + 60000), sleep: async () => {} });
  const h8b = (await P().query('SELECT status, send_hold_reason FROM outreach_logs WHERE id=$1', [cs])).rows[0];
  ok('  set it again and they go, the reason cleared', h8b.status === 'sent' && h8b.send_hold_reason === null, h8b);

  // ── 9. THE 41 ALREADY APPROVED AND WAITING ────────────────────────────────
  OUT.push('', '-- releasing what the window was holding --');
  const stuck = [];
  for (let i = 0; i < 3; i++) stuck.push(await draft(B, { brand: 'Stuck' }));
  // Approved the old way: a Tuesday slot days away, and the card marked sent at approval.
  await P().query(`UPDATE outreach_logs SET status='approved', approved_at=NOW() - INTERVAL '5 days',
                     scheduled_send_at = NOW() + INTERVAL '3 days' WHERE id = ANY($1)`, [stuck]);
  await P().query(`UPDATE outreach_queue SET state='sent', sent_at=NOW(), sent_via='email' WHERE outreach_log_id = ANY($1)`, [stuck]);
  const rel = await store.releaseApprovedBacklog(P());
  ok('the backlog is made due now', rel.madeDue >= 3, rel);
  const due = (await P().query(`SELECT COUNT(*)::int AS n FROM outreach_logs WHERE id = ANY($1) AND scheduled_send_at <= NOW()`, [stuck])).rows[0].n;
  ok('  all of them', due === 3, due);
  const back = (await P().query(`SELECT state FROM outreach_queue WHERE outreach_log_id = ANY($1)`, [stuck])).rows;
  ok('  and their cards go back to Sending until the email leaves', back.every((r) => r.state === 'sending'), back);
  const held = await draft(B, { brand: 'HeldStuck' });
  await P().query(`UPDATE outreach_logs SET status='approved', approved_at=NOW(), scheduled_send_at=NOW() + INTERVAL '2 days',
                     send_hold_reason='compliance: a hold' WHERE id=$1`, [held]);
  await store.releaseApprovedBacklog(P());
  const heldRow = (await P().query('SELECT scheduled_send_at FROM outreach_logs WHERE id=$1', [held])).rows[0];
  ok('  a deliberate hold keeps its time', new Date(heldRow.scheduled_send_at).getTime() > Date.now() + 86400000, heldRow);
  Job._nextAt.clear();
  const rec9 = recorder();
  let c9 = Date.now();
  for (let i = 0; i < 5; i++) { await Job.runOnce({ send: rec9.fn, now: new Date(c9), sleep: async () => {} }); c9 += Job.MAX_GAP_MS + 1; }
  ok('  and the queue sends them', stuck.every((id) => rec9.sent.some((s) => s.id === id)), rec9.sent);

  // ── 10. THE COPY SAYS WHAT HAPPENS ────────────────────────────────────────
  OUT.push('', '-- the words on the page --');
  const page = read('public/index.html');
  ok('no page still promises Tuesday to Thursday', !/Tuesday to Thursday/.test(page) && !/Tuesday to Thursday/.test(stripComments(read('server/index.js'))));
  ok('Home renders the approved rows and polls while any are sending', /function hqOutboxHtml\(d\)/.test(page) && /hqPollOutbox\(d\);/.test(page));

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('sendqueue: FAILED', e); process.exit(1); });
