'use strict';
// Runs against the local test Postgres and boots the real server.
//
//   node tests/nilgo.js
//
// ── NIL GO, MADE EASY (services/nilGo) ──────────────────────────────────────
// Signed deals with their 5-business-day deadline, the facts NIL Go asks for,
// the association question, and the status, which moves the CRM stage.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('nilgotest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const PASS = 'nilgo-pass-1';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  const NG = require(REPO + 'server/services/nilGo.js');

  // ── THE DEADLINE ───────────────────────────────────────────────────────
  const fri = NG.deadlineFrom('2026-11-13T15:00:00Z');
  ok('5 business days from a Friday is the next Friday', fri.toISOString().slice(0, 10) === '2026-11-20', fri);
  ok('  from a Wednesday, weekend skipped: the next Wednesday', NG.deadlineFrom('2026-11-18T15:00:00Z').toISOString().slice(0, 10) === '2026-11-25');

  await NG.ensureColumns(P);
  const hash = await bcrypt.hash(PASS, 8);
  await P.query(`INSERT INTO users (id, name, email, password, role, comped) VALUES ('ng-a','Avery Stone','avery@ng.test',$1,'agent',TRUE), ('ng-b','Blair Other','blair@ng.test',$1,'agent',TRUE)`, [hash]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('ng-1','ng-a','{"name":"Jordan Lake","school":"Pinecrest State","sport":"Volleyball"}'::jsonb), ('ng-2','ng-b','{"name":"Other Kid"}'::jsonb)`);
  const deal = async (o) => (await P.query(
    `INSERT INTO athlete_self_deals (athlete_id, agent_id, brand_name, value, stage, crm_stage, crm_stage_at, deliverables, contact_name, contact_email, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$7) RETURNING id`,
    [o.athlete || 'ng-1', o.agent || 'ng-a', o.brand, o.value === undefined ? null : o.value, o.stage || 'Negotiating', o.crm || null, o.at || new Date(), o.deliv || null, o.cn || null, o.ce || null])).rows[0].id;
  const today = new Date();
  const big = await deal({ brand: 'Pinecrest Ford', value: 1500, crm: 'contract_signed', at: new Date(today.getTime() - 86400000), deliv: '2 Instagram posts and an appearance', cn: 'Pat Ford', ce: 'pat@pinecrestford.example' });
  const noAmt = await deal({ brand: 'Bean There', stage: 'Closed' });
  const small = await deal({ brand: 'Taco Spot', value: 300, crm: 'contract_signed' });
  const late = await deal({ brand: 'Iron Gym', value: 900, crm: 'contract_signed', at: new Date(today.getTime() - 14 * 86400000) });
  const already = await deal({ brand: 'Smile Dental', value: 2000, crm: 'cleared' });
  await deal({ brand: 'Not Signed Yet', value: 5000, crm: 'replied' });
  await deal({ brand: 'Elsewhere', value: 5000, crm: 'contract_signed', agent: 'ng-b', athlete: 'ng-2' });
  const logged = await deal({ brand: 'Logged Co' });
  await P.query(`INSERT INTO deal_outcomes (agent_id, athlete_id, deal_id, brand, deal_value, deliverable, closed_at) VALUES ('ng-a','ng-1',$1,'Logged Co',800,'one post',$2)`, [String(logged), new Date(today.getTime() - 2 * 86400000)]);

  const list = await NG.list(P, 'ng-a');
  const by = (b) => list.find((x) => x.brand === b);
  ok('signed deals only, never another agent\'s or an unsigned one', list.length === 6 && !by('Not Signed Yet') && !by('Elsewhere'), list.map((x) => x.brand));
  ok('$600 and up: to file, with a deadline', by('Pinecrest Ford').status === 'to_file' && by('Pinecrest Ford').daysLeft >= 3 && !by('Pinecrest Ford').overdue, by('Pinecrest Ford'));
  ok('  under $600: not needed', by('Taco Spot').status === 'not_needed');
  ok('  no amount on file: asks for it, stays to file', by('Bean There').needsAmount === true && by('Bean There').status === 'to_file');
  ok('  two weeks ago and not filed: overdue', by('Iron Gym').overdue === true && by('Iron Gym').daysLeft < 0);
  ok('  already cleared in the CRM: cleared', by('Smile Dental').status === 'cleared');
  ok('  a logged deal: its amount and deliverable come from the log', by('Logged Co').value === 800 && by('Logged Co').fields.find((f) => f.label === 'What the athlete delivers').value === 'one post');
  const f = by('Pinecrest Ford').fields;
  const val = (l) => (f.find((x) => x.label === l) || {}).value;
  ok('the facts NIL Go asks for, laid out', val('Athlete') === 'Jordan Lake' && val('Who is paying (business name)') === 'Pinecrest Ford' && val('Total compensation') === '$1,500'
    && val('Business contact') === 'Pat Ford, pat@pinecrestford.example' && val('School and sport') === 'Pinecrest State, Volleyball', f);
  ok('  and what is missing, the association question first among them', by('Pinecrest Ford').missing.includes('Tied to the school, a booster or a collective'));
  const sig1 = (await P.query(`SELECT nil_go_signed_at FROM athlete_self_deals WHERE id = $1`, [big])).rows[0].nil_go_signed_at;
  await P.query(`UPDATE athlete_self_deals SET crm_stage_at = NOW() WHERE id = $1`, [big]);
  await NG.list(P, 'ng-a');
  const sig2 = (await P.query(`SELECT nil_go_signed_at FROM athlete_self_deals WHERE id = $1`, [big])).rows[0].nil_go_signed_at;
  ok('the signed date is kept, so the deadline never drifts', +new Date(sig1) === +new Date(sig2));
  ok('summary: to file (incl. the one with no amount), and how many are late', JSON.stringify(NG.summary(list)) === JSON.stringify({ toFile: 4, overdue: 1, dueSoon: 0 })
    || (NG.summary(list).toFile === 4 && NG.summary(list).overdue === 1), NG.summary(list));

  // ── THE REAL SERVER ────────────────────────────────────────────────────
  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'nilgo-test', CYPRESS_SEED_ON_BOOT: 'off', UNIVERSITY_NIGHTLY: 'off', PORTAL_ROSTER_SWEEP: 'off', RESEND_API_KEY: 're_test_dummy', DATABASE_URL: '' },
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
    ok('signed out: 401', (await call('GET', '/api/nilgo')).status === 401);
    await call('POST', '/api/auth/login', { email: 'avery@ng.test', password: PASS });
    const g = await (await call('GET', '/api/nilgo')).json();
    ok('GET /api/nilgo: the deals and the summary', g.deals.length === 6 && g.summary.toFile === 4 && g.threshold === 600, g.summary);
    const a1 = await (await call('POST', '/api/nilgo/' + big, { associated: 'no' })).json();
    ok('answer the association question', a1.ok && a1.deal.associated === 'no' && !a1.deal.missing.includes('Tied to the school, a booster or a collective'), a1);
    const a2 = await (await call('POST', '/api/nilgo/' + big, { status: 'filed' })).json();
    const row = (await P.query(`SELECT crm_stage, nil_go_filed_at FROM athlete_self_deals WHERE id = $1`, [big])).rows[0];
    ok('I filed it: status filed, the CRM moves to Filed with NIL Go', a2.deal.status === 'filed' && row.crm_stage === 'filed_nil_go' && row.nil_go_filed_at, row);
    await call('POST', '/api/nilgo/' + big, { status: 'cleared' });
    ok('  cleared: the CRM moves to Cleared', (await P.query(`SELECT crm_stage FROM athlete_self_deals WHERE id = $1`, [big])).rows[0].crm_stage === 'cleared');
    const a3 = await (await call('POST', '/api/nilgo/' + noAmt, { value: '$1,200' })).json();
    ok('add the amount: it sticks and the deal still needs filing', a3.deal.value === 1200 && a3.deal.status === 'to_file' && !a3.deal.needsAmount, a3.deal);
    ok('bad input refused: an unknown status, a bad answer, a bad amount', (await call('POST', '/api/nilgo/' + big, { status: 'approved' })).status === 400
      && (await call('POST', '/api/nilgo/' + big, { associated: 'maybe' })).status === 400 && (await call('POST', '/api/nilgo/' + big, { value: 'lots' })).status === 400);
    const other = (await P.query(`SELECT id FROM athlete_self_deals WHERE brand_name = 'Elsewhere'`)).rows[0].id;
    ok('another agent\'s deal: 404', (await call('POST', '/api/nilgo/' + other, { status: 'filed' })).status === 404);
  } finally { srv.kill(); }

  const page = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('the tab: nav button with a badge, the view, and its loader', /id="nilgoNavBtn" onclick="showView\('nilgo',this\)"/.test(page) && /id="view-nilgo"/.test(page)
    && /if \(id === 'nilgo'\) loadNilGo\(\);/.test(page) && /ngRefreshBadge\(\);/.test(page));
  ok('  says plainly the athlete files, and the 5 business days', /The athlete files it, or one representative they name/.test(page) && /within 5 business days of signing/.test(page));
  ok('no em dashes in the new copy', !/—/.test(fs.readFileSync(REPO + 'server/services/nilGo.js', 'utf8').replace(/\/\/.*$/gm, '')));

  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.log(OUT.join('\n')); console.error(e); process.exit(1); });
