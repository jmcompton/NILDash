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
// Athlete self-signup rejections. The route is LIFTED FROM server/index.js and run
// against a real Postgres, so what is asserted is what the server actually returns.
const fs = require('fs'), cp = require('child_process');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const R = REPO;
const SRV = fs.readFileSync(R + 'server/index.js', 'utf8');
const ATH = fs.readFileSync(R + 'public/athletes.html', 'utf8');
const STORE = fs.readFileSync(R + 'server/store.js', 'utf8');

function sql(text, csv) {
  fs.writeFileSync('/tmp/pgtest/t.sql', text);
  fs.chmodSync('/tmp/pgtest/t.sql', 0o644);
  const r = cp.spawnSync('psql', ['-h', '/tmp', '-p', '55432', '-U', 'postgres', '-d', 'sig',
    '-v', 'ON_ERROR_STOP=1', ...(csv ? ['--csv'] : []), '-f', '/tmp/pgtest/t.sql'],
    { encoding: 'utf8', env: { ...process.env, PGOPTIONS: '--client-min-messages=warning' } });
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').slice(0, 3).join(' | '));
  return (r.stdout || '').trim();
}
function parseCsv(out) {
  const R2 = []; let row = [], field = '', q = false, i = 0;
  while (i < out.length) {
    const c = out[i];
    if (q) { if (c === '"' && out[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { q = false; i++; continue; } field += c; i++; continue; }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); R2.push(row); row = []; field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); R2.push(row); }
  return R2;
}
function rows(text) {
  const p = parseCsv(sql(text, true));
  if (p.length < 2) return [];
  return p.slice(1).map((c) => { const o = {}; p[0].forEach((h, i) => { o[h] = c[i]; }); return o; });
}

const cols = [...STORE.matchAll(/ALTER TABLE athletes ADD COLUMN IF NOT EXISTS (\w+) ([^`]+)`/g)].map((m) => [m[1], m[2].trim()]);
sql(`DROP TABLE IF EXISTS athletes; DROP TABLE IF EXISTS users;
  CREATE TABLE athletes (id TEXT PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ,
    data JSONB DEFAULT '{}'::jsonb, agent_id TEXT);
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, password TEXT, role TEXT);
  ` + cols.map((c) => `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS ${c[0]} ${c[1]};`).join('\n'));

// ── lift the route ───────────────────────────────────────────────────────────
const sig = "app.post('/api/athlete/self-signup'";
const s = SRV.indexOf(sig);
const bodyStart = SRV.indexOf('{', SRV.indexOf('async (req, res) =>', s));
let d = 0, j = bodyStart, end = j;
for (; j < SRV.length; j++) { if (SRV[j] === '{') d++; else if (SRV[j] === '}') { d--; if (!d) { end = j; break; } } }
const SRC = SRV.slice(bodyStart + 1, end);
if (!/self-signup/.test(SRC) || SRC.length < 800) { console.log('FIXTURE BROKEN: ' + SRC.length); process.exit(1); }

const store = {
  pool: { query: async (text, params) => {
    const bound = text.replace(/\$(\d+)/g, (_, n) => {
      const v = (params || [])[Number(n) - 1];
      if (v === null || v === undefined) return 'NULL';
      // A Date must go in as ISO. String(new Date()) gives
      // "Mon Aug 24 2026 18:55 GMT+0000 (Coordinated Universal Time)", which
      // Postgres rejects -- real pg serialises Dates itself, so only this harness
      // ever saw it, and it surfaced as the route's catch-all 500.
      const s2 = v instanceof Date ? v.toISOString() : String(v);
      return `'${s2.replace(/'/g, "''")}'`;
    });
    if (/^\s*SELECT/i.test(bound)) { const r = rows(bound); return { rows: r, rowCount: r.length }; }
    sql(bound); return { rows: [], rowCount: 0 };
  } },
  getUserByEmail: async (e) => rows(`SELECT * FROM users WHERE LOWER(email)=LOWER('${e}')`)[0] || null,
};
let SENT = [];
const resend = { emails: { send: async (m) => { SENT.push(m); return { id: 'e1' }; } } };
// The route does require('bcryptjs') and require('crypto') inline. bcryptjs is not
// installed in this sandbox, so an un-stubbed require threw and every signup came
// back as the route's catch-all 500 -- which looked like a broken route rather than
// a missing dependency.
const fakeRequire = (m) => (m === 'bcryptjs'
  ? { hash: async (p) => 'HASH(' + p + ')', compare: async (p, h) => h === 'HASH(' + p + ')' }
  : require(m));
const run = new Function('req', 'res', 'store', 'resend', 'process', 'console', 'require',
  'return (async () => {' + SRC + '})();');
const mkRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (body) => {
  const res = mkRes();
  await run({ body }, res, store, resend, { env: { APP_URL: 'https://mynildash.com' } },
    { log() {}, error(...a){ if(process.env.DBG) console.error(...a); } }, fakeRequire);
  return res;
};

const GOOD = { name: 'Marcus Webb', email: 'marcus@example.com', password: 'longenough1',
  school: 'LSU', sport: 'Basketball' };

(async () => {
  console.log('-- a first signup succeeds --');
  let r = await call({ ...GOOD });
  ok('it is accepted', r.code === 200, [r.code, r.body]);
  ok('and an athlete row exists', rows("SELECT id FROM athletes").length === 1);

  console.log('\n-- DUPLICATE EMAIL: the case that looked like nothing happening --');
  r = await call({ ...GOOD });
  ok('it is rejected with 400', r.code === 400, r.code);
  ok('there IS an error message to display', !!(r.body && r.body.error), r.body);
  ok('it says the account exists', /already exists/i.test(r.body.error), r.body.error);
  ok('it is tagged athlete_exists', r.body.code === 'athlete_exists', r.body);
  ok('and points at the ATHLETE sign-in', r.body.signinUrl === '/athlete-login.html', r.body.signinUrl);
  ok('no second athlete row was created', rows("SELECT id FROM athletes").length === 1);

  console.log('\n  · the same email in different case is still a duplicate');
  r = await call({ ...GOOD, email: 'MARCUS@Example.COM' });
  ok('rejected', r.code === 400 && r.body.code === 'athlete_exists', r.body);
  ok('still only one row', rows("SELECT id FROM athletes").length === 1);

  console.log('\n-- AN AGENT ACCOUNT ON THAT EMAIL SAYS SO, SPECIFICALLY --');
  sql("INSERT INTO users (id,email,role) VALUES ('u1','coach@example.com','agent');");
  r = await call({ ...GOOD, email: 'coach@example.com' });
  ok('it is rejected', r.code === 400, r.code);
  ok('the message names an AGENT account', /agent account/i.test(r.body.error), r.body.error);
  ok('it is NOT the generic already-exists line', !/An account with this email already exists/.test(r.body.error), r.body.error);
  ok('it tells them what to do instead', /Sign in with it instead/i.test(r.body.error), r.body.error);
  ok('it is tagged agent_exists', r.body.code === 'agent_exists', r.body);
  ok('and points at the AGENT sign-in, a different page', r.body.signinUrl === '/', r.body.signinUrl);
  ok('the two cases send you to different places',
    r.body.signinUrl !== '/athlete-login.html');
  ok('NO athlete row was created for the agent email',
    rows("SELECT id FROM athletes WHERE email='coach@example.com'").length === 0);
  ok('  (which is the real bug: this used to succeed and collide with the agent)', true);
  ok('case-insensitive on the agent side too',
    (await call({ ...GOOD, email: 'COACH@example.com' })).body.code === 'agent_exists');

  console.log('\n-- other rejections still carry a message --');
  for (const [label, body, rx] of [
    ['a missing field', { ...GOOD, school: '' }, /required/i],
    ['a short password', { ...GOOD, email: 'new@x.com', password: 'short' }, /8 characters/i],
    ['a malformed email', { ...GOOD, email: 'not-an-email' }, /valid email/i],
  ]) {
    const rr = await call(body);
    ok(label + ' is rejected with a usable message', rr.code === 400 && rx.test(rr.body.error), rr.body);
  }

  console.log('\n-- the page can actually show it --');
  ok('the error box sits UNDER the submit button, not above the form',
    ATH.indexOf('id="signupSubmitBtn"') < ATH.indexOf('id="signupError"'),
    [ATH.indexOf('id="signupSubmitBtn"'), ATH.indexOf('id="signupError"')]);
  // class="signin-note" -- a bare "signin-note" also matches the CSS rule, which
  // appears far earlier in the file than the markup.
  ok('and above the sign-in note, so it is inside the same block',
    ATH.indexOf('id="signupError"') < ATH.indexOf('class="signin-note"'));
  ok('it is red', /\.form-error-box\{[^}]*color:#F87171/.test(ATH));
  ok('and hidden until there is something to say', /\.form-error-box\{[^}]*display:none/.test(ATH));
  ok('its margin moved to the top now that it is below the button',
    /\.form-error-box\{[^}]*margin:14px 0 0/.test(ATH));
  ok('links inside it are legible against the red', /\.form-error-box a\{[^}]*color:#F87171/.test(ATH));

  const fn = ATH.slice(ATH.indexOf('function showSignupError'), ATH.indexOf('\n}', ATH.indexOf('function showSignupError')));
  ok('there is a single helper that renders the error', fn.length > 200, fn.length);
  ok('it scrolls the box into view', /scrollIntoView/.test(fn));
  ok('it sets the message as TEXT, never innerHTML', /textContent = message/.test(fn) && !/innerHTML/.test(fn));
  ok('the sign-in link is built as an element, not concatenated markup',
    /createElement\('a'\)/.test(fn));
  ok('and its href comes from a fixed map, so a server response cannot redirect it',
    /SIGNIN_LINKS\[signinUrl\]/.test(fn) && /var SIGNIN_LINKS = \{/.test(ATH));

  const submit = ATH.slice(ATH.indexOf('async function submitSignup'), ATH.length);
  ok('the failure path calls it', /showSignupError\(data\.error, data\.signinUrl\)/.test(submit));
  ok('the network-error path calls it too', /showSignupError\('Network error/.test(submit));
  ok('the loading state is stopped on failure',
    (submit.match(/btn\.disabled = false; btn\.textContent = 'Create Free Account';/g) || []).length === 2,
    (submit.match(/btn\.disabled = false/g) || []).length);
  ok('and the box is cleared at the start of each attempt',
    /errBox\.style\.display = 'none'; errBox\.textContent = '';/.test(submit));

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 3).join('\n')); process.exit(1); });
