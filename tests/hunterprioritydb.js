'use strict';
//   node tests/hunterprioritydb.js   (local test Postgres)
//
// The Hunter priority list in the database: an agent added from the admin
// route reaches the night's Hunter credits first, after the environment's.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const { Pool } = require('pg');
const fs = require('fs');
const HPr = require(REPO + 'server/services/hunterPriority.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

(async () => {
  const pool = new Pool();
  try {
    await HPr.ensureTable(pool);
    await pool.query(`DELETE FROM hunter_priority_agents WHERE who LIKE '%@hp.test' OR who LIKE 'hp %'`);
    ok('nothing in the table: the environment list alone', JSON.stringify(await HPr.loadList(pool, 'env@hp.test')) === JSON.stringify(['env@hp.test']));
    const w = await HPr.add(pool, '  Trial@HP.test ', 'testing for a 40-agent firm');
    ok('an agent is added cleaned (trimmed, lower case)', w === 'trial@hp.test', w);
    await HPr.add(pool, 'HP  Second Agent');
    const order = await HPr.loadList(pool, 'env@hp.test');
    ok('the environment comes first, then the table in the order added', JSON.stringify(order.filter((x) => /hp/.test(x))) === JSON.stringify(['env@hp.test', 'trial@hp.test', 'hp second agent']), order);
    await HPr.add(pool, 'env@hp.test');
    ok('a name in both is listed once', (await HPr.loadList(pool, 'env@hp.test')).filter((x) => x === 'env@hp.test').length === 1);
    const s = HPr.split([{ id: 'a1', email: 'x@y.test' }, { id: 'a2', email: 'trial@hp.test' }], await HPr.loadList(pool, ''));
    ok('the added agent runs first', s.first.map((a) => a.id).join() === 'a2' && s.rest.map((a) => a.id).join() === 'a1', s);
    ok('removed, it is gone', (await HPr.remove(pool, 'Trial@hp.test')) === 1 && !(await HPr.loadList(pool, '')).includes('trial@hp.test'));
    let threw = null; try { await HPr.add(pool, '   '); } catch (e) { threw = e.status; }
    ok('an empty name is refused', threw === 400, threw);
    const broken = { query: async () => { throw new Error('db down'); } };
    ok('a database that cannot be read leaves the environment list', JSON.stringify(await HPr.loadList(broken, 'env@hp.test')) === JSON.stringify(['env@hp.test']));
    const oq = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
    ok('the nightly run reads the list from the database', /HPr\.split\(agents, await HPr\.loadList\(pool\)\)/.test(oq));
    const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
    ok('admin routes to read, add and remove, admin only', /app\.get\('\/api\/admin\/hunter-priority'/.test(idx) && /app\.post\('\/api\/admin\/hunter-priority'/.test(idx)
      && /app\.delete\('\/api\/admin\/hunter-priority\/:who'/.test(idx) && (idx.match(/if \(!\(await _isAdmin\(req\)\)\) return res\.status\(403\)/g) || []).length === 3);
    await pool.query(`DELETE FROM hunter_priority_agents WHERE who LIKE '%@hp.test' OR who LIKE 'hp %'`);
  } catch (e) { F++; OUT.push('FAIL threw: ' + e.stack); }
  await pool.end();
  console.log(OUT.join('\n'));
  console.log(`\n${OUT.filter((l) => l.startsWith('PASS')).length} passed\nfailures: ${F}`);
  process.exit(F ? 1 : 0);
})();
