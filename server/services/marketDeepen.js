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

// ── ONE WIDEN PER MARKET WAS ONE WIDEN, PERIOD ──────────────────────────────
//
// The key used to be the market alone, on the reasoning that "deepening Auburn
// once serves every Auburn athlete." Half true: the widened pass does write new
// businesses into the shared market pool, so the NEXT athlete's slate reads a
// bigger pool. What it does not do is help an athlete whose exclusions already
// cover everything the first widen found -- and that athlete cannot trigger a
// second, deeper pass, because the market's single 24h claim is spent. With 45
// clients spread over a handful of schools, that is most of the roster: the
// first athlete at each school widens and everyone behind them is told "not
// widening" and handed an empty slate.
//
// So the claim is now per athlete per market. The market still has a budget --
// MAX_PER_MARKET widens inside the window -- because 20 athletes at one school
// must not mean 20 deep searches in one night. Two gates: exclusivity per
// athlete, cost per market.
const MAX_PER_MARKET = parseInt(process.env.MARKET_DEEPEN_MAX_PER_WINDOW, 10) || 5;

// The market half of the key. Athletes at the same school share a pool, which is
// what the per-market budget is counted against.
function marketKey(school) {
  return String(school || '').trim().toLowerCase().replace(/\s+/g, ' ') || null;
}
// The market-wide budget row. Empty athlete_id is not an athlete; it is the
// counter every athlete at this market spends from.
const MARKET_ROW = '';

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_deepen_log (
      market_key TEXT PRIMARY KEY,
      last_deepened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_source TEXT,
      deepen_count INT NOT NULL DEFAULT 0
    )`).catch((e) => console.error('[marketDeepen] ensureTable:', e.message));
  // THE COMPOSITE KEY IS MIGRATED IN store.js's INIT, not here. ensureTable is
  // called from the job and not on every boot, and a schema change that only
  // lands when a particular code path runs is the email_verify_credit_log
  // mistake: the column existed everywhere except production.
}

// Can this market be widened right now? Never throws: a guard that errors must
// deny, not crash the night -- and it must not deny silently either, so the
// reason comes back in words for the run log.
async function canDeepen(pool, school, opts = {}) {
  const key = marketKey(school);
  if (!key) return { ok: false, reason: 'no market to widen', key: null };
  const athleteId = String(opts.athleteId || MARKET_ROW);
  const hours = opts.windowHours || WINDOW_HOURS;
  try {
    // Two questions in one read: has THIS athlete widened this market inside the
    // window, and does the market have budget left for anyone.
    const r = await pool.query(
      `SELECT athlete_id, last_deepened_at, deepen_count,
              EXTRACT(EPOCH FROM (NOW() - last_deepened_at))/3600 AS hours_ago
         FROM market_deepen_log
        WHERE market_key = $1 AND athlete_id IN ($2, $3)`,
      [key, athleteId, MARKET_ROW]);
    const mine = r.rows.find((x) => x.athlete_id === athleteId && athleteId !== MARKET_ROW)
      || (athleteId === MARKET_ROW ? r.rows.find((x) => x.athlete_id === MARKET_ROW) : null);
    const market = r.rows.find((x) => x.athlete_id === MARKET_ROW);

    if (mine && Number(mine.hours_ago) < hours) {
      const who = athleteId === MARKET_ROW ? 'this market' : 'this athlete';
      return { ok: false, key, lastAt: mine.last_deepened_at,
        reason: `already widened for ${who} ${Math.round(Number(mine.hours_ago))}h ago, `
          + `and it is one pass per ${athleteId === MARKET_ROW ? 'market' : 'athlete'} per ${hours}h` };
    }
    // The market budget. Only counts inside the window -- an old row is not a
    // spent budget, it is a stale one.
    if (market && Number(market.hours_ago) < hours
        && Number(market.deepen_count) >= MAX_PER_MARKET) {
      return { ok: false, key, lastAt: market.last_deepened_at,
        reason: `this market has been widened ${market.deepen_count} times in the last `
          + `${hours}h, which is the cap of ${MAX_PER_MARKET}` };
    }
    return { ok: true, reason: null, key, lastAt: mine ? mine.last_deepened_at : null };
  } catch (e) {
    console.error('[marketDeepen] canDeepen:', e.message);
    return { ok: false, key, reason: 'could not read the widen log, so not spending' };
  }
}

// CLAIMED BEFORE THE SEARCH, not after. Two athletes at the same school are
// processed back to back in the same run; recording afterwards would let both
// fire before either had written a row. The insert IS the claim, and it returns
// false when this athlete already holds one inside the window.
//
// The per-athlete claim is the exclusive gate and is a single statement, so two
// processes cannot both win it. The market counter is bumped after, which can
// overshoot the cap by at most the number of athletes claiming simultaneously --
// bounded, and in the safe direction for correctness (an extra widen costs
// money; a missed one costs an athlete their whole night).
async function claimDeepen(pool, school, opts = {}) {
  const key = marketKey(school);
  if (!key) return false;
  const athleteId = String(opts.athleteId || MARKET_ROW);
  const hours = opts.windowHours || WINDOW_HOURS;
  try {
    const gate = await canDeepen(pool, school, opts);
    if (!gate.ok) return false;
    const r = await pool.query(
      `INSERT INTO market_deepen_log (market_key, athlete_id, last_deepened_at, last_source, deepen_count)
       VALUES ($1, $2, NOW(), $3, 1)
       ON CONFLICT (market_key, athlete_id) DO UPDATE
         SET last_deepened_at = NOW(),
             last_source = EXCLUDED.last_source,
             deepen_count = market_deepen_log.deepen_count + 1
       WHERE market_deepen_log.last_deepened_at < NOW() - ($4 || ' hours')::interval
       RETURNING market_key`,
      [key, athleteId, opts.source || 'nightly', String(hours)]);
    if (!(r.rowCount > 0)) return false;

    // Spend one from the market's budget. Reset rather than incremented when the
    // window has rolled, so the cap is per-window and not per-lifetime.
    if (athleteId !== MARKET_ROW) {
      await pool.query(
        `INSERT INTO market_deepen_log (market_key, athlete_id, last_deepened_at, last_source, deepen_count)
         VALUES ($1, $2, NOW(), $3, 1)
         ON CONFLICT (market_key, athlete_id) DO UPDATE
           SET deepen_count = CASE
                 WHEN market_deepen_log.last_deepened_at < NOW() - ($4 || ' hours')::interval
                   THEN 1 ELSE market_deepen_log.deepen_count + 1 END,
               last_deepened_at = NOW(),
               last_source = EXCLUDED.last_source`,
        [key, MARKET_ROW, opts.source || 'nightly', String(hours)]).catch((e) =>
        console.error('[marketDeepen] market counter:', e.message));
    }
    return true;
  } catch (e) {
    console.error('[marketDeepen] claimDeepen:', e.message);
    return false;
  }
}

module.exports = { marketKey, ensureTable, canDeepen, claimDeepen, WINDOW_HOURS, MAX_PER_MARKET, MARKET_ROW };
