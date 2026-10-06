'use strict';
//   node tests/approvedbacklog.js
//
// ── THE SEPTEMBER 23 BACKLOG ────────────────────────────────────────────────
// Approved, never sent, 13 days old. Nothing is sent: each row is re-decided
// once (a fresh unapproved draft, a call card, a DM card, or nothing) and the
// old row is closed so the morning alert stops reporting it.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const store = require(REPO + 'server/store.js');
const B = require(REPO + 'server/services/approvedBacklog.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 800) : '')); } };
const AG = 'bl-agent', ATH = 'bl-ath';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    for (const t of ['outreach_logs', 'outreach_queue']) await P.query(`DELETE FROM ${t} WHERE agent_id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM email_suppression WHERE email = 'gone@bounced.test'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'Jabree B','jabree.bl@belcher.test','x','agent')`, [AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data,created_at) VALUES ($1,$2,$3,NOW())`, [ATH, AG, JSON.stringify({ name: 'Mataya G', school: 'Alabama', dob: '2004-09-02' })]);
  const old = async (id, brand, to, why) => P.query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,approved_at,scheduled_send_at,cadence_stopped_at,cadence_stop_reason,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'approved',$7,'2026-09-23 15:00:00-05','2026-09-23 15:00:00-05',$8,$9,'2026-09-22')`,
    [id, AG, ATH, brand, 'Idea for ' + brand, `<p>Hi there,</p><p>${brand} is close to campus. Would you be open to a few posts with Mataya? A short call would be great.</p>`,
      to, why ? '2026-09-23 15:05:00-05' : null, why]);
  await old('bl-1', 'Had Address Co', 'owner@hadaddress.test', null);
  await old('bl-2', 'Phone Only Grill', null, 'no address to send to');
  await P.query(`INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,phone,outreach_log_id,contact_name)
                 VALUES ($1,$2,1,'name:phone only grill','Phone Only Grill','email','sending','205-555-0123','bl-2','Pat')`, [AG, ATH]);
  await old('bl-3', 'Findable Bakery', null, 'no address to send to');
  await old('bl-4', 'Gram Only Studio', null, 'no address to send to');
  await old('bl-5', 'Nowhere Shop', null, 'no address to send to');
  await old('bl-6', 'Bounced Bar', 'gone@bounced.test', null);
  await require(REPO + 'server/services/suppression.js').suppress(P, 'gone@bounced.test', { reason: 'hard bounce', kind: 'bounce' });
  await old('bl-8', 'Nameless Gym', null, 'no address to send to');
  await old('bl-7', 'Later Day', null, 'no address to send to');
  await P.query(`UPDATE outreach_logs SET approved_at = '2026-09-25 15:00:00-05' WHERE id = 'bl-7'`);

  const looked = [];
  const lookup = async (r) => {
    looked.push(r.brand_name);
    if (r.brand_name === 'Findable Bakery') return { email: 'hello@findable.test', phone: null, instagram: null, costUsd: 0.075 };
    if (r.brand_name === 'Gram Only Studio') return { email: null, phone: null, instagram: 'gramonly', contactName: 'Gina Park', costUsd: 0.075 };
    if (r.brand_name === 'Nameless Gym') return { email: null, phone: '205-555-0999', instagram: null, contactName: null, costUsd: 0.075 };
    return { email: null, phone: null, instagram: null, costUsd: 0.075 };
  };

  // ── DRY RUN ───────────────────────────────────────────────────────────────
  const dry = await B.run(P, { date: '2026-09-23', lookup });
  ok('the dry run finds the day\'s rows and only them', dry.rows === 7 && !dry.results.some((r) => r.brand === 'Later Day'), dry.results.map((r) => r.brand));
  ok('  changes nothing and looks nothing up', looked.length === 0 && (await P.query(`SELECT COUNT(*)::int n FROM outreach_logs WHERE agent_id = $1 AND status = 'approved'`, [AG])).rows[0].n === 8
    && /^DRY RUN/.test(B.format(dry)), B.format(dry));

  // ── APPLY ─────────────────────────────────────────────────────────────────
  const out = await B.run(P, { date: '2026-09-23', apply: true, lookup, today: '2026-10-06' });
  const by = Object.fromEntries(out.results.map((r) => [r.brand, r]));
  ok('LOOKED UP ONCE, only where there was no sendable address', looked.sort().join() === ['Bounced Bar', 'Findable Bakery', 'Gram Only Studio', 'Nameless Gym', 'Nowhere Shop', 'Phone Only Grill'].sort().join()
    && out.lookups === 6, looked);
  const drafts = (await P.query(`SELECT * FROM outreach_logs WHERE agent_id = $1 AND status = 'draft'`, [AG])).rows;
  const fresh = (b) => drafts.find((d) => d.brand_name === b);
  ok('AN ADDRESS ON THE ROW -> a fresh draft dated today, unapproved, the same email', fresh('Had Address Co') && fresh('Had Address Co').sent_to_email === 'owner@hadaddress.test'
    && !fresh('Had Address Co').approved_at && !fresh('Had Address Co').sent_at && /close to campus/.test(fresh('Had Address Co').body_html)
    && new Date(fresh('Had Address Co').created_at).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10), fresh('Had Address Co'));
  ok('AN ADDRESS FOUND BY THE ONE LOOKUP -> a fresh unapproved draft', fresh('Findable Bakery') && fresh('Findable Bakery').sent_to_email === 'hello@findable.test' && !fresh('Findable Bakery').approved_at);
  const q = (await P.query(`SELECT * FROM outreach_queue WHERE agent_id = $1 AND state = 'queued'`, [AG])).rows;
  const qc = (b) => q.find((x) => x.brand_name === b);
  ok('NO ADDRESS, A PHONE -> a call card', qc('Phone Only Grill') && qc('Phone Only Grill').channel === 'call' && qc('Phone Only Grill').phone === '205-555-0123', qc('Phone Only Grill'));
  ok('NO ADDRESS, A HANDLE -> a DM card with the message, opening with the person\'s name', qc('Gram Only Studio') && qc('Gram Only Studio').channel === 'dm'
    && /^Hi Gina,/.test(qc('Gram Only Studio').dm_text) && /close to campus/.test(qc('Gram Only Studio').dm_text), qc('Gram Only Studio'));
  ok('  no named person: no card, through the same rule as every card (insertCard), and the report says why', by['Nameless Gym'].becomes === 'nothing to reach'
    && !qc('Nameless Gym') && /could not be written: /.test(by['Nameless Gym'].note || ''), by['Nameless Gym']);
  ok('A BOUNCED ADDRESS IS NOT SENT TO AGAIN; nothing else found -> no card, said so', by['Bounced Bar'].becomes === 'nothing to reach' && !fresh('Bounced Bar') && !qc('Bounced Bar')
    && by['Nowhere Shop'].becomes === 'nothing to reach', [by['Bounced Bar'], by['Nowhere Shop']]);
  const closed = (await P.query(`SELECT id, status, cadence_stop_reason FROM outreach_logs WHERE id LIKE 'bl-%' ORDER BY id`)).rows;
  ok('EVERY OLD ROW IS CLOSED with the reason (the other day\'s row untouched)', closed.filter((r) => r.id !== 'bl-7').every((r) => r.status === 'expired' && /^closed 2026-10-06: approved 2026-09-23, never sent/.test(r.cadence_stop_reason))
    && closed.find((r) => r.id === 'bl-7').status === 'approved', closed);
  ok('  the linked card that said Sending is closed too', (await P.query(`SELECT state FROM outreach_queue WHERE outreach_log_id = 'bl-2'`)).rows[0].state === 'expired');
  ok('NOTHING WAS APPROVED OR SENT', (await P.query(`SELECT COUNT(*)::int n FROM outreach_logs WHERE agent_id = $1 AND (sent_at IS NOT NULL OR (status = 'approved' AND id <> 'bl-7'))`, [AG])).rows[0].n === 0);
  const MA = require(REPO + 'server/services/morningAlert.js');
  const ma = await MA.collect(P);
  ok('THE MORNING ALERT STOPS REPORTING THEM', !JSON.stringify(ma.overdueSends || {}).includes('no address to send to') || (ma.overdueSends.total || 0) === 0, ma.overdueSends);
  const again = await B.run(P, { date: '2026-09-23', apply: true, lookup });
  ok('running it again does nothing twice', again.rows === 0, again.rows);

  const home = await B.onHome(P, 'jabree.bl@belcher.test');
  const m = home.byAthlete['Mataya G'] || {};
  ok('WHAT THE AGENT HAS NOW, by athlete: email cards with an address, call cards, DM cards', home.ok && m.email === 2 && m.emailToday === 2 && m.call === 1 && m.dm === 1, home);
  ok('  printed', /WHAT jabree\.bl@belcher\.test \(Jabree B\) HAS NOW:/.test(B.format(out, home)) && /Mataya G +2 email cards with an address \(2 dated today\), 1 call cards, 1 DM cards/.test(B.format(out, home)), B.format(out, home));
  ok('the admin script is registered, dry run unless apply=1', /'approved-unsent-backlog': \{ file: 'scripts\/approved-unsent-backlog\.js'/.test(require('fs').readFileSync(REPO + 'server/index.js', 'utf8')));
  await clean();
}

main().then(() => { console.log(OUT.join('\n')); console.log(`\nfailures: ${F}`); process.exit(F ? 1 : 0); })
  .catch((e) => { console.log(OUT.join('\n')); console.log('FAIL threw: ' + (e && e.stack)); process.exit(1); });
