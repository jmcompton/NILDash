'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// The 7-day draft expiry, against real Postgres. This sweep has been wired into
// production for some time at 21 days and, at the current write rate, has almost
// certainly never expired a row -- so it has never actually run. Prove it does
// what it says before lowering the number that makes it fire.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const SR = require(ROOT + 'server/services/shiftReport.js');
const Home = require(ROOT + 'server/services/homeQueue.js');

const AG = 'exp-agent', AG2 = 'exp-other';
const ATH = 'exp-ath', ATH2 = 'exp-ath2';
const out = [];
const check = (n, c, d) => { out.push({ n, ok: !!c }); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d ? '   ' + d : '')); };

async function seed(P) {
  for (const t of ['outreach_logs', 'outreach_queue', 'brand_match_scores', 'athletes'])
    for (const a of [AG, AG2]) await P.query(`DELETE FROM ${t} WHERE agent_id=$1`, [a]).catch(() => {});
  for (const a of [AG, AG2]) await P.query(`DELETE FROM users WHERE id=$1`, [a]).catch(() => {});
  for (const a of [AG, AG2])
    await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'A',$2,'x','agent')`,
      [a, a + '@x.com']);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
    [ATH, AG, JSON.stringify({ name: 'Marcus Johnson', school: 'Alabama', dob: '2004-09-02' })]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
    [ATH2, AG2, JSON.stringify({ name: 'Other Athlete', school: 'Auburn', dob: '2004-01-01' })]);

  // ageDays, status, agent
  const rows = [
    ['fresh-1',   0.5, 'draft',    AG],
    ['fresh-2',   3,   'draft',    AG],
    ['edge-just', 6.9, 'draft',    AG],   // inside the window by hours
    ['edge-over', 7.1, 'draft',    AG],   // outside by hours
    ['old-1',    12,   'draft',    AG],
    ['old-2',    40,   'draft',    AG],
    ['sent-old', 40,   'sent',     AG],   // sent long ago -- must not be touched
    ['appr-old', 40,   'approved', AG],   // approved and waiting on the send window
    ['repl-old', 40,   'replied',  AG],
    ['exp-old',  40,   'expired',  AG],   // already expired -- must not churn
    ['other-ag', 40,   'draft',    AG2],  // a different agent
  ];
  for (const [id, age, status, ag] of rows) {
    await P.query(
      // ADDRESSED, because Home now withholds a card with no recipient. Before
      // that gate an addressless draft still rendered, so this seed did not need
      // one; it does now, and the behaviour change is the point rather than a
      // regression. A real resolvable domain so MX is a genuine answer.
      `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_to_email, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'A partnership idea','<p>Hi there,</p><p>Real body worth keeping.</p>',$5,$7,
               NOW() - ($6 || ' hours')::interval, NOW() - ($6 || ' hours')::interval)`,
      [id, ag, ag === AG ? ATH : ATH2, 'Brand ' + id, status, String(Math.round(age * 24)),
       'owner@' + id.replace(/[^a-z0-9]/g, '') + '.mynildash.com']);
  }
}

const statusOf = async (P, id) => (await P.query('SELECT status, body_html, updated_at FROM outreach_logs WHERE id=$1', [id])).rows[0];

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await seed(P);

  console.log('DRAFT_EXPIRY_DAYS = ' + SR.DRAFT_EXPIRY_DAYS);
  check('default is 7', SR.DRAFT_EXPIRY_DAYS === 7);

  const auditBefore = await SR.buildDraftAudit(P, AG, async (l, s, p) => (await P.query(s, p)).rows);
  console.log('  before: pending=' + auditBefore.pending + ' stale=' + auditBefore.stale
    + ' expired=' + auditBefore.expired + ' oldestDays=' + auditBefore.oldestDraftAgeDays);
  check('audit sees the stale ones before the sweep', auditBefore.stale === 3, 'stale=' + auditBefore.stale);
  check('audit reports the expiry window it will use', auditBefore.expiryDays === 7);

  const beforeUpdated = (await statusOf(P, 'exp-old')).updated_at;

  const n = await SR.expireStaleDrafts(P, null);
  console.log('  swept: ' + n + ' row(s)');
  check('expired exactly the four drafts past 7 days across both agents', n === 4, 'n=' + n);

  check('0.5-day draft untouched',  (await statusOf(P, 'fresh-1')).status === 'draft');
  check('3-day draft untouched',    (await statusOf(P, 'fresh-2')).status === 'draft');
  check('6.9-day draft untouched — the boundary is not off by a day',
    (await statusOf(P, 'edge-just')).status === 'draft');
  check('7.1-day draft expired',    (await statusOf(P, 'edge-over')).status === 'expired');
  check('12-day draft expired',     (await statusOf(P, 'old-1')).status === 'expired');
  check('40-day draft expired',     (await statusOf(P, 'old-2')).status === 'expired');

  check('a sent email is never expired',     (await statusOf(P, 'sent-old')).status === 'sent');
  check('an approved email awaiting its send window is never expired',
    (await statusOf(P, 'appr-old')).status === 'approved');
  check('a replied email is never expired',  (await statusOf(P, 'repl-old')).status === 'replied');
  check('an already-expired row does not churn',
    String((await statusOf(P, 'exp-old')).updated_at) === String(beforeUpdated));
  check('the other agent was swept too (the job runs with agentId null)',
    (await statusOf(P, 'other-ag')).status === 'expired');

  const body = (await statusOf(P, 'old-2')).body_html;
  check('the body is kept — expiry is a status change, not a delete',
    /Real body worth keeping/.test(body));

  // Scoped sweep, the per-agent form.
  await P.query(`UPDATE outreach_logs SET status='draft' WHERE id='other-ag'`);
  const n2 = await SR.expireStaleDrafts(P, AG);
  check('a sweep scoped to one agent leaves the other alone',
    n2 === 0 && (await statusOf(P, 'other-ag')).status === 'draft', 'n2=' + n2);
  await P.query(`UPDATE outreach_logs SET status='expired' WHERE id='other-ag'`);

  const auditAfter = await SR.buildDraftAudit(P, AG, async (l, s, p) => (await P.query(s, p)).rows);
  console.log('  after:  pending=' + auditAfter.pending + ' stale=' + auditAfter.stale
    + ' expired=' + auditAfter.expired + ' oldestDays=' + auditAfter.oldestDraftAgeDays);
  check('nothing stale is left', auditAfter.stale === 0);
  check('the expired count is now visible in the audit', auditAfter.expired === 4, 'expired=' + auditAfter.expired);
  check('pending dropped by exactly the three swept', auditAfter.pending === auditBefore.pending - 3,
    auditBefore.pending + ' -> ' + auditAfter.pending);

  // The thing that actually matters to an agent: an expired draft must not be
  // offered for approval.
  const h = await Home.buildHome(P, AG, { athleteId: ATH });
  const shown = (h.cards || []).map((c) => c.business);
  check('Home offers no expired draft',
    !shown.some((b) => /old-1|old-2|edge-over/.test(String(b))), shown.join(', ') || '(none)');
  check('Home still offers the fresh ones', shown.length === 3, 'cards=' + shown.length);

  // Idempotence: a second sweep in the same 6-hour tick must be a no-op.
  const n3 = await SR.expireStaleDrafts(P, null);
  check('a repeat sweep expires nothing', n3 === 0, 'n3=' + n3);

  const bad = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - bad.length) + '/' + out.length + ' passed');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
