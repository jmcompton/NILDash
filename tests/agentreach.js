'use strict';
// Runs against the local test Postgres. No network.
//
//   node tests/run.js             every suite, against the committed baseline
//   node tests/agentreach.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE ADMIN COUNTER COUNTS WHAT THE AGENT DID ─────────────────────────────
// The Agent Activity "Outreach" column and the funnel's "Sent outreach" step
// counted athlete_activity_log rows that only the ATHLETE portal writes, so an
// agent who had sent real outreach read 0. They now count emails that left,
// DM/call/programme cards marked sent, and businesses marked contacted.
const fs = require('fs');
const { execFileSync } = require('child_process');
const store = require(REPO + 'server/store.js');
const AR = require(REPO + 'server/services/agentReach.js');
const SF = require(REPO + 'server/services/signupFunnel.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');

const AG = 'rch-agent', OTHER = 'rch-other', A1 = 'rch-ath-1', A2 = 'rch-ath-2', QUIET = 'rch-quiet';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    for (const t of ['outreach_logs', 'outreach_queue', 'athlete_activity_log']) {
      await P.query(`DELETE FROM ${t} WHERE agent_id = ANY($1)`, [[AG, OTHER, QUIET]]).catch(() => {});
    }
    await P.query('DELETE FROM brand_engagement WHERE athlete_id = ANY($1)', [[A1, A2]]).catch(() => {});
    await P.query('DELETE FROM athletes WHERE id = ANY($1)', [[A1, A2]]).catch(() => {});
    await P.query('DELETE FROM users WHERE id = ANY($1)', [[AG, OTHER, QUIET]]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES
    ($1,'Kay Reed','rch-a@x.com','x','agent'),($2,'Other Agent','rch-o@x.com','x','agent'),($3,'Quiet Agent','rch-q@x.com','x','agent')`,
  [AG, OTHER, QUIET]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,'{"name":"Amari Allen"}'),($3,$4,'{"name":"Jo Doe"}')`, [A1, AG, A2, OTHER]);

  // EMAILS. Counted only when they left.
  const log = (id, agent, extra) => P.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, approved_at, sent_at)
     VALUES ($1, $2, $3, 'B', $4, $5, $6)`, [id, agent, agent === AG ? A1 : A2, ...extra]);
  await log('rch-e1', AG, ['sent', new Date(), new Date()]);      // approved, then released
  await log('rch-e2', AG, ['sent', null, new Date()]);            // sent by hand
  await log('rch-e3', AG, ['approved', new Date(), null]);        // approved, never left
  await log('rch-e4', AG, ['draft', null, null]);                 // a draft
  await log('rch-e5', OTHER, ['sent', null, new Date()]);         // somebody else's
  // CARDS. DM, call and programme marked sent count; an email card does not.
  let slot = 0;
  const card = (agent, state, via, channel) => P.query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state, sent_via)
     VALUES ($1, $2, $3, $4, $4, $5, $6, $7)`, [agent, agent === AG ? A1 : A2, ++slot, 'rch b' + slot, channel, state, via]);
  await card(AG, 'sent', 'dm', 'dm');
  await card(AG, 'sent', 'call', 'call');
  await card(AG, 'sent', null, 'program');       // older rows carry no sent_via
  await card(AG, 'sent', 'email', 'email');      // marked sent AT APPROVAL: not counted
  await card(AG, 'queued', null, 'dm');
  await card(AG, 'skipped', null, 'dm');
  await card(OTHER, 'sent', 'dm', 'dm');
  // BUSINESSES CONTACTED. Owned through the athlete; distinct per athlete.
  const be = (athlete, key, state, agentId) => P.query(
    `INSERT INTO brand_engagement (agent_id, athlete_id, brand_key, brand_name, lane, state) VALUES ($1,$2,$3,$3,'local',$4)`,
    [agentId, athlete, key, state]);
  await be(A1, 'rch-x', 'contacted', AG);
  await be(A1, 'rch-y', 'responded', AG);
  await be(A1, 'rch-v', 'contacted', null);      // agent_id never recorded: still Amari's agent
  await be(A1, 'rch-z', 'shown', AG);            // shown is not contacted
  await be(A2, 'rch-w', 'contacted', AG);        // a stray agent_id on ANOTHER agent's athlete
  // ATHLETE-PORTAL ACTIVITY: what the old column counted. No longer counted.
  await P.query(`INSERT INTO athlete_activity_log (athlete_id, agent_id, activity_type) VALUES
    ($1,$2,'outreach_written'),($1,$2,'email_sent'),($1,$2,'email_sent')`, [A1, AG]);

  // ── 1. THE THREE NUMBERS ────────────────────────────────────────────────
  OUT.push('-- what an agent sent or reached --');
  const q = async (id) => (await P.query(`SELECT u.id, ${AR.COLUMNS} FROM users u ${AR.LATERAL} WHERE u.id = $1`, [id])).rows[0];
  const r = await q(AG);
  ok('EMAILS: the released one and the hand-sent one, not the approved-but-unsent, the draft, or another agent\'s',
    r.emails_sent === 2, r);
  ok('CARDS: DM, call and programme marked sent; not the email card marked at approval, not queued or skipped',
    r.cards_sent === 3, r);
  ok('CONTACTED: three businesses, including one whose engagement row never recorded an agent',
    r.contacted === 3, r);
  ok('  a stray agent_id on another agent\'s athlete does not count for this one',
    (await q(OTHER)).contacted === 1);
  const quiet = await q(QUIET);
  ok('an agent who did nothing reads zero on all three', quiet.emails_sent === 0 && quiet.cards_sent === 0 && quiet.contacted === 0, quiet);
  ok('athlete-portal activity rows no longer count toward any of them', r.emails_sent + r.cards_sent === 5);

  // ── 2. THE FUNNEL STEP ──────────────────────────────────────────────────
  OUT.push('', '-- the funnel --');
  const base = { role: 'agent', last_login: new Date(), password_reset_required: false, athletes: 1, scans: 1 };
  const funnel = SF.buildFunnel([
    { id: 'a', email: 'a@x', ...base, emails_sent: 1 },
    { id: 'b', email: 'b@x', ...base, cards_sent: 1 },
    { id: 'c', email: 'c@x', ...base, contacted: 1 },
    { id: 'd', email: 'd@x', ...base },
  ]);
  const step = (funnel.steps || []).find((s) => s.key === 'sent_outreach');
  ok('an email, a card or a contacted business each reaches the step; nothing does not', step && step.reached === 3, step);
  ok('  the step is renamed for what it counts', step && step.label === 'Sent or contacted a business', step && step.label);

  // ── 3. BOTH ENDPOINTS USE THE ONE DEFINITION ────────────────────────────
  OUT.push('', '-- wiring --');
  const idx = read('server/index.js');
  const act = idx.slice(idx.indexOf("app.get('/api/admin/agent-activity'"), idx.indexOf("app.get('/api/admin/signup-funnel'"));
  const fun = idx.slice(idx.indexOf("app.get('/api/admin/signup-funnel'"), idx.indexOf("app.post('/api/admin/archive-user'"));
  ok('Agent Activity uses the shared fragment', /\$\{AgentReach\.LATERAL\}/.test(act) && /\$\{AgentReach\.COLUMNS\}/.test(act));
  ok('  the funnel uses the same one', /\$\{AgentReach\.LATERAL\}/.test(fun) && /\$\{AgentReach\.COLUMNS\}/.test(fun));
  ok('  and neither still counts the athlete-portal rows', !/'outreach_written'/.test(act + fun));
  const admin = read('public/admin.html');
  ok('the column is renamed "Sent / contacted"', />Sent \/ contacted<\/th>/.test(admin) && !/>Outreach<\/th>/.test(admin));
  ok('  and both copies of the table render the three numbers', (admin.match(/reachCell\(u\) \+/g) || []).length === 2 && !/u\.outreach/.test(admin));

  // ── 4. THE RELEASE STATUS SCRIPT ────────────────────────────────────────
  OUT.push('', '-- send-status --');
  ok('send-status is registered with the admin script runner', /'send-status': \{ file: 'scripts\/send-status\.js'/.test(idx));
  const run = (env) => {
    try {
      return execFileSync(process.execPath, [REPO + 'scripts/send-status.js'],
        { encoding: 'utf8', env: { ...process.env, INIT_WAIT_MS: '5000', ...env }, timeout: 90000 });
    } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); }
  };
  // There is no release switch any more (approve means send). The one thing
  // that can still stop every send is the CAN-SPAM address, and it says so.
  const noAddr = run({ BUSINESS_MAILING_ADDRESS: '' });
  ok('no CAN-SPAM address: it says NO, and why', /NO\. The CAN-SPAM postal address is missing/.test(noAddr), noAddr.slice(-400));
  const withAddr = run({ BUSINESS_MAILING_ADDRESS: '1 Main St, Auburn, AL 36830' });
  ok('with an address it reports what is sending and what went', /CAN-SPAM postal address\s+->\s+set/.test(withAddr)
    && /sending now \(approved, not held\)\s+\d+/.test(withAddr) && /sent after approval, last day\s+\d+/.test(withAddr), withAddr.slice(-500));
  ok('  and nothing about a release switch', !/CLOSER_RELEASE_ENABLED/.test(withAddr));
  ok('  the per-agent table tells sending, sent and hand-sent apart', /rch-a@x\.com\s+1\s+0\s+1\s+1/.test(withAddr), (withAddr.match(/rch-a@x\.com.*/) || [])[0]);

  // ── 5. EVERY APPROVED EMAIL, ACCOUNTED FOR ──────────────────────────────
  OUT.push('', '-- approved-accounting --');
  ok('approved-accounting is registered with the admin script runner', /'approved-accounting': \{ file: 'scripts\/approved-accounting\.js'/.test(idx));
  const H = 3600000, now = Date.now(), ago = (ms) => new Date(now - ms);
  const acc = (id, extra) => P.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, approved_at, sent_at, sent_to_email, subject,
                                cadence_stopped_at, cadence_stop_reason, send_hold_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, AG, A1, ...extra]);
  await acc('rch-acc-sent', ['Acc Sent Deli', 'sent', ago(48 * H), ago(H / 6), 'sent@acc.x', 'Hi', null, null, null]);
  await acc('rch-acc-held', ['Acc Held Gym', 'approved', ago(48 * H), null, 'held@acc.x', 'Hi', null, null, '4-day rule']);
  await acc('rch-acc-dup', ['Acc Dup Cafe', 'approved', ago(48 * H), null, 'dup@acc.x', 'Same', ago(H / 6), '"Same" was already sent to dup@acc.x', null]);
  await acc('rch-acc-hand', ['Acc Dup Cafe', 'sent', null, ago(24 * H), 'dup@acc.x', 'Same', null, null, null]);
  await acc('rch-acc-early', ['Acc Early Bar', 'approved', ago(48 * H), null, 'early@acc.x', 'Hi', ago(24 * H), 'they replied before this went out', null]);
  await acc('rch-acc-wait', ['Acc Wait Shop', 'approved', ago(48 * H), null, 'wait@acc.x', 'Hi', null, null, null]);
  await P.query(`INSERT INTO email_sends (email, subject, subject_key, system, agent_id, ref_id, sent_at) VALUES
    ('sent@acc.x','Hi','hi','closer',$1,'rch-acc-sent',$2), ('dup@acc.x','Same','same','manual',$1,'rch-acc-hand',$3)`,
  [AG, ago(H / 6), ago(24 * H)]);
  let accOut;
  try {
    accOut = execFileSync(process.execPath, [REPO + 'scripts/approved-accounting.js', '--before=' + ago(H).toISOString()],
      { encoding: 'utf8', env: { ...process.env, INIT_WAIT_MS: '5000' }, timeout: 90000 });
  } catch (e) { accOut = String(e.stdout || '') + String(e.stderr || ''); }
  const line = (biz) => { const i = accOut.indexOf(biz); return i < 0 ? '' : accOut.slice(i, accOut.indexOf('\n', i)); };
  ok('sent after the cutoff reads SENT (release queue)', /SENT \(release queue\)/.test(line('Acc Sent Deli')), line('Acc Sent Deli'));
  ok('a hold reads HELD with its reason', /HELD/.test(line('Acc Held Gym')) && /4-day rule/.test(accOut), line('Acc Held Gym'));
  ok('a same-subject stop reads DEDUPED and names the hand-sent row it repeated',
    /DEDUPED/.test(line('Acc Dup Cafe')) && /earlier send: manual, row rch-acc-hand.*"sent by hand" count/.test(accOut), accOut.slice(-900));
  ok('a row stopped before the deploy is listed and says so', /STOPPED \(they replied\) -- before the deploy/.test(line('Acc Early Bar')), line('Acc Early Bar'));
  ok('an untouched one reads WAITING', /WAITING/.test(line('Acc Wait Shop')), line('Acc Wait Shop'));
  ok('the hand-sent row is not one of the approved set', !/Acc Dup Cafe[^\n]*SENT BY HAND/.test(accOut) && /rows in both: 0/.test(accOut));
  ok('  but it is reported as sharing an address with one', /hand-sent [^\n]*dup@acc\.x \(row rch-acc-hand\); approved row rch-acc-dup/.test(accOut));
  const ss = run({ BUSINESS_MAILING_ADDRESS: '1 Main St, Auburn, AL 36830' });
  ok('send-status now counts approved-then-stopped instead of dropping it', /approved, then stopped, not sent\s+\d+/.test(ss)
    && /APPROVED, THEN STOPPED, BY REASON/.test(ss) && /was already sent to dup@acc\.x/.test(ss), ss.slice(-700));
  await P.query(`DELETE FROM email_sends WHERE ref_id LIKE 'rch-acc-%'`).catch(() => {});

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('agentreach: FAILED', e); process.exit(1); });
