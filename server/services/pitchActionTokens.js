'use strict';
// ── ONE-TAP APPROVE AND SKIP, FROM THE EMAIL ────────────────────────────────
//
// Agents were not logging in, so pitches sat and deals stalled. Each pitch in
// the nightly digest carries two links -- one approve, one skip -- that work
// with no session at all. A link that acts on an agent's behalf with no login
// is a credential, so it is built like one.
//
// ── THE RULES, AND WHY EACH ONE ─────────────────────────────────────────────
//
// HASHED AT REST. The email carries the raw token; this table holds only its
// SHA-256. A read of pitch_action_tokens -- a backup, a log line, a support
// query, a leaked dump -- yields no working link. Exactly the rule
// services/passwordReset already holds itself to, and for the same reason.
//
// 32 RANDOM BYTES, URL-SAFE. base64url of 32 bytes is 43 characters and 256
// bits of entropy. Guessing one is not a thing that happens.
//
// SEVENTY-TWO HOURS. Long enough that Friday's digest still works on Monday
// morning, short enough that a forwarded email or an old inbox is not a
// standing key to somebody's outreach.
//
// SINGLE USE, CLAIMED IN ONE STATEMENT. `UPDATE ... WHERE used_at IS NULL
// RETURNING` is the claim: two taps on the same link, or a double-submit from a
// flaky phone connection, cannot both win. A read-then-write would let both
// through and send the pitch twice.
//
// AND THE SIBLING DIES WITH IT. Approve and skip are a pair; using one must
// retire the other, or an agent who approved a pitch could tap Skip in the same
// email ten seconds later and stop the cadence on a message already scheduled.
//
// ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ───────────────────────────────
// It does not approve or skip anything. It issues, validates and claims
// tokens; the route calls Closer.approveBatch or Closer.skipDraft -- the same
// functions the dashboard calls -- to do the actual work. A token service that
// also knows how to send mail is a token service that will one day send mail
// by accident.

const crypto = require('crypto');

// ── TWO SHAPES OF TOKEN ─────────────────────────────────────────────────────
// 'approve' and 'skip' are about ONE pitch: pitch_id is the draft, athlete_id
// is carried alongside it for the page's heading.
//
// 'approve_all' is about ONE ATHLETE -- the "Approve all" button on each
// athlete's block in the digest -- so it has NO pitch_id and its athlete_id is
// the subject. A third action rather than an athlete id smuggled into a column
// called pitch_id: that column LEFT JOINs outreach_logs, and putting an athlete
// there would make the join silently return nothing and the page say "this
// pitch no longer exists" about a perfectly good athlete.
const TOKEN_BYTES = 32;
const TTL_MS = 72 * 60 * 60 * 1000;
const ACTIONS = ['approve', 'skip', 'approve_all'];

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// URL-safe, so it survives an email client, a copy-paste and a redirect
// without any encoding step to get wrong.
function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pitch_action_tokens (
      id         SERIAL PRIMARY KEY,
      pitch_id   TEXT,
      agent_id   TEXT NOT NULL,
      action     TEXT NOT NULL,
      athlete_id TEXT,
      token_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch((e) => console.error('[pitchActionTokens] ensureTable:', e.message));
  // Additive, for a database created before approve_all existed. IF NOT EXISTS
  // on both, so this is safe to run on every boot like every other migration
  // in this codebase.
  await pool.query(`ALTER TABLE pitch_action_tokens ADD COLUMN IF NOT EXISTS athlete_id TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE pitch_action_tokens ALTER COLUMN pitch_id DROP NOT NULL`).catch(() => {});
  // The lookup is by hash and nothing else, so it is the index that matters.
  // UNIQUE: two rows with one hash would make "which token is this" ambiguous,
  // and the claim below assumes exactly one.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pitch_action_tokens_hash ON pitch_action_tokens (token_hash)`)
    .catch(() => {});
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_pitch_action_tokens_pitch ON pitch_action_tokens (pitch_id)`)
    .catch(() => {});
}

// ── ISSUE ───────────────────────────────────────────────────────────────────
// issueFor(pool, { pitchId, agentId, ttlMs }) -> { approve, skip, expiresAt }
// where approve and skip are RAW tokens, returned to the caller for the email
// and stored nowhere. One pair per pitch per digest.
//
// Earlier unused pairs for the same pitch are retired first, so the links in
// the most recent email are the ones that work. Without that, yesterday's
// digest and today's would both be live and the "single use" promise would be
// true per link but false per pitch.
// `retirePrevious: false` keeps the earlier pair alive. The confirmation page
// after an action offers the agent's NEXT pitch with its own buttons, and that
// pitch already has live links in the email they are holding. Retiring them
// there would mean: tap Approve on Rama Jamas, go back to the email, tap Skip
// on Hydro Fit, and be told "already done" about a pitch nobody touched. The
// single-use promise is still kept -- whichever link is used first claims, and
// the claim retires every other token for that pitch.
async function issueFor(pool, { pitchId, agentId, athleteId, ttlMs, retirePrevious } = {}) {
  if (!pitchId || !agentId) throw new Error('issueFor: pitchId and agentId required');
  const expiresAt = new Date(Date.now() + (Number(ttlMs) || TTL_MS));
  const raw = { approve: newToken(), skip: newToken() };
  if (retirePrevious !== false) {
    await pool.query(
      `UPDATE pitch_action_tokens SET used_at = NOW()
        WHERE pitch_id = $1 AND used_at IS NULL`, [String(pitchId)]);
  }
  await pool.query(
    `INSERT INTO pitch_action_tokens (pitch_id, agent_id, action, athlete_id, token_hash, expires_at)
     VALUES ($1,$2,'approve',$3,$4,$6), ($1,$2,'skip',$3,$5,$6)`,
    [String(pitchId), String(agentId), athleteId ? String(athleteId) : null,
     hashToken(raw.approve), hashToken(raw.skip), expiresAt.toISOString()]);
  return { approve: raw.approve, skip: raw.skip, expiresAt };
}

// The "Approve all" button on one athlete's block. One token, no pitch.
async function issueApproveAll(pool, { agentId, athleteId, ttlMs } = {}) {
  if (!agentId || !athleteId) throw new Error('issueApproveAll: agentId and athleteId required');
  const expiresAt = new Date(Date.now() + (Number(ttlMs) || TTL_MS));
  const raw = newToken();
  await pool.query(
    `UPDATE pitch_action_tokens SET used_at = NOW()
      WHERE action = 'approve_all' AND athlete_id = $1 AND used_at IS NULL`, [String(athleteId)]);
  await pool.query(
    `INSERT INTO pitch_action_tokens (pitch_id, agent_id, action, athlete_id, token_hash, expires_at)
     VALUES (NULL,$1,'approve_all',$2,$3,$4)`,
    [String(agentId), String(athleteId), hashToken(raw), expiresAt.toISOString()]);
  return { approveAll: raw, expiresAt };
}

// Several pitches in one go, for a digest. Returns a Map pitchId -> {approve, skip}.
async function issueForMany(pool, agentId, pitches, opts = {}) {
  const out = new Map();
  const list = (pitches || []).map((p) => (typeof p === 'string' ? { id: p } : p)).filter((p) => p && p.id);
  const seen = new Set();
  for (const p of list) {
    const id = String(p.id);
    if (seen.has(id)) continue;
    seen.add(id);
    try { out.set(id, await issueFor(pool, { pitchId: id, agentId, athleteId: p.athleteId, ttlMs: opts.ttlMs })); }
    catch (e) { console.error(`[pitchActionTokens] could not issue for ${id}: ${e.message}`); }
  }
  return out;
}

// ── LOOK UP, WITHOUT CLAIMING ───────────────────────────────────────────────
// What GET needs. Returns { ok, reason, row } and NEVER marks anything used:
// Outlook Safe Links and Gmail's scanner open every URL in a message before a
// human sees it, and a GET that acted would fire pitches nobody chose to send.
// That is the whole reason the page has a button on it.
//
// `reason` is a machine key the page turns into a sentence: 'unknown',
// 'expired', 'used', 'gone', 'handled'.
async function lookup(pool, rawToken) {
  const raw = String(rawToken || '').trim();
  if (!raw) return { ok: false, reason: 'unknown' };
  let r;
  try {
    r = await pool.query(
      `SELECT t.id, t.pitch_id, t.agent_id, t.action, t.expires_at, t.used_at,
              COALESCE(l.athlete_id, t.athlete_id) AS athlete_id,
              l.status, l.approved_at, l.cadence_stopped_at, l.brand_name, l.subject,
              l.body_html, l.sent_to_email,
              COALESCE(al.data->>'name', at.data->>'name') AS athlete_name,
              q.contact_name
         FROM pitch_action_tokens t
         LEFT JOIN outreach_logs l ON l.id = t.pitch_id
         LEFT JOIN athletes al ON al.id = l.athlete_id
         LEFT JOIN athletes at ON at.id = t.athlete_id
         LEFT JOIN LATERAL (
           SELECT contact_name FROM outreach_queue q2
            WHERE q2.athlete_id = l.athlete_id AND LOWER(q2.brand_name) = LOWER(l.brand_name)
            ORDER BY q2.created_at DESC LIMIT 1
         ) q ON TRUE
        WHERE t.token_hash = $1`, [hashToken(raw)]);
  } catch (e) {
    console.error('[pitchActionTokens] lookup:', e.message);
    return { ok: false, reason: 'unknown' };
  }
  const row = r.rows[0];
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.used_at) return { ok: false, reason: 'used', row };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired', row };

  // ── APPROVE ALL: the subject is an athlete, not a draft ─────────────────
  // "Handled" here means the athlete has nothing left waiting, which is the
  // same sentence and the same page as a single pitch already dealt with.
  if (row.action === 'approve_all') {
    if (!row.athlete_id) return { ok: false, reason: 'gone', row };
    const pend = await pendingForAthlete(pool, row.agent_id, row.athlete_id);
    if (!pend.length) return { ok: false, reason: 'handled', row };
    return { ok: true, reason: null, row, pending: pend };
  }

  if (!row.status) return { ok: false, reason: 'gone', row };
  // Handled elsewhere -- in the dashboard, or by the sibling link. A real and
  // expected outcome, not an error, and it gets its own page.
  if (row.status !== 'draft' || row.approved_at || row.cadence_stopped_at) {
    return { ok: false, reason: 'handled', row };
  }
  return { ok: true, reason: null, row };
}

// Every draft still waiting for one athlete, oldest first. What "Approve all"
// acts on, read at TAP TIME and not at send time: a pitch skipped from the
// dashboard this morning is not in this list, so Approve all cannot resurrect
// a decision the agent already made.
async function pendingForAthlete(pool, agentId, athleteId) {
  try {
    const r = await pool.query(
      `SELECT id, brand_name, subject FROM outreach_logs
        WHERE agent_id = $1 AND athlete_id = $2
          AND status = 'draft' AND approved_at IS NULL AND cadence_stopped_at IS NULL
          AND (next_follow_up_at IS NULL OR next_follow_up_at <= NOW())
        ORDER BY created_at ASC`, [agentId, athleteId]);
    return r.rows;
  } catch (e) { console.error('[pitchActionTokens] pendingForAthlete:', e.message); return []; }
}

// ── CLAIM ───────────────────────────────────────────────────────────────────
// What POST calls, BEFORE doing the work. One statement: the UPDATE is the
// check. A second tap finds used_at already set and gets nothing back.
//
// The sibling is retired in the same breath, so the other button in the same
// email is dead the moment this one is pressed.
async function claim(pool, rawToken) {
  const raw = String(rawToken || '').trim();
  if (!raw) return { ok: false, reason: 'unknown' };
  const pre = await lookup(pool, raw);
  if (!pre.ok) return pre;
  let r;
  try {
    r = await pool.query(
      `UPDATE pitch_action_tokens SET used_at = NOW()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        RETURNING id, pitch_id, agent_id, action, athlete_id`, [hashToken(raw)]);
  } catch (e) {
    console.error('[pitchActionTokens] claim:', e.message);
    return { ok: false, reason: 'unknown' };
  }
  const got = r.rows[0];
  // Lost the race: somebody (or a second tap) claimed it between the lookup
  // and here. 'used' is the honest answer.
  if (!got) return { ok: false, reason: 'used', row: pre.row };
  // The other button in the same email dies with this one: an agent who just
  // approved must not be able to tap Skip ten seconds later and stop a pitch
  // that is already scheduled. Only for a pitch pair -- an approve_all token
  // has no pitch and no sibling, and `pitch_id IS NULL` would match every
  // other athlete's approve_all row in the table.
  if (got.pitch_id) {
    // EVERY other live token for this pitch, not just the sibling: the
    // confirmation page can mint a second pair for a pitch that already has
    // links in an email (issueFor's retirePrevious: false), and exactly one of
    // all of them may ever act.
    await pool.query(
      `UPDATE pitch_action_tokens SET used_at = NOW()
        WHERE pitch_id = $1 AND id <> $2 AND used_at IS NULL`, [got.pitch_id, got.id])
      .catch((e) => console.error('[pitchActionTokens] sibling:', e.message));
  }
  return { ok: true, reason: null, row: pre.row, claim: got };
}

// After the action: the agent's next pitch still waiting, so the confirmation
// page can offer it with its own buttons and the queue clears in a row rather
// than one email at a time.
async function nextPending(pool, agentId, excludeId) {
  try {
    const r = await pool.query(
      `SELECT l.id, l.brand_name, l.subject, l.body_html, l.athlete_id,
              a.data->>'name' AS athlete_name,
              q.contact_name
         FROM outreach_logs l
         JOIN athletes a ON a.id = l.athlete_id
         LEFT JOIN LATERAL (
           SELECT contact_name FROM outreach_queue q2
            WHERE q2.athlete_id = l.athlete_id AND LOWER(q2.brand_name) = LOWER(l.brand_name)
            ORDER BY q2.created_at DESC LIMIT 1
         ) q ON TRUE
        WHERE l.agent_id = $1 AND l.id <> COALESCE($2, '')
          AND l.status = 'draft' AND l.approved_at IS NULL AND l.cadence_stopped_at IS NULL
          AND (l.next_follow_up_at IS NULL OR l.next_follow_up_at <= NOW())
        ORDER BY l.created_at ASC LIMIT 1`, [agentId, excludeId || null]);
    return r.rows[0] || null;
  } catch (e) { console.error('[pitchActionTokens] nextPending:', e.message); return null; }
}

// How many are still waiting, for the confirmation page's line.
async function pendingCount(pool, agentId) {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM outreach_logs
        WHERE agent_id = $1 AND status = 'draft' AND approved_at IS NULL
          AND cadence_stopped_at IS NULL
          AND (next_follow_up_at IS NULL OR next_follow_up_at <= NOW())`, [agentId]);
    return (r.rows[0] && r.rows[0].n) || 0;
  } catch (_) { return 0; }
}

// Housekeeping: tokens that expired a fortnight ago are neither useful nor
// interesting. Called from the same tick that sends the digest.
async function purgeExpired(pool, olderThanDays) {
  const d = Math.max(1, Number(olderThanDays) || 14);
  try {
    const r = await pool.query(
      `DELETE FROM pitch_action_tokens WHERE expires_at < NOW() - ($1 || ' days')::interval`, [String(d)]);
    return r.rowCount || 0;
  } catch (e) { console.error('[pitchActionTokens] purgeExpired:', e.message); return 0; }
}

module.exports = {
  TOKEN_BYTES, TTL_MS, ACTIONS,
  hashToken, newToken, ensureTable,
  issueFor, issueApproveAll, issueForMany, lookup, claim,
  pendingForAthlete, nextPending, pendingCount, purgeExpired,
};
