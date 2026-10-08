'use strict';
// ── THE ADMIN HOME: FIVE NUMBERS AND WHAT NEEDS ME ──────────────────────────
//
// The admin page grew one section at a time until the numbers that say whether
// NILDash is working were nowhere on it. This reads them in one call:
//
//   written    pitches the night (or a scan) wrote: email drafts plus queue cards
//   approved   email drafts the agent approved, plus queue cards marked sent
//   sent       email drafts that actually went out, plus queue cards marked sent
//   replied    a business answered: replied_at on a draft, or a queue outcome
//   signed     deals logged as closed (deal_outcomes, the same table the
//              "Deals logged" tiles count)
//
// Only FIRST touches count as written/approved/sent. A follow-up is the same
// pitch arriving again, and counting it would make the funnel look busier than
// the pile of businesses actually contacted.
//
// Read-only. Every query is wrapped so one missing table empties its own number
// instead of the whole page.

function days(n) { const d = Math.round(Number(n) || 30); return Math.min(365, Math.max(1, d)); }

async function one(pool, label, sql, params, errs) {
  try { return (await pool.query(sql, params)).rows; }
  catch (e) { errs.push(label + ': ' + e.message); return []; }
}

async function funnel(pool, windowDays, errs) {
  const p = [String(days(windowDays))];
  const since = `NOW() - ($1 || ' days')::interval`;
  const logs = (await one(pool, 'funnel-logs', `
    SELECT COUNT(*) FILTER (WHERE created_at >= ${since})::int AS written,
           COUNT(*) FILTER (WHERE approved_at >= ${since})::int AS approved,
           COUNT(*) FILTER (WHERE sent_at >= ${since})::int AS sent,
           COUNT(*) FILTER (WHERE replied_at >= ${since})::int AS replied
      FROM outreach_logs
     WHERE COALESCE(touch_no, 1) = 1`, p, errs))[0] || {};
  const queue = (await one(pool, 'funnel-queue', `
    SELECT COUNT(*) FILTER (WHERE created_at >= ${since})::int AS written,
           COUNT(*) FILTER (WHERE sent_at >= ${since})::int AS sent,
           COUNT(*) FILTER (WHERE outcome IN ('replied','closed') AND outcome_at >= ${since})::int AS replied
      FROM outreach_queue
     WHERE COALESCE(channel, '') <> 'program'
       AND outreach_log_id IS NULL`, p, errs))[0] || {};
  const deals = (await one(pool, 'funnel-deals', `
    SELECT COUNT(*)::int AS signed FROM deal_outcomes WHERE closed_at >= ${since}`, p, errs))[0] || {};
  const n = (x) => Number(x) || 0;
  return {
    written: n(logs.written) + n(queue.written),
    approved: n(logs.approved) + n(queue.sent),
    sent: n(logs.sent) + n(queue.sent),
    replied: n(logs.replied) + n(queue.replied),
    signed: n(deals.signed),
  };
}

async function health(pool, errs) {
  const r = (await one(pool, 'health', `
    SELECT
      (SELECT COUNT(*)::int FROM users
        WHERE COALESCE(archived, false) = false AND role IN ('agent','admin')
          AND last_login >= NOW() - interval '7 days') AS active_agents,
      (SELECT COUNT(*)::int FROM users
        WHERE COALESCE(archived, false) = false AND role IN ('agent','admin')) AS agents,
      (SELECT COUNT(*)::int FROM athletes a JOIN users u ON u.id = a.agent_id
        WHERE COALESCE(u.archived, false) = false) AS athletes`, [], errs))[0] || {};
  return { activeAgents: Number(r.active_agents) || 0, agents: Number(r.agents) || 0, athletes: Number(r.athletes) || 0 };
}

// Athletes of agents active in the last 14 days who got fewer than five new
// pitches in the last 24 hours. The five-a-morning promise, checked.
async function shortAthletes(pool, errs) {
  const rows = await one(pool, 'short', `
    WITH fresh AS (
      SELECT athlete_id, COUNT(*)::int AS n FROM (
        SELECT athlete_id FROM outreach_queue
         WHERE created_at >= NOW() - interval '24 hours' AND COALESCE(channel,'') <> 'program'
        UNION ALL
        SELECT athlete_id FROM outreach_logs
         WHERE created_at >= NOW() - interval '24 hours' AND COALESCE(touch_no, 1) = 1
      ) x GROUP BY athlete_id)
    SELECT a.id, a.data->>'name' AS athlete, u.name AS agent, COALESCE(f.n, 0) AS n
      FROM athletes a
      JOIN users u ON u.id = a.agent_id
      LEFT JOIN fresh f ON f.athlete_id = a.id
     WHERE COALESCE(u.archived, false) = false
       AND u.last_login >= NOW() - interval '14 days'
       AND COALESCE(f.n, 0) < 5
     ORDER BY COALESCE(f.n, 0) ASC, u.name, a.data->>'name'
     LIMIT 50`, [], errs);
  return rows.map((r) => ({ athlete: r.athlete || '(no name)', agent: r.agent || '', fresh: Number(r.n) || 0 }));
}

// Per agent: pitches waiting on them, and what happened to what they sent.
async function agents(pool, windowDays, errs) {
  const p = [String(days(windowDays))];
  const since = `NOW() - ($1 || ' days')::interval`;
  const rows = await one(pool, 'agents', `
    SELECT u.id, u.name, u.email, u.plan, u.last_login,
      (SELECT COUNT(*)::int FROM outreach_logs l
        WHERE l.agent_id = u.id AND l.sent_at IS NULL AND l.approved_at IS NULL
          AND COALESCE(l.status,'draft') = 'draft' AND COALESCE(l.touch_no,1) = 1)
      + (SELECT COUNT(*)::int FROM outreach_queue q
        WHERE q.agent_id = u.id AND q.state = 'queued' AND COALESCE(q.channel,'') <> 'program') AS waiting,
      (SELECT MIN(l.created_at) FROM outreach_logs l
        WHERE l.agent_id = u.id AND l.sent_at IS NULL AND l.approved_at IS NULL
          AND COALESCE(l.status,'draft') = 'draft') AS oldest_waiting,
      (SELECT COUNT(*)::int FROM outreach_logs l
        WHERE l.agent_id = u.id AND l.sent_at >= ${since} AND COALESCE(l.touch_no,1) = 1)
      + (SELECT COUNT(*)::int FROM outreach_queue q WHERE q.agent_id = u.id AND q.sent_at >= ${since}) AS sent,
      (SELECT COUNT(*)::int FROM outreach_logs l WHERE l.agent_id = u.id AND l.replied_at >= ${since})
      + (SELECT COUNT(*)::int FROM outreach_queue q WHERE q.agent_id = u.id
          AND q.outcome IN ('replied','closed') AND q.outcome_at >= ${since}) AS replied,
      (SELECT COUNT(*)::int FROM deal_outcomes d WHERE d.agent_id = u.id AND d.closed_at >= ${since}) AS signed
      FROM users u
     WHERE COALESCE(u.archived, false) = false AND u.role IN ('agent','admin')
     ORDER BY u.last_login DESC NULLS LAST
     LIMIT 40`, p, errs);
  return rows.map((r) => ({
    name: r.name || r.email, email: r.email, plan: r.plan || null,
    lastLogin: r.last_login || null,
    waiting: Number(r.waiting) || 0,
    oldestWaiting: r.oldest_waiting || null,
    sent: Number(r.sent) || 0, replied: Number(r.replied) || 0, signed: Number(r.signed) || 0,
  }));
}

// What needs me, worst first. Each item is a sentence, not a status code.
function attention(list, short) {
  const out = [];
  const DAY = 86400000;
  for (const a of list) {
    if (a.waiting >= 10 && a.oldestWaiting && (Date.now() - new Date(a.oldestWaiting).getTime()) >= 3 * DAY) {
      const d = Math.floor((Date.now() - new Date(a.oldestWaiting).getTime()) / DAY);
      out.push({ level: 'bad', title: `${a.name} has ${a.waiting} pitches waiting`,
        detail: `The oldest has waited ${d} days for approval` });
    }
  }
  if (short.length) {
    const zero = short.filter((s) => s.fresh === 0).length;
    out.push({ level: 'bad', title: `${short.length} athlete${short.length === 1 ? '' : 's'} got fewer than 5 new pitches in the last 24 hours`,
      detail: zero ? `${zero} got none` : 'Every one of them got at least one' });
  }
  return out.slice(0, 8);
}

async function build(pool, opts = {}) {
  const errs = [];
  const windowDays = days(opts.days);
  const [f, h, s, list] = await Promise.all([
    funnel(pool, windowDays, errs), health(pool, errs), shortAthletes(pool, errs), agents(pool, windowDays, errs)]);
  return { windowDays, funnel: f, health: { ...h, athletesShort: s.length }, short: s,
    agents: list, attention: attention(list, s), errors: errs };
}

module.exports = { build, _attention: attention, _days: days };
