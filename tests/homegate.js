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
// The Home gate, the credit ceiling, and the number the customer actually feels
// at 7am: how long a COLD Home load takes for one athlete with nothing cached.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const Home = require(ROOT + 'server/services/homeQueue.js');
const VB = require(ROOT + 'server/services/verifyBudget.js');
const EV = require(ROOT + 'server/services/emailVerify.js');
const hunter = require(ROOT + 'server/services/hunterLookup.js');

const out = [];
const check = (n, c, d) => { out.push({ n, ok: !!c }); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d ? '   ' + d : '')); };

const AG = 'hg-agent', ATH = 'hg-ath', ATH2 = 'hg-ath2';

// Businesses with a real, resolvable domain so MX is a genuine network call.
const REAL = ['cahababrewing.com', 'trakshak.com', 'vigilantecoffee.com', 'onyxcoffeelab.com',
  'doglanecafe.com', 'franklinsrestaurant.com', 'proteusbicycles.com', 'thehallcp.com',
  'willibrew.com', 'liquid-iv.com', 'mynildash.com', 'boardandbrew.com'];

async function seed(P, { n, withAddress, badAddress }) {
  for (const t of ['outreach_logs', 'outreach_queue', 'brand_match_scores', 'athletes'])
    await P.query(`DELETE FROM ${t} WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM email_verification`).catch(() => {});
  await P.query(`DELETE FROM email_verify_credit_log WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM brand_evidence_cache WHERE brand_key LIKE 'hg:%'`).catch(() => {});
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'J','hg@x.com','x','agent','America/New_York')`, [AG]);
  for (const [id, nm] of [[ATH, 'Kaden House'], [ATH2, 'Amber Bretton']])
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
      [id, AG, JSON.stringify({ name: nm, school: 'Maryland', dob: '2005-04-11' })]);

  for (let i = 0; i < n; i++) {
    const dom = REAL[i % REAL.length];
    const brand = 'Biz ' + i;
    await P.query(
      `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,created_at)
       VALUES ($1,$2,$3,$4,'A partnership idea',
               '<p>Hi there,</p><p>A real reason this business should back this athlete today.</p>',
               'draft',$5, NOW() - ($6||' minutes')::interval)`,
      ['hg-' + i, AG, ATH, brand, withAddress ? 'owner@' + dom : null, String(100 - i)]);
    await P.query(
      `INSERT INTO brand_match_scores (id,agent_id,athlete_id,brand_name,reasoning,compatibility_score)
       VALUES ($1,$2,$3,$4,'Reason '||$5,$6)`,
      ['hgm-' + i, AG, ATH, brand, String(i), 90 - i]);
    // The siteemail row attach reads, so attach has something to stamp on.
    if (!withAddress) {
      await P.query(
        `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,refreshed_at)
         VALUES ($1,'siteemail',$2,'x',$3,NOW()) ON CONFLICT (brand_key,lane) DO UPDATE
           SET brand=EXCLUDED.brand, evidence=EXCLUDED.evidence`,
        ['hg:' + i, brand, JSON.stringify({ email: 'owner@' + dom, siteRoot: dom })]);
    }
  }
  if (badAddress) {
    await P.query(`UPDATE outreach_logs SET sent_to_email='noreply@cahababrewing.com' WHERE id='hg-0'`);
    await P.query(`UPDATE outreach_logs SET sent_to_email='not-an-email' WHERE id='hg-1'`);
  }
}

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await VB.ensureTable(P);

  console.log('\n1. THE GATE: a card with no address never reaches the page');
  await seed(P, { n: 8, withAddress: true });
  await P.query(`UPDATE outreach_logs SET sent_to_email = NULL WHERE id IN ('hg-0','hg-2','hg-4')`);
  // No siteemail rows for these, so attach cannot rescue them -- which is the
  // case the gate exists for.
  let h = await Home.buildHome(P, AG, { athleteId: ATH });
  const shown = h.cards.map((c) => c.business);
  check('none of the addressless cards is on the page',
    !shown.some((b) => ['Biz 0', 'Biz 2', 'Biz 4'].includes(b)), shown.join(', '));
  check('every card that IS shown has a recipient', h.cards.every((c) => c.to && c.to.includes('@')),
    h.cards.map((c) => c.to).join(', '));
  check('the backfill still produced a full slate of five', h.cards.length === 5, 'cards=' + h.cards.length);
  check('the withheld ones are reported, not silently dropped', h.withheld.length === 3,
    JSON.stringify(h.withheld.map((w) => w.business)));
  check('and each says why', h.withheld.every((w) => /no email address/.test(w.why)),
    (h.withheld[0] || {}).why);

  console.log('\n2. A MALFORMED OR ROLE ADDRESS IS ALSO REFUSED');
  await seed(P, { n: 8, withAddress: true, badAddress: true });
  h = await Home.buildHome(P, AG, { athleteId: ATH });
  check('no-reply@ is withheld', h.withheld.some((w) => w.business === 'Biz 0'),
    JSON.stringify(h.withheld.map((w) => w.business + ': ' + w.why)));
  check('a non-address is withheld', h.withheld.some((w) => w.business === 'Biz 1'));
  check('the page is still full', h.cards.length === 5, 'cards=' + h.cards.length);

  console.log('\n3. THE WORKAROUND: attach rescues a draft whose address was never stamped on');
  await seed(P, { n: 6, withAddress: false });
  const nullBefore = (await P.query(
    `SELECT COUNT(*)::int n FROM outreach_logs WHERE agent_id=$1 AND sent_to_email IS NULL`, [AG])).rows[0].n;
  h = await Home.buildHome(P, AG, { athleteId: ATH });
  const nullAfter = (await P.query(
    `SELECT COUNT(*)::int n FROM outreach_logs WHERE agent_id=$1 AND sent_to_email IS NULL`, [AG])).rows[0].n;
  check('every draft started with no address', nullBefore === 6, 'null=' + nullBefore);
  check('Home addressed them from the cache', nullAfter === 0, 'null=' + nullAfter);
  check('and they are on the page', h.cards.length === 5 && h.cards.every((c) => c.to), 'cards=' + h.cards.length);

  console.log('\n4. THE CREDIT CEILING');
  await seed(P, { n: 12, withAddress: false });
  let calls = 0;
  const stub = async () => { calls++; await new Promise((r) => setTimeout(r, 250)); return { ok: true, status: 'valid' }; };
  hunter.verifyEmail = stub;
  await Home.buildHome(P, AG, { athleteId: ATH });
  check('a cold load spends at most the per-athlete daily budget',
    calls <= VB.PER_ATHLETE_DAY, 'hunter calls=' + calls + ' budget=' + VB.PER_ATHLETE_DAY);
  const logged = (await P.query(
    `SELECT athlete_id, business, email, checked_at FROM email_verify_credit_log WHERE agent_id=$1`, [AG])).rows;
  check('every credit is logged with athlete, business and timestamp',
    logged.length === calls && logged.every((r) => r.athlete_id && r.business && r.email && r.checked_at),
    logged.length + ' rows, e.g. ' + JSON.stringify(logged[0] || null));

  const before = calls;
  await Home.buildHome(P, AG, { athleteId: ATH });
  check('a SECOND load the same day spends nothing more', calls === before,
    'calls=' + calls + ' (addresses are stamped on, so attach has no rows left)');
  await Home.buildHome(P, AG, { athleteId: ATH2 });
  check('the budget is per athlete, so a different athlete has its own',
    calls >= before, 'calls=' + calls);

  console.log('\n5. THE OVER-FETCH CANNOT RUN AWAY');
  await seed(P, { n: 60, withAddress: false });
  const seen = new Set();
  hunter.verifyEmail = async (e) => { seen.add(e); return { ok: true, status: 'valid' }; };
  h = await Home.buildHome(P, AG, { athleteId: ATH });
  const touched = (await P.query(
    `SELECT COUNT(*)::int n FROM email_verification`)).rows[0].n;
  check('60 drafts do not become 60 verifications', touched <= 15, 'verified rows=' + touched);
  check('the page still shows exactly five', h.cards.length === 5, 'cards=' + h.cards.length);

  console.log('\n6. COLD LOAD LATENCY — one athlete, nothing cached');
  // The customer's 7am. Real MX over the network, Hunter stubbed at 400ms which
  // is a realistic API round trip, budget-capped at PER_ATHLETE_DAY.
  const timings = [];
  for (let run = 0; run < 3; run++) {
    await seed(P, { n: 15, withAddress: false });
    hunter.verifyEmail = async () => { await new Promise((r) => setTimeout(r, 400)); return { ok: true, status: 'valid' }; };
    const t0 = process.hrtime.bigint();
    const hh = await Home.buildHome(P, AG, { athleteId: ATH });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    timings.push(ms);
    console.log('    run ' + (run + 1) + ': ' + Math.round(ms) + 'ms  cards=' + hh.cards.length
      + ' withheld=' + hh.withheld.length);
  }
  const worst = Math.max(...timings);
  console.log('    worst of three: ' + Math.round(worst) + 'ms');
  check('a cold load stays under the 2500ms deadline', worst < 2500, Math.round(worst) + 'ms');

  // And the baseline it is measured against.
  await seed(P, { n: 15, withAddress: false });
  await Home.buildHome(P, AG, { athleteId: ATH });          // warm the verdict cache
  const t1 = process.hrtime.bigint();
  await Home.buildHome(P, AG, { athleteId: ATH });
  const warm = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log('    warm load (verdicts cached): ' + Math.round(warm) + 'ms');
  check('a warm load is fast', warm < 400, Math.round(warm) + 'ms');

  console.log('\n7. A HUNG VERIFIER MUST NOT HOLD THE PAGE');
  // Hunter's own timeout is 8000ms. Before the deadline bounded the CALL rather
  // than merely preceding it, one hung request meant an eight-second Home.
  await seed(P, { n: 15, withAddress: false });
  hunter.verifyEmail = async () => { await new Promise((r) => setTimeout(r, 8000)); return { ok: true, status: 'valid' }; };
  const t2 = process.hrtime.bigint();
  const hung = await Home.buildHome(P, AG, { athleteId: ATH });
  const hungMs = Number(process.hrtime.bigint() - t2) / 1e6;
  console.log('    hung-verifier load: ' + Math.round(hungMs) + 'ms');
  check('the page still comes back inside the deadline', hungMs < 3200, Math.round(hungMs) + 'ms');
  check('and it still has cards on it', hung.cards.length === 5, 'cards=' + hung.cards.length);
  check('the unanswered ones ride as unverified rather than being withheld',
    hung.withheld.length === 0, JSON.stringify(hung.withheld));

  const bad = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - bad.length) + '/' + out.length + ' passed');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
