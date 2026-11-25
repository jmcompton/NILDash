'use strict';
// ── AN ERROR IN ONE REQUEST MUST NOT TAKE THE SERVER DOWN ───────────────────
//
//   node tests/asyncsafe.js
//
// middleware/asyncSafe: an async route that throws answers 500 and the server
// keeps serving. Run for real: a small app, one route that throws the way
// /admin/inbound did, and a request after it.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
const http = require('http');
const fs = require('fs');
let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 500) : '')); } };

(async () => {
  let unhandled = 0;
  require(REPO + 'server/middleware/asyncSafe').install();
  process.on('unhandledRejection', () => { unhandled++; });
  const _err = console.error; const logged = []; console.error = (...a) => { logged.push(a.join(' ')); };
  const express = require('express');
  const app = express();
  app.get('/admin/page', async (_rq, rs) => { if (errs.length) rs.send('never'); rs.send('x'); });   // eslint-disable-line no-undef
  app.get('/api/thing', async () => { throw new Error('boom'); });
  app.get('/api/half', async (_rq, rs) => { rs.write('part'); throw new Error('after the headers'); });
  app.get('/api/sync', () => { throw new Error('sync boom'); });
  app.get('/api/fine', async (_rq, rs) => { rs.json({ ok: true }); });
  app.get('/api/next', async (_rq, _rs, next) => { next(); }, (_rq, rs) => rs.json({ second: true }));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const get = (path) => new Promise((res) => {
    http.get({ host: '127.0.0.1', port: srv.address().port, path }, (r) => { let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => res({ code: r.statusCode, body: t })); })
      .on('error', (e) => res({ code: 0, body: e.message }));
  });
  let r = await get('/admin/page');
  ok('a page that reads an undefined name answers 500 in plain words', r.code === 500 && /Something went wrong on our side/.test(r.body) && !/errs is not defined/.test(r.body), r);
  r = await get('/api/thing');
  ok('an API route that throws answers 500 as JSON, with no stack', r.code === 500 && JSON.parse(r.body).error && !/boom|at /.test(r.body), r);
  r = await get('/api/half');
  ok('a route that fails after it started answering is closed, not left hanging', r.code === 200 && r.body === 'part', r);
  r = await get('/api/sync');
  ok('a synchronous throw is still handled', r.code === 500, r.code);
  r = await get('/api/fine');
  ok('THE SERVER IS STILL UP and the next request is served', r.code === 200 && JSON.parse(r.body).ok === true, r);
  r = await get('/api/next');
  ok('a route that passes to the next handler still does', r.code === 200 && JSON.parse(r.body).second === true, r);
  await new Promise((x) => setTimeout(x, 50));
  console.error = _err;
  ok('nothing was left as an unhandled rejection', unhandled === 0, unhandled);
  ok('each failure is logged with its path', logged.some((l) => /\[route-error\] GET \/admin\/page: .*errs is not defined/.test(l)) && logged.some((l) => /GET \/api\/thing/.test(l)), logged.map((l) => l.slice(0, 80)));
  const IX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('the app installs it before any route', IX.indexOf("require('./middleware/asyncSafe').install()") > 0 && IX.indexOf("require('./middleware/asyncSafe').install()") < IX.indexOf('const app  = express();'));
  const a = IX.indexOf("app.get('/admin/inbound'"); const blk = IX.slice(a, IX.indexOf('\napp.', a + 10));
  ok('/admin/inbound no longer reads the undefined name', !/\berrs\b/.test(blk));
  srv.close();
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
