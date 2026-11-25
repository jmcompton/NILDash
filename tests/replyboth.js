'use strict';
// ── THE REPLY GOES TO THE AGENT'S OWN INBOX TOO ─────────────────────────────
//
//   node tests/replyboth.js
//
// services/replyCapture.replyToWithMailbox: every pitch carries two reply
// addresses, ours and the mailbox it was sent from, so a business's answer
// lands in the agent's inbox in the same thread and NILDash still gets its
// copy. Checked on what each provider actually puts on the wire, and on the
// way back in: a reply addressed to both still finds its agent.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.OUTREACH_REPLY_CAPTURE_ENABLED = '1';
delete process.env.REPLY_TO_MAILBOX;
const fs = require('fs');
let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 600) : '')); } };

(async () => {
  const RC = require(REPO + 'server/services/replyCapture');
  const ours = RC.agentReplyAddress('dana');

  console.log('-- the two addresses --');
  ok('ours and the mailbox, ours first', RC.replyToWithMailbox(ours, 'Dana@RiverbendSports.com') === 'dana@mynildash.com, dana@riverbendsports.com', RC.replyToWithMailbox(ours, 'Dana@RiverbendSports.com'));
  ok('no mailbox address: ours alone, as before', RC.replyToWithMailbox(ours, null) === ours && RC.replyToWithMailbox(ours, '') === ours);
  ok('a mailbox address that is not one clean address is left off', RC.replyToWithMailbox(ours, 'a@b.com, evil@x.com') === ours && RC.replyToWithMailbox(ours, 'Dana <d@x.com>') === ours && RC.replyToWithMailbox(ours, 'nope') === ours);
  ok('never our own domain twice', RC.replyToWithMailbox(ours, 'dana@mynildash.com') === ours && RC.replyToWithMailbox(ours, 'someone@mynildash.com') === ours);
  ok('capture off: nothing, so the reply goes to the mailbox by itself', RC.replyToWithMailbox(null, 'dana@riverbendsports.com') === null);
  process.env.REPLY_TO_MAILBOX = 'off';
  ok('REPLY_TO_MAILBOX=off is the switch back to ours alone', RC.replyToWithMailbox(ours, 'dana@riverbendsports.com') === ours);
  delete process.env.REPLY_TO_MAILBOX;
  ok('as a list for providers that want one', JSON.stringify(RC.replyToList('a@x.com, b@y.com')) === '["a@x.com","b@y.com"]' && RC.replyToList(null).length === 0);

  const both = RC.replyToWithMailbox(ours, 'dana@riverbendsports.com');

  console.log('-- on the wire, per provider --');
  // Gmail: the MIME we build.
  const G = require(REPO + 'server/services/providers/gmail');
  const build = G.buildMimeMessage || G._buildMimeMessage;
  if (build) {
    const mime = build({ to: ['owner@tacoshop.com'], subject: 'Hi', bodyHtml: '<p>x</p>', attachments: [], replyTo: both, messageId: '<m1@mynildash.com>' });
    const raw = Buffer.isBuffer(mime) ? mime.toString() : String(mime);
    const text = /Reply-To:/.test(raw) ? raw : Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    ok('Gmail: one Reply-To header naming both', /^Reply-To: dana@mynildash\.com, dana@riverbendsports\.com\r?$/m.test(text) && (text.match(/^Reply-To:/gm) || []).length === 1, (text.match(/^Reply-To:.*$/m) || [])[0]);
  } else {
    const src = fs.readFileSync(REPO + 'server/services/providers/gmail.js', 'utf8');
    ok('Gmail: the header is written from the value as given', /const replyToLines = replyTo \? \[`Reply-To: \$\{replyTo\}`\] : \[\];/.test(src));
  }
  // Outlook: the Graph payload.
  const OS = fs.readFileSync(REPO + 'server/services/providers/outlook.js', 'utf8');
  const fn = new Function(OS.slice(OS.indexOf('function replyToRecipients'), OS.indexOf('\n}\n', OS.indexOf('function replyToRecipients')) + 3) + '\nreturn replyToRecipients;')();
  ok('Outlook: one recipient object per address', JSON.stringify(fn(both)) === '[{"emailAddress":{"address":"dana@mynildash.com"}},{"emailAddress":{"address":"dana@riverbendsports.com"}}]' && fn(ours).length === 1, fn(both));
  ok('  and both Graph calls use it', (OS.match(/replyTo: replyToRecipients\(replyTo\)/g) || []).length === 2 && !/address: replyTo \}/.test(OS));
  // SMTP (Zoho and the rest): the message nodemailer writes.
  const nodemailer = require('nodemailer');
  const M = require(REPO + 'server/services/providers/imap');
  let written = '';
  const deps = { createTransport: () => { const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    return { sendMail: async (o) => { const info = await t.sendMail(o); written = info.message.toString(); return { messageId: info.messageId, accepted: ['x'], rejected: [] }; }, close() {} }; } };
  await M.sendEmail('dana@riverbendsports.com', 'pw', { smtpHost: 'smtppro.zoho.com', smtpPort: 465 }, { to: ['owner@tacoshop.com'], subject: 'Hi', bodyHtml: '<p>x</p>', replyTo: both, messageId: '<m1@mynildash.com>', fromName: 'Dana Whitfield' }, deps);
  ok('SMTP: one Reply-To header naming both', /^Reply-To: dana@mynildash\.com, dana@riverbendsports\.com$/m.test(written) && (written.match(/^Reply-To:/gm) || []).length === 1, (written.match(/^Reply-To:.*$/m) || [])[0]);
  ok('  From is still the agent, and the Message-ID is still ours', /^From: Dana Whitfield <dana@riverbendsports\.com>$/m.test(written) && /^Message-ID: <m1@mynildash\.com>$/mi.test(written));

  console.log('-- and the way back in --');
  const toList = ['dana@riverbendsports.com', 'Dana@mynildash.com'];
  const rcpt = toList.map((a) => RC.classifyRecipient(a)).find(Boolean);
  ok('a reply addressed to both still finds our address, whichever comes first', rcpt && rcpt.kind === 'named' && rcpt.localPart === 'dana', rcpt);
  ok('the agent\'s own mailbox is not mistaken for one of ours', RC.classifyRecipient('dana@riverbendsports.com') === null);
  const IN = fs.readFileSync(REPO + 'server/routes/resendInbound.js', 'utf8');
  ok('the webhook looks through every To address for ours', /toList\.map\(\(addr\) => replyCapture\.classifyRecipient\(addr\)\)\.find\(Boolean\)/.test(IN));

  ok('the agent\'s own Reply All is recorded and not read as the business answering', /fromAddr === String\(agent\.email \|\| ''\)\.toLowerCase\(\)[\s\S]{0,300}email_accounts WHERE user_id = \$1 AND LOWER\(email_address\) = \$2[\s\S]{0,400}matchMethod: 'own-mail'[\s\S]{0,120}return;/.test(IN)
    && IN.indexOf("matchMethod: 'own-mail'") < IN.indexOf('// (a) header match'));

  console.log('-- both send paths use it --');
  const CR = fs.readFileSync(REPO + 'server/jobs/closerRelease.js', 'utf8'), OR = fs.readFileSync(REPO + 'server/routes/outreach.js', 'utf8');
  ok('the send queue', /replyCapture\.replyToWithMailbox\(replyCapture\.agentReplyAddress\(account\.replyLocalPart\), account\.email_address\)/.test(CR));
  ok('a pitch sent by hand', /replyCapture\.replyToWithMailbox\(replyCapture\.agentReplyAddress\(await ensureReplyLocalPart\(req\.principal\.id\)\), account\.email_address\)/.test(OR));
  ok('nothing else builds a pitch reply address by itself', !/replyTo = replyCapture\.ENABLED[^;]{0,120}\? replyCapture\.agentReplyAddress\(/.test(CR + OR));

  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
