'use strict';
// ── SERPER: COUNTED, WARNED EARLY, AND NEVER A DEAD NIGHT ────────────────────
//
// Nov 2026: Serper ran out of credits and 1,127 calls failed in a day before
// anyone looked. Every contact search, Instagram handle search and paying-
// brand read failed with it, so cards were dropped instead of found. Three
// things here so that cannot happen quietly again:
//
//   COUNTED   every Serper call adds one to serper_usage (day, site). The
//             status page and the warning read it.
//   WARNED    a top-up is recorded (POST /api/admin/serper-topup {credits}).
//             What is left = that top-up minus every call since. When fewer
//             than WARN_DAYS days are left at the last week's pace, or under
//             WARN_SHARE of the top-up, the admin gets one email a day saying
//             how many days remain. Before it runs out, not after.
//   NEVER DEAD  a billing or key failure trips the breaker for BREAKER_MS:
//             every caller reads Serper as not configured, so web search goes
//             to the next provider (Brave, Tavily, then Anthropic's own) and
//             Places goes to Google, exactly as when no Serper key is set.
//             The work goes on at a higher price instead of failing a
//             thousand times. After BREAKER_MS one call tries Serper again.

const BREAKER_MS = parseInt(process.env.SERPER_BREAKER_MS, 10) || 30 * 60 * 1000;
const WARN_DAYS = parseFloat(process.env.SERPER_WARN_DAYS) || 7;
const WARN_SHARE = parseFloat(process.env.SERPER_WARN_SHARE) || 0.15;

let _openUntil = 0;
let _openWhy = null;
const _pending = new Map();   // site -> n, flushed in batches
let _flushTimer = null;

const key = () => String(process.env.SERPER_API_KEY || '').trim();

// Is Serper usable right now? A key, and the breaker closed.
function usable() { return !!key() && Date.now() >= _openUntil; }
function breaker() { return { open: Date.now() < _openUntil, until: _openUntil ? new Date(_openUntil).toISOString() : null, why: _openWhy }; }

// A billing or key failure: stop calling Serper for BREAKER_MS.
function trip(why) {
  _openUntil = Date.now() + BREAKER_MS;
  _openWhy = String(why || 'billing or key failure').slice(0, 200);
  console.error(`[serper-guard] breaker open until ${new Date(_openUntil).toISOString()}: ${_openWhy}; callers fall back to the next provider`);
}
function _reset() { _openUntil = 0; _openWhy = null; _pending.clear(); }

// Failure text that means "stop calling": out of credits, key refused.
const STOP = /not enough credits|out of credits|insufficient|payment required|invalid api key|unauthori[sz]ed|\b40[123]\b/i;
function failed(status, message) {
  const s = Number(status) || 0;
  if (s === 401 || s === 402 || s === 403 || STOP.test(String(message || ''))) { trip(`HTTP ${s || '?'}: ${String(message || '').slice(0, 160)}`); return true; }
  return false;
}

async function ensureTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS serper_usage (
    day DATE NOT NULL, site TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, site))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS serper_topups (
    id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), credits INTEGER NOT NULL, note TEXT)`);
  // The day's count at the moment of the top-up: calls earlier that day were
  // paid from the old balance, not this one.
  await pool.query(`ALTER TABLE serper_topups ADD COLUMN IF NOT EXISTS base INTEGER NOT NULL DEFAULT 0`);
}

// One Serper call made. Batched: written within a few seconds, never per call.
function count(site, n = 1) {
  const s = String(site || 'other').slice(0, 40);
  _pending.set(s, (_pending.get(s) || 0) + n);
  if (!_flushTimer) {
    _flushTimer = setTimeout(() => { _flushTimer = null; flush().catch(() => {}); }, 5000);
    if (_flushTimer.unref) _flushTimer.unref();
  }
}
async function flush(poolArg) {
  if (!_pending.size) return 0;
  const rows = [..._pending.entries()];
  _pending.clear();
  let pool = poolArg;
  try { pool = pool || require('../store').pool; } catch (_) { return 0; }
  try {
    await ensureTables(pool);
    for (const [site, n] of rows) {
      await pool.query(`INSERT INTO serper_usage (day, site, n) VALUES ((NOW() AT TIME ZONE 'America/Chicago')::date, $1, $2)
        ON CONFLICT (day, site) DO UPDATE SET n = serper_usage.n + EXCLUDED.n`, [site, n]);
    }
  } catch (e) { console.error('[serper-guard] usage not recorded: ' + e.message); }
  return rows.length;
}

async function recordTopup(pool, credits, note) {
  const c = parseInt(credits, 10);
  if (!(c > 0) || c > 100000000) return { ok: false, error: 'credits must be a positive whole number' };
  await flush(pool);
  await ensureTables(pool);
  await pool.query(`INSERT INTO serper_topups (credits, note, base) VALUES ($1, $2,
      (SELECT COALESCE(SUM(n), 0)::int FROM serper_usage WHERE day = (NOW() AT TIME ZONE 'America/Chicago')::date))`,
    [c, note ? String(note).slice(0, 200) : null]);
  _openUntil = 0; _openWhy = null;   // a fresh top-up: try Serper again now
  return { ok: true, ...(await balance(pool)) };
}

// -> { bought, boughtAt, used, left, perDay, daysLeft, last7, bySite }
async function balance(pool) {
  await flush(pool);
  await ensureTables(pool);
  const t = (await pool.query(`SELECT credits, at, base FROM serper_topups ORDER BY at DESC, id DESC LIMIT 1`)).rows[0] || null;
  const week = (await pool.query(`SELECT day::text AS day, SUM(n)::int AS n FROM serper_usage
     WHERE day > (NOW() AT TIME ZONE 'America/Chicago')::date - 7 GROUP BY day ORDER BY day`)).rows;
  const bySite = (await pool.query(`SELECT site, SUM(n)::int AS n FROM serper_usage
     WHERE day > (NOW() AT TIME ZONE 'America/Chicago')::date - 7 GROUP BY site ORDER BY 2 DESC`)).rows;
  const last7 = week.reduce((s, r) => s + r.n, 0);
  const perDay = week.length ? Math.round(last7 / Math.max(1, week.length)) : 0;
  let used = null, left = null, daysLeft = null;
  if (t) {
    used = Math.max(0, (await pool.query(`SELECT COALESCE(SUM(n),0)::int AS n FROM serper_usage WHERE day >= ($1::timestamptz AT TIME ZONE 'America/Chicago')::date`, [t.at])).rows[0].n - (t.base || 0));
    left = Math.max(0, t.credits - used);
    daysLeft = perDay > 0 ? Math.floor(left / perDay) : null;
  }
  return { bought: t ? t.credits : null, boughtAt: t ? new Date(t.at).toISOString() : null, used, left, perDay, daysLeft, last7, bySite, breaker: breaker() };
}

// The morning check. -> { warn, why, ...balance }; emails once a day when warn.
async function check(pool, opts = {}) {
  const b = await balance(pool);
  let why = null;
  if (b.bought == null) why = null;   // no top-up on record: nothing to measure against
  else if (b.left <= 0) why = `Serper is out by our count (${b.used} of ${b.bought} used)`;
  else if (b.daysLeft != null && b.daysLeft <= WARN_DAYS) why = `about ${b.daysLeft} day(s) of Serper credits left (${b.left} left, using ${b.perDay} a day)`;
  else if (b.left < WARN_SHARE * b.bought) why = `${b.left} of ${b.bought} Serper credits left`;
  if (why && !opts.dryRun) {
    await require('./ourFault').alertNow('serper', 'low', why, 'serperGuard.check', {
      subject: `NILDash: top up Serper soon (${why})`,
      text: [why, '', 'Top up at serper.dev before it runs out, then tell Claude the amount so the count starts again.',
        'Until then nothing breaks: when it runs out, searches move to the next provider at a higher price.'].join('\n'),
      every: '20 hours',
    }).catch((e) => console.error('[serper-guard] warning not sent: ' + e.message));
  }
  return { warn: !!why, why, ...b };
}

module.exports = { usable, breaker, trip, failed, count, flush, recordTopup, balance, check, ensureTables, BREAKER_MS, WARN_DAYS, WARN_SHARE, _reset };
