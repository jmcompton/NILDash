'use strict';
// Runs against the local test Postgres and boots the real server.
//
//   node tests/clientreports.js
//
// ── THIS WEEK'S CLIENT REPORTS, ONE TAP (services/clientReports) ────────────
// The weekly athlete report now says who got a follow-up, and the nightly
// digest offers this week's reports behind one link: GET shows what would go
// and to whom and sends nothing; POST sends each ready report once. Fictional.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('clientreportstest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY);

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  const CR = require(REPO + 'server/services/clientReports.js');
  const AR = require(REPO + 'server/services/athleteReport.js');
  await P.query(`INSERT INTO users (id, name, email, password, role, comped) VALUES ('cr-a','Avery Stone','avery@reports.test','x','agent',TRUE), ('cr-b','Blair Other','blair@reports.test','x','agent',TRUE)`);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES
    ('cr-1','cr-a','{"name":"Jordan Lake","email":"jordan@family.test","parentEmail":"mom@family.test"}'::jsonb),
    ('cr-2','cr-a','{"name":"Riley Moss","parentEmail":"dad@moss.test"}'::jsonb),
    ('cr-3','cr-a','{"name":"Sam NoEmail"}'::jsonb),
    ('cr-4','cr-a','{"name":"Quiet Week","email":"quiet@family.test"}'::jsonb),
    ('cr-5','cr-a','{"name":"Done Already","email":"done@family.test"}'::jsonb),
    ('cr-6','cr-b','{"name":"Other Agent Kid","email":"kid@other.test"}'::jsonb)`);
  const log = (id, o) => P.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, touch_no, parent_id, sent_at, replied_at, created_at)
     VALUES ($1,$2,$3,$4,'sent',$5,$6,$7,$8,NOW())`, [id, o.agent || 'cr-a', o.athlete, o.brand, o.touch || 1, o.parent || null, o.sent, o.replied || null]);
  await log('l1', { athlete: 'cr-1', brand: 'Joe\'s Pizza', sent: ago(9) });
  await log('l1-t2', { athlete: 'cr-1', brand: 'Joe\'s Pizza', touch: 2, parent: 'l1', sent: ago(2) });
  await log('l2', { athlete: 'cr-1', brand: 'Bean There', sent: ago(3), replied: ago(1) });
  await log('l3', { athlete: 'cr-2', brand: 'Iron Gym', sent: ago(4) });
  await log('l4', { athlete: 'cr-3', brand: 'Taco Spot', sent: ago(2) });
  await log('l5', { athlete: 'cr-4', brand: 'Old News', sent: ago(20) });
  await log('l6', { athlete: 'cr-5', brand: 'Car Wash', sent: ago(2) });
  await log('l7', { agent: 'cr-b', athlete: 'cr-6', brand: 'Elsewhere', sent: ago(2) });
  await CR.ensureTables(P);
  await P.query(`INSERT INTO athlete_report_sends (athlete_id, agent_id, recipients, sent_at) VALUES ('cr-5','cr-a','done@family.test', $1)`, [ago(2)]);

  // ── THE REPORT ITSELF ──────────────────────────────────────────────────
  const w = CR.windowFor(new Date());
  const d = await AR.collectReportData('cr-1', 'cr-a', w.since, w.until);
  ok('the report knows who got a follow-up', d.followedUp.length === 1 && d.followedUp[0].brand_name === 'Joe\'s Pizza', d.followedUp);
  const html = AR.renderReportHtml(d);
  ok('  and says so, with a Followed up badge', /We followed up with 1 business that had not answered yet\./.test(html) && />Followed up</.test(html));

  // ── WHO GETS ONE ───────────────────────────────────────────────────────
  const list = await CR.ready(P, 'cr-a');
  const names = list.map((x) => x.name).sort();
  ok('ready: Jordan and Riley (no email on file, a quiet week, or a report 2 days ago: left out)', names.join(',') === 'Jordan Lake,Riley Moss', list);
  const j = list.find((x) => x.name === 'Jordan Lake');
  ok('  Jordan goes to the athlete and the parent, with the counts', j.recipients.join(',') === 'jordan@family.test,mom@family.test' && j.pitched === 2 && j.replies === 1 && j.followUps === 1, j);
  ok('  Riley to the parent only', list.find((x) => x.name === 'Riley Moss').recipients.join(',') === 'dad@moss.test');

  // ── THE OFFER ──────────────────────────────────────────────────────────
  const o1 = await CR.offerFor(P, 'cr-a');
  const o2 = await CR.offerFor(P, 'cr-a');
  ok('the digest offer: a link and the names, the same link all week', o1 && o1.count === 2 && /\/client-reports\/[a-f0-9]{36}$/.test(o1.url) && o1.url === o2.url, o1);
  const token = o1.url.split('/').pop();
  ok('  a bad or unknown token is nothing', (await CR.byToken(P, 'nope')) === null && (await CR.byToken(P, 'a'.repeat(36))) === null);
  ok('  nothing ready, no offer', (await CR.offerFor(P, 'cr-zzz')) === null);
  const D = require(REPO + 'server/services/nightlyDigest.js');
  const m = D.render({ rows: [{ name: 'Jordan Lake', pitches: [{ brand: 'Joe', approveUrl: 'a', skipUrl: 'b' }] }], reviewUrl: 'r', date: new Date(), reports: o1 });
  ok('the nightly digest carries it: one line, one button, in the text version too',
    /This week&#39;s client reports are ready for Jordan and Riley|This week's client reports are ready for Jordan and Riley/.test(m.html) && /Send 2 client reports/.test(m.html) && m.text.includes('Send them: ' + o1.url));
  ok('  and without one, no box', !/client reports/.test(D.render({ rows: [{ name: 'X Y', pitches: [] }], reviewUrl: 'r', date: new Date() }).html));

  // ── THE REAL SERVER: GET SENDS NOTHING, POST SENDS ONCE ────────────────
  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'cr-test', CYPRESS_SEED_ON_BOOT: 'off', UNIVERSITY_NIGHTLY: 'off', PORTAL_ROSTER_SWEEP: 'off',
      RESEND_API_KEY: 're_test_dummy', DATABASE_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let srvErr = ''; srv.stderr.on('data', (x) => { srvErr = (srvErr + x).slice(-3000); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/privacy')).ok; } catch (_) {} if (!up) await new Promise((x) => setTimeout(x, 1000)); }
    ok('the server boots', up, srvErr.slice(-400));
    const g = await fetch(base + '/client-reports/' + token);
    const gt = await g.text();
    ok('GET: the page lists both, who it goes to, and one Send button', g.status === 200 && /Jordan Lake/.test(gt) && /mom@family\.test/.test(gt) && /Send all 2 reports/.test(gt), gt.slice(0, 300));
    const sentRows = async () => (await P.query(`SELECT COUNT(*)::int n FROM athlete_report_sends WHERE agent_id = 'cr-a'`)).rows[0].n;
    ok('  and GET sent nothing', (await sentRows()) === 1 && !(await CR.byToken(P, token)).sent_at);
    ok('an unknown token: 404', (await fetch(base + '/client-reports/' + 'b'.repeat(36))).status === 404);
    // The dummy key: Resend refuses. Nothing is logged as sent and the link works again.
    const p1 = await (await fetch(base + '/client-reports/' + token, { method: 'POST' })).text();
    ok('POST with the mail provider refusing: nothing logged as sent, and the link still works', (await sentRows()) === 1 && /not sent/.test(p1) && !(await CR.byToken(P, token)).sent_at, p1.slice(0, 400));
  } finally { srv.kill(); }

  // With a working send: both go, once.
  const mails = [];
  const r1 = await CR.sendAll(P, token, { send: async (msg) => { mails.push(msg); return { data: { id: 'm' + mails.length } }; } });
  ok('sendAll: both reports go, to the right people, with the agent as reply-to', r1.ok && r1.sent.length === 2 && r1.failed.length === 0
    && mails.some((x) => x.to.join(',') === 'jordan@family.test,mom@family.test') && mails.every((x) => x.replyTo === 'avery@reports.test' || x.replyTo), r1);
  ok('  logged with the follow-up count', (await P.query(`SELECT summary FROM athlete_report_sends WHERE athlete_id = 'cr-1' ORDER BY id DESC LIMIT 1`)).rows[0].summary.followUps === 1);
  const r2 = await CR.sendAll(P, token, { send: async (msg) => { mails.push(msg); return {}; } });
  ok('  a second tap sends nothing', r2.already === true && mails.length === 2);
  ok('  and the digest stops offering this week', (await CR.offerFor(P, 'cr-a')) === null);
  ok('another agent\'s link never sends this agent\'s athletes', !mails.some((x) => /kid@other/.test(x.to.join(','))));
  await P.query(`UPDATE client_report_offers SET created_at = NOW() - INTERVAL '20 days', sent_at = NULL WHERE token = $1`, [token]);
  ok('an old link has expired', (await CR.sendAll(P, token, { send: async () => ({}) })).status === 410);

  // ── THE APP'S OWN SEND BUTTON USES THE SAME PATH ───────────────────────
  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('/api/athlete-report/send goes through clientReports.sendOne', /require\('\.\/services\/clientReports'\)\.sendOne\(store\.pool/.test(idx));
  ok('no em dashes in the new copy', !/—/.test(fs.readFileSync(REPO + 'server/services/clientReports.js', 'utf8').replace(/\/\/.*$/gm, '')));

  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.log(OUT.join('\n')); console.error(e); process.exit(1); });
