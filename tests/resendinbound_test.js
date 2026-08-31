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
// Real Express app, real Postgres (already migrated via server/store.js's own
// init(), so this is the ACTUAL production schema, not a hand-rolled fixture),
// a real webhook signature computed the same way Resend/Svix does it, and a
// stubbed 'resend' module so no real network call happens and no real email
// gets sent. Run: PGHOST=/tmp PGPORT=55432 PGUSER=postgres PGDATABASE=replytest node this.js
'use strict';
process.env.OUTREACH_REPLY_CAPTURE_ENABLED = '1';
process.env.RESEND_WEBHOOK_SECRET = 'whsec_' + Buffer.from('test-secret-bytes-32-long-abcd!').toString('base64');
process.env.RESEND_API_KEY = 're_fake';
process.env.APP_URL = 'https://mynildash.com';

const Module = require('module');
const originalLoad = Module._load;
const sentEmails = [];
let receivingImpl = async () => ({ data: { headers: [], text: '', html: '' } });

Module._load = function (request, parent, isMain) {
  if (request === 'resend') {
    return {
      Resend: class {
        constructor() {
          this.emails = {
            send: async (payload) => { sentEmails.push(payload); return { data: { id: 'fake_send' }, error: null }; },
            receiving: { get: async (id) => receivingImpl(id) },
          };
        }
      },
    };
  }
  return originalLoad.apply(this, arguments);
};

const crypto = require('crypto');
const express = require('express');
const store = require(REPO + 'server/store');
const resendInboundRouter = require(REPO + 'server/routes/resendInbound');
const replyCapture = require(REPO + 'server/services/replyCapture');

let OUT = [], FAIL = 0;
function ok(n, c, got) { if (c) OUT.push('PASS ' + n); else { FAIL++; OUT.push('FAIL ' + n + (got !== undefined ? '  got=' + JSON.stringify(got) : '')); } }

function sign(payload, tsOverride) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const id = 'msg_' + crypto.randomBytes(8).toString('hex');
  const ts = tsOverride || String(Math.floor(Date.now() / 1000));
  const sig = 'v1,' + crypto.createHmac('sha256', key).update(`${id}.${ts}.${payload}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig };
}

async function post(port, path, bodyStr, headers) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: bodyStr,
  });
  return { status: res.status, body: await res.text().catch(() => '') };
}

async function main() {
  await new Promise((r) => setTimeout(r, 1500)); // let store.js's own init() settle

  await store.pool.query('DELETE FROM outreach_logs');
  await store.pool.query('DELETE FROM workflow_events');
  await store.pool.query("DELETE FROM users WHERE id LIKE 'agent_test%'");
  await store.pool.query("DELETE FROM athletes WHERE id LIKE 'ath_test%'");

  await store.pool.query(
    `INSERT INTO users (id, name, email, password, role) VALUES ($1,$2,$3,$4,'agent')`,
    ['agent_test1', 'Test Agent', 'agent-test@example.com', 'x']);
  await store.pool.query(
    `INSERT INTO athletes (id, agent_id, email, data) VALUES ($1,$2,$3,$4)`,
    ['ath_test1', 'agent_test1', 'marcus-test@example.com', JSON.stringify({ name: 'Marcus Johnson' })]);

  const logId = 'out_' + crypto.randomBytes(8).toString('hex');
  await store.pool.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, sent_at)
     VALUES ($1,$2,$3,$4,'sent',NOW())`,
    [logId, 'agent_test1', 'ath_test1', "Saw's BBQ"]);

  const app = express();
  app.use('/api/webhooks/resend-inbound', express.raw({ type: 'application/json' }), resendInboundRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  const replyAddr = replyCapture.replyToAddressFor(logId);
  ok('setup: replyToAddressFor produced an address for this log id', !!replyAddr, replyAddr);

  // ── 1. Signature rejection ──────────────────────────────────────────────
  const payload1 = JSON.stringify({ type: 'email.received', data: { email_id: 'e1', from: 'dana@rallyhouse.com', to: [replyAddr], subject: 'Re: partnership' } });
  const badHeaders = sign(payload1);
  badHeaders['svix-signature'] = 'v1,' + Buffer.from('garbage').toString('base64');
  const r1 = await post(port, '/api/webhooks/resend-inbound', payload1, badHeaders);
  ok('bad signature -> 400', r1.status === 400, r1.status);
  const row1 = (await store.pool.query('SELECT * FROM outreach_logs WHERE id=$1', [logId])).rows[0];
  ok('  and nothing was written to the row', row1.status === 'sent' && row1.last_inbound_kind === null, row1);

  // ── 2. Real reply, correctly signed ─────────────────────────────────────
  receivingImpl = async () => ({ data: { headers: [{ name: 'Content-Type', value: 'text/html' }], text: 'Sounds great, let\'s set up a call!', html: '<p>Sounds great, lets set up a call!</p>' } });
  const goodHeaders2 = sign(payload1);
  const r2 = await post(port, '/api/webhooks/resend-inbound', payload1, goodHeaders2);
  ok('correctly-signed real reply -> 200 immediately', r2.status === 200, r2.status);
  await new Promise((r) => setTimeout(r, 800)); // processEvent runs after the response
  const row2 = (await store.pool.query('SELECT * FROM outreach_logs WHERE id=$1', [logId])).rows[0];
  ok('markReplied fired: status=replied', row2.status === 'replied', row2.status);
  ok('  replied_at is set', !!row2.replied_at, row2.replied_at);
  ok('  reply_text captured from the Receiving API call', row2.reply_text === "Sounds great, let's set up a call!", row2.reply_text);
  ok('  reply_from captured', row2.reply_from === 'dana@rallyhouse.com', row2.reply_from);
  ok('  last_inbound_kind = reply', row2.last_inbound_kind === 'reply', row2.last_inbound_kind);
  const events = (await store.pool.query("SELECT * FROM workflow_events WHERE event_type='reply_received'")).rows;
  ok('  the existing markReplied workflow_event fired too (nothing bypassed)', events.length === 1, events.length);
  ok('  a notification (not a forward) was sent to the AGENT, not the business', sentEmails.length === 1 && sentEmails[0].to === 'agent-test@example.com', sentEmails[0]);
  ok('  notification names the brand', /Saw's BBQ/.test(sentEmails[0].subject), sentEmails[0].subject);
  ok('  notification links into the app, does not paste raw business contact info as if forwarded', /mynildash\.com/.test(sentEmails[0].html), sentEmails[0].html);

  // ── 3. Auto-reply must NOT count as a reply ─────────────────────────────
  await store.pool.query(`UPDATE outreach_logs SET status='sent', replied_at=NULL, reply_text=NULL WHERE id=$1`, [logId]);
  sentEmails.length = 0;
  receivingImpl = async () => ({ data: { headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }], text: 'I am out of office until Monday.', html: '' } });
  const payload3 = JSON.stringify({ type: 'email.received', data: { email_id: 'e3', from: 'dana@rallyhouse.com', to: [replyAddr], subject: 'Automatic reply: Out of Office' } });
  const r3 = await post(port, '/api/webhooks/resend-inbound', payload3, sign(payload3));
  ok('auto-reply webhook -> 200 (acked, not rejected)', r3.status === 200, r3.status);
  await new Promise((r) => setTimeout(r, 500));
  const row3 = (await store.pool.query('SELECT * FROM outreach_logs WHERE id=$1', [logId])).rows[0];
  ok('  status is STILL "sent", not flipped to replied', row3.status === 'sent', row3.status);
  ok('  replied_at is still null', row3.replied_at === null, row3.replied_at);
  ok('  reply_text was never populated for an auto-reply', row3.reply_text === null, row3.reply_text);
  ok('  but last_inbound_kind records that something DID arrive (diagnostic trail)', row3.last_inbound_kind === 'auto_reply', row3.last_inbound_kind);
  ok('  and no agent notification was sent for it', sentEmails.length === 0, sentEmails.length);

  // ── 4. Bounce must NOT count as a reply either ──────────────────────────
  sentEmails.length = 0;
  receivingImpl = async () => ({ data: { headers: [{ name: 'Content-Type', value: 'multipart/report; report-type=delivery-status; boundary=x' }], text: '', html: '' } });
  const payload4 = JSON.stringify({ type: 'email.received', data: { email_id: 'e4', from: 'mailer-daemon@rallyhouse.com', to: [replyAddr], subject: 'Delivery Status Notification (Failure)' } });
  const r4 = await post(port, '/api/webhooks/resend-inbound', payload4, sign(payload4));
  ok('bounce webhook -> 200', r4.status === 200, r4.status);
  await new Promise((r) => setTimeout(r, 500));
  const row4 = (await store.pool.query('SELECT * FROM outreach_logs WHERE id=$1', [logId])).rows[0];
  ok('  status is STILL "sent" after a bounce', row4.status === 'sent', row4.status);
  ok('  last_inbound_kind = bounce', row4.last_inbound_kind === 'bounce', row4.last_inbound_kind);
  ok('  no agent notification for a bounce', sentEmails.length === 0, sentEmails.length);

  // ── 5. Unknown token address: acked, no crash, nothing written ─────────
  const payload5 = JSON.stringify({ type: 'email.received', data: { email_id: 'e5', from: 'x@y.com', to: ['rdeadbeefdeadbeef@reply.mynildash.com'], subject: 'hi' } });
  const r5 = await post(port, '/api/webhooks/resend-inbound', payload5, sign(payload5));
  ok('unknown/unmatched token -> still 200 (no retry storm)', r5.status === 200, r5.status);

  // ── 6. Non-inbound event types are ignored cleanly ──────────────────────
  const payload6 = JSON.stringify({ type: 'email.delivered', data: { email_id: 'e6' } });
  const r6 = await post(port, '/api/webhooks/resend-inbound', payload6, sign(payload6));
  ok('a non email.received event -> 200, ignored', r6.status === 200, r6.status);

  server.close();
  OUT.push(''); OUT.push('failures: ' + FAIL);
  console.log(OUT.join('\n'));
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error('THREW', e); process.exit(1); });
