'use strict';
// ── THE BUDGET IS THE AGENT'S, AND IT IS ALLOCATED, NOT DIVIDED ──────────────
//
// One mailbox, one reputation, one 40-a-night ceiling -- however many athletes
// hang off it. An agent with 45 clients does not get 45 budgets.
//
// DIVIDING EVENLY IS THE OBVIOUS THING AND IT IS WRONG. 40 across 45 athletes is
// zero-point-nine emails each, which in practice means one weak pitch for
// everybody and momentum for nobody. Worse, it spends the same on the athlete
// whose deal is about to close as on the one whose market has four businesses
// left in it.
//
// So the night picks. Roughly a dozen athletes get real coverage, chosen on what
// changed, and the roster rotates so it is a different dozen tomorrow.
//
// WHAT MOVES AN ATHLETE UP:
//   something in motion   a reply this week, a deal that just closed, a game
//                         coming up. A business that answered is warm NOW and
//                         cools fast; this is the highest-value thing we know.
//   gone quiet            nothing sent in a while. Not a punishment for being
//                         boring -- the roster is the product, and an athlete
//                         with no activity is the one the agent will be asked
//                         about by a parent.
//   never touched         a new signing with no history outranks routine work.
//
// WHAT MOVES AN ATHLETE DOWN:
//   thin market           few unworked businesses left. Spending the ceiling
//                         here buys the bottom of a picked-over list.
//   worked very recently  we mailed their businesses yesterday. Diminishing.
//
// THE FLOOR IS NOT A TIEBREAK. Every athlete is touched at least once every
// seven days no matter how they score, because an agent cannot tell a client
// "the algorithm ranked you low". Floor athletes are allocated FIRST, out of the
// same budget, and the score only decides what happens with what is left.

const WEEKLY_FLOOR_DAYS = 7;
// Enough to be a real approach rather than a token one. Three to five businesses
// for one athlete beats one each for five.
const MAX_PER_ATHLETE = 5;
const MIN_PER_ATHLETE = 2;

const W = {
  replied: 40,          // a business answered us for this athlete, recently
  closed: 25,           // a deal just closed; momentum and a reference story
  game: 12,             // a game inside the window: timely hook for the pitch
  neverTouched: 30,     // a new signing with nothing sent yet
  quietPerDay: 2.5,     // grows the longer they have been silent
  quietCap: 30,
  thinMarket: -20,      // few unworked businesses left
  workedYesterday: -15,
};

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// ── The facts each athlete is scored on ─────────────────────────────────────
// One query, not one per athlete: an agent with 80 clients would otherwise cost
// 80 round trips before a single email was written.
async function gatherSignals(pool, agentId, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const rows = (await pool.query(
    `SELECT a.id,
            a.data->>'name'   AS name,
            a.data->>'school' AS school,
            -- Last time we sent anything for them, any channel.
            -- NO EPOCH SENTINEL. It used to COALESCE both sides to 'epoch', and
            -- the JS then tried to spot that with String(d).startsWith('1970') --
            -- which is false, because a Date stringifies as "Thu Jan 01 1970...".
            -- So "never sent" was read as sent-in-1970 and the page said
            -- "nothing sent in 20689 days". Postgres GREATEST already ignores
            -- NULLs and returns NULL only when every input is NULL, so the
            -- sentinel was never needed in the first place.
            GREATEST(
              (SELECT MAX(sent_at) FROM outreach_logs  l WHERE l.athlete_id = a.id),
              (SELECT MAX(sent_at) FROM outreach_queue q WHERE q.athlete_id = a.id)
            ) AS last_touch,
            -- a business that ANSWERED, which is the warmest thing we hold
            (SELECT MAX(l2.replied_at) FROM outreach_logs l2
              WHERE l2.athlete_id = a.id AND l2.replied_at IS NOT NULL) AS last_reply,
            -- our own close, from the JSONB deals table
            (SELECT MAX((d.data->>'closedAt')::timestamptz) FROM deals d
              WHERE d.athlete_id = a.id AND d.data->>'stage' = 'Closed'
                AND d.data->>'closedAt' IS NOT NULL) AS last_close,
            -- unworked businesses left in their market: the thin-market test
            (SELECT COUNT(*)::int FROM outreach_queue q2
              WHERE q2.athlete_id = a.id AND q2.state = 'queued') AS queued_now
       FROM athletes a
      WHERE a.agent_id = $1
      ORDER BY a.created_at ASC`, [agentId])).rows;

  const days = (t) => (t && String(t) !== 'epoch'
    ? (now.getTime() - new Date(t).getTime()) / 86400000 : null);

  return rows.map((r) => {
    const lastTouch = r.last_touch || null;
    return {
      id: r.id,
      name: r.name || null,
      school: r.school || null,
      daysSinceTouch: days(lastTouch),
      daysSinceReply: days(r.last_reply),
      daysSinceClose: days(r.last_close),
      queuedNow: Number(r.queued_now) || 0,
      neverTouched: lastTouch === null,
      // Supplied by the caller when it knows: the Scout already computes market
      // exhaustion, and a game date is athlete data we may or may not hold. Both
      // are ABSENT rather than guessed when we do not have them.
      marketThin: null,
      gameWithinDays: null,
    };
  });
}

function scoreAthlete(a, opts = {}) {
  const why = [];
  let score = 0;

  if (a.daysSinceReply !== null && a.daysSinceReply <= 14) {
    const w = Math.round(W.replied * (1 - a.daysSinceReply / 14));
    score += w; why.push(`a business replied ${Math.round(a.daysSinceReply)}d ago`);
  }
  if (a.daysSinceClose !== null && a.daysSinceClose <= 21) {
    score += W.closed; why.push('a deal closed recently');
  }
  if (a.gameWithinDays !== null && a.gameWithinDays >= 0 && a.gameWithinDays <= 10) {
    score += W.game; why.push('a game is coming up');
  }
  if (a.neverTouched) {
    score += W.neverTouched; why.push('nothing has ever been sent for them');
  } else if (a.daysSinceTouch !== null) {
    if (a.daysSinceTouch >= 3) {
      const w = Math.round(clamp(a.daysSinceTouch * W.quietPerDay, 0, W.quietCap));
      score += w; why.push(`quiet for ${Math.round(a.daysSinceTouch)}d`);
    }
    if (a.daysSinceTouch < 1.5) {
      score += W.workedYesterday; why.push('worked in the last day');
    }
  }
  if (a.marketThin === true || (a.marketThin === null && a.queuedNow === 0 && !a.neverTouched)) {
    score += W.thinMarket; why.push('little left unworked in their market');
  }
  void opts;
  return { score, why };
}

// ── Allocation ───────────────────────────────────────────────────────────────
// budget is the agent's REMAINING email allowance for tonight, from sendGuard.
// Returns per-athlete counts that sum to at most that budget.
function allocate(signals, budget, opts = {}) {
  const total = Math.max(0, Math.floor(budget) || 0);
  if (!total || !signals.length) {
    return { picks: [], spent: 0, budget: total, skipped: signals.length,
      note: !total ? 'no email allowance left tonight' : 'no athletes to allocate to' };
  }
  const maxEach = opts.maxPerAthlete || MAX_PER_ATHLETE;
  const minEach = opts.minPerAthlete || MIN_PER_ATHLETE;
  const floorDays = opts.floorDays || WEEKLY_FLOOR_DAYS;

  const scored = signals.map((a) => {
    const s = scoreAthlete(a, opts);
    const dueByFloor = a.neverTouched
      || a.daysSinceTouch === null
      || a.daysSinceTouch >= floorDays;
    return { ...a, score: s.score, why: s.why, dueByFloor };
  });

  const picks = [];
  let left = total;

  // 1. THE FLOOR FIRST, out of the same budget. An athlete nobody has touched in
  //    a week is allocated before the highest-scoring one, because "you have not
  //    contacted anyone for my son in nine days" is not answerable with a rank.
  const floorFirst = scored.filter((a) => a.dueByFloor)
    .sort((a, b) => (b.daysSinceTouch === null ? 1e9 : b.daysSinceTouch)
                  - (a.daysSinceTouch === null ? 1e9 : a.daysSinceTouch));
  for (const a of floorFirst) {
    if (left < 1) break;
    const n = Math.min(minEach, left);
    picks.push({ athleteId: a.id, name: a.name, count: n, score: a.score,
      reason: 'weekly floor: ' + (a.neverTouched ? 'nothing sent yet'
        : `nothing sent in ${Math.round(a.daysSinceTouch)} days`),
      why: a.why, floor: true });
    left -= n;
  }

  // 2. THE REST BY SCORE, topping up the floor picks before starting new ones --
  //    a floor athlete who also scores well should get a real slate, not the
  //    two-message minimum.
  const byScore = scored.slice().sort((a, b) => b.score - a.score);
  const byId = new Map(picks.map((p) => [p.athleteId, p]));
  for (const a of byScore) {
    if (left < 1) break;
    if (a.score <= 0 && !byId.has(a.id)) continue;   // below the bar, and not owed a floor
    const existing = byId.get(a.id);
    const room = maxEach - (existing ? existing.count : 0);
    if (room < 1) continue;
    const want = Math.min(room, existing ? room : minEach, left);
    if (want < 1) continue;
    if (existing) {
      existing.count += want;
    } else {
      const p = { athleteId: a.id, name: a.name, count: want, score: a.score,
        reason: a.why.length ? a.why.join(', ') : 'next in rotation', why: a.why, floor: false };
      picks.push(p); byId.set(a.id, p);
    }
    left -= want;
  }

  // 3. ROTATION. Anything still unspent goes to whoever has waited longest and
  //    is not already at the per-athlete ceiling, so a large roster gets real
  //    coverage of PART of it rather than a thin smear across all of it.
  if (left > 0) {
    const rotation = scored.slice().sort((a, b) =>
      (b.daysSinceTouch === null ? 1e9 : b.daysSinceTouch)
      - (a.daysSinceTouch === null ? 1e9 : a.daysSinceTouch));
    for (const a of rotation) {
      if (left < 1) break;
      const existing = byId.get(a.id);
      const room = maxEach - (existing ? existing.count : 0);
      if (room < 1) continue;
      const give = Math.min(room, left);
      if (existing) existing.count += give;
      else {
        const p = { athleteId: a.id, name: a.name, count: give, score: a.score,
          reason: 'rotation', why: a.why, floor: false };
        picks.push(p); byId.set(a.id, p);
      }
      left -= give;
    }
  }

  const spent = picks.reduce((n, p) => n + p.count, 0);
  return {
    picks: picks.filter((p) => p.count > 0).sort((a, b) => b.score - a.score),
    spent, budget: total, left,
    covered: picks.filter((p) => p.count > 0).length,
    ofRoster: signals.length,
    note: null,
  };
}

module.exports = {
  gatherSignals, scoreAthlete, allocate,
  WEEKLY_FLOOR_DAYS, MAX_PER_ATHLETE, MIN_PER_ATHLETE, W,
};
