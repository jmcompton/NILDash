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
// /api/admin/hunter-audit against real Postgres, in the cache shapes the deleted
// hunterLookup.js actually wrote. The load-bearing case is the EMPTY lane: if
// Hunter never answered, the page must say the 0-for-20 measured nothing, not
// report a 0% hit rate as if it were coverage.
const fs = require('fs'); const http = require('http');
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const express = require('express');
const app = express();
app.use((req, _r, next) => { req.session = { userId: 'u1' }; next(); });

const SRC = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
const START = SRC.indexOf("app.get('/api/admin/hunter-audit'");
const END = SRC.indexOf("// ── Website validation pass, admin only ──");
if (START < 0 || END < 0 || END < START) { console.error('slice failed'); process.exit(1); }
const ROUTE_SRC = SRC.slice(START, END);

let USER = { email: 'admin@test.local' };
const ADMIN_EMAIL = 'admin@test.local';
const isFounderEmail = (e) => e === 'founder@test.local';
const requireAuth = (req, _r, next) => next();
const storeShim = { pool: store.pool, getUser: async () => USER };
const Module = require('module');
const realLoad = Module._load;
Module._load = function (r, p, m) {
  if (/services\/siteEmail/.test(r)) return realLoad(ROOT + 'server/services/siteEmail.js', p, m);
  return realLoad.apply(this, arguments);
};
{ const store = storeShim; eval(ROUTE_SRC); }

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

let PORT;
const get = async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/admin/hunter-audit`);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const clear = async () => {
  await store.pool.query(`DELETE FROM brand_evidence_cache WHERE lane IN ('hunter','contacts')`);
};
// One deep lookup, exactly as the contacts lane stores it.
const deep = (key, website) => store.pool.query(
  `INSERT INTO brand_evidence_cache (brand_key, lane, brand, website, evidence, outcome, refreshed_at)
   VALUES ($1,'contacts',$1,$2,'{}'::jsonb,'OK',NOW())
   ON CONFLICT (brand_key, lane) DO UPDATE SET website = EXCLUDED.website`, [key, website]);
// A hunter row, in the two shapes hunterLookup wrote and no others.
const hunterOK = (domain, emails) => store.pool.query(
  `INSERT INTO brand_evidence_cache (brand_key, lane, brand, website, evidence, outcome, refreshed_at)
   VALUES ($1,'hunter',$1,NULL,$2::jsonb,'OK',NOW())
   ON CONFLICT (brand_key, lane) DO UPDATE SET evidence = EXCLUDED.evidence, outcome='OK'`,
  [domain, JSON.stringify({ found: true, emails })]);
const hunterNONE = (domain) => store.pool.query(
  `INSERT INTO brand_evidence_cache (brand_key, lane, brand, website, evidence, outcome, refreshed_at)
   VALUES ($1,'hunter',$1,NULL,'{"found":false}'::jsonb,'NONE',NOW())
   ON CONFLICT (brand_key, lane) DO UPDATE SET outcome='NONE'`, [domain]);

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;

  // ── THE LOAD-BEARING CASE: 20 domains asked, hunter lane empty ────────────
  await clear();
  for (let i = 0; i < 20; i++) await deep('biz' + i, 'https://biz' + i + '.com/contact');
  let r = await get();
  ok('20 deep lookups with a website -> 20 domains asked', r.body.askedDomains === 20, r.body.askedDomains);
  ok('  an empty hunter lane means ZERO proven answers', r.body.answered === 0, r.body.answered);
  ok('  all 20 are reported silent', r.body.silent === 20, r.body.silent);
  ok('  and the payload states silent is not separable', /not|cannot/i.test(r.body.caveat || '') && /429/.test(r.body.caveat || ''), r.body.caveat);
  ok('  no addresses claimed', r.body.totalAddresses === 0 && r.body.addresses.length === 0, r.body.totalAddresses);
  ok('  zeroAddresses is 0, NOT 20 -- a call that never answered is not a coverage miss',
    r.body.zeroAddresses === 0, r.body.zeroAddresses);

  // ── a working API: answers, some with addresses ───────────────────────────
  await clear();
  for (let i = 0; i < 10; i++) await deep('b' + i, 'https://b' + i + '.com');
  await hunterOK('b0.com', [
    { email: 'dana.kessler@b0.com', type: 'personal', confidence: 92, firstName: 'Dana', lastName: 'Kessler', position: 'Owner' },
    { email: 'info@b0.com', type: 'generic', confidence: 71, firstName: null, lastName: null, position: null },
  ]);
  await hunterOK('b1.com', [
    { email: 'j.smith@b1.com', type: 'personal', confidence: 64, firstName: 'J', lastName: 'Smith', position: null },
  ]);
  for (let i = 2; i < 9; i++) await hunterNONE('b' + i + '.com');
  r = await get();
  ok('9 answered of 10 asked', r.body.askedDomains === 10 && r.body.answered === 9, [r.body.askedDomains, r.body.answered]);
  ok('  2 returned addresses, 7 returned none', r.body.withAddresses === 2 && r.body.zeroAddresses === 7, [r.body.withAddresses, r.body.zeroAddresses]);
  ok('  1 silent', r.body.silent === 1, r.body.silent);
  ok('  3 addresses total', r.body.totalAddresses === 3, r.body.totalAddresses);
  ok('  split personal vs generic', r.body.personalAddresses === 2 && r.body.genericAddresses === 1, [r.body.personalAddresses, r.body.genericAddresses]);

  const dana = r.body.addresses.find((a) => a.email === 'dana.kessler@b0.com');
  ok('  Hunter\'s OWN type is reported', dana && dana.type === 'personal', dana);
  ok('  Hunter\'s OWN position is reported', dana && dana.position === 'Owner', dana && dana.position);
  ok('  confidence is reported', dana && dana.confidence === 92, dana && dana.confidence);
  ok('  and the name', dana && dana.name === 'Dana Kessler', dana && dana.name);
  const jsmith = r.body.addresses.find((a) => a.email === 'j.smith@b1.com');
  ok('  a personal address with NO position is reported as such, not invented',
    jsmith && jsmith.position === null, jsmith && jsmith.position);
  ok('  the zero-address domains are listed', (r.body.noneDomains || []).length === 7, (r.body.noneDomains || []).length);

  // ── THE OVERLAP: what Hunter would actually add over siteEmail ───────────
  await clear();
  await store.pool.query(`DELETE FROM brand_evidence_cache WHERE lane='siteemail'`);
  const se = (key, website, email) => store.pool.query(
    `INSERT INTO brand_evidence_cache (brand_key, lane, brand, website, evidence, outcome, refreshed_at)
     VALUES ($1,'siteemail',$1,$2,$3::jsonb,'OK',NOW())
     ON CONFLICT (brand_key, lane) DO UPDATE SET evidence=EXCLUDED.evidence`,
    [key, website, JSON.stringify(email ? { email, type: 'personal' } : { email: null, type: null })]);

  for (const d of ['w.com', 'x.com', 'y.com', 'z.com']) await deep('d-' + d, 'https://' + d);
  // w: both have one          -> no lift
  // x: siteEmail tried, found nothing, Hunter has a person -> LIFT
  // y: siteEmail never tried,               Hunter has a person -> lift, but free to close
  // z: Hunter has only a GENERIC address    -> not counted at all
  await se('w', 'https://w.com', 'owner@w.com');
  await se('x', 'https://x.com', null);
  await hunterOK('w.com', [{ email: 'a@w.com', type: 'personal', confidence: 90, firstName: 'A', lastName: 'One', position: 'Owner' }]);
  await hunterOK('x.com', [{ email: 'b@x.com', type: 'personal', confidence: 90, firstName: 'B', lastName: 'Two', position: 'Owner' }]);
  await hunterOK('y.com', [{ email: 'c@y.com', type: 'personal', confidence: 90, firstName: 'C', lastName: 'Three', position: 'Owner' }]);
  await hunterOK('z.com', [{ email: 'info@z.com', type: 'generic', confidence: 60, firstName: null, lastName: null, position: null }]);
  r = await get();
  const ov = r.body.overlap;
  ok('overlap: 3 domains have a Hunter PERSONAL address', ov.domainsWithPersonal === 3, ov.domainsWithPersonal);
  ok('  a generic-only domain is excluded from the lift entirely', ov.domainsWithPersonal === 3, ov);
  ok('  1 where siteEmail already has one -> NO lift', ov.bothHave === 1, ov.bothHave);
  ok('  2 where siteEmail has nothing -> the real lift', ov.hunterOnly === 2, ov.hunterOnly);
  ok('  1 of those siteEmail never even tried', ov.hunterOnlyUntried === 1, ov.hunterOnlyUntried);
  ok('  the lift is SMALLER than the raw address count', ov.hunterOnly < r.body.totalAddresses, [ov.hunterOnly, r.body.totalAddresses]);
  const xr = ov.hunterOnlyRows.find((q) => q.domain === 'x.com');
  const yr = ov.hunterOnlyRows.find((q) => q.domain === 'y.com');
  ok('  a tried-but-empty domain is marked tried', xr && xr.siteEmailTried === true, xr);
  ok('  an untried domain is marked untried', yr && yr.siteEmailTried === false, yr);
  ok('  and the rows carry the addresses', xr && xr.addresses[0].email === 'b@x.com', xr && xr.addresses);
  await store.pool.query(`DELETE FROM brand_evidence_cache WHERE lane='siteemail'`);

  // ── root-domain dedup: two pages of one site are ONE domain asked ─────────
  await clear();
  await deep('x1', 'https://www.acme.com/contact');
  await deep('x2', 'https://acme.com/about');
  await deep('x3', 'https://other.com');
  r = await get();
  ok('two URLs on one site count as ONE domain asked', r.body.askedDomains === 2, r.body.askedDomains);

  // deep rows with no website are not counted as asked
  await store.pool.query(
    `INSERT INTO brand_evidence_cache (brand_key, lane, brand, website, evidence, outcome, refreshed_at)
     VALUES ('nosite','contacts','nosite',NULL,'{}'::jsonb,'OK',NOW())`);
  r = await get();
  ok('a deep lookup with no website was never asked', r.body.askedDomains === 2, r.body.askedDomains);

  // ── genuinely read only ───────────────────────────────────────────────────
  ok('the route source contains no INSERT/UPDATE/DELETE',
    !/\b(INSERT|UPDATE|DELETE)\b/.test(ROUTE_SRC), (ROUTE_SRC.match(/\b(INSERT|UPDATE|DELETE)\b/) || [])[0]);
  ok('  and no fetch or model call', !/\bfetch\(|oneShot|require\('\.\/ai/.test(ROUTE_SRC));
  const before = (await store.pool.query('SELECT COUNT(*)::int n FROM brand_evidence_cache')).rows[0].n;
  await get(); await get();
  const after = (await store.pool.query('SELECT COUNT(*)::int n FROM brand_evidence_cache')).rows[0].n;
  ok('  running it twice changes no rows', before === after, [before, after]);

  // ── auth ──────────────────────────────────────────────────────────────────
  USER = { email: 'nobody@test.local' };
  r = await get(); ok('a non-admin gets 403', r.status === 403, r.status);
  USER = { email: 'founder@test.local' };
  r = await get(); ok('a founder is allowed', r.status === 200, r.status);
  USER = null;
  r = await get(); ok('logged out gets 403', r.status === 403, r.status);

  await clear();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  server.close(); await store.pool.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
