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
// Real Postgres + real Express + real Svix signature. Only 'resend' is stubbed
// (no network, no mail sent). Exercises the whole inbound path end to end.
'use strict';
process.env.OUTREACH_REPLY_CAPTURE_ENABLED = '1';
process.env.OUTREACH_REPLY_DOMAIN = 'mynildash.com';
process.env.RESEND_WEBHOOK_SECRET = 'whsec_' + Buffer.from('secret-bytes-32-chars-long-ab!!').toString('base64');
process.env.RESEND_API_KEY = 're_fake';
process.env.APP_URL = 'https://mynildash.com';

const Module = require('module');
const originalLoad = Module._load;
const sentEmails = [];
let receivingImpl = async () => ({ data: { headers: [], text: 'Sounds great!', html: '' } });
Module._load = function (request) {
  if (request === 'resend') {
    return { Resend: class {
      constructor() {
        this.emails = {
          send: async (p) => { sentEmails.push(p); return { data: { id: 'x' } }; },
          receiving: { get: async (id) => receivingImpl(id) },
        };
      }
    } };
  }
  return originalLoad.apply(this, arguments);
};

const crypto = require('crypto');
const express = require('express');
const store = require(REPO + 'server/store');
const RC = require(REPO + 'server/services/replyCapture');
const router = require(REPO + 'server/routes/resendInbound');

let OUT = [], FAIL = 0;
function ok(n, c, got) { if (c) OUT.push('PASS ' + n); else { FAIL++; OUT.push('FAIL ' + n + (got !== undefined ? '  got=' + JSON.stringify(got) : '')); } }

function sign(payload) {
  const key = Buffer.from(process.env.RESEND_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const id = 'msg_' + crypto.randomBytes(6).toString('hex');
  const ts = String(Math.floor(Date.now() / 1000));
  return { 'svix-id': id, 'svix-timestamp': ts,
    'svix-signature': 'v1,' + crypto.createHmac('sha256', key).update(`${id}.${ts}.${payload}`).digest('base64') };
}
async function post(port, body) {
  const r = await fetch(`http://127.0.0.1:${port}/api/webhooks/resend-inbound`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...sign(body) }, body });
  return r.status;
}
const inbound = (to, from, subject) => JSON.stringify({
  type: 'email.received', created_at: new Date().toISOString(),
  data: { email_id: 'e_' + Math.random().toString(16).slice(2), from, to: [to], subject: subject || 'Re: partnership' },
});

async function main() {
  await new Promise((r) => setTimeout(r, 2000));
  const pool = store.pool;
  await pool.query('DELETE FROM outreach_logs');
  await pool.query('DELETE FROM workflow_events');
  await pool.query("DELETE FROM users WHERE id LIKE 'ag_%'");
  await pool.query("DELETE FROM athletes WHERE id LIKE 'at_%'");

  // Three agents, two sharing a first name, to exercise the collision ladder.
  await pool.query(`INSERT INTO users (id,name,email,password,role) VALUES
    ('ag_1','John Mark Compton','jm@x.com','x','agent'),
    ('ag_2','John Smith','js@x.com','x','agent'),
    ('ag_3','John Sanders','jsa@x.com','x','agent')`);
  await pool.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('at_1','ag_1','{"name":"Marcus Johnson"}'::jsonb)`);

  // Assign addresses the same way the send route does.
  const outreachRoute = require(REPO + 'server/routes/outreach.js');
  // ensureReplyLocalPart is module-private, so drive it through the same ladder
  // the route uses, against the real unique index.
  async function assign(agentId) {
    const u = (await pool.query('SELECT name,email,reply_local_part FROM users WHERE id=$1', [agentId])).rows[0];
    if (u.reply_local_part) return u.reply_local_part;
    for (const cand of RC.localPartCandidates(u.name, u.email)) {
      const r = await pool.query(
        `UPDATE users SET reply_local_part=$2 WHERE id=$1 AND reply_local_part IS NULL RETURNING reply_local_part`,
        [agentId, cand]).catch((e) => (e.code === '23505' ? null : Promise.reject(e)));
      if (r && r.rows[0]) return r.rows[0].reply_local_part;
    }
    return null;
  }
  const a1 = await assign('ag_1'), a2 = await assign('ag_2'), a3 = await assign('ag_3');
  ok('agent 1 gets the clean name', a1 === 'johnmark', a1);
  ok('agent 2 (different first name pool) gets john', a2 === 'john', a2);
  ok('agent 3 COLLIDES on john and falls to the next rung', a3 === 'johns', a3);
  ok('  all three are distinct', new Set([a1, a2, a3]).size === 3, [a1, a2, a3]);
  ok('  and re-assigning is stable, never reissued', (await assign('ag_1')) === a1);

  const app = express();
  app.use('/api/webhooks/resend-inbound', express.raw({ type: 'application/json' }), router);
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const port = server.address().port;

  const mkLog = async (id, to, sentAt) => pool.query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,status,sent_at,sent_to_email)
     VALUES ($1,'ag_1','at_1',$2,'sent',$3,$4)`, [id, 'Acme Co', sentAt, to]);

  // ── 1. Named address, exact sender ────────────────────────────────────────
  await mkLog('out_1111111111111111', 'dana@acme.com', '2026-08-01');
  ok('POST accepted', (await post(port, inbound('johnmark@mynildash.com', 'dana@acme.com'))) === 200);
  await new Promise((r) => setTimeout(r, 700));
  let row = (await pool.query(`SELECT * FROM outreach_logs WHERE id='out_1111111111111111'`)).rows[0];
  ok('an exact-sender reply marks the right outreach replied', row.status === 'replied', row.status);
  ok('  and no ambiguity warning is sent', sentEmails.length === 1 && !/Heads up/.test(sentEmails[0].html), sentEmails[0] && sentEmails[0].html);

  // ── 2. General inbox -> human reply (domain match) ────────────────────────
  sentEmails.length = 0;
  await mkLog('out_2222222222222222', 'info@beta.com', '2026-08-02');
  await post(port, inbound('johnmark@mynildash.com', 'dana@beta.com'));
  await new Promise((r) => setTimeout(r, 700));
  row = (await pool.query(`SELECT * FROM outreach_logs WHERE id='out_2222222222222222'`)).rows[0];
  ok('a reply from a DIFFERENT mailbox at the same company still matches', row.status === 'replied', row.status);

  // ── 3. THE ASKED QUESTION: two open outreaches to one business ───────────
  sentEmails.length = 0;
  await mkLog('out_3333333333333333', 'info@gamma.com', '2026-08-01');
  await mkLog('out_4444444444444444', 'info@gamma.com', '2026-08-09');
  await post(port, inbound('johnmark@mynildash.com', 'dana@gamma.com'));
  await new Promise((r) => setTimeout(r, 700));
  const older = (await pool.query(`SELECT status FROM outreach_logs WHERE id='out_3333333333333333'`)).rows[0];
  const newer = (await pool.query(`SELECT status FROM outreach_logs WHERE id='out_4444444444444444'`)).rows[0];
  ok('the MOST RECENT open outreach is the one marked replied', newer.status === 'replied', newer.status);
  ok('  the older one is left alone (not double-marked)', older.status === 'sent', older.status);
  ok('  and the agent is WARNED the attribution may be wrong',
    sentEmails.length === 1 && /Heads up/.test(sentEmails[0].html), sentEmails[0] && sentEmails[0].html.slice(0, 400));
  ok('  naming how many pitches are competing', /2 open outreaches/.test(sentEmails[0].html));

  // ── 4. Cross-agent isolation ─────────────────────────────────────────────
  sentEmails.length = 0;
  await pool.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,status,sent_at,sent_to_email)
    VALUES ('out_5555555555555555','ag_2','at_1','Delta','sent','2026-08-01','dana@delta.com')`);
  await post(port, inbound('johnmark@mynildash.com', 'dana@delta.com'));
  await new Promise((r) => setTimeout(r, 700));
  const other = (await pool.query(`SELECT status FROM outreach_logs WHERE id='out_5555555555555555'`)).rows[0];
  ok("agent 1's address can never match agent 2's outreach", other.status === 'sent', other.status);
  ok('  and no notification is sent for it', sentEmails.length === 0, sentEmails.length);

  // ── 5. Catch-all noise is dropped quietly ────────────────────────────────
  ok('mail to noreply@ is accepted but ignored', (await post(port, inbound('noreply@mynildash.com', 'x@y.com'))) === 200);
  ok('mail to an unknown local part is accepted but ignored', (await post(port, inbound('nobody@mynildash.com', 'x@y.com'))) === 200);

  // ── 6. Legacy token still works ──────────────────────────────────────────
  sentEmails.length = 0;
  await pool.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,status,sent_at)
    VALUES ('out_8b3e030aceadf56c','ag_1','at_1','Legacy Co','sent','2026-07-01')`);
  await post(port, inbound('r8b3e030aceadf56c@reply.mynildash.com', 'anyone@anywhere.com'));
  await new Promise((r) => setTimeout(r, 700));
  const legacy = (await pool.query(`SELECT status FROM outreach_logs WHERE id='out_8b3e030aceadf56c'`)).rows[0];
  ok('a reply to an already-sent TOKEN address still matches exactly', legacy.status === 'replied', legacy.status);
  ok('  even though the sender matches no sent_to_email at all', sentEmails.length === 1);

  // ── 7. Auto-reply still never counts, on the named path ──────────────────
  sentEmails.length = 0;
  receivingImpl = async () => ({ data: { headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }], text: 'OOO', html: '' } });
  await mkLog('out_6666666666666666', 'dana@epsilon.com', '2026-08-05');
  await post(port, inbound('johnmark@mynildash.com', 'dana@epsilon.com', 'Automatic reply'));
  await new Promise((r) => setTimeout(r, 700));
  const ooo = (await pool.query(`SELECT status,last_inbound_kind FROM outreach_logs WHERE id='out_6666666666666666'`)).rows[0];
  ok('an out-of-office on the named path is still NOT a reply', ooo.status === 'sent', ooo.status);
  ok('  but is recorded as seen', ooo.last_inbound_kind === 'auto_reply', ooo.last_inbound_kind);
  ok('  and does not notify', sentEmails.length === 0);

  server.close();
  OUT.push(''); OUT.push('failures: ' + FAIL);
  console.log(OUT.join('\n'));
  process.exit(FAIL ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
