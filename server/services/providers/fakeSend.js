'use strict';
// ── A MAIL PROVIDER FOR TESTS ONLY ──────────────────────────────────────────
//
// Active only when NILDASH_TEST_FAKE_SEND is set, which nothing but a test
// sets. Then every send (the release queue and the editor's Send) goes here
// instead of Gmail, Outlook or SMTP: it waits delayMs, fails when the
// recipient contains failTo, and appends one line per send to logFile so a
// test can count what actually went out.
//
//   NILDASH_TEST_FAKE_SEND='{"delayMs":20000,"failTo":"bounce","logFile":"/tmp/sends.log"}'
const fs = require('fs');

function active() { return !!process.env.NILDASH_TEST_FAKE_SEND; }
function config() {
  try { return JSON.parse(process.env.NILDASH_TEST_FAKE_SEND) || {}; } catch (_) { return {}; }
}

// Same last argument as every real provider: { to, subject, ... }.
async function sendEmail(...args) {
  const c = config();
  const a = args[args.length - 1] || {};
  const to = [].concat(a.to || []).join(',');
  await new Promise((r) => setTimeout(r, Number(c.delayMs) || 0));
  if (c.failTo && to.includes(c.failTo)) {
    const e = new Error(c.failMessage || 'Mailbox unavailable: the recipient server refused the message');
    if (c.failCode) e.code = c.failCode;
    throw e;
  }
  if (c.logFile) fs.appendFileSync(c.logFile, JSON.stringify({ at: new Date().toISOString(), to, subject: a.subject || '' }) + '\n');
  return { providerMessageId: 'fake-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) };
}

if (active()) console.warn('[fake-send] NILDASH_TEST_FAKE_SEND is set: NO REAL EMAIL WILL BE SENT by this process');

module.exports = { active, config, sendEmail };
