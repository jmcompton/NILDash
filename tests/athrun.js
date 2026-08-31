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
// "Athlete not found" on AI Outreach, for real.
//
// The Deal Scan card's AI Outreach button drives outreach-engine.js, which posts
// POST /api/outreach/run. That path is neither rewritten nor token-attached by the
// athlete shim, so in athlete mode it falls straight through to the AGENT API --
// and /run resolves the athlete with `WHERE id=$1 AND agent_id=$2` against the
// session user. A self-managed athlete has agent_id NULL, so there is no row.
//
// Both halves are exercised here: the shipped route handler against a real
// Postgres, and the shipped client shim against the real path.
const fs = require('fs'), cp = require('child_process');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const R = REPO;
const RT = fs.readFileSync(R + 'server/routes/outreach.js', 'utf8');
const SRV = fs.readFileSync(R + 'server/index.js', 'utf8');
const IDX = fs.readFileSync(R + 'public/index.html', 'utf8');
const STORE = fs.readFileSync(R + 'server/store.js', 'utf8');
const DB = 'athrun';

// ── psql-backed pool ────────────────────────────────────────────────────────
function psql(text, csv, db) {
  fs.writeFileSync('/tmp/pgtest/r.sql', text);
  fs.chmodSync('/tmp/pgtest/r.sql', 0o644);
  const r = cp.spawnSync('psql', ['-h', '/tmp', '-p', '55432', '-U', 'postgres', '-d', db || DB,
    '-v', 'ON_ERROR_STOP=1', ...(csv ? ['--csv'] : []), '-f', '/tmp/pgtest/r.sql'],
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
function bind(text, params) {
  if (!params || !params.length) return text;
  let out = text;
  for (let i = params.length; i >= 1; i--) out = out.split('$' + i).join(lit(params[i - 1]));
  return out;
}
function parseCsv(out) {
  const lines = []; let cur = '', inQ = false;
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
    cells.push(c); return cells;
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
    const s = bind(text, params);
    if (!(/^\s*(SELECT|WITH)/i.test(s) || /RETURNING/i.test(s))) { psql(s); return { rows: [], rowCount: 0 }; }
    const rows = parseCsv(psql(s, true));
    rows.forEach((r) => { if (typeof r.data === 'string') { try { r.data = JSON.parse(r.data); } catch (_) {} } });
    return { rows, rowCount: rows.length };
  },
};

// ── the database ────────────────────────────────────────────────────────────
psql(`DROP DATABASE IF EXISTS ${DB};`, false, 'postgres');
psql(`CREATE DATABASE ${DB};`, false, 'postgres');
const cols = [...STORE.matchAll(/ALTER TABLE athletes ADD COLUMN IF NOT EXISTS (\w+) ([^`]+)`/g)].map((m) => [m[1], m[2].trim()]);
if (cols.length < 10) throw new Error('FIXTURE BROKEN: athlete columns');
psql(`CREATE TABLE athletes (id TEXT PRIMARY KEY, agent_id TEXT, data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      ` + cols.map((c) => `ALTER TABLE athletes ADD COLUMN IF NOT EXISTS ${c[0]} ${c[1]};`).join('\n'));

const SELF_ID = 'self-1755470000000-a1b2c3d4';
const AGENT_ID = 'usr_john';
const MANAGED_ID = 'ath_priya';
psql(`INSERT INTO athletes (id, agent_id, data, email, athlete_type, subscription_status, instagram_followers)
      VALUES ('${SELF_ID}', NULL, ${lit({ name: 'Amari Allen', sport: 'Track', school: 'Samford' })},
                'amari@example.com', 'self_managed', 'free', 18400),
             ('${MANAGED_ID}', '${AGENT_ID}', ${lit({ name: 'Priya Raman', sport: 'Soccer', school: 'Stanford' })},
                'priya@example.com', 'agent_managed', 'active', NULL);`);

// ── lift the shipped /run handler ───────────────────────────────────────────
function liftHandler(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error('FIXTURE BROKEN, no route: ' + marker);
  const bodyStart = src.indexOf('async (req, res) => {', start);
  let d = 0, j = src.indexOf('{', bodyStart), end = j;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { end = j; break; } } }
  return src.slice(bodyStart, end + 1);
}
function liftFn(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) throw new Error('FIXTURE BROKEN, not found: ' + sig);
  let d = 0, j = src.indexOf('{', start), end = j;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { end = j; break; } } }
  return src.slice(start, end + 1);
}

const RUN = liftHandler(RT, "router.post('/run'");
if (!/Athlete not found/.test(RUN)) throw new Error('FIXTURE BROKEN: /run lifted wrong');
const SAFE = liftFn(RT, 'function _safeKnownContacts(v) {');
// The athlete resolver is part of what is under test, so it is lifted, not stubbed.
const RESOLVE = /async function resolveAthleteFor/.test(RT)
  ? liftFn(RT, 'async function resolveAthleteFor(')
  : '';

let lastWorkflow = null;
function makeRun() {
  const src = SAFE + '\n' + RESOLVE + '\nconst handler = ' + RUN + ';\nreturn handler;';
  return new Function('pool', 'orchestrator', 'console', src)(
    pool,
    { async runOutreachWorkflow(p) { lastWorkflow = p; return { runId: 'run_1' }; } },
    { log() {}, warn() {}, error() {} });
}
function mkRes() {
  const res = { code: 200, body: null };
  res.status = function (c) { res.code = c; return res; };
  res.json = function (b) { res.body = b; return res; };
  return res;
}
// req as each caller presents it. An athlete has a verified principal and no
// session; an agent has a session and no principal.
const callRun = async (req) => {
  lastWorkflow = null;
  const h = makeRun();
  const res = mkRes();
  await h(Object.assign({ body: {} }, req), res);
  return res;
};
const DEAL = { brand: 'Iron Tribe Homewood', category: 'gym', region: 'Birmingham, AL' };

(async () => {
  console.log('-- THE LIVE FAILURE --');
  console.log('  the athlete opens AI Outreach in a browser that also holds an agent session.');
  console.log('  /api/outreach/run is not rewritten by the shim, so it arrives as the AGENT.');
  {
    const res = await callRun({
      session: { userId: AGENT_ID },
      athlete: { id: SELF_ID, role: 'athlete' },
      principal: { kind: 'athlete', id: SELF_ID },
      body: { athleteId: SELF_ID, dealScanResult: DEAL },
    });
    ok('IT IS NOT "Athlete not found"',
      !(res.body && res.body.error === 'Athlete not found'), { code: res.code, body: res.body });
    ok('  the run starts', res.code === 200 && res.body && res.body.runId, { code: res.code, body: res.body });
    ok('  and it is HER run, not the agent\'s', lastWorkflow && lastWorkflow.athlete
      && lastWorkflow.athlete.id === SELF_ID, lastWorkflow && lastWorkflow.athlete && lastWorkflow.athlete.id);
    ok('  owned by her, so the agent session cannot claim it',
      lastWorkflow && String(lastWorkflow.agentId || lastWorkflow.ownerId) === SELF_ID,
      lastWorkflow && { agentId: lastWorkflow.agentId, ownerId: lastWorkflow.ownerId });
  }

  console.log('\n-- AND IN A CLEAN ATHLETE BROWSER, WITH NO AGENT SESSION AT ALL --');
  {
    const res = await callRun({
      session: null,
      athlete: { id: SELF_ID, role: 'athlete' },
      principal: { kind: 'athlete', id: SELF_ID },
      body: { athleteId: SELF_ID, dealScanResult: DEAL },
    });
    ok('the run still starts', res.code === 200 && res.body && res.body.runId, { code: res.code, body: res.body });
    ok('  resolved from the token, not from a session', lastWorkflow && lastWorkflow.athlete.id === SELF_ID,
      lastWorkflow && lastWorkflow.athlete && lastWorkflow.athlete.id);
  }

  console.log('\n-- SHE IS THE SUBJECT: A BODY athleteId CANNOT REDIRECT IT --');
  {
    const res = await callRun({
      session: null,
      athlete: { id: SELF_ID, role: 'athlete' },
      principal: { kind: 'athlete', id: SELF_ID },
      body: { athleteId: MANAGED_ID, dealScanResult: DEAL },     // someone else's id
    });
    ok('the run is still hers, not Priya\'s',
      res.code === 200 && lastWorkflow && lastWorkflow.athlete.id === SELF_ID,
      { code: res.code, athlete: lastWorkflow && lastWorkflow.athlete && lastWorkflow.athlete.id });
    ok('  and none of Priya\'s data is loaded',
      !lastWorkflow || !/Priya/.test(JSON.stringify(lastWorkflow.athlete || {})),
      lastWorkflow && lastWorkflow.athlete && lastWorkflow.athlete.name);
  }
  {
    // Omitting it entirely must work too: an athlete is not required to name herself.
    const res = await callRun({
      session: null, athlete: { id: SELF_ID, role: 'athlete' },
      principal: { kind: 'athlete', id: SELF_ID },
      body: { dealScanResult: DEAL },
    });
    ok('no athleteId at all is fine for an athlete', res.code === 200, { code: res.code, body: res.body });
  }

  console.log('\n-- AN AGENT IS COMPLETELY UNCHANGED --');
  {
    const res = await callRun({
      session: { userId: AGENT_ID }, principal: { kind: 'agent', id: AGENT_ID },
      body: { athleteId: MANAGED_ID, dealScanResult: DEAL },
    });
    ok('his own athlete runs', res.code === 200 && res.body.runId, { code: res.code, body: res.body });
    ok('  owned by him', lastWorkflow && String(lastWorkflow.agentId || lastWorkflow.ownerId) === AGENT_ID,
      lastWorkflow && { agentId: lastWorkflow.agentId, ownerId: lastWorkflow.ownerId });
    ok('  he still has to name an athlete',
      (await callRun({ session: { userId: AGENT_ID }, principal: { kind: 'agent', id: AGENT_ID },
        body: { dealScanResult: DEAL } })).code === 400);
  }
  {
    // The isolation that already existed must survive: an agent cannot run the
    // workflow for an athlete who is not his.
    const res = await callRun({
      session: { userId: AGENT_ID }, principal: { kind: 'agent', id: AGENT_ID },
      body: { athleteId: SELF_ID, dealScanResult: DEAL },
    });
    ok('an agent CANNOT run it for a self-managed athlete who is not his',
      res.code === 404, { code: res.code, body: res.body });
  }
  {
    const OTHER = 'usr_someone_else';
    const res = await callRun({
      session: { userId: OTHER }, principal: { kind: 'agent', id: OTHER },
      body: { athleteId: MANAGED_ID, dealScanResult: DEAL },
    });
    ok('nor for another agent\'s athlete', res.code === 404, { code: res.code, body: res.body });
  }

  console.log('\n-- THE CLIENT MUST NOT SEND IT TO THE AGENT API AT ALL --');
  {
    // Lift the real shim decision functions and ask them about the real path.
    const from = IDX.indexOf('var ATHLETE_ROUTE_MAP = [');
    const to = IDX.indexOf('// Response reshaping, only where');
    const shim = new Function(
      IDX.slice(from, to) + '\n return { mapAthletePath, needsAthleteAuth, ATHLETE_ROUTE_MAP };')();
    const P = '/api/outreach/run';
    ok('the run path is handled in athlete mode',
      !!(shim.mapAthletePath(P) || shim.needsAthleteAuth(P)),
      { mapped: shim.mapAthletePath(P), authed: shim.needsAthleteAuth(P) });
    const D = '/api/outreach/draft';
    ok('  and so is the pre-warmed draft lookup',
      !!(shim.mapAthletePath(D) || shim.needsAthleteAuth(D)),
      { mapped: shim.mapAthletePath(D), authed: shim.needsAthleteAuth(D) });
    const S = '/api/outreach/runs/run_1';
    ok('  and the poll that follows it',
      !!(shim.mapAthletePath(S) || shim.needsAthleteAuth(S)),
      { mapped: shim.mapAthletePath(S), authed: shim.needsAthleteAuth(S) });
    // The existing mapping must keep winning: it is checked before the passthrough.
    ok('the logs mapping still wins over the new passthrough',
      shim.mapAthletePath('/api/outreach/logs') === '/api/athlete/outreach',
      shim.mapAthletePath('/api/outreach/logs'));
  }

  console.log('\n-- AND THE SERVER MUST ACCEPT THE TOKEN ON THAT MOUNT --');
  {
    const mount = (SRV.match(/app\.use\('\/api\/outreach',[^\n]*/) || [''])[0];
    ok('the mount is not agent-session-only', !/requireAuth,\s*requireAgentSubscription/.test(mount), mount);
    ok('  it takes a principal-aware gate', /outreachAuth|assistantAuth|principal/i.test(mount), mount);
  }

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
