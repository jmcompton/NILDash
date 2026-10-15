'use strict';
// Needs the test Postgres (PGHOST/PGPORT/PGUSER/PGDATABASE, as every suite). Makes no network calls:
// fetch and DNS are stubbed.
//
//   node tests/finderbudget.js
//
// ── HUNTER'S TWO POOLS, EMAIL FINDER, AND THE NIGHT'S VERIFICATION CREDITS ──
// The plan bills 2,000 searches and 4,000 verifications a month, separately.
// Verifying every email card must not starve the searches that find
// addresses, and a search ceiling must not stop verification.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.HUNTER_API_KEY = 'test-key';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// MX passes for every domain here: the container has no DNS, and the thing
// under test is what happens after MX.
const dnsP = require('dns').promises;
dnsP.resolveMx = async () => [{ exchange: 'mx.test', priority: 10 }];

const store = require(REPO + 'server/store.js');
const H = require(REPO + 'server/services/hunterLookup.js');
const VB = require(REPO + 'server/services/verifyBudget.js');
const EF = require(REPO + 'server/services/emailFinder.js');
const DR = require(REPO + 'server/services/domainResolve.js');

let F = 0, N = 0;
const ok = (c, m, d) => { N++; console.log((c ? 'PASS ' : 'FAIL ') + m + (c || d === undefined ? '' : '   ' + JSON.stringify(d))); if (!c) F++; };

// fetch stub: url -> JSON body
let fetchLog = [];
let answer = () => ({ status: 200, body: { data: {} } });
global.fetch = async (url) => {
  fetchLog.push(String(url));
  const a = answer(String(url));
  return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
};

const TAG = 'nildash-fb-';
async function clean(P) {
  await P.query(`DELETE FROM email_verify_credit_log`);
  await P.query(`DELETE FROM brand_evidence_cache WHERE lane IN ('hunter','hunterfinder')`);
  await P.query(`DELETE FROM brand_evidence_cache WHERE lane = 'domain' AND (brand_key LIKE 'dom:fb %' OR brand_key LIKE 'dom:fernbrook %')`);
  await P.query(`DELETE FROM email_verification WHERE email LIKE '%@fbtest.com' OR email LIKE '${TAG}%'`);
  H._resetBudgetCache(); H._resetBreaker();
}

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await VB.ensureTable(P);
  await clean(P);

  console.log('\n1. TWO POOLS');
  // A month with more verifications logged than the whole SEARCH ceiling.
  await P.query(`INSERT INTO email_verify_credit_log (agent_id, athlete_id, business, email, source, local_date)
    SELECT 'a', 'ath', 'B', 'x' || g || '@fbtest.com', 'nightly', CURRENT_DATE FROM generate_series(1, $1) g`, [H.MONTHLY_BUDGET + 50]);
  H._resetBudgetCache();
  let bs = await H.budgetStatus();
  ok(bs.used === 0 && bs.remaining === H.MONTHLY_BUDGET, 'verifications do not spend the search ceiling', bs);
  ok(bs.verifyUsed === H.MONTHLY_BUDGET + 50 && bs.verifyRemaining === H.VERIFY_MONTHLY_BUDGET - bs.verifyUsed, '  they count against their own pool', bs);
  answer = () => ({ status: 200, body: { data: { emails: [{ value: 'tom@fbtest.com', type: 'personal', confidence: 90, first_name: 'Tom', last_name: 'Smith' }], pattern: '{first}' } } });
  fetchLog = [];
  const h = await H.findDomainEmails('fbtest.com', { withPattern: true });
  ok(h && h.found && fetchLog.length === 1, 'so a domain search still runs', { h, fetchLog });
  ok(H.VERIFY_MONTHLY_BUDGET === 3600 && H.MONTHLY_BUDGET === 1800, 'ceilings: 1,800 of 2,000 searches, 3,600 of 4,000 verifications', [H.MONTHLY_BUDGET, H.VERIFY_MONTHLY_BUDGET]);

  console.log('\n2. EMAIL FINDER');
  answer = (u) => /email-finder/.test(u)
    ? { status: 200, body: { data: { email: 'Tom.Smith@fbtest.com', score: 88, sources: [{ uri: 'https://fbtest.com/team' }], accept_all: false, verification: { status: 'valid' } } } }
    : { status: 500, body: {} };
  fetchLog = [];
  const f1 = await H.findEmail('Tom', 'Smith', 'fbtest.com');
  ok(f1.email === 'tom.smith@fbtest.com' && f1.score === 88 && f1.sources === 1 && f1.sourceUrl === 'https://fbtest.com/team', 'asks by name and domain; returns the address, score and source', f1);
  ok(/first_name=Tom/.test(fetchLog[0]) && /last_name=Smith/.test(fetchLog[0]) && /domain=fbtest\.com/.test(fetchLog[0]), '  the request carries the name and domain', fetchLog[0]);
  const f2 = await H.findEmail('Tom', 'Smith', 'fbtest.com');
  ok(f2.cached && fetchLog.length === 1, '  the second ask is free: cached by name and domain', { f2, calls: fetchLog.length });
  H._resetBudgetCache();
  bs = await H.budgetStatus();
  ok(bs.used === 2, '  Email Finder counts as a search, with the domain search', bs);
  answer = () => ({ status: 404, body: { errors: [{ details: 'no email' }] } });
  const f3 = await H.findEmail('Ann', 'Bee', 'fbtest.com');
  ok(f3.email === null && !f3.fault, 'Hunter has no address for the person: an answer, not a fault', f3);
  ok((await H.findEmail('Ann', '', 'fbtest.com')).email === null, 'no surname: not asked');

  console.log('\n3. THE VERIFIER');
  answer = (u) => {
    if (/email-verifier/.test(u)) {
      const e = decodeURIComponent((u.match(/email=([^&]+)/) || [])[1] || '');
      if (/catchall/.test(e)) return { status: 200, body: { data: { status: 'accept_all', result: 'risky', accept_all: true } } };
      if (/gmailish/.test(e)) return { status: 200, body: { data: { status: 'webmail', result: 'deliverable' } } };
      if (/nobody/.test(e)) return { status: 200, body: { data: { status: 'invalid', result: 'undeliverable' } } };
      return { status: 200, body: { data: { status: 'valid', result: 'deliverable' } } };
    }
    return { status: 500, body: {} };
  };
  const D = EF.liveDeps(P, { agentId: 'agent-fb', athleteId: 'ath-fb', business: 'FB Pizza', source: 'nightly' });
  await P.query(`DELETE FROM email_verify_credit_log`); H._resetBudgetCache();
  const v1 = await D.verify(`${TAG}tom@fbtest.com`);
  ok(v1.result === 'valid' && v1.status === 'valid' && EF.verdictOf(v1) === 'valid', 'valid', v1);
  const v2 = await D.verify(`${TAG}catchall@fbtest.com`);
  ok(EF.verdictOf(v2) === 'catch-all' && v2.status === 'accept_all', 'accept_all is told apart from unknown', v2);
  const v3 = await D.verify(`${TAG}gmailish@fbtest.com`);
  ok(v3.result === 'valid', 'webmail that Hunter could check (deliverable) is valid', v3);
  const v4 = await D.verify(`${TAG}nobody@fbtest.com`);
  ok(EF.verdictOf(v4) === 'invalid', 'invalid', v4);
  const log = (await P.query(`SELECT agent_id, athlete_id, business, source FROM email_verify_credit_log ORDER BY id`)).rows;
  ok(log.length === 4 && log.every((r) => r.source === 'nightly' && r.agent_id === 'agent-fb' && r.athlete_id === 'ath-fb' && r.business === 'FB Pizza'),
    'every credit is logged: source nightly, the agent, the athlete, the business', log);
  const again = await D.verify(`${TAG}catchall@fbtest.com`);
  const stored = (await P.query(`SELECT status FROM email_verification WHERE email = $1`, [`${TAG}catchall@fbtest.com`])).rows[0];
  ok(again.cached && EF.verdictOf(again) === 'catch-all' && stored && stored.status === 'accept_all', 'the cached verdict keeps catch-all (status column), and costs nothing', { again, stored });
  ok((await P.query(`SELECT COUNT(*)::int n FROM email_verify_credit_log`)).rows[0].n === 4, '  no fifth credit for a cached verdict');
  // An old row with only the detail text still reads as catch-all.
  await P.query(`INSERT INTO email_verification (email, result, detail, source) VALUES ($1, 'unknown', 'the verifier says accept_all', 'hunter')
    ON CONFLICT (email) DO UPDATE SET result = 'unknown', detail = 'the verifier says accept_all', status = NULL, checked_at = NOW()`, [`${TAG}old@fbtest.com`]);
  ok(EF.verdictOf(await D.verify(`${TAG}old@fbtest.com`)) === 'catch-all', 'a row written before the status column still reads as catch-all');

  answer = () => ({ status: 202, body: { data: {} } });
  const slow = await D.verify(`${TAG}slowserver@fbtest.com`);
  ok(EF.verdictOf(slow) === 'not-run', 'Hunter still verifying (202) is not a verdict', slow);
  ok(!(await P.query(`SELECT 1 FROM email_verification WHERE email = $1`, [`${TAG}slowserver@fbtest.com`])).rows.length, '  and is not cached');
  const hlSrc = require('fs').readFileSync(REPO + 'server/services/hunterLookup.js', 'utf8');
  ok(/_call\('verifier', url, \{ timeoutMs: VERIFY_TIMEOUT_MS/.test(hlSrc) && /setTimeout\(\(\) => ctrl\.abort\(\), timeoutMs\)/.test(hlSrc) && /\|\| 22000/.test(hlSrc), 'a mailbox check waits up to 22s, not the 8s search timeout');

  console.log('\n4. THE VERIFICATION POOL REFUSES AT ITS OWN CEILING');
  await P.query(`INSERT INTO email_verify_credit_log (agent_id, athlete_id, business, email, source, local_date)
    SELECT 'a', 'ath', 'B', 'y' || g || '@fbtest.com', 'nightly', CURRENT_DATE FROM generate_series(1, $1) g`, [H.VERIFY_MONTHLY_BUDGET]);
  H._resetBudgetCache();
  fetchLog = [];
  const r = await H.verifyEmail(`${TAG}late@fbtest.com`);
  ok(r.ok === false && r.budget === true && fetchLog.length === 0, 'past 3,600 verifications Hunter is not called, and it says why', r);
  const vr = await D.verify(`${TAG}late2@fbtest.com`);
  ok(EF.verdictOf(vr) === 'not-run' && vr.budget, '  the night reads that as "could not run", never as a pass', vr);
  const fault = (await P.query(`SELECT reason FROM service_faults WHERE service = 'hunter' AND reason LIKE 'verification budget spent%' ORDER BY at DESC LIMIT 1`).catch(() => ({ rows: [] }))).rows[0];
  ok(!!fault, '  and it is recorded as a fault, so the morning hears about it', fault);
  await P.query(`DELETE FROM service_faults WHERE service = 'hunter' AND reason LIKE 'verification budget spent%'`).catch(() => {});

  console.log('\n5. A STALE "NO WEBSITE" IS ASKED AGAIN');
  const key = `dom:fernbrook pizza | - | v1`;
  await P.query(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, website, evidence, outcome, refreshed_at)
    VALUES ($1, 'domain', 'fernbrook pizza', NULL, $2, 'NONE', NOW() - INTERVAL '10 days')
    ON CONFLICT (brand_key, lane) DO UPDATE SET evidence = EXCLUDED.evidence, outcome = 'NONE', refreshed_at = NOW() - INTERVAL '10 days'`,
    [key, JSON.stringify({ v: 'v1', website: null, reason: 'the search returned no website', tried: [] })]);
  let searched = 0;
  const ws = async () => { searched++; return { text: '{"website": "https://fernbrookpizza.com"}', citations: [], searches: 1 }; };
  const keep = await DR.resolveDomain('Fernbrook Pizza', { webSearch: ws });
  ok(keep.cached && searched === 0, 'without the option, the cached answer stands (30 days)', keep);
  const fresh = await DR.resolveDomain('Fernbrook Pizza', { webSearch: ws, refreshNoneAfterDays: 7 });
  ok(searched === 1 && fresh.website === 'https://fernbrookpizza.com', 'a "no website" older than 7 days is searched again', fresh);
  const now = await DR.resolveDomain('Fernbrook Pizza', { webSearch: ws, refreshNoneAfterDays: 7 });
  ok(now.cached && searched === 1, '  and the found website is cached as usual', now);

  await clean(P);
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('THREW', e.stack); process.exit(1); });
