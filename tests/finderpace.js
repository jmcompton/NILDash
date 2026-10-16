'use strict';
// Runs against the local test Postgres. No network: Hunter is a stubbed fetch,
// and the night's per-athlete fill is a stand-in that records what it was given.
//
//   node tests/finderpace.js
//
// ── THE FIRST REAL NIGHT UNDER EMAIL_FIVE_ON ────────────────────────────────
// 36 of 37 short athletes were "stopped by the per-athlete time limit" and the
// alert counted 163x "hunter: TIMEOUT: email finder: This operation was
// aborted". All 163 were OUR timer: Email Finder was cut off at the 8-second
// Domain Search timeout, though it waits on the business's mail server the way
// the Verifier (22s) does. Not one 403 or 429 came back from Hunter.
//   1  Email Finder gets its own timeout (30s); Domain Search keeps 8s
//   2  every Hunter call goes through one gate: a pace well under Hunter's
//      15/s and 500/min, backoff when Hunter says "too fast" (a 429, or a 403
//      whose body says rate limit), and a 403 that is a bad key still stops it
//   3  athletes of one agent run side by side under EMAIL_FIVE_ON, each on its
//      own lane of the budget; 15 minutes each, the same $2.50
//   4  night-length: before and after
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.HUNTER_API_KEY = 'fp-test-key';
process.env.HUNTER_TIMEOUT_MS = '1000';          // the search timeout, scaled down for the test
process.env.HUNTER_BACKOFF_MS = '60';
process.env.HUNTER_MAX_INFLIGHT = '4';
process.env.HUNTER_MAX_PER_SEC = '10';
process.env.HUNTER_MONTHLY_BUDGET = '1000000';
process.env.HUNTER_MONTHLY_VERIFY_BUDGET = '1000000';
delete process.env.EMAIL_FIVE_ON;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const fs = require('fs');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request) {
  const m = originalLoad.apply(this, arguments);
  if (request === '../services/placesLookup') {
    const place = (b) => ({ name: b, businessStatus: 'OPERATIONAL', website: null, phone: '(254) 555-1212', primaryType: 'restaurant' });
    return { ...m, lookupPlace: async (b) => place(b), lookupPlaceResult: async (b) => ({ ok: true, place: place(b) }) };
  }
  return m;
};
let handler = null;
global.fetch = async (url, init) => handler(String(url), init || {});
const store = require(REPO + 'server/store.js');
const H = require(REPO + 'server/services/hunterLookup.js');
const Q = require(REPO + 'server/services/outreachQueue.js');
const job = require(REPO + 'server/jobs/outreachQueue.js');
const NL = require(REPO + 'server/services/nightLength.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const respond = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body,
  headers: { get: (k) => (headers[String(k).toLowerCase()] != null ? headers[String(k).toLowerCase()] : null) } });
const after = (ms, value, signal) => new Promise((res, rej) => {
  const t = setTimeout(() => res(value), ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('This operation was aborted'); e.name = 'AbortError'; rej(e); });
});
const found = (email) => respond(200, { data: { email, score: 91, sources: [], accept_all: false, verification: { status: 'valid' } } });
const AG = 'fp-agent';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const t0 = new Date();
  const clean = async () => {
    await P.query(`DELETE FROM brand_evidence_cache WHERE brand_key LIKE '%@ fp-%' OR brand_key LIKE 'fp-%'`).catch(() => {});
    await P.query(`DELETE FROM service_faults WHERE service = 'hunter' AND (context LIKE '@fp-%' OR reason LIKE '%fp-%')`).catch(() => {});
    await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM outreach_queue_athlete_state WHERE athlete_id LIKE 'fp-%'`).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  };
  await clean();

  // ── 1. THE TIMEOUT ───────────────────────────────────────────────────────
  OUT.push('-- the email finder timeout --');
  ok('Email Finder gets its own timeout, 30s; Domain Search keeps the search timeout; the Verifier keeps 22s',
    H.FINDER_TIMEOUT_MS === 30000 && H.TIMEOUT_MS === 1000 && H.VERIFY_TIMEOUT_MS === 22000, [H.FINDER_TIMEOUT_MS, H.TIMEOUT_MS, H.VERIFY_TIMEOUT_MS]);
  // The same slow answer (1.5s, past the 1s search timeout) for both.
  handler = (url, init) => after(1500, url.includes('email-finder') ? found('dana.reed@fp-a.com') : respond(200, { data: { emails: [], pattern: null } }), init.signal);
  H._resetBreaker();
  const ds = await H.findDomainEmails('fp-slow.com', { force: true, withPattern: true });
  ok('the old behaviour, shown: a call slower than the search timeout is aborted by our own timer', ds && ds.fault && ds.fault.outcome === 'TIMEOUT'
    && /no answer within 1s \(aborted after \d+ms\)/.test(ds.fault.reason), ds);
  const fe = await H.findEmail('Dana', 'Reed', 'fp-a.com', { force: true });
  ok('THE FIX: the same 1.5s answer from Email Finder is waited for, and it finds the address', fe && fe.email === 'dana.reed@fp-a.com' && !fe.fault, fe);
  ok('  a 403 or 429 from Hunter was never what happened: a timeout is our abort, recorded as TIMEOUT with how long it waited',
    /aborted after/.test(ds.fault.reason) && !/HTTP_4/.test(ds.fault.outcome));

  // ── 2. "TOO FAST": BACK OFF, DON'T SWITCH HUNTER OFF ─────────────────────
  OUT.push('', '-- rate limits --');
  const seq = (list) => { let i = 0; return (url, init) => Promise.resolve(list[Math.min(i++, list.length - 1)]).then((r) => (typeof r === 'function' ? r(url, init) : r)); };
  const calls = () => H._recentCalls().filter((c) => c.at >= t0.getTime());
  let n0 = calls().length;
  const tooFast = { errors: [{ id: 'too_many_requests', details: 'slow down' }] };
  handler = seq([respond(429, tooFast), respond(429, tooFast), found('ann.lee@fp-b.com')]);
  let s = Date.now();
  const r429 = await H.findEmail('Ann', 'Lee', 'fp-b.com', { force: true });
  const backoffs = calls().slice(n0).filter((c) => c.outcome === 'BACKOFF').length;
  ok('a 429 is waited out and asked again (backoff, doubling), and the address still comes back', r429.email === 'ann.lee@fp-b.com' && backoffs === 2 && Date.now() - s >= 170, { r429, backoffs, ms: Date.now() - s });
  const rateBody = { errors: [{ id: 'too_many_requests', code: 403, details: "You've reached the rate limit of requests per second" }] };
  handler = seq([respond(403, rateBody), found('bo.diaz@fp-c.com')]);
  const r403 = await H.findEmail('Bo', 'Diaz', 'fp-c.com', { force: true });
  ok('a 403 that says rate limit is "too fast", not a dead key: backed off, answered, Hunter stays on', r403.email === 'bo.diaz@fp-c.com' && H._isRateLimit(403, rateBody), r403);
  handler = seq([respond(429, {}, { 'retry-after': '1' }), found('cy.ho@fp-e.com')]);
  s = Date.now();
  const rRA = await H.findEmail('Cy', 'Ho', 'fp-e.com', { force: true });
  ok('  Retry-After is honoured', rRA.email === 'cy.ho@fp-e.com' && Date.now() - s >= 950, Date.now() - s);
  let fetches = 0;
  handler = (url) => { fetches++; return Promise.resolve(respond(429, tooFast)); };
  const rStill = await H.findEmail('Di', 'Ng', 'fp-f.com', { force: true });
  ok('still too fast after the backoffs: RATE_LIMITED, as before (asked four times in all)', rStill.fault && rStill.fault.outcome === 'HTTP_429' && fetches === H.BACKOFF_TRIES + 1, { rStill, fetches });
  H._resetBreaker();
  fetches = 0;
  handler = (url) => { fetches++; return Promise.resolve(respond(429, { errors: [{ id: 'too_many_requests', details: 'You have reached your monthly quota' }] })); };
  const rQuota = await H.findEmail('Ola', 'Ng', 'fp-q.com', { force: true });
  ok('OUT OF CREDITS IS NOT TOO FAST: a monthly-quota 429 is not waited on or asked again; Hunter stops, as before', rQuota.fault && rQuota.fault.outcome === 'HTTP_429' && fetches === 1, { rQuota, fetches });
  fetches = 0;
  handler = (url) => { fetches++; return Promise.resolve(found('x@fp-q2.com')); };
  const rQ2 = await H.findEmail('Pat', 'Ng', 'fp-q2.com', { force: true });
  ok('  and the next call does not reach Hunter at all', rQ2.fault && fetches === 0, { rQ2, fetches });
  H._resetBreaker();
  ok('  a bare 429 with no body is read as a spent plan too (no backoff); Retry-After makes it "too fast"', !H._isRateLimit(429, {}) && H._isRateLimit(429, {}, '2'));
  const keyBody = { errors: [{ id: 'authentication_failed', code: 401, details: 'No user found for the API key supplied' }] };
  handler = () => Promise.resolve(respond(403, keyBody));
  const rKey = await H.findEmail('Ed', 'Fox', 'fp-g.com', { force: true });
  fetches = 0;
  handler = (url) => { fetches++; return Promise.resolve(found('x@fp-h.com')); };
  const rAfter = await H.findEmail('Fi', 'Gu', 'fp-h.com', { force: true });
  ok('a 403 that is a bad key is still a dead key: UNAUTHORIZED, and Hunter is paused (not called again)', rKey.fault && rKey.fault.outcome === 'HTTP_401'
    && rAfter.fault && fetches === 0, { rKey: rKey.fault, rAfter, fetches });
  H._resetBreaker();

  // ── 3. THE PACE ──────────────────────────────────────────────────────────
  OUT.push('', '-- the pace --');
  // ON A VIRTUAL CLOCK. Measured on the wall clock, the moment a call left was
  // read a few milliseconds after the gate stamped it, by a varying amount, so
  // a window could hold one call the gate never let into it. Here time moves
  // only when every waiter is asleep (a timer fires once all the work that
  // can run at the current instant has run), so the times the gate reads and
  // the times recorded here are the same times. The limits are unchanged.
  const VC = (() => {
    let now = 1e12; const timers = []; let pumping = false;
    const pump = () => {
      pumping = false;
      if (!timers.length) return;
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const t = timers.shift();
      now = Math.max(now, t.at);
      t.resolve();
      schedule();
    };
    const schedule = () => { if (!pumping) { pumping = true; setImmediate(pump); } };
    let seq = 0;
    return { now: () => now, sleep: (ms) => new Promise((resolve) => { timers.push({ at: now + Math.max(0, ms), seq: seq++, resolve }); schedule(); }) };
  })();
  H._setClock(VC);
  let open = 0, maxOpen = 0; const starts = [];
  handler = (url, init) => { open++; maxOpen = Math.max(maxOpen, open); starts.push(VC.now()); return VC.sleep(120).then(() => respond(200, { data: { status: 'valid' } })).finally(() => { open--; }); };
  const vt0 = VC.now();
  await Promise.all(Array.from({ length: 25 }, (_, i) => H._call('verifier', `https://api.hunter.io/v2/email-verifier?email=p${i}@fp-p.com`, { timeoutMs: 5000 })));
  H._setClock(null);
  const perSecMax = Math.max(...starts.map((t) => starts.filter((u) => u >= t && u - t < 1000).length));
  ok('  (25 calls at 10 a second take at least two virtual seconds: the gate really waited)', starts.length === 25 && starts[24] - vt0 >= 2000, starts.map((t) => t - vt0));
  ok('a burst of 25 calls: never more than HUNTER_MAX_INFLIGHT open at once', maxOpen <= 4 && maxOpen >= 2, maxOpen);
  ok('  and never more than HUNTER_MAX_PER_SEC started in any second', perSecMax <= 10, perSecMax);
  ok('  the defaults sit under Hunter\'s 15/s and 500/min (and the Verifier\'s lower limit)', /HUNTER_MAX_PER_SEC, 10\) \|\| 8/.test(fs.readFileSync(REPO + 'server/services/hunterLookup.js', 'utf8'))
    && /HUNTER_MAX_PER_MIN, 10\) \|\| 250/.test(fs.readFileSync(REPO + 'server/services/hunterLookup.js', 'utf8')));
  fetches = 0;
  handler = (url, init) => { fetches++; return after(200, found('gil.ames@fp-d.com'), init.signal); };
  const [d1, d2] = await Promise.all([H.findEmail('Gil', 'Ames', 'fp-d.com', { force: true }), H.findEmail('Gil', 'Ames', 'fp-d.com', { force: true })]);
  ok('two athletes asking for the same owner at once: one call to Hunter, one answer for both', fetches === 1 && d1.email === 'gil.ames@fp-d.com' && d2.email === d1.email, { fetches, d1, d2 });
  await new Promise((r) => setTimeout(r, 400));
  const logged = (await P.query(`SELECT endpoint, ms, outcome, status FROM hunter_call_log WHERE at >= $1`, [t0])).rows;
  ok('every call is logged with how long it took (hunter_call_log)', logged.some((x) => x.endpoint === 'email-finder' && x.outcome === 'OK' && x.ms >= 1400)
    && logged.some((x) => x.endpoint === 'domain-search' && x.outcome === 'TIMEOUT') && logged.some((x) => x.outcome === 'BACKOFF'), logged.slice(0, 6));

  // ── 4. BUDGET LANES ──────────────────────────────────────────────────────
  OUT.push('', '-- one lane of the budget per athlete --');
  const b = Q.newBudget(10, 5, { rosterSize: 4 });
  const l1 = b.lane(4), l2 = b.lane(3), l3 = b.lane(2);
  ok('three athletes at once each get a share of what is left, not of a share another reset', [l1, l2, l3].every((l) => Math.abs(l.shareOf() - 2.5) < 1e-9));
  l1.spend(1);
  ok('  spend is the athlete\'s own (mine), and the pot\'s (spent)', l1.mine() === 1 && l2.mine() === 0 && b.spent() === 1);
  ok('  an athlete cannot spend past its own share', !l1.canSpend(2) && l1.canSpend(1.4));
  l1.close();
  const l4 = b.lane(1);
  ok('  what an athlete leaves unspent goes to the ones still to start', Math.abs(l4.shareOf() - 4.0) < 1e-9, l4.shareOf());
  const tiny = Q.newBudget(1, 1, { rosterSize: 2 });
  const t1 = tiny.lane(2); t1.spend(0.5);
  const t2 = tiny.lane(1);
  ok('  the pot is still the ceiling for all of them together', !t2.canSpend(0.6) && t2.canSpend(0.5));

  // ── 5. ATHLETES SIDE BY SIDE, IN THE REAL fillAgent ─────────────────────
  OUT.push('', '-- athletes side by side (EMAIL_FIVE_ON) --');
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1, 'Pace Agent', 'pace@fp-test.test', 'x', 'agent')`, [AG]);
  for (let i = 0; i < 7; i++) {
    await P.query(`INSERT INTO athletes (id, agent_id, data, created_at) VALUES ($1, $2, $3::jsonb, NOW() + make_interval(secs => $4))`,
      ['fp-ath-' + i, AG, JSON.stringify({ name: 'Pace Athlete ' + i, school: 'Baylor University', sport: 'Football' }), i]);
  }
  const realFill = job.fillAthlete;
  const runWith = async (five) => {
    if (five) process.env.EMAIL_FIVE_ON = '1'; else delete process.env.EMAIL_FIVE_ON;
    process.env.OUTREACH_ATHLETE_CONCURRENCY = '3';
    await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id = $1`, [AG]);
    let live = 0, peak = 0; const seen = [];
    job.fillAthlete = async (pool, ctx) => {
      live++; peak = Math.max(peak, live);
      const lane = ctx.budget;
      seen.push({ id: ctx.athleteId, lane: typeof lane.mine === 'function', share: lane.shareOf ? lane.shareOf() : null });
      await new Promise((r) => setTimeout(r, 150));
      lane.spend(0.4);
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      live--;
      return { filled: 1, open: 5, tried: [], spendLog: [{ brand: 'x', lane: 'contacts', cost: 0.4 }], loop: { stop: 'floor', elapsedMs: 200 }, deferred: [] };
    };
    try {
      const r = await job.fillAgent(P, { id: AG, name: 'Pace Agent', email: 'pace@fp-test.test', signature_text: null, scheduling_url: null, last_login: new Date() },
        { runDate: '2026-10-15', force: true });
      return { r, peak, seen };
    } finally { job.fillAthlete = realFill; delete process.env.EMAIL_FIVE_ON; }
  };
  const on = await runWith(true);
  ok('under EMAIL_FIVE_ON, three athletes of the agent run at once (not one, not all seven)', on.peak === 3, on.peak);
  ok('  each on its own lane of the budget', on.seen.length === 7 && on.seen.every((x) => x.lane), on.seen);
  const dets = (on.r && on.r.details) || [];
  ok('  each athlete\'s spend is its own ($0.40), not the others\' spent while it ran', dets.length === 7 && dets.every((d) => Math.abs(d.spentUsd - 0.4) < 1e-9), dets.map((d) => d.spentUsd));
  ok('  the run row lists them in roster order, and every one is there', JSON.stringify(dets.map((d) => d.athleteId)) === JSON.stringify([0, 1, 2, 3, 4, 5, 6].map((i) => 'fp-ath-' + i))
    && on.r.filled === 7 && Math.abs(on.r.spent - 2.8) < 1e-9, { order: dets.map((d) => d.athleteId), filled: on.r.filled, spent: on.r.spent });
  const off = await runWith(false);
  ok('EMAIL_FIVE_ON off: one at a time, on the agent\'s own budget, exactly as before', off.peak === 1 && off.seen.every((x) => !x.lane)
    && off.r.details.every((d) => Math.abs(d.spentUsd - 0.4) < 1e-9), { peak: off.peak, lanes: off.seen.map((x) => x.lane) });
  ok('15 minutes an athlete under EMAIL_FIVE_ON, 8 otherwise; the $2.50 ceiling is unchanged',
    Q.FIVE_TIME_CEILING_MS === 15 * 60000 && Q.ATHLETE_TIME_CEILING_MS === 8 * 60000 && Q.ATHLETE_COST_CEILING_USD === 2.5
    && /FINDER\.five\(\) \? Q\.FIVE_TIME_CEILING_MS : Q\.ATHLETE_TIME_CEILING_MS/.test(fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8')));

  // ── 6. NIGHT LENGTH ──────────────────────────────────────────────────────
  OUT.push('', '-- night-length --');
  ok('the scheduling model: next job to whichever worker is free first', NL.makespan([8, 8, 8, 8], 2) === 16 && NL.makespan([5, 1, 1, 1, 1, 1], 2) === 5
    && NL.simulate([{ athletes: [8, 8, 8], tailMs: 1 }, { athletes: [2] }], { agentConc: 1, athleteConc: 3 }).night === 11);
  // The first real night's shape: one agent, 50 athletes, 36 stopped at 8
  // minutes, the rest done sooner, ten minutes of retry passes after.
  const MIN = 60000;
  const det = [];
  for (let i = 0; i < 36; i++) det.push({ athleteId: 'a' + i, athleteName: 'A' + i, filled: 2, loop: { stop: 'time', elapsedMs: 8 * MIN } });
  for (let i = 36; i < 50; i++) det.push({ athleteId: 'a' + i, athleteName: 'A' + i, filled: 5, loop: { stop: 'floor', elapsedMs: 4 * MIN } });
  const start = new Date('2026-10-15T06:00:00Z');
  const sum = det.reduce((x, d) => x + d.loop.elapsedMs, 0);
  const g = { runDate: '2026-10-15', rows: [{ agent_id: 'x', agent_name: 'One Agent', created_at: start, finished_at: new Date(start.getTime() + sum + 10 * MIN), details: det }],
    faults: Array.from({ length: 163 }, () => ({ reason: 'TIMEOUT: email finder: This operation was aborted' })), calls: [] };
  const nb = NL.build(g, { agentConc: 4, athleteConc: 3 });
  ok('before: the measured night (36 x 8 + 14 x 4 minutes, then 10 of retries = 5h 54m)', nb.before.measured === sum + 10 * MIN && NL.hm(nb.before.measured) === '5h 54m', NL.hm(nb.before.measured));
  // Three workers: 36 x 8 = 96 min each, then the 14 x 4 add 20 on the busiest, then 10 of retries.
  ok('after: three at a time, fastest 2h 06m, slowest 3h 30m (every stopped athlete using the full 15 minutes)',
    NL.hm(nb.after.fastest) === '2h 06m' && NL.hm(nb.after.slowest) === '3h 30m', [NL.hm(nb.after.fastest), NL.hm(nb.after.slowest)]);
  ok('  15 minutes one at a time would have been a 10h night: the ceiling only works with the athletes side by side', NL.hm(nb.slowestOneAtATime) === '10h 06m', NL.hm(nb.slowestOneAtATime));
  const txt = NL.format(nb);
  ok('the printout: before, after (fastest and slowest), per agent, and Hunter that night', /BEFORE  measured: 5h 54m/.test(txt) && /fastest 2h 06m/.test(txt) && /slowest 3h 30m/.test(txt)
    && /email finder timeouts \(our abort\): 163/.test(txt), txt);
  const def = require(REPO + 'server/services/adminScripts.js').registry()['night-length'];
  ok('night-length is an admin script', def && def.file === 'scripts/night-length.js' && JSON.stringify(def.args({ date: '2026-10-15', athletes: '3', agents: 'x' })) === '["--date","2026-10-15","--athletes","3"]');

  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass}/${pass + F} passed`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
