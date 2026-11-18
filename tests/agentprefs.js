'use strict';
// Runs against the local test Postgres and boots the real server.
//
//   node tests/agentprefs.js
//
// ── AN AGENT'S OWN RULES FOR THEIR CARDS (services/agentPrefs) ──────────────
// A starting price and kinds of business never to show; saving applies to the
// cards already waiting. Also: a graduated athlete's market is where they
// live now (livesIn), the card shows the business's website, and the writer
// calls one athlete by name, never "their".
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('agentprefstest', { schema: true });
process.env.OFFER_ON = process.env.OFFER_ON || '1';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const PASS = 'prefs-pass-1';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  const AP = require(REPO + 'server/services/agentPrefs.js');
  await AP.ensureColumns(P);

  // ── THE RULES, PURE ─────────────────────────────────────────────────────
  const re = { never: ['real_estate'] };
  ok('never real estate: by Google type, by name; a coffee shop is fine', AP.blockedBy(re, { name: 'Smith Group', types: ['real_estate_agency'] }).key === 'real_estate'
    && AP.blockedBy(re, { name: 'Lakeside Realty' }).key === 'real_estate' && AP.blockedBy(re, { name: 'Keller Williams Pinecrest' }).key === 'real_estate'
    && AP.blockedBy(re, { name: 'Main Street Coffee', category: 'cafe' }) === null && AP.blockedBy({ never: [] }, { name: 'Lakeside Realty' }) === null);
  const f = AP.applyFloor({ amount: 250, kind: 'cash', label: '$250', why: 'a small local business' }, 500);
  ok('a $250 suggestion under a $500 floor starts at $500 and says why; $500 and none are left alone',
    f.amount === 500 && f.label === '$500' && /your starting price/.test(f.why) && AP.applyFloor({ amount: 500, kind: 'cash', label: '$500' }, 500).amount === 500
    && AP.applyFloor(null, 500) === null && AP.applyFloor({ amount: 250, kind: 'cash' }, null).amount === 250, f);

  // ── WHERE A GRADUATED ATHLETE LIVES NOW ─────────────────────────────────
  const AR = require(REPO + 'server/services/athleteRecord.js');
  const loc = () => ({ city: 'Waltham', state: 'MA' });
  const before = AR.resolveAthlete({ id: 'x', data: { name: 'Cash Test', school: 'Bentley University' } }, { schoolLocation: loc });
  const after = AR.resolveAthlete({ id: 'x', data: { name: 'Cash Test', school: 'Bentley University', livesIn: 'Readfield, ME' } }, { schoolLocation: loc });
  ok('livesIn moves the local lane to where they live now; the school stays on the record', before.market === 'Waltham, MA' && after.market === 'Readfield, ME'
    && after.marketSource === 'lives-in' && after.school === 'Bentley University' && !after.missing.includes('livesIn') && !before.missing.includes('livesIn'), { before: before.market, after: after.market });

  // ── THE WRITER ──────────────────────────────────────────────────────────
  const PW = require(REPO + 'server/services/pitchWriter.js');
  ok('the writer calls one athlete by first name, never "their"', /ONE ATHLETE IS ONE PERSON/.test(PW.SYSTEM) && /never as "they", "them" or "their"/.test(PW.SYSTEM) && /ONE ATHLETE IS ONE PERSON/.test(PW.SYSTEM_PRO));
  ok('  and the older generator says the same', /never call one athlete "they", "them" or "their"/.test(fs.readFileSync(REPO + 'server/services/pitchGeneration.js', 'utf8')));

  // ── SAVING APPLIES TO THE CARDS ALREADY WAITING ─────────────────────────
  const hash = await bcrypt.hash(PASS, 8);
  await P.query(`INSERT INTO users (id, name, email, password, role, comped) VALUES ('ap-a','Avery Stone','avery@ap.test',$1,'agent',TRUE), ('ap-b','Blair Other','blair@ap.test',$1,'agent',TRUE)`, [hash]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('ap-1','ap-a','{"name":"Jordan Lake"}'::jsonb), ('ap-2','ap-b','{"name":"Other Kid"}'::jsonb)`);
  await require(REPO + 'server/services/offerSuggest.js').ensureColumns?.(P);
  for (const c of ['offer_amount NUMERIC', 'offer_kind TEXT', 'offer_suggested NUMERIC', 'offer_menu_item TEXT', 'offer_why TEXT', 'business_category TEXT', 'outreach_log_id TEXT']) {
    await P.query(`ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS ${c}`).catch(() => {});
  }
  const card = (id, agent, ath, slot, name, amt, dm) => P.query(`INSERT INTO outreach_queue (id, agent_id, athlete_id, slot, brand_key, brand_name, channel, state, dm_text, offer_amount, offer_kind)
    VALUES ($1,$2,$3,$4,$5,$5,'dm','queued',$7,$6,'cash')`, [id, agent, ath, slot, name, amt, dm]);
  await card(901, 'ap-a', 'ap-1', 1, 'Lakeside Realty', 250, 'Hi, a $250 partnership with Jordan.');
  await card(902, 'ap-a', 'ap-1', 2, 'Main Street Coffee', 250, 'Hi, a $250 partnership with Jordan.');
  await card(903, 'ap-a', 'ap-1', 3, 'Pinecrest Ford', 500, 'Hi, a $500 partnership with Jordan.');
  await card(904, 'ap-b', 'ap-2', 1, 'Other Realty', 250, 'Hi, a $250 partnership.');
  const s = await AP.set(P, 'ap-a', { offerFloor: 500, never: ['real_estate', 'not_a_kind'] });
  const rows = Object.fromEntries((await P.query(`SELECT id, state, offer_amount, dm_text FROM outreach_queue ORDER BY id`)).rows.map((r) => [r.id, r]));
  ok('saving: the real estate card is removed, the $250 card is raised to $500 with the draft rewritten, the $500 card untouched',
    s.ok && s.skipped === 1 && s.lifted === 1 && rows[901].state === 'skipped' && Number(rows[902].offer_amount) === 500 && /\$500 partnership/.test(rows[902].dm_text)
    && Number(rows[903].offer_amount) === 500 && JSON.stringify(s.prefs.never) === '["real_estate"]', { s, rows });
  ok('  another agent\'s cards are not touched', rows[904].state === 'queued' && Number(rows[904].offer_amount) === 250);
  ok('  a starting price off the list is refused', (await AP.set(P, 'ap-a', { offerFloor: 333 })).ok === false);

  // ── THE REAL SERVER ────────────────────────────────────────────────────
  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'prefs-test', CYPRESS_SEED_ON_BOOT: 'off', UNIVERSITY_NIGHTLY: 'off', PORTAL_ROSTER_SWEEP: 'off', PAYING_BRANDS_OFF: '1', RESEND_API_KEY: 're_test_dummy', DATABASE_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let srvErr = ''; srv.stderr.on('data', (x) => { srvErr = (srvErr + x).slice(-3000); });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (m, p, body) => { const r = await fetch(base + p, { method: m, redirect: 'manual', headers: Object.assign(cookie ? { Cookie: cookie } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return r; };
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/privacy')).ok; } catch (_) {} if (!up) await new Promise((x) => setTimeout(x, 1000)); }
    ok('the server boots', up, srvErr.slice(-400));
    ok('signed out: 401; the admin route is not public', (await call('GET', '/api/agent/settings/cards')).status === 401
      && [401, 403].includes((await call('POST', '/api/admin/agent-card-settings', { agentEmail: 'blair@ap.test', never: ['law'] })).status));
    await call('POST', '/api/auth/login', { email: 'blair@ap.test', password: PASS });
    const g = await (await call('GET', '/api/agent/settings/cards')).json();
    ok('the agent reads their settings: none set, the choices listed', g.offerFloor === null && g.never.length === 0 && g.floors.includes(500) && g.kinds.some((k) => k.key === 'real_estate'), g);
    const p = await (await call('POST', '/api/agent/settings/cards', { offerFloor: 500, never: ['real_estate'] })).json();
    ok('  and saves them; their waiting real estate card goes', p.ok && p.offerFloor === 500 && p.skipped === 1
      && (await P.query(`SELECT state FROM outreach_queue WHERE id = 904`)).rows[0].state === 'skipped', p);
  } finally { srv.kill(); }

  const idx = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('settings: the My cards box, loaded with the page', /id="cards-card"/.test(idx) && /setTimeout\(loadCardPrefs, 60\)/.test(idx) && /function saveCardPrefs\(\)/.test(idx));
  ok('the card shows the website, https only', /Website: <a href="' \+ hqEscape\(c\.website\)/.test(idx) && /c\.website && \/\^https:/.test(idx));
  const HQ = fs.readFileSync(REPO + 'server/services/homeQueue.js', 'utf8');
  ok('  from the pitch address\'s domain, never a free mailbox', /website: websiteOf\(c\.toEmail\)/.test(HQ) && /isFreeMail\(email\)\) return null/.test(HQ));
  const OQ = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the nightly queue: never-these refused before any credit, and the starting price applied', /AgentPrefs\.blockedBy\(_ap,/.test(OQ) && /AgentPrefs\.applyFloor\(OFFER\.ON\(\)/.test(OQ)
    && OQ.indexOf('AgentPrefs.blockedBy(') < OQ.indexOf("THE SEND GATE'S OWN CHECK, BEFORE ANY HUNTER CREDIT"));
  ok('no em dashes in the new copy', !/—/.test(fs.readFileSync(REPO + 'server/services/agentPrefs.js', 'utf8').replace(/\/\/.*$/gm, '')));
  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.log(OUT.join('\n')); console.error(e); process.exit(1); });
