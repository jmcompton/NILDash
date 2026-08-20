'use strict';
// ── WIDENING THE RADIUS WHEN A MARKET RUNS OUT ───────────────────────────────
//
// ai.getDealRecommendations already knows how to search farther out: opts.deepen
// swaps the geography string for _geoWide ("further-out suburbs and neighboring
// towns within about 40 miles") and asks for smaller, next-tier businesses,
// excluding the pool we already hold. That pass existed and worked. Nothing the
// nightly job did could ever trigger it.
//
// It fired in exactly one place: an agent OPENING Deal Scan with fewer than five
// unseen businesses left. So a market the nightly Scout drained stayed drained
// until a human happened to open that athlete's scan -- which, for an agent with
// 45 clients, is most of the roster most of the time. The Scout reports
// localExhausted; this is what it reports it TO.
//
// WHY THE GUARD IS IN THE DATABASE. The existing guard is an in-process Map. The
// nightly job is a SEPARATE PROCESS, so it would get its own fresh allowance and
// the two paths could each deepen the same market on the same day. Worse, with
// 45 athletes spread over a handful of schools, an in-memory guard in the job
// would still be per-run. Persisted, both processes share one budget per market.
const WINDOW_HOURS = 24;

// Athletes at the same school share one market, so the key is the market, not
// the athlete. Deepening Auburn once serves every Auburn athlete on the roster.
function marketKey(school) {
  return String(school || '').trim().toLowerCase().replace(/\s+/g, ' ') || null;
}

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_deepen_log (
      market_key TEXT PRIMARY KEY,
      last_deepened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_source TEXT,
      deepen_count INT NOT NULL DEFAULT 0
    )`).catch((e) => console.error('[marketDeepen] ensureTable:', e.message));
}

// Can this market be widened right now? Never throws: a guard that errors must
// deny, not crash the night -- and it must not deny silently either, so the
// reason comes back in words for the run log.
async function canDeepen(pool, school, opts = {}) {
  const key = marketKey(school);
  if (!key) return { ok: false, reason: 'no market to widen', key: null };
  const hours = opts.windowHours || WINDOW_HOURS;
  try {
    const r = await pool.query(
      `SELECT last_deepened_at, EXTRACT(EPOCH FROM (NOW() - last_deepened_at))/3600 AS hours_ago
         FROM market_deepen_log WHERE market_key = $1`, [key]);
    const row = r.rows[0];
    if (!row) return { ok: true, reason: null, key, lastAt: null };
    const ago = Number(row.hours_ago);
    if (ago < hours) {
      return { ok: false, key, lastAt: row.last_deepened_at,
        reason: `already widened ${Math.round(ago)}h ago, and the cap is one pass per market per ${hours}h` };
    }
    return { ok: true, reason: null, key, lastAt: row.last_deepened_at };
  } catch (e) {
    console.error('[marketDeepen] canDeepen:', e.message);
    return { ok: false, key, reason: 'could not read the widen log, so not spending' };
  }
}

// CLAIMED BEFORE THE SEARCH, not after. Two athletes at the same school are
// processed back to back in the same run; recording afterwards would let both
// fire before either had written a row. The insert IS the claim, and it returns
// false when someone else already holds it.
async function claimDeepen(pool, school, opts = {}) {
  const key = marketKey(school);
  if (!key) return false;
  const hours = opts.windowHours || WINDOW_HOURS;
  try {
    const r = await pool.query(
      `INSERT INTO market_deepen_log (market_key, last_deepened_at, last_source, deepen_count)
       VALUES ($1, NOW(), $2, 1)
       ON CONFLICT (market_key) DO UPDATE
         SET last_deepened_at = NOW(),
             last_source = EXCLUDED.last_source,
             deepen_count = market_deepen_log.deepen_count + 1
       WHERE market_deepen_log.last_deepened_at < NOW() - ($3 || ' hours')::interval
       RETURNING market_key`,
      [key, opts.source || 'nightly', String(hours)]);
    return r.rowCount > 0;
  } catch (e) {
    console.error('[marketDeepen] claimDeepen:', e.message);
    return false;
  }
}

module.exports = { marketKey, ensureTable, canDeepen, claimDeepen, WINDOW_HOURS };
