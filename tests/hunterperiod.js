'use strict';
// Needs the test Postgres. Makes no network calls: fetch is stubbed.
//
//   node tests/hunterperiod.js
//
// ── HUNTER'S BILLING PERIOD, NOT THE CALENDAR MONTH ─────────────────────────
// Our Hunter plan resets on the 20th. The counters counted from the 1st, so on
// October 21st ours said 1800 of 1800 searches used and blocked Domain Search
// ("hunter: search budget spent (1800/1800)" 52 times in a night) while
// Hunter's own account showed 135 of 2,000. services/hunterPeriod gives every
// count the period's start: the account's reset date minus one month, read
// at boot and every few hours, the calendar month only when the account
// cannot be read.
//
// "Today" is pinned to 2026-10-21 so the case is exactly the one seen.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('hunterperiodtest', { schema: true });
process.env.TZ = process.env.TZ || 'America/Chicago';
process.env.HUNTER_API_KEY = 'hp-test-key';
delete process.env.HUNTER_PACE_ON;
delete process.env.HUNTER_MONTHLY_BUDGET;
delete process.env.HUNTER_MONTHLY_VERIFY_BUDGET;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// Hunter, stubbed. The account says what ours said on 2026-10-21.
let calls = [];
let accountAnswer = () => ({ status: 200, body: { data: { plan_name: 'Starter', reset_date: '2026-11-20',
  requests: { searches: { used: 135, available: 2000 }, verifications: { used: 40, available: 4000 } } } } });
global.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  const a = /\/v2\/account/.test(u) ? accountAnswer()
    : { status: 200, body: { data: { emails: [{ value: 'tom@hpshop.com', type: 'personal', confidence: 90, first_name: 'Tom', last_name: 'Smith' }], pattern: '{first}' } } };
  return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
};

const store = require(REPO + 'server/store.js');
const HPer = require(REPO + 'server/services/hunterPeriod');
const H = require(REPO + 'server/services/hunterLookup');
const HP = require(REPO + 'server/services/hunterPace');
const VB = require(REPO + 'server/services/verifyBudget');
const R = require(REPO + 'server/services/emailFinderReport');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const TODAY = Date.parse('2026-10-21T15:00:00Z');
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

(async () => {
  console.log('\n1. THE PERIOD. Pure.');
  ok('a reset on 2026-11-20 began on 2026-10-20', ymd(HPer.monthBefore('2026-11-20')) === '2026-10-20');
  ok('  across a year: a reset on 2026-01-20 began on 2025-12-20', ymd(HPer.monthBefore('2026-01-20')) === '2025-12-20');
  ok('  the day clamped to the month: March 31st began February 28th (29th in a leap year)', ymd(HPer.monthBefore('2026-03-31')) === '2026-02-28' && ymd(HPer.monthBefore('2028-03-31')) === '2028-02-29');
  ok('  a reset date that is not a date gives nothing', HPer.monthBefore('soon') === null && HPer.monthBefore(null) === null);
  ok('fromAccount: the period from the answer', ymd(HPer.fromAccount({ ok: true, resetDate: '2026-11-20' }, TODAY).start) === '2026-10-20');
  ok('  not from an answer whose period has not started (a reset more than a month out)', HPer.fromAccount({ ok: true, resetDate: '2026-12-25' }, TODAY) === null);
  ok('  nor from a failed read', HPer.fromAccount({ ok: false, error: 'x' }, TODAY) === null);

  HPer._reset();
  HPer._setClock(() => TODAY);
  const c0 = HPer.current();
  ok('before any read: the calendar month, saying why', c0.from === 'calendar' && ymd(c0.start) === '2026-10-01' && c0.resetDate === '2026-11-01' && /not been read yet/.test(c0.error), c0);
  calls = [];
  const w0 = await HPer.forCount();
  ok('  a counter never reads the account itself: no call', w0.from === 'calendar' && calls.length === 0, calls);

  console.log('\n2. THE READ, AND THE FALLBACK');
  const w1 = await HPer.refresh();
  ok('a period starting on the 20th: the account resets 2026-11-20, so it began 2026-10-20', w1.from === 'hunter' && ymd(w1.start) === '2026-10-20' && w1.resetDate === '2026-11-20', w1);
  ok('  read through the account endpoint, once', calls.filter((u) => /\/v2\/account/.test(u)).length === 1, calls);
  ok('  and said in words', HPer.describe(w1) === "since 2026-10-20 (Hunter's billing period; resets 2026-11-20)", HPer.describe(w1));
  ok('  fresh, so the timer does not read it again yet', HPer.stale() === false);
  accountAnswer = () => ({ status: 503, body: { errors: [{ details: 'down for maintenance' }] } });
  const w2 = await HPer.refresh();
  ok('the account fails after a good read: the period still holds until its reset date', w2.from === 'hunter' && ymd(w2.start) === '2026-10-20', w2);
  HPer._setClock(() => Date.parse('2026-11-21T12:00:00Z'));
  const w3 = HPer.current();
  ok('  past the reset date with no new answer: the calendar month, saying why', w3.from === 'calendar' && ymd(w3.start) === '2026-11-01' && /past its reset date; Hunter answered HTTP 503/.test(w3.error), w3);
  HPer._reset();
  HPer._setClock(() => TODAY);
  const w4 = await HPer.refresh();
  ok('the account fails with no earlier answer: the calendar month, saying why', w4.from === 'calendar' && ymd(w4.start) === '2026-10-01' && /HTTP 503: down for maintenance/.test(w4.error), w4);
  ok('  said in words too', /since 2026-10-01 \(the calendar month: Hunter's account could not be read, Hunter answered HTTP 503/.test(HPer.describe(w4)), HPer.describe(w4));
  accountAnswer = () => ({ status: 200, body: { data: { plan_name: 'Starter', reset_date: '2026-11-20', requests: { searches: { used: 135, available: 2000 }, verifications: { used: 40, available: 4000 } } } } });
  HPer.noteAccount({ ok: true, resetDate: '2026-11-20' });
  ok('an answer read for something else (pacing, the report) sets the period too', HPer.current().from === 'hunter' && ymd(HPer.current().start) === '2026-10-20');

  console.log('\n3. TODAY\'S CASE: 135, NOT 1800');
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await VB.ensureTable(P);
  // 1,665 searches in the period that ended on the 20th (October 1st to 19th),
  // 135 since the reset; 3,000 verifications before it, 40 since.
  await P.query(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at)
    SELECT 'old' || g || '.com', CASE WHEN g % 5 = 0 THEN 'hunterfinder' ELSE 'hunter' END, 'old' || g, '{}'::jsonb, 'OK',
           TIMESTAMPTZ '2026-10-01 06:00:00+00' + make_interval(mins => g * 15) FROM generate_series(1, 1665) g`);
  await P.query(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at)
    SELECT 'new' || g || '.com', 'hunter', 'new' || g, '{}'::jsonb, 'OK', TIMESTAMPTZ '2026-10-20 01:00:00+00' + make_interval(mins => g * 5) FROM generate_series(1, 135) g`);
  await P.query(`INSERT INTO email_verify_credit_log (agent_id, athlete_id, business, email, source, local_date, checked_at)
    SELECT 'a', 'ath', 'B', 'v' || g || '@x.com', 'nightly', DATE '2026-10-05', TIMESTAMPTZ '2026-10-02 00:00:00+00' + make_interval(mins => g * 8) FROM generate_series(1, 3000) g`);
  await P.query(`INSERT INTO email_verify_credit_log (agent_id, athlete_id, business, email, source, local_date, checked_at)
    SELECT 'a', 'ath', 'B', 'w' || g || '@x.com', 'nightly', DATE '2026-10-21', TIMESTAMPTZ '2026-10-20 02:00:00+00' + make_interval(mins => g * 30) FROM generate_series(1, 40) g`);
  // A NO_KEY row is not a credit, in or out of the period.
  await P.query(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at) VALUES ('nokey.com','hunter','nokey','{}'::jsonb,'NO_KEY', TIMESTAMPTZ '2026-10-20 12:00:00+00')`);

  H._resetBudgetCache();
  const b1 = await H.budgetStatus();
  ok('the search counter reads 135, not 1800', b1.used === 135 && b1.ladderUsed === 135, b1);
  ok('  so 1,665 of the 1,800 are left', b1.remaining === H.MONTHLY_BUDGET - 135 && H.MONTHLY_BUDGET === 1800, b1);
  ok('the verification counter (HUNTER_MONTHLY_VERIFY_BUDGET) reads 40, not 3,040: the same window', b1.verifyUsed === 40 && b1.verifyRemaining === H.VERIFY_MONTHLY_BUDGET - 40, b1);
  ok('  and the status says which window', b1.periodStart === '2026-10-20' && b1.resetDate === '2026-11-20' && b1.periodFrom === 'hunter' && /Hunter's billing period/.test(b1.periodLine), b1);
  calls = [];
  H._resetBreaker && H._resetBreaker();
  const h1 = await H.findDomainEmails('hpshop.com', { withPattern: true });
  ok('Domain Search runs: one call to Hunter', !!(h1 && h1.found) && calls.filter((u) => /domain-search/.test(u)).length === 1, { h1, calls });

  // The old window, for the record: what the calendar month counts.
  HPer._reset();
  H._resetBudgetCache();
  const b2 = await H.budgetStatus();
  ok('with the account unread (the fallback), the calendar month counts 1,800 + this one: Domain Search is blocked, as on the 21st', b2.used >= 1800 && b2.remaining === 0 && b2.periodFrom === 'calendar' && b2.periodStart === '2026-10-01', b2);
  calls = [];
  const h2 = await H.findDomainEmails('hpshop2.com', { withPattern: true });
  ok('  and the search is skipped, no call made', h2 === null && calls.length === 0, { h2, calls });
  HPer.noteAccount({ ok: true, resetDate: '2026-11-20' });
  H._resetBudgetCache();
  ok('the account read again: back to the period', (await H.budgetStatus()).used === 136);

  console.log('\n4. EVERY READER USES THE SAME WINDOW');
  const vb = await VB.accountStatus(P);
  ok('verifyBudget.accountStatus: 40 verifications this period', vb.verifyUsed === 40 && vb.periodStart === '2026-10-20' && vb.resetDate === '2026-11-20', vb);
  ok('  its line, in the agent\'s morning email, says the plan resets on the 20th and no vendor name', /billing period/.test(vb.line) && /before the plan resets on 2026-11-20/.test(vb.line) && !/Hunter/.test(vb.line) && !/—/.test(vb.line), vb.line);
  const est = await HP.estimateAccount(TODAY);
  ok('pacing\'s own-count estimate resets on the 20th, with the period\'s counts', est.estimated && est.resetDate === '2026-11-20' && est.searches.used === 136 && est.verifications.used === 40, est);
  const proj = HP.projection({ ok: true, resetDate: '2026-11-20', searches: { used: 135, available: 2000, left: 1865 } }, TODAY);
  ok('pacing\'s burn rate is over the period: 135 in about 1.6 days is about 83 a day (from the 1st it would read about 6.5)', proj[0] && proj[0].perDay > 80 && proj[0].perDay < 90, proj);
  // The night, as the 5:30 email reads it.
  process.env.HUNTER_PACE_ON = '1';
  HPer._reset();
  H._resetBudgetCache();
  const night = await HP.beginNight(P, { runDate: '2026-10-21', now: TODAY,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => accountAnswer().body }) });
  ok('the night reads the account, which sets the period', HPer.current().from === 'hunter' && night.plan.resetDate === '2026-11-20');
  ok('  and records our own count over it', night.plan.ourCount && night.plan.ourCount.since === '2026-10-20' && night.plan.ourCount.searches === 136 && night.plan.ourCount.verifications === 40, night.plan.ourCount);
  await HP.endNight(P, { check: false });
  const morning = await HP.morningLines(P, '2026-10-21');
  ok('the 5:30 email: Hunter\'s numbers and ours, over the same period', morning.lines.some((l) => /^Hunter: 1865 searches left, resets 2026-11-20/.test(l))
    && morning.lines.some((l) => l === 'Our own count since 2026-10-20: 136 of 1800 searches, 40 of 3600 verifications.'), morning.lines);
  delete process.env.HUNTER_PACE_ON;
  HP._reset();
  const txt = R.format({ days: 7, cards: 0, mix: {}, rows: [], budget: await H.budgetStatus() }, null);
  ok('email-finder-report: "HUNTER THIS BILLING PERIOD", counted since the 20th', /HUNTER THIS BILLING PERIOD:/.test(txt) && /our count since 2026-10-20 \(Hunter's billing period; resets 2026-11-20\): 136 of the 1800/.test(txt), txt.split('\n').filter((l) => /HUNTER|our count/.test(l)));
  const rsrc = fs.readFileSync(REPO + 'server/services/emailFinderReport.js', 'utf8');
  ok('  and a card counts as "this period" from the period\'s start, not the 1st', /q\.created_at >= \$2 AS "thisMonth"/.test(rsrc) && /\[days, period\.start\]/.test(rsrc) && !/date_trunc\('month'/.test(rsrc));
  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('the admin status page: "Spent this billing period", with the window', (idx.match(/Spent this billing period <span class="dim">\(/g) || []).length === 2
    && /'<tr><td>Spent this billing period <span class="dim">\('\+esc\(bn\.periodLine/.test(idx) && /periodLine: budget\.periodLine/.test(idx) && !/Spent this calendar month/.test(idx));
  ok('the server reads the period at boot and every few hours, pacing on or off', /const perTick = \(\) => \{ if \(HPer\.stale\(\)\) HPer\.refresh\(\)/.test(idx) && /perTick\(\);\s*\n\s*setInterval\(perTick, 30 \* 60 \* 1000\);/.test(idx));
  const left = ['server/services/hunterLookup.js', 'server/services/verifyBudget.js', 'server/services/hunterPace.js', 'server/services/emailFinderReport.js']
    .filter((f) => /date_trunc\('month'/i.test(fs.readFileSync(REPO + f, 'utf8')));
  ok('no Hunter count anywhere still starts on the 1st', left.length === 0, left);

  console.log(`\n${N - F}/${N} passed`);
  await store.pool.end().catch(() => {});
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
