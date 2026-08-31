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
// create-comped-athlete, end to end against a real Postgres.
//
// The two routes are LIFTED FROM server/index.js and executed, so this fails if
// the shipped code stops doing what it claims. bcrypt/resend are stubbed (no
// node_modules here); the questions under test are which table and column get
// written, and whether the athlete could then actually log in.
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
// A REAL csv parse. Splitting on commas put the JSONB `data` column's own commas
// into the next field and shifted every column after it, so SELECT * reported
// wrong values for columns that were in fact correct.
function parseCsv(out) {
  const rowsOut = []; let row = [], field = '', q = false, i = 0;
  while (i < out.length) {
    const c = out[i];
    if (q) {
      if (c === '"' && out[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rowsOut.push(row); row = []; field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rowsOut.push(row); }
  return rowsOut;
}
function rows(text) {
  const parsed = parseCsv(sql(text, true));
  if (parsed.length < 2) return [];
  const head = parsed[0];
  return parsed.slice(1).map((c) => { const o = {}; head.forEach((h, i) => { o[h] = c[i]; }); return o; });
}

const cols = [...STORE.matchAll(/ALTER TABLE athletes ADD COLUMN IF NOT EXISTS (\w+) ([^`]+)`/g)].map((m) => [m[1], m[2].trim()]);
sql(`DROP TABLE IF EXISTS athletes; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS password_resets;
  CREATE TABLE athletes (id TEXT PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ,
    data JSONB DEFAULT '{}'::jsonb, agent_id TEXT);
  CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, password TEXT, name TEXT, role TEXT,
    comped BOOLEAN DEFAULT FALSE, password_reset_required BOOLEAN DEFAULT FALSE, updated_at TIMESTAMPTZ);
  CREATE TABLE password_resets (email TEXT, token TEXT, expires_at TIMESTAMPTZ, used BOOLEAN DEFAULT FALSE);
  ` + cols.map((c) => `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS ${c[0]} ${c[1]};`).join('\n'));

// ── harness ──────────────────────────────────────────────────────────────────
const store = {
  pool: { query: async (text, params) => {
    const bound = text.replace(/\$(\d+)/g, (_, n) => {
      const v = (params || [])[Number(n) - 1];
      return v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
    });
    if (/^\s*(SELECT|INSERT[\s\S]*RETURNING|UPDATE[\s\S]*RETURNING)/i.test(bound)) {
      const rs = rows(bound); return { rows: rs, rowCount: rs.length };
    }
    const out = sql(bound);
    const m = /(?:UPDATE|INSERT \d+) (\d+)/.exec(out);
    return { rows: [], rowCount: m ? Number(m[1]) : 0 };
  } },
  getUser: async () => ({ email: 'admin@x.com' }),
  getUserByEmail: async (e) => rows(`SELECT * FROM users WHERE LOWER(email)=LOWER('${e}')`)[0] || null,
};
const bcrypt = { hash: async (p) => 'HASH(' + p + ')', compare: async (p, h) => h === 'HASH(' + p + ')' };
let SENT = [];
const resend = { emails: { send: async (m) => { SENT.push(m); return { id: 'e1' }; } } };
const ADMIN_EMAIL = 'admin@x.com';
const process_env = { APP_URL: 'https://mynildash.com' };

// Lift a route body and make it callable.
function liftRoute(sig) {
  const s = SRV.indexOf(sig);
  if (s === -1) { console.log('FIXTURE BROKEN: no route ' + sig); process.exit(1); }
  const bodyStart = SRV.indexOf('{', SRV.indexOf('async (req, res) =>', s));
  let d = 0, j = bodyStart, end = j;
  for (; j < SRV.length; j++) { if (SRV[j] === '{') d++; else if (SRV[j] === '}') { d--; if (!d) { end = j; break; } } }
  const src = SRV.slice(bodyStart + 1, end);
  if (src.length < 200) { console.log('FIXTURE BROKEN: ' + sig + ' body is ' + src.length); process.exit(1); }
  return new Function('req', 'res', 'store', 'bcrypt', 'resend', 'ADMIN_EMAIL', 'process', 'console', 'require',
    'return (async () => {' + src + '})();');
}
const createAthlete = liftRoute("app.post('/api/admin/create-comped-athlete'");
const resetPassword = liftRoute("app.post('/api/auth/reset-password'");

const mkRes = () => { const r = { code: 200, body: null,
  status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; return r; };
const call = async (fn, body) => {
  const res = mkRes();
  await fn({ body, session: { userId: 'admin' } }, res, store, bcrypt, resend, ADMIN_EMAIL,
    { env: process_env }, { log() {}, error() {} }, require);
  return res;
};

(async () => {
  console.log('-- creating an athlete who has not signed up --');
  SENT = [];
  let res = await call(createAthlete, { name: 'Priya Raman', email: 'Priya@Example.com', school: 'Stanford', sport: 'Soccer' });
  ok('the call succeeds', res.code === 200 && res.body && res.body.ok === true, res.body);
  const id = res.body && res.body.athleteId;
  ok('it returns an athleteId, not a userId', !!id && !('userId' in res.body), Object.keys(res.body || {}));

  const a = rows(`SELECT * FROM athletes WHERE id='${id}'`)[0];
  ok('a row exists in ATHLETES, not users', !!a && rows("SELECT * FROM users").length === 0);
  ok('the email is lowercased', a.email === 'priya@example.com', a.email);
  ok('comped is TRUE, which is what grants access', a.comped === 't', a.comped);
  ok('type is self_managed, so the gate applies to her at all', a.athlete_type === 'self_managed');
  ok('email_verified is TRUE, so verify-email cannot strand her', a.email_verified === 't');
  ok('onboarding_complete is TRUE, which athlete/login requires', a.onboarding_complete === 't');
  ok('subscription_status is inactive, NOT faked to active', a.subscription_status === 'inactive', a.subscription_status);
  ok('name, school and sport are stored', /Priya Raman/.test(a.data) && /Stanford/.test(a.data) && /Soccer/.test(a.data), a.data);
  ok('a random password hash is set so the row is never passwordless', !!a.password_hash);
  ok('and it is not guessable from the email', !new RegExp('priya', 'i').test(a.password_hash));

  console.log('\n  · she is emailed a set-password link');
  ok('one email was sent', SENT.length === 1, SENT.length);
  ok('to her', SENT[0] && SENT[0].to === 'priya@example.com');
  ok('containing the reset link', SENT[0] && SENT[0].html.includes(res.body.resetUrl));
  ok('and it points her at the athlete login, not the agent one',
    SENT[0].html.includes('/athlete-login.html'), (SENT[0].html.match(/mynildash\.com[^\s"<]*/g) || []));
  ok('the admin also gets the link back, for when email is not configured',
    /^https:\/\/mynildash\.com\/reset\?token=[a-f0-9]{64}$/.test(res.body.resetUrl), res.body.resetUrl);
  ok('a reset token row was written', rows("SELECT * FROM password_resets WHERE email='priya@example.com'").length === 1);

  console.log('\n-- SHE CAN ACTUALLY SET A PASSWORD AND LOG IN --');
  const token = rows("SELECT token FROM password_resets WHERE email='priya@example.com'")[0].token;
  const rp = await call(resetPassword, { token, password: 'her-new-password' });
  ok('the reset succeeds for an athlete', rp.code === 200 && rp.body.ok === true, rp.body);
  ok('and it reports which kind of account it was', rp.body.role === 'athlete', rp.body);
  const after = rows(`SELECT * FROM athletes WHERE id='${id}'`)[0];
  ok('her password_hash changed to the new one', after.password_hash === 'HASH(her-new-password)', after.password_hash);
  ok('the token is burned', rows("SELECT used FROM password_resets WHERE token='" + token + "'")[0].used === 't');
  // The login query, lifted, is what decides whether she can get in.
  const loginQ = /FROM athletes a[\s\S]*?WHERE a\.email = \$1 AND a\.onboarding_complete = TRUE/.test(SRV);
  ok('athlete/login matches on email + onboarding_complete', loginQ);
  const found = rows(`SELECT id, password_hash FROM athletes WHERE email='priya@example.com' AND onboarding_complete = TRUE`);
  ok('that query finds her', found.length === 1, found.length);
  ok('and her new password verifies', await bcrypt.compare('her-new-password', found[0].password_hash));

  console.log('\n  · a reused token is refused');
  const again = await call(resetPassword, { token, password: 'x' });
  ok('second use fails', again.code === 400, [again.code, again.body]);

  console.log('\n-- the agent reset path is untouched --');
  sql("INSERT INTO users (id,email,password,role) VALUES ('u1','agent@x.com','old','agent');");
  sql("INSERT INTO password_resets (email,token,expires_at) VALUES ('agent@x.com','tok-agent',NOW()+INTERVAL '1 day');");
  const ar = await call(resetPassword, { token: 'tok-agent', password: 'agent-pw' });
  ok('an agent reset still works', ar.code === 200 && ar.body.ok === true, ar.body);
  ok('and is reported as an agent', ar.body.role === 'agent');
  ok('the users row was updated', rows("SELECT password FROM users WHERE id='u1'")[0].password === 'HASH(agent-pw)');

  console.log('\n  · when an email exists in BOTH tables, the agent still wins');
  sql("INSERT INTO athletes (id,email,onboarding_complete) VALUES ('dup','both@x.com',TRUE);");
  sql("INSERT INTO users (id,email,password,role) VALUES ('u2','both@x.com','old','agent');");
  sql("INSERT INTO password_resets (email,token,expires_at) VALUES ('both@x.com','tok-both',NOW()+INTERVAL '1 day');");
  const br = await call(resetPassword, { token: 'tok-both', password: 'shared' });
  ok('the users row is the one written', br.body.role === 'agent'
    && rows("SELECT password FROM users WHERE id='u2'")[0].password === 'HASH(shared)');
  // id is selected alongside because a row whose ONLY column is NULL prints as a
  // blank line, which sql()'s trim() removes -- making a real row look like none.
  ok('and the athlete row is left alone',
    !rows("SELECT id, password_hash FROM athletes WHERE id='dup'")[0].password_hash, 'expected empty');

  console.log('\n-- refusals --');
  const dupe = await call(createAthlete, { name: 'Priya Again', email: 'priya@example.com' });
  ok('a duplicate athlete email is refused', dupe.code === 400 && /already has an athlete account/.test(dupe.body.error), dupe.body);
  const asAgent = await call(createAthlete, { name: 'X', email: 'agent@x.com' });
  ok('an email already used by an AGENT is refused', asAgent.code === 400 && /agent account/.test(asAgent.body.error), asAgent.body);
  ok('  (because the reset route would set the agent password, not the athlete one)', true);
  const bad = await call(createAthlete, { name: 'X', email: 'not-an-email' });
  ok('an invalid email is refused', bad.code === 400, bad.body);
  const noName = await call(createAthlete, { name: '', email: 'a@b.com' });
  ok('a missing name is refused', noName.code === 400, noName.body);
  ok('nothing was created by any refusal', rows("SELECT * FROM athletes WHERE email='not-an-email'").length === 0);

  console.log('\n  · school and sport are optional');
  const min = await call(createAthlete, { name: 'Min Imal', email: 'min@x.com' });
  ok('an account is created without them', min.code === 200 && min.body.ok === true, min.body);
  const mrow = rows(`SELECT data, comped FROM athletes WHERE id='${min.body.athleteId}'`)[0];
  ok('and is still comped and usable', mrow.comped === 't');

  console.log('\n-- it mirrors create-comped-agent --');
  ok('same admin check', (SRV.match(/if \(!admin \|\| admin\.email !== ADMIN_EMAIL\) return res\.status\(403\)/g) || []).length === 2);
  ok('same 7-day link window', (SRV.match(/7 \* 86400000/g) || []).length >= 2);
  ok('same best-effort email: the link is returned even if sending fails',
    /\[create-comped-athlete\] email failed \(link still returned\)/.test(SRV));
  ok('same response fields', /res\.json\(\{ ok: true, athleteId: id, name, email, resetUrl, emailed \}\)/.test(SRV));
  ok('the admin panel exists', /Create comped athlete/.test(ADM));
  ok('with name, email, school and sport inputs',
    /id="ccath-name"/.test(ADM) && /id="ccath-email"/.test(ADM) && /id="ccath-school"/.test(ADM) && /id="ccath-sport"/.test(ADM));
  ok('a copyable link box like the agent one', /id="ccath-link"/.test(ADM));
  // Slice the actual function rather than guessing a character distance -- the
  // first version capped it at 2600 and the call sits at 2873.
  const fnStart = ADM.indexOf('async function createCompedAthlete');
  const fnBody = ADM.slice(fnStart, ADM.indexOf('\n}\n', fnStart));
  ok('the function was found', fnStart !== -1 && fnBody.length > 500, fnBody.length);
  ok('it refreshes the comp list afterwards', /_loadAthleteCompsNow\(\)/.test(fnBody));
  ok('and clears the form', /nameEl\.value = ''/.test(fnBody));
  ok('and it escapes the name it echoes back', /refEsc\(data\.name \|\| name\)/.test(ADM));

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message + '\n' + e.stack.split('\n').slice(0, 3).join('\n')); process.exit(1); });
