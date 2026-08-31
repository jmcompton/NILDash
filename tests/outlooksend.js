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
const GRAPH_OWN = '<AS8PR01MB1234@prod.outlook.com>';

// Default tenant: accepts our stamp, and the read-back reflects it.
function acceptingTenant(stamped) {
  return (verb, path, body) => {
    if (verb === 'POST' && path === '/me/messages') return { id: 'DRAFT1', conversationId: 'CONV1' };
    if (verb === 'POST' && /\/createReply$/.test(path)) return { id: 'DRAFT2', conversationId: 'CONV1', body: { contentType: 'HTML', content: '<hr>quoted original' } };
    if (verb === 'PATCH') { if (body && body.internetMessageId) stamped.v = body.internetMessageId; return {}; }
    if (verb === 'GET' && path === '/me/messages') return { value: [{ id: 'MSG_LATEST' }] };
    if (verb === 'GET') return { internetMessageId: stamped.v || GRAPH_OWN };
    if (verb === 'POST' && /\/send$/.test(path)) return {};
    if (verb === 'POST' && /\/attachments$/.test(path)) return { id: 'ATT1' };
    return {};
  };
}

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail: detail || '' });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
};
const paths = () => CALLS.map((c) => c.verb + ' ' + c.path);

(async () => {
  // ── 1. New message, tenant accepts the stamp ──────────────────────────────
  console.log('\n1. NEW MESSAGE, tenant accepts our Message-ID');
  CALLS = []; let st = {}; BEHAVIOUR = acceptingTenant(st);
  let r = await outlook.sendEmail('tok', null, {
    to: ['owner@bikeshop.com'], subject: 'A partnership idea',
    bodyHtml: '<p>Hi Laura,</p>', replyTo: 'jordan@reply.mynildash.com', messageId: MINTED,
  });
  console.log('     ' + paths().join('\n     '));
  const patch1 = CALLS.find((c) => c.verb === 'PATCH');
  check('draft created before send', paths()[0] === 'POST /me/messages');
  check('our Message-ID was stamped on the draft', patch1 && patch1.body.internetMessageId === MINTED);
  check('draft was sent', paths().includes('POST /me/messages/DRAFT1/send'));
  check('never used the one-shot /me/sendMail', !paths().some((p) => p.includes('sendMail')));
  check('returns the id that shipped', r.messageId === MINTED, r.messageId);
  check('reports the stamp took', r.messageIdStamped === true);
  check('carries the conversation back', r.providerThreadId === 'CONV1');

  // ── 2. Tenant refuses the stamp ───────────────────────────────────────────
  console.log('\n2. NEW MESSAGE, tenant REFUSES a caller-supplied Message-ID');
  CALLS = [];
  BEHAVIOUR = (verb, path, body) => {
    if (verb === 'PATCH' && body && body.internetMessageId) throw new Error('ErrorInvalidPropertySet');
    return acceptingTenant({})(verb, path, body);
  };
  r = await outlook.sendEmail('tok', null, {
    to: ['owner@bikeshop.com'], subject: 'x', bodyHtml: '<p>y</p>', messageId: MINTED,
  });
  check('still sent -- a refused stamp must not lose the email', paths().includes('POST /me/messages/DRAFT1/send'));
  check('returns what Graph actually assigned, not what we asked for', r.messageId === GRAPH_OWN, r.messageId);
  check('says plainly that the stamp did not take', r.messageIdStamped === false);

  // ── 3. Reply: conversationId must not be posted as a message id ───────────
  console.log('\n3. REPLY by threadId (a conversationId)');
  CALLS = []; st = {}; BEHAVIOUR = acceptingTenant(st);
  r = await outlook.sendEmail('tok', null, {
    to: null, bodyHtml: '<p>Following up.</p>', threadId: 'CONV1', messageId: MINTED,
  });
  console.log('     ' + paths().join('\n     '));
  const lookup = CALLS.find((c) => c.verb === 'GET' && c.path === '/me/messages');
  check('resolved the conversation to a message first', !!lookup, lookup && lookup.filter);
  check('newest message in the conversation', lookup && lookup.orderby === 'receivedDateTime desc' && lookup.top === 1);
  check('createReply used the MESSAGE id', paths().includes('POST /me/messages/MSG_LATEST/createReply'));
  check('the conversationId was never used as a message id',
    !paths().some((p) => p.includes('/me/messages/CONV1/')));
  check('the old /reply endpoint is gone entirely', !paths().some((p) => /\/reply$/.test(p)));
  const patch3 = CALLS.find((c) => c.verb === 'PATCH');
  check('reply keeps the quoted original underneath',
    patch3 && /Following up\./.test(patch3.body.body.content) && /quoted original/.test(patch3.body.body.content));
  check('reply is stamped too', patch3 && patch3.body.internetMessageId === MINTED);

  // ── 4. Conversation resolves to nothing ───────────────────────────────────
  console.log('\n4. REPLY where the conversation has no message');
  CALLS = [];
  BEHAVIOUR = (verb, path, body) => {
    if (verb === 'GET' && path === '/me/messages') return { value: [] };
    return acceptingTenant({})(verb, path, body);
  };
  r = await outlook.sendEmail('tok', null, {
    to: ['owner@bikeshop.com'], subject: 's', bodyHtml: '<p>b</p>', threadId: 'GONE', messageId: MINTED,
  });
  check('falls back to a new message rather than throwing', paths().includes('POST /me/messages'));
  check('still delivered', paths().includes('POST /me/messages/DRAFT1/send'));

  // ── 4b. The lookup itself fails ───────────────────────────────────────────
  CALLS = [];
  BEHAVIOUR = (verb, path, body) => {
    if (verb === 'GET' && path === '/me/messages') throw new Error('Graph 503');
    return acceptingTenant({})(verb, path, body);
  };
  r = await outlook.sendEmail('tok', null, {
    to: ['o@b.com'], subject: 's', bodyHtml: '<p>b</p>', threadId: 'CONV1', messageId: MINTED,
  });
  check('a Graph outage on the lookup still delivers', paths().includes('POST /me/messages/DRAFT1/send'));

  // ── 5. Attachments ────────────────────────────────────────────────────────
  console.log('\n5. MEDIA KIT ATTACHED');
  CALLS = []; st = {}; BEHAVIOUR = acceptingTenant(st);
  await outlook.sendEmail('tok', null, {
    to: ['o@b.com'], subject: 's', bodyHtml: '<p>b</p>', messageId: MINTED,
    attachments: [{ filename: 'kit.pdf', mimeType: 'application/pdf', data: 'YmFzZTY0' }],
  });
  const att = CALLS.find((c) => /\/attachments$/.test(c.path));
  check('attachment posted to the draft', att && att.body.name === 'kit.pdf');
  check('attached before the send', CALLS.indexOf(att) < CALLS.findIndex((c) => /\/send$/.test(c.path)));

  // ── 6. No messageId supplied (reply capture off) ──────────────────────────
  console.log('\n6. REPLY CAPTURE OFF (no messageId minted)');
  CALLS = []; BEHAVIOUR = acceptingTenant({});
  r = await outlook.sendEmail('tok', null, { to: ['o@b.com'], subject: 's', bodyHtml: '<p>b</p>' });
  check('sends with no stamp attempt', !CALLS.some((c) => c.verb === 'PATCH' && c.body && c.body.internetMessageId));
  check('still delivered', paths().includes('POST /me/messages/DRAFT1/send'));

  // ── 7. Caller preference, the expression in both send paths ───────────────
  console.log('\n7. WHAT THE CALLER STORES');
  const caller = (res, minted) => ({ ...(res || {}), messageId: (res && res.messageId) || minted }).messageId;
  check('Outlook confirmed id wins over the minted one',
    caller({ providerMessageId: 'D', messageId: GRAPH_OWN }, MINTED) === GRAPH_OWN);
  check('Gmail unchanged -- reports no messageId, so the minted one stands',
    caller({ providerMessageId: 'g1', providerThreadId: 't1' }, MINTED) === MINTED);
  check('IMAP unchanged',
    caller({ providerMessageId: MINTED, providerThreadId: null }, MINTED) === MINTED);

  const bad = results.filter((x) => !x.ok);
  console.log('\n' + (results.length - bad.length) + '/' + results.length + ' passed');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
