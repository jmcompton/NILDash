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
// "Athlete not found" on AI Outreach for a self-managed athlete.
//
// Runs the SHIPPED route handler against a REAL Postgres holding a REAL
// self-signup athlete row, with a real athlete principal on req. Nothing about
// the lookup is reimplemented: the handler and its loader are lifted out of
// server/index.js and executed.
const fs = require('fs'), cp = require('child_process');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const R = REPO;
const SRV = fs.readFileSync(R + 'server/index.js', 'utf8');
const STORE = fs.readFileSync(R + 'server/store.js', 'utf8');
const DB = 'athoutreach';

// ── a psql-backed pool.query, close enough to node-postgres ─────────────────
function psql(text, csv, db) {
  fs.writeFileSync('/tmp/pgtest/q.sql', text);
  fs.chmodSync('/tmp/pgtest/q.sql', 0o644);
  const r = cp.spawnSync('psql', ['-h', '/tmp', '-p', '55432', '-U', 'postgres', '-d', db || DB,
    '-v', 'ON_ERROR_STOP=1', ...(csv ? ['--csv'] : []), '-f', '/tmp/pgtest/q.sql'],
    { encoding: 'utf8', env: { ...process.env, PGOPTIONS: '--client-min-messages=warning' } });
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').slice(0, 4).join(' | '));
  return (r.stdout || '').trim();
}
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return "'" + v.toISOString() + "'";
  if (typeof v === 'object') return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
  return "'" + String(v).replace(/'/g, "''") + "'";
};
// $1..$n substitution, longest index first so $10 is not eaten by $1.
function bind(text, params) {
  if (!params || !params.length) return text;
  let out = text;
  for (let i = params.length; i >= 1; i--) out = out.split('$' + i).join(lit(params[i - 1]));
  return out;
}
// CSV parse that survives a JSONB column full of commas and quotes.
function parseCsv(out) {
  const lines = [];
  let cur = '', inQ = false;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (ch === '"') { if (inQ && out[i + 1] === '"') { cur += '""'; i++; } else inQ = !inQ; cur += ch; continue; }
    if (ch === '\n' && !inQ) { lines.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) lines.push(cur);
  if (!lines.length) return [];
  const split = (l) => {
    const cells = []; let c = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { c += '"'; i++; } else q = !q; continue; }
      if (ch === ',' && !q) { cells.push(c); c = ''; continue; }
      c += ch;
    }
    cells.push(c);
    return cells;
  };
  const head = split(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = split(l), o = {};
    head.forEach((h, i) => { o[h] = cells[i] === '' ? null : cells[i]; });
    return o;
  });
}
const pool = {
  async query(text, params) {
    const sqlText = bind(text, params);
    const isSelect = /^\s*(SELECT|WITH)/i.test(sqlText) || /RETURNING/i.test(sqlText);
    if (!isSelect) { psql(sqlText); return { rows: [], rowCount: 0 }; }
    const rows = parseCsv(psql(sqlText, true));
    return { rows, rowCount: rows.length };
  },
};

// ── the database, schema straight from store.js ─────────────────────────────
psql(`DROP DATABASE IF EXISTS ${DB};`, false, 'postgres');
psql(`CREATE DATABASE ${DB};`, false, 'postgres');
const cols = [...STORE.matchAll(/ALTER TABLE athletes ADD COLUMN IF NOT EXISTS (\w+) ([^`]+)`/g)]
  .map((m) => [m[1], m[2].trim()]);
if (cols.length < 10) throw new Error('FIXTURE BROKEN: only ' + cols.length + ' athlete columns found in store.js');
psql(`CREATE TABLE athletes (
        id TEXT PRIMARY KEY, agent_id TEXT, data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      ` + cols.map((c) => `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS ${c[0]} ${c[1]};`).join('\n') + `
      CREATE TABLE athlete_activity_log (id SERIAL PRIMARY KEY, athlete_id TEXT, agent_id TEXT,
        activity_type TEXT, description TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());`);

// ── two real athletes, inserted the way the shipped routes insert them ──────
// SELF-MANAGED: exactly the shape POST /api/athlete/self-signup writes -- agent_id
// NULL, a 'self-' id, follower counts in dedicated columns, and a data JSON that
// carries the handle rather than a follower count.
const SELF_ID = 'self-1755470000000-a1b2c3d4';
const AGENT_ID = 'usr_john';
const MANAGED_ID = 'ath_managed_1';
psql(`INSERT INTO athletes (id, agent_id, data, email, athlete_type, email_verified,
        subscription_status, instagram_followers, tiktok_followers, twitter_followers, onboarding_complete)
      VALUES
      ('${SELF_ID}', NULL, ${lit({ name: 'Amari Allen', sport: 'Track', school: 'Samford', position: 'Distance', instagramHandle: 'amariruns', engagement: 4.2 })},
        'amari@example.com', 'self_managed', TRUE, 'free', 18400, 5200, 0, TRUE),
      ('${MANAGED_ID}', '${AGENT_ID}', ${lit({ name: 'Priya Raman', sport: 'Soccer', school: 'Stanford', position: 'M', instagram: 22000, tiktok: 4000, engagement: 5.1, stats: '12 goals' })},
        'priya@example.com', 'agent_managed', TRUE, 'active', NULL, NULL, NULL, TRUE);`);

// ── lift the shipped code ───────────────────────────────────────────────────
function liftFn(sig) {
  const start = SRV.indexOf(sig);
  if (start === -1) throw new Error('FIXTURE BROKEN, not found: ' + sig);
  let d = 0, j = SRV.indexOf('{', start), end = j;
  for (; j < SRV.length; j++) { if (SRV[j] === '{') d++; else if (SRV[j] === '}') { d--; if (!d) { end = j; break; } } }
  return SRV.slice(start, end + 1);
}
// The route handler: everything between the app.post( and its closing });
function liftRoute(marker) {
  const start = SRV.indexOf(marker);
  if (start === -1) throw new Error('FIXTURE BROKEN, no route: ' + marker);
  const bodyStart = SRV.indexOf('async (req, res) => {', start);
  if (bodyStart === -1) throw new Error('FIXTURE BROKEN, no handler on ' + marker);
  let d = 0, j = SRV.indexOf('{', bodyStart), end = j;
  for (; j < SRV.length; j++) { if (SRV[j] === '{') d++; else if (SRV[j] === '}') { d--; if (!d) { end = j; break; } } }
  return SRV.slice(bodyStart, end + 1);
}

const LOADER = liftFn('async function _loadAthleteObjForAI(athleteId) {');
if (!/FROM athletes a WHERE/.test(LOADER)) throw new Error('FIXTURE BROKEN: loader lifted wrong');
const HANDLER = liftRoute("app.post('/api/athlete/write-outreach'");
if (!/Athlete not found/.test(HANDLER)) throw new Error('FIXTURE BROKEN: handler lifted wrong');

// A fake res that records what the route did.
function mkRes() {
  const res = { code: 200, body: null, done: false };
  res.status = function (c) { res.code = c; return res; };
  res.json = function (b) { res.body = b; res.done = true; return res; };
  return res;
}

let lastPrompt = null;
const aiStub = {
  async oneShot(prompt) {
    lastPrompt = prompt;
    return JSON.stringify({ emailSubject: 'S', email: 'E', instagram: 'I', linkedin: 'L' });
  },
};

// Build the handler with its real collaborators. store.pool is the psql-backed
// pool; ai and the activity logger are stubbed because they leave the process.
function makeHandler() {
  const src = LOADER + '\n'
    + 'async function logAthleteActivity() {}\n'
    + 'const handler = ' + HANDLER + ';\n'
    + 'return handler;';
  return new Function('store', 'ai', 'console', src)(
    { pool }, aiStub, { log() {}, error() {} });
}

const call = async (principal, body) => {
  const handler = makeHandler();
  const res = mkRes();
  await handler({ athlete: principal, body: body || { brand: 'Iron Tribe Homewood' } }, res);
  return res;
};

(async () => {
  console.log('-- the fixtures are what the shipped signup writes --');
  {
    const r = await pool.query('SELECT id, agent_id, athlete_type FROM athletes ORDER BY id');
    ok('two athletes are on file', r.rows.length === 2, r.rows);
    const self = r.rows.find((x) => x.athlete_type === 'self_managed');
    ok('the self-managed one has NO agent', self && self.agent_id === null, self);
    ok('  and a self- id, like self-signup mints', /^self-/.test(self.id), self && self.id);
  }

  console.log('\n-- THE LIVE FAILURE: a self-managed athlete asks for outreach --');
  {
    // The principal verifyAthleteToken builds from a real self-signup JWT.
    const AMARI = { id: SELF_ID, email: 'amari@example.com', role: 'athlete',
      agent_id: null, athlete_name: 'Amari Allen', athlete_type: 'self_managed' };
    const res = await call(AMARI);
    ok('IT DOES NOT 404', res.code !== 404, { code: res.code, body: res.body });
    ok('  it is not "Athlete not found"', !(res.body && res.body.error === 'Athlete not found'), res.body);
    ok('  the outreach comes back', res.code === 200 && !!(res.body && res.body.email), { code: res.code, body: res.body });

    console.log('\n  · and it is HER outreach, built from HER row');
    ok('the prompt names her', /Amari Allen/.test(lastPrompt || ''), (lastPrompt || '').slice(0, 160));
    ok('  her sport and school', /Track/.test(lastPrompt) && /Samford/.test(lastPrompt));
    ok('  her real follower count from the dedicated column, not 0',
      /Instagram followers: 18400/.test(lastPrompt || ''),
      (lastPrompt || '').split('\n').find((l) => /Instagram followers/.test(l)));
    ok('  her TikTok count too', /TikTok: 5200/.test(lastPrompt || ''),
      (lastPrompt || '').split('\n').find((l) => /TikTok/.test(l)));
    ok('  and no other athlete', !/Priya/.test(lastPrompt || ''));
  }

  console.log('\n-- AN AGENT-MANAGED ATHLETE IS UNCHANGED --');
  {
    const PRIYA = { id: MANAGED_ID, email: 'priya@example.com', role: 'athlete',
      agent_id: AGENT_ID, athlete_name: 'Priya Raman' };
    const res = await call(PRIYA);
    ok('she gets her outreach', res.code === 200 && !!(res.body && res.body.email), { code: res.code, body: res.body });
    ok('  built from her own row', /Priya Raman/.test(lastPrompt) && /Stanford/.test(lastPrompt));
    ok('  with followers out of the data JSON', /Instagram followers: 22000/.test(lastPrompt),
      (lastPrompt || '').split('\n').find((l) => /Instagram followers/.test(l)));
    ok('  and not Amari', !/Amari/.test(lastPrompt));
  }

  console.log('\n-- AN ID THAT REALLY IS NOT THERE STILL 404s --');
  {
    const GHOST = { id: 'self-does-not-exist', role: 'athlete' };
    const res = await call(GHOST);
    ok('a genuinely missing athlete is 404', res.code === 404, { code: res.code, body: res.body });
    ok('  with the same message', res.body && res.body.error === 'Athlete not found', res.body);
  }

  console.log('\n-- THE ATHLETE IS THE SUBJECT, NOT A BODY PARAMETER --');
  {
    const AMARI = { id: SELF_ID, role: 'athlete', athlete_name: 'Amari Allen' };
    const res = await call(AMARI, { brand: 'Iron Tribe Homewood', athleteId: MANAGED_ID });
    ok('a body athleteId naming someone else is ignored', res.code === 200, { code: res.code, body: res.body });
    ok('  the outreach is still hers', /Amari Allen/.test(lastPrompt) && !/Priya/.test(lastPrompt),
      (lastPrompt || '').slice(0, 120));
  }

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
