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
// Athlete signups panel. The two things that matter: it must be READ ONLY, and
// every column it selects must exist or the whole panel errors.
const fs = require('fs');
const SRV = fs.readFileSync(REPO + 'server/index.js', 'utf8');
const STORE = fs.readFileSync(REPO + 'server/store.js', 'utf8');
const HTML = fs.readFileSync(REPO + 'public/index.html', 'utf8');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}

// The route body, by brace matching from its app.get.
const start = SRV.indexOf("app.get('/api/admin/athlete-signups'");
ok('the route exists', start > -1, start);
let depth = 0, end = start;
for (let i = SRV.indexOf('{', start); i < SRV.length; i++) {
  if (SRV[i] === '{') depth++;
  else if (SRV[i] === '}') { depth--; if (!depth) { end = i; break; } }
}
const ROUTE = SRV.slice(start, end + 1);

console.log('-- READ ONLY --');
for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE']) {
  ok(`no ${verb} anywhere in the route`, !new RegExp('\\b' + verb + '\\b').test(ROUTE), verb);
}
ok('every query is a SELECT', (ROUTE.match(/store\.pool\.query\(/g) || []).length === 3,
  (ROUTE.match(/store\.pool\.query\(/g) || []).length);
ok('three SELECT statements, one per query', (ROUTE.match(/\bSELECT\b/g) || []).length === 3,
  (ROUTE.match(/\bSELECT\b/g) || []).length);
ok('no store write helper is called',
  !/store\.(save|delete|update|insert|upsert)/i.test(ROUTE), null);

console.log('-- admin gated --');
ok('checks the session user', /store\.getUser\(req\.session\.userId\)/.test(ROUTE), null);
ok('403s anyone who is not the admin email',
  /user\.email !== ADMIN_EMAIL\) return res\.status\(403\)/.test(ROUTE), null);
ok('the gate is the FIRST thing, before any query',
  ROUTE.indexOf('ADMIN_EMAIL') < ROUTE.indexOf('store.pool.query'), null);

console.log('-- every selected column actually exists on athletes --');
// A column that does not exist throws and the whole panel shows an error, so this
// is checked against the schema rather than assumed.
const BASE = ['id', 'agent_id', 'data', 'created_at', 'updated_at'];
const added = [...STORE.matchAll(/ALTER TABLE athletes ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
const known = new Set([...BASE, ...added]);
const selected = ['id', 'email', 'email_verified', 'subscription_status', 'created_at',
  'account_activated_at', 'last_login', 'athlete_type', 'agent_id', 'data'];
for (const c of selected) ok(`athletes.${c} exists`, known.has(c), [...known].slice(0, 40));
ok('last_login_at is NOT referenced, the column is last_login',
  !/last_login_at/.test(ROUTE), null);

console.log('-- the queries answer the actual question --');
ok('groups by athlete_type and subscription_status',
  /GROUP BY 1, 2/.test(ROUTE) && /athlete_type/.test(ROUTE) && /subscription_status/.test(ROUTE), null);
ok('reports MAX(created_at)', /MAX\(created_at\)/.test(ROUTE), null);
ok('NULL athlete_type is its own bucket, not folded into a default',
  /COALESCE\(athlete_type, '\(null\)'\)/.test(ROUTE), null);
ok('finds self-serve rows by type OR the self- id prefix',
  /athlete_type = 'self_managed' OR id LIKE 'self-%'/.test(ROUTE), null);
ok('the self-signup list is capped, this is a check not an export',
  /LIMIT 25/.test(ROUTE), null);
ok('counts rows with no agent', /agent_id IS NULL/.test(ROUTE), null);

console.log('-- the panel --');
ok('lives in the Growth view', HTML.indexOf('Athlete signups') > HTML.indexOf('id="view-growth"'), null);
ok('is before the Growth sub-tab nav, with the other admin panels',
  HTML.indexOf('Athlete signups') < HTML.indexOf('gtab-prospects-btn'), null);
ok('has a button wired to the loader', /onclick="_athleteSignups\(this\)"/.test(HTML), null);
ok('the loader issues a GET, not a POST',
  /_athleteSignups[\s\S]{0,600}?fetch\(API_BASE \+ '\/api\/admin\/athlete-signups', \{ credentials: 'include' \}\)/.test(HTML),
  null);
ok('no method: POST anywhere in the loader',
  !/_athleteSignups[\s\S]{0,1200}?method: 'POST'/.test(HTML), null);
ok('sends the session cookie', /athlete-signups', \{ credentials: 'include' \}/.test(HTML), null);

console.log('-- rendering --');
ok('states the answer plainly when there ARE signups',
  /self-serve signup\(s\) came through \/athletes while it was unlinked/.test(HTML), null);
ok('and plainly when there are none',
  /No self-serve signups\. Nobody has reached \/athletes\./.test(HTML), null);
ok('escapes every interpolated value', /_athSigEsc/.test(HTML), null);
ok('emails are escaped, not injected raw',
  /_athSigEsc\(a\.email \|\| '\(no email\)'\)/.test(HTML), null);
ok('names are escaped', /_athSigEsc\(a\.name \|\| '\(no name\)'\)/.test(HTML), null);
ok('handles a null date rather than printing Invalid Date',
  /if \(!ts\) return 'never';/.test(HTML), null);
ok('handles an unparseable date too', /isNaN\(d\.getTime\(\)\)/.test(HTML), null);

// The escape helper, run for real.
const esc = new Function('return ' + (HTML.match(/function _athSigEsc\(s\) \{[\s\S]*?\n\}/) || [''])[0]
  .replace('function _athSigEsc(s)', 'function(s)') + ';')();
ok('escaping works on a script tag',
  esc('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;',
  esc('<script>alert(1)</script>'));
ok('escaping handles quotes', esc(`a"b'c`) === 'a&quot;b&#39;c', esc(`a"b'c`));
ok('null becomes empty, not the string null', esc(null) === '', esc(null));

const dt = new Function('return ' + (HTML.match(/function _athSigDate\(ts\) \{[\s\S]*?\n\}/) || [''])[0]
  .replace('function _athSigDate(ts)', 'function(ts)') + ';')();
ok('a null date reads as never', dt(null) === 'never', dt(null));
ok('a real date renders with an age', /\d{4}-\d{2}-\d{2} \(/.test(dt(new Date().toISOString())),
  dt(new Date().toISOString()));
ok('garbage passes through rather than showing Invalid Date',
  dt('not-a-date') === 'not-a-date', dt('not-a-date'));

console.log('');
console.log('failures: ' + fails);
process.exit(fails ? 1 : 0);
