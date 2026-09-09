'use strict';
// Runs from a checkout on any machine: repo-relative paths, overridable
// Postgres settings.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/pwreset.js        just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

// ── LOCKED OUT WITH NO ERROR TO FIND ────────────────────────────────────────
//
// Two of three paying customers texted the founder. A reset flow existed the
// whole time. It failed them because the email lookup was byte-exact and
// signup stored whatever was typed, so Chris@ could not log in as chris@, and a
// reset request with the lowercase form found nobody -- and, correctly refusing
// to say whether the address existed, told him to check his email.
//
// WHAT THIS SUITE PROTECTS, in order of what would actually hurt:
//
//   1. THE LOOKUP IS CASE- AND WHITESPACE-INSENSITIVE, on the ROWS ALREADY IN
//      THE TABLE. Not on new rows -- those are stored normalised and would pass
//      trivially. The fixture stores "Chris@Example.Test " with a capital and a
//      trailing space, exactly as a signup in 2025 would have.
//
//   2. THE TOKEN IN THE TABLE IS NOT THE TOKEN IN THE EMAIL.
//
//   3. ONE USE. Two submits of one link cannot both succeed, and the second
//      cannot succeed after the first regardless of ordering.
//
//   4. THE RESPONSE DOES NOT SAY WHETHER THE ADDRESS EXISTS -- including when
//      the mail provider fails, which used to be a 500 only a real address
//      could produce.
//
//   5. A RESET ENDS OTHER SESSIONS. It is how you get a stranger out as much as
//      how you get back in.

const { Pool } = require(REPO + 'node_modules/pg');
const bcrypt = require(REPO + 'node_modules/bcryptjs');
const PR = require(REPO + 'server/services/passwordReset');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

const P = new Pool({ max: 4 });
const UID = 'pwr-agent';
const STORED = 'Chris@Example.Test ';        // capital C, capital T, trailing space
const TYPED = 'chris@example.test';          // what he actually typed on his phone
const ATH = 'pwr-athlete';

// A fake mail provider: records what would have been sent, can be told to fail.
function mailer() {
  const m = { sent: [], fail: false };
  m.send = async (msg) => { if (m.fail) throw new Error('resend down'); m.sent.push(msg); };
  return m;
}
const findUser = async (norm) => (await P.query(
  'SELECT id, email FROM users WHERE LOWER(TRIM(email)) = $1 LIMIT 1', [norm])).rows[0] || null;
const findAthlete = async (norm) => (await P.query(
  'SELECT id, email FROM athletes WHERE LOWER(TRIM(email)) = $1 LIMIT 1', [norm])).rows[0] || null;
const tokenFrom = (msg) => (msg.html.match(/reset\?token=([0-9a-f]+)/) || [])[1];

async function cleanup() {
  await P.query(`DELETE FROM password_resets WHERE LOWER(TRIM(email)) IN ($1, $2, $3)`,
    [TYPED, 'nobody@example.test', 'ath@example.test']);
  await P.query(`DELETE FROM session WHERE sess->>'userId' = $1`, [UID]).catch(() => {});
  await P.query(`DELETE FROM athletes WHERE id = $1`, [ATH]);
  await P.query(`DELETE FROM users WHERE id = $1`, [UID]);
}

async function main() {
  await cleanup();
  // connect-pg-simple's table, if this database has never had a session store.
  await P.query(`CREATE TABLE IF NOT EXISTS session (
    sid varchar NOT NULL COLLATE "default" PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL)`);

  const oldHash = await bcrypt.hash('old-password', 10);
  // Stored EXACTLY as a pre-fix signup would have stored it. No .catch() on any
  // fixture insert in this file.
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1,$2,$3,$4,'agent')`,
    [UID, 'Chris Sarver', STORED, oldHash]);

  // ── 1. THE LOOKUP FINDS THE OLD ROW ───────────────────────────────────────
  {
    ok('normEmail lowercases and trims', PR.normEmail('  Chris@Example.Test ') === TYPED, PR.normEmail('  Chris@Example.Test '));
    ok('  and an empty address is null, not ""', PR.normEmail('   ') === null, PR.normEmail('   '));
    const u = await findUser(PR.normEmail(TYPED));
    ok('a row stored with capitals and a trailing space is found by the lowercase form',
      u && u.id === UID, u);
    ok('  and by the shouting form', (await findUser(PR.normEmail('CHRIS@EXAMPLE.TEST'))) !== null, null);
  }

  // ── 2. REQUEST: SENDS, AND THE TABLE HOLDS A HASH ─────────────────────────
  let firstToken;
  {
    const m = mailer();
    const out = await PR.requestReset({ pool: P, email: '  ' + TYPED.toUpperCase() + ' ',
      appUrl: 'https://x.test', findUser, findAthlete, sendMail: m.send });
    ok('a reset request for the lowercase form of a mixed-case row sends mail', out.sent === true, out);
    ok('  addressed to the normalised address', m.sent[0] && m.sent[0].to === TYPED, m.sent[0] && m.sent[0].to);
    ok('  with a plain-text part', m.sent[0] && /reset\?token=/.test(m.sent[0].text), null);
    firstToken = tokenFrom(m.sent[0]);
    ok('  the link carries a 64-hex token', /^[0-9a-f]{64}$/.test(firstToken || ''), firstToken);

    const row = await P.query(`SELECT token, token_hash, used, email FROM password_resets
      WHERE LOWER(TRIM(email)) = $1 ORDER BY id DESC LIMIT 1`, [TYPED]);
    ok('the table does NOT hold the emailed token', row.rows[0].token !== firstToken && row.rows[0].token == null, row.rows[0].token);
    ok('  it holds its SHA-256', row.rows[0].token_hash === PR.hashToken(firstToken), null);
    ok('  stored against the normalised email (the funnel groups on it)', row.rows[0].email === TYPED, row.rows[0].email);
  }

  // ── 3. ONE ACTIVE LINK PER ADDRESS ────────────────────────────────────────
  let secondToken;
  {
    const m = mailer();
    await PR.requestReset({ pool: P, email: TYPED, appUrl: 'https://x.test', findUser, findAthlete, sendMail: m.send });
    secondToken = tokenFrom(m.sent[0]);
    ok('a second request issues a different token', secondToken && secondToken !== firstToken, null);
    const first = await PR.completeReset({ pool: P, token: firstToken, password: 'new-password-1' });
    ok('  and the FIRST link no longer works', first.ok === false && /Invalid or expired/.test(first.error), first);
    const still = await bcrypt.compare('old-password', (await P.query('SELECT password FROM users WHERE id=$1', [UID])).rows[0].password);
    ok('  so the password is unchanged', still === true, null);
  }

  // ── 4. COMPLETE: SETS THE PASSWORD, ONCE ──────────────────────────────────
  {
    // Two live sessions for this account, as if a stranger had one too.
    for (const sid of ['pwr-sid-1', 'pwr-sid-2']) {
      await P.query(`INSERT INTO session (sid, sess, expire) VALUES ($1, $2, NOW() + INTERVAL '1 day')
        ON CONFLICT (sid) DO NOTHING`, [sid, JSON.stringify({ cookie: {}, userId: UID })]);
    }
    const short = await PR.completeReset({ pool: P, token: secondToken, password: 'abc' });
    ok('a 3-character password is refused SERVER-side', short.ok === false && /at least 6/.test(short.error), short);
    const stillLive = await P.query(`SELECT used FROM password_resets WHERE token_hash=$1`, [PR.hashToken(secondToken)]);
    ok('  and the refusal does not burn the token', stillLive.rows[0].used === false, stillLive.rows[0]);

    const done = await PR.completeReset({ pool: P, token: secondToken, password: 'new-password-2' });
    ok('a valid link sets the password', done.ok === true && done.role === 'agent', done);
    const row = (await P.query('SELECT password, password_reset_required FROM users WHERE id=$1', [UID])).rows[0];
    ok('  stored as a bcrypt hash, not the password', /^\$2[aby]\$/.test(row.password) && row.password !== 'new-password-2', row.password.slice(0, 7));
    ok('  which verifies', await bcrypt.compare('new-password-2', row.password), null);
    ok('  and clears password_reset_required', row.password_reset_required === false, row.password_reset_required);

    const again = await PR.completeReset({ pool: P, token: secondToken, password: 'new-password-3' });
    ok('the same link a second time is refused', again.ok === false, again);
    ok('  and did not change the password', await bcrypt.compare('new-password-2', (await P.query('SELECT password FROM users WHERE id=$1', [UID])).rows[0].password), null);

    const sess = await P.query(`SELECT COUNT(*)::int c FROM session WHERE sess->>'userId' = $1`, [UID]);
    ok('a reset ends the account\'s other sessions', sess.rows[0].c === 0, sess.rows[0].c);
  }

  // ── 5. EXPIRY ─────────────────────────────────────────────────────────────
  {
    const { token } = await PR.issueResetToken(P, { email: TYPED, ttlMs: 1000 });
    await P.query(`UPDATE password_resets SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash=$1`, [PR.hashToken(token)]);
    const out = await PR.completeReset({ pool: P, token, password: 'new-password-4' });
    ok('an expired link is refused', out.ok === false && /expired/.test(out.error), out);
  }

  // ── 6. THE RESPONSE NEVER SAYS WHETHER THE ADDRESS EXISTS ─────────────────
  {
    const m = mailer();
    const none = await PR.requestReset({ pool: P, email: 'nobody@example.test', appUrl: 'https://x.test',
      findUser, findAthlete, sendMail: m.send });
    ok('an unknown address gets ok:true', none.ok === true && none.sent === false, none);
    ok('  and no mail', m.sent.length === 0, m.sent.length);

    const m2 = mailer(); m2.fail = true;
    const failed = await PR.requestReset({ pool: P, email: TYPED, appUrl: 'https://x.test',
      findUser, findAthlete, sendMail: m2.send });
    ok('a mail-provider failure ALSO gets ok:true (it used to be a 500 only a real address could cause)',
      failed.ok === true && failed.sent === false && failed.reason === 'send_failed', failed);
    ok('  and the two responses are indistinguishable to the caller',
      JSON.stringify({ ok: none.ok }) === JSON.stringify({ ok: failed.ok }), null);
    const empty = await PR.requestReset({ pool: P, email: '   ', appUrl: 'https://x.test', findUser, findAthlete, sendMail: m.send });
    ok('  a blank address is the one 400', empty.ok === false && empty.status === 400, empty);
  }

  // ── 7. ATHLETES CAN ASK TOO ───────────────────────────────────────────────
  // The reset route always knew how to set an athlete's password; the request
  // route ignored the athletes table and so sent nothing for every athlete.
  {
    await P.query(`INSERT INTO athletes (id, agent_id, data, email, password_hash)
      VALUES ($1,$2,$3,$4,$5)`, [ATH, UID, JSON.stringify({ name: 'Noah' }), 'Ath@Example.Test', await bcrypt.hash('x', 10)]);
    const m = mailer();
    const out = await PR.requestReset({ pool: P, email: 'ath@example.test', appUrl: 'https://x.test',
      findUser, findAthlete, sendMail: m.send });
    ok('an athlete address gets a reset email', out.sent === true && out.kind === 'athlete', out);
    const done = await PR.completeReset({ pool: P, token: tokenFrom(m.sent[0]), password: 'athlete-pass-1' });
    ok('  and the link sets the athlete password', done.ok === true && done.role === 'athlete', done);
    const a = (await P.query('SELECT password_hash, onboarding_complete FROM athletes WHERE id=$1', [ATH])).rows[0];
    ok('  which verifies', await bcrypt.compare('athlete-pass-1', a.password_hash), null);
  }

  // ── 8. THE ROUTES ARE WIRED THE WAY THE SERVICE ASSUMES ───────────────────
  {
    const fs = require('fs');
    const src = fs.readFileSync(REPO + 'server/index.js', 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const st = fs.readFileSync(REPO + 'server/store.js', 'utf8').replace(/^\s*\/\/.*$/gm, '');
    ok('forgot-password has its OWN rate limiter, not the one login burns',
      /app\.post\('\/api\/auth\/forgot-password', resetLimiter,/.test(src), null);
    ok('  reset-password is rate-limited too', /app\.post\('\/api\/auth\/reset-password', resetLimiter,/.test(src), null);
    ok('  and login still uses authLimiter', /app\.post\('\/api\/auth\/login', authLimiter,/.test(src), null);
    ok('no route inserts a plaintext token any more',
      !/INSERT INTO password_resets \(email, token, expires_at\)/.test(src), null);
    ok('  every issuer goes through issueResetToken', (src.match(/pwReset\.issueResetToken\(/g) || []).length === 2,
      (src.match(/pwReset\.issueResetToken\(/g) || []).length);
    ok('store lookups compare LOWER(TRIM(email))', (st.match(/WHERE LOWER\(TRIM\(email\)\) = \$1/g) || []).length >= 2, null);
    ok('  and saveUser writes the normalised address', /normEmail\(data\.email\)/.test(st), null);
    ok('  no byte-exact email lookup remains in store', !/WHERE email=\$1/.test(st), null);
    ok('the login page links to /reset', /href="\/reset"/.test(fs.readFileSync(REPO + 'public/index.html', 'utf8')), null);
    ok('the page and the server agree on the minimum length',
      new RegExp('at least ' + PR.MIN_PASSWORD_LENGTH).test(fs.readFileSync(REPO + 'public/reset.html', 'utf8')), null);
  }

  // ── 9. THE AUDIT SCRIPT CANNOT SILENTLY MISS PRODUCTION AGAIN ────────────
  // Its first version did `new Pool()` with no arguments: PG* env vars, which
  // production does not set. It dialled localhost, wrote one line to stderr,
  // and looked exactly like a script that had not run. Every guarantee below is
  // one the founder had to ask for after watching it print nothing.
  {
    const fs = require('fs');
    const sc = fs.readFileSync(REPO + 'scripts/audit-email-case.js', 'utf8').replace(/^\s*\/\/.*$/gm, '');
    ok('the audit script connects through server/store (DATABASE_URL + SSL, like the app)',
      /require\('\.\.\/server\/store'\)/.test(sc) && /store\.pool/.test(sc), null);
    ok('  and never builds a bare pool of its own', !/new Pool\(/.test(sc), null);
    ok('  it prints where it is connecting BEFORE the first query',
      sc.indexOf('connecting via') > -1 && sc.indexOf('connecting via') < sc.indexOf('await P.query'), null);
    ok('  its exit code starts at 1 and is only lowered after the report',
      /process\.exitCode = 1/.test(sc) && sc.indexOf('process.exit(0)') > sc.indexOf("'Done."), null);
    ok('  a query failure is written to STDOUT, not only stderr',
      /console\.log\(msg\)/.test(sc) && /console\.error\(msg\)/.test(sc), null);
    ok('  and a promise that never settles exits 1 with a message, not 0 in silence',
      /beforeExit/.test(sc) && /never settled/.test(sc), null);
    ok('  an empty result says so in words', /None -- every agent email/.test(sc) && /None\. Good\./.test(sc), null);
  }

  await cleanup();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch(async (e) => {
  console.error('THREW', e);
  try { await cleanup(); await P.end(); } catch (_) {}
  process.exit(1);
});
