'use strict';
// ── THE AGENT INBOX (services/inbox, GET /api/agent/inbox) ────────────────────────
// On a fresh database with the app's schema:
//   1. only this agent's replied rows, needs-reply first, newest first;
//   2. handled, declined and closed replies are listed but not "needs reply";
//   3. the reply is shown without the quoted pitch, the pitch as plain text;
//   4. the link opens the thread in the agent's own mailbox;
//   5. the route is signed-in only and read only.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('agentinboxtest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const store = require(REPO + 'server/store');
const IB = require(REPO + 'server/services/inbox');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 600) : '')); } };

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ('ib-a', 'Ann Agent', 'ann@agency.example', 'x', 'agent'), ('ib-b', 'Bo Other', 'bo@agency.example', 'x', 'agent')`);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('ib-ath', 'ib-a', '{"name":"Trey Alcott"}'), ('ib-ath2', 'ib-b', '{"name":"Other Athlete"}')`);
  await P.query(`INSERT INTO email_accounts (id, user_id, provider, email_address) VALUES ('ib-mb', 'ib-a', 'gmail', 'ann@agency.example')`);
  const row = (id, agent, ath, brand, extra) => P.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, email_account_id, subject, body_html, status, sent_at, message_id,
       replied_at, reply_from, reply_subject, reply_text, reply_handled_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())`,
    [id, agent, ath, brand, extra.mb || null, extra.subject || 'Trey Alcott, Samford football', extra.body || '<p>Hi Jess,</p><p>I represent Trey &amp; his family.</p>',
      extra.status || 'sent', extra.sent || new Date(Date.now() - 3 * 864e5), extra.mid || null,
      extra.replied || null, extra.from || null, extra.rsub || null, extra.text || null, extra.handled || null]);
  const hour = (h) => new Date(Date.now() - h * 3600e3);
  await row('ib-1', 'ib-a', 'ib-ath', 'Avondale Wing Co.', { mb: 'ib-mb', mid: '<abc123@nildash.example>', replied: hour(2), from: 'jess@avondale.example', rsub: 'Re: Trey Alcott',
    text: 'Love this. What would two posts cost?\n\nOn Tue, Nov 10, 2026 at 9:00 AM Ann <ann@agency.example> wrote:\n> Hi Jess, I represent Trey' });
  await row('ib-2', 'ib-a', 'ib-ath', 'Boro Barbers', { mb: 'ib-mb', mid: '<def@nildash.example>', replied: hour(30), from: 'kev@boro.example', text: 'Signed copy attached.' });
  await row('ib-3', 'ib-a', 'ib-ath', 'Old Handled Co', { replied: hour(1), from: 'x@old.example', text: 'Thanks, all set.', handled: hour(0.5) });
  await row('ib-4', 'ib-a', 'ib-ath', 'No Reply Yet', {});
  await row('ib-5', 'ib-b', 'ib-ath2', 'Someone Else', { replied: hour(1), from: 'y@else.example', text: 'Not yours.' });
  await row('ib-6', 'ib-a', 'ib-ath', 'Ancient Reply', { replied: new Date(Date.now() - 400 * 864e5), from: 'z@old.example', text: 'Long ago.' });

  console.log('\n1. WHOSE ROWS, IN WHAT ORDER');
  const out = await IB.list(P, 'ib-a');
  const ids = out.items.map((i) => i.logId);
  ok('only this agent\'s replied rows, within the window', JSON.stringify(ids.slice().sort()) === '["ib-1","ib-2","ib-3"]', ids);
  ok('needs-reply first, newest first: ib-1, ib-2, then the handled ib-3', JSON.stringify(ids) === '["ib-1","ib-2","ib-3"]', ids);
  ok('the count of replies waiting is 2', out.needsReply === 2, out.needsReply);

  console.log('\n2. HANDLED IS LISTED, NOT WAITING');
  const h = out.items.find((i) => i.logId === 'ib-3');
  ok('a handled reply says so', h && h.needsReply === false && !!h.handledAt, h);
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, outreach_log_id, outcome) VALUES ('ib-a', 'ib-ath', 1, 'boro barbers', 'Boro Barbers', 'ib-2', 'declined')`).catch((e) => console.log('   (queue insert: ' + e.message + ')'));
  const out2 = await IB.list(P, 'ib-a');
  const b = out2.items.find((i) => i.logId === 'ib-2');
  ok('a reply whose deal was marked not interested stops waiting', b && b.needsReply === false && out2.needsReply === 1, b);

  console.log('\n3. WHAT IS SHOWN');
  const a = out.items.find((i) => i.logId === 'ib-1');
  ok('the reply without the quoted pitch underneath', a.reply === 'Love this. What would two posts cost?', a.reply);
  ok('the pitch as plain text, entities decoded, no tags', a.pitch === 'Hi Jess,\nI represent Trey & his family.', a.pitch);
  ok('athlete, business and sender carried', a.athlete === 'Trey Alcott' && a.business === 'Avondale Wing Co.' && a.from === 'jess@avondale.example', a);
  ok('toText drops scripts and styles', IB.toText('<style>x{}</style><script>alert(1)</script><b>ok</b>') === 'ok');

  console.log('\n4. THE LINK OPENS THEIR OWN MAILBOX');
  ok('Gmail: searches the thread by the Message-ID we sent with', a.openUrl === 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent('rfc822msgid:abc123@nildash.example'), a.openUrl);
  ok('Outlook: searches by the sender', IB.openUrl({ provider: 'outlook', reply_from: 'jess@x.example' }) === 'https://outlook.office.com/mail/search?q=jess%40x.example');
  ok('anything else: a mailto with Re: on the subject', IB.openUrl({ reply_from: 'jess@x.example', subject: 'Hello' }) === 'mailto:jess%40x.example?subject=Re%3A%20Hello');
  ok('nothing to link to: null', IB.openUrl({}) === null);

  console.log('\n5. THE ROUTE');
  const SRV = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  const block = SRV.slice(SRV.indexOf("app.get('/api/agent/inbox'"), SRV.indexOf("app.get('/api/agent/home'"));
  ok('GET /api/agent/inbox is signed-in only', /app\.get\('\/api\/agent\/inbox', requireAuth, async/.test(block));
  ok('  scoped to the session\'s agent', /list\(store\.pool, req\.session\.userId\)/.test(block));
  ok('  and read only: the service never writes', !/\b(INSERT|UPDATE|DELETE)\b/.test(fs.readFileSync(REPO + 'server/services/inbox.js', 'utf8').replace(/\/\/.*$/gm, '')));

  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
