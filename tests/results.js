'use strict';
// Runs against the local test Postgres and boots the real server.
//
//   node tests/results.js
//
// ── RESULTS (services/results) ──────────────────────────────────────────────
// One count of what the work turned into: first emails, follow-ups, replies
// (once per conversation), interested replies, replies after a follow-up,
// deals and their value, and follow-ups waiting on the agent. Fictional names.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('resultstest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY);
const PASS = 'results-pass-1';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  const R = require(REPO + 'server/services/results.js');
  await P.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS reply_intent TEXT`);
  const hash = await bcrypt.hash(PASS, 8);
  await P.query(`INSERT INTO users (id, name, email, password, role, comped) VALUES
    ('rs-a','Avery Stone','avery@results.test',$1,'agent',TRUE),
    ('rs-b','Blair Gone','blair@results.test',$1,'agent',TRUE),
    ('rs-c','Casey Other','casey@results.test',$1,'agent',TRUE)`, [hash]);
  await P.query(`UPDATE users SET archived = TRUE WHERE id = 'rs-b'`);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES
    ('rs-ath1','rs-a','{"name":"Jordan Lake"}'::jsonb), ('rs-ath2','rs-a','{"name":"Riley Moss"}'::jsonb),
    ('rs-ath3','rs-c','{"name":"Sam Vale"}'::jsonb), ('rs-athb','rs-b','{"name":"Old Name"}'::jsonb)`);
  const log = (id, o) => P.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, brand_key, status, touch_no, parent_id, sent_at, replied_at, reply_intent, body_html, cadence_stopped_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())`,
    [id, o.agent || 'rs-a', o.athlete || 'rs-ath1', o.brand, o.key || null, o.status || 'sent', o.touch || 1, o.parent || null,
      o.sent || null, o.replied || null, o.intent || null, o.body === undefined ? '<p>x</p>' : o.body, o.stopped || null]);
  // Agent A, athlete 1:
  //   chain 1: sent 10 days ago, follow-up 6 days ago, reply 2 days ago (after the follow-up), interested
  //   chain 2: sent 5 days ago, reply 4 days ago, a question, no follow-up
  //   chain 3: sent 8 days ago, follow-up written and waiting (draft), no reply
  //   chain 4: sent 40 days ago (outside 30 days), its reply came 3 days ago (inside)
  //   chain 5: sent 3 days ago to the SAME business as chain 2 (a second athlete): one more email, same business
  //   a stopped follow-up and an empty-body follow-up: never "waiting"
  await log('o1', { brand: 'Joe\'s Pizza', key: 'joespizza', sent: ago(10) });
  await log('o1-t2', { brand: 'Joe\'s Pizza', key: 'joespizza', touch: 2, parent: 'o1', sent: ago(6), replied: ago(2), intent: 'interested' });
  await log('o2', { brand: 'Bean There', key: 'beanthere', sent: ago(5), replied: ago(4), intent: 'question' });
  await log('o3', { brand: 'Iron Gym', key: 'irongym', sent: ago(8) });
  await log('o3-t2', { brand: 'Iron Gym', key: 'irongym', touch: 2, parent: 'o3', status: 'draft' });
  await log('o4', { brand: 'Old Shop', key: 'oldshop', sent: ago(40), replied: ago(3), intent: 'not_interested' });
  await log('o5', { brand: 'Bean There', key: 'beanthere', athlete: 'rs-ath2', sent: ago(3) });
  await log('o6', { brand: 'Dead End', key: 'deadend', sent: ago(9) });
  await log('o6-t2', { brand: 'Dead End', key: 'deadend', touch: 2, parent: 'o6', status: 'draft', stopped: ago(1) });
  await log('o6-t3', { brand: 'Dead End', key: null, touch: 3, parent: 'o6', status: 'draft', body: '' });
  await log('o7', { brand: 'Never Sent', key: 'neversent', status: 'draft' });
  // Agent C and archived agent B: separate, and B never counts.
  await log('c1', { agent: 'rs-c', athlete: 'rs-ath3', brand: 'Taco Spot', key: 'tacospot', sent: ago(2), replied: ago(1) });
  await log('b1', { agent: 'rs-b', athlete: 'rs-athb', brand: 'Ghost', key: 'ghost', sent: ago(2), replied: ago(1) });
  // Deals: A signed 500 (5 days ago) and one with no value; an old one 50 days ago; B's never counts.
  await P.query(`INSERT INTO deal_outcomes (agent_id, athlete_id, brand, deal_value, closed_at) VALUES
    ('rs-a','rs-ath1','Joe''s Pizza',500,$1), ('rs-a','rs-ath2','Bean There',NULL,$1), ('rs-a','rs-ath1','Old Shop',250,$2), ('rs-b','rs-athb','Ghost',9999,$1)`, [ago(1), ago(50)]);

  const a = await R.forAgent(P, 'rs-a');
  const r = a.recent, t = a.allTime;
  ok('first emails in 30 days: o1, o2, o3, o5, o6 (the 40-day one and the unsent draft are out)', r.pitched === 5, r);
  ok('  businesses: Bean There twice is one business', r.businesses === 4, r);
  ok('  all time adds the 40-day pitch', t.pitched === 6 && t.businesses === 5, t);
  ok('follow-ups: only the one that went out', r.followUps === 1 && t.followUps === 1, r);
  ok('replies: one per conversation, dated by the reply (the 40-day pitch replied 3 days ago counts)', r.replies === 3 && t.replies === 3, r);
  ok('  interested counts interested and a question, not a no', r.interested === 2, r);
  ok('  after a follow-up: only chain 1', r.afterFollow === 1, r);
  ok('deals: two in 30 days (one with no value), three all time', r.deals === 2 && t.deals === 3, { r, t });
  ok('  dollars: 500 in 30 days, 750 all time', r.dollars === 500 && t.dollars === 750, { r, t });
  ok('waiting: the due draft only (not the stopped one, not an empty body)', t.waiting === 1, t);
  ok('rates: replies over businesses, and the share after a follow-up', r.replyRate === 75 && r.followShare === 33, r);
  const one = await R.forAgent(P, 'rs-a', { athleteId: 'rs-ath2' });
  ok('one athlete: only their pitch and their deal', one.recent.pitched === 1 && one.recent.replies === 0 && one.recent.deals === 1, one.recent);
  const c = await R.forAgent(P, 'rs-c');
  ok('another agent sees only their own', c.recent.pitched === 1 && c.recent.replies === 1 && c.recent.deals === 0, c.recent);
  const b = await R.forAgent(P, 'rs-b');
  ok('an archived account counts nothing', b.allTime.pitched === 0 && b.allTime.deals === 0, b.allTime);
  const p = await R.platform(P, { days: 30, weeks: 8 });
  ok('platform: A and C together, never B', p.total.pitched === 6 && p.total.replies === 4 && p.total.deals === 2 && p.total.dollars === 500, p.total);
  ok('  per agent, both listed, most replies first', p.agents.length === 2 && p.agents[0].id === 'rs-a', p.agents.map((x) => x.id));
  ok('  eight weeks, newest first, and the weeks add up to no more than all time', p.byWeek.length === 8 && p.byWeek[0].week > p.byWeek[1].week
    && p.byWeek.reduce((s, w) => s + w.pitched, 0) <= p.allTime.pitched, p.byWeek.map((w) => w.week));
  const html = R.renderHtml(p);
  ok('the admin page renders the numbers and escapes names', /Results/.test(html) && /Avery Stone/.test(html) && !/<script/i.test(html));

  // ── THE REAL SERVER ────────────────────────────────────────────────────
  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'results-test', CYPRESS_SEED_ON_BOOT: 'off', UNIVERSITY_NIGHTLY: 'off', PORTAL_ROSTER_SWEEP: 'off',
      RESEND_API_KEY: 're_test_dummy', DATABASE_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let srvErr = ''; srv.stderr.on('data', (d) => { srvErr = (srvErr + d).slice(-3000); });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (m, path, body) => { const res = await fetch(base + path, { method: m, redirect: 'manual', headers: Object.assign(cookie ? { Cookie: cookie } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return res; };
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/privacy')).ok; } catch (_) {} if (!up) await new Promise((x) => setTimeout(x, 1000)); }
    ok('the server boots', up, srvErr.slice(-400));
    ok('signed out: 401', (await call('GET', '/api/results')).status === 401);
    ok('the agent signs in', (await call('POST', '/api/auth/login', { email: 'avery@results.test', password: PASS })).status === 200);
    const mine = await (await call('GET', '/api/results')).json();
    ok('/api/results: the agent\'s own last 30 days and all time', mine.recent && mine.recent.pitched === 5 && mine.allTime.waiting === 1 && mine.days === 30, mine);
    ok('  an athlete of theirs', (await (await call('GET', '/api/results?athleteId=rs-ath2')).json()).recent.pitched === 1);
    ok('  someone else\'s athlete: 404', (await call('GET', '/api/results?athleteId=rs-ath3')).status === 404);
    ok('the admin page and its JSON: not for an agent', (await call('GET', '/admin/results')).status === 403 && (await call('GET', '/api/admin/results')).status === 403);
  } finally { srv.kill(); }

  // ── THE PAGE ───────────────────────────────────────────────────────────
  const page = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('Home: the results line, loaded with the queue, hidden until something was sent', /id="home-results" class="hq-results" hidden/.test(page)
    && /hqRender\(\);\n    loadHomeResults\(\);/.test(page) && /if \(!\(a\.pitched > 0\)\) \{ el\.hidden = true; return; \}/.test(page));
  ok('no em dashes in the new copy', !/—/.test(fs.readFileSync(REPO + 'server/services/results.js', 'utf8').replace(/\/\/.*$/gm, '')));

  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.log(OUT.join('\n')); console.error(e); process.exit(1); });
