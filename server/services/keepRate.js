'use strict';
// ── THE KEEP RATE: HOW MANY PLACED CARDS THE AGENT KEPT ─────────────────────
//
// Discovery's definition of done is five candidates a night that the agent
// approves rather than skips. Not five found: five kept. Nothing measured it.
//
// Every placed card carries its own outcome on outreach_queue.state:
//
//   sent      KEPT. The agent approved it: an email approved (closer sets the
//             card 'sent', sent_via 'email'), or a DM or call marked sent.
//   skipped   SKIPPED. The card's Skip, or the email draft's Skip, which
//             closer.skipDraft carries back to the card.
//   expired   NEVER DECIDED. It sat unworked until the queue retired it.
//   queued    STILL WAITING.
//
// keep rate = kept / (kept + skipped). Expired and waiting cards are shown
// beside it and left out of it: the agent has not said yes or no to them, and
// counting them either way would make the number mean something else.
//
// A card belongs to the Central date it was created on, which is how the
// nightly job dates its own run (jobs/outreachQueue.today). Cards created in
// the run's 1am-5am window are the nightly run's; the rest are on-demand
// fills, counted separately so a busy day of on-demand fills cannot pass for a
// good night.

const CENTRAL_TZ = 'America/Chicago';
const NIGHT_START_HOUR = 1;   // jobs/outreachQueue WINDOW_START_HOUR
const NIGHT_END_HOUR = 5;     // exclusive, WINDOW_END_HOUR

function rate(kept, skipped) {
  const decided = kept + skipped;
  return decided ? kept / decided : null;
}

function pct(r) {
  return r == null ? 'n/a' : Math.round(r * 100) + '%';
}

// One row per (night, athlete, source). Read-only.
async function keepRateRows(pool, agentId, { days = 14 } = {}) {
  const r = await pool.query(
    `SELECT to_char((q.created_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS night,
            (EXTRACT(HOUR FROM q.created_at AT TIME ZONE $3) >= $4
              AND EXTRACT(HOUR FROM q.created_at AT TIME ZONE $3) < $5) AS nightly,
            q.athlete_id, a.data->>'name' AS athlete_name,
            COUNT(*)::int                                        AS placed,
            COUNT(*) FILTER (WHERE q.state = 'sent')::int        AS kept,
            COUNT(*) FILTER (WHERE q.state = 'skipped')::int     AS skipped,
            COUNT(*) FILTER (WHERE q.state = 'expired')::int     AS expired,
            COUNT(*) FILTER (WHERE q.state = 'queued')::int      AS waiting
       FROM outreach_queue q
       LEFT JOIN athletes a ON a.id = q.athlete_id
      WHERE q.agent_id = $1
        AND q.created_at > NOW() - ($2 || ' days')::interval
      GROUP BY 1, 2, 3, 4
      ORDER BY 1 DESC, 4`,
    [agentId, String(days), CENTRAL_TZ, NIGHT_START_HOUR, NIGHT_END_HOUR]);
  return r.rows;
}

function _sum(rows) {
  const t = { placed: 0, kept: 0, skipped: 0, expired: 0, waiting: 0 };
  for (const x of rows) for (const k of Object.keys(t)) t[k] += Number(x[k]) || 0;
  t.rate = rate(t.kept, t.skipped);
  return t;
}

// The numbers the report prints, grouped by night then athlete.
function summarise(rows) {
  const nights = new Map();
  for (const row of rows) {
    if (!nights.has(row.night)) nights.set(row.night, []);
    nights.get(row.night).push(row);
  }
  const out = [];
  for (const [night, list] of nights) {
    const nightly = list.filter((x) => x.nightly);
    const byAthlete = new Map();
    for (const x of nightly) {
      const k = x.athlete_id;
      if (!byAthlete.has(k)) byAthlete.set(k, { athleteId: k, name: x.athlete_name || k, rows: [] });
      byAthlete.get(k).rows.push(x);
    }
    out.push({
      night,
      nightly: _sum(nightly),
      onDemand: _sum(list.filter((x) => !x.nightly)),
      athletes: [...byAthlete.values()].map((a) => ({ athleteId: a.athleteId, name: a.name, ..._sum(a.rows) })),
    });
  }
  return out;
}

function line(t) {
  return `placed ${t.placed}, kept ${t.kept}, skipped ${t.skipped}, expired ${t.expired}, waiting ${t.waiting}`
    + `  ->  keep rate ${pct(t.rate)}${t.kept + t.skipped ? ` (${t.kept} of ${t.kept + t.skipped} decided)` : ''}`;
}

module.exports = { keepRateRows, summarise, rate, pct, line, CENTRAL_TZ, NIGHT_START_HOUR, NIGHT_END_HOUR };
