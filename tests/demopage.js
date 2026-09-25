'use strict';
// No database, no network.
//
//   node tests/run.js             every suite, against the committed baseline
//   node tests/demopage.js        just this one
//
// ── /demo IS A PUBLIC MARKETING PAGE ────────────────────────────────────────
// https://mynildash.com/demo serves public/demo.html to anyone, logged in or
// not. Replace that file to update the page; nothing else needs to change.
// These checks fail if the route is ever put behind auth, swallowed by the
// single-page-app catch-all, or the page starts depending on a login.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..') + path.sep;
const IDX = fs.readFileSync(REPO + 'server/index.js', 'utf8');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

const file = REPO + 'public/demo.html';
ok('the page lives at public/demo.html', fs.existsSync(file));
const html = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
ok('  and is a whole HTML document', /^<!DOCTYPE html>/i.test(html.trim()) && /<\/html>\s*$/i.test(html));

const m = IDX.match(/app\.get\('\/demo',\s*([^\n]*)\n/);
ok('GET /demo has its own route', !!m, m && m[0]);
ok('  with NO middleware in front of the handler (no requireAuth, no subscription check)',
  !!m && /^\(req, res\) => \{$/.test(m[1].trim()), m && m[1]);
const body2 = IDX.slice(IDX.indexOf("app.get('/demo',"), IDX.indexOf("app.get('/demo',") + 300);
ok('  and it sends public/demo.html, read from disk on every request',
  /sendFile\(path\.join\(__dirname, '\.\.', 'public', 'demo\.html'\)/.test(body2), body2);
ok('  with no-cache, so no browser, proxy or CDN serves an old copy',
  /cacheControl: false, headers: \{ 'Cache-Control': DEMO_NO_CACHE \}/.test(body2)
  && /const DEMO_NO_CACHE = 'no-cache, must-revalidate'/.test(IDX), body2);
ok('  and /demo.html, which express.static answers, gets the same header',
  /basename\(filePath\) === 'demo\.html'\) res\.setHeader\('Cache-Control', 'no-cache, must-revalidate'\)/.test(IDX));
ok('no other route or static mount serves a demo page',
  (IDX.match(/app\.(get|use)\([^)]*demo/g) || []).length === 1
  && !fs.readdirSync(REPO + 'public').some((f) => /demo/i.test(f) && f !== 'demo.html'));
ok('  registered before the catch-all that returns the app',
  IDX.indexOf("app.get('/demo',") > 0 && IDX.indexOf("app.get('/demo',") < IDX.indexOf("app.get('*',"));
ok('no app-wide or path-prefix auth middleware covers /demo',
  !/app\.use\(\s*(?:'\/demo'|'\/'\s*,)?\s*require(Auth|AgentSubscription|UniversityAuth|UniversityMode|Admin)\b/.test(IDX)
  && !/app\.use\('\/demo/.test(IDX));
ok('express.static serves public/ too, so /demo.html also works', /app\.use\(express\.static\(path\.join\(__dirname, '\.\.', 'public'\), \{/.test(IDX));

ok('the page calls no API and needs no session', !/\/api\//.test(html) && !/fetch\(/.test(html));
ok('  and never sends a visitor to a login screen', !/location[^;\n]*login/i.test(html));

OUT.push(''); OUT.push('failures: ' + F);
console.log(OUT.join('\n'));
process.exit(F ? 1 : 0);
