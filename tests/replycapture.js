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
process.env.OUTREACH_REPLY_CAPTURE_ENABLED = '1';
process.env.OUTREACH_REPLY_DOMAIN = 'reply.mynildash.com';
delete require.cache[require.resolve(REPO + 'server/services/replyCapture.js')];
const RC = require(REPO + 'server/services/replyCapture.js');

let OUT = [], FAIL = 0;
function ok(n, c, got) { if (c) OUT.push('PASS ' + n); else { FAIL++; OUT.push('FAIL ' + n + (got !== undefined ? '  got=' + JSON.stringify(got) : '')); } }

// ── token encode/decode round trip ──────────────────────────────────────────
const id = 'out_a1b2c3d4e5f60718';
ok('tokenForLogId strips the out_ prefix', RC.tokenForLogId(id) === 'a1b2c3d4e5f60718', RC.tokenForLogId(id));
ok('logIdForToken reverses it exactly', RC.logIdForToken('a1b2c3d4e5f60718') === id);
ok('a malformed id yields no token', RC.tokenForLogId('not-an-id') === null);
ok('a malformed token yields no id', RC.logIdForToken('zz') === null);

const addr = RC.replyToAddressFor(id);
ok('replyToAddressFor builds r<token>@domain', addr === 'ra1b2c3d4e5f60718@reply.mynildash.com', addr);
ok('and it decodes straight back to the same outreach_logs id', RC.logIdForReplyAddress(addr) === id, RC.logIdForReplyAddress(addr));
ok('decode is case-insensitive on both halves', RC.logIdForReplyAddress('RA1B2C3D4E5F60718@REPLY.MYNILDASH.COM') === id);
ok('a totally unrelated address decodes to nothing', RC.logIdForReplyAddress('someone@gmail.com') === null);
ok('right shape, wrong domain decodes to nothing', RC.logIdForReplyAddress('ra1b2c3d4e5f60718@evil.com') === null);
ok('a stray subaddress-looking local part with no domain match fails closed', RC.logIdForReplyAddress('ra1b2c3d4e5f60718@sub.reply.mynildash.com') === null);

// ── ENABLED gate ─────────────────────────────────────────────────────────────
delete require.cache[require.resolve(REPO + 'server/services/replyCapture.js')];
delete process.env.OUTREACH_REPLY_CAPTURE_ENABLED;
const RCoff = require(REPO + 'server/services/replyCapture.js');
ok('with the flag unset, replyToAddressFor returns null (no header set anywhere)', RCoff.replyToAddressFor(id) === null, RCoff.replyToAddressFor(id));

// ── classifyInbound: bounce ──────────────────────────────────────────────────
ok('DSN content-type is a bounce', RC.classifyInbound({ headers: { 'Content-Type': 'multipart/report; report-type=delivery-status; boundary=x' } }).kind === 'bounce');
ok('X-Failed-Recipients is a bounce', RC.classifyInbound({ headers: { 'X-Failed-Recipients': 'x@y.com' } }).kind === 'bounce');
ok('mailer-daemon sender is a bounce', RC.classifyInbound({ from: 'MAILER-DAEMON@mail.example.com' }).kind === 'bounce');
ok('postmaster sender is a bounce', RC.classifyInbound({ from: 'postmaster@example.com' }).kind === 'bounce');
ok('an "Undeliverable:" subject is a bounce even with no useful headers', RC.classifyInbound({ subject: 'Undeliverable: Great fit for Marcus' }).kind === 'bounce');
ok('"Mail Delivery Failed" subject is a bounce', RC.classifyInbound({ subject: 'Mail Delivery Failed' }).kind === 'bounce');

// ── classifyInbound: auto-reply / OOO ────────────────────────────────────────
ok('Auto-Submitted: auto-replied is an auto_reply', RC.classifyInbound({ headers: { 'Auto-Submitted': 'auto-replied' } }).kind === 'auto_reply');
ok('Auto-Submitted: auto-generated is an auto_reply too', RC.classifyInbound({ headers: { 'Auto-Submitted': 'auto-generated' } }).kind === 'auto_reply');
ok('Auto-Submitted: no is NOT an auto-reply (explicit negative)', RC.classifyInbound({ headers: { 'Auto-Submitted': 'no' }, subject: 'Great, let\'s talk' }).kind === 'reply');
ok('legacy X-Autoreply: yes is an auto_reply', RC.classifyInbound({ headers: { 'X-Autoreply': 'yes' } }).kind === 'auto_reply');
ok('X-Autorespond present (any value) is an auto_reply', RC.classifyInbound({ headers: { 'X-Autorespond': '' } }).kind === 'auto_reply');
ok('Precedence: auto_reply is an auto_reply', RC.classifyInbound({ headers: { Precedence: 'auto_reply' } }).kind === 'auto_reply');
ok('"Out of Office" subject with no headers is an auto_reply (fallback)', RC.classifyInbound({ subject: 'Out of Office: back Monday' }).kind === 'auto_reply');
ok('"Automatic reply:" subject is an auto_reply', RC.classifyInbound({ subject: 'Automatic reply: I am away' }).kind === 'auto_reply');
ok('a bounce beats an auto-reply header when both could match', RC.classifyInbound({ headers: { 'Auto-Submitted': 'auto-replied', 'X-Failed-Recipients': 'x@y.com' } }).kind === 'bounce');

// ── classifyInbound: real reply ──────────────────────────────────────────────
ok('an ordinary reply with none of the above is "reply"', RC.classifyInbound({ headers: { 'Content-Type': 'text/html' }, subject: 'Re: partnership with Marcus', from: 'dana@rallyhouse.com' }).kind === 'reply');
ok('an empty/missing headers object does not throw and defaults to reply', RC.classifyInbound({ subject: 'Sounds great!' }).kind === 'reply');
ok('headers as an array of {name,value} (the shape Resend documents) also works', RC.classifyInbound({ headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }).kind === 'auto_reply');

// ── signature verification ───────────────────────────────────────────────────
const crypto = require('crypto');
const secretRaw = crypto.randomBytes(24);
const secret = 'whsec_' + secretRaw.toString('base64');
const payload = JSON.stringify({ type: 'email.received', data: { email_id: 'abc' } });
const svixId = 'msg_test123';
const svixTimestamp = String(Math.floor(Date.now() / 1000));
const signedContent = `${svixId}.${svixTimestamp}.${payload}`;
const goodSig = 'v1,' + crypto.createHmac('sha256', secretRaw).update(signedContent).digest('base64');

ok('a correctly-signed payload verifies', RC.verifyResendSignature({
  payload, secret, headers: { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': goodSig },
}) === true);
ok('a tampered payload fails verification', RC.verifyResendSignature({
  payload: payload + 'x', secret, headers: { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': goodSig },
}) === false);
ok('the wrong secret fails verification', RC.verifyResendSignature({
  payload, secret: 'whsec_' + crypto.randomBytes(24).toString('base64'),
  headers: { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': goodSig },
}) === false);
ok('a stale timestamp outside tolerance fails even with a correct signature', (() => {
  const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
  const oldContent = `${svixId}.${oldTs}.${payload}`;
  const oldSig = 'v1,' + crypto.createHmac('sha256', secretRaw).update(oldContent).digest('base64');
  return RC.verifyResendSignature({ payload, secret, headers: { 'svix-id': svixId, 'svix-timestamp': oldTs, 'svix-signature': oldSig } }) === false;
})());
ok('multiple space-separated signature candidates: a match anywhere in the list passes', RC.verifyResendSignature({
  payload, secret, headers: { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': 'v1,bogus== ' + goodSig },
}) === true);
ok('missing headers fails closed, not open', RC.verifyResendSignature({ payload, secret, headers: {} }) === false);

OUT.push(''); OUT.push('failures: ' + FAIL);
console.log(OUT.join('\n'));
process.exit(FAIL ? 1 : 0);
