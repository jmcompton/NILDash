'use strict';
// ── NO PAID RESEARCH WHERE NOTHING CAN COME OF IT (NIGHTLY_SKIP_ON) ─────────
//
// The nightly run skips an agent with no connected mailbox (no email card of
// theirs can be sent) and an athlete whose name contains the word "Test",
// printing each skip and recording it on the night's row. Off: everyone is
// filled as before.
//
// The real run() and fillAgent, on a fresh database; fillAthlete (where the
// paid research happens) is replaced by a recorder.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('nightskiptest', { schema: true });
process.env.TZ = process.env.TZ || 'America/Chicago';
for (const k of ['NIGHTLY_SKIP_ON', 'HUNTER_PACE_ON', 'EMAIL_FIVE_ON', 'MARKET_MIX_ON']) delete process.env[k];
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const store = require(REPO + 'server/store');
const job = require(REPO + 'server/jobs/outreachQueue');
const S5 = require(REPO + 'server/services/shortOfFive');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 600) : '')); } };

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  // A: no mailbox. B: a connected Gmail. C: a disconnected one.
  for (const [id, name] of [['ns-a', 'Avery NoMail'], ['ns-b', 'Blair Mailbox'], ['ns-c', 'Casey Gone']]) {
    await P.query(`INSERT INTO users (id, name, email, password, role, last_login) VALUES ($1, $2, $3, 'x', 'agent', NOW())`, [id, name, id + '@x.test']);
  }
  await P.query(`INSERT INTO email_accounts (id, user_id, provider, email_address, status) VALUES ('ns-acct-b', 'ns-b', 'gmail', 'blair@agency.test', 'active'),
                 ('ns-acct-c', 'ns-c', 'gmail', 'casey@agency.test', 'disconnected')`);
  const roster = [['ns-a1', 'ns-a', 'Amber Real'], ['ns-b1', 'ns-b', 'Real Person'], ['ns-b2', 'ns-b', 'Test Athlete'],
    ['ns-b3', 'ns-b', 'Jo Testa'], ['ns-b4', 'ns-b', 'Marcus TEST'], ['ns-c1', 'ns-c', 'Casey Client']];
  for (const [id, ag, name] of roster) await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1, $2, $3::jsonb)`, [id, ag, JSON.stringify({ name })]);

  // The paid research, recorded instead of run.
  const researched = [];
  const realFill = job.fillAthlete;
  job.fillAthlete = async (pool, ctx) => { researched.push(ctx.athleteId); return { filled: 0, open: 5, tried: [], note: null }; };
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); realLog(...a); };

  console.log('\nNIGHTLY_SKIP_ON=1');
  process.env.NIGHTLY_SKIP_ON = '1';
  await job.run({ runDate: '2026-10-19' });
  const rows = new Map((await P.query(`SELECT agent_id, note, details FROM outreach_queue_runs WHERE run_date = '2026-10-19'`)).rows.map((r) => [r.agent_id, r]));
  ok('an agent with no mailbox: no paid research for any of their athletes', !researched.includes('ns-a1'), researched);
  ok('  the night\'s row says why', /^skipped: no connected mailbox/.test((rows.get('ns-a') || {}).note || ''), rows.get('ns-a'));
  ok('  and it was printed', logs.some((l) => /agent=ns-a skipped: no connected mailbox/.test(l)), logs.filter((l) => /ns-a/.test(l)));
  ok('a disconnected mailbox counts as none', !researched.includes('ns-c1') && /disconnected/.test((rows.get('ns-c') || {}).note || ''), rows.get('ns-c'));
  ok('an agent with a connected mailbox is researched', researched.includes('ns-b1'), researched);
  ok('  but not their test athletes ("Test Athlete", "Marcus TEST")', !researched.includes('ns-b2') && !researched.includes('ns-b4'), researched);
  ok('  "Jo Testa" is a surname, not a test athlete', researched.includes('ns-b3'), researched);
  ok('  each test athlete skip was printed', logs.some((l) => /athlete=ns-b2 "Test Athlete" skipped: a test athlete/.test(l)) && logs.some((l) => /athlete=ns-b4 "Marcus TEST" skipped/.test(l)));
  const det = ((rows.get('ns-b') || {}).details || []);
  const skippedRows = det.filter((d) => d.skipped === 'test-athlete').map((d) => d.athleteId).sort();
  ok('  and recorded on the night\'s row, spending nothing', JSON.stringify(skippedRows) === '["ns-b2","ns-b4"]' && det.filter((d) => d.skipped).every((d) => d.spentUsd === 0 && /test athlete/.test(d.note)), det);

  const rep = await S5.collect(P, { now: Date.parse('2026-10-19T11:00:00Z') });
  ok('the 5:30 email does not list a test athlete as short (Jo Testa still is)', !rep.short.some((s) => ['Test Athlete', 'Marcus TEST'].includes(s.athlete))
    && rep.short.some((s) => s.athlete === 'Jo Testa'), rep.short.map((s) => s.athlete));
  ok('  it counts them, and the two mailbox-less agents, as not filled by design', rep.skippedByDesign === 4, rep.skippedByDesign);
  const msg = S5.render(rep);
  ok('the 5:30 email prints what was skipped, each by name and why', /SKIPPED LAST NIGHT, NO PAID RESEARCH: 4/.test(msg.text)
    && /Avery NoMail: no connected mailbox \(no mailbox is connected\)/.test(msg.text)
    && /Casey Gone: no connected mailbox \(the mailbox is disconnected/.test(msg.text)
    && /Blair Mailbox \/ Test Athlete: a test athlete \(the name contains "Test"\)/.test(msg.text)
    && /Blair Mailbox \/ Marcus TEST: a test athlete/.test(msg.text), msg.text);
  ok('  and the email goes because something was skipped', S5.needsEmail({ short: [], backfills: [], skips: rep.skips }));

  console.log('\nswitch off');
  delete process.env.NIGHTLY_SKIP_ON;
  researched.length = 0;
  await job.run({ runDate: '2026-10-20' });
  ok('everyone is researched as before', ['ns-a1', 'ns-b1', 'ns-b2', 'ns-b3', 'ns-b4', 'ns-c1'].every((id) => researched.includes(id)), researched);
  const offRows = (await P.query(`SELECT note FROM outreach_queue_runs WHERE run_date = '2026-10-20'`)).rows;
  ok('  and no night is marked skipped for a mailbox', !offRows.some((r) => /no connected mailbox/.test(r.note || '')), offRows);

  console.log = realLog;
  job.fillAthlete = realFill;
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
