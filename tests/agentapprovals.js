'use strict';
//   node tests/agentapprovals.js   (local test Postgres)
//
// scripts/agent-approvals.js: one agent's approved emails that never sent,
// listed, and released to the normal queue: never one with no address, one
// whose address already got an email, a follow-up waiting out its gap, or one
// with a hard compliance rule.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const { execFileSync } = require('child_process');
const store = require(REPO + 'server/store.js');
const Closer = require(REPO + 'server/services/closer.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const AG = 'aa-agent', EMAIL = 'aa-agent@aa.example';
const P = () => store.pool;
const run = (...a) => execFileSync(process.execPath, [REPO + 'scripts/agent-approvals.js', '--agent', EMAIL, ...a],
  { env: { ...process.env, INIT_WAIT_MS: '2500' }, encoding: 'utf8' });
async function row(id, brand, email, { stopped, hold, touch = 1, athlete = 'aa-a1', subject } = {}) {
  await P().query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,brand_key,subject,body_html,status,sent_to_email,touch_no,
        approved_at,approved_by,scheduled_send_at,cadence_stopped_at,cadence_stop_reason,send_hold_reason)
     VALUES ($1,$2,$3,$4,$5,$6,'<p>x</p>','approved',$7,$8,NOW() - INTERVAL '2 days',$2,NOW() - INTERVAL '2 days',$9,$10,$11)`,
    [id, AG, athlete, brand, brand.toLowerCase(), subject || 'Quick idea for ' + brand, email, touch,
      stopped ? new Date() : null, stopped || null, hold || null]);
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  await require(REPO + 'server/services/sendGuard.js').ensureTable(P());
  await require(REPO + 'server/services/sendRules.js').ensureTable(P()).catch(() => {});
  const clean = async () => {
    for (const q of [`DELETE FROM compliance_holds WHERE agent_id=$1`, `DELETE FROM outreach_logs WHERE agent_id=$1`, `DELETE FROM athletes WHERE agent_id=$1`,
      `DELETE FROM agent_send_budget WHERE agent_id=$1`, `DELETE FROM agent_approval_releases WHERE agent_id=$1`, `DELETE FROM users WHERE id=$1`]) await P().query(q, [AG]).catch(() => {});
    await P().query(`DELETE FROM email_sends WHERE email LIKE '%@aa.example' OR email LIKE '%@chop.edu'`).catch(() => {});
    await P().query(`DELETE FROM outreach_logs WHERE id LIKE 'aa-prior%'`).catch(() => {});
  };
  await clean();
  await P().query(`INSERT INTO users (id,name,email,password,role,report_tz) VALUES ($1,'Release Agent',$2,'x','agent','America/Chicago')`, [AG, EMAIL]);
  await P().query(`UPDATE users SET business_street='1 Test St', business_city='Testville', business_state='AL', business_zip='35201' WHERE id=$1`, [AG]);
  await store.saveAthlete('aa-a1', { id: 'aa-a1', agentId: AG, name: 'Jordan Hale', sport: 'track', school: 'Temple University', over18: true });
  await store.saveAthlete('aa-a2', { id: 'aa-a2', agentId: AG, name: 'Young One', sport: 'soccer', school: 'Temple University', over18: false });

  await row('aa-1', "Children's Hospital of Philadelphia Sports Medicine", 'sportsmed@chop.edu', { hold: 'compliance: not a sponsor: chop.edu is a university\'s own address' });
  await P().query(`INSERT INTO compliance_holds (agent_id, athlete_id, outreach_log_id, brand_name, rule_key, rule_label, severity, reason, facts, rules_version, unchecked)
    VALUES ($1,'aa-a1','aa-1','CHOP','category-not-a-sponsor','not a sponsor','block','chop.edu','{"source":"rule"}'::jsonb,'t','[]'::jsonb)`, [AG]);
  await row('aa-2', 'Cairn Coffee', 'info@aa.example', { stopped: 'Not sent: info@ is a shared inbox, not a named person.' });
  await row('aa-3', 'No Address Co', null, { stopped: 'no address to send to' });
  await row('aa-4', 'PSECU', 'pat@aa.example', { stopped: '"Quick idea for PSECU" was already sent to pat@aa.example' });
  await P().query(`INSERT INTO email_sends (email, subject, subject_key, system, agent_id, ref_id, sent_at) VALUES ('pat@aa.example','Quick idea for PSECU','quick idea for psecu','closer',$1,'aa-prior',NOW() - INTERVAL '10 days')`, [AG]);
  await row('aa-5', 'Temple Health', 'kim@aa.example', { touch: 3, subject: 'Re: Quick idea for Temple Health',
    hold: 'kim@aa.example already got "Re: Quick idea for Temple Health" from the follow-up sequence (touch 2) on 2026-11-02; nothing else for 4 days' });
  await row('aa-6', 'Kessler Liquor', 'kessler@aa.example', { athlete: 'aa-a2', hold: 'compliance: alcohol' });
  await P().query(`INSERT INTO compliance_holds (agent_id, athlete_id, outreach_log_id, brand_name, rule_key, rule_label, severity, reason, facts, rules_version, unchecked)
    VALUES ($1,'aa-a2','aa-6','Kessler Liquor','category-alcohol','alcohol','block','a minor','{"source":"rule"}'::jsonb,'t','[]'::jsonb)`, [AG]);

  const list = run();
  ok('the list names every approved email that never sent', (list.match(/^- /gm) || []).length === 6, list);
  ok('  with athlete, business, address and reason', /Jordan Hale \| Children's Hospital of Philadelphia Sports Medicine \| sportsmed@chop\.edu \| approved .* \| held: compliance: not a sponsor/.test(list), list);
  ok('a list changes nothing', (await P().query(`SELECT COUNT(*)::int AS n FROM outreach_logs WHERE agent_id=$1 AND cadence_stopped_at IS NULL AND send_hold_reason IS NULL`, [AG])).rows[0].n === 0);
  ok('it would release CHOP and the shared inbox: 2 of 6', /Would release: 2 of 6/.test(list), list.split('\n').slice(-6));

  const ap = run('--apply');
  ok('apply releases 2 of 6', /Released: 2 of 6/.test(ap), ap.split('\n').slice(-6));
  ok('  not the one with no address', /No Address Co[\s\S]*?not released: no address to send to/.test(ap));
  ok('  not the one whose address already got that email (no double sends)', /PSECU[\s\S]*?not released: pat@aa\.example already got an email from us/.test(ap), ap);
  ok('  not the follow-up waiting out its 4-day gap (it sends on its own)', /Temple Health[\s\S]*?not released: a follow-up waiting out the 4-day gap/.test(ap));
  ok('  not the one with a hard rule (alcohol to a minor)', /Kessler Liquor[\s\S]*?not released: hard compliance rule/.test(ap));
  const s1 = (await P().query(`SELECT id, status, cadence_stopped_at, send_hold_reason FROM outreach_logs WHERE id IN ('aa-1','aa-2') ORDER BY id`)).rows;
  ok('released rows are approved, unstopped, unheld and due now', s1.every((r) => r.status === 'approved' && !r.cadence_stopped_at && !r.send_hold_reason), s1);
  ok('  and the CHOP soft hold is resolved as approved by the agent',
    (await P().query(`SELECT resolution FROM compliance_holds WHERE outreach_log_id='aa-1'`)).rows[0].resolution === 'approved-by-agent');

  const sent = [];
  for (let i = 0; i < 3; i++) await Closer.releaseDue(P(), { sleep: async () => {}, send: async (log) => { sent.push(log.brand_name); return { providerMessageId: 'm' + sent.length }; } });
  ok('the normal release queue sends both released emails', sent.includes("Children's Hospital of Philadelphia Sports Medicine") && sent.includes('Cairn Coffee'), sent);
  ok('  and nothing it was not given', !sent.includes('Kessler Liquor') && !sent.includes('PSECU') && !sent.includes('No Address Co'), sent);
  const st = run('--status');
  ok('status reports what became of each released email', /RELEASED FOR Release Agent .*: 2\. Sent 2/.test(st), st);
  const again = run('--apply');
  ok('a second apply releases nothing more (already sent)', /Released: 0 of/.test(again), again.split('\n').slice(-5));

  await clean();
}
main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  console.log(OUT.join('\n'));
  console.log(`\n${OUT.filter((l) => l.startsWith('PASS')).length} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
