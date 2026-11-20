'use strict';
// ── NO MONEY ON CARDS NOBODY OPENS, NO DEAD NIGHT WHEN A PROVIDER RUNS DRY ──
//
//   node tests/spendguard.js
//
// services/serperGuard: Serper calls counted by day and site; a top-up
// recorded; the low-balance warning before it runs out; a billing failure
// opens the breaker so web search and Places move to the next provider.
// jobs/outreachQueue: owner-name results kept in the database across
// processes; an agent who signs in but works no cards goes on the weekly fill;
// on a Hunter cache night the social and national brands are still tried.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('spendguardtest', { schema: true });
process.env.TZ = process.env.TZ || 'America/Chicago';
for (const k of ['BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY', 'SEARCH_PROVIDER', 'PLACES_PROVIDER', 'OUTREACH_QUEUE_UNWORKED']) delete process.env[k];
process.env.SERPER_API_KEY = 'test-serper-key';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 600) : '')); } };

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const store = require(REPO + 'server/store');
  const P = store.pool;
  const SG = require(REPO + 'server/services/serperGuard');
  const WST = require(REPO + 'server/services/webSearchTool');
  const SP = require(REPO + 'server/services/serperPlaces');

  console.log('-- Serper: counted, warned, and a breaker instead of a thousand failures --');
  SG._reset();
  ok('with a key and the breaker closed, Serper is the search provider and answers Places', WST.provider() && WST.provider().name === 'serper' && SP.ON());
  SG.count('search', 3); SG.count('places', 2);
  await SG.flush(P);
  const day = (await P.query(`SELECT site, n FROM serper_usage ORDER BY site`)).rows;
  ok('calls are counted by site', JSON.stringify(day) === JSON.stringify([{ site: 'places', n: 2 }, { site: 'search', n: 3 }]), day);
  let b = await SG.balance(P);
  ok('no top-up on record: usage shown, no balance guessed', b.bought === null && b.left === null && b.last7 === 5, b);
  let c = await SG.check(P, { dryRun: true });
  ok('  and no warning without a top-up to count from', c.warn === false, c);

  await SG.recordTopup(P, 100);
  SG.count('search', 90); await SG.flush(P);
  c = await SG.check(P, { dryRun: true });
  ok('a top-up of 100 with 90 used since: warned before it runs out', c.warn === true && c.left === 10 && /left/.test(c.why), c);
  ok('  a bad top-up amount is refused', (await SG.recordTopup(P, -5)).ok === false && (await SG.recordTopup(P, 'abc')).ok === false);
  const big = await SG.recordTopup(P, 50000);
  ok('  a fresh top-up restarts the count: no warning', big.ok && big.left === 50000 && (await SG.check(P, { dryRun: true })).warn === false, big);

  // Out of credits, through the real failure path.
  const OF = require(REPO + 'server/services/ourFault');
  const e402 = new Error('HTTP 400: {"message":"Not enough credits","statusCode":400}'); e402.status = 400;
  const kind = OF.providerError('serper', e402, 'test');
  ok('"Not enough credits" is a billing failure and opens the breaker', kind === 'billing' && SG.breaker().open === true);
  ok('  while open, nobody sees a Serper key: web search moves on, Places goes to Google', WST.provider() === null && SP.ON() === false
    && WST.PROVIDERS.serper.key() === '');
  process.env.BRAVE_SEARCH_API_KEY = 'test-brave';
  ok('  with another provider set, it answers instead', WST.provider() && WST.provider().name === 'brave');
  delete process.env.BRAVE_SEARCH_API_KEY;
  await SG.recordTopup(P, 50000);
  ok('  recording a top-up closes the breaker at once', SG.breaker().open === false && WST.provider().name === 'serper');
  SG.failed(400, 'Bad request: q is required');
  ok('  an ordinary bad request does not open it', SG.breaker().open === false);
  SG._reset();

  // serperPlaces: a credits failure is recorded and opens the breaker.
  const r = await SP.search({ query: 'coffee shop Waco TX' }, { fetch: async () => ({ ok: false, status: 400, json: async () => ({ message: 'Not enough credits' }) }) });
  ok('a Places call that hits "Not enough credits" fails, and the breaker opens', r.ok === false && SG.breaker().open === true, r);
  SG._reset();

  console.log('-- owner names: kept in the database, not per process --');
  const OQ = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the owner-name search reads and writes owner_name_cache (30 days found, 7 days a miss)',
    /FROM owner_name_cache WHERE key = \$1/.test(OQ) && /INSERT INTO owner_name_cache/.test(OQ) && /FINAL_NAME_DB_FOUND_DAYS = .* 30/.test(OQ) && /FINAL_NAME_DB_MISS_DAYS = .* 7/.test(OQ));
  ok('  a search that threw is never kept (the write follows a returned search only)',
    OQ.indexOf('ONS.findOwnerName({ brand, city') < OQ.indexOf('INSERT INTO owner_name_cache'));

  console.log('-- signed in, not working the cards: the weekly fill --');
  const job = require(REPO + 'server/jobs/outreachQueue');
  const mk = async (id, createdDaysAgo) => {
    await P.query(`INSERT INTO users (id, name, email, password, role, last_login, created_at) VALUES ($1,$1,$1 || '@x.test','x','agent',NOW(), NOW() - ($2 || ' days')::interval)`, [id, String(createdDaysAgo)]);
    await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1 || '-a', $1, '{"name":"Jo Real"}'::jsonb)`, [id]);
  };
  const cards = async (agent, n) => { for (let i = 0; i < n; i++) await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state) VALUES ($1, $1 || '-a', $2::int, $3, $4, 'email', 'queued')`, [agent, i + 1, 'b' + (i + 1), 'Biz ' + (i + 1)]); };
  await mk('sg-idle', 60); await cards('sg-idle', 5);
  await mk('sg-new', 3); await cards('sg-new', 5);
  await mk('sg-busy', 60); await cards('sg-busy', 5);
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, approved_at) VALUES ('sg-log-1', 'sg-busy', 'sg-busy-a', 'Biz 1', NOW() - INTERVAL '2 days')`);
  await mk('sg-few', 60); await cards('sg-few', 2);
  const ag = async (id) => (await P.query(`SELECT id FROM users WHERE id = $1`, [id])).rows[0];
  const idle = await job.unworkedSkip(P, await ag('sg-idle'));
  ok('signed in, 5 cards waiting, none ever approved: weekly fill, and says why', /no card ever approved or sent, 5 waiting/.test(idle || ''), idle);
  ok('  a new account (under 14 days) is never held to it', (await job.unworkedSkip(P, await ag('sg-new'))) === null);
  ok('  an agent who approved a card 2 days ago is filled nightly', (await job.unworkedSkip(P, await ag('sg-busy'))) === null);
  ok('  an agent with fewer than 5 waiting is filled nightly', (await job.unworkedSkip(P, await ag('sg-few'))) === null);
  process.env.OUTREACH_QUEUE_UNWORKED = '0';
  ok('  OUTREACH_QUEUE_UNWORKED=0 turns it off', (await job.unworkedSkip(P, await ag('sg-idle'))) === null);
  delete process.env.OUTREACH_QUEUE_UNWORKED;
  ok('  the nightly run reads it beside the sign-in test, as a dormant account', /inactiveSkip\(a, opts\.now\) \|\| await unworkedSkip\(pool, a\)/.test(OQ));

  console.log('-- a Hunter cache night still tries the social and national brands --');
  ok('the cache skip applies to local businesses only', /HP\.cacheOnly\(\) && \(cand\.lane !== 'social' && cand\.lane !== 'national'\)/.test(OQ));
  ok('  drained in cache mode: the brand rungs are tried before the night stops', OQ.indexOf('await cacheBrandRungs()') > -1
    && OQ.indexOf('await cacheBrandRungs()') < OQ.indexOf("if (ci >= cands.length) { stop = 'cache'; break; }"));
  ok('  under the same lane rules as the ladder (mix seats; never under FIVE without the mix)', /async function cacheBrandRungs\(\)[\s\S]{0,400}mixSeats\(\)\[lane\] <= 0[\s\S]{0,80}FINDER\.five\(\)\) continue/.test(OQ));

  console.log('-- the admin can see and record it --');
  const IDX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('GET /api/admin/serper and POST /api/admin/serper-topup, admin only', /app\.get\('\/api\/admin\/serper', async[\s\S]{0,120}_statusAdminOk/.test(IDX) && /app\.post\('\/api\/admin\/serper-topup', async[\s\S]{0,120}_statusAdminOk/.test(IDX));
  ok('the morning preflight reads the balance and sends the daily warning', /SG\.check\(require\('\.\.\/store'\)\.pool\)/.test(fs.readFileSync(REPO + 'server/services/preflight.js', 'utf8')));
  ok('no em dashes in the new copy', !/—/.test(fs.readFileSync(REPO + 'server/services/serperGuard.js', 'utf8').replace(/\/\/.*$/gm, '')));

  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
