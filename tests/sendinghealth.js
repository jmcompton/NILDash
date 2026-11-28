'use strict';
// ── WHERE AN AGENT'S MAIL LANDS ─────────────────────────────────────────────
//
//   node tests/sendinghealth.js
//
// services/sendingHealth: the domain's records read into a verdict in plain
// words, and a test email from the agent's mailbox to OUR mailboxes, looked up
// to see inbox or junk. Nothing here ever goes to a business.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('sendinghealthtest', { schema: true });
process.env.ADMIN_EMAIL = 'founder@gmail.com';
const WAIT = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 800) : '')); } };

// A pretend DNS: { 'name': [txt...] }, mx: { domain: [exchange...] }.
const dns = (txtMap, mxMap) => ({
  resolveTxt: async (name) => { if (txtMap[name]) return txtMap[name].map((t) => [t]); const e = new Error('none'); e.code = 'ENODATA'; throw e; },
  resolveMx: async (d) => { if (mxMap[d]) return mxMap[d].map((x, i) => ({ exchange: x, priority: i })); const e = new Error('none'); e.code = 'ENODATA'; throw e; },
  resolveCname: async () => { const e = new Error('none'); e.code = 'ENODATA'; throw e; },
});
const KEY = 'v=DKIM1; k=rsa; p=' + 'A'.repeat(60);

(async () => {
  await new Promise((r) => setTimeout(r, WAIT));
  const P = require(REPO + 'server/store').pool;
  const SH = require(REPO + 'server/services/sendingHealth');

  console.log('-- the domain --');
  let r = await SH.check('dana@riverbendagency.com', { resolver: dns({
    'riverbendagency.com': ['v=spf1 include:zohomail.com ~all', 'google-site-verification=x'], '_dmarc.riverbendagency.com': ['v=DMARC1; p=quarantine'], 'zmail._domainkey.riverbendagency.com': [KEY] },
  { 'riverbendagency.com': ['mx.zoho.com', 'mx2.zoho.com'] }) });
  ok('all three records in place: good, and it knows the mailbox is on Zoho', r.level === 'good' && r.provider === 'Zoho Mail' && r.spf.coversProvider === true && r.dkim.selector === 'zmail' && r.dmarc.policy === 'quarantine' && r.fixes.length === 0 && /SPF, DKIM and DMARC are all in place/.test(r.summary), r);
  r = await SH.check('dana@riverbendagency.com', { resolver: dns({}, { 'riverbendagency.com': ['aspmx.l.google.com'] }) });
  ok('nothing published: a fix, with the exact record to add for their provider', r.level === 'fix' && r.provider === 'Google Workspace' && r.fixes.find((f) => f.what === 'SPF').do === 'Add a TXT record on riverbendagency.com: v=spf1 include:_spf.google.com ~all'
    && r.fixes.some((f) => f.what === 'DKIM') && /_dmarc\.riverbendagency\.com: v=DMARC1; p=none/.test(r.fixes.find((f) => f.what === 'DMARC').do) && /needs a fix before pitches go out: SPF/.test(r.summary), r);
  r = await SH.check('dana@riverbendagency.com', { resolver: dns({ 'riverbendagency.com': ['v=spf1 include:_spf.google.com ~all'], 'selector1._domainkey.riverbendagency.com': [KEY], '_dmarc.riverbendagency.com': ['v=DMARC1; p=none'] },
    { 'riverbendagency.com': ['riverbendagency-com.mail.protection.outlook.com'] }) });
  ok('SPF that leaves out the provider they actually send through: a fix that says which line to add', r.level === 'fix' && r.spf.coversProvider === false && /Add include:spf\.protection\.outlook\.com to the existing SPF record/.test(r.fixes[0].do), r.fixes);
  r = await SH.check('dana@riverbendagency.com', { resolver: dns({ 'riverbendagency.com': ['v=spf1 include:_spf.google.com ~all', 'v=spf1 a mx ~all'] }, { 'riverbendagency.com': ['aspmx.l.google.com'] }) });
  ok('two SPF records: a fix (both are ignored)', r.level === 'fix' && /has 2 SPF records/.test(r.fixes[0].say));
  r = await SH.check('dana@riverbendagency.com', { resolver: dns({ 'riverbendagency.com': ['v=spf1 include:_spf.google.com ~all'], 'google._domainkey.riverbendagency.com': [KEY] }, { 'riverbendagency.com': ['aspmx.l.google.com'] }) });
  ok('only DMARC missing: it can send, with a warning', r.level === 'warn' && r.fixes.length === 1 && r.fixes[0].what === 'DMARC' && /can send, but should add DMARC/.test(r.summary), r);
  r = await SH.check('someagent@gmail.com', { resolver: { resolveTxt: async () => { throw new Error('should not look'); }, resolveMx: async () => { throw new Error('should not look'); } } });
  ok('a gmail.com address has nothing to set up, and DNS is not asked', r.level === 'good' && r.free === true && /signs its own mail/.test(r.summary));
  r = await SH.check('dana@riverbendagency.com', { resolver: { resolveTxt: async () => { const e = new Error('timeout'); e.code = 'ETIMEOUT'; throw e; }, resolveMx: async () => { const e = new Error('timeout'); e.code = 'ETIMEOUT'; throw e; } } });
  ok('DNS that does not answer is "could not read", never a false alarm', r.level === 'unknown' && r.fixes.length === 0);

  console.log('-- the test send --');
  await P.query(`INSERT INTO users (id, email, name, password, role) VALUES ('ag1', 'dana@riverbendagency.com', 'Dana Whitfield', 'x', 'agent'), ('ag2', 'nomail@x.com', 'No Mailbox', 'x', 'agent')`);
  const ES = require(REPO + 'server/services/emailStore');
  await P.query(`INSERT INTO email_accounts (id, user_id, provider, email_address, status, can_send) VALUES ('ea1', 'ag1', 'gmail', 'dana@riverbendagency.com', 'active', TRUE)`).catch(async (e) => { console.log('  (email_accounts insert: ' + e.message + ')'); });
  ok('the agent has a mailbox on file for the test', !!ES.pickSendingAccount(await ES.getEmailAccountsByUser('ag1')));
  const m = SH.testEmail('Dana Whitfield');
  ok('the test email reads like a real first pitch: no link, no price, signed by first name', /quick conversation/.test(m.text) && /\nDana$/.test(m.text) && !/https?:|\$/.test(m.text) && /<p>Hi,<\/p>/.test(m.html));
  const wire = [];
  const seeds = [{ email: 'founder@comptongroup.test', kind: 'outlook' }, { email: 'founder@gmail.com', kind: 'gmail-manual' }];
  const send = async (x) => { wire.push(x); return {}; };
  ok('no mailbox: nothing to test, said plainly', (await SH.startTest(P, 'ag2', { seeds, send })).status === 400 && wire.length === 0);
  r = await SH.startTest(P, 'ag1', { seeds, send });
  ok('one email to each of OUR mailboxes, from the agent, each with its own id', r.ok && wire.length === 2 && wire.map((w) => w.to).join() === 'founder@comptongroup.test,founder@gmail.com' && wire.every((w) => w.agentId === 'ag1' && /^<placement\.[0-9a-f]{18}@/.test(w.messageId)) && wire[0].messageId !== wire[1].messageId, wire);
  ok('  a second click within ten minutes sends nothing', (await SH.startTest(P, 'ag1', { seeds, send })).status === 429 && wire.length === 2);
  const tests = async () => (await P.query(`SELECT * FROM placement_tests ORDER BY id`)).rows;
  let t = await tests();
  ok('  the Gmail one says to look, because NILDash cannot read Gmail; the Outlook one is waiting', t[1].result === 'look' && /open it and see whether this is in the inbox or in Spam/.test(t[1].detail) && t[0].result === null);
  const graphFor = (folderOfHit) => async (method, path) => {
    if (/mailFolders\/inbox/.test(path)) return { id: 'F-INBOX' };
    if (/mailFolders\/junkemail/.test(path)) return { id: 'F-JUNK' };
    if (/internetMessageId/.test(decodeURIComponent(path))) return { value: folderOfHit ? [{ id: 'm1', parentFolderId: folderOfHit }] : [] };
    throw new Error('unexpected ' + path);
  };
  ok('too soon to look: left alone', (await SH.settle(P, { mb: {}, graph: graphFor('F-INBOX'), minAgeMs: 60000 })) === 0 && (await tests())[0].result === null);
  ok('found in the inbox', (await SH.settle(P, { mb: {}, graph: graphFor('F-INBOX'), minAgeMs: 0 })) === 1 && (await tests())[0].result === 'inbox');
  const again = async (folder, ageMin) => { await P.query(`UPDATE placement_tests SET result = NULL, checked_at = NULL, sent_at = NOW() - ($1 || ' minutes')::interval WHERE id = $2`, [String(ageMin || 1), t[0].id]); await SH.settle(P, { mb: {}, graph: graphFor(folder), minAgeMs: 0 }); return (await tests())[0]; };
  ok('found in Junk: SPAM', (await again('F-JUNK')).result === 'spam' && /Junk/.test((await tests())[0].detail));
  ok('found somewhere else: a rule moved it', (await again('F-OTHER')).result === 'other');
  ok('not there yet: still waiting', (await again(null, 2)).result === null);
  ok('not there after twenty minutes: never arrived', (await again(null, 25)).result === 'missing');
  await P.query(`DELETE FROM placement_tests`);
  r = await SH.startTest(P, 'ag1', { seeds: [seeds[0]], send: async () => { throw new Error('535 Authentication failed'); } });
  ok('a mailbox that cannot send: the test says so with the reason', r.ok && r.sent[0].ok === false && (await tests())[0].result === 'failed' && /535/.test((await tests())[0].detail));

  console.log('-- what Client accounts shows --');
  const resolver = dns({ 'riverbendagency.com': ['v=spf1 include:_spf.google.com ~all'], 'google._domainkey.riverbendagency.com': [KEY] }, { 'riverbendagency.com': ['aspmx.l.google.com'] });
  const ov = await SH.overview(P, { resolver, mb: {}, graph: graphFor('F-INBOX'), minAgeMs: 0 });
  ok('an agent with a mailbox: the verdict, the fix and the last test; an agent without one is not listed', ov.ag1 && ov.ag1.level === 'warn' && ov.ag1.fixes[0].what === 'DMARC' && ov.ag1.tests.length === 1 && ov.ag1.tests[0].result === 'failed' && !ov.ag2, ov);
  let asked = 0;
  await SH.domainFor(P, 'ag1', { deps: { resolver: { resolveTxt: async () => { asked++; return []; }, resolveMx: async () => { asked++; return []; } } } });
  ok('the domain is read once a day, not on every page load', asked === 0);
  await SH.domainFor(P, 'ag1', { force: true, deps: { resolver } });
  ok('  unless he asks for it again', (await P.query(`SELECT level FROM sending_health WHERE agent_id = 'ag1'`)).rows[0].level === 'warn');

  console.log('-- admin only, and never to a business --');
  const SRC = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  const blk = SRC.slice(SRC.indexOf("// ── WHERE AN AGENT'S MAIL LANDS"), SRC.indexOf('// ── FOLLOW-UPS WAIT FOR THE FOUNDER'));
  ok('every route is the admin\'s alone', (blk.match(/app\.(get|post)\('\/api\/admin\/sending-health/g) || []).length === 3 && (blk.match(/requireAuth, gate\(/g) || []).length === 3 && /_realAdmin\(req\)\)\) return res\.status\(403\)/.test(blk));
  const code = fs.readFileSync(REPO + 'server/services/sendingHealth.js', 'utf8');
  ok('the test takes its recipients from our own mailboxes only: no address comes in from the request', !/req\.body|req\.query/.test(blk.replace(/req\.params\.agentId/g, '')) && /async function seeds\(pool\)/.test(code) && !/brand_contacts|outreach_queue|sent_to_email/.test(code));

  console.log(`\n${N - F}/${N} passed`);
  await P.end().catch(() => {});
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
