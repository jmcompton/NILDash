'use strict';
// Runs against the local test Postgres and boots the real server.
//
//   node tests/athletelink.js
//
// ── THE ATHLETE'S UPDATE LINK (services/athleteLink) ────────────────────────
// One private link per athlete, no login: mark a deliverable posted (with a
// link as proof), log a gift, report a brand that reached out. GET changes
// nothing; each update lands where the agent works and in the activity log.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('athletelinktest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const PASS = 'link-pass-1';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  const AL = require(REPO + 'server/services/athleteLink.js');
  await AL.ensureColumns(P);
  await require(REPO + 'server/services/giftedDeals.js').ensureTables(P);
  const hash = await bcrypt.hash(PASS, 8);
  await P.query(`INSERT INTO users (id, name, email, password, role, comped) VALUES ('al-a','Avery Stone','avery@al.test',$1,'agent',TRUE), ('al-b','Blair Other','blair@al.test',$1,'agent',TRUE)`, [hash]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('al-1','al-a','{"name":"Jordan Lake"}'::jsonb), ('al-2','al-b','{"name":"Other Kid"}'::jsonb)`);
  const ev = async (id, title, days, status, ath = 'al-1', agent = 'al-a') => P.query(
    `INSERT INTO athlete_calendar_events (id, athlete_id, agent_id, title, event_date, brand, status) VALUES ($1,$2,$3,$4,CURRENT_DATE + $5::int,'Joe''s Pizza',$6)`, [id, ath, agent, title, days, status]);
  await ev('e1', 'Instagram story', 2, 'pending');
  await ev('e2', 'TikTok video', -3, 'pending');
  await ev('e3', 'Already done', 1, 'completed');
  await ev('e4', 'Far away', 90, 'pending');
  await ev('e5', 'Draft', 1, 'draft');
  await ev('e9', 'Other kid post', 1, 'pending', 'al-2', 'al-b');

  const l1 = await AL.linkFor(P, 'al-a', 'al-1');
  const l2 = await AL.linkFor(P, 'al-a', 'al-1');
  ok('one link per athlete, the same each time', l1 && /\/me\/[a-f0-9]{40}$/.test(l1.url) && l1.url === l2.url, l1);
  ok('  not for another agent\'s athlete', (await AL.linkFor(P, 'al-a', 'al-2')) === null);
  const token = l1.url.split('/').pop();
  const ath = await AL.byToken(P, token);
  ok('the token finds the athlete and the agent', ath && ath.id === 'al-1' && ath.agentId === 'al-a' && ath.agentName === 'Avery Stone', ath);
  const due = await AL.due(P, ath);
  ok('what\'s due: open items, late ones too, not done, not drafts, not months away', due.map((x) => x.id).join(',') === 'e2,e1', due.map((x) => x.id));

  // ── THE REAL SERVER ────────────────────────────────────────────────────
  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'link-test', CYPRESS_SEED_ON_BOOT: 'off', UNIVERSITY_NIGHTLY: 'off', PORTAL_ROSTER_SWEEP: 'off', RESEND_API_KEY: 're_test_dummy', DATABASE_URL: '', APP_URL: 'http://127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let srvErr = ''; srv.stderr.on('data', (x) => { srvErr = (srvErr + x).slice(-3000); });
  const base = `http://127.0.0.1:${port}`;
  const form = (path, data) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/privacy')).ok; } catch (_) {} if (!up) await new Promise((x) => setTimeout(x, 1000)); }
    ok('the server boots', up, srvErr.slice(-400));
    const g = await fetch(base + '/me/' + token);
    const page = await g.text();
    ok('the page: their first name, their agent, what\'s due, and both forms; noindex', g.status === 200 && /Hey Jordan/.test(page) && /Avery Stone/.test(page) && /TikTok video/.test(page)
      && /Was due/.test(page) && /A brand sent me something/.test(page) && /A brand reached out/.test(page) && /noindex/.test(page) && !/Far away|Already done|Other kid/.test(page));
    ok('  GET changed nothing', (await P.query(`SELECT status FROM athlete_calendar_events WHERE id = 'e1'`)).rows[0].status === 'pending');
    ok('a wrong or replaced token: not active', (await fetch(base + '/me/' + 'f'.repeat(40))).status === 404 && (await fetch(base + '/me/short')).status === 404);

    const p1 = await form(`/me/${token}/posted/e1`, { proofUrl: 'instagram.com/p/abc' });
    const row = (await P.query(`SELECT status, completed_by_role, completed_by_id, proof_url FROM athlete_calendar_events WHERE id = 'e1'`)).rows[0];
    ok('I posted it: done, by the athlete, with the link as proof, back to the page', p1.status === 303 && /ok=posted/.test(p1.headers.get('location'))
      && row.status === 'completed' && row.completed_by_role === 'athlete' && row.completed_by_id === 'al-1' && row.proof_url === 'https://instagram.com/p/abc', row);
    ok('  another athlete\'s item cannot be touched', /err=/.test((await form(`/me/${token}/posted/e9`, {})).headers.get('location'))
      && (await P.query(`SELECT status FROM athlete_calendar_events WHERE id = 'e9'`)).rows[0].status === 'pending');
    ok('  a bad link is refused', /err=/.test((await form(`/me/${token}/posted/e2`, { proofUrl: 'not a link' })).headers.get('location')));

    const p2 = await form(`/me/${token}/gift`, { brand: 'Lola Blankets', product: 'Throw', retailValue: '180', platform: 'instagram story' });
    const gift = (await P.query(`SELECT * FROM gifted_deals WHERE athlete_id = 'al-1'`)).rows[0];
    ok('a gift lands in the agent\'s Gifts & Reports, marked as the athlete\'s', /ok=gift/.test(p2.headers.get('location')) && gift && gift.agent_id === 'al-a' && Number(gift.retail_value) === 180 && /athlete/.test(gift.notes), gift);
    ok('  no brand: refused with a reason', /err=Enter%20the%20brand/.test((await form(`/me/${token}/gift`, { brand: '' })).headers.get('location')));

    const p3 = await form(`/me/${token}/deal`, { brand: 'Iron Gym', contactName: 'Sam Lee', contactEmail: 'Sam@IronGym.example', channel: 'Instagram DM', offer: '$300', what: 'Two posts a month' });
    const deal = (await P.query(`SELECT * FROM athlete_self_deals WHERE brand_name = 'Iron Gym'`)).rows[0];
    ok('a brand that reached out becomes a Pipeline deal for the agent, from the athlete', /ok=deal/.test(p3.headers.get('location')) && deal && deal.agent_id === 'al-a' && deal.stage === 'Prospecting'
      && deal.source === 'athlete' && Number(deal.value) === 300 && deal.contact_email === 'sam@irongym.example' && /Instagram DM/.test(deal.notes), deal);
    ok('  a bad email or offer is refused', /err=/.test((await form(`/me/${token}/deal`, { brand: 'X Co', contactEmail: 'nope' })).headers.get('location'))
      && /err=/.test((await form(`/me/${token}/deal`, { brand: 'X Co', offer: 'lots' })).headers.get('location')));
    const acts = (await P.query(`SELECT activity_type FROM athlete_activity_log WHERE athlete_id = 'al-1' ORDER BY id`)).rows.map((x) => x.activity_type);
    ok('every update is in the activity log', acts.join(',') === 'deliverable_completed,gift_logged,deal_reported', acts);

    // The agent side.
    let cookie = '';
    const call = async (m, p) => { const r = await fetch(base + p, { method: m, headers: cookie ? { Cookie: cookie } : {} }); const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return r; };
    await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'avery@al.test', password: PASS }) })
      .then((r) => { cookie = (r.headers.get('set-cookie') || '').split(';')[0]; });
    const got = await (await call('GET', '/api/athletes/al-1/update-link')).json();
    ok('the agent gets the same link', got.url.endsWith(token), got);
    const rot = await (await call('POST', '/api/athletes/al-1/update-link')).json();
    ok('  replacing it: a new link, and the old one stops working', !rot.url.endsWith(token) && (await fetch(base + '/me/' + token)).status === 404 && (await fetch(base + '/me/' + rot.url.split('/').pop())).status === 200);
    ok('  another agent\'s athlete: 404', (await call('GET', '/api/athletes/al-2/update-link')).status === 404);
  } finally { srv.kill(); }

  const idx = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('the agent\'s box: the link, Copy, Text it, Replace', /id="gf-link"/.test(idx) && /onclick="gfCopyLink\(this\)"/.test(idx) && /id="gf-text"/.test(idx) && /onclick="gfNewLink\(\)"/.test(idx) && /gfLinkLoad\(false\);/.test(idx));
  ok('no em dashes in the new copy', !/—/.test(fs.readFileSync(REPO + 'server/services/athleteLink.js', 'utf8').replace(/\/\/.*$/gm, '')));
  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.log(OUT.join('\n')); console.error(e); process.exit(1); });
