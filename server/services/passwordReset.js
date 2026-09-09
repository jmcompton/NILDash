'use strict';
// ── SELF-SERVE PASSWORD RESET ────────────────────────────────────────────────
//
// Two of three paying customers texted the founder because they were locked
// out. A reset flow existed the whole time -- link, page, route, Resend mail,
// single-use expiring token. It failed for them anyway, and the way it failed
// is the reason this file exists:
//
//   THE EMAIL LOOKUP WAS BYTE-EXACT. `WHERE email=$1`, on login and on
//   forgot-password alike, and signup stored whatever was typed. So an account
//   created as Chris@... could not log in as chris@..., and when Chris then
//   asked for a reset with the lowercase form the route found nobody, answered
//   {ok:true} so as not to reveal whether the address existed, and the page said
//   "Check your email". Nothing was sent. There was no error anywhere to find.
//
// Everything that matches an email address now goes through normEmail() first,
// and the SQL compares LOWER(TRIM(email)) so rows already stored with capitals
// or a trailing space keep working without being rewritten.
//
// TOKENS ARE HASHED AT REST. The emailed link carries the raw token; the table
// holds its SHA-256. A read of password_resets -- a backup, a log line, a
// support query -- no longer yields a live way into someone's account.
//
// ONE ACTIVE LINK PER ADDRESS. Issuing a new token retires any unused earlier
// ones, so the link in the most recent email is the one that works and an older
// email cannot resurrect access later.
//
// THE CLAIM IS ONE STATEMENT. Marking a token used and reading which address it
// belongs to happen in a single UPDATE ... RETURNING, so two submits of the same
// link cannot both succeed.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const TOKEN_BYTES = 32;
const DEFAULT_TTL_MS = 60 * 60 * 1000;          // a forgot-password link: 1 hour
const ONBOARDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // a set-password link on a new account: 7 days
const MIN_PASSWORD_LENGTH = 6;                   // matches /api/auth/change-password and the page copy

// Lower-case and trimmed, or null. A mobile keyboard's trailing space and a
// capitalised first letter are both the same address to every mail server on
// earth, and were both a lockout here.
function normEmail(e) {
  const s = String(e == null ? '' : e).trim().toLowerCase();
  return s || null;
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// ── ISSUE ───────────────────────────────────────────────────────────────────
// Writes the row, returns the raw token for the email. `email` is stored as
// normalised so the funnel query's GROUP BY LOWER(email) keeps grouping.
async function issueResetToken(pool, { email, ttlMs }) {
  const norm = normEmail(email);
  if (!norm) throw new Error('issueResetToken: email required');
  const raw = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + (ttlMs || DEFAULT_TTL_MS));

  // Retire earlier unused links for this address. Done before the insert so a
  // failure here leaves nothing half-issued.
  await pool.query(
    `UPDATE password_resets SET used = TRUE
      WHERE LOWER(TRIM(email)) = $1 AND used = FALSE`, [norm]);
  await pool.query(
    `INSERT INTO password_resets (email, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [norm, hashToken(raw), expiresAt.toISOString()]);
  return { token: raw, expiresAt };
}

function resetUrl(appUrl, token) {
  return String(appUrl || 'https://mynildash.com').replace(/\/+$/, '') + '/reset?token=' + token;
}

// ── REQUEST ─────────────────────────────────────────────────────────────────
// Never reveals whether the address exists, and never throws for the reasons a
// caller would turn into a 500 that reveals it either. Returns what happened so
// the server log can say it plainly even though the response cannot.
//
//   findUser(norm)    -> row with {id, email} or null   (users table)
//   findAthlete(norm) -> row with {id, email} or null   (athletes table)
//   sendMail({to, subject, html, text})                 (Resend, or a fake in tests)
async function requestReset({ pool, email, appUrl, findUser, findAthlete, sendMail, ttlMs }) {
  const norm = normEmail(email);
  if (!norm) return { ok: false, status: 400, error: 'Email required' };

  let account = null, kind = null;
  try {
    account = await findUser(norm);
    if (account) kind = 'agent';
    else if (findAthlete) { account = await findAthlete(norm); if (account) kind = 'athlete'; }
  } catch (e) {
    console.error('[forgot-password] lookup failed:', e.message);
    return { ok: true, sent: false, reason: 'lookup_failed' };
  }
  if (!account) return { ok: true, sent: false, reason: 'no_account' };

  let token;
  try {
    ({ token } = await issueResetToken(pool, { email: norm, ttlMs }));
  } catch (e) {
    console.error('[forgot-password] token issue failed:', e.message);
    return { ok: true, sent: false, reason: 'issue_failed' };
  }

  const url = resetUrl(appUrl, token);
  const mail = renderResetEmail(url, ttlMs || DEFAULT_TTL_MS);
  try {
    await sendMail({ to: norm, subject: mail.subject, html: mail.html, text: mail.text });
  } catch (e) {
    // A send failure used to come back as a 500 -- which only ever happened when
    // the address existed, and so said so. Log it where an operator will see it;
    // the response stays identical to the not-found case.
    console.error(`[forgot-password] SEND FAILED for ${norm}: ${e.message}`);
    return { ok: true, sent: false, reason: 'send_failed', kind };
  }
  return { ok: true, sent: true, kind };
}

function renderResetEmail(url, ttlMs) {
  const hours = Math.round((ttlMs || DEFAULT_TTL_MS) / 3600000);
  const expiry = hours >= 24 ? `${Math.round(hours / 24)} day${hours >= 48 ? 's' : ''}` : `${hours} hour${hours === 1 ? '' : 's'}`;
  const subject = 'Reset your NILDash password';
  const html = '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;max-width:500px;margin:0 auto;padding:40px 24px;color:#111">' +
    '<h2 style="color:#111;margin:0 0 12px">NILDash</h2>' +
    '<p style="line-height:1.5">Someone asked to reset the password for this address. If that was you, set a new one here:</p>' +
    '<a href="' + url + '" style="display:inline-block;margin:20px 0;padding:12px 24px;background:#C8F135;color:#000;text-decoration:none;border-radius:40px;font-weight:700">Set a new password</a>' +
    '<p style="color:#666;font-size:12px;line-height:1.5">This link works once and expires in ' + expiry + '. ' +
    'If you did not ask for this, you can ignore it — your password has not changed.</p>' +
    '<p style="color:#999;font-size:11px;word-break:break-all">' + url + '</p>' +
    '</div>';
  const text = `Someone asked to reset the password for this address. If that was you, set a new one here:\n\n${url}\n\n` +
    `This link works once and expires in ${expiry}. If you did not ask for this, ignore it — your password has not changed.`;
  return { subject, html, text };
}

// ── COMPLETE ────────────────────────────────────────────────────────────────
// Claims the token, sets the password, ends the account's other sessions.
async function completeReset({ pool, token, password, minLength }) {
  const min = minLength || MIN_PASSWORD_LENGTH;
  if (!token || !password) return { ok: false, status: 400, error: 'Token and password required' };
  // The page enforces this too, but the page is not the boundary.
  if (String(password).length < min) {
    return { ok: false, status: 400, error: `Password must be at least ${min} characters` };
  }

  // Claim in one statement: used=TRUE and RETURNING email together, so a second
  // submit of the same link finds nothing. Old rows written before hashing have
  // token_hash NULL and can never match, which is correct -- a plaintext token in
  // the table is exactly the thing we stopped trusting.
  const claim = await pool.query(
    `UPDATE password_resets SET used = TRUE
      WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW()
      RETURNING email`, [hashToken(token)]);
  if (!claim.rows.length) return { ok: false, status: 400, error: 'Invalid or expired reset link' };
  const norm = normEmail(claim.rows[0].email);

  const hash = await bcrypt.hash(String(password), 10);

  // Agents first, then athletes -- same precedence the old route had, so an
  // address present in both tables behaves as before.
  const u = await pool.query(
    `UPDATE users SET password = $1, password_reset_required = FALSE, updated_at = NOW()
      WHERE LOWER(TRIM(email)) = $2 RETURNING id`, [hash, norm]);
  if (u.rows.length) {
    await endOtherSessions(pool, u.rows[0].id);
    return { ok: true, role: 'agent', userId: u.rows[0].id };
  }

  const a = await pool.query(
    `UPDATE athletes SET password_hash = $1, onboarding_complete = TRUE,
            email_verified = TRUE, updated_at = NOW()
      WHERE LOWER(TRIM(email)) = $2 RETURNING id`, [hash, norm]);
  if (a.rows.length) return { ok: true, role: 'athlete', athleteId: a.rows[0].id };

  // The token was valid and is now burnt, but the account behind it is gone.
  return { ok: false, status: 400, error: 'User not found' };
}

// A reset is how you get a stranger OUT of your account as much as how you get
// back in. express-session keeps userId inside the JSON `sess` column of
// connect-pg-simple's table; in dev there is no table (MemoryStore), so this is
// best-effort and never fails the reset.
async function endOtherSessions(pool, userId) {
  try {
    const r = await pool.query(`DELETE FROM session WHERE sess->>'userId' = $1`, [String(userId)]);
    if (r.rowCount) console.log(`[reset-password] ended ${r.rowCount} session(s) for ${userId}`);
    return r.rowCount || 0;
  } catch (e) {
    if (!/relation "session" does not exist/.test(e.message)) {
      console.warn('[reset-password] could not end sessions:', e.message);
    }
    return 0;
  }
}

module.exports = {
  normEmail, hashToken, issueResetToken, requestReset, completeReset, endOtherSessions,
  renderResetEmail, resetUrl,
  DEFAULT_TTL_MS, ONBOARDING_TTL_MS, MIN_PASSWORD_LENGTH,
};
