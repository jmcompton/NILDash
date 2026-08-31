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
// Retiring the queue rows the hometown fallback left behind.
const fs = require('fs'); const http = require('http');
const ROOT = REPO;
const Module = require('module'); const realLoad = Module._load;
Module._load = function (rq, p, m) {
  if (/^\.\/services\//.test(rq)) return realLoad(ROOT + 'server/' + rq.slice(2), p, m);
  return realLoad.apply(this, arguments);
};
const store = require(ROOT + 'server/store.js');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'rq-agent';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const wipe = async () => {
    await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM brand_evidence_cache WHERE brand_key LIKE 'rq%'`).catch(() => {});
  };
  await wipe();

  // One athlete at Auburn; one whose school does not resolve.
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES
    ('rq-a1',$1,'{"name":"Right Town","school":"Auburn University"}'::jsonb),
    ('rq-a2',$1,'{"name":"No Market","school":"Nowhere Tech","hometown":"Knoxville, TN"}'::jsonb)`, [AG]);
  const biz = async (key, brand, addr) => P.query(
    `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
     VALUES ($1,'places',$2,NULL,$3::jsonb,'OK',NOW())`, [key, brand, JSON.stringify({ address: addr })]);
  await biz('rq1', 'Right Cafe', '1 Main St, Auburn, AL 36832, USA');
  await biz('rq2', 'Wrong Cafe', '9 Gay St, Knoxville, TN 37902, USA');
  await biz('rq3', 'Orphan Cafe', '5 Elm St, Knoxville, TN 37902, USA');
  // One queued row PER SLOT: uq_outreach_queue_open enforces (athlete_id, slot)
  // uniqueness among queued rows, which is the real invariant.
  const q = async (id, ath, slot, brand, state) => P.query(
    `INSERT INTO outreach_queue (id, agent_id, athlete_id, slot, brand_key, brand_name, channel, state)
     VALUES ($1,$2,$3,$4,$5,$6,'dm',$7)`, [id, AG, ath, slot, 'k' + id, brand, state]);
  await q(90001, 'rq-a1', 1, 'Right Cafe', 'queued');    // correct city -> keep
  await q(90002, 'rq-a1', 2, 'Wrong Cafe', 'queued');    // wrong city  -> retire
  await q(90003, 'rq-a2', 1, 'Orphan Cafe', 'queued');   // no market   -> retire
  await q(90004, 'rq-a1', 4, 'Wrong Cafe', 'sent');      // ALREADY WORKED -> never touch
  await q(90005, 'rq-a1', 3, 'Unknown Cafe', 'queued');  // no address on file -> keep

  const app = require('express')(); app.use(require('express').json());
  app.use((rq, _r, next) => { rq.session = { userId: 'u1' }; next(); });
  const requireAuth = (_a, _b, next) => next();
  const _inboundAdminOk = () => true;
  const storeShim = { pool: P, getUser: async () => ({ email: 'a@b.c' }) };
  const SRC = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
  const a = SRC.indexOf("app.post('/api/admin/retire-stale-queue'");
  const b = SRC.indexOf('// ── /admin/athlete-markets');
  ok('the endpoint is present', a > 0 && b > a);
  { const store = storeShim; eval(SRC.slice(a, b)); }
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const PORT = srv.address().port;
  const post = async (body) => (await fetch(`http://127.0.0.1:${PORT}/api/admin/retire-stale-queue`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();

  let d = await post({});
  ok('it DRY RUNS by default', d.dryRun === true, d);
  ok('  finds the two stale rows', d.wouldRetire === 2, d.wouldRetire);
  ok('  one of them from an athlete with no market', d.noMarket === 1, d.noMarket);
  ok('  naming which businesses', d.sample.some((x) => x.brand === 'Wrong Cafe'), d.sample);
  const before = (await P.query(`SELECT COUNT(*)::int n FROM outreach_queue WHERE agent_id=$1 AND state='queued'`, [AG])).rows[0].n;
  ok('  and changes NOTHING', before === 4, before);

  d = await post({ confirm: true });
  ok('confirm retires exactly those two', d.retired === 2, d);
  const st = async (id) => (await P.query(`SELECT state, outcome FROM outreach_queue WHERE id=$1`, [id])).rows[0];
  ok('  the right-city card is untouched', (await st(90001)).state === 'queued');
  ok('  the wrong-city card is retired', (await st(90002)).state === 'retired');
  ok('    with the reason recorded', (await st(90002)).outcome === 'wrong-market');
  ok('  the no-market card is retired', (await st(90003)).state === 'retired');
  ok('  A CARD ALREADY SENT IS NEVER TOUCHED', (await st(90004)).state === 'sent', await st(90004));
  ok('  a row with no address is left alone, not guessed at', (await st(90005)).state === 'queued');
  ok('  nothing was deleted', (await P.query(`SELECT COUNT(*)::int n FROM outreach_queue WHERE agent_id=$1`, [AG])).rows[0].n === 5);

  // Retiring frees the slot so tonight re-sources it.
  const Q = require(ROOT + 'server/services/outreachQueue.js');
  const rows = (await P.query(`SELECT slot, state FROM outreach_queue WHERE athlete_id='rq-a2' AND state='queued'`)).rows;
  ok('  and the freed slot is open for re-sourcing', Q.slotsToFill(rows).indexOf(1) !== -1, Q.slotsToFill(rows));

  d = await post({ confirm: true });
  ok('running it again retires nothing (idempotent)', d.retired === 0, d);

  await wipe(); srv.close();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
