'use strict';
// ── CLIENT ACCOUNTS: THE FOUNDER WORKS INSIDE AN AGENT'S ACCOUNT ────────────
//
// The done-for-you service (Nov 2026): an agent connects their mailbox and
// hands over a script, and the founder does the rest for them. He loads the
// roster, reviews the pitches and approves them, and they send from the
// agent's own mailbox. The agent does nothing in NILDash after connecting.
//
// That needs the founder INSIDE the agent's account, without the agent
// inviting him or sharing a password. From the admin account he opens a
// client; the session then works that agent's account (session.userId = the
// agent) and remembers who is really signed in (session.adminId). Every route
// that reads session.userId works the agent's athletes, pitches and mailbox
// with no change, the same way a team member's session does
// (services/teamSeats).
//
// WHAT STAYS WITH THE AGENT while the founder is in their account: their
// password, their billing, their team, and connecting or removing their
// mailbox (NOT_WHILE_WORKING_AS). Everything else is the work he is there for.
//
// ONLY THE ADMIN ACCOUNT can open a client, only an agent's account can be
// opened, and every open and close is written to work_as_log with who and when.

const TS = require('./teamSeats');
const CLIENT_ROLES = ['agent'];

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS work_as_log (
    id          BIGSERIAL PRIMARY KEY,
    admin_id    TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at    TIMESTAMPTZ
  )`);
}

// The account that is really signed in: the admin's own, also while he is
// working in a client's account.
function realUserId(session) { return (session && (session.adminId || session.userId)) || null; }

function blocked(method, path) {
  const m = String(method || '').toUpperCase(), p = String(path || '');
  if (m === 'POST' && p === '/api/auth/change-password') return true;
  return TS.ownerOnly(m, p);
}

// -> { ok, agent } or { ok:false, status, error }
async function open(pool, admin, agentId) {
  if (!admin) return { ok: false, status: 403, error: 'Forbidden' };
  const a = (await pool.query(`SELECT id, name, email, role, archived FROM users WHERE id = $1`, [String(agentId || '')])).rows[0];
  if (!a) return { ok: false, status: 404, error: 'That account was not found.' };
  if (a.id === admin.id) return { ok: false, status: 400, error: 'That is your own account.' };
  if (!CLIENT_ROLES.includes(a.role)) return { ok: false, status: 400, error: 'Only an agent account can be opened.' };
  if (a.archived === true) return { ok: false, status: 400, error: 'That account is archived.' };
  await ensureTable(pool);
  await pool.query(`UPDATE work_as_log SET ended_at = NOW() WHERE admin_id = $1 AND ended_at IS NULL`, [admin.id]);
  await pool.query(`INSERT INTO work_as_log (admin_id, agent_id) VALUES ($1, $2)`, [admin.id, a.id]);
  return { ok: true, agent: a };
}

async function close(pool, adminId) {
  await ensureTable(pool);
  await pool.query(`UPDATE work_as_log SET ended_at = NOW() WHERE admin_id = $1 AND ended_at IS NULL`, [String(adminId)]);
  return { ok: true };
}

// The agents the founder can open, with what he needs to see before he does:
// is the mailbox connected, how many athletes, how many pitches are waiting
// for a yes, how many replies have come in.
async function clients(pool) {
  await require('./managedClients').ensureColumns(pool);
  await require('./mailboxNotice').ensureTable(pool);
  // mailbox: the address pitches send from, or null. mailbox_broken: one is on
  // file but the provider is refusing it (a revoked sign-in, a changed
  // password), so nothing sends until the agent reconnects.
  const rows = (await pool.query(`
    SELECT u.id, u.name, u.email, u.sign_first_name, u.last_login, u.managed_since,
           (SELECT COUNT(*)::int FROM athletes a WHERE a.agent_id = u.id) AS athletes,
           (SELECT e.email_address FROM email_accounts e WHERE e.user_id = u.id AND COALESCE(e.status,'active') = 'active'
              AND e.can_send IS NOT FALSE AND NOT EXISTS (SELECT 1 FROM mailbox_notices n WHERE n.account_id = e.id)
              ORDER BY e.updated_at DESC NULLS LAST LIMIT 1) AS mailbox,
           (SELECT e.email_address FROM email_accounts e WHERE e.user_id = u.id AND COALESCE(e.status,'active') <> 'disconnected'
              AND (COALESCE(e.status,'active') <> 'active' OR EXISTS (SELECT 1 FROM mailbox_notices n WHERE n.account_id = e.id))
              ORDER BY e.updated_at DESC NULLS LAST LIMIT 1) AS mailbox_broken,
           (SELECT COUNT(*)::int FROM outreach_queue q WHERE q.agent_id = u.id AND q.state = 'queued') AS waiting,
           (SELECT COUNT(*)::int FROM outreach_logs l WHERE l.agent_id = u.id AND l.sent_at IS NOT NULL) AS sent,
           (SELECT COUNT(*)::int FROM outreach_logs l WHERE l.agent_id = u.id AND l.replied_at IS NOT NULL) AS replies,
           (SELECT MAX(l.replied_at) FROM outreach_logs l WHERE l.agent_id = u.id) AS last_reply
      FROM users u
     WHERE u.role = 'agent' AND COALESCE(u.archived, false) = false
     ORDER BY (u.managed_since IS NULL),
              (SELECT COUNT(*) FROM outreach_queue q WHERE q.agent_id = u.id AND q.state = 'queued') DESC, u.last_login DESC NULLS LAST, u.name`)).rows;
  const AN = require('./agentName');
  return rows.map((r) => ({ id: r.id, name: AN.displayName(r) || r.name || r.email, email: r.email, athletes: r.athletes,
    managed: !!r.managed_since, mailbox: r.mailbox || null, mailboxBroken: r.mailbox ? null : (r.mailbox_broken || null),
    waiting: r.waiting, sent: r.sent, replies: r.replies, lastReply: r.last_reply, lastLogin: r.last_login }));
}

module.exports = { ensureTable, realUserId, blocked, open, close, clients, CLIENT_ROLES };
