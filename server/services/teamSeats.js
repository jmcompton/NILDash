'use strict';
// ── TEAM SEATS: STAFF LOGINS ON ONE AGENT ACCOUNT ───────────────────────────
//
// An agency with ten staff works one roster. Pricing is by athletes (the plan
// caps them, services/pricing + services/seats), never by people, so staff
// logins cost nothing extra.
//
// HOW IT WORKS
//   The owner invites a staff member by email (Settings > Your team). That
//   creates a users row with role 'team_member' and team_owner_id = the owner,
//   and emails a set-password link (the same hashed-token flow as every other
//   invite, services/passwordReset).
//
//   When a team member signs in, the session is the OWNER's account
//   (session.userId = owner) and session.memberId = the member. Every route
//   that reads session.userId therefore works the owner's athletes, pitches,
//   deals and plan with no change, and the plan's athlete cap applies to the
//   whole team.
//
//   A few things stay with the owner (ownerOnly below): billing, the team
//   itself, and connecting or removing the account's mailbox (a member
//   connecting theirs would replace the owner's). A member's own password is
//   theirs (the change-password route uses session.memberId).
//
//   Removing a member ends their sessions at once and stops their sign-in.
//   Inviting the same address again brings them back with a new link.

const crypto = require('crypto');
const MAX_MEMBERS = 25;
// Agents own teams. Not admins: a staff login on an admin account would
// inherit admin rights through session.userId.
const OWNER_ROLES = ['agent'];

async function ensureColumns(pool) {
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS team_owner_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS team_removed_at TIMESTAMPTZ`).catch(() => {});
  await pool.query(`CREATE INDEX IF NOT EXISTS users_team_owner_idx ON users (team_owner_id) WHERE team_owner_id IS NOT NULL`).catch(() => {});
}

const normEmail = (e) => String(e || '').trim().toLowerCase();
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

// Sign-in: who the session acts as. A normal user is themselves; a team member
// is their owner's account. -> { ok, account, member } or { ok:false, error }.
async function resolve(pool, user) {
  if (!user || user.role !== 'team_member') return { ok: true, account: user, member: null };
  if (user.team_removed_at || !user.team_owner_id) return { ok: false, status: 403, error: 'This team login was removed by the account owner.' };
  const owner = (await pool.query(`SELECT * FROM users WHERE id = $1`, [user.team_owner_id])).rows[0];
  if (!owner || owner.archived || !OWNER_ROLES.includes(owner.role)) return { ok: false, status: 403, error: 'This team account is no longer active.' };
  return { ok: true, account: owner, member: user };
}

async function list(pool, ownerId) {
  return (await pool.query(
    `SELECT id, name, email, created_at, last_login, to_jsonb(users)->>'first_login_at' AS first_login_at, team_removed_at FROM users
      WHERE team_owner_id = $1 AND role = 'team_member' ORDER BY (team_removed_at IS NULL) DESC, created_at`, [ownerId])).rows
    .map((u) => ({ id: u.id, name: u.name, email: u.email, invitedAt: u.created_at, lastLogin: u.last_login || null,
      status: u.team_removed_at ? 'removed' : (u.first_login_at || u.last_login) ? 'active' : 'invited' }));
}

// The owner invites a staff member. deps.send({to, name, ownerName, url, ttlWords})
// is the email (injectable for tests); a send failure still returns the link so
// the owner can share it by hand.
async function invite(pool, owner, { name, email }, deps = {}) {
  if (!owner || !OWNER_ROLES.includes(owner.role)) return { ok: false, status: 403, error: 'Only the account owner can add people to the team.' };
  const em = normEmail(email), nm = cleanName(name);
  if (nm.length < 2) return { ok: false, status: 400, error: 'Enter their name.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return { ok: false, status: 400, error: 'Enter a valid email address.' };
  if (em === normEmail(owner.email)) return { ok: false, status: 400, error: 'That is your own email.' };
  const PR = require('./passwordReset');
  const existing = (await pool.query(`SELECT * FROM users WHERE LOWER(TRIM(email)) = $1`, [em])).rows[0];
  let memberId;
  if (existing) {
    // Only a removed member of this same team can be brought back.
    if (existing.role !== 'team_member' || existing.team_owner_id !== owner.id) return { ok: false, status: 400, error: 'That email already has a NILDash account. Use a different email for them.' };
    if (!existing.team_removed_at) return { ok: false, status: 400, error: 'They are already on your team.' };
    memberId = existing.id;
  }
  const active = (await pool.query(`SELECT COUNT(*)::int n FROM users WHERE team_owner_id = $1 AND role = 'team_member' AND team_removed_at IS NULL`, [owner.id])).rows[0].n;
  if (active >= MAX_MEMBERS) return { ok: false, status: 400, error: `A team can have up to ${MAX_MEMBERS} people. Remove someone first.` };
  if (memberId) {
    await pool.query(`UPDATE users SET team_removed_at = NULL, name = $1, password_reset_required = TRUE WHERE id = $2`, [nm, memberId]);
  } else {
    memberId = 'member-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
    const hash = await require('bcryptjs').hash(crypto.randomBytes(24).toString('hex'), 10);
    await pool.query(
      `INSERT INTO users (id, name, email, password, role, team_owner_id, password_reset_required, created_at)
       VALUES ($1,$2,$3,$4,'team_member',$5,TRUE,NOW())`, [memberId, nm, em, hash, owner.id]);
  }
  const ttl = PR.agentInviteTtlMs();
  const { token } = await PR.issueResetToken(pool, { email: em, ttlMs: ttl });
  const url = PR.resetUrl(process.env.APP_URL, token);
  let emailed = false;
  if (deps.send) {
    try { await deps.send({ to: em, name: nm, ownerName: owner.name || 'Your team', url, ttlWords: PR.expiryWords(ttl) }); emailed = true; }
    catch (e) { console.error('[team/invite] email failed (link still returned):', e.message); }
  }
  return { ok: true, member: { id: memberId, name: nm, email: em, status: 'invited' }, setPasswordUrl: url, emailed };
}

// The owner removes a member: sign-in stops and their open sessions end now.
async function remove(pool, ownerId, memberId) {
  const r = await pool.query(`UPDATE users SET team_removed_at = NOW() WHERE id = $1 AND team_owner_id = $2 AND role = 'team_member' AND team_removed_at IS NULL`,
    [String(memberId || ''), ownerId]);
  if (!r.rowCount) return { ok: false, status: 404, error: 'No such person on your team.' };
  await endSessions(pool, memberId);
  return { ok: true };
}
async function endSessions(pool, memberId) {
  try { return (await pool.query(`DELETE FROM session WHERE sess->>'memberId' = $1`, [String(memberId)])).rowCount || 0; }
  catch (e) { if (!/relation "session" does not exist/.test(e.message)) console.warn('[team] could not end sessions:', e.message); return 0; }
}

// Checked on each request from a member's session. Fails open on a database
// error only for the check itself (the session still needs the owner's id).
async function stillActive(pool, memberId) {
  try {
    const r = (await pool.query(`SELECT team_removed_at FROM users WHERE id = $1 AND role = 'team_member'`, [String(memberId)])).rows[0];
    return !!r && !r.team_removed_at;
  } catch (e) { console.warn('[team] active check failed:', e.message); return true; }
}

// What a team member may not do: it belongs to the account owner. Method +
// path prefix.
const OWNER_ONLY = [
  ['POST', '/api/agent/create-checkout'],
  ['POST', '/api/team/'],
  ['GET', '/api/email/oauth/'],
  ['POST', '/api/email/connect/'],
  ['DELETE', '/api/email/accounts/'],
  ['GET', '/api/agent/calendar/google/connect'],
];
function ownerOnly(method, path) {
  const m = String(method || '').toUpperCase(), p = String(path || '');
  return OWNER_ONLY.some(([mm, pre]) => mm === m && p.startsWith(pre));
}

function inviteEmailHtml({ name, ownerName, url, ttlWords }) {
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  return '<div style="font-family:system-ui,Arial,sans-serif;max-width:520px;margin:0 auto;padding:40px">'
    + '<h2 style="color:#C8F135">NILDash</h2>'
    + '<p>Hi ' + esc(name) + ',</p>'
    + '<p>' + esc(ownerName) + ' added you to their team on NILDash. You will work the same athletes, pitches and deals with your own login.</p>'
    + '<p>Set your password to sign in:</p>'
    + '<a href="' + esc(url) + '" style="display:inline-block;margin:20px 0;padding:12px 24px;background:#C8F135;color:#000;text-decoration:none;border-radius:40px;font-weight:700">Set your password</a>'
    + '<p style="color:#666;font-size:12px">This link lasts ' + esc(ttlWords) + '. After that, use "Forgot password" at ' + esc(process.env.APP_URL || 'https://mynildash.com') + '.</p>'
    + '</div>';
}

module.exports = { ensureColumns, resolve, list, invite, remove, endSessions, stillActive, ownerOnly, inviteEmailHtml, MAX_MEMBERS, OWNER_ROLES };
