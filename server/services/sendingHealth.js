'use strict';
// ── WHERE DOES AN AGENT'S MAIL LAND ─────────────────────────────────────────
//
// 182 businesses pitched, 3 replies, and nothing that says whether the other
// 179 read it and passed or never saw it. Pitches leave from each agent's own
// mailbox, so it is the agent's domain that decides inbox or junk. Two checks,
// both per agent, both without touching anything a business receives:
//
// 1. THE DOMAIN (check). Three public records tell Gmail and Outlook the mail
//    is real: SPF (who may send for this domain), DKIM (a signature), DMARC
//    (what to do with mail that fails). Read from DNS, no access needed.
//    Verdict: good / warn / fix, each with what to do in plain words.
//
// 2. A TEST SEND (startTest, settle). One email, written like a real pitch,
//    from the agent's mailbox to mailboxes that are OURS: the admin Outlook
//    mailbox (which NILDash can read, so it looks up where the test landed:
//    inbox or junk) and the admin's Gmail (NILDash holds no read access to
//    any Gmail, so that one says "look in your Gmail"). Never to a business.
//
// Admin only. Results are kept in sending_health (the domain, one row per
// agent) and placement_tests (each test email).
const dnsP = require('dns').promises;
const crypto = require('crypto');

const FREE = /^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|aol|icloud|me|mac|proton|protonmail|pm|zohomail)\.[a-z.]+$/i;
const PROVIDERS = [
  { key: 'google', name: 'Google Workspace', mx: /google(mail)?\.com\.?$|googlemail\.com\.?$/i, spf: /_spf\.google\.com/i, selectors: ['google'], spfAdd: 'include:_spf.google.com' },
  { key: 'microsoft', name: 'Microsoft 365', mx: /protection\.outlook\.com\.?$|outlook\.com\.?$/i, spf: /spf\.protection\.outlook\.com/i, selectors: ['selector1', 'selector2'], spfAdd: 'include:spf.protection.outlook.com' },
  { key: 'zoho', name: 'Zoho Mail', mx: /zoho\.(com|eu|in|com\.au|jp)\.?$/i, spf: /zoho(mail)?\.(com|eu|in|com\.au|jp)|zohomail/i, selectors: ['zmail', 'zoho', 'default'], spfAdd: 'include:zohomail.com' },
  { key: 'godaddy', name: 'GoDaddy email', mx: /secureserver\.net\.?$/i, spf: /secureserver\.net/i, selectors: ['default', 's1', 's2'], spfAdd: 'include:secureserver.net' },
];
const COMMON_SELECTORS = ['default', 'selector1', 'selector2', 'google', 'k1', 's1', 's2', 'mail', 'dkim', 'smtp', 'zmail'];

const domainOf = (email) => String(email || '').trim().toLowerCase().split('@')[1] || '';

async function txt(resolver, name) {
  try { return (await resolver.resolveTxt(name)).map((parts) => parts.join('')); }
  catch (e) { if (['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ESERVFAIL'].includes(e.code)) return []; throw e; }
}

// -> { domain, level: 'good'|'warn'|'fix'|'unknown', summary, provider, spf, dkim, dmarc, fixes: [..] }
async function check(email, deps = {}) {
  const resolver = deps.resolver || dnsP;
  const domain = domainOf(email);
  if (!domain) return { domain: '', level: 'unknown', summary: 'No address to check.', fixes: [] };
  if (FREE.test(domain)) {
    return { domain, level: 'good', free: true, provider: domain, summary: `Sent through ${domain} itself, which signs its own mail. Nothing to set up.`, fixes: [] };
  }
  let mx = [], spfRecs = [], dmarcRecs = [];
  try {
    mx = await resolver.resolveMx(domain).catch((e) => { if (['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(e.code)) return []; throw e; });
    spfRecs = (await txt(resolver, domain)).filter((t) => /^v=spf1\b/i.test(t.trim()));
    dmarcRecs = (await txt(resolver, '_dmarc.' + domain)).filter((t) => /^v=DMARC1\b/i.test(t.trim()));
  } catch (e) {
    return { domain, level: 'unknown', summary: `Could not read the records for ${domain} just now. Try again.`, fixes: [], error: String(e.code || e.message) };
  }
  const prov = PROVIDERS.find((p) => mx.some((m) => p.mx.test(m.exchange || ''))) || null;
  const fixes = [];

  const spf = { found: spfRecs.length > 0, record: spfRecs[0] || null, count: spfRecs.length, coversProvider: null };
  if (!spf.found) fixes.push({ level: 'fix', what: 'SPF', say: `${domain} has no SPF record, so Gmail and Outlook cannot tell its mail is real and often send it to spam.`,
    do: `Add a TXT record on ${domain}: v=spf1 ${prov ? prov.spfAdd : 'include:<your email provider>'} ~all` });
  else if (spf.count > 1) fixes.push({ level: 'fix', what: 'SPF', say: `${domain} has ${spf.count} SPF records. There may be only one, or all of them are ignored.`, do: 'Merge them into one TXT record that starts with v=spf1.' });
  else if (prov) {
    spf.coversProvider = prov.spf.test(spf.record);
    if (!spf.coversProvider) fixes.push({ level: 'fix', what: 'SPF', say: `The SPF record on ${domain} does not list ${prov.name}, which is what this mailbox sends through.`, do: `Add ${prov.spfAdd} to the existing SPF record.` });
  }

  const selectors = [...new Set([...(prov ? prov.selectors : []), ...COMMON_SELECTORS])];
  const dkim = { found: false, selector: null };
  for (const s of selectors) {
    let recs = [];
    try { recs = await txt(resolver, `${s}._domainkey.${domain}`); } catch (_) { recs = []; }
    if (recs.some((t) => /p=[A-Za-z0-9+/]{20,}/.test(t.replace(/\s+/g, '')))) { dkim.found = true; dkim.selector = s; break; }
    if (!recs.length && resolver.resolveCname) {
      try { const c = await resolver.resolveCname(`${s}._domainkey.${domain}`); if (c && c.length) { dkim.found = true; dkim.selector = s; break; } } catch (_) { /* none */ }
    }
  }
  if (!dkim.found) fixes.push({ level: 'warn', what: 'DKIM', say: `No DKIM signature was found for ${domain} at the usual names. It may be set under a name we did not try.`,
    do: `In ${prov ? prov.name : 'the email provider'}'s admin settings, turn on DKIM for ${domain} and add the record it gives you.` });

  const dmarc = { found: dmarcRecs.length > 0, record: dmarcRecs[0] || null, policy: null };
  if (dmarc.found) dmarc.policy = ((/\bp\s*=\s*(none|quarantine|reject)/i.exec(dmarc.record) || [])[1] || '').toLowerCase() || null;
  else fixes.push({ level: 'warn', what: 'DMARC', say: `${domain} has no DMARC record. Gmail and Yahoo now expect one from anyone sending regularly.`,
    do: `Add a TXT record named _dmarc.${domain}: v=DMARC1; p=none; rua=mailto:postmaster@${domain}` });

  const level = fixes.some((f) => f.level === 'fix') ? 'fix' : fixes.length ? 'warn' : 'good';
  const summary = level === 'good' ? `${domain} is set up to reach the inbox: SPF, DKIM and DMARC are all in place.`
    : level === 'fix' ? `${domain} needs a fix before pitches go out: ${fixes.filter((f) => f.level === 'fix').map((f) => f.what).join(' and ')}.`
      : `${domain} can send, but should add ${fixes.map((f) => f.what).join(' and ')}.`;
  return { domain, level, summary, provider: prov ? prov.name : null, spf, dkim, dmarc, fixes };
}

// ── KEPT ────────────────────────────────────────────────────────────────────
let _ready = false;
async function ensureTables(pool) {
  if (_ready) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS sending_health (
    agent_id TEXT PRIMARY KEY, email TEXT, domain TEXT, level TEXT, result JSONB, checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS placement_tests (
    id BIGSERIAL PRIMARY KEY, agent_id TEXT NOT NULL, from_email TEXT NOT NULL, seed_email TEXT NOT NULL, seed_kind TEXT NOT NULL,
    message_id TEXT, subject TEXT, sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), result TEXT, detail TEXT, checked_at TIMESTAMPTZ)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS placement_tests_agent ON placement_tests (agent_id, sent_at DESC)`);
  _ready = true;
}

async function mailboxOf(pool, agentId) {
  const ES = require('./emailStore');
  const acct = ES.pickSendingAccount(await ES.getEmailAccountsByUser(agentId));
  return acct || null;
}

const FRESH_MS = 24 * 3600 * 1000;
async function domainFor(pool, agentId, { force, deps } = {}) {
  await ensureTables(pool);
  const acct = await mailboxOf(pool, agentId);
  if (!acct) return null;
  const email = String(acct.email_address || '').toLowerCase();
  const kept = (await pool.query(`SELECT email, result, checked_at FROM sending_health WHERE agent_id = $1`, [agentId])).rows[0];
  if (!force && kept && kept.email === email && Date.now() - new Date(kept.checked_at).getTime() < FRESH_MS && kept.result && kept.result.level !== 'unknown') return { ...kept.result, email, checkedAt: kept.checked_at };
  const r = await check(email, deps);
  await pool.query(`INSERT INTO sending_health (agent_id, email, domain, level, result, checked_at) VALUES ($1,$2,$3,$4,$5,NOW())
    ON CONFLICT (agent_id) DO UPDATE SET email = EXCLUDED.email, domain = EXCLUDED.domain, level = EXCLUDED.level, result = EXCLUDED.result, checked_at = NOW()`,
  [agentId, email, r.domain, r.level, JSON.stringify(r)]);
  return { ...r, email, checkedAt: new Date() };
}

// ── THE TEST SEND ───────────────────────────────────────────────────────────
// Where the test goes: mailboxes that are ours. Never anyone else's.
async function seeds(pool) {
  const out = [];
  try {
    const mb = await require('./salesMailbox').account(pool);
    if (mb && mb.ok && mb.canRead) out.push({ email: mb.address, kind: 'outlook', mb });
  } catch (e) { console.error('[sendingHealth] outlook seed:', e.message); }
  const admin = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (admin && /@(gmail|googlemail)\.com$/.test(admin) && !out.some((s) => s.email === admin)) out.push({ email: admin, kind: 'gmail-manual' });
  return out;
}

// Written like a real first pitch, so the test says something about real ones.
function testEmail(fromName) {
  const first = String(fromName || '').trim().split(/\s+/)[0] || '';
  const text = ['Hi,', '',
    'I represent a college athlete who plays close to you, and a lot of the people who follow them live and shop nearby.',
    'I think there is a simple way for them to bring you customers: a couple of posts and a visit, nothing complicated.', '',
    'Would you be open to a quick conversation about it?', '', first].filter((l, i, a) => !(i === a.length - 1 && !l)).join('\n');
  return { subject: 'A quick idea for your business', text,
    html: text.split(/\n\n/).map((p) => '<p>' + p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>') + '</p>').join('') };
}

async function sendFrom(pool, agentId, to, msg, messageId, deps = {}) {
  if (deps.send) return deps.send({ agentId, to, msg, messageId });
  const CR = require('../jobs/closerRelease');
  const account = await CR.senderFor(pool, agentId, new Map());
  if (!account) throw new Error('no mailbox is connected');
  const provider = CR.providerFor(account);
  const args = { to: [to], subject: msg.subject, bodyHtml: msg.html, attachments: [], messageId, fromName: account.senderName || null };
  return account.provider === 'imap'
    ? provider.sendEmail(account.email_address, account.accessToken, account.refreshToken ? JSON.parse(account.refreshToken) : {}, args)
    : provider.sendEmail(account.accessToken, account.refreshToken, args);
}

// One test: one email to each of our mailboxes. At most one test per agent
// every ten minutes, so a double click is not two emails.
async function startTest(pool, agentId, deps = {}) {
  await ensureTables(pool);
  const acct = await mailboxOf(pool, agentId);
  if (!acct) return { ok: false, status: 400, error: 'This agent has no mailbox connected, so there is nothing to test yet.' };
  const recent = (await pool.query(`SELECT 1 FROM placement_tests WHERE agent_id = $1 AND sent_at > NOW() - INTERVAL '10 minutes' LIMIT 1`, [agentId])).rows[0];
  if (recent && !deps.force) return { ok: false, status: 429, error: 'A test went out in the last ten minutes. Give it a minute and look at the result.' };
  const list = deps.seeds || await seeds(pool);
  if (!list.length) return { ok: false, status: 400, error: 'There is no mailbox of ours to send the test to. Connect the admin Outlook mailbox first.' };
  const u = (await pool.query(`SELECT name FROM users WHERE id = $1`, [agentId])).rows[0] || {};
  const msg = testEmail(u.name);
  const sent = [];
  for (const s of list) {
    const messageId = `<placement.${crypto.randomBytes(9).toString('hex')}@${process.env.REPLY_DOMAIN || 'mynildash.com'}>`;
    let res = null, err = null;
    try { res = await sendFrom(pool, agentId, s.email, msg, messageId, deps); } catch (e) { err = e; }
    const usedId = err ? null : (res && res.messageIdUnknown ? null : ((res && res.messageId) || messageId));
    await pool.query(`INSERT INTO placement_tests (agent_id, from_email, seed_email, seed_kind, message_id, subject, result, detail, checked_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [agentId, String(acct.email_address).toLowerCase(), s.email, s.kind, usedId, msg.subject,
      err ? 'failed' : s.kind === 'gmail-manual' ? 'look' : null,
      err ? String(err.message).slice(0, 300) : s.kind === 'gmail-manual' ? `Sent to ${s.email}. NILDash cannot read Gmail, so open it and see whether this is in the inbox or in Spam.` : null,
      err || s.kind === 'gmail-manual' ? new Date() : null]);
    sent.push({ to: s.email, ok: !err, error: err ? String(err.message).slice(0, 200) : null });
  }
  return { ok: true, sent };
}

// Where did it land. Looks the test up in our Outlook mailbox by its
// Message-ID (or, when the provider would not say which id shipped, by subject
// and sender). Called a minute after a test and again on each read.
const GIVE_UP_MS = 20 * 60 * 1000;
async function settle(pool, deps = {}) {
  await ensureTables(pool);
  const rows = (await pool.query(`SELECT * FROM placement_tests WHERE result IS NULL AND seed_kind = 'outlook' ORDER BY sent_at LIMIT 20`)).rows;
  if (!rows.length) return 0;
  const MB = require('./salesMailbox');
  const mb = deps.mb || await MB.account(pool);
  const graph = (path) => (deps.graph ? deps.graph('GET', path) : MB.graph(mb, 'GET', path));
  let folders = null, done = 0;
  for (const r of rows) {
    const age = Date.now() - new Date(r.sent_at).getTime();
    if (age < (deps.minAgeMs == null ? 45000 : deps.minAgeMs)) continue;
    let result = null, detail = null;
    try {
      if (!folders) {
        const [inbox, junk] = await Promise.all([graph('/me/mailFolders/inbox?$select=id'), graph('/me/mailFolders/junkemail?$select=id')]);
        folders = { inbox: inbox.id, junk: junk.id };
      }
      const q = r.message_id
        ? `/me/messages?$filter=${encodeURIComponent(`internetMessageId eq '${String(r.message_id).replace(/'/g, "''")}'`)}&$select=id,parentFolderId&$top=1`
        : `/me/messages?$filter=${encodeURIComponent(`from/emailAddress/address eq '${r.from_email}' and receivedDateTime ge ${new Date(new Date(r.sent_at).getTime() - 60000).toISOString()}`)}&$select=id,parentFolderId,subject&$top=5`;
      const hit = ((await graph(q)).value || []).find((m) => r.message_id || m.subject === r.subject);
      if (hit) {
        result = hit.parentFolderId === folders.inbox ? 'inbox' : hit.parentFolderId === folders.junk ? 'spam' : 'other';
        detail = result === 'inbox' ? 'Landed in the inbox.' : result === 'spam' ? 'Landed in Junk.' : 'Arrived, but a mailbox rule moved it to another folder.';
      } else if (age > GIVE_UP_MS) { result = 'missing'; detail = 'Never arrived after twenty minutes. It was dropped or held before the mailbox.'; }
    } catch (e) {
      if (age > GIVE_UP_MS) { result = 'unknown'; detail = 'Could not read our mailbox to look: ' + String(e.message).slice(0, 160); }
    }
    if (result) { await pool.query(`UPDATE placement_tests SET result = $2, detail = $3, checked_at = NOW() WHERE id = $1`, [r.id, result, detail]); done++; }
  }
  return done;
}

// For the Client accounts list: every agent with a mailbox, the domain's
// verdict and the last test.
async function overview(pool, deps = {}) {
  await ensureTables(pool);
  await settle(pool, deps).catch((e) => console.error('[sendingHealth] settle:', e.message));
  const agents = (await pool.query(`SELECT DISTINCT ea.user_id AS id FROM email_accounts ea WHERE COALESCE(ea.status, 'active') <> 'disconnected'`).catch(() => ({ rows: [] }))).rows;
  const out = {};
  for (const a of agents) {
    let dom = null;
    try { dom = await domainFor(pool, a.id, { deps }); } catch (e) { console.error('[sendingHealth] domain:', e.message); }
    if (!dom) continue;
    const tests = (await pool.query(`SELECT seed_email, seed_kind, result, detail, sent_at FROM placement_tests
      WHERE agent_id = $1 AND sent_at >= (SELECT MAX(sent_at) - INTERVAL '2 minutes' FROM placement_tests WHERE agent_id = $1) ORDER BY id`, [a.id])).rows;
    out[a.id] = { email: dom.email, level: dom.level, summary: dom.summary, fixes: dom.fixes || [], provider: dom.provider || null,
      tests: tests.map((t) => ({ to: t.seed_email, result: t.result || 'pending', detail: t.detail || 'Sent. Looking for it now.', at: t.sent_at })) };
  }
  return out;
}

module.exports = { check, domainFor, seeds, startTest, settle, overview, testEmail, ensureTables, domainOf, PROVIDERS };
