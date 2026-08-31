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
// /admin/local-coverage rendered as the browser receives it, with NO clicking.
// This suite exists because section 6's burn projection shipped as unreachable
// code: it lived only inside the job poll, the dry-run path returned before the
// poll started, and the poll bailed on `if(!j) return`. Every assertion here is
// against the RAW HTML of a plain GET, which is the only thing that proves a
// number is actually on the page.
process.env.HUNTER_MONTHLY_BUDGET = '1800';

const fs = require('fs'); const http = require('http');
const ROOT = REPO;
const Module = require('module');
const realLoad = Module._load;
Module._load = function (rq, p, m) {
  if (/^\.\/services\//.test(rq)) return realLoad(ROOT + 'server/' + rq.slice(2), p, m);
  return realLoad.apply(this, arguments);
};
const store = require(ROOT + 'server/store.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(String(g).slice(0, 200)) : '')); } };

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const clean = () => store.pool.query(
    `DELETE FROM brand_evidence_cache WHERE lane IN ('hunter','siteemail','websitecheck','places','contacts')`);
  await clean();
  await store.pool.query(`DELETE FROM hunter_jobs`);

  // A small, fully-known dataset so every rendered number is predictable.
  const mk = async (i, hasSiteEmail) => {
    const w = 'https://biz' + i + '.com';
    await store.pool.query(
      `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
       VALUES ($1,'places',$1,$2,'{}'::jsonb,'OK', NOW() - INTERVAL '5 days')`, ['b' + i, w]);
    await store.pool.query(
      `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
       VALUES ($1,'websitecheck',$1,$2,'{"verdict":"pass"}'::jsonb,'OK',NOW())`, ['wc' + i, w]);
    await store.pool.query(
      `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
       VALUES ($1,'siteemail',$1,$2,$3::jsonb,'OK',NOW())`,
      ['se' + i, w, JSON.stringify(hasSiteEmail ? { email: 'a@biz' + i + '.com' } : { email: null })]);
  };
  for (let i = 0; i < 10; i++) await mk(i, i < 4);          // 4 of 10 have an address
  // Hunter has one the website did not.
  await store.pool.query(
    `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
     VALUES ('biz9.com','hunter','biz9.com',NULL,$1::jsonb,'OK',NOW())`,
    [JSON.stringify({ found: true, emails: [{ email: 'gm@biz9.com', type: 'personal' }] })]);

  // Serve the real page handler.
  const app = require('express')();
  app.use((q, _r, next) => { q.session = { userId: 'u1' }; next(); });
  const ADMIN_EMAIL = 'admin@test.local';
  const isFounderEmail = () => false;
  const storeShim = { pool: store.pool, getUser: async () => ({ email: ADMIN_EMAIL }) };
  const SRC = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
  const hs = SRC.indexOf('async function _hunterCoverageAndBurn()');
  const he = SRC.indexOf("app.get('/api/admin/hunter-backfill'");
  const ps = SRC.indexOf("app.get('/admin/local-coverage'");
  const pe = SRC.indexOf('\napp.', ps + 10);
  ok('the helper and the page handler are both present', hs > 0 && he > hs && ps > 0 && pe > ps);
  { const store = storeShim; eval(SRC.slice(hs, he) + '\n' + SRC.slice(ps, pe)); }

  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const PORT = srv.address().port;
  const page = await (await fetch(`http://127.0.0.1:${PORT}/admin/local-coverage`)).text();

  // ── THE REGRESSION: these must be in the HTML of a plain GET ─────────────
  ok('section 6 is titled for what it shows', /6 — Hunter: coverage and monthly credit burn/.test(page), page.match(/<h2>6[^<]*/));
  ok('THE BURN HEADING IS IN THE RAW HTML, no clicking', /Projected monthly credit burn/.test(page));
  ok('  and it is server-rendered, not a JS string in a script block',
    page.indexOf('Projected monthly credit burn') < page.indexOf('<script>'),
    [page.indexOf('Projected monthly credit burn'), page.indexOf('<script>')]);
  for (const label of ['New websites discovered, last 30 days', 'New websites, last 90 days',
    'Share where siteEmail finds nothing', 'Projected credits/month', 'Budget cap',
    'Spent this calendar month']) {
    ok(`  row present: "${label}"`, page.includes(label));
  }
  for (const label of ['Validated local businesses', 'siteEmail found an address',
    'Hunter added one siteEmail did not have', 'At least one usable email, any source',
    'Reachable in writing']) {
    ok(`  coverage row present: "${label}"`, page.includes(label));
  }

  // ── the numbers are right, not just the labels ──────────────────────────
  const tableAfter = (h) => {
    const i = page.indexOf(h); if (i < 0) return '';
    const j = page.indexOf('</table>', i); return page.slice(i, j);
  };
  const cov = tableAfter('Validated local businesses');
  ok('10 validated businesses', /Validated local businesses<\/td><td class="mono">10</.test(cov), cov.slice(0, 160));
  ok('  4 from siteEmail (40%)', /siteEmail found an address<\/td><td class="mono">4 <span class="dim">\(40%\)/.test(cov), cov);
  ok('  1 Hunter added', /Hunter added one siteEmail did not have<\/td><td class="mono">1</.test(cov), cov);
  ok('  5 with an email from any source (50%)', /any source<\/b><\/td><td class="mono"[^>]*>5 <span class="dim">\(50%\)/.test(cov), cov);

  const burn = tableAfter('New websites discovered, last 30 days');
  ok('10 new websites in 30 days', /last 30 days<\/td><td class="mono">10</.test(burn), burn.slice(0, 200));
  ok('  the need rate is measured at 60%', /finds nothing[\s\S]*?<td class="mono">60%</.test(burn), burn);
  ok('  projecting 6 credits/month (10 x 60%)', /\(30-day window\)<\/span><\/td><td class="mono"[^>]*>6</.test(burn), burn);
  ok('  the 1800 cap is shown beside it', /HUNTER_MONTHLY_BUDGET[\s\S]*?<td class="mono">1800</.test(burn), burn);

  // ── the honesty guards render too ───────────────────────────────────────
  ok('a 5-day-old dataset is FLAGGED as thin, not sold as a monthly rate',
    /days of discovery history/.test(page) && /read it as a floor/.test(page));
  ok('  and the projection is called out as inside the cap', /Comfortably inside the cap/.test(page));
  ok('the cost model is explained on the page', /one credit per month however many\s*\n?\s*times it is scanned/.test(page.replace(/<[^>]+>/g, '')));

  // ── a failure in section 6 must not blank the rest of the page ──────────
  await store.pool.query(`DROP TABLE IF EXISTS hunter_jobs_backup`);
  const page2 = await (await fetch(`http://127.0.0.1:${PORT}/admin/local-coverage`)).text();
  ok('the page still renders sections 1-4 alongside section 6',
    /1 —|Places/.test(page2) && /Projected monthly credit burn/.test(page2));

  // ── with NO data at all it must not throw ───────────────────────────────
  await clean();
  const page3 = await (await fetch(`http://127.0.0.1:${PORT}/admin/local-coverage`)).text();
  ok('an empty dataset renders rather than 500ing', /Projected monthly credit burn/.test(page3) || /Could not compute/.test(page3));
  // Scoped to RENDERED MARKUP: inline script source legitimately contains the
  // token "undefined" (`ov.domainsWithPersonal!==undefined`), which is code, not
  // a template hole.
  const markup = page3.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  const holeAt = markup.search(/undefined|NaN|\[object Object\]/);
  ok('  with no template holes in the rendered markup', holeAt < 0,
    holeAt < 0 ? '' : markup.slice(Math.max(0, holeAt - 240), holeAt + 60));

  await store.pool.query(`DELETE FROM hunter_jobs`).catch(() => {});
  srv.close();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await store.pool.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
