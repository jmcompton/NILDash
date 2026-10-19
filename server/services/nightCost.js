'use strict';
// ── WHAT LAST NIGHT COST, AND WHAT EACH VERIFIED EMAIL COST ─────────────────
//
// For the 5:30am email (services/shortOfFive, HUNTER_PACE_ON). The same window
// and the same source as admin script spend-breakdown (scripts/spend-
// breakdown.js --date): a run date is the morning the cards appeared, and the
// night is 18:00 UTC the evening before to 12:00 UTC that day.
//
//   model calls and web searches   ai_call_ledger.est_usd (every model call,
//                                  priced from list prices)
//   Google Places                  the Places calls the run recorded on its
//                                  spend log, at Q.USD_PER_PLACES_REQUEST
//   Hunter                         credits, not dollars: on the Hunter line
//
// Per verified email: that total over the email cards with a verified address
// for a named person placed in the window.

function windowOf(runDate) {
  const to = new Date(String(runDate).slice(0, 10) + 'T12:00:00Z');
  return { from: new Date(to.getTime() - 18 * 3600000), to };
}

async function forRunDate(pool, runDate) {
  const w = windowOf(runDate);
  const ledger = (await pool.query(
    `SELECT COALESCE(SUM(est_usd), 0)::float AS usd, COUNT(*)::int AS calls,
            COUNT(*) FILTER (WHERE est_usd IS NULL)::int AS unpriced
       FROM ai_call_ledger WHERE at >= $1 AND at < $2`, [w.from, w.to])
    .catch((e) => ({ rows: [{ usd: 0, calls: 0, unpriced: 0, error: e.message }] }))).rows[0];
  const runs = (await pool.query(`SELECT details FROM outreach_queue_runs WHERE run_date = $1`, [String(runDate).slice(0, 10)])
    .catch(() => ({ rows: [] }))).rows;
  let placesCalls = 0;
  for (const r of runs) {
    for (const d of (Array.isArray(r.details) ? r.details : [])) {
      for (const x of ((d && Array.isArray(d.spendLog)) ? d.spendLog : [])) placesCalls += Number(x && x.placesCalls) || 0;
    }
  }
  const Q = require('./outreachQueue');
  const placesUsd = Math.round(placesCalls * Q.USD_PER_PLACES_REQUEST * 1000) / 1000;
  const verified = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM outreach_queue
      WHERE created_at >= $1 AND created_at < $2 AND channel = 'email' AND email_verified = TRUE`, [w.from, w.to])
    .catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  const usd = Math.round(((Number(ledger.usd) || 0) + placesUsd) * 1000) / 1000;
  return { runDate: String(runDate).slice(0, 10), from: w.from, to: w.to, usd, ledgerUsd: Math.round((Number(ledger.usd) || 0) * 1000) / 1000,
    calls: ledger.calls || 0, unpriced: ledger.unpriced || 0, ledgerError: ledger.error || null, placesCalls, placesUsd,
    verified, perVerified: verified ? Math.round((usd / verified) * 1000) / 1000 : null };
}

// Pure. -> lines for the email.
function render(c) {
  if (!c) return [];
  const $ = (n) => '$' + (Number(n) || 0).toFixed(2);
  const L = [];
  L.push(`Last night's cost: ${$(c.usd)} (model calls and web searches ${$(c.ledgerUsd)} across ${c.calls} call${c.calls === 1 ? '' : 's'}`
    + `${c.unpriced ? `, ${c.unpriced} on a model with no price on file counted at $0` : ''}; Google Places ${$(c.placesUsd)} for ${c.placesCalls} call${c.placesCalls === 1 ? '' : 's'})`
    + (c.ledgerError ? ` -- the model-call ledger could not be read: ${c.ledgerError}` : ''));
  L.push(c.verified
    ? `Cost per verified email: ${$(c.perVerified)} (${c.verified} email card${c.verified === 1 ? '' : 's'} with a verified address for a named person placed)`
    : 'Cost per verified email: none placed last night, so no figure.');
  L.push(`Breakdown: /api/admin/scripts/spend-breakdown?text=1&date=${c.runDate}`);
  return L;
}

module.exports = { forRunDate, render, windowOf };
