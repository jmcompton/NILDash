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
// THE CEILING, THE COUNTER, AND THE TWO PROVIDER REFUSALS.
// 40 is a deliverability limit, not Google's. The thing being protected is the
// agent's own mailbox reputation, so the cap has to hold under concurrency --
// the Hunter budget was overspent twice by a check-then-increment that looked
// exactly like a working cap until two calls landed in the same tick.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const G = require(ROOT + 'server/services/sendGuard.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'sg-agent';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await G.ensureTable(P);
  const clean = async () => {
    await P.query(`DELETE FROM agent_send_budget WHERE agent_id LIKE 'sg-%'`).catch(() => {});
    await P.query(`DELETE FROM users WHERE id LIKE 'sg-%'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'A','sg@x.com','x','agent','America/Chicago')
                 ON CONFLICT DO NOTHING`, [AG]);

  // ── THE DEFAULT IS 40, AND IT IS A DELIVERABILITY NUMBER ─────────────────
  ok('the default ceiling is 40', G.DEFAULT_DAILY_CAP === 40, G.DEFAULT_DAILY_CAP);
  const st0 = await G.status(P, AG);
  ok('a fresh agent has the full allowance', st0.remaining === 40 && st0.used === 0, st0);
  ok('  and is not blocked', st0.blocked === false, st0);

  // ── THE CAP HOLDS UNDER CONCURRENCY ──────────────────────────────────────
  // Fifty simultaneous reservations against a cap of 40. A check-then-increment
  // passes this test with 2 and fails it with 50, which is why it is 50.
  await P.query(`UPDATE users SET daily_email_cap = 40 WHERE id = $1`, [AG]);
  const results = await Promise.all(
    Array.from({ length: 50 }, () => G.reserve(P, AG)));
  const granted = results.filter((r) => r.ok).length;
  ok('FIFTY CONCURRENT RESERVATIONS GRANT EXACTLY 40', granted === 40, granted);
  const st1 = await G.status(P, AG);
  ok('  and the counter agrees', st1.used === 40 && st1.remaining === 0, st1);
  const refused = results.find((r) => !r.ok);
  ok('  a refusal says WHICH refusal it was',
    /ceiling is reached/.test(refused.reason), refused);

  // ── A FAILED SEND GIVES THE ALLOWANCE BACK ───────────────────────────────
  await G.release(P, AG);
  const st2 = await G.status(P, AG);
  ok('releasing a reservation returns it', st2.used === 39 && st2.remaining === 1, st2);
  const again = await G.reserve(P, AG);
  ok('  so the freed slot can be used', again.ok === true, again);

  // ── A CONFIGURABLE CEILING ───────────────────────────────────────────────
  const AG2 = 'sg-agent2';
  await P.query(`INSERT INTO users (id,name,email,password,role,daily_email_cap,report_tz)
                 VALUES ($1,'B','sg2@x.com','x','agent',5,'America/Chicago')`, [AG2]);
  const cap2 = await G.capFor(P, AG2);
  ok('an agent can carry their own ceiling', cap2.cap === 5, cap2);
  const r2 = await Promise.all(Array.from({ length: 9 }, () => G.reserve(P, AG2)));
  ok('  and it is the one enforced', r2.filter((x) => x.ok).length === 5,
    r2.filter((x) => x.ok).length);

  // ── THE RESET IS THE AGENT'S MIDNIGHT ────────────────────────────────────
  // 02:00 UTC is still yesterday evening in Chicago. A UTC-keyed counter would
  // reset in the middle of an agent's working evening.
  const utcEarly = Date.parse('2026-08-21T02:00:00Z');
  ok('the local date is the AGENT\'s date, not UTC\'s',
    G.localDate('America/Chicago', utcEarly) === '2026-08-20',
    G.localDate('America/Chicago', utcEarly));
  ok('  and a different zone gets a different day',
    G.localDate('Pacific/Honolulu', utcEarly) === '2026-08-20');
  ok('  an unknown zone falls back rather than throwing',
    /^\d{4}-\d{2}-\d{2}$/.test(G.localDate('Not/AZone', utcEarly)),
    G.localDate('Not/AZone', utcEarly));
  const tomorrow = await G.status(P, AG, { now: Date.parse('2026-08-25T18:00:00Z') });
  ok('a later day starts fresh', tomorrow.used === 0 && tomorrow.remaining === 40, tomorrow);

  // ── 429 IS "TOO FAST". 403 QUOTA IS "TOO MUCH". ──────────────────────────
  const e429 = Object.assign(new Error('User-rate limit exceeded'), { code: 429 });
  const c429 = G.classifyError(e429);
  ok('a 429 is a RATE problem and is retryable', c429.kind === 'rate' && c429.retryable === true, c429);

  const e403 = Object.assign(new Error('Daily Limit Exceeded'), { code: 403 });
  const c403 = G.classifyError(e403);
  ok('a 403 quota is a QUOTA problem', c403.kind === 'quota', c403);
  ok('  AND IT IS NOT RETRYABLE — retrying into a 403 lengthens the refusal',
    c403.retryable === false, c403);

  const e401 = Object.assign(new Error('invalid_grant'), { code: 401 });
  ok('a 401 is an auth problem, not a quota one', G.classifyError(e401).kind === 'auth');
  ok('a 500 is retryable', G.classifyError({ code: 503 }).kind === 'server');

  // retry-after is respected when the server sends one
  const withHeader = { code: 429, response: { status: 429, headers: { 'retry-after': '7' } } };
  ok('retry-after seconds are read off the response',
    G.retryAfterOf(withHeader) === 7000, G.retryAfterOf(withHeader));
  ok('  and backoff uses it rather than its own curve',
    G.backoffMs(0, 7000, 0.5) === 7000, G.backoffMs(0, 7000, 0.5));
  ok('  with no header it backs off exponentially',
    G.backoffMs(0, null, 0) === 1000 && G.backoffMs(3, null, 0) === 8000,
    [G.backoffMs(0, null, 0), G.backoffMs(3, null, 0)]);
  ok('  and never past the ceiling',
    G.backoffMs(20, null, 0) === G.MAX_BACKOFF_MS, G.backoffMs(20, null, 0));

  // ── THE RETRY LOOP ───────────────────────────────────────────────────────
  let calls = 0;
  const waited = [];
  const rate = await G.sendWithRetry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('rate'), { code: 429 });
    return { id: 'ok' };
  }, { sleep: async (ms) => { waited.push(ms); }, rnd: 0 });
  ok('a rate-limited send retries and then succeeds', rate.ok === true && calls === 3, { rate, calls });
  ok('  waiting longer each time', waited.length === 2 && waited[1] > waited[0], waited);

  let quotaCalls = 0, stopped = null;
  const quota = await G.sendWithRetry(async () => {
    quotaCalls++;
    throw Object.assign(new Error('Daily Limit Exceeded'), { code: 403 });
  }, { sleep: async () => {}, onQuota: (c) => { stopped = c; } });
  ok('A QUOTA REFUSAL IS NOT RETRIED', quotaCalls === 1, quotaCalls);
  ok('  and the caller is told to stop the agent', !!stopped, stopped);
  ok('  reported as a quota failure', quota.kind === 'quota', quota);

  let giveUp = 0;
  const never = await G.sendWithRetry(async () => {
    giveUp++; throw Object.assign(new Error('rate'), { code: 429 });
  }, { sleep: async () => {}, maxAttempts: 4, rnd: 0 });
  ok('a permanently rate-limited send gives up rather than looping',
    never.ok === false && giveUp === 4, { giveUp, never: never.kind });

  // ── A BLOCKED AGENT SENDS NOTHING MORE TODAY ─────────────────────────────
  const AG3 = 'sg-agent3';
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'C','sg3@x.com','x','agent','America/Chicago')`, [AG3]);
  await G.reserve(P, AG3);
  await G.blockForDay(P, AG3, 'the mail provider refused on quota');
  const st3 = await G.status(P, AG3);
  ok('a blocked agent reads as blocked', st3.blocked === true, st3);
  ok('  with the reason in words', /refused on quota/.test(st3.blockedReason), st3.blockedReason);
  const after = await G.reserve(P, AG3);
  ok('  AND CANNOT RESERVE AGAIN, even under the ceiling', after.ok === false, after);
  ok('  the refusal names the block, not the cap', /quota/.test(after.reason), after.reason);

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
