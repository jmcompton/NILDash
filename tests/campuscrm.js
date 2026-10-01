'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/campuscrm.js        just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── A DEPARTMENT WORKS ITS TOWN: SEARCH, THE SHARED CRM, PITCHES, THE NIGHT ──
// Parts 2 and 3 of the Cypress product. The definition of done, as a test:
// filter "women's basketball, within 5 miles, has a contact, not yet
// contacted", export it, pitch three. And the hard rule: once anyone on staff
// has touched a business, no one pitches it again without seeing that first.
// The model is stubbed; everything else is the real code and the real tables.
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const store = require(REPO + 'server/store.js');
const CP = require(REPO + 'server/services/campusPool.js');
const CM = require(REPO + 'server/services/campusMarket.js');
const CN = require(REPO + 'server/services/campusNightly.js');
const TS = require(REPO + 'server/services/teamScan.js');
const TW = require(REPO + 'server/services/teamWriter.js');
const MG = require(REPO + 'server/middleware/modeGuard.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const A = 'univ-crmtest-a', B = 'univ-crmtest-b';
const MKA = 'crmtown, ca', MKB = 'othertown, ca';
const STAFF = { x: 'crm-xavier', y: 'crm-yolanda', b: 'crm-bstaff', agent: 'crm-agent' };
const PASS = 'crm-test-pass-1';
const MI = 1609.34;

async function freePort() {
  return new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
}

// The stub writer: a plain, rule-abiding pitch, or one naming the athlete.
const calls = { n: 0 };
const ai = {
  oneShot: async (prompt) => {
    calls.n++;
    const biz = (prompt.match(/BUSINESS: (.+)/) || [])[1];
    const ath = (prompt.match(/ATHLETE \(the only person you may name\): ([^\n-]+)/) || [])[1];
    if (ath) return `SUBJECT: ${ath.trim()} and ${biz}\nBODY:\n${ath.trim()} plays for us and lives near ${biz}. Would you be open to a few posts together this season? A short call would be great.`;
    return `SUBJECT: Backing the team this season\nBODY:\n${biz} is close to campus and home games bring students and families past you. Would you like to support the program this season as a local partner? Could we set up a short call?`;
  },
};

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await TS.ensureTables(P);
  await CP.ensureTables(P);

  const clean = async () => {
    for (const u of [A, B]) {
      for (const t of ['university_contacts', 'university_market_runs', 'university_crm', 'university_touches', 'university_deals', 'university_drafts',
        'university_brand_engagement', 'university_staff']) await P.query(`DELETE FROM ${t} WHERE university_id = $1`, [u]);
      await P.query(`DELETE FROM university_research_claims WHERE team_id LIKE 'crm%'`);
      await P.query(`DELETE FROM university_teams WHERE university_id = $1`, [u]);
      await P.query(`DELETE FROM universities WHERE id = $1`, [u]);
    }
    await P.query(`DELETE FROM university_market_seen WHERE market_key = ANY($1)`, [[MKA, MKB]]);
    await P.query(`DELETE FROM users WHERE id = ANY($1)`, [Object.values(STAFF)]);
    await P.query(`DELETE FROM service_faults WHERE context LIKE 'teamScan crm%'`).catch(() => {});
  };
  await clean();

  // ── FIXTURE ───────────────────────────────────────────────────────────────
  await P.query(`INSERT INTO universities (id, name, short_name, location) VALUES ($1,'Crm Test College','CTC','1 College Way, Crmtown, CA 90000'),
                 ($2,'Other College','OC','1 Main, Othertown, CA 90001')`, [A, B]);
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, market_key) VALUES
    ('crm:wbb',$1,'Women''s Basketball','basketball',$2), ('crm:sb',$1,'Softball','softball',$2), ('crmb:wbb',$3,'Women''s Basketball','basketball',$4)`, [A, MKA, B, MKB]);
  const hash = await bcrypt.hash(PASS, 8);
  const mkUser = (id, name, role, uid) => P.query(`INSERT INTO users (id, name, email, password, role, university_id, plan_tier) VALUES ($1,$2,$3,$4,$5,$6,'unlimited')`,
    [id, name, id + '@crm.test', hash, role, uid]);
  await mkUser(STAFF.x, 'Xavier Ruiz', 'university', A);
  await mkUser(STAFF.y, 'Yolanda Park', 'university', A);
  await mkUser(STAFF.b, 'Other Staff', 'university', B);
  await mkUser(STAFF.agent, 'An Agent', 'agent', null);
  await P.query(`INSERT INTO university_staff (user_id, university_id, title, default_sender) VALUES ($1,$2,'Associate AD',TRUE)`, [STAFF.x, A]);

  // 40 businesses in town A. 0-29 reachable; 30-39 not. 0-9 within 3 miles,
  // the rest 6-12 miles. Categories alternate gym / restaurant. 3 has history.
  const fitFor = (i) => [{ team_id: 'crm:wbb', team: "Women's Basketball", score: i % 2 ? 22 : 40, why: i % 2 ? 'near campus' : 'a gym: players train there' },
    { team_id: 'crm:sb', team: 'Softball', score: 18, why: 'near campus' }];
  for (let i = 0; i < 40; i++) {
    const brand = `Crm Biz ${i}`;
    const miles = i < 10 ? 1 + i * 0.2 : 6 + (i - 10) * 0.2;
    await P.query(`INSERT INTO university_market_seen (market_key, brand, place_id, category, types, address, distance_m, rating, user_ratings_total)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,4.5,120)`, [MKA, brand, 'crm-' + i, i % 2 ? 'restaurant' : 'gym', JSON.stringify([i % 2 ? 'restaurant' : 'gym']),
      `${i} Main St, Crmtown`, Math.round(miles * MI)]);
    await P.query(`INSERT INTO university_contacts (university_id, market_key, brand, place_id, contact_name, contact_title, email, phone, reachable, status, team_fit, athlete_history, athlete_history_note)
                   VALUES ($1,$2,$3,$4,$5,'Owner',$6,'(714) 555-0100',$7,$8,$9::jsonb,$10,$11)`,
      [A, MKA, brand, 'crm-' + i, i < 30 ? 'Dana Reed' : null, i < 30 ? `dana${i}@biz.test` : null, i < 30, i < 30 ? 'reachable' : 'unreachable',
        JSON.stringify(fitFor(i)), i === 3, i === 3 ? 'Sponsors the high school team' : null]);
  }
  // A casino in the pool, marked blocked, with a contact somehow attached.
  await P.query(`INSERT INTO university_market_seen (market_key, brand, place_id, category, types, address, distance_m, blocked_reason)
                 VALUES ($1,'Crm Lucky Casino','crm-casino','entertainment','["casino"]','9 Main St',1600,'gambling: casino')`, [MKA]);
  await P.query(`INSERT INTO university_contacts (university_id, market_key, brand, contact_name, email, reachable, status, team_fit)
                 VALUES ($1,$2,'Crm Lucky Casino','Pat Lee','pat@casino.test',TRUE,'reachable',$3::jsonb)`, [A, MKA, JSON.stringify([{ team_id: 'crm:wbb', team: 'x', score: 90, why: 'x' }])]);
  // Town B has its own business.
  await P.query(`INSERT INTO university_market_seen (market_key, brand, place_id, category, types, distance_m) VALUES ($1,'Other Biz','ob-1','gym','["gym"]',1000)`, [MKB]);

  // ── 1. SEARCH: THE DEFINITION OF DONE ─────────────────────────────────────
  OUT.push('-- search: women\'s basketball, within 5 miles, has a contact, not yet contacted --');
  const q = { team: 'crm:wbb', miles: '5', contact: '1', stage: 'not_contacted' };
  const s1 = await CM.search(P, A, q);
  ok('the filter finds the ten close, reachable businesses', s1.ok && s1.total === 10 && s1.rows.every((r) => r.miles <= 5 && r.contact.reachable && r.stage === 'not_contacted'), { total: s1.total });
  ok('  sorted by fit for the team, best first, each with why', s1.rows[0].fit.score === 40 && s1.rows[0].fit.why && s1.rows[9].fit.score === 22, s1.rows.map((r) => r.fit));
  ok('  every row carries the named human and how to reach them', s1.rows.every((r) => r.contact.name === 'Dana Reed' && r.contact.email && r.contact.phone));
  ok('  the blocked casino is never in a search', !(await CM.search(P, A, { limit: 5000 })).rows.some((r) => /Casino/.test(r.brand)));
  ok('category filter', (await CM.search(P, A, { category: 'gym', limit: 5000 })).total === 20);
  ok('athlete-history filter', (await CM.search(P, A, { history: '1' })).rows.map((r) => r.brand).join() === 'Crm Biz 3');
  ok('text search', (await CM.search(P, A, { q: 'biz 3' })).rows.some((r) => r.brand === 'Crm Biz 3'));
  const byName = await CM.search(P, A, { sort: 'name', dir: 'desc', limit: 3 });
  ok('sort by name, descending', byName.rows[0].brand === 'Crm Biz 9', byName.rows.map((r) => r.brand));
  const byDist = await CM.search(P, A, { limit: 2 });
  ok('default sort is nearest first', byDist.rows[0].brand === 'Crm Biz 0');
  const csv = CM.csvOf(s1.rows, "Women's Basketball");
  const lines = csv.trim().split('\r\n');
  ok('the CSV has a header and one line per business, with the contact and why', lines.length === 11 && /Business,Kind,Address,Miles from campus,Contact,Title,Email,Phone/.test(lines[0])
    && /Why for Women's Basketball/.test(lines[0]) && /dana0@biz\.test/.test(csv) && /a gym: players train there/.test(csv), lines.slice(0, 2));

  // ── 2. THE SHARED CRM AND THE HARD RULE ───────────────────────────────────
  OUT.push('', '-- the shared CRM, and the hard rule --');
  const p1 = await CM.pitch(P, A, STAFF.x, { brand: 'Crm Biz 0', teamId: 'crm:wbb', ai });
  ok('an untouched business: a pitch, written to its named human and signed by the staff member', p1.ok && /^Hi Dana,/.test(p1.draft.body)
    && /Xavier Ruiz\nAssociate AD\nCrm Test College Athletics\ncrm-xavier@crm\.test/.test(p1.draft.body) && p1.draft.to === 'dana0@biz.test', p1);
  ok('  with a mailto link that opens it ready to send', /^mailto:dana0%40biz\.test\?subject=/.test(p1.draft.mailto));
  ok('  and no price anywhere', !/\$\d/.test(p1.draft.body));
  await CM.logTouch(P, A, STAFF.x, 'Crm Biz 0', { channel: 'email', summary: 'Sent the team pitch', teamId: 'crm:wbb', draftId: p1.draft.id });
  const after = (await CM.search(P, A, { q: 'Crm Biz 0' })).rows.find((r) => r.brand === 'Crm Biz 0');
  ok('logging the email moves it to Contacted, by whom and when', after.stage === 'contacted' && after.lastTouchBy === 'Xavier Ruiz' && after.lastTouchAt);
  ok('  and it leaves the "not yet contacted" filter', (await CM.search(P, A, q)).total === 9);
  const p2 = await CM.pitch(P, A, STAFF.y, { brand: 'Crm Biz 0', teamId: 'crm:sb', ai });
  ok('HARD RULE: a second staff member is refused, and shown the history first', !p2.ok && p2.status === 409 && p2.needsAck
    && p2.history.touches[0].user_name === 'Xavier Ruiz' && /Sent the team pitch/.test(p2.history.touches[0].summary), p2);
  const nBefore = (await P.query(`SELECT COUNT(*)::int n FROM university_drafts WHERE university_id = $1`, [A])).rows[0].n;
  ok('  and nothing was written', nBefore === 1);
  const p3 = await CM.pitch(P, A, STAFF.y, { brand: 'Crm Biz 0', teamId: 'crm:sb', acknowledgeHistory: true, ai });
  ok('  having seen it, she may pitch, signed as herself', p3.ok && /Yolanda Park\nCrm Test College Athletics/.test(p3.draft.body), p3.error);
  await CM.setStage(P, A, STAFF.y, 'Crm Biz 1', 'do_not_contact', 'Owner asked not to be contacted');
  const p4 = await CM.pitch(P, A, STAFF.x, { brand: 'Crm Biz 1', teamId: 'crm:wbb', acknowledgeHistory: true, ai });
  ok('Do not contact means do not contact, acknowledged or not', !p4.ok && p4.status === 409 && /Do not contact/.test(p4.error), p4);
  const p5 = await CM.pitch(P, A, STAFF.x, { brand: 'Crm Lucky Casino', teamId: 'crm:wbb', ai });
  ok('a gambling venue cannot be pitched for a team at all', !p5.ok && (p5.status === 404 || p5.status === 422), p5);
  const p6 = await CM.pitch(P, A, STAFF.x, { brand: 'Crm Biz 2', athlete: { name: 'Maya Lopez', facts: 'guard, from Cypress' }, ai });
  ok('an athlete pitch names the athlete the staff member chose', p6.ok && /Maya/.test(p6.draft.body), p6.error);
  const drow = (await P.query(`SELECT kind, athlete_name, team_id, contact_email, sender_email FROM university_drafts WHERE id = $1`, [p6.draft.id])).rows[0];
  ok('  stored as an athlete pitch, no team, with who it goes to and from', drow.kind === 'athlete' && drow.athlete_name === 'Maya Lopez' && drow.team_id === null
    && drow.contact_email === 'dana2@biz.test' && drow.sender_email === 'crm-xavier@crm.test', drow);
  await CM.logTouch(P, A, STAFF.y, 'Crm Biz 4', { channel: 'phone', summary: 'Called, left a message' });
  await CM.logTouch(P, A, STAFF.y, 'Crm Biz 4', { channel: 'phone', direction: 'in', summary: 'Called back', outcome: 'Wants details', stage: 'in_talks' });
  const deal = await CM.addDeal(P, A, STAFF.x, 'Crm Biz 4', { teamId: 'crm:wbb', value: 2500, description: 'Season banner' });
  const d4 = await CM.detail(P, A, 'Crm Biz 4');
  ok('the business page shows every touch by every staff member, newest first', d4.touches.length === 3 && d4.touches.some((t) => t.user_name === 'Yolanda Park' && t.outcome === 'Wants details'));
  ok('a deal is logged against the team with its value, and the stage is Deal signed', deal.value_cents === 250000 && d4.deals[0].team_name === "Women's Basketball" && d4.stage === 'deal_signed', d4.stage);
  ok('  a deal can be against an athlete instead', (await CM.addDeal(P, A, STAFF.x, 'Crm Biz 5', { athleteName: 'Maya Lopez', value: 300 })).athlete_name === 'Maya Lopez');
  ok('notes are shared', (await CM.setStage(P, A, STAFF.x, 'Crm Biz 6', null, 'Ask after the holidays')).ok
    && (await CM.search(P, A, { q: 'Crm Biz 6' })).rows.find((r) => r.brand === 'Crm Biz 6').notes === 'Ask after the holidays');
  ok('stage filter finds them', (await CM.search(P, A, { stage: 'deal_signed' })).total === 2);

  // ── 3. ONE DEPARTMENT NEVER SEES ANOTHER'S ────────────────────────────────
  OUT.push('', '-- isolation --');
  const sb = await CM.search(P, B, { limit: 5000 });
  ok('the other college searches only its own town', sb.total === 1 && sb.rows[0].brand === 'Other Biz', sb.rows.map((r) => r.brand));
  const isoD = await CM.detail(P, B, 'Crm Biz 4'), isoDeals = await CM.deals(P, B), isoH = await CM.history(P, B, 'Crm Biz 0');
  ok('  sees none of the first one\'s CRM, touches or deals', isoD === null && isoDeals.length === 0 && isoH.touched === false, { isoD: !!isoD, deals: isoDeals.length, isoH });

  // ── 4. THE NIGHT: FIVE CARDS A TEAM ───────────────────────────────────────
  OUT.push('', '-- the night: five cards a team --');
  const night = '2026-10-05';
  const r = await CN.runNight(P, A, { ai, discoverPool: false, resolveContacts: false, night });
  const cards = (await P.query(`SELECT * FROM university_drafts WHERE university_id = $1 AND kind = 'pitch' AND night IS NOT NULL ORDER BY team_id`, [A])).rows;
  ok('every team holds five cards', r.ok && r.cards === 10 && r.target === 10 && r.short.length === 0, r);
  ok('  every card: a business, a named human and how to reach them, the team, why, a signed pitch',
    cards.every((c) => c.contact_name === 'Dana Reed' && c.contact_email && c.team_id && c.why && /^Hi Dana,/.test(c.body) && /Xavier Ruiz/.test(c.body) && c.sender_email));
  const touched = ['Crm Biz 0', 'Crm Biz 1', 'Crm Biz 4', 'Crm Biz 5', 'Crm Biz 6'];
  ok('  never a business anyone on staff has touched', !cards.some((c) => touched.includes(c.brand_name)), cards.map((c) => c.brand_name));
  ok('  never the casino, never an unreachable business', !cards.some((c) => /Casino/.test(c.brand_name) || Number(c.brand_name.split(' ').pop()) >= 30));
  ok('  never the same business for two teams', new Set(cards.map((c) => c.brand_name)).size === cards.length);
  ok('  no price on any card', cards.every((c) => !/\$\d/.test(c.body) && c.price_cents === null && c.inventory_id === null));
  ok('the run is recorded, and a restart in the window does not run it twice', await CN.ranTonight(P, A, night));

  // A team with nothing left that fits: short, and the alert names it.
  await P.query(`UPDATE university_contacts SET team_fit = '[]'::jsonb WHERE university_id = $1`, [A]);
  const r2 = await CN.runNight(P, A, { ai, discoverPool: false, resolveContacts: false, night: '2026-10-06' });
  ok('short of five: the night says so, by team, with where it stopped', r2.cards === 0 && r2.short.length === 2 && r2.short.every((x) => x.stop === 'ladder' && x.rungs.includes('local')), r2.short);
  const faults = (await P.query(`SELECT reason FROM service_faults WHERE service = 'nightly-floor' AND context LIKE 'teamScan crm:%' ORDER BY at DESC LIMIT 5`).catch(() => ({ rows: [] }))).rows;
  ok('  and an ourFault nightly-floor alert names the team and the rungs', faults.some((f) => /Crm Test College Women's Basketball: 0 of 5 cards/.test(f.reason) && /rungs tried: local/.test(f.reason)), faults);

  // ── 5. THE WRITER'S THREE KINDS ───────────────────────────────────────────
  OUT.push('', '-- the writer --');
  const base = { university: { name: 'Crm Test College' }, team: { name: 'Softball' }, business: { brand_name: 'Crm Biz 9' } };
  ok('kinds: an item is an ask, an athlete is an athlete pitch, else a team pitch',
    TW.kindOf({ ...base, item: { name: 'x', price_cents: 1 } }) === 'ask' && TW.kindOf({ ...base, athlete: { name: 'A B' } }) === 'athlete' && TW.kindOf(base) === 'pitch');
  ok('a team pitch with a price is refused', !TW.checkAsk({ subject: 's', body: 'It is $500 for a banner.' }, base).ok);
  ok('  so is one using NIL', !TW.checkAsk({ subject: 'NIL deal', body: 'A partnership.' }, base).ok);
  ok('  an athlete pitch must name the athlete', !TW.checkAsk({ subject: 's', body: 'One of our players would love to work with you.' }, { ...base, athlete: { name: 'Maya Lopez' } }).ok);
  ok('  a team pitch prompt carries no ASK line and says no prices', !/THE ASK:/.test(TW.buildPrompt(base)) && /No prices/.test(TW.buildPrompt(base)));

  // ── 6. THE WALL ───────────────────────────────────────────────────────────
  OUT.push('', '-- the wall --');
  ok('department staff may use the market tool', MG.allowedForUniversity('GET /api/university/market/search') && MG.allowedForUniversity('POST /api/university/market/pitch'));
  ok('  and connect their own mailbox, but never read an inbox or send through the agent route',
    MG.allowedForUniversity('GET /api/email/oauth/gmail') && !MG.allowedForUniversity('GET /api/email/threads') && !MG.allowedForUniversity('POST /api/email/send'));
  ok('  a look-alike path is not in', !MG.allowedForUniversity('GET /api/university/marketplace') && !MG.allowedForUniversity('GET /api/university/market/../../athletes'));

  // ── 7. THE REAL SERVER ────────────────────────────────────────────────────
  OUT.push('', '-- the real server --');
  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'crm-test', CYPRESS_SEED_ON_BOOT: 'off', UNIVERSITY_NIGHTLY: 'off',
      RESEND_API_KEY: process.env.RESEND_API_KEY || 're_test_dummy', DATABASE_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let srvErr = ''; srv.stderr.on('data', (d) => { srvErr = (srvErr + d).slice(-2000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
      try { up = (await fetch(baseUrl + '/privacy')).ok; } catch (_) {}
      if (!up) await new Promise((res) => setTimeout(res, 1000));
    }
    ok('the server boots', up, srvErr.slice(-400));
    const login = async (id) => {
      const res = await fetch(baseUrl + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: id + '@crm.test', password: PASS }) });
      return (res.headers.get('set-cookie') || '').split(';')[0];
    };
    const call = async (cookie, method, path, body) => {
      const res = await fetch(baseUrl + path, { method, headers: Object.assign({ Cookie: cookie }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let j = null; try { j = JSON.parse(text); } catch (_) {}
      return { status: res.status, body: j, text, type: res.headers.get('content-type') || '' };
    };
    const cx = await login(STAFF.x);
    const me = await call(cx, 'GET', '/api/university/market/me');
    ok('staff sign in and see their own department, teams and stages', me.status === 200 && me.body.university.id === A && me.body.teams.length === 2 && me.body.stages.length === 7, me.status);
    const sr = await call(cx, 'GET', '/api/university/market/search?team=crm:wbb&miles=5&contact=1&stage=not_contacted');
    ok('  the filter over HTTP', sr.status === 200 && sr.body.total > 0 && sr.body.rows.every((x) => x.miles <= 5 && x.stage === 'not_contacted'), sr.status);
    const ex = await call(cx, 'GET', '/api/university/market/search?team=crm:wbb&miles=5&contact=1&stage=not_contacted&format=csv');
    ok('  CSV export downloads', ex.status === 200 && /text\/csv/.test(ex.type) && /Business,Kind/.test(ex.text));
    const again = await call(cx, 'POST', '/api/university/market/pitch', { brand: 'Crm Biz 0', teamId: 'crm:wbb' });
    ok('  the hard rule over HTTP: 409 with the history', again.status === 409 && again.body.needsAck && again.body.history.touches.length > 0, again.status);
    const cb = await login(STAFF.b);
    const other = await call(cb, 'GET', '/api/university/market/business?brand=' + encodeURIComponent('Crm Biz 4'));
    ok('  the other college gets 404 for this one\'s business', other.status === 404, other.status);
    const ca = await login(STAFF.agent);
    const ag = await call(ca, 'GET', '/api/university/market/search');
    ok('  an agent cannot use it', ag.status === 403, ag.status);
    const adm = await call(cx, 'POST', '/api/admin/campus/' + A + '/pool');
    ok('  and staff cannot start a paid pool build', adm.status === 403, adm.status);
  } finally {
    srv.kill();
  }

  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
