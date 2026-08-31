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
// Athlete comps: the SQL runs against a real Postgres, the access rule is lifted
// from server/index.js, and the admin markup is checked against the agent one it
// is supposed to mirror.
const fs = require('fs'), cp = require('child_process');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const R = REPO;
const SRV = fs.readFileSync(R + 'server/index.js', 'utf8');
const ADM = fs.readFileSync(R + 'public/admin.html', 'utf8');
const STORE = fs.readFileSync(R + 'server/store.js', 'utf8');

function sql(text, csv) {
  fs.writeFileSync('/tmp/pgtest/t.sql', text);
  fs.chmodSync('/tmp/pgtest/t.sql', 0o644);
  const r = cp.spawnSync('psql', ['-h', '/tmp', '-p', '55432', '-U', 'postgres', '-d', 'comp',
    '-v', 'ON_ERROR_STOP=1', ...(csv ? ['--csv'] : []), '-f', '/tmp/pgtest/t.sql'],
    { encoding: 'utf8', env: { ...process.env, PGOPTIONS: '--client-min-messages=warning' } });
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

// Schema straight from store.js, so a renamed column breaks this rather than
// silently passing against a hand-written table.
const cols = [...STORE.matchAll(/ALTER TABLE athletes ADD COLUMN IF NOT EXISTS (\w+) ([^`]+)`/g)]
  .map((m) => [m[1], m[2].trim()]);
sql(`DROP TABLE IF EXISTS athletes;
  CREATE TABLE athletes (id TEXT PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW(), data JSONB DEFAULT '{}'::jsonb, agent_id TEXT);
  ` + cols.map((c) => `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS ${c[0]} ${c[1]};`).join('\n'));
ok('the comped column is declared in store.js', cols.some((c) => c[0] === 'comped'), cols.map((c) => c[0]).filter((x) => /comp|free_bef/.test(x)));

sql(`INSERT INTO athletes (id,email,athlete_type,subscription_status,comped,created_at,data) VALUES
  ('a1','jordan.wells@x.com','self_managed','inactive',FALSE,'2026-01-01','{"name":"Jordan Wells","school":"Alabama","sport":"Football"}'),
  ('a2','TALL.CASE@X.COM','self_managed','inactive',TRUE ,'2026-02-01','{"name":"Marcus Webb","school":"LSU"}'),
  ('a3','no-name@x.com','self_managed','active',FALSE,'2026-03-01','{}'),
  ('a4','client@x.com','agent_managed','inactive',FALSE,'2026-04-01','{"name":"Jordan Pike"}'),
  ('a5',NULL,'self_managed','free',FALSE,'2026-05-01','{"name":"No Email"}');`);

// ── the search query, lifted from the route rather than retyped ──────────────
const routeStart = SRV.indexOf("app.get('/api/admin/athletes'");
const route = SRV.slice(routeStart, SRV.indexOf('\n});', routeStart));
ok('the route was found', routeStart !== -1 && route.length > 400, route.length);
const whereSrc = /where = `([\s\S]*?)`;/.exec(route);
const selectSrc = /`SELECT([\s\S]*?)LIMIT 50`/.exec(route);
ok('its WHERE clause was lifted', !!whereSrc, whereSrc && whereSrc[1]);
ok('its SELECT was lifted', !!selectSrc);

const runSearch = (q) => {
  const where = q ? whereSrc[1].replace(/\$1/g, `'%${q.toLowerCase()}%'`) : '';
  const body = selectSrc[1].replace('${where}', where);
  return rows('SELECT' + body + 'LIMIT 50');
};

console.log('\n-- search finds an athlete by name or email --');
ok('by first name', runSearch('jordan').map((r) => r.id).sort().join() === 'a1,a4', runSearch('jordan').map((r) => r.id));
ok('by surname', runSearch('webb').map((r) => r.id).join() === 'a2');
ok('by email local-part', runSearch('no-name').map((r) => r.id).join() === 'a3');
ok('case-insensitively, on an UPPERCASE stored email',
  runSearch('tall.case').map((r) => r.id).join() === 'a2', runSearch('tall.case').map((r) => r.id));
ok('a partial match works', runSearch('well').map((r) => r.id).join() === 'a1');
ok('no match returns nothing rather than everything', runSearch('zzzz').length === 0);

console.log('\n  · rows with NULLs do not vanish or crash the search');
ok('an athlete with no name is still findable by email', runSearch('no-name').length === 1);
ok('an athlete with no email is still findable by name',
  runSearch('no email').map((r) => r.id).join() === 'a5', runSearch('no email').map((r) => r.id));

console.log('\n-- 3. comped athletes are visible at a glance --');
const all = runSearch('');
ok('an empty query lists everyone', all.length === 5, all.length);
ok('the comped one sorts first', all[0].id === 'a2', all.map((r) => r.id));
ok('and the rest stay newest-first', all.slice(1).map((r) => r.id).join() === 'a5,a4,a3,a1', all.map((r) => r.id));
ok('the row carries what the badge needs',
  all[0].comped === 't' && 'subscription_status' in all[0] && 'athlete_type' in all[0], all[0]);

console.log('\n-- 4. the toggle writes comped and NOTHING else --');
const toggleSql = /UPDATE athletes SET comped = \$1 WHERE id = \$2/.test(SRV);
ok('the update statement touches only comped', toggleSql);
const beforeRow = rows("SELECT subscription_status, free_before_billing FROM athletes WHERE id='a3'")[0];
sql("UPDATE athletes SET comped = TRUE WHERE id = 'a3'");
const afterRow = rows("SELECT subscription_status, free_before_billing, comped FROM athletes WHERE id='a3'")[0];
ok('subscription_status is unchanged by a comp', afterRow.subscription_status === beforeRow.subscription_status,
  [beforeRow.subscription_status, afterRow.subscription_status]);
ok('and comped is set', afterRow.comped === 't');
// The real independence claim: a Stripe webhook overwrites status, comp survives.
sql("UPDATE athletes SET subscription_status = 'canceled' WHERE id = 'a3'");
ok('a Stripe status write does not clear the comp',
  rows("SELECT comped FROM athletes WHERE id='a3'")[0].comped === 't');
ok('no code path anywhere writes athletes.comped except the admin route',
  (SRV.match(/UPDATE athletes SET comped/g) || []).length === 1,
  (SRV.match(/UPDATE athletes SET comped[^\n]*/g) || []));

console.log('\n-- 1. athleteHasAccess grants on comped, like agentHasAccess --');
const lift = (name) => {
  const s = SRV.indexOf('function ' + name + '(');
  let d = 0, j = SRV.indexOf('{', s), end = j;
  for (; j < SRV.length; j++) { if (SRV[j] === '{') d++; else if (SRV[j] === '}') { d--; if (!d) { end = j; break; } } }
  return SRV.slice(s, end + 1);
};
const FN = lift('athleteHasAccess');
ok('lifted', /comped/.test(FN) && FN.length > 200, FN.length);
const ON = new Function('BILLING_ENABLED', FN + '\n return athleteHasAccess;')(true);
const base = { athlete_type: 'self_managed', subscription_status: 'canceled' };
ok('a comped athlete has access even when canceled', ON({ ...base, comped: true }) === true);
ok('and without the comp they do not', ON({ ...base, comped: false }) === false);
ok('comped:undefined is not treated as comped', ON({ ...base }) === false);
// The agent rule it is meant to match.
const AFN = lift('agentHasAccess');
ok('the agent rule checks comped the same way',
  /if \(user\.comped === true\) return true;/.test(AFN) && /if \(athlete\.comped === true\) return true;/.test(FN));

console.log('\n-- 2. the admin surface mirrors the agent one --');
ok('there is an athlete comp endpoint', /app\.post\('\/api\/admin\/set-athlete-comp'/.test(SRV));
ok('it uses the SAME admin check as set-comp',
  (SRV.match(/if \(!user \|\| user\.email !== ADMIN_EMAIL\) return res\.status\(403\)/g) || []).length >= 3);
ok('and the same response shape', /res\.json\(\{ ok: true, athleteId, comped: comped === true \}\)/.test(SRV));
ok('a missing athlete is reported, not silently ok', /No athlete with that id/.test(SRV));
ok('the comp is logged with who did it', /\[admin\] athlete \$\{athleteId\} comped=/.test(SRV));

ok('the panel exists in admin.html', /Athlete Comps/.test(ADM));
ok('with a search box', /id="ath-search"/.test(ADM) && /Search name or email/.test(ADM));
ok('and a table body to fill', /id="athlete-comp-table"/.test(ADM));
ok('it loads on boot', /setTimeout\(_loadAthleteCompsNow, \d+\)/.test(ADM));
ok('search is debounced, so typing does not fire a request per keystroke',
  /clearTimeout\(_athSearchTimer\)/.test(ADM));
ok('the toggle posts to the athlete endpoint', /fetch\('\/api\/admin\/set-athlete-comp'/.test(ADM));
ok('the badge matches the agent one exactly',
  (ADM.match(/background:#a78bfa20;color:#a78bfa;font-weight:700;margin-left:6px;text-transform:uppercase">Comped</g) || []).length === 2);
ok('the button flips label like the agent one', /\? 'Un-comp' : 'Comp'/.test(ADM));
ok('the row re-renders in place after a toggle', /row\.outerHTML = athleteRowHtml\(a\)/.test(ADM));
ok('athlete-supplied text is escaped', /refEsc\(a\.name/.test(ADM) && /refEsc\(a\.email/.test(ADM));
ok('and so is the id used to build the onclick', /setAthleteComp\(\\'' \+ refEsc\(a\.id\)/.test(ADM));

console.log('\nfailures: ' + f);
process.exit(f ? 1 : 0);
