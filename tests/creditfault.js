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
// THE INCIDENT, REPRODUCED.
//
// email_verify_credit_log did not exist in production (to_regclass -> NULL), so
// every COUNT threw, so accountStatus assigned verifyUsed = VERIFY_MONTHLY_CAP
// and the shift report said "1200 of 1200 checks used" every morning since the
// feature shipped. Not one credit had been spent.
//
// Half of this file drops the table to reproduce that exactly. The other half
// puts it back and checks the metering that should have been there.
process.env.HUNTER_API_KEY = process.env.HUNTER_API_KEY || 'test-key-not-used';

const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const VB = require(ROOT + 'server/services/verifyBudget.js');
const DA = require(ROOT + 'server/services/draftAddress.js');
const SR = require(ROOT + 'server/services/shiftReport.js');
const SE = require(ROOT + 'server/services/shiftEmail.js');
const hunter = require(ROOT + 'server/services/hunterLookup.js');

const out = [];
const check = (n, c, d) => { out.push({ n, ok: !!c }); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d !== undefined ? '   ' + d : '')); };

const AG = 'cf-agent';
const A1 = 'cf-ath-1', A2 = 'cf-ath-2';

// The real Hunter call is never made: draftAddress injects the verifier, so a
// counter here IS the credit meter, and it counts what actually reached the wire.
let hunterCalls = [];
const realVerify = hunter.verifyEmail;

async function seed(P) {
  for (const t of ['outreach_logs', 'brand_evidence_cache']) {
    await P.query(`DELETE FROM ${t} WHERE ${t === 'outreach_logs' ? 'agent_id' : 'brand_key'} `
      + `${t === 'outreach_logs' ? '= $1' : "LIKE 'cf-%'"}`, t === 'outreach_logs' ? [AG] : []).catch(() => {});
  }
  await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'J','cf@x.com','x','agent','America/Chicago')`, [AG]);
  for (const [id, nm] of [[A1, 'Amber Bretton'], [A2, 'Devon Pike']]) {
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
      [id, AG, JSON.stringify({ name: nm, school: 'Alabama', dob: '2004-09-02' })]);
  }
}

// Drafts with no address, plus a cached siteemail row per brand so lookupMany
// finds one without any network.
async function resetVerdicts(P) {
  // NINETY-DAY VERDICT CACHE. verifyMany skips the verifier entirely for an
  // address it already has an answer for, so without this a second run of this
  // file measures the cache and reports it as the budget.
  await P.query(`DELETE FROM email_verification WHERE email LIKE 'nildash-cf-%'`).catch(() => {});
}

async function draftsFor(P, athleteId, n, tag) {
  for (let i = 0; i < n; i++) {
    const brand = `CF ${tag} ${i}`;
    await P.query(
      `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,created_at)
       VALUES ($1,$2,$3,$4,'S','<p>b</p>','draft',NOW())`,
      [`cf-l-${tag}-${i}`, AG, athleteId, brand]);
    await P.query(
      `INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at)
       VALUES ($1,'siteemail',$2,$3,'OK',NOW())
       ON CONFLICT (brand_key, lane) DO UPDATE SET evidence = EXCLUDED.evidence, refreshed_at = NOW()`,
      // A DOMAIN WITH REAL MX. The free MX check runs before Hunter and is not
      // budgeted, so addresses on a reserved TLD like .example are rejected as
      // "domain does not exist" and never reach the paid check at all -- which
      // would make this file report zero credits for the wrong reason. Distinct
      // local parts on one MX-valid domain isolate the thing under test.
      [`cf-${tag}-${i}`, brand,
        JSON.stringify({ email: `nildash-cf-${tag}-${i}@gmail.com`, kind: 'generic' })]);
  }
}

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await seed(P);
  await resetVerdicts(P);

  // ── 1. THE PRODUCTION STATE ───────────────────────────────────────────────
  console.log('\n1. WITH THE TABLE MISSING, AS IT WAS IN PRODUCTION');
  await P.query(`DROP TABLE IF EXISTS email_verify_credit_log`);
  const gone = (await P.query(`SELECT to_regclass('public.email_verify_credit_log') AS t`)).rows[0].t;
  check('the table really is absent', gone === null, JSON.stringify(gone));

  const broken = await VB.accountStatus(P);
  check('it does NOT report a spent month', broken.exhausted === false, 'exhausted=' + broken.exhausted);
  check('  it reports a FAULT', broken.unknown === true, 'unknown=' + broken.unknown);
  check('  verifyUsed is null, never a figure to be believed',
    broken.verifyUsed === null, JSON.stringify(broken.verifyUsed));
  check('  and the sentence says nothing has been spent',
    /Nothing has been spent|nothing has been spent/i.test(broken.line), broken.line);
  check('  it never prints "1200 of 1200"', !/1200 of 1200/.test(broken.line), broken.line);
  check('spentToday says UNKNOWN, not "already spent"',
    (await VB.spentToday(P, A1, '2026-08-27')) === null);

  // The old failure mode, stated as the thing that must not come back.
  check('THE REGRESSION GUARD: a read failure is never the cap',
    broken.verifyUsed !== VB.VERIFY_MONTHLY_CAP, 'cap=' + VB.VERIFY_MONTHLY_CAP);

  await draftsFor(P, A1, 4, 'x');
  hunterCalls = [];
  hunter.verifyEmail = async (e) => { hunterCalls.push(e); return { ok: true, status: 'valid' }; };
  const r1 = await DA.attach(P, { agentId: AG, athleteId: A1, budget: VB.PER_ATHLETE_DAY, limit: 50 });
  check('NOT ONE CREDIT is spent while the meter is broken', hunterCalls.length === 0,
    'hunter calls=' + hunterCalls.length);
  check('  and the reason given is the fault, not a budget',
    r1.budget && r1.budget.boundBy === 'meter-fault', r1.budget && r1.budget.boundBy);
  check('addresses are still attached — an outage is not an empty queue',
    r1.attached === 4, 'attached=' + r1.attached + ' rejected=' + r1.rejected);

  const repBroken = await SR.buildShiftReport(P, AG);
  check('the shift report surfaces the fault', !!(repBroken.verifyBudget && repBroken.verifyBudget.unknown),
    JSON.stringify(repBroken.verifyBudget && repBroken.verifyBudget.line));
  const mailBroken = SE.renderShiftEmail(repBroken, { agentName: 'J' });
  check('  the email says nothing has been spent', /Nothing has been spent/.test(mailBroken.html));
  check('  and never claims a spent month', !/1200 of 1200/.test(mailBroken.html));

  // ── 2. THE TABLE IS CREATED BY THE NORMAL PATH ────────────────────────────
  console.log('\n2. THE MIGRATION, NOT A LAZY CALL FROM ONE BRANCH');
  const src = require('fs').readFileSync(ROOT + 'server/store.js', 'utf8');
  check('store.js creates it alongside the other tables',
    /CREATE TABLE IF NOT EXISTS email_verify_credit_log/.test(src));
  check('  and says so at init like the rest',
    /\[init\] email_verify_credit_log table ready/.test(src));
  // PROVED BY RUNNING IT, not by reading it. store.init() is not exported -- it
  // runs on require -- so a fresh process that does nothing but require store.js
  // is exactly what a deploy does. The table is still dropped at this point.
  const stillGone = (await P.query(`SELECT to_regclass('public.email_verify_credit_log') AS t`)).rows[0].t;
  check('  (still absent going in)', stillGone === null);
  require('child_process').execFileSync(process.execPath,
    // Interpolated, not referenced: this string is evaluated in a CHILD process
    // where REPO does not exist.
    ['-e', `require(${JSON.stringify(ROOT + 'server/store.js')}); setTimeout(() => process.exit(0), 7000);`],
    { env: { ...process.env, NODE_PATH: ROOT + 'node_modules' }, stdio: 'ignore', timeout: 60000 });
  const back = (await P.query(`SELECT to_regclass('public.email_verify_credit_log') AS t`)).rows[0].t;
  check('a plain startup creates it — no code path has to be exercised first',
    back !== null, JSON.stringify(back));
  const idx = (await P.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'email_verify_credit_log' ORDER BY 1`)).rows;
  check('  with the two indexes the budget reads use', idx.length >= 3,
    JSON.stringify(idx.map((r) => r.indexname)));

  // ── 3. METERING, ONCE IT CAN COUNT ────────────────────────────────────────
  console.log('\n3. THE PER-ATHLETE CEILING');
  await P.query(`DELETE FROM email_verify_credit_log`);
  await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]);
  await resetVerdicts(P);
  await draftsFor(P, A1, 6, 'y');
  hunterCalls = [];
  const r2 = await DA.attach(P, { agentId: AG, athleteId: A1, budget: VB.PER_ATHLETE_DAY, limit: 50 });
  check('six drafts, three credits', hunterCalls.length === 3, 'hunter calls=' + hunterCalls.length);
  check('  every one of them logged', (await P.query(
    `SELECT COUNT(*)::int n FROM email_verify_credit_log`)).rows[0].n === 3);
  check('  the rest are skipped, not silently spent', r2.creditsSkipped === 3, r2.creditsSkipped);

  hunterCalls = [];
  await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]);
  await draftsFor(P, A1, 4, 'z');
  await DA.attach(P, { agentId: AG, athleteId: A1, budget: VB.PER_ATHLETE_DAY, limit: 50 });
  check('a SECOND load the same day spends nothing more', hunterCalls.length === 0,
    'hunter calls=' + hunterCalls.length);

  // ── 4. THE UNMETERED DRAIN ────────────────────────────────────────────────
  console.log('\n4. THE CLOSER BACKFILL IS BUDGETED NOW');
  await P.query(`DELETE FROM email_verify_credit_log`);
  await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]);
  await resetVerdicts(P);
  // The shape that drained the account: a backfill spanning the roster, called
  // with no athleteId and no budget, exactly as closer.buildBatch calls it.
  await draftsFor(P, A1, 10, 'p');
  await draftsFor(P, A2, 10, 'q');
  hunterCalls = [];
  const r3 = await DA.attach(P, { agentId: AG, limit: 300 });
  check('20 drafts across 2 athletes no longer buy 20 credits',
    hunterCalls.length === 6, 'hunter calls=' + hunterCalls.length);
  check('  it is the per-athlete ceiling, applied per athlete', hunterCalls.length === 2 * VB.PER_ATHLETE_DAY);
  const logged = (await P.query(
    `SELECT athlete_id, COUNT(*)::int n, MIN(source) src FROM email_verify_credit_log
      GROUP BY athlete_id ORDER BY athlete_id`)).rows;
  check('  every credit is logged AND attributed to an athlete',
    logged.length === 2 && logged.every((x) => x.n === 3 && x.athlete_id), JSON.stringify(logged));
  check('  and names the caller that spent it',
    logged.every((x) => x.src === 'closer-backfill'), JSON.stringify(logged.map((x) => x.src)));
  check('  addresses still attach for all 20', r3.attached === 20, 'attached=' + r3.attached);

  console.log('\n   THE REGRESSION GUARD: no unbudgeted branch is left');
  // CODE ONLY. The old condition is quoted in a comment above the replacement,
  // deliberately -- that comment is the record of why the branch is gone -- so a
  // whole-file match finds its own documentation and reports a regression.
  const daCode = require('fs').readFileSync(ROOT + 'server/services/draftAddress.js', 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('attach has no "only budget when asked" condition left in the code',
    !/if\s*\(\s*opts\.athleteId\s*&&\s*Number\.isFinite\(opts\.budget\)\s*\)/.test(daCode));

  // ── 5. HUNTER'S OWN CEILING CAN SEE IT ────────────────────────────────────
  console.log('\n5. VERIFICATION IS VISIBLE TO THE HUNTER CEILING');
  const acct = await hunter.accountUsedThisMonth(true);
  check('the account total counts verifications', acct.verify === 6, JSON.stringify(acct));
  check('  separately from domain searches', typeof acct.ladder === 'number', JSON.stringify(acct));
  check('  and sums them', acct.used === acct.ladder + acct.verify, JSON.stringify(acct));
  const bs = await hunter.budgetStatus();
  check('budgetStatus reports the shared plan, not one consumer',
    bs.used === acct.used && bs.verifyUsed === 6, JSON.stringify(bs));
  const hlSrc = require('fs').readFileSync(ROOT + 'server/services/hunterLookup.js', 'utf8');
  check('THE REGRESSION GUARD: the ceiling check reads both consumers',
    /const acct = await accountUsedThisMonth\(\);/.test(hlSrc) && /acct\.used >= MONTHLY_BUDGET/.test(hlSrc));

  // ── 6. A CREDIT THAT CANNOT BE RECORDED IS NOT SPENT ──────────────────────
  console.log('\n6. NEVER SPEND WHAT YOU CANNOT COUNT');
  await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]);
  await P.query(`DELETE FROM email_verify_credit_log`);
  await resetVerdicts(P);
  await draftsFor(P, A2, 5, 'w');
  // The log readable at the start of the pass and gone by the time a credit is
  // committed -- the exact window in which the old code spent and lost the row.
  const realQuery = P.query.bind(P);
  let armed = false;
  P.query = async (sql, params) => {
    if (armed && typeof sql === 'string' && /INSERT INTO email_verify_credit_log/.test(sql)) {
      throw new Error('relation "email_verify_credit_log" does not exist');
    }
    return realQuery(sql, params);
  };
  hunterCalls = [];
  armed = true;
  const r4 = await DA.attach(P, { agentId: AG, athleteId: A2, budget: VB.PER_ATHLETE_DAY, limit: 50 });
  armed = false;
  P.query = realQuery;
  check('an unrecordable credit is never spent', hunterCalls.length === 0,
    'hunter calls=' + hunterCalls.length);
  check('  and the pass stops rather than bleeding', r4.creditsSpent === 0, r4.creditsSpent);
  check('  addresses still attach', r4.attached === 5, 'attached=' + r4.attached);

  hunter.verifyEmail = realVerify;
  const failed = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - failed.length) + '/' + out.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
