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
// /admin/national-index rendered against real Postgres. Checks it survives an
// EMPTY table (the likely production state) as well as a populated one, and
// that the verdict line changes with the count rather than being decoration.
const fs = require('fs');
const http = require('http');
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const express = require('express');
const app = express();
app.use((req, _res, next) => { req.session = { userId: 'u1' }; next(); });

const SRC = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
const START = SRC.indexOf("app.get('/admin/national-index'");
const END = SRC.indexOf("app.get('/admin/inbound'");
if (START < 0 || END < 0 || END < START) { console.error('slice failed'); process.exit(1); }
const ROUTE_SRC = SRC.slice(START, END);

let USER = { email: 'admin@test.local' };
const ADMIN_EMAIL = 'admin@test.local';
const isFounderEmail = (e) => e === 'founder@test.local';
const _inboundAdminOk = (u) => !!u && (u.email === ADMIN_EMAIL || isFounderEmail(u.email));
const storeShim = { pool: store.pool, getUser: async () => USER };
{ const store = storeShim; eval(ROUTE_SRC); }

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(String(g).slice(0, 300)) : '')); } };

let PORT;
async function get() {
  const r = await fetch(`http://127.0.0.1:${PORT}/admin/national-index`);
  return { status: r.status, html: await r.text() };
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;

  // ── empty table: the state this page most likely finds in production ──────
  await store.pool.query('DELETE FROM social_brands');
  let r = await get();
  ok('renders against an EMPTY table without throwing', r.status === 200, r.status);
  ok('  reports zero rather than a blank', /rows total/.test(r.html) && />0<\/div>/.test(r.html), r.status);
  ok('  and says plainly that the index is empty', /index is EMPTY/.test(r.html), r.html.slice(0, 200));
  ok('  no unrendered template holes', !/undefined|\[object Object\]|NaN/.test(r.html), (r.html.match(/undefined|\[object Object\]|NaN/) || [])[0]);

  // ── a handful of rows ─────────────────────────────────────────────────────
  for (let i = 0; i < 6; i++) {
    await store.pool.query(
      `INSERT INTO social_brands (brand, category, website, sports, tier_min, tier_max, deal_structure,
         proof_url, proof_date, brand_size, active)
       VALUES ($1,'apparel','https://b.example',ARRAY['all']::text[],1000,50000,'affiliate',
         $2, CURRENT_DATE - ($3 || ' days')::interval, $4, $5)`,
      ['Brand ' + i, 'https://b.example/amb' + i, i * 40, i % 2 ? 'national' : 'small', i !== 5]);
  }
  r = await get();
  ok('renders with rows', r.status === 200 && /Brand 5/.test(r.html), r.status);
  ok('  active excludes the retired row (5 of 6)', />5<\/div>[\s\S]{0,120}?active/.test(r.html), (r.html.match(/>\d+<\/div>\s*<div[^>]*>active/) || [])[0]);
  ok('  the retired row is labelled, not hidden', /retired<\/span>/.test(r.html));
  ok('  verdict escalates to "almost every search will miss"', /Almost every search/.test(r.html), (r.html.match(/<b>Verdict:<\/b>[^<]*/) || [])[0]);
  ok('  growth-by-day table has entries', /When rows were added/.test(r.html) && /\d{4}-\d{2}-\d{2}/.test(r.html));
  ok('  brand size split shown', /national:/.test(r.html) && /small\/DTC:/.test(r.html));
  ok('  freshness split shown', /current \(verified within 12 months\)/.test(r.html));
  ok('  aging row counted (one is 200 days old, all under 12mo)', /aging: <b>0<\/b>/.test(r.html), (r.html.match(/aging: <b>\d+<\/b>/) || [])[0]);
  ok('  still no template holes', !/undefined|\[object Object\]|NaN/.test(r.html), (r.html.match(/undefined|\[object Object\]|NaN/) || [])[0]);

  // an aging row really does land in the aging bucket
  await store.pool.query(
    `INSERT INTO social_brands (brand, category, website, sports, tier_min, tier_max, deal_structure, proof_url, proof_date, active)
     VALUES ('Stale Co','apparel','https://s.example',ARRAY['all']::text[],0,0,'affiliate','https://s.example/a', CURRENT_DATE - INTERVAL '20 months', true)`);
  r = await get();
  ok('  a 20-month-old proof counts as aging', /aging: <b>1<\/b>/.test(r.html), (r.html.match(/aging: <b>\d+<\/b>/) || [])[0]);

  // ── escaping ──────────────────────────────────────────────────────────────
  await store.pool.query(
    `INSERT INTO social_brands (brand, category, website, sports, tier_min, tier_max, deal_structure, proof_url, proof_date, active)
     VALUES ($1,'x','https://x.example',ARRAY['all']::text[],0,0,'affiliate','https://x.example/<script>',CURRENT_DATE,true)`,
    ['<script>alert(1)</script>']);
  r = await get();
  ok('a brand name with markup is ESCAPED, not injected', !/<script>alert\(1\)<\/script>/.test(r.html), (r.html.match(/alert\(1\)/) || [])[0]);
  ok('  and is still readable on the page', /&lt;script&gt;alert\(1\)/.test(r.html));

  // ── auth ──────────────────────────────────────────────────────────────────
  USER = { email: 'random@test.local' };
  r = await get();
  ok('a non-admin gets 403', r.status === 403, r.status);
  USER = { email: 'founder@test.local' };
  r = await get();
  ok('a founder account is allowed', r.status === 200, r.status);
  USER = null;
  r = await get();
  ok('logged out gets 403', r.status === 403, r.status);
  USER = { email: ADMIN_EMAIL };

  // ── it is genuinely read only ─────────────────────────────────────────────
  ok('the route source contains no INSERT/UPDATE/DELETE',
    !/\b(INSERT|UPDATE|DELETE)\b/.test(ROUTE_SRC), (ROUTE_SRC.match(/\b(INSERT|UPDATE|DELETE)\b/) || [])[0]);
  const before = (await store.pool.query('SELECT COUNT(*)::int n FROM social_brands')).rows[0].n;
  await get(); await get();
  const after = (await store.pool.query('SELECT COUNT(*)::int n FROM social_brands')).rows[0].n;
  ok('  and loading it twice changes no rows', before === after, [before, after]);

  await store.pool.query('DELETE FROM social_brands');
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  server.close(); await store.pool.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
