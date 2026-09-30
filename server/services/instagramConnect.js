'use strict';
// ── INSTAGRAM STATS, FROM INSTAGRAM, BY THE ATHLETE'S CONSENT ────────────────
//
// Follower and engagement numbers were typed in by hand or scraped by third
// parties, and both were wrong: the hand-typed fields were almost always blank,
// and the data providers returned inaccurate counts. The only exact source is
// Instagram itself, and it requires the ATHLETE to authorise once.
//
// So: the agent (our user) sends the athlete a link; the athlete taps Connect
// Instagram and Allow; from then on we read the real numbers, on connect and
// nightly. Instagram Login (NOT Facebook Login), scope instagram_business_basic
// only.
//
//   1. createInvite        agent -> a single-use, expiring token for one athlete
//   2. /athlete/connect/:t the athlete's page (no login): name, agent, one button
//   3. /api/instagram/start/:t -> instagram.com/oauth/authorize (state = token)
//   4. /api/instagram/callback  code -> short token -> long-lived (60 day) token,
//                               stored encrypted; stats fetched immediately
//   5. nightly               refresh tokens well before expiry, then re-fetch;
//                               a token that cannot be refreshed is an alert
//   6. deauthorize / data-deletion   Meta's two callbacks, signed_request verified
//
// WHAT IS STORED. The raw inputs, not just a percentage: followers, follows,
// media count, and each of the last 12 posts' likes and comments with their
// timestamp and type, plus fetched_at -- so the engagement formula can change
// without refetching. The athlete record's instagram / engagement fields are
// written from the latest fetch with source 'instagram' (services/
// reachProvenance), which makes every reader treat them as live.
//
// NEVER A ZERO THAT IS NOT REAL. An athlete who has not connected has no
// Instagram number: status says "not connected", never "0".
const crypto = require('crypto');
const C = require('./crypto');

const AUTHORIZE_URL = 'https://www.instagram.com/oauth/authorize';
const TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const LONG_LIVED_URL = 'https://graph.instagram.com/access_token';
const REFRESH_URL = 'https://graph.instagram.com/refresh_access_token';
const GRAPH = 'https://graph.instagram.com';
const SCOPE = 'instagram_business_basic';
const INVITE_DAYS = parseInt(process.env.INSTAGRAM_INVITE_DAYS, 10) || 14;
// Refresh when a long-lived token has this many days or fewer left (tokens last
// 60 days, refreshable once 24h old). Nightly, so a token is tried ~20 times
// before it would lapse.
const REFRESH_WHEN_DAYS_LEFT = parseInt(process.env.INSTAGRAM_REFRESH_DAYS_LEFT, 10) || 20;
const MEDIA_LIMIT = 12;

const appId = () => String(process.env.INSTAGRAM_APP_ID || '').trim();
const appSecret = () => String(process.env.INSTAGRAM_APP_SECRET || '').trim();
const redirectUri = () => String(process.env.INSTAGRAM_REDIRECT_URI || 'https://mynildash.com/api/instagram/callback').trim();
const publicBase = () => String(process.env.PUBLIC_BASE_URL || 'https://mynildash.com').replace(/\/+$/, '');
const configured = () => !!(appId() && appSecret());

async function ensureTables(pool) {
  for (const sql of [
    // Its own table: athlete_invite_tokens is the athlete-PORTAL invite, and
    // issuing one of those invalidates the athlete's other unused ones.
    `CREATE TABLE IF NOT EXISTS instagram_connect_tokens (
       token       TEXT PRIMARY KEY,
       athlete_id  TEXT NOT NULL,
       agent_id    TEXT,
       created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       expires_at  TIMESTAMPTZ NOT NULL,
       used_at     TIMESTAMPTZ,
       revoked_at  TIMESTAMPTZ
     )`,
    `CREATE INDEX IF NOT EXISTS idx_ig_connect_tokens_athlete ON instagram_connect_tokens (athlete_id)`,
    `CREATE TABLE IF NOT EXISTS instagram_connections (
       athlete_id        TEXT PRIMARY KEY,
       agent_id          TEXT,
       ig_user_id        TEXT,
       username          TEXT,
       access_token_enc  TEXT,
       token_expires_at  TIMESTAMPTZ,
       token_issued_at   TIMESTAMPTZ,
       status            TEXT NOT NULL DEFAULT 'connected',
       status_reason     TEXT,
       connected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       last_synced_at    TIMESTAMPTZ,
       last_sync_error   TEXT,
       updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_ig_connections_user ON instagram_connections (ig_user_id)`,
    `CREATE TABLE IF NOT EXISTS instagram_stats (
       id               SERIAL PRIMARY KEY,
       athlete_id       TEXT NOT NULL,
       ig_user_id       TEXT,
       username         TEXT,
       fetched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       followers_count  INT,
       follows_count    INT,
       media_count      INT,
       posts            JSONB,
       posts_counted    INT,
       avg_likes        NUMERIC,
       avg_comments     NUMERIC,
       engagement_rate  NUMERIC
     )`,
    `CREATE INDEX IF NOT EXISTS idx_ig_stats_athlete ON instagram_stats (athlete_id, fetched_at DESC)`,
    `CREATE TABLE IF NOT EXISTS instagram_deletion_requests (
       confirmation_code TEXT PRIMARY KEY,
       ig_user_id        TEXT,
       athlete_ids       TEXT[],
       requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       completed_at      TIMESTAMPTZ,
       status            TEXT NOT NULL DEFAULT 'received'
     )`,
    `CREATE TABLE IF NOT EXISTS instagram_sync_runs (
       run_date    DATE PRIMARY KEY,
       started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       finished_at TIMESTAMPTZ,
       summary     JSONB
     )`,
  ]) await pool.query(sql);
}

// ── 1. THE INVITE ───────────────────────────────────────────────────────────
async function createInvite(pool, { athleteId, agentId, days }) {
  await ensureTables(pool);
  // One live link per athlete: a new one retires the old.
  await pool.query(`UPDATE instagram_connect_tokens SET revoked_at = NOW()
                     WHERE athlete_id = $1 AND used_at IS NULL AND revoked_at IS NULL`, [athleteId]);
  const token = crypto.randomBytes(24).toString('base64url');
  const d = Number(days) > 0 ? Number(days) : INVITE_DAYS;
  const r = await pool.query(
    `INSERT INTO instagram_connect_tokens (token, athlete_id, agent_id, expires_at)
     VALUES ($1,$2,$3, NOW() + ($4 || ' days')::interval) RETURNING expires_at`, [token, athleteId, agentId || null, String(d)]);
  return { token, url: `${publicBase()}/athlete/connect/${token}`, expiresAt: r.rows[0].expires_at };
}

// A token's state: { ok, reason, athleteId, agentId, athleteName, agentName }.
async function readInvite(pool, token) {
  await ensureTables(pool);
  if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(String(token))) return { ok: false, reason: 'invalid' };
  const r = await pool.query(
    `SELECT t.*, a.data->>'name' AS athlete_name, u.name AS agent_name
       FROM instagram_connect_tokens t
       LEFT JOIN athletes a ON a.id = t.athlete_id
       LEFT JOIN users u ON u.id = t.agent_id
      WHERE t.token = $1`, [token]);
  const t = r.rows[0];
  if (!t) return { ok: false, reason: 'invalid' };
  const base = { athleteId: t.athlete_id, agentId: t.agent_id, athleteName: t.athlete_name || null, agentName: t.agent_name || null };
  if (t.used_at) return { ...base, ok: false, reason: 'used' };
  if (t.revoked_at) return { ...base, ok: false, reason: 'replaced' };
  if (new Date(t.expires_at).getTime() < Date.now()) return { ...base, ok: false, reason: 'expired' };
  if (!t.athlete_name) return { ...base, ok: false, reason: 'invalid' };
  return { ...base, ok: true };
}

function authorizeUrl(token) {
  const q = new URLSearchParams({ client_id: appId(), redirect_uri: redirectUri(), response_type: 'code', scope: SCOPE, state: token });
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

// ── HTTP, with Instagram's own error words kept ─────────────────────────────
async function _call(fetchFn, url, init) {
  const f = fetchFn || globalThis.fetch;
  let res, body = null, text = '';
  try {
    res = await f(url, { ...(init || {}), signal: AbortSignal.timeout(20000) });
    text = await res.text();
    try { body = JSON.parse(text); } catch (_) { body = null; }
  } catch (e) {
    return { ok: false, status: 0, error: `could not reach Instagram: ${e.message}`, fault: true };
  }
  if (!res.ok || (body && body.error)) {
    const err = body && body.error;
    const msg = err ? (typeof err === 'string' ? `${err}${body.error_description ? ': ' + body.error_description : ''}` : `${err.type || ''} ${err.code || ''}: ${err.message || ''}`.trim())
      : (body && body.error_message) || `HTTP ${res.status} ${text.slice(0, 200)}`;
    // 190 / OAuthException: the token is not valid any more (expired, revoked,
    // password changed). Anything else is a request that failed.
    const code = err && typeof err === 'object' ? Number(err.code) : null;
    const invalidToken = code === 190 || (err && err.type === 'OAuthException' && /token|session/i.test(err.message || ''));
    return { ok: false, status: res.status, error: msg, invalidToken, fault: res.status >= 500 || res.status === 429 };
  }
  return { ok: true, status: res.status, body };
}

// code -> short-lived token -> long-lived token
async function exchangeCode(code, opts = {}) {
  const clean = String(code || '').replace(/#_$/, '');
  const form = new URLSearchParams({ client_id: appId(), client_secret: appSecret(), grant_type: 'authorization_code',
    redirect_uri: redirectUri(), code: clean });
  const short = await _call(opts.fetch, TOKEN_URL, { method: 'POST', body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (!short.ok) return { ok: false, step: 'code', error: short.error, fault: short.fault };
  const s = short.body || {};
  const shortToken = s.access_token || (Array.isArray(s.data) && s.data[0] && s.data[0].access_token);
  const userId = s.user_id || (Array.isArray(s.data) && s.data[0] && s.data[0].user_id);
  if (!shortToken) return { ok: false, step: 'code', error: 'Instagram returned no access token' };
  const q = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: appSecret(), access_token: shortToken });
  const long = await _call(opts.fetch, `${LONG_LIVED_URL}?${q}`);
  if (!long.ok) return { ok: false, step: 'long-lived', error: long.error, fault: long.fault };
  const expiresIn = Number(long.body.expires_in) || 60 * 86400;
  return { ok: true, accessToken: long.body.access_token, userId: userId ? String(userId) : null, expiresIn };
}

async function refreshToken(accessToken, opts = {}) {
  const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: accessToken });
  const r = await _call(opts.fetch, `${REFRESH_URL}?${q}`);
  if (!r.ok) return { ok: false, error: r.error, invalidToken: r.invalidToken, fault: r.fault };
  return { ok: true, accessToken: r.body.access_token, expiresIn: Number(r.body.expires_in) || 60 * 86400 };
}

// ── 4. THE NUMBERS ──────────────────────────────────────────────────────────
// engagement rate = (avg likes + avg comments over the last 12 posts) / followers.
// A post whose like count Instagram withholds (hidden likes) has no like_count:
// it is left out of the likes average rather than counted as zero.
function computeEngagement(followers, posts) {
  const list = Array.isArray(posts) ? posts : [];
  const liked = list.filter((p) => Number.isFinite(Number(p.like_count)) && p.like_count !== null && p.like_count !== undefined);
  const commented = list.filter((p) => Number.isFinite(Number(p.comments_count)) && p.comments_count !== null && p.comments_count !== undefined);
  const avg = (xs, k) => (xs.length ? xs.reduce((s, p) => s + Number(p[k]), 0) / xs.length : null);
  const avgLikes = avg(liked, 'like_count');
  const avgComments = avg(commented, 'comments_count');
  const f = Number(followers);
  const rate = f > 0 && (avgLikes !== null || avgComments !== null) ? ((avgLikes || 0) + (avgComments || 0)) / f : null;
  return { postsCounted: list.length, avgLikes, avgComments, engagementRate: rate };
}

async function fetchStats(accessToken, opts = {}) {
  const me = await _call(opts.fetch, `${GRAPH}/me?${new URLSearchParams({ fields: 'user_id,username,followers_count,follows_count,media_count', access_token: accessToken })}`);
  if (!me.ok) return { ok: false, error: me.error, invalidToken: me.invalidToken, fault: me.fault };
  const media = await _call(opts.fetch, `${GRAPH}/me/media?${new URLSearchParams({ fields: 'id,like_count,comments_count,timestamp,media_type', limit: String(MEDIA_LIMIT), access_token: accessToken })}`);
  if (!media.ok) return { ok: false, error: media.error, invalidToken: media.invalidToken, fault: media.fault };
  const posts = ((media.body && media.body.data) || []).slice(0, MEDIA_LIMIT).map((p) => ({
    id: p.id, like_count: p.like_count === undefined ? null : p.like_count, comments_count: p.comments_count === undefined ? null : p.comments_count,
    timestamp: p.timestamp || null, media_type: p.media_type || null }));
  const b = me.body || {};
  const followers = b.followers_count === undefined ? null : Number(b.followers_count);
  return { ok: true, userId: b.user_id ? String(b.user_id) : (b.id ? String(b.id) : null), username: b.username || null,
    followers, follows: b.follows_count === undefined ? null : Number(b.follows_count),
    mediaCount: b.media_count === undefined ? null : Number(b.media_count), posts, ...computeEngagement(followers, posts) };
}

// Store a fetch, and write the athlete record's live fields from it.
async function saveStats(pool, athleteId, s) {
  const at = new Date();
  await pool.query(
    `INSERT INTO instagram_stats (athlete_id, ig_user_id, username, fetched_at, followers_count, follows_count, media_count, posts, posts_counted, avg_likes, avg_comments, engagement_rate)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)`,
    [athleteId, s.userId, s.username, at, s.followers, s.follows, s.mediaCount, JSON.stringify(s.posts || []), s.postsCounted,
      s.avgLikes, s.avgComments, s.engagementRate]);
  // The athlete record: live, sourced and dated (services/reachProvenance).
  const patch = { instagramHandle: s.username || undefined, igStatsSource: 'instagram_connect', igStatsFetchedAt: at.toISOString() };
  if (Number.isFinite(s.followers)) Object.assign(patch, { instagram: s.followers, reachSource: 'instagram', reachAsOf: at.toISOString().slice(0, 10) });
  if (s.engagementRate !== null && s.engagementRate !== undefined) {
    Object.assign(patch, { engagement: Math.round(s.engagementRate * 10000) / 100, engagementSource: 'instagram', engagementAsOf: at.toISOString().slice(0, 10) });
  }
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
  await pool.query(`UPDATE athletes SET data = COALESCE(data, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [athleteId, JSON.stringify(patch)]);
  return at;
}

// ── 4b. CALLBACK ────────────────────────────────────────────────────────────
// { ok, athleteName, username, followers } or { ok:false, reason, message }
async function handleCallback(pool, { code, state, error, errorReason }, opts = {}) {
  await ensureTables(pool);
  const inv = await readInvite(pool, state);
  if (!inv.ok) return { ok: false, reason: inv.reason, message: inviteMessage(inv.reason) };
  if (error || !code) {
    // The athlete said no, or backed out. The link stays good for another try.
    return { ok: false, reason: 'declined', athleteName: inv.athleteName,
      message: errorReason === 'user_denied' || error === 'access_denied'
        ? 'You chose not to connect. Nothing was shared. You can use this link again if you change your mind.'
        : 'Instagram did not complete the connection. Nothing was shared. You can try this link again.' };
  }
  // SINGLE USE: claimed before anything is exchanged.
  const claim = await pool.query(`UPDATE instagram_connect_tokens SET used_at = NOW() WHERE token = $1 AND used_at IS NULL RETURNING athlete_id`, [state]);
  if (!claim.rowCount) return { ok: false, reason: 'used', message: inviteMessage('used') };
  const release = () => pool.query(`UPDATE instagram_connect_tokens SET used_at = NULL WHERE token = $1`, [state]).catch(() => {});
  if (!configured()) {
    await release();
    require('./ourFault').record('instagram', 'INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET not set; an athlete could not connect', 'instagram callback').catch(() => {});
    return { ok: false, reason: 'unavailable', message: 'Instagram connection is not available right now. Nothing was shared. Please try your link again later.' };
  }
  const ex = await exchangeCode(code, opts);
  if (!ex.ok) {
    // Our side or Instagram's: the athlete can try the same link again.
    await release();
    require('./ourFault').record('instagram', `token exchange (${ex.step}) failed for athlete ${inv.athleteId}: ${ex.error}`, 'instagram callback').catch(() => {});
    return { ok: false, reason: 'exchange', message: 'Instagram did not finish connecting. Nothing was shared. Please try your link again.' };
  }
  await pool.query(
    `INSERT INTO instagram_connections (athlete_id, agent_id, ig_user_id, access_token_enc, token_expires_at, token_issued_at, status, status_reason, connected_at, updated_at)
     VALUES ($1,$2,$3,$4, NOW() + ($5 || ' seconds')::interval, NOW(), 'connected', NULL, NOW(), NOW())
     ON CONFLICT (athlete_id) DO UPDATE SET agent_id = EXCLUDED.agent_id, ig_user_id = EXCLUDED.ig_user_id,
       access_token_enc = EXCLUDED.access_token_enc, token_expires_at = EXCLUDED.token_expires_at, token_issued_at = NOW(),
       status = 'connected', status_reason = NULL, connected_at = NOW(), updated_at = NOW()`,
    [inv.athleteId, inv.agentId, ex.userId, C.encrypt(ex.accessToken), String(ex.expiresIn)]);
  const sync = await syncAthlete(pool, inv.athleteId, opts);
  return { ok: true, athleteName: inv.athleteName, agentName: inv.agentName, username: sync.username || null,
    followers: sync.ok ? sync.followers : null, synced: sync.ok, syncError: sync.ok ? null : sync.error };
}

function inviteMessage(reason) {
  return {
    used: 'This link has already been used. If you need to reconnect, ask your agent for a new link.',
    expired: 'This link has expired. Ask your agent to send you a new one.',
    replaced: 'Your agent has sent you a newer link. Please use the most recent one.',
    invalid: 'This link is not valid. Ask your agent to send you a new one.',
  }[reason] || 'This link is not valid. Ask your agent to send you a new one.';
}

// ── 5. SYNC, REFRESH ────────────────────────────────────────────────────────
async function markStatus(pool, athleteId, status, reason) {
  await pool.query(`UPDATE instagram_connections SET status = $2, status_reason = $3, updated_at = NOW() WHERE athlete_id = $1`,
    [athleteId, status, reason ? String(reason).slice(0, 500) : null]);
}

async function syncAthlete(pool, athleteId, opts = {}) {
  const c = (await pool.query(`SELECT * FROM instagram_connections WHERE athlete_id = $1`, [athleteId])).rows[0];
  if (!c || c.status !== 'connected') return { ok: false, error: 'not connected' };
  const token = C.decrypt(c.access_token_enc);
  if (!token) return { ok: false, error: 'stored token could not be decrypted' };
  const s = await fetchStats(token, opts);
  if (!s.ok) {
    await pool.query(`UPDATE instagram_connections SET last_sync_error = $2, updated_at = NOW() WHERE athlete_id = $1`, [athleteId, String(s.error).slice(0, 500)]);
    if (s.invalidToken) {
      await markStatus(pool, athleteId, 'expired', s.error);
      await alertTokenLost(pool, athleteId, s.error);
    } else {
      require('./ourFault').record('instagram', `stats fetch failed for athlete ${athleteId}: ${s.error}`, 'instagram sync').catch(() => {});
    }
    return { ok: false, error: s.error };
  }
  const at = await saveStats(pool, athleteId, s);
  await pool.query(`UPDATE instagram_connections SET username = $2, ig_user_id = COALESCE($3, ig_user_id), last_synced_at = $4, last_sync_error = NULL, updated_at = NOW() WHERE athlete_id = $1`,
    [athleteId, s.username, s.userId, at]);
  return { ok: true, username: s.username, followers: s.followers, engagementRate: s.engagementRate, fetchedAt: at };
}

async function alertTokenLost(pool, athleteId, why) {
  const a = (await pool.query(`SELECT a.data->>'name' AS name, u.name AS agent FROM athletes a LEFT JOIN users u ON u.id = a.agent_id WHERE a.id = $1`, [athleteId])).rows[0] || {};
  await require('./ourFault').record('instagram-token',
    `${a.name || athleteId} (agent ${a.agent || '?'}): Instagram token could not be used or refreshed; the athlete must reconnect. ${String(why || '').slice(0, 200)}`,
    'instagram athlete=' + athleteId).catch(() => {});
}

// Tokens with REFRESH_WHEN_DAYS_LEFT or fewer days left, at least 24h old.
async function refreshDue(pool, opts = {}) {
  const rows = (await pool.query(
    `SELECT athlete_id, access_token_enc, token_expires_at FROM instagram_connections
      WHERE status = 'connected' AND token_expires_at < NOW() + ($1 || ' days')::interval
        AND token_issued_at < NOW() - INTERVAL '24 hours'`, [String(REFRESH_WHEN_DAYS_LEFT)])).rows;
  const out = { due: rows.length, refreshed: 0, failed: [] };
  for (const r of rows) {
    const token = C.decrypt(r.access_token_enc);
    const res = token ? await refreshToken(token, opts) : { ok: false, error: 'stored token could not be decrypted' };
    if (res.ok) {
      await pool.query(`UPDATE instagram_connections SET access_token_enc = $2, token_expires_at = NOW() + ($3 || ' seconds')::interval,
                          token_issued_at = NOW(), updated_at = NOW() WHERE athlete_id = $1`, [r.athlete_id, C.encrypt(res.accessToken), String(res.expiresIn)]);
      out.refreshed++;
    } else {
      out.failed.push({ athleteId: r.athlete_id, error: res.error });
      const lapsed = new Date(r.token_expires_at).getTime() < Date.now();
      if (res.invalidToken || lapsed) await markStatus(pool, r.athlete_id, 'expired', res.error);
      // Alert every time it fails: there are ~20 nightly tries before it lapses.
      await alertTokenLost(pool, r.athlete_id, `refresh failed: ${res.error}${lapsed ? '' : ` (expires ${new Date(r.token_expires_at).toISOString().slice(0, 10)})`}`);
    }
  }
  // A token past its expiry that nobody refreshed is expired, whatever else.
  await pool.query(`UPDATE instagram_connections SET status = 'expired', status_reason = COALESCE(status_reason, 'token expired'), updated_at = NOW()
                     WHERE status = 'connected' AND token_expires_at < NOW()`);
  return out;
}

async function nightly(pool, opts = {}) {
  await ensureTables(pool);
  const refresh = await refreshDue(pool, opts);
  const ids = (await pool.query(`SELECT athlete_id FROM instagram_connections WHERE status = 'connected'`)).rows.map((r) => r.athlete_id);
  const out = { refresh, synced: 0, failed: [] };
  for (const id of ids) {
    const r = await syncAthlete(pool, id, opts);
    if (r.ok) out.synced++; else out.failed.push({ athleteId: id, error: r.error });
  }
  return out;
}

// Once per Central date, 5am to 7am (after the nightly fill, before agents
// wake). The date row is claimed first.
function centralParts(ms) {
  const d = new Date(ms == null ? Date.now() : ms);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d);
  const hour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(d), 10) % 24;
  return { date, hour };
}
async function tick(pool, opts = {}) {
  const { date, hour } = centralParts(opts.now);
  if (!opts.force && !(hour >= 5 && hour < 7)) return { ran: false, why: 'outside the window' };
  await ensureTables(pool);
  const claim = await pool.query(`INSERT INTO instagram_sync_runs (run_date) VALUES ($1) ON CONFLICT DO NOTHING RETURNING run_date`, [date]);
  if (!claim.rowCount) return { ran: false, why: 'already ran for ' + date };
  const res = await nightly(pool, opts);
  await pool.query(`UPDATE instagram_sync_runs SET finished_at = NOW(), summary = $2 WHERE run_date = $1`, [date, res]);
  console.log(`[instagram] ${date}: ${res.refresh.refreshed} of ${res.refresh.due} token(s) refreshed, ${res.synced} athlete(s) synced, `
    + `${res.failed.length + res.refresh.failed.length} failure(s)`);
  return { ran: true, ...res };
}

// ── 6. META'S CALLBACKS ─────────────────────────────────────────────────────
// signed_request = base64url(signature) . base64url(payload), HMAC-SHA256 with
// the app secret. Returns the payload, or null when it does not verify.
function parseSignedRequest(signed, secret) {
  const s = String(signed || '');
  const [sig, payload] = s.split('.');
  if (!sig || !payload) return null;
  const key = secret || appSecret();
  if (!key) return null;
  const expected = crypto.createHmac('sha256', key).update(payload).digest();
  const got = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (data.algorithm && String(data.algorithm).toUpperCase() !== 'HMAC-SHA256') return null;
    return data;
  } catch (_) { return null; }
}

// The user removed our app: disconnected, token deleted.
async function deauthorize(pool, igUserId) {
  await ensureTables(pool);
  const r = await pool.query(`UPDATE instagram_connections SET status = 'disconnected', status_reason = 'removed by the athlete in Instagram',
                                access_token_enc = NULL, updated_at = NOW() WHERE ig_user_id = $1 RETURNING athlete_id`, [String(igUserId)]);
  return { athleteIds: r.rows.map((x) => x.athlete_id) };
}

// A data deletion request: everything we fetched from Instagram for this user
// is deleted -- the token, every stats row, and the live fields on the athlete
// record. The request is recorded with a confirmation code Meta shows the user.
async function deleteData(pool, igUserId) {
  await ensureTables(pool);
  const code = crypto.randomBytes(10).toString('hex');
  const ids = (await pool.query(`SELECT athlete_id FROM instagram_connections WHERE ig_user_id = $1`, [String(igUserId)])).rows.map((r) => r.athlete_id);
  await pool.query(`INSERT INTO instagram_deletion_requests (confirmation_code, ig_user_id, athlete_ids) VALUES ($1,$2,$3)`, [code, String(igUserId), ids]);
  if (ids.length) {
    await pool.query(`DELETE FROM instagram_stats WHERE athlete_id = ANY($1) OR ig_user_id = $2`, [ids, String(igUserId)]);
    await pool.query(`UPDATE instagram_connections SET status = 'disconnected', status_reason = 'data deleted at the athlete''s request',
                        access_token_enc = NULL, ig_user_id = NULL, username = NULL, last_synced_at = NULL, updated_at = NOW() WHERE athlete_id = ANY($1)`, [ids]);
    // Only the fields Instagram supplied, and only where Instagram supplied them.
    await pool.query(`UPDATE athletes SET data = (data - 'igStatsSource' - 'igStatsFetchedAt'
                        - (CASE WHEN data->>'reachSource' = 'instagram' THEN ARRAY['instagram','reachSource','reachAsOf'] ELSE ARRAY[]::text[] END)
                        - (CASE WHEN data->>'engagementSource' = 'instagram' THEN ARRAY['engagement','engagementSource','engagementAsOf'] ELSE ARRAY[]::text[] END))
                      WHERE id = ANY($1)`, [ids]);
  } else {
    await pool.query(`DELETE FROM instagram_stats WHERE ig_user_id = $1`, [String(igUserId)]);
  }
  await pool.query(`UPDATE instagram_deletion_requests SET status = 'completed', completed_at = NOW() WHERE confirmation_code = $1`, [code]);
  return { code, url: `${publicBase()}/api/instagram/deletion-status?code=${code}`, athleteIds: ids };
}

// ── FOR THE AGENT ───────────────────────────────────────────────────────────
// Per athlete: status 'connected' | 'expired' | 'disconnected' | 'not_connected',
// username, last sync, and the latest numbers (null when there are none).
async function statusForAgent(pool, agentId) {
  await ensureTables(pool);
  const rows = (await pool.query(
    `SELECT a.id AS athlete_id, c.status, c.status_reason, c.username, c.last_synced_at, c.last_sync_error, c.token_expires_at,
            s.followers_count, s.engagement_rate, s.fetched_at,
            (SELECT MAX(t.expires_at) FROM instagram_connect_tokens t WHERE t.athlete_id = a.id AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > NOW()) AS invite_expires_at
       FROM athletes a
       LEFT JOIN instagram_connections c ON c.athlete_id = a.id
       LEFT JOIN LATERAL (SELECT followers_count, engagement_rate, fetched_at FROM instagram_stats x WHERE x.athlete_id = a.id ORDER BY fetched_at DESC LIMIT 1) s ON TRUE
      WHERE a.agent_id = $1`, [agentId])).rows;
  const out = {};
  for (const r of rows) {
    const status = !r.status ? 'not_connected' : r.status;
    const live = status === 'connected';
    out[r.athlete_id] = {
      status, reason: r.status_reason || null, username: r.username || null,
      lastSyncedAt: r.last_synced_at || null, lastSyncError: r.last_sync_error || null,
      followers: live && r.followers_count !== null ? Number(r.followers_count) : null,
      engagementRate: live && r.engagement_rate !== null ? Number(r.engagement_rate) : null,
      inviteExpiresAt: r.invite_expires_at || null,
    };
  }
  return out;
}

async function isConnected(pool, athleteId) {
  try {
    await ensureTables(pool);
    const r = await pool.query(`SELECT 1 FROM instagram_connections WHERE athlete_id = $1 AND status = 'connected'`, [athleteId]);
    return r.rowCount > 0;
  } catch (_) { return false; }
}

// The latest stored numbers for the media kit, or null.
async function latestFor(pool, athleteId) {
  await ensureTables(pool);
  const r = await pool.query(
    `SELECT s.*, c.status FROM instagram_stats s JOIN instagram_connections c ON c.athlete_id = s.athlete_id
      WHERE s.athlete_id = $1 AND c.status = 'connected' ORDER BY s.fetched_at DESC LIMIT 1`, [athleteId]);
  return r.rows[0] || null;
}

module.exports = {
  ensureTables, createInvite, readInvite, authorizeUrl, exchangeCode, refreshToken, fetchStats, computeEngagement, saveStats,
  handleCallback, syncAthlete, refreshDue, nightly, tick, parseSignedRequest, deauthorize, deleteData, statusForAgent, isConnected,
  latestFor, inviteMessage, configured, redirectUri, appId, SCOPE, AUTHORIZE_URL, TOKEN_URL, LONG_LIVED_URL, REFRESH_URL, GRAPH,
  REFRESH_WHEN_DAYS_LEFT, INVITE_DAYS,
};
