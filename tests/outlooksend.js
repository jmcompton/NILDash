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
// Outlook send path against a recorded fake Graph. No tenant exists, so what is
// provable here is the SHAPE of the conversation with Graph: which endpoints get
// called, in what order, with what ids. That is exactly where the two bugs were.

const ROOT = REPO;

// Monkeypatch the real package before outlook.js captures it.
const GraphPkg = require(ROOT + 'node_modules/@microsoft/microsoft-graph-client');
let CALLS, BEHAVIOUR;

function fakeApi(path) {
  const q = {};
  const rec = (verb, body) => {
    CALLS.push({ verb, path, ...q, body: body === undefined ? null : body });
    return BEHAVIOUR(verb, path, body, q);
  };
  const chain = {
    filter: (v) => { q.filter = v; return chain; },
    orderby: (v) => { q.orderby = v; return chain; },
    top: (v) => { q.top = v; return chain; },
    select: (v) => { q.select = v; return chain; },
    get: () => Promise.resolve(rec('GET')),
    post: (b) => Promise.resolve(rec('POST', b)),
    patch: (b) => Promise.resolve(rec('PATCH', b)),
  };
  return chain;
}
GraphPkg.Client.init = () => ({ api: fakeApi });

const outlook = require(ROOT + 'server/services/providers/outlook.js');

const MINTED = '<out_abc123.deadbeef@reply.mynildash.com>';

// A tenant that answers. Send-only: /me/sendMail and /reply return 202 with
// no body; a conversation lookup (needs Mail.Read) returns its newest message.
function tenant() {
  return (verb, path) => {
    if (verb === 'GET' && path === '/me/messages') return { value: [{ id: 'MSG_LATEST' }] };
    return {};
  };
}

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail: detail || '' });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
};
const paths = () => CALLS.map((c) => c.verb + ' ' + c.path);

// THE SEND IS ONE CALL ON Mail.Send (services/providers/outlook). It used to
// be draft, stamp our Message-ID, send -- which needs Mail.ReadWrite, a second
// and broader mail permission on every connection, for an anchor the Reply-To
// already gives: the business's answer goes to the agent's reply address.
(async () => {
  // ── 1. New message ────────────────────────────────────────────────────────
  console.log('\n1. NEW MESSAGE');
  CALLS = []; BEHAVIOUR = tenant();
  let r = await outlook.sendEmail('tok', null, {
    to: ['owner@bikeshop.com'], subject: 'A partnership idea',
    bodyHtml: '<p>Hi Laura,</p>', replyTo: 'jordan@reply.mynildash.com', messageId: MINTED,
  });
  console.log('     ' + paths().join('\n     '));
  const send = CALLS.find((c) => c.path === '/me/sendMail');
  check('one call: POST /me/sendMail', JSON.stringify(paths()) === JSON.stringify(['POST /me/sendMail']));
  check('no draft is created (that needs Mail.ReadWrite)', !paths().some((p) => p === 'POST /me/messages' || /\/send$/.test(p)));
  check('subject, body and recipient on the message', send && send.body.message.subject === 'A partnership idea' && send.body.message.body.content === '<p>Hi Laura,</p>'
    && send.body.message.toRecipients[0].emailAddress.address === 'owner@bikeshop.com');
  check('the Reply-To that routes the answer back to us', send && send.body.message.replyTo[0].emailAddress.address === 'jordan@reply.mynildash.com');
  check('our id rides along as an X- header', send && send.body.message.internetMessageHeaders[0].name === 'X-NILDash-Message-Id' && send.body.message.internetMessageHeaders[0].value === MINTED);
  check('saved to Sent Items, so the agent sees it in Outlook', send && send.body.saveToSentItems === true);
  check('says the Message-ID on the wire is unknown (not ours)', r.messageId === null && r.messageIdUnknown === true && r.messageIdStamped === false);

  // ── 2. Reply to a known message ───────────────────────────────────────────
  console.log('\n2. REPLY to a message id');
  CALLS = []; BEHAVIOUR = tenant();
  await outlook.sendEmail('tok', null, { bodyHtml: '<p>Following up.</p>', replyToMessageId: 'M9', replyTo: 'jordan@reply.mynildash.com' });
  const rep = CALLS.find((c) => /\/reply$/.test(c.path));
  check('POST /me/messages/{id}/reply (Mail.Send is enough)', JSON.stringify(paths()) === JSON.stringify(['POST /me/messages/M9/reply']));
  check('the follow-up is the comment, with the Reply-To', rep && rep.body.comment === '<p>Following up.</p>' && rep.body.message.replyTo[0].emailAddress.address === 'jordan@reply.mynildash.com');

  // ── 3. Reply by threadId: a conversationId is never posted as a message id ─
  console.log('\n3. REPLY by threadId (a conversationId)');
  CALLS = []; BEHAVIOUR = tenant();
  await outlook.sendEmail('tok', null, { bodyHtml: '<p>b</p>', threadId: 'CONV1' });
  const lookup = CALLS.find((c) => c.verb === 'GET' && c.path === '/me/messages');
  check('resolved the conversation to its newest message first', lookup && /CONV1/.test(lookup.filter) && lookup.orderby === 'receivedDateTime desc' && lookup.top === 1);
  check('replied to the MESSAGE id, never the conversationId', paths().includes('POST /me/messages/MSG_LATEST/reply') && !paths().some((p) => p.includes('/me/messages/CONV1/')));

  // ── 4. The lookup fails (send-only: no Mail.Read) -> still delivered ──────
  console.log('\n4. SEND-ONLY MAILBOX: the conversation lookup is refused');
  CALLS = [];
  BEHAVIOUR = (verb, path) => { if (verb === 'GET') throw new Error('ErrorAccessDenied: Access is denied'); return {}; };
  r = await outlook.sendEmail('tok', null, { to: ['o@b.com'], subject: 's', bodyHtml: '<p>b</p>', threadId: 'CONV1' });
  check('a refused lookup still delivers, as a new message', paths().includes('POST /me/sendMail'));

  // ── 5. Attachments ────────────────────────────────────────────────────────
  console.log('\n5. MEDIA KIT ATTACHED');
  CALLS = []; BEHAVIOUR = tenant();
  await outlook.sendEmail('tok', null, { to: ['o@b.com'], subject: 's', bodyHtml: '<p>b</p>', attachments: [{ filename: 'kit.pdf', mimeType: 'application/pdf', data: 'YmFzZTY0' }] });
  const a5 = (CALLS.find((c) => c.path === '/me/sendMail') || {}).body;
  check('the attachment travels inside the one send', a5 && a5.message.attachments[0].name === 'kit.pdf' && a5.message.attachments[0].contentBytes === 'YmFzZTY0' && paths().length === 1);

  // ── 6. What the caller stores ─────────────────────────────────────────────
  console.log('\n6. WHAT THE CALLER STORES');
  const caller = (res, minted) => (res && res.messageIdUnknown ? null : ((res && res.messageId) || minted));
  check('Outlook: no anchor stored (never one that did not ship)', caller({ messageId: null, messageIdUnknown: true }, MINTED) === null);
  check('Gmail unchanged: the minted id stands', caller({ providerMessageId: 'g1', providerThreadId: 't1' }, MINTED) === MINTED);
  check('IMAP unchanged', caller({ providerMessageId: MINTED, providerThreadId: null }, MINTED) === MINTED);
  const fs = require('fs');
  check('both send paths use that expression',
    /messageId: result && result\.messageIdUnknown \? null : \(\(result && result\.messageId\) \|\| messageId\)/.test(fs.readFileSync(ROOT + 'server/routes/outreach.js', 'utf8'))
    && /messageId: res && res\.messageIdUnknown \? null : \(\(res && res\.messageId\) \|\| messageId\)/.test(fs.readFileSync(ROOT + 'server/jobs/closerRelease.js', 'utf8')));

  const bad = results.filter((x) => !x.ok);
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' passed');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
