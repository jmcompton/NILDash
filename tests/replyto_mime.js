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
// Lift buildMimeMessage + encodeHeaderValue straight from the shipped gmail.js
// via brace-matching, since the file can't be require()'d here (no googleapis).
const fs = require('fs');
const src = fs.readFileSync(REPO + 'server/services/providers/gmail.js', 'utf8');
function extract(name) {
  const start = src.indexOf('function ' + name);
  // Find the body's opening brace, not a destructuring param's -- the first
  // '{' after the parameter list's closing ')'.
  const parenEnd = src.indexOf(')', start);
  let depth = 0, i = src.indexOf('{', parenEnd);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}
eval(extract('encodeHeaderValue') + '\n' + extract('buildMimeMessage'));

let OUT = [], FAIL = 0;
function ok(n, c, got) { if (c) OUT.push('PASS ' + n); else { FAIL++; OUT.push('FAIL ' + n + (got !== undefined ? '  got=' + JSON.stringify(got) : '')); } }

const withReply = buildMimeMessage({ to: 'x@y.com', subject: 'Hi', bodyHtml: '<p>hi</p>', replyTo: 'rabc123@reply.mynildash.com' });
ok('simple (no-attachment) branch includes the Reply-To header', /^Reply-To: rabc123@reply\.mynildash\.com$/m.test(withReply), withReply);
ok('Reply-To appears before the Subject line', withReply.indexOf('Reply-To:') < withReply.indexOf('Subject:'));

const withoutReply = buildMimeMessage({ to: 'x@y.com', subject: 'Hi', bodyHtml: '<p>hi</p>' });
ok('no replyTo passed -> no Reply-To header at all (capture off / null case)', !/Reply-To:/.test(withoutReply), withoutReply);

const withAttach = buildMimeMessage({
  to: 'x@y.com', subject: 'Hi', bodyHtml: '<p>hi</p>', replyTo: 'rabc123@reply.mynildash.com',
  attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', data: 'AAAA' }],
});
ok('the WITH-attachments branch also includes Reply-To', /^Reply-To: rabc123@reply\.mynildash\.com$/m.test(withAttach), withAttach);

OUT.push(''); OUT.push('failures: ' + FAIL);
console.log(OUT.join('\n'));
process.exit(FAIL ? 1 : 0);
