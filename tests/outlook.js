'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js        every suite, against the committed baseline
//   node tests/outlook.js    just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
process.env.OUTLOOK_CLIENT_ID = 'test-client-id';
process.env.OUTLOOK_CLIENT_SECRET = 'test-secret';
process.env.OUTLOOK_REDIRECT_URI = 'https://mynildash.com/api/email/oauth/outlook/callback';
delete process.env.OUTLOOK_TENANT_ID;

// ── OUTLOOK / MICROSOFT 365: CONNECT, STAY CONNECTED, SEND, READ REPLIES ────
// Microsoft is faked at the network (the v2 token endpoint and Graph), so this
// proves our side end to end without an Azure app:
//   1. The authorize URL asks for the right scopes (offline_access included).
//   2. The code exchange returns and KEEPS a refresh token (MSAL never did).
//   3. Refresh returns Microsoft's rotated refresh token, and it is stored.
//   4. Every send reads tokens through emailStore, which refreshes an expired
//      Outlook token first.
//   5. Send: draft, stamp our Message-ID, send; the Message-ID read back.
//   6. Replies read as received (from someone else), our own mail as sent.
//   7. One mailbox per agent: connecting Outlook retires the Gmail one.
//   8. The preflight's mailbox check covers Outlook, says "will not send" on a
//      refused token, and stores a rotated one.
const fs = require('fs');
const store = require(REPO + 'server/store.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const realFetch = global.fetch;
const U = 'ol-agent';

// A fake Microsoft. tokenMode: 'ok' | 'norefresh' | 'refused'.
function microsoft(state) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url && url.url ? url.url : url);
    const method = (init && init.method) || (url && url.method) || 'GET';
    calls.push({ u, method, body: init && init.body ? String(init.body) : '' });
    const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (/login\.microsoftonline\.com\/.*\/token$/.test(u)) {
      const b = new URLSearchParams(String(init.body));
      if (state.tokenMode === 'refused') return res(400, { error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired due to inactivity.\r\nTrace ID: x' });
      state.issued = (state.issued || 0) + 1;
      const out = { token_type: 'Bearer', expires_in: 3599, access_token: 'AT' + state.issued, scope: 'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read' };
      if (state.tokenMode !== 'norefresh') out.refresh_token = (b.get('grant_type') === 'refresh_token' ? 'RT-rotated-' : 'RT-') + state.issued;
      return res(200, out);
    }
    if (/graph\.microsoft\.com\/v1\.0\/me(\?|$)/.test(u)) return res(200, { mail: 'Agent@Contoso.com', displayName: 'Ana Agent', userPrincipalName: 'agent@contoso.com' });
    if (/\/me\/messages\?/.test(u) && method === 'GET') return res(200, { value: state.inbox || [] });
    if (/\/me\/messages$/.test(u) && method === 'POST') return res(201, { id: 'draft1', conversationId: 'conv1' });
    if (/\/me\/messages\/draft1$/.test(u) && method === 'PATCH') { state.patched = JSON.parse(init.body); return res(200, {}); }
    if (/\/me\/messages\/draft1\?\$select=internetMessageId/.test(u)) return res(200, { internetMessageId: state.patched && state.patched.internetMessageId });
    if (/\/me\/messages\/draft1\/send$/.test(u)) { state.sent = true; return res(202, {}); }
    if (/\/me\/sendMail$/.test(u) && method === 'POST') { state.sent = JSON.parse(init.body); return new Response(null, { status: 202 }); }
    if (/\/me\/messages\/m1\/reply$/.test(u) && method === 'POST') { state.replied = JSON.parse(init.body); return new Response(null, { status: 202 }); }
    return res(404, { error: { message: 'unexpected ' + method + ' ' + u } });
  };
  return calls;
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const O = require(REPO + 'server/services/providers/outlook.js');
  const ES = require(REPO + 'server/services/emailStore.js');
  const clean = async () => { await P.query(`DELETE FROM email_accounts WHERE user_id = $1`, [U]).catch(() => {}); await P.query(`DELETE FROM users WHERE id = $1`, [U]).catch(() => {}); };
  await clean();
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1,'Ana Agent','ol@x.test','x','agent')`, [U]);

  // ── 1. THE AUTHORIZE URL ────────────────────────────────────────────────
  OUT.push('-- connect --');
  const url = new URL(O.getAuthUrl('state123'));
  ok('the authorize URL is the v2 endpoint on "common" (any work, school or personal account), with our redirect',
    url.origin + url.pathname === 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize' && url.searchParams.get('redirect_uri') === process.env.OUTLOOK_REDIRECT_URI
    && url.searchParams.get('client_id') === 'test-client-id' && url.searchParams.get('state') === 'state123', url.toString());
  const sc = url.searchParams.get('scope').split(' ');
  ok('  the default asks the least: Mail.Send, User.Read, offline_access; no read or write permission on the mailbox',
    JSON.stringify(sc.slice().sort()) === JSON.stringify(['https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/User.Read', 'offline_access'].sort()), sc);
  const scR = new URL(O.getAuthUrl('s', { read: true })).searchParams.get('scope').split(' ');
  ok('  the "also read replies" upgrade adds Mail.Read, and still never Mail.ReadWrite',
    scR.includes('https://graph.microsoft.com/Mail.Read') && !scR.some((x) => /ReadWrite/.test(x)), scR);

  // ── 2. THE CODE EXCHANGE KEEPS A REFRESH TOKEN ─────────────────────────
  const st = { tokenMode: 'ok' };
  microsoft(st);
  const t = await O.exchangeCode('authcode');
  ok('the exchange returns the refresh token, the mailbox address (lower case) and that it may send',
    t.refreshToken === 'RT-1' && t.accessToken === 'AT1' && t.email === 'agent@contoso.com' && t.canSend === true && t.expiry instanceof Date, t);
  ok('  canRead follows the granted scopes (Mail.Read), so sync runs only where it may',
    O.canReadFrom(['https://graph.microsoft.com/Mail.Read']) && !O.canReadFrom(['https://graph.microsoft.com/Mail.Send']));
  st.tokenMode = 'norefresh';
  let noRt = null; try { await O.exchangeCode('authcode'); } catch (e) { noRt = e; }
  ok('  no refresh token (offline_access refused): the connection is refused with a plain reason, never saved to die in an hour', noRt && /did not return a refresh token/.test(noRt.message));
  st.tokenMode = 'ok';

  // ── 3. REFRESH ROTATES ──────────────────────────────────────────────────
  const r = await O.refreshAccessToken('RT-1');
  ok('refresh returns a new access token and Microsoft\'s rotated refresh token', /^AT/.test(r.accessToken) && /^RT-rotated-/.test(r.refreshToken), r);
  st.tokenMode = 'refused';
  let refused = null; try { await O.refreshAccessToken('RT-old'); } catch (e) { refused = e; }
  ok('  a refused refresh throws with Microsoft\'s words and the status', refused && refused.status === 400 && /invalid_grant: AADSTS700082/.test(refused.message), refused && refused.message);
  st.tokenMode = 'ok';

  // ── 7. ONE MAILBOX PER AGENT ────────────────────────────────────────────
  OUT.push('', '-- one mailbox --');
  await ES.saveEmailAccount('ea_g1', U, 'gmail', 'ana@gmail.test', 'Ana', 'gAT', 'gRT', new Date(Date.now() + 3600e3), null, true);
  const ol = await ES.saveEmailAccount('ea_o1', U, 'outlook', t.email, t.displayName, t.accessToken, t.refreshToken, new Date(Date.now() - 60e3), t.grantedScopes, t.canSend);
  const rows = (await P.query(`SELECT id, provider, status FROM email_accounts WHERE user_id = $1 ORDER BY created_at`, [U])).rows;
  const pick = ES.pickSendingAccount(await ES.getEmailAccountsByUser(U));
  ok('connecting Outlook retires the Gmail mailbox (kept, marked disconnected) and Outlook is the one that sends',
    rows.find((x) => x.provider === 'gmail').status === 'disconnected' && rows.find((x) => x.provider === 'outlook').status === 'active' && pick && pick.provider === 'outlook', { rows, pick: pick && pick.provider });

  // ── 4. AN EXPIRED OUTLOOK TOKEN IS REFRESHED WHERE EVERY SEND READS IT ─
  OUT.push('', '-- send --');
  const before = st.issued;
  const full = await ES.getEmailAccountWithTokens(ol.id);
  const stored = await ES.getEmailAccountWithTokens(ol.id);
  ok('reading an expired Outlook account refreshes it once, and stores the rotated refresh token',
    full.tokenRefreshed && /^AT/.test(full.accessToken) && full.accessToken !== 'AT1' && /^RT-rotated-/.test(full.refreshToken)
    && stored.refreshToken === full.refreshToken && !stored.tokenRefreshed && st.issued === before + 1, { full: { a: full.accessToken, r: full.refreshToken }, stored: stored.refreshToken });

  // ── 5. SEND: ONE CALL ON Mail.Send ──────────────────────────────────────
  const calls = microsoft(st);
  const sent = await O.sendEmail(full.accessToken, full.refreshToken, { to: ['owner@bakery.test'], subject: 'Hi', bodyHtml: '<p>Hello</p>', replyTo: 'ana@reply.mynildash.com', messageId: '<log-1@mynildash.com>' });
  const seq = calls.filter((c) => /graph\.microsoft\.com/.test(c.u)).map((c) => c.method + ' ' + c.u.replace('https://graph.microsoft.com/v1.0', '').split('?')[0]);
  const m = st.sent && st.sent.message;
  ok('send: one /me/sendMail (Mail.Send is enough), saved to Sent Items', JSON.stringify(seq) === JSON.stringify(['POST /me/sendMail']) && st.sent.saveToSentItems === true, seq);
  ok('  the subject, body, recipient and the Reply-To that routes the answer back to us',
    m && m.subject === 'Hi' && m.body.content === '<p>Hello</p>' && m.toRecipients[0].emailAddress.address === 'owner@bakery.test' && m.replyTo[0].emailAddress.address === 'ana@reply.mynildash.com', m);
  ok('  our message id rides along as an X- header; the result says it was not stamped, so the caller keeps its own',
    m.internetMessageHeaders[0].name === 'X-NILDash-Message-Id' && m.internetMessageHeaders[0].value === '<log-1@mynildash.com>' && sent.messageId === null && sent.messageIdStamped === false, { h: m.internetMessageHeaders, sent });
  st.sent = null;
  await O.sendEmail('AT', 'RT', { replyToMessageId: 'm1', bodyHtml: '<p>Following up</p>', replyTo: 'ana@reply.mynildash.com' });
  ok('  a reply to a known message: /me/messages/{id}/reply, also on Mail.Send', st.replied && st.replied.comment === '<p>Following up</p>' && !st.sent, st.replied);

  // ── 6. REPLIES ARE RECEIVED ─────────────────────────────────────────────
  OUT.push('', '-- replies --');
  st.inbox = [
    { id: 'm1', conversationId: 'conv1', internetMessageId: '<r1@bakery.test>', subject: 'RE: Hi', from: { emailAddress: { address: 'Owner@Bakery.test', name: 'Owner' } }, toRecipients: [{ emailAddress: { address: 'agent@contoso.com' } }], body: { contentType: 'HTML', content: '<p>Yes</p>' }, bodyPreview: 'Yes', receivedDateTime: '2026-10-04T15:00:00Z', sentDateTime: '2026-10-04T14:59:58Z', isRead: false, isDraft: false },
    { id: 'm2', conversationId: 'conv1', subject: 'Hi', from: { emailAddress: { address: 'agent@contoso.com' } }, toRecipients: [], body: {}, receivedDateTime: '2026-10-04T14:00:00Z', sentDateTime: '2026-10-04T14:00:00Z', isDraft: false },
  ];
  const got = await O.fetchMessages('AT', 'RT', null, 50, { ownAddress: 'agent@contoso.com' });
  ok('a reply from the business is RECEIVED (it has a sentDateTime too, which used to make it "sent")', got.messages[0].direction === 'received' && got.messages[0].fromAddress === 'owner@bakery.test', got.messages[0]);
  ok('  our own message is SENT', got.messages[1].direction === 'sent');
  ok('  sync passes the mailbox\'s own address', /outlook\.fetchMessages\(access, refresh, account\.sync_cursor, 50, \{ ownAddress: account\.email_address \}\)/.test(fs.readFileSync(REPO + 'server/services/emailSync.js', 'utf8')));

  // ── 8. THE PREFLIGHT ────────────────────────────────────────────────────
  OUT.push('', '-- the preflight --');
  const PF = require(REPO + 'server/services/preflight.js');
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('ol-ath', $1, '{"name":"X"}'::jsonb) ON CONFLICT DO NOTHING`, [U]);
  st.tokenMode = 'refused';
  const bad = await PF.checks({ pool: P })['mailbox-tokens']().then(() => null, (e) => e);
  ok('a refused Outlook token: the check fails and names the agent and mailbox ("will not send")',
    bad && /will not send/.test(bad.message) && /Ana Agent \(agent@contoso\.com\): outlook refused the token: .*invalid_grant/.test(bad.message), bad && bad.message);
  ok('  and its consequence reads "will not send tonight"', /will not send tonight/.test(PF.CONSEQUENCE['mailbox-tokens']));
  st.tokenMode = 'ok';
  const good = await PF.checks({ pool: P })['mailbox-tokens']();
  const after = await P.query(`SELECT 1 FROM email_accounts WHERE id = $1`, [ol.id]);
  const rt = (await ES.getEmailAccountWithTokens(ol.id)).refreshToken;
  ok('  a good one passes, and the rotated refresh token from the check is stored', /1 mailbox\(es\) refreshed/.test(good) && after.rows.length && /^RT-rotated-/.test(rt), { good, rt });

  // ── 8b. THE ADMIN APPROVAL PATH ────────────────────────────────────────
  OUT.push('', '-- when the organization needs its admin --');
  ok('Microsoft\'s "needs admin approval" answers are recognised (AADSTS65001, 90094, consent_required)',
    O.isConsentError('access_denied', 'AADSTS90094: The grant requires admin permission.') && O.isConsentError('consent_required', '') && O.isConsentError('invalid_client', 'AADSTS65001: The user or administrator has not consented')
    && !O.isConsentError('access_denied', 'AADSTS65004: User declined to consent to access the app.'));
  const au = new URL(O.adminConsentUrl({}));
  ok('the admin link: Microsoft\'s admin consent endpoint on "organizations", our client id, the send scopes, our admin callback',
    au.origin + au.pathname === 'https://login.microsoftonline.com/organizations/v2.0/adminconsent' && au.searchParams.get('client_id') === 'test-client-id'
    && au.searchParams.get('scope') === 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read'
    && au.searchParams.get('redirect_uri') === 'https://mynildash.com/api/email/oauth/outlook/admin-callback', au.toString());
  const RR = fs.readFileSync(REPO + 'server/routes/email.js', 'utf8'), IX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('  the callback sends a consent error to the explanation screen, not a raw error',
    /if \(outlook\.isConsentError\(error, req\.query\.error_description\)\) \{\s*return res\.redirect\('\/microsoft-consent\.html'/.test(RR));
  ok('  the admin link and the admin\'s return are reachable without a NILDash login (the admin has none)',
    /'\/oauth\/outlook\/admin-link', '\/oauth\/outlook\/admin-callback'\]/.test(IX) && /router\.get\('\/oauth\/outlook\/admin-callback'/.test(RR));
  const PG = fs.readFileSync(REPO + 'public/microsoft-consent.html', 'utf8');
  ok('  the screen explains it in plain words, with the link to copy, email to the admin, and "Connect again"',
    /needs to approve NILDash/.test(PG) && /Copy link/.test(PG) && /Email it to my admin/.test(PG) && /Connect again/.test(PG) && /It cannot read, change or delete your email/.test(PG));
  ok('a send-only Outlook mailbox is not polled (no read permission); a read-enabled one is',
    /!require\('\.\/providers\/outlook'\)\.canReadFrom\(account\.granted_scopes\)\) return;/.test(fs.readFileSync(REPO + 'server/services/emailSync.js', 'utf8')));

  // ── 9. WIRED ────────────────────────────────────────────────────────────
  OUT.push('', '-- wired --');
  const R = fs.readFileSync(REPO + 'server/routes/email.js', 'utf8'), E = fs.readFileSync(REPO + 'public/email.js', 'utf8');
  ok('Settings shows Connect Outlook when the server is configured (/api/email/providers), not a hard-coded flag',
    /router\.get\('\/providers'/.test(R) && /fetch\('\/api\/email\/providers'/.test(E) && /let OUTLOOK_ENABLED = false;/.test(E));
  ok('the callback saves the granted scopes and refuses to claim sending without Mail.Send',
    /tokens\.grantedScopes, tokens\.canSend\s*\)/.test(R) && /emailScopeMissing=outlook/.test(R));
  ok('the old library is no longer used for tokens (it hid the refresh token)', !/require\('@azure\/msal-node'\)/.test(fs.readFileSync(REPO + 'server/services/providers/outlook.js', 'utf8')));

  global.fetch = realFetch;
  await P.query(`DELETE FROM athletes WHERE id = 'ol-ath'`).catch(() => {});
  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  global.fetch = realFetch;
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
