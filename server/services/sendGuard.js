'use strict';
// ── THE SEND PATH HAS A CEILING NOW ──────────────────────────────────────────
//
// Before this there was no daily counter, no 429 handling, no 403 handling and
// no backoff anywhere between the dispatcher and gmail.users.messages.send. A
// cap hit threw raw into whatever the caller happened to catch.
//
// WHY 40, WHEN GOOGLE ALLOWS 500 OR 2,000.
//
// Google's cap is not the binding constraint and treating it as one is how you
// lose a mailbox. Personal gmail.com allows 500 recipients a day and Workspace
// 2,000, but cold outreach above roughly 50 a day reads to Gmail's filters as
// bulk sending, and the sender's reputation degrades over two to four weeks.
//
// That damage lands on the AGENT'S OWN MAILBOX -- the one they use for real
// client work, contracts and parents. A failed send is an inconvenience. A
// mailbox that quietly starts landing in spam is the business.
//
// So 40 is a DELIVERABILITY limit, deliberately far below the platform limit,
// and it is the number this file enforces. Scale is supposed to come from more
// mailboxes, not more volume per mailbox.
//
// EMAIL ONLY. DM, phone and program cards are not email and are not counted
// here -- only about a third of local businesses have a reachable address, so
// those channels carry most of the volume and none of the reputation risk.

const DEFAULT_DAILY_CAP = parseInt(process.env.AGENT_DAILY_EMAIL_CAP, 10) || 40;

// A cap that resets at UTC midnight resets in the middle of the afternoon for an
// agent in Hawaii. The reset is the agent's OWN midnight, from users.report_tz,
// which they already set for their daily report.
const DEFAULT_TZ = 'America/Chicago';

function localDate(tz, ms) {
  const zone = tz && /^[A-Za-z]+\/[A-Za-z_]+$/.test(tz) ? tz : DEFAULT_TZ;
  try {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return f.format(new Date(ms == null ? Date.now() : ms));   // YYYY-MM-DD
  } catch (_) {
    return new Date(ms == null ? Date.now() : ms).toISOString().slice(0, 10);
  }
}

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_send_budget (
      agent_id       TEXT NOT NULL,
      local_date     DATE NOT NULL,
      sent           INT  NOT NULL DEFAULT 0,
      cap            INT  NOT NULL,
      blocked_at     TIMESTAMPTZ,
      blocked_reason TEXT,
      last_send_at   TIMESTAMPTZ,
      PRIMARY KEY (agent_id, local_date)
    )`).catch((e) => console.error('[sendGuard] ensureTable:', e.message));
}

async function capFor(pool, agentId) {
  try {
    const r = await pool.query(
      `SELECT daily_email_cap, report_tz FROM users WHERE id = $1`, [agentId]);
    const row = r.rows[0] || {};
    const cap = Number(row.daily_email_cap);
    return {
      cap: Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_DAILY_CAP,
      tz: row.report_tz || DEFAULT_TZ,
    };
  } catch (_) {
    return { cap: DEFAULT_DAILY_CAP, tz: DEFAULT_TZ };
  }
}

// Read-only view of where an agent stands today. Used by the shift report and
// by the allocator, neither of which should be reserving anything.
async function status(pool, agentId, opts = {}) {
  const { cap, tz } = opts.cap ? { cap: opts.cap, tz: opts.tz || DEFAULT_TZ } : await capFor(pool, agentId);
  const day = localDate(tz, opts.now);
  try {
    const r = await pool.query(
      `SELECT sent, cap, blocked_at, blocked_reason FROM agent_send_budget
        WHERE agent_id = $1 AND local_date = $2`, [agentId, day]);
    const row = r.rows[0];
    const used = row ? Number(row.sent) : 0;
    // THE LIVE CAP WINS OVER THE SNAPSHOT. agent_send_budget.cap is a copy taken
    // on the first send of the day, so reading it back meant a limit raised at
    // 9am did not apply until tomorrow -- the agent whose ceiling you just
    // raised keeps being told they are at 40 of 40. users.daily_email_cap is the
    // setting; this row is a counter.
    const effCap = cap;
    return {
      day, tz, cap: effCap, used,
      remaining: Math.max(0, effCap - used),
      blocked: !!(row && row.blocked_at),
      blockedReason: (row && row.blocked_reason) || null,
    };
  } catch (e) {
    console.error('[sendGuard] status:', e.message);
    // A guard that cannot read its own counter must not hand out permission.
    return { day, tz, cap, used: cap, remaining: 0, blocked: true,
      blockedReason: 'could not read the send counter, so nothing is being sent' };
  }
}

// ── RESERVE, DO NOT CHECK-THEN-INCREMENT ─────────────────────────────────────
// The Hunter budget was overspent twice by exactly this mistake: reading a
// count, comparing it, and incrementing in a later tick. Concurrent sends both
// pass the comparison and both spend. The increment IS the check here -- one
// statement, and the WHERE clause is what enforces the cap.
async function reserve(pool, agentId, opts = {}) {
  const { cap, tz } = opts.cap ? { cap: opts.cap, tz: opts.tz || DEFAULT_TZ } : await capFor(pool, agentId);
  const day = localDate(tz, opts.now);
  try {
    const r = await pool.query(
      `INSERT INTO agent_send_budget (agent_id, local_date, sent, cap, last_send_at)
       VALUES ($1, $2, 1, $3, NOW())
       ON CONFLICT (agent_id, local_date) DO UPDATE
         -- cap is re-stamped from the live per-account setting, and the WHERE
         -- tests against EXCLUDED rather than the stored copy. Without this the
         -- ceiling an agent is held to is whatever it was on their first send of
         -- the day, so raising a limit took effect tomorrow rather than now.
         -- Still one atomic statement: the increment IS the check.
         SET sent = agent_send_budget.sent + 1, cap = EXCLUDED.cap, last_send_at = NOW()
       WHERE agent_send_budget.sent < EXCLUDED.cap
         AND agent_send_budget.blocked_at IS NULL
       RETURNING sent, cap`,
      [agentId, day, cap]);
    if (r.rowCount > 0) {
      const row = r.rows[0];
      return { ok: true, used: Number(row.sent), cap: Number(row.cap),
        remaining: Math.max(0, Number(row.cap) - Number(row.sent)), day, tz };
    }
    // Refused. Say WHICH refusal it was: a cap and a block are different
    // problems and the shift report has to tell them apart.
    const st = await status(pool, agentId, { cap, tz, now: opts.now });
    return { ok: false, ...st,
      reason: st.blocked
        ? st.blockedReason
        : `today's ${st.cap}-email ceiling is reached` };
  } catch (e) {
    console.error('[sendGuard] reserve:', e.message);
    return { ok: false, day, tz, cap, used: cap, remaining: 0, blocked: true,
      reason: 'could not reserve against the send counter, so nothing was sent' };
  }
}

// Give the reservation back when the send did not actually go out. Without this
// a transient failure silently eats the day's allowance.
async function release(pool, agentId, opts = {}) {
  const { tz } = opts.tz ? { tz: opts.tz } : await capFor(pool, agentId);
  const day = localDate(tz, opts.now);
  await pool.query(
    `UPDATE agent_send_budget SET sent = GREATEST(0, sent - 1)
      WHERE agent_id = $1 AND local_date = $2`, [agentId, day]).catch(() => {});
}

// A 403 quota refusal is not retryable and not a per-message problem: Gmail can
// keep refusing for hours. Stop this agent for the rest of their day rather than
// hammering an account that is already unhappy with us.
async function blockForDay(pool, agentId, reason, opts = {}) {
  const { cap, tz } = opts.cap ? { cap: opts.cap, tz: opts.tz || DEFAULT_TZ } : await capFor(pool, agentId);
  const day = localDate(tz, opts.now);
  await pool.query(
    `INSERT INTO agent_send_budget (agent_id, local_date, sent, cap, blocked_at, blocked_reason)
     VALUES ($1,$2,0,$3,NOW(),$4)
     ON CONFLICT (agent_id, local_date) DO UPDATE
       SET blocked_at = NOW(), blocked_reason = $4`,
    [agentId, day, cap, String(reason || 'the mail provider refused on quota').slice(0, 300)]
  ).catch((e) => console.error('[sendGuard] blockForDay:', e.message));
}

// ── WHAT THE PROVIDER IS ACTUALLY TELLING US ─────────────────────────────────
// Gmail does not silently throttle -- it fails loudly, and the two failures mean
// opposite things:
//   429 rateLimitExceeded / userRateLimitExceeded  too fast. Wait and retry.
//   403 quota / dailyLimitExceeded                 too much. Stop for the day.
// Retrying into a 403 is how a temporary refusal becomes a longer one.
//
// There is a third failure this cannot see: a 200 OK on a message that lands in
// spam. Nothing in the response says so. That is what the 40 ceiling is for.
function classifyError(err) {
  const code = Number(err && (err.code || err.status
    || (err.response && err.response.status))) || 0;
  const raw = JSON.stringify((err && err.errors) || (err && err.response && err.response.data) || '')
    + ' ' + String((err && err.message) || '');
  const reason = raw.toLowerCase();

  if (code === 429 || /ratelimitexceeded|user-rate limit|userratelimit/.test(reason)) {
    return { kind: 'rate', retryable: true, retryAfterMs: retryAfterOf(err) };
  }
  if (code === 403 && /quota|daily limit|dailylimitexceeded|limitexceeded/.test(reason)) {
    return { kind: 'quota', retryable: false,
      detail: 'the mail provider refused on quota' };
  }
  // ── A MISSING SCOPE IS NOT A REJECTED CONNECTION ────────────────────────
  // Google answers an ungranted gmail.send with 403 "Request had insufficient
  // authentication scopes", which fell through to the generic auth branch below
  // and came out as "needs reconnecting". True, but it is the same sentence we
  // print for a revoked token -- and a plain reconnect does NOT fix this one,
  // because gmail.send is a sensitive scope with its own checkbox that the agent
  // has to tick. The instruction has to name the checkbox or they will reconnect,
  // decline it again, and land back here.
  //
  // AHEAD of the 401/403 branch on purpose: order is the whole behaviour.
  if (/insufficient authentication scopes|insufficientpermissions|insufficient_scope|accessnotconfigured/.test(reason)) {
    return { kind: 'scope', retryable: false,
      detail: 'the mailbox is connected but was not given permission to send email — '
        + 'reconnect Google and tick "Send email on your behalf"' };
  }
  if (code === 401 || code === 403) {
    return { kind: 'auth', retryable: false,
      detail: 'the mailbox connection was rejected, so it needs reconnecting' };
  }
  if (code >= 500) return { kind: 'server', retryable: true, retryAfterMs: null };
  return { kind: 'other', retryable: false, detail: (err && err.message) || 'send failed' };
}

function retryAfterOf(err) {
  const h = (err && err.response && err.response.headers) || {};
  const v = h['retry-after'] || h['Retry-After'];
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(v);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 64000;
const MAX_ATTEMPTS = 5;

// RESPECT retry-after WHEN THE SERVER SENDS ONE. Truncated exponential backoff
// is the fallback for when it does not, per Google's own guidance. Jittered, so
// a batch of sends that all trip the limit together do not all retry together.
function backoffMs(attempt, retryAfterMs, rnd) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(retryAfterMs, MAX_BACKOFF_MS);
  }
  const base = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  const jitter = (typeof rnd === 'number' ? rnd : Math.random()) * 1000;
  return Math.round(base + jitter);
}

// Run one send with the retry policy. `fn` does the actual provider call.
// onQuota is called once if the provider refuses on quota, so the caller can
// stop the whole agent rather than walking the rest of the batch into the wall.
async function sendWithRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let attempt = 0;
  let last = null;
  while (attempt < maxAttempts) {
    try {
      const out = await fn();
      return { ok: true, result: out, attempts: attempt + 1 };
    } catch (e) {
      last = e;
      const c = classifyError(e);
      if (c.kind === 'quota') {
        if (opts.onQuota) await opts.onQuota(c);
        return { ok: false, kind: 'quota', error: e, detail: c.detail, attempts: attempt + 1 };
      }
      if (!c.retryable) {
        return { ok: false, kind: c.kind, error: e, detail: c.detail, attempts: attempt + 1 };
      }
      attempt++;
      if (attempt >= maxAttempts) break;
      const wait = backoffMs(attempt - 1, c.retryAfterMs, opts.rnd);
      if (opts.onRetry) opts.onRetry({ attempt, waitMs: wait, kind: c.kind });
      await sleep(wait);
    }
  }
  return { ok: false, kind: 'rate', error: last, attempts: attempt,
    detail: `gave up after ${attempt} attempts against the provider's rate limit` };
}

module.exports = {
  ensureTable, status, reserve, release, blockForDay, capFor,
  classifyError, retryAfterOf, backoffMs, sendWithRetry, localDate,
  DEFAULT_DAILY_CAP, DEFAULT_TZ, MAX_ATTEMPTS, MAX_BACKOFF_MS,
};
