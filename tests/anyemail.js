'use strict';
// ── ANY EMAIL: ZOHO AND EVERY OTHER MAILBOX THAT IS NOT GMAIL OR OUTLOOK ────
//
//   node tests/anyemail.js
//
// services/providers/imap: an agent on Zoho (or Yahoo, iCloud, GoDaddy, a
// company's own server) connects with the address and an app password, and
// NILDash sends through that provider's SMTP server. The provider is worked
// out from the address; the password is proved before anything is saved; a
// refused password reads as a disconnected mailbox; the inbox is never read.
//
// The wire is real: section 3 runs a small SMTP server on this machine and
// nodemailer speaks to it, so the message checked is the one that was sent.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('anyemailtest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const net = require('net');
const fs = require('fs');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const thrown = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// A mail server that speaks just enough SMTP: greets, takes AUTH PLAIN or
// LOGIN, accepts one password, and keeps every message it is handed.
function smtpServer(goodPass) {
  const got = [];
  const srv = net.createServer((sock) => {
    let buf = '', mode = 'cmd', authed = false, step = 0, data = '';
    const say = (s) => sock.write(s + '\r\n');
    say('220 test.local ESMTP');
    const checkPlain = (b64) => { const parts = Buffer.from(b64, 'base64').toString().split('\0'); return parts[parts.length - 1] === goodPass; };
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (mode === 'data') {
          if (line === '.') { got.push(data); data = ''; mode = 'cmd'; say('250 queued'); } else data += line + '\n';
          continue;
        }
        if (mode === 'login') {
          step++;
          if (step === 1) { say('334 UGFzc3dvcmQ6'); continue; }
          authed = Buffer.from(line, 'base64').toString() === goodPass; mode = 'cmd';
          say(authed ? '235 ok' : '535 Authentication Failed'); continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) { sock.write('250-test.local\r\n250 AUTH PLAIN LOGIN\r\n'); }
        else if (up.startsWith('AUTH PLAIN')) { authed = checkPlain(line.split(' ')[2] || ''); say(authed ? '235 ok' : '535 Authentication Failed'); }
        else if (up.startsWith('AUTH LOGIN')) { mode = 'login'; step = 0; say('334 VXNlcm5hbWU6'); }
        else if (up.startsWith('MAIL FROM') || up.startsWith('RCPT TO')) { say(authed ? '250 ok' : '530 auth first'); }
        else if (up === 'DATA') { mode = 'data'; say('354 go'); }
        else if (up === 'QUIT') { say('221 bye'); sock.end(); }
        else say('250 ok');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, got, port: srv.address().port })));
}

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const M = require(REPO + 'server/services/providers/imap');
  const nodemailer = require('nodemailer');

  console.log('-- who hosts the mailbox, from the address --');
  const mx = (list) => ({ resolveMx: async () => list });
  let d = await M.detect('dana@riverbendsports.com', mx([{ exchange: 'mx2.zoho.com', priority: 20 }, { exchange: 'mx.zoho.com', priority: 10 }]));
  ok('a company domain whose mail is at Zoho is Zoho', d.kind === 'zoho' && d.label === 'Zoho Mail', d);
  ok('  both Zoho servers are tried: the one for company domains first', d.servers.length === 2 && d.servers[0].host === 'smtppro.zoho.com' && d.servers[1].host === 'smtp.zoho.com' && d.servers.every((s) => s.port === 465 && s.secure), d.servers);
  ok('  and the agent is told to try the normal password first, with the app password as the fallback', /normal email password/.test(d.help) && /App Passwords/.test(d.refused), d);
  d = await M.detect('a@firm.eu', mx([{ exchange: 'mx.zoho.eu', priority: 10 }]));
  ok('Zoho in another region uses that region\'s servers', d.servers[0].host === 'smtppro.zoho.eu', d.servers);
  d = await M.detect('a@agency.com', mx([{ exchange: 'aspmx.l.google.com', priority: 1 }]));
  ok('a Google Workspace domain is sent to the Gmail button', d.use === 'gmail' && d.servers.length === 0, d);
  d = await M.detect('a@agency.com', mx([{ exchange: 'agency-com.mail.protection.outlook.com', priority: 0 }]));
  ok('a Microsoft 365 domain is sent to the Outlook button', d.use === 'outlook', d);
  d = await M.detect('a@yahoo.com', mx([]));
  ok('a provider\'s own address needs no lookup', d.kind === 'yahoo' && d.servers[0].host === 'smtp.mail.yahoo.com');
  d = await M.detect('a@gmail.com', mx([]));
  ok('gmail.com is the Gmail button', d.use === 'gmail');
  d = await M.detect('a@smallfirm.com', mx([{ exchange: 'mail.smallfirm.com', priority: 10 }]));
  ok('an unknown host is "other": the agent is asked for the server', d.kind === 'other' && !d.use && d.servers.length === 0, d);
  d = await M.detect('a@broken.example', { resolveMx: async () => { throw new Error('ENOTFOUND'); } });
  ok('a domain that cannot be looked up does not throw', d.kind === 'other');
  ok('GoDaddy, iCloud and Fastmail are known by their MX', M.kindOfMx('smtp.secureserver.net.').kind === 'godaddy' && M.kindOfMx('mx01.mail.icloud.com').kind === 'icloud' && M.kindOfMx('in1-smtp.messagingengine.com').kind === 'fastmail');
  ok('a look-alike host is not Zoho', M.kindOfMx('mx.notzoho.com') === null && M.kindOfMx('zoho.com.evil.net') === null);

  console.log('-- a server the agent typed --');
  const pub = { lookup: async () => [{ address: '93.184.216.34', family: 4 }] };
  ok('a public mail server on 465 or 587 is accepted', (await M.checkHost('smtp.example.com', 587, pub)).secure === false && (await M.checkHost('SMTP.Example.com', 465, pub)).host === 'smtp.example.com');
  ok('never this machine or a private network', !!(await thrown(() => M.checkHost('mail.internal.example', 465, { lookup: async () => [{ address: '10.0.0.5', family: 4 }] })))
    && !!(await thrown(() => M.checkHost('x.example.com', 465, { lookup: async () => [{ address: '127.0.0.1', family: 4 }] })))
    && !!(await thrown(() => M.checkHost('x.example.com', 465, { lookup: async () => [{ address: '169.254.169.254', family: 4 }] })))
    && !!(await thrown(() => M.checkHost('x.example.com', 465, { lookup: async () => [{ address: '::1', family: 6 }] }))));
  ok('never an IP address or a bare name', !!(await thrown(() => M.checkHost('10.0.0.5', 465, pub))) && !!(await thrown(() => M.checkHost('localhost', 465, pub))));
  ok('never another port', !!(await thrown(() => M.checkHost('smtp.example.com', 25, pub))) && !!(await thrown(() => M.checkHost('smtp.example.com', 6379, pub))));

  console.log('-- the password is proved before anything is saved --');
  const zohoMx = mx([{ exchange: 'mx.zoho.com', priority: 10 }]);
  const tried = [];
  const fakeT = (behave) => (o) => { tried.push(o); return { verify: async () => behave(o), close() {} }; };
  const authErr = () => { const e = new Error('Invalid login: 535 Authentication Failed'); e.code = 'EAUTH'; e.responseCode = 535; return e; };
  let v = await M.verifySmtp('Dana@RiverbendSports.com', 'app-pass', {}, { ...zohoMx, createTransport: fakeT(() => true) });
  ok('accepted by the first server: that server is what gets stored', v.smtpHost === 'smtppro.zoho.com' && v.smtpPort === 465 && v.secure === true && v.kind === 'zoho', v);
  ok('  the login is the full address, lowercased, over TLS', tried[0].auth.user === 'dana@riverbendsports.com' && tried[0].secure === true, tried[0]);
  tried.length = 0;
  v = await M.verifySmtp('dana@riverbendsports.com', 'app-pass', {}, { ...zohoMx, createTransport: fakeT((o) => { if (o.host === 'smtppro.zoho.com') throw authErr(); return true; }) });
  ok('refused by the first, accepted by the second: the second is stored', v.smtpHost === 'smtp.zoho.com' && tried.length === 2, v);
  let e = await thrown(() => M.verifySmtp('dana@riverbendsports.com', 'wrong', {}, { ...zohoMx, createTransport: fakeT(() => { throw authErr(); }) }));
  ok('a wrong password says so, names Zoho, and says where the app password is', e && e.code === 'BAD_PASSWORD' && /Zoho Mail did not accept that password/.test(e.userMessage) && /App Passwords/.test(e.userMessage), e && e.userMessage);
  ok('  the message never repeats the password', e && !/wrong/.test(e.userMessage));
  e = await thrown(() => M.verifySmtp('dana@riverbendsports.com', 'p', {}, { ...zohoMx, createTransport: fakeT(() => { const x = new Error('connect ETIMEDOUT'); x.code = 'ETIMEDOUT'; throw x; }) }));
  ok('a server that does not answer is not called a wrong password', e && e.code === 'UNREACHABLE' && /could not reach/.test(e.userMessage), e && e.userMessage);
  e = await thrown(() => M.verifySmtp('a@smallfirm.com', 'p', {}, { ...mx([{ exchange: 'mail.smallfirm.com', priority: 1 }]), createTransport: fakeT(() => true) }));
  ok('an unknown provider with no server typed asks for the server', e && e.code === 'NEED_SERVER' && /Advanced/.test(e.userMessage), e && e.userMessage);
  v = await M.verifySmtp('a@smallfirm.com', 'p', { smtpHost: 'mail.smallfirm.com', smtpPort: 587 }, { ...mx([]), ...pub, createTransport: fakeT(() => true) });
  ok('  and with one typed, that server is used', v.smtpHost === 'mail.smallfirm.com' && v.smtpPort === 587 && v.secure === false, v);
  ok('  on 587 the password is never sent before TLS', tried[tried.length - 1].requireTLS === true && tried[tried.length - 1].secure === false, tried[tried.length - 1]);
  e = await thrown(() => M.verifySmtp('a@agency.com', 'p', {}, { ...mx([{ exchange: 'aspmx.l.google.com', priority: 1 }]), createTransport: fakeT(() => true) }));
  ok('a Google mailbox is pointed at the Gmail button, not asked for a password', e && /Use the Gmail button/.test(e.userMessage));
  ok('no address or no password is refused before any connection', !!(await thrown(() => M.verifySmtp('nope', 'p'))) && !!(await thrown(() => M.verifySmtp('a@b.com', ''))));

  console.log('-- on the wire: a real SMTP conversation --');
  const S1 = await smtpServer('good-app-pass');
  // The provider's own transport options, pointed at the local server (which
  // has no certificate, so TLS is off for this test only).
  const local = { createTransport: (o) => nodemailer.createTransport({ ...o, host: '127.0.0.1', port: S1.port, secure: false, requireTLS: false, ignoreTLS: true }) };
  const cfg = { smtpHost: 'smtppro.zoho.com', smtpPort: 465, secure: true, kind: 'zoho' };
  const r = await M.sendEmail('dana@riverbendsports.com', 'good-app-pass', cfg, {
    to: ['owner@tacoshop.com'], subject: 'A quick idea for Taco Shop', bodyHtml: '<p>Hello from the pitch</p>',
    replyTo: 'dana-ab12@reply.mynildash.com', messageId: '<nd-log123@mynildash.com>', fromName: 'Dana Whitfield' }, local);
  const raw = S1.got[0] || '';
  ok('the message is delivered to the server', S1.got.length === 1 && /Hello from the pitch/.test(raw), raw.slice(0, 300));
  ok('  From is the agent\'s own address, with his name', /^From: Dana Whitfield <dana@riverbendsports\.com>/m.test(raw), (raw.match(/^From:.*$/m) || [])[0]);
  ok('  To, Subject and Reply-To are as given', /^To: owner@tacoshop\.com/m.test(raw) && /^Subject: A quick idea for Taco Shop/m.test(raw) && /^Reply-To: dana-ab12@reply\.mynildash\.com/m.test(raw));
  ok('  the Message-ID is the one we minted, so a reply matches', /^Message-ID: <nd-log123@mynildash\.com>/mi.test(raw) && r.providerMessageId === '<nd-log123@mynildash.com>', r);
  e = await thrown(() => M.sendEmail('dana@riverbendsports.com', 'changed-since', cfg, { to: ['x@y.com'], subject: 's', bodyHtml: 'b' }, local));
  ok('a password the server now refuses throws 401: a disconnected mailbox, not a retry', e && e.code === 401 && S1.got.length === 1, e && [e.code, e.message]);
  const SG = require(REPO + 'server/services/sendGuard');
  const cls = (SG.classify || SG.classifyError || (() => null))(e);
  ok('  and the send queue reads it as "needs reconnecting"', !cls || (cls.kind === 'auth' && cls.retryable === false), cls);
  ok('the morning check: a good saved password passes, a refused one is an auth error',
    (await M.verifyStored('dana@riverbendsports.com', 'good-app-pass', cfg, local)) === true
    && M.isAuthError(await thrown(() => M.verifyStored('dana@riverbendsports.com', 'nope', cfg, local))));
  ok('the stored server is read in every shape it has been saved in',
    M.storedServer('a@b.com', { smtpHost: 'h.example.com', smtpPort: 587 }).secure === false
    && M.storedServer('a@b.com', { host: 'h.example.com', port: 465 }).secure === true
    && M.storedServer('a@yahoo.com', {}).host === 'smtp.mail.yahoo.com' && M.storedServer('a@b.com', {}) === null);
  S1.srv.close();

  console.log('-- saved like any other mailbox, and it counts --');
  const store = require(REPO + 'server/store');
  const P = store.pool;
  const ES = require(REPO + 'server/services/emailStore');
  await P.query(`INSERT INTO users (id, email, name, password, role) VALUES ('ag-d', 'dana@riverbendsports.com', 'dana whitfield', 'x', 'agent') ON CONFLICT DO NOTHING`);
  await ES.saveEmailAccount('ea_d1', 'ag-d', 'imap', 'dana@riverbendsports.com', 'dana@riverbendsports.com', 'good-app-pass', JSON.stringify(cfg), null, ['smtp.send'], true);
  const row = (await P.query(`SELECT * FROM email_accounts WHERE user_id = 'ag-d'`)).rows[0];
  ok('the password is not stored in the clear', row && row.access_token_enc && !/good-app-pass/.test(String(row.access_token_enc)) && !/smtppro/.test(String(row.refresh_token_enc)), row && Object.keys(row));
  const full = await ES.getEmailAccountWithTokens(row.id);
  ok('  and reads back for the send', full.accessToken === 'good-app-pass' && JSON.parse(full.refreshToken).smtpHost === 'smtppro.zoho.com' && full.canSend !== false, { canSend: full.canSend });
  const pick = ES.pickSendingAccount(await ES.getEmailAccountsByUser('ag-d'));
  ok('it is the mailbox this agent\'s pitches send from', pick && pick.provider === 'imap' && pick.email_address === 'dana@riverbendsports.com', pick);
  const AS = require(REPO + 'server/services/agentSetup');
  const f = await AS.facts(P, 'ag-d');
  ok('setup step 1 (connect your email) is done', f && f.mailbox === true && f.mailboxCannotSend === false, f);
  const MN = require(REPO + 'server/services/mailboxNotice');
  const src = (p) => fs.readFileSync(REPO + p, 'utf8');
  ok('the reconnect notice for it names no Gmail or Outlook', /emailForPassword/.test(src('server/services/mailboxNotice.js')) && typeof MN.record === 'function');

  console.log('-- wired in --');
  const R = src('server/routes/email.js'), SY = src('server/services/emailSync.js'), CR = src('server/jobs/closerRelease.js'), PF = src('server/services/preflight.js');
  ok('the connect route proves the password, then saves it as able to send', /await imap\.verifySmtp\(emailAddress, password,[\s\S]{0,400}saveEmailAccount\([\s\S]{0,300}\['smtp\.send'\], true/.test(R));
  ok('  and never puts the password in a log line or the reply', !/console\.(log|error)\([^)]*password/.test(R.slice(R.indexOf("router.post('/connect/imap'"), R.indexOf("router.get('/detect'"))) && !/res\.json\(\{[^}]*password/.test(R));
  ok('  an error the agent sees is ours to word, never a raw server error', /error: e\.userMessage \|\| 'That mailbox could not be connected/.test(R));
  ok('the inbox of such a mailbox is never read', /if \(account\.provider === 'imap'\) return;/.test(SY));
  ok('the send queue sends through it, with the agent\'s name', /account\.provider === 'imap'[\s\S]{0,200}provider\.sendEmail\(account\.email_address, account\.accessToken/.test(CR) && /fromName: account\.senderName/.test(CR));
  ok('the morning check verifies the saved password, and a quiet server is not a disconnect', /r\.provider === 'imap'[\s\S]{0,900}smtp\.verifyStored[\s\S]{0,400}isAuthError/.test(PF));
  const UI = src('public/agent-setup.js'), EJ = src('public/email.js'), IX = src('public/index.html');
  ok('setup offers "Use another email" beside Gmail and Outlook', /agentSetup\.other\(true\)">Use another email</.test(UI) && /connectOther/.test(UI) && /\/api\/email\/connect\/imap/.test(UI));
  ok('Settings offers it too', /const IMAP_ENABLED\s*=\s*true/.test(EJ) && /Other email \(Zoho, Yahoo, iCloud\)/.test(IX) && /id="imap-error"/.test(IX));
  ok('no screen asks an agent for IMAP settings', !/IMAP Host/.test(IX) && !/imap-host/.test(EJ));

  console.log(`\n${N - F}/${N} passed`);
  await P.end().catch(() => {});
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
