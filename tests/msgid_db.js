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
process.env.OUTREACH_REPLY_DOMAIN = 'mynildash.com';
process.env.RESEND_WEBHOOK_SECRET = 'whsec_' + Buffer.from('secret-bytes-32-chars-long-ab!!').toString('base64');
process.env.RESEND_API_KEY = 're_fake';
process.env.ADMIN_EMAIL = 'admin@example.com';

const Module = require('module');
const orig = Module._load;
const sentEmails = [];
let receivingImpl = async () => ({ data: { headers: [], text: 'Sounds great!', html: '' } });
Module._load = function (r) {
  if (r === 'resend') return { Resend: class { constructor(){ this.emails = {
    send: async (p) => { sentEmails.push(p); return { data: { id: 'x' } }; },
    receiving: { get: async (id) => receivingImpl(id) } }; } } };
  return orig.apply(this, arguments);
};

const crypto = require('crypto');
const express = require('express');
const store = require(REPO + 'server/store');
const RC = require(REPO + 'server/services/replyCapture');
const router = require(REPO + 'server/routes/resendInbound');

let OUT = [], FAIL = 0;
const ok = (n, c, got) => { if (c) OUT.push('PASS ' + n); else { FAIL++; OUT.push('FAIL ' + n + (got !== undefined ? '  got=' + JSON.stringify(got) : '')); } };

function sign(p) {
  const key = Buffer.from(process.env.RESEND_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const id = 'msg_' + crypto.randomBytes(6).toString('hex'), ts = String(Math.floor(Date.now() / 1000));
  return { 'svix-id': id, 'svix-timestamp': ts,
    'svix-signature': 'v1,' + crypto.createHmac('sha256', key).update(`${id}.${ts}.${p}`).digest('base64') };
}
let PORT;
const post = async (b) => (await fetch(`http://127.0.0.1:${PORT}/api/webhooks/resend-inbound`,
  { method: 'POST', headers: { 'Content-Type': 'application/json', ...sign(b) }, body: b })).status;
const inbound = (to, from, subject) => JSON.stringify({ type: 'email.received',
  created_at: new Date().toISOString(),
  data: { email_id: 'e_' + crypto.randomBytes(4).toString('hex'), from, to: [to], subject: subject || 'Re: hi' } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await wait(2000);
  const pool = store.pool;
  for (const t of ['inbound_messages', 'outreach_logs', 'workflow_events']) await pool.query(`DELETE FROM ${t}`);
  await pool.query("DELETE FROM users WHERE id LIKE 'ag_%'");
  await pool.query("DELETE FROM athletes WHERE id LIKE 'at_%'");
  await pool.query(`INSERT INTO users (id,name,email,password,role,reply_local_part)
    VALUES ('ag_1','John Mark Compton','jm@x.com','x','agent','johnmark')`);
  await pool.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('at_1','ag_1','{"name":"Marcus"}'::jsonb)`);

  const app = express();
  app.use('/api/webhooks/resend-inbound', express.raw({ type: 'application/json' }), router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  PORT = srv.address().port;

  // ── Message-ID shape ──────────────────────────────────────────────────────
  const mid = RC.buildMessageId('out_aaaaaaaaaaaaaaaa');
  ok('buildMessageId is a valid RFC822 id on the reply domain',
    /^<out_aaaaaaaaaaaaaaaa\.[0-9a-f]{16}@mynildash\.com>$/.test(mid), mid);
  ok('two calls differ (no collisions across sends)', RC.buildMessageId('out_x') !== RC.buildMessageId('out_x'));

  ok('referencedMessageIds reads In-Reply-To',
    RC.referencedMessageIds({ 'In-Reply-To': '<a@b>' })[0] === '<a@b>');
  ok('  and References, most-recent ancestor first',
    JSON.stringify(RC.referencedMessageIds({ References: '<root@b> <mid@b> <last@b>' })) === '["<last@b>","<mid@b>","<root@b>"]',
    RC.referencedMessageIds({ References: '<root@b> <mid@b> <last@b>' }));
  ok('  In-Reply-To is tried before References',
    RC.referencedMessageIds({ 'In-Reply-To': '<direct@b>', References: '<root@b>' })[0] === '<direct@b>');

  // ── (a) header match beats the ambiguity that defeats sender match ────────
  // Two pitches to the SAME business, same agent. Sender matching cannot tell
  // them apart; the Message-ID can.
  const midOld = RC.buildMessageId('out_1111111111111111');
  const midNew = RC.buildMessageId('out_2222222222222222');
  await pool.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,status,sent_at,sent_to_email,message_id) VALUES
    ('out_1111111111111111','ag_1','at_1','Acme','sent','2026-08-01','info@acme.com',$1),
    ('out_2222222222222222','ag_1','at_1','Acme','sent','2026-08-09','info@acme.com',$2)`, [midOld, midNew]);

  receivingImpl = async () => ({ data: { headers: [{ name: 'In-Reply-To', value: midOld }], text: 'yes', html: '' } });
  ok('POST accepted', (await post(inbound('johnmark@mynildash.com', 'dana@acme.com'))) === 200);
  await wait(800);
  let a = (await pool.query(`SELECT status FROM outreach_logs WHERE id='out_1111111111111111'`)).rows[0];
  let b = (await pool.query(`SELECT status FROM outreach_logs WHERE id='out_2222222222222222'`)).rows[0];
  ok('In-Reply-To picks the OLDER pitch, which sender-matching would have missed', a.status === 'replied', a.status);
  ok('  and leaves the newer one alone', b.status === 'sent', b.status);
  let im = (await pool.query(`SELECT * FROM inbound_messages ORDER BY id DESC LIMIT 1`)).rows[0];
  ok('  recorded with match_method=in-reply-to', im.match_method === 'in-reply-to', im.match_method);
  ok('  and no ambiguity warning was sent', !/Heads up/.test(sentEmails[sentEmails.length - 1].html));

  // ── (b) falls back to sender when no usable headers ───────────────────────
  sentEmails.length = 0;
  receivingImpl = async () => ({ data: { headers: [], text: 'hi', html: '' } });
  await pool.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,status,sent_at,sent_to_email)
    VALUES ('out_3333333333333333','ag_1','at_1','Beta','sent','2026-08-02','info@beta.com')`);
  await post(inbound('johnmark@mynildash.com', 'dana@beta.com'));
  await wait(800);
  ok('with no headers it falls back to the sender ladder',
    (await pool.query(`SELECT status FROM outreach_logs WHERE id='out_3333333333333333'`)).rows[0].status === 'replied');
  im = (await pool.query(`SELECT * FROM inbound_messages ORDER BY id DESC LIMIT 1`)).rows[0];
  ok('  recorded as from-domain', im.match_method === 'from-domain', im.match_method);

  // ── (c) unmatched is STORED, never discarded ──────────────────────────────
  sentEmails.length = 0;
  const beforeCount = (await pool.query('SELECT COUNT(*)::int n FROM inbound_messages')).rows[0].n;
  await post(inbound('johnmark@mynildash.com', 'stranger@nowhere.com', 'Is this you?'));
  await wait(800);
  const after = (await pool.query('SELECT COUNT(*)::int n FROM inbound_messages')).rows[0].n;
  ok('an unmatched reply is STORED, not thrown away', after === beforeCount + 1, { beforeCount, after });
  im = (await pool.query(`SELECT * FROM inbound_messages ORDER BY id DESC LIMIT 1`)).rows[0];
  ok('  flagged unmatched', im.match_method === 'unmatched' && im.matched_outreach_id === null, im);
  ok('  with the sender preserved so it can be actioned by hand', im.from_addr === 'stranger@nowhere.com', im.from_addr);
  ok('  and the reason recorded', !!im.note, im.note);
  ok('  no outreach was wrongly marked replied', sentEmails.length === 0);

  // ── catch-all noise is recorded too, but marked not-ours ──────────────────
  await post(inbound('noreply@mynildash.com', 'someone@x.com'));
  await wait(600);
  im = (await pool.query(`SELECT * FROM inbound_messages ORDER BY id DESC LIMIT 1`)).rows[0];
  ok('mail to a non-agent address is recorded as not-ours', im.match_method === 'not-ours', im.match_method);

  // ── a bounce that matches still never counts as a reply ───────────────────
  sentEmails.length = 0;
  receivingImpl = async () => ({ data: { headers: [{ name: 'Content-Type', value: 'multipart/report; report-type=delivery-status' }], text: '', html: '' } });
  await pool.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,status,sent_at,sent_to_email)
    VALUES ('out_4444444444444444','ag_1','at_1','Gamma','sent','2026-08-03','info@gamma.com')`);
  await post(inbound('johnmark@mynildash.com', 'mailer-daemon@gamma.com', 'Undeliverable'));
  await wait(800);
  ok('a bounce is still not a reply', (await pool.query(`SELECT status FROM outreach_logs WHERE id='out_4444444444444444'`)).rows[0].status === 'sent');
  im = (await pool.query(`SELECT * FROM inbound_messages ORDER BY id DESC LIMIT 1`)).rows[0];
  ok('  but it IS recorded, with its classification', im.classification === 'bounce', im.classification);
  ok('  and no notification sent', sentEmails.length === 0);

  srv.close();
  OUT.push(''); OUT.push('failures: ' + FAIL);
  console.log(OUT.join('\n'));
  process.exit(FAIL ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
