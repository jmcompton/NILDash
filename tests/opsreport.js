'use strict';
// No database needed.
//
//   node tests/opsreport.js
//
// ── /api/ops/report OPENS ONLY WITH THE TOKEN ───────────────────────────────
const path = require('path');
const OR = require(path.join(__dirname, '..', 'server/services/opsReport.js'));
let OUT = [], F = 0;
const ok = (n, c) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n); } };
const req = (h) => ({ headers: h ? { authorization: h } : {} });
const T = 'x'.repeat(32);

delete process.env.OPS_READ_TOKEN;
ok('no token set: closed, even to a matching empty header', !OR.tokenOk(req('Bearer ')) && !OR.tokenOk(req()));
process.env.OPS_READ_TOKEN = 'short';
ok('a token under 24 characters: closed', !OR.tokenOk(req('Bearer short')));
process.env.OPS_READ_TOKEN = T;
ok('the right token opens it', OR.tokenOk(req('Bearer ' + T)));
ok('the wrong token does not', !OR.tokenOk(req('Bearer ' + 'y'.repeat(32))));
ok('no header does not', !OR.tokenOk(req()));
ok('the token without Bearer does not', !OR.tokenOk(req(T)));
ok('the text renders from an empty report', /OPS REPORT/.test(OR.formatText({ at: 'now', readErrors: [], universities: [] })));

console.log(OUT.join('\n'));
console.log(`\n${OUT.length - F}/${OUT.length} passed`);
process.exit(F ? 1 : 0);
