'use strict';
// Runs against the local test Postgres.
//
//   node tests/mailboxnotice.js
//
// ── A REFUSED MAILBOX IS THE AGENT'S TO RECONNECT, AND A FAILURE ONLY IF IT MATTERS
// John Harrison's Gmail refused its token three nights running (invalid_grant)
// and woke the founder at 12:33am each time; he had never approved or sent
// anything. Now the agent is emailed a reconnect link, and the preflight goes
// red only when a refused mailbox holds something up.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.APP_URL = 'https://mynildash.com';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const store = require(REPO + 'server/store.js');
  const PF = require(REPO + 'server/services/preflight.js');
  const MN = require(REPO + 'server/services/mailboxNotice.js');
  const P = store.pool;
  await MN.ensureTable(P);
  const A = 'u-mbn-dormant', B = 'u-mbn-active';
  const clean = async () => {
    await P.query(`DELETE FROM mailbox_notices WHERE user_id IN ($1,$2)`, [A, B]);
    await P.query(`DELETE FROM outreach_queue WHERE agent_id IN ($1,$2)`, [A, B]);
    await P.query(`DELETE FROM email_accounts WHERE user_id IN ($1,$2)`, [A, B]);
    await P.query(`DELETE FROM athletes WHERE agent_id IN ($1,$2)`, [A, B]);
    await P.query(`DELETE FROM users WHERE id IN ($1,$2)`, [A, B]);
  };
  await clean();
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1,'John Dormant','dormant@mbn.example','x','agent'), ($2,'Ana Active','active@mbn.example','x','agent')`, [A, B]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('ath-mbn-a',$1,'{"name":"A One"}'::jsonb), ('ath-mbn-b',$2,'{"name":"B One"}'::jsonb)`, [A, B]);
  await P.query(`INSERT INTO email_accounts (id, user_id, provider, email_address, status) VALUES ('mbn-a',$1,'gmail','dormant@gmail.example','active')`, [A]);

  const sent = [];
  const deps = (refused) => ({ pool: P,
    emailStore: { getEmailAccountWithTokens: async () => ({ refreshToken: 'rt' }) },
    gmail: { isAvailable: () => true, refreshAccessToken: async () => { if (refused) throw new Error('invalid_grant'); return { accessToken: 'at' }; } },
    noticeSend: async (m) => { sent.push(m); } });
  const check = (refused) => PF.checks(deps(refused))['mailbox-tokens']().then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

  // ── 1. A DORMANT AGENT'S REFUSED MAILBOX: a notice, not a failure ─────────
  const r1 = await check(true);
  ok('A REFUSED MAILBOX WITH NOTHING WAITING IS NOT A PREFLIGHT FAILURE', r1.ok && /refused with nothing waiting \(notice, agent emailed\)/.test(r1.v), r1);
  ok('  the agent who owns it is emailed a reconnect link, not the founder', sent.length === 1 && sent[0].to === 'dormant@mbn.example'
    && /mynildash\.com\/reconnect-mailbox\?provider=gmail/.test(sent[0].text) && /Reconnect your Gmail/.test(sent[0].subject), sent[0]);
  const r2 = await check(true);
  ok('  a second night: still a notice, and no second email inside a week', r2.ok && sent.length === 1, { r2, sent: sent.length });
  const rec = await MN.recent(P);
  ok('  listed for the morning alert, counted, with nothing waiting', rec.some((x) => x.account_id === 'mbn-a' && x.queued === 0 && x.approved === 0 && x.emailed_at), rec);

  // ── 2. AN AGENT WITH CARDS WAITING: still a failure ───────────────────────
  await P.query(`INSERT INTO email_accounts (id, user_id, provider, email_address, status) VALUES ('mbn-b',$1,'gmail','active@gmail.example','active')`, [B]);
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state) VALUES ($1,'ath-mbn-b',1,'k:taco','Taco Spot','email','queued')`, [B]);
  const r3 = await check(true);
  ok('A REFUSED MAILBOX WITH CARDS WAITING IS STILL A FAILURE, naming only that agent', !r3.ok && /Ana Active/.test(r3.e.message) && !/John Dormant/.test(r3.e.message)
    && /1 card\(s\) waiting/.test(r3.e.message), r3.e && r3.e.message);
  ok('  and that agent is emailed too', sent.some((m) => m.to === 'active@mbn.example'));

  // ── 3. RECONNECTED: the notice clears ─────────────────────────────────────
  await check(false);
  ok('a mailbox that refreshes again leaves the notice list', !(await MN.recent(P)).some((x) => x.user_id === A || x.user_id === B));

  // ── 4. DISCONNECTED: not checked at all ───────────────────────────────────
  await check(true);
  const D = require(REPO + 'scripts/disconnect-mailbox.js');
  const dry = await D.run(P, 'dormant@gmail.example', false);
  ok('THE DISCONNECT SCRIPT, DRY RUN: says what it would do, changes nothing', /would be disconnected/.test(dry.lines.join('\n'))
    && (await P.query(`SELECT status FROM email_accounts WHERE id = 'mbn-a'`)).rows[0].status === 'active', dry.lines);
  const app = await D.run(P, 'dormant@mbn.example', true);
  ok('  applied: disconnected (not deleted), found by the agent\'s login too, and off the notice list', app.changed === 1
    && (await P.query(`SELECT status FROM email_accounts WHERE id = 'mbn-a'`)).rows[0].status === 'disconnected' && !(await MN.recent(P)).some((x) => x.account_id === 'mbn-a'), app.lines);
  const before = sent.length;
  await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [B]);
  await P.query(`UPDATE email_accounts SET status = 'disconnected' WHERE id = 'mbn-b'`);
  const r5 = await check(true);
  ok('  a disconnected mailbox is not checked, so it never alerts or emails', r5.ok && sent.length === before, r5);

  // ── 5. THE LINK AND THE ALERT ─────────────────────────────────────────────
  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('the reconnect link: signed in, the provider\'s consent screen; signed out, sign in first', /app\.get\('\/reconnect-mailbox'/.test(idx)
    && /res\.redirect\('\/\?next=' \+ encodeURIComponent\('\/reconnect-mailbox\?provider=' \+ p\)\)/.test(idx) && /\/api\/email\/oauth\/\$\{p\}/.test(idx));
  ok('  and the sign-in page returns to it', /reconnect-mailbox\\\?provider=\(gmail\|outlook\)\$\/\.test\(_next\)/.test(fs.readFileSync(REPO + 'public/index.html', 'utf8')));
  ok('the morning alert lists the notices', /MAILBOX NOTICES/.test(fs.readFileSync(REPO + 'server/services/morningAlert.js', 'utf8')));
  await clean();
}
main().then(() => { console.log(OUT.join('\n')); console.log(`\nfailures: ${F}`); process.exit(F ? 1 : 0); })
  .catch((e) => { console.log(OUT.join('\n')); console.log('FAIL threw: ' + (e && e.stack)); process.exit(1); });
