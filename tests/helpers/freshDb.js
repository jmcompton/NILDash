'use strict';
// A suite that drives its SQL through psql gets its own database, dropped and
// made again on every run, so it never depends on what an earlier run or
// another suite left behind. Same server as every suite (PGHOST/PGPORT/PGUSER).
// Also makes the scratch directory those suites write their .sql files to.
//
// { schema: true } builds the app's own schema in it, the way production gets
// it: server/store.js's init, then server/migrations (helpers/migrate), in a
// child process pointed at the new database.
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const REPO = path.join(__dirname, '..', '..') + path.sep;

const BUILD = `
const store = require(${JSON.stringify(REPO + 'server/store.js')});
const { migrate } = require(${JSON.stringify(__dirname + path.sep + 'migrate.js')});
(async () => {
  await store.ready;
  // init() starts some statements it does not await: wait for the pool to go quiet.
  const p = store.pool;
  for (let quiet = 0; quiet < 5;) {
    await new Promise((r) => setTimeout(r, 200));
    quiet = p.totalCount === p.idleCount && !p.waitingCount ? quiet + 1 : 0;
  }
  await migrate(p);
  await p.end();
  process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });`;

function freshDb(name, opts = {}) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('freshDb: not a plain database name: ' + name);
  fs.mkdirSync('/tmp/pgtest', { recursive: true });
  try { fs.chmodSync('/tmp/pgtest', 0o777); } catch (_) {}
  const args = ['-h', process.env.PGHOST || '/tmp', '-p', process.env.PGPORT || '55432', '-U', process.env.PGUSER || 'postgres',
    '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  for (const c of [`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`, `CREATE DATABASE ${name}`]) {
    const r = cp.spawnSync('psql', [...args, '-c', c], { encoding: 'utf8', env: { ...process.env, PGOPTIONS: '--client-min-messages=warning' } });
    if (r.status !== 0) throw new Error(`freshDb ${name}: ${(r.stderr || '').trim()}`);
  }
  if (opts.schema) {
    const r = cp.spawnSync(process.execPath, ['-e', BUILD], { encoding: 'utf8', timeout: 120000,
      env: { ...process.env, PGDATABASE: name, NODE_ENV: process.env.NODE_ENV || 'development' } });
    if (r.status !== 0) throw new Error(`freshDb ${name} schema: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-5).join(' | ')}`);
  }
  return name;
}

module.exports = { freshDb };
