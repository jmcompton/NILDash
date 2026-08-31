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
// Athlete billing, end to end, against a REAL Postgres.
//
// The webhook handler and the access rules are LIFTED FROM server/index.js rather
// than restated here, so the test cannot pass while the shipped code says something
// else. `pg` is not installed, so SQL goes through psql.
const fs = require('fs'), cp = require('child_process');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const SRV = fs.readFileSync(REPO + 'server/index.js', 'utf8');

// ── psql plumbing ────────────────────────────────────────────────────────────
function sql(text, csv) {
  fs.writeFileSync('/tmp/pgtest/t.sql', text);
  fs.chmodSync('/tmp/pgtest/t.sql', 0o644);
  const r = cp.spawnSync('psql', ['-h', '/tmp', '-p', '55432', '-U', 'postgres', '-d', 'billing',
    '-v', 'ON_ERROR_STOP=1', ...(csv ? ['--csv'] : []), '-f', '/tmp/pgtest/t.sql'], { encoding: 'utf8', env: { ...process.env, PGOPTIONS: '--client-min-messages=warning' } });
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').slice(0, 3).join(' | '));
  return (r.stdout || '').trim();
}
function rows(text) {
  const out = sql(text, true);
  const lines = out.split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const head = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const c = l.split(','), o = {};
    head.forEach((h, i) => { o[h] = c[i]; });
    return o;
  });
}

// ── schema: the athlete columns exactly as store.js declares them ────────────
const STORE = fs.readFileSync(REPO + 'server/store.js', 'utf8');
// Capture to the closing backtick of the JS template literal. A \S+ on the DEFAULT
// swallowed the backtick and comma from the source line and produced
// "BOOLEAN DEFAULT FALSE`," as a column type.
const athleteCols = [...STORE.matchAll(/ALTER TABLE athletes ADD COLUMN IF NOT EXISTS (\w+) ([^`]+)`/g)]
  .map((m) => [m[0], m[1], m[2].trim()]);
if (athleteCols.length < 15) { console.log('FIXTURE BROKEN: lifted ' + athleteCols.length + ' athlete columns'); process.exit(1); }
sql(`DROP TABLE IF EXISTS athletes; DROP TABLE IF EXISTS users;
  CREATE TABLE athletes (id TEXT PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW(), data JSONB DEFAULT '{}'::jsonb, agent_id TEXT);
  CREATE TABLE users (id TEXT PRIMARY KEY, stripe_customer_id TEXT, stripe_subscription_id TEXT, subscription_status TEXT);
  ` + athleteCols.map((m) => `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS ${m[1]} ${m[2]};`).join('\n'));
console.log('-- schema built from store.js: ' + athleteCols.length + ' athlete columns --');
ok('the new columns exist', /comped/.test(sql('SELECT string_agg(column_name,\',\') FROM information_schema.columns WHERE table_name=\'athletes\''))
  && /free_before_billing/.test(sql('SELECT string_agg(column_name,\',\') FROM information_schema.columns WHERE table_name=\'athletes\'')));

// ── lift the webhook handler and run it for real ─────────────────────────────
// Everything between the route opening and `res.json({ received: true })`.
const wStart = SRV.indexOf("app.post('/api/athlete/stripe-webhook'");
const wEnd = SRV.indexOf('res.json({ received: true });', wStart);
if (wStart === -1 || wEnd === -1 || wEnd < wStart) { console.log('FIXTURE BROKEN: no webhook body'); process.exit(1); }
const bodyStart = SRV.indexOf('let event;', wStart);
const HANDLER_SRC = SRV.slice(SRV.indexOf('if (event.type', bodyStart), wEnd);
if (!/checkout\.session\.completed/.test(HANDLER_SRC) || HANDLER_SRC.length < 1500) {
  console.log('FIXTURE BROKEN: webhook body is ' + HANDLER_SRC.length + ' chars'); process.exit(1);
}

// A store double that runs the real SQL through psql, so the queries are executed
// exactly as written, against the real schema.
const store = { pool: { query: async (text, params) => {
  let i = 0;
  const bound = text.replace(/\$(\d+)/g, (_, n) => {
    const v = params[Number(n) - 1];
    return v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
  });
  i = i; // no-op, keeps the shape obvious
  const isSelect = /^\s*SELECT/i.test(bound);
  if (isSelect) return { rows: rows(bound) };
  sql(bound);
  return { rows: [] };
} } };

const runWebhook = new Function('event', 'store', 'console',
  'return (async () => {' + HANDLER_SRC + '})();');

const fire = (event) => runWebhook(event, store, { log() {}, error() {} });

// ── fixtures ─────────────────────────────────────────────────────────────────
const seed = () => sql(`
  DELETE FROM athletes; DELETE FROM users;
  INSERT INTO athletes (id, email, athlete_type, subscription_status, onboarding_complete)
    VALUES ('ath-self','self@x.com','self_managed','inactive',FALSE);
  INSERT INTO athletes (id, email, athlete_type, subscription_status, stripe_customer_id)
    VALUES ('ath-cust','cust@x.com','self_managed','inactive','cus_1');
  INSERT INTO athletes (id, email, athlete_type, subscription_status, free_before_billing)
    VALUES ('ath-old','old@x.com','self_managed','free',NOW());
  INSERT INTO athletes (id, email, athlete_type, subscription_status, agent_id)
    VALUES ('ath-agent','agent@x.com','agent_managed','inactive','u1');
  INSERT INTO users (id, stripe_customer_id, subscription_status) VALUES ('u1','cus_agent','active');
`);
const get = (id) => rows(`SELECT * FROM athletes WHERE id='${id}'`)[0];

console.log('\n-- 4. checkout.session.completed ACTUALLY marks an athlete paid --');
(async () => {
  seed();
  await fire({ type: 'checkout.session.completed',
    data: { object: { metadata: { athlete_id: 'ath-self' }, subscription: 'sub_1' } } });
  const a = get('ath-self');
  ok('subscription_status becomes active', a.subscription_status === 'active', a.subscription_status);
  ok('the subscription id is stored', a.stripe_subscription_id === 'sub_1', a.stripe_subscription_id);
  ok('and onboarding is completed', a.onboarding_complete === 't', a.onboarding_complete);

  console.log('\n  · it does not touch anyone else');
  ok('the agent-managed athlete is untouched', get('ath-agent').subscription_status === 'inactive');
  ok('the grandfathered athlete is untouched', get('ath-old').subscription_status === 'free');

  console.log('\n  · an event with no athlete_id is a no-op, not a crash');
  seed();
  await fire({ type: 'checkout.session.completed', data: { object: { metadata: {}, subscription: 'sub_x' } } });
  ok('nobody is activated', get('ath-self').subscription_status === 'inactive');

  console.log('\n  · a replayed event is idempotent (Stripe retries)');
  seed();
  const ev = { type: 'checkout.session.completed', data: { object: { metadata: { athlete_id: 'ath-self' }, subscription: 'sub_1' } } };
  await fire(ev); await fire(ev);
  ok('still exactly one active athlete',
    rows("SELECT COUNT(*) c FROM athletes WHERE subscription_status='active'")[0].c === '1');

  console.log('\n-- the full lifecycle reaches athletes, not just users --');
  seed();
  await fire({ type: 'customer.subscription.updated',
    data: { object: { id: 'sub_2', customer: 'cus_1', status: 'past_due' } } });
  ok('past_due lands on the athlete row', get('ath-cust').subscription_status === 'past_due',
    get('ath-cust').subscription_status);
  ok('and the subscription id is linked', get('ath-cust').stripe_subscription_id === 'sub_2');

  await fire({ type: 'customer.subscription.updated',
    data: { object: { id: 'sub_2', customer: 'cus_1', status: 'active' } } });
  ok('recovering to active is reflected', get('ath-cust').subscription_status === 'active');

  await fire({ type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_2', customer: 'cus_1', status: 'canceled' } } });
  ok('a delete deactivates', ['canceled', 'inactive'].includes(get('ath-cust').subscription_status),
    get('ath-cust').subscription_status);

  console.log('\n  · a cancel must NOT strip the grandfather stamp');
  seed();
  sql("UPDATE athletes SET stripe_customer_id='cus_2' WHERE id='ath-old'");
  await fire({ type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_3', customer: 'cus_2', status: 'canceled' } } });
  ok('free_before_billing survives', !!get('ath-old').free_before_billing, get('ath-old').free_before_billing);

  // ── access rules, lifted ───────────────────────────────────────────────────
  console.log('\n-- 2/6. athleteHasAccess --');
  const fnStart = SRV.indexOf('function athleteHasAccess(');
  let d = 0, j = SRV.indexOf('{', fnStart), end = j;
  for (; j < SRV.length; j++) { if (SRV[j] === '{') d++; else if (SRV[j] === '}') { d--; if (!d) { end = j; break; } } }
  const FN_SRC = SRV.slice(fnStart, end + 1);
  ok('the access function was lifted', /BILLING_ENABLED/.test(FN_SRC) && FN_SRC.length > 200, FN_SRC.length);
  const mk = (flag) => new Function('BILLING_ENABLED', FN_SRC + '\n return athleteHasAccess;')(flag);
  const OFF = mk(false), ON = mk(true);

  const self = (o) => Object.assign({ athlete_type: 'self_managed', subscription_status: 'inactive' }, o);
  console.log('  · billing OFF: nothing changes for anyone');
  ok('an unsubscribed athlete has access', OFF(self({})) === true);
  ok('so does one with no row at all', OFF(null) === true);
  ok('and an agent-managed one', OFF({ athlete_type: 'agent_managed' }) === true);

  console.log('  · billing ON');
  ok('an unsubscribed self-managed athlete is blocked', ON(self({})) === false);
  ok('active passes', ON(self({ subscription_status: 'active' })) === true);
  ok('trialing passes', ON(self({ subscription_status: 'trialing' })) === true);
  ok('past_due is blocked', ON(self({ subscription_status: 'past_due' })) === false);
  ok('canceled is blocked', ON(self({ subscription_status: 'canceled' })) === false);
  ok('agent-managed always passes: their agent pays', ON({ athlete_type: 'agent_managed' }) === true);
  ok('comped passes', ON(self({ comped: true })) === true);
  ok('grandfathered passes', ON(self({ free_before_billing: '2026-08-01' })) === true);
  ok("the legacy 'free' status passes too", ON(self({ subscription_status: 'free' })) === true);
  ok('a grandfathered athlete survives a cancellation',
    ON(self({ free_before_billing: '2026-08-01', subscription_status: 'canceled' })) === true);

  console.log('\n-- 5. the flag really is off in the shipped code --');
  ok('BILLING_ENABLED still defaults false',
    /const BILLING_ENABLED = process\.env\.BILLING_ENABLED === 'true'/.test(SRV));
  ok('the gate returns immediately while it is off',
    /async function requireAthleteSubscription\(req, res, next\) \{\s*\n\s*if \(!BILLING_ENABLED\) return next\(\);/.test(SRV));
  ok('and the access rule short-circuits first',
    /function athleteHasAccess\(athlete\) \{\s*\n\s*if \(!BILLING_ENABLED\) return true;/.test(SRV));
  ok('the free path still runs before any Stripe call',
    SRV.indexOf("if (!BILLING_ENABLED) {") < SRV.indexOf('billing on — opening checkout'));

  console.log('\n-- 3. every athlete route that spends tokens is gated --');
  // Select by the AUTH middleware, not by path. "/api/athlete" is a prefix of
  // "/api/athletes", so a path match pulled in /api/athletes/:id/contracts/extract
  // -- an AGENT route on requireAuth + requireAgentSubscription, correctly gated
  // for the other audience. verifyAthleteToken is what actually makes a route
  // athlete-facing.
  const athleteAi = [...SRV.matchAll(/app\.(?:get|post|put|patch)\('([^']*)'([^\n]*verifyAthleteToken[^\n]*aiLimiter[^\n]*)/g)];
  ok('there are athlete AI routes to check', athleteAi.length >= 12, athleteAi.length);
  const ungated = athleteAi.filter((m) => !/requireAthleteSubscription/.test(m[2])).map((m) => m[1]);
  ok('none is reachable without a subscription', ungated.length === 0, ungated);
  ok('the gate runs after the token check, never before',
    !/requireAthleteSubscription, verifyAthleteToken/.test(SRV));
  ok('and before the rate limiter, matching the agent side',
    !/aiLimiter, requireAthleteSubscription/.test(SRV));

  console.log('\n-- the three paths that can mark an athlete paid all exist --');
  ok('1. the webhook', /const athleteId = session\.metadata && session\.metadata\.athlete_id/.test(SRV));
  ok('2. the success redirect', /app\.get\('\/api\/athlete\/stripe-complete'/.test(SRV));
  ok('3. the self-heal asks Stripe directly',
    /requireAthleteSubscription[\s\S]{0,2000}stripe\.subscriptions\.list\(\{[\s\S]{0,120}customer: athlete\.stripe_customer_id/.test(SRV));
  ok('the self-heal reads the DB, not the 30-day JWT',
    /requireAthleteSubscription[\s\S]{0,700}FROM athletes WHERE id = \$1/.test(SRV));
  ok('a locked-out athlete has a way to pay',
    /app\.post\('\/api\/athlete\/create-checkout', verifyAthleteToken/.test(SRV));
  ok('checkout reuses an existing customer instead of making a second one',
    /let customerId = athlete\.stripe_customer_id;\s*\n\s*if \(!customerId\)/.test(SRV));
  ok('the free-forever bypass on Stripe failure is gone',
    !/return await _issueJwtAndRedirect\('trialing'\)/.test(SRV));

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message); process.exit(1); });
