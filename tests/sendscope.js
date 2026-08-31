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

// ── A MAILBOX THAT CANNOT SEND MUST NOT LOOK LIKE ONE THAT CAN ──────────────
//
// gmail.send is a SENSITIVE scope with its own checkbox on Google's consent
// screen. Untick it and the OAuth exchange succeeds, the account saves, Calendar
// works -- and the first anyone hears of it is "Request had insufficient
// authentication scopes", raw from Google, after an agent has written a pitch to
// a real business. This is a send-path suite: getting it wrong either sends
// nothing when it should, or claims it can send when it cannot.
//
// THE THREE STATES ARE THE WHOLE SUITE. true / false / null, where null means
// "we never asked" -- every account connected before granted_scopes existed. If
// null is ever treated as false, the deploy that adds the column empties the
// From picker for the entire roster. That is asserted here, repeatedly, on
// purpose.

const fs = require('fs');
const ROOT = REPO;
const store = require(ROOT + 'server/store');
const emailStore = require(ROOT + 'server/services/emailStore');
const gmail = require(ROOT + 'server/services/providers/gmail');
const sendGuard = require(ROOT + 'server/services/sendGuard');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};
const AG = 'scope-agent';
const SEND = 'https://www.googleapis.com/auth/gmail.send';
const CAL  = 'https://www.googleapis.com/auth/calendar.events';
const MAIL = 'https://www.googleapis.com/auth/userinfo.email';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM email_accounts WHERE user_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role)
                 VALUES ($1,'Scope Tester','scope@x.com','x','agent') ON CONFLICT DO NOTHING`, [AG]);

  // ── PIECE 1: THE COLUMNS EXIST, VIA THE NORMAL INIT PATH ─────────────────
  // email_verify_credit_log was created outside store.js's init, to_regclass
  // returned NULL in production for weeks, and the read failure presented as a
  // spent month. The lesson is asserted, not remembered.
  const cols = (await P.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name='email_accounts' AND column_name IN ('granted_scopes','can_send','scopes_checked_at')`
  )).rows;
  ok('granted_scopes / can_send / scopes_checked_at all exist', cols.length === 3, cols);
  ok('  granted_scopes is an array, not a joined string',
    (cols.find((c) => c.column_name === 'granted_scopes') || {}).data_type === 'ARRAY', cols);
  const initSrc = fs.readFileSync(ROOT + 'server/store.js', 'utf8');
  const noComments = initSrc.split('\n').filter((l) => !/^\s*(\/\/|--)/.test(l)).join('\n');
  ok('  and they are added in store.js, not in a side script',
    /ADD COLUMN IF NOT EXISTS granted_scopes/.test(noComments), null);

  // ── THE SCOPE PARSER ─────────────────────────────────────────────────────
  ok('Google\'s space-joined scope string parses to a list',
    JSON.stringify(gmail.parseGrantedScopes({ scope: SEND + ' ' + CAL })) === JSON.stringify([SEND, CAL]));
  ok('  a missing scope field is null, meaning UNKNOWN',
    gmail.parseGrantedScopes({}) === null && gmail.parseGrantedScopes({ scope: '' }) === null);
  ok('hasSendScope is true when the send scope is granted',
    gmail.hasSendScope([SEND, CAL, MAIL]) === true);
  ok('  false when it was withheld', gmail.hasSendScope([CAL, MAIL]) === false);
  ok('  and NULL, not false, when we never looked',
    gmail.hasSendScope(null) === null && gmail.hasSendScope(undefined) === null);

  // ── SENDABILITY: THE ONE DEFINITION BOTH READERS USE ─────────────────────
  ok('sendability reads a stored true', emailStore.sendability({ can_send: true }) === true);
  ok('  a stored false', emailStore.sendability({ can_send: false }) === false);
  ok('  derives from granted_scopes when can_send was never set',
    emailStore.sendability({ can_send: null, granted_scopes: [SEND, CAL] }) === true
      && emailStore.sendability({ can_send: null, granted_scopes: [CAL] }) === false);
  ok('  AND RETURNS NULL WHEN THERE IS NOTHING TO READ',
    emailStore.sendability({ can_send: null, granted_scopes: null }) === null,
    emailStore.sendability({ can_send: null, granted_scopes: null }));
  ok('only a known false blocks — unknown is not a refusal',
    emailStore.knownCannotSend({ can_send: false }) === true
      && emailStore.knownCannotSend({ can_send: null, granted_scopes: null }) === false
      && emailStore.knownCannotSend({ can_send: true }) === false);

  // ── WHAT THE CALLBACK STORES ─────────────────────────────────────────────
  const good = await emailStore.saveEmailAccount('ea_scope_good', AG, 'gmail',
    'good@gmail.com', 'Good', 'at', 'rt', null, [SEND, CAL, MAIL], true);
  const bad = await emailStore.saveEmailAccount('ea_scope_bad', AG, 'gmail',
    'bad@gmail.com', 'Bad', 'at', 'rt', null, [CAL, MAIL], false);
  ok('a full grant saves as sendable', good.canSend === true, good.canSend);
  ok('A GRANT WITHOUT gmail.send SAVES AS NON-SENDING', bad.canSend === false, bad.canSend);
  ok('  the account is still SAVED, so Calendar is not taken away too',
    !!bad && bad.status === 'active', bad);
  ok('  and what Google actually granted is on the row, not just a boolean',
    Array.isArray(bad.granted_scopes) && bad.granted_scopes.includes(CAL)
      && !bad.granted_scopes.includes(SEND), bad.granted_scopes);
  ok('  stamped with when we looked', !!bad.scopes_checked_at, bad.scopes_checked_at);

  // A caller with no scope information must leave the row UNKNOWN rather than
  // guessing either way -- IMAP goes through this same function.
  const unk = await emailStore.saveEmailAccount('ea_scope_unk', AG, 'imap',
    'unknown@example.org', 'Unknown', 'pw', '{}', null);
  ok('a caller that knows nothing writes UNKNOWN, not false',
    unk.canSend === null && unk.granted_scopes === null, unk);
  ok('  and leaves no checked-at stamp, because nothing was checked',
    unk.scopes_checked_at === null, unk.scopes_checked_at);

  // ── RECONNECTING MUST BE ABLE TO CLEAR A BAD ANSWER ──────────────────────
  // COALESCE(EXCLUDED, existing) on the upsert would pin the false forever.
  const fixed = await emailStore.saveEmailAccount('ea_scope_bad2', AG, 'gmail',
    'bad@gmail.com', 'Bad', 'at2', 'rt2', null, [SEND, CAL, MAIL], true);
  ok('RECONNECTING WITH THE BOX TICKED CLEARS THE BLOCK',
    fixed.canSend === true, fixed.canSend);
  const stillOne = (await P.query(
    `SELECT COUNT(*)::int AS n FROM email_accounts WHERE user_id=$1 AND email_address='bad@gmail.com'`,
    [AG])).rows[0].n;
  ok('  without leaving a second row for the same mailbox', stillOne === 1, stillOne);

  // ── THE AUDIT WRITE-BACK ─────────────────────────────────────────────────
  await emailStore.recordGrantedScopes('ea_scope_unk', [CAL, MAIL], false);
  const audited = await emailStore.getEmailAccount('ea_scope_unk');
  ok('the audit turns an unknown row into a fact',
    audited.canSend === false && audited.scopes_checked_at !== null, audited);

  // ── THE ERROR CLASSIFIER ─────────────────────────────────────────────────
  // Google's real shape for this failure.
  const scopeErr = Object.assign(new Error('Request had insufficient authentication scopes.'),
    { code: 403, errors: [{ reason: 'insufficientPermissions' }] });
  const c = sendGuard.classifyError(scopeErr);
  ok('AN UNGRANTED SCOPE IS ITS OWN KIND, NOT A GENERIC AUTH FAILURE',
    c.kind === 'scope', c);
  ok('  it is not retried, because retrying cannot grant a scope', c.retryable === false, c);
  ok('  and the wording names the checkbox the agent has to tick',
    /Send email on your behalf/.test(c.detail), c.detail);
  ok('  a REVOKED token still classifies as auth, not scope',
    sendGuard.classifyError(Object.assign(new Error('invalid_grant'), { code: 401 })).kind === 'auth');
  ok('  and a quota 403 is still quota — order in classifyError matters',
    sendGuard.classifyError(Object.assign(new Error('Daily Limit Exceeded'), { code: 403 })).kind === 'quota');
  ok('  a 429 is still a retryable rate limit',
    sendGuard.classifyError(Object.assign(new Error('rateLimitExceeded'), { code: 429 })).retryable === true);

  // ── THE SEND PATH REFUSES BEFORE GOOGLE DOES ─────────────────────────────
  const outSrc = fs.readFileSync(ROOT + 'server/routes/outreach.js', 'utf8');
  const outNoComments = outSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('sendViaEmailService checks sendability before building the message',
    /knownCannotSend\(account\)/.test(outNoComments), null);
  ok('  the refusal happens BEFORE the provider is called',
    outNoComments.indexOf('knownCannotSend(account)') < outNoComments.indexOf('gmail.sendEmail'), null);
  ok('  and the manual send endpoint no longer returns Google\'s raw words',
    !/res\.status\(500\)\.json\(\{ error: e\.message \}\);\s*\n\s*\}\);\s*\n\s*\n\s*\/\*\*\s*\n\s*\* PATCH/.test(outNoComments)
      && /sendGuard\.classifyError\(e\)/.test(outNoComments), null);

  // ── THE PICKER ───────────────────────────────────────────────────────────
  const oe = fs.readFileSync(ROOT + 'public/outreach-engine.js', 'utf8');
  const oeNoComments = oe.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok('THE FROM PICKER DROPS A MAILBOX THAT IS KNOWN NOT TO SEND',
    /accounts\.filter\(a => a\.canSend !== false\)/.test(oeNoComments), null);
  ok('  IT KEEPS THE UNKNOWN ONES: `!== false`, never `=== true`',
    !/filter\(a => a\.canSend === true\)/.test(oeNoComments), null);
  ok('  a scope-blocked mailbox gets its own message, not "connect a mailbox"',
    /renderFromSlotScopeMissing/.test(oeNoComments)
      && /Send email on your behalf/.test(oe), null);
  ok('  and the pre-draft notice distinguishes it from having no mailbox at all',
    /updateMailboxNotice\('scope'\)/.test(oeNoComments), null);
  ok('the accounts endpoint hands the client a derived canSend',
    /safe\.canSend = sendability\(row\)/.test(
      fs.readFileSync(ROOT + 'server/services/emailStore.js', 'utf8')), null);

  // ── THE CALLBACK ─────────────────────────────────────────────────────────
  const cb = fs.readFileSync(ROOT + 'server/routes/email.js', 'utf8');
  const cbNoComments = cb.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  ok('the gmail callback passes the granted scopes through to storage',
    /tokens\.grantedScopes, tokens\.canSend/.test(cbNoComments), null);
  ok('  a scope-less connection redirects as its own outcome, not as success',
    /emailScopeMissing=gmail/.test(cbNoComments), null);
  ok('  CALENDAR IS STILL CONNECTED: the gcal token is stored either way',
    cbNoComments.indexOf('gcal_refresh_token=$1') > 0
      && cbNoComments.indexOf('gcal_refresh_token=$1') < cbNoComments.indexOf('emailScopeMissing'), null);

  // ── THE AUDIT SCRIPT ─────────────────────────────────────────────────────
  const aud = fs.readFileSync(ROOT + 'scripts/audit-gmail-scopes.js', 'utf8');
  const audNoComments = aud.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok('the audit is read-only unless --write is passed',
    /const WRITE = has\('--write'\)/.test(audNoComments)
      && /if \(WRITE\)/.test(audNoComments), null);
  ok('  IT NEVER SENDS: no sendEmail call anywhere in it',
    !/sendEmail/.test(audNoComments), null);
  ok('  a dead token is never recorded as "cannot send"',
    /verdict === 'CAN SEND' \|\| verdict === 'NO SEND'/.test(audNoComments), null);
  ok('  and an unreachable Google is reported as UNKNOWN, not as a failure',
    /out\.unknown\.push/.test(audNoComments) && /not recorded either way/.test(aud), null);

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
