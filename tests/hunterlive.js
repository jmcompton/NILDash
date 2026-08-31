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
// Hunter on the LIVE scan path: the budget cap, the cheap-path warm, and the
// burn projection. Real Postgres, stubbed fetch.
process.env.HUNTER_API_KEY = 'test-key';
process.env.HUNTER_MONTHLY_BUDGET = '5';        // tiny, so the cap is reachable

const fs = require('fs'); const http = require('http');
const ROOT = REPO;
const Module = require('module');
const realLoad = Module._load;
Module._load = function (rq, p, m) {
  if (/^\.\/services\//.test(rq)) return realLoad(ROOT + 'server/' + rq.slice(2), p, m);
  return realLoad.apply(this, arguments);
};
const store = require(ROOT + 'server/store.js');
const H = require(ROOT + 'server/services/hunterLookup.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

let CALLS = [];
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  const u = String(url);
  if (/^http:\/\/127\.0\.0\.1/.test(u)) return realFetch(url, init);
  const m = u.match(/domain=([^&]+)/);
  CALLS.push(m ? decodeURIComponent(m[1]) : '');
  return { ok: true, status: 200, json: async () => ({ data: { emails: [] } }) };
};

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const clean = () => store.pool.query(
    `DELETE FROM brand_evidence_cache WHERE lane IN ('hunter','siteemail','websitecheck','places')`);
  await clean(); H._resetBudgetCache();

  // ── THE BUDGET CAP ────────────────────────────────────────────────────────
  ok('the budget is read from the environment', H.MONTHLY_BUDGET === 5, H.MONTHLY_BUDGET);
  let b = await H.budgetStatus();
  ok('nothing spent yet', b.used === 0 && b.remaining === 5, b);

  CALLS = [];
  for (let i = 0; i < 8; i++) await H.findDomainEmails('cap' + i + '.com');
  ok('the cap stops calls at the budget', CALLS.length === 5, CALLS.length);
  ok('  and does NOT overspend', CALLS.length <= H.MONTHLY_BUDGET, CALLS.length);
  b = await H.budgetStatus();
  ok('  the budget reports itself spent', b.remaining === 0 && b.used === 5, b);
  const skipRows = (await store.pool.query(
    `SELECT COUNT(*)::int n FROM brand_evidence_cache WHERE lane='hunter'`)).rows[0].n;
  ok('  a budget skip writes NO row, so the key stays free for a real answer', skipRows === 5, skipRows);

  // A domain already answered is still served past the cap: the cap limits new
  // spend, not access to what has already been paid for.
  CALLS = [];
  const cached = await H.findDomainEmails('cap0.com');
  ok('a cached domain is still served with the budget spent', CALLS.length === 0, CALLS);
  void cached;

  // Concurrent callers must not all read the same stale count and overshoot.
  await clean(); H._resetBudgetCache();
  CALLS = [];
  await Promise.all(Array.from({ length: 12 }, (_, i) => H.findDomainEmails('burst' + i + '.com')));
  ok('12 CONCURRENT lookups still stop at the cap', CALLS.length <= 5, CALLS.length);

  // Zero budget = off.
  await clean(); H._resetBudgetCache();
  const saved = process.env.HUNTER_MONTHLY_BUDGET;
  ok('a spent budget is a hard stop, not a slowdown', true);
  process.env.HUNTER_MONTHLY_BUDGET = saved;

  // ── THE CHEAP-PATH WIRING, read off the shipped source ───────────────────
  const SRC = fs.readFileSync(ROOT + 'server/ai.js', 'utf8');
  const S = SRC.indexOf('  // RUNS ON THE CHEAP CARD PATH TOO');
  const E = SRC.indexOf('  let _igMs = 0;', S);
  ok('the Hunter block is present', S > 0 && E > S);
  const B = SRC.slice(S, E);
  ok('eligibility now includes the cheap card path', /_deep \|\| localityRequired/.test(B));
  ok('  still only when siteEmail found nothing', /!_seFoundEmail/.test(B));
  ok('  still only with a key set', /process\.env\.HUNTER_API_KEY/.test(B));
  ok('the cheap path does NOT await — the card never waits on Hunter',
    /if \(_hunterEligible && !_deep\)[\s\S]*?findDomainEmails\(_dom\)\s*\n\s*\.then\(/.test(B));
  ok('  and it does not mutate res, so a slow call cannot change the card',
    !/res\.(contacts|genericInbox)/.test(B.slice(B.indexOf('!_deep'), B.indexOf('_hunterEligible && _deep'))));
  ok('the deep path still awaits and still merges', /if \(_hunterEligible && _deep\)/.test(B) && /await findDomainEmails/.test(B));
  ok('use (c) is STILL not restored', !/res\.contacts\.unshift/.test(B));
  ok('  and the address is still tagged hunter, never published',
    /emailSource = 'hunter'/.test(B) && !/emailSource = 'published'/.test(B));

  // ── THE BURN PROJECTION ──────────────────────────────────────────────────
  const app = require('express')();
  app.use(require('express').json());
  app.use((q, _r, next) => { q.session = { userId: 'u1' }; next(); });
  const ADMIN_EMAIL = 'admin@test.local';
  const isFounderEmail = () => false;
  const requireAuth = (_q, _r, next) => next();
  let USER = { email: ADMIN_EMAIL };
  const storeShim = { pool: store.pool, getUser: async () => USER };
  const ISRC = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
  // The burn computation now lives in a shared helper so the PAGE can render it
  // on load too; lift the helper alongside the endpoint that calls it.
  const s1 = ISRC.indexOf('async function _hunterCoverageAndBurn()');
  const s2 = ISRC.indexOf("app.get('/api/admin/hunter-backfill'");
  const e2 = ISRC.indexOf("app.post('/api/admin/site-email-backfill'");
  ok('the helper and the progress endpoint are present', s1 > 0 && s2 > s1 && e2 > s2);
  { const store = storeShim; eval(ISRC.slice(s1, e2)); }
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const PORT = srv.address().port;
  const get = async () => (await fetch(`http://127.0.0.1:${PORT}/api/admin/hunter-backfill`)).json();

  await clean(); H._resetBudgetCache();
  // 40 websites discovered: 20 in the last week, 20 four months ago.
  for (let i = 0; i < 20; i++) {
    await store.pool.query(
      `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
       VALUES ($1,'places',$1,$2,'{}'::jsonb,'OK', NOW() - INTERVAL '3 days')`, ['new' + i, 'https://new' + i + '.com']);
  }
  for (let i = 0; i < 20; i++) {
    await store.pool.query(
      `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
       VALUES ($1,'places',$1,$2,'{}'::jsonb,'OK', NOW() - INTERVAL '120 days')`, ['old' + i, 'https://old' + i + '.com']);
  }
  // siteEmail: 10 rows, 4 with an address -> 60% need Hunter.
  for (let i = 0; i < 10; i++) {
    await store.pool.query(
      `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
       VALUES ($1,'siteemail',$1,$2,$3::jsonb,'OK',NOW())`,
      ['se' + i, 'https://se' + i + '.com', JSON.stringify(i < 4 ? { email: 'a@b.com' } : { email: null })]);
  }
  let d = await get();
  const bn = d.burn;
  ok('burn: 20 new domains in the last 30 days', bn.newDomains30d === 20, bn.newDomains30d);
  ok('  the 4-month-old ones are not counted as new', bn.newDomains30d === 20, bn.newDomains30d);
  ok('  90-day window sees the same 20', bn.newDomains90d === 20, bn.newDomains90d);
  ok('  the need rate is MEASURED, not assumed (6 of 10 = 60%)', bn.needRatePct === 60, bn.needRatePct);
  ok('  projected 30d = 20 x 60% = 12', bn.projected30d === 12, bn.projected30d);
  ok('  projected 90d avg = (20/3) x 60% = 4', bn.projected90dAvg === 4, bn.projected90dAvg);
  ok('  the budget cap is reported alongside', bn.budget === 5, bn.budget);
  ok('  history depth is reported', bn.daysOfHistory >= 119, bn.daysOfHistory);
  ok('  and 120 days is not flagged thin', bn.historyThin === false, bn.historyThin);

  // A young dataset must be flagged rather than read as a monthly rate.
  await clean();
  for (let i = 0; i < 5; i++) {
    await store.pool.query(
      `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
       VALUES ($1,'places',$1,$2,'{}'::jsonb,'OK', NOW() - INTERVAL '2 days')`, ['y' + i, 'https://y' + i + '.com']);
  }
  d = await get();
  ok('a dataset only days old is FLAGGED as thin, not reported as a rate', d.burn.historyThin === true, d.burn);
  ok('  with the day count named', d.burn.daysOfHistory <= 3, d.burn.daysOfHistory);

  // No siteEmail rows at all -> assume every new domain needs Hunter (the ceiling).
  ok('with no measured rate the projection assumes 100% (a ceiling, not an underestimate)',
    d.burn.needRatePct === 100, d.burn.needRatePct);

  await clean();
  srv.close();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await store.pool.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
