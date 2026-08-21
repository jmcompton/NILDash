'use strict';
// ── ANSWERING QUESTIONS ABOUT THE AGENT'S OWN DATA ───────────────────────────
//
// The assistant could already act (add an athlete, run a scan) and could already
// answer questions about the PRODUCT from a static knowledge file. It could not
// answer a question about the agent's own rows -- "how many athletes have no
// deals", "what happened to the Ourisman thread" -- because nothing gave it a
// way to look.
//
// A model with no way to look and a question it wants to answer will make
// something up. That is the failure this file exists to prevent, and it prevents
// it by construction rather than by instruction:
//
//   1. FIXED QUERIES ONLY. There is no free-form SQL tool here and there must
//      never be one. The model picks a question from a list; it does not write
//      the query. A model that can write SQL against a live database is one
//      prompt injection away from reading another agent's roster.
//   2. EVERY QUERY IS SCOPED TO THE CALLER. agent_id is bound as a parameter in
//      every statement below, not interpolated and not optional.
//   3. AN EMPTY RESULT IS AN ANSWER. Each query returns rows AND a `found`
//      count, so "none" is reportable as a fact rather than read as a failure to
//      look properly.
//   4. WHAT IS NOT COVERED SAYS SO. Anything outside this list returns a
//      refusal naming the page that would answer it, which is the honest move
//      and also the useful one.

const QUESTIONS = {
  athletes_without_deals: {
    description: 'Athletes on the roster with no deal logged at any stage. Use for '
      + '"who has nothing", "how many athletes have no deals".',
    where: 'Pipeline',
    run: async (pool, agentId) => (await pool.query(
      `SELECT a.data->>'name' AS name, a.data->>'school' AS school
         FROM athletes a
        WHERE a.agent_id = $1
          AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.athlete_id = a.id)
        ORDER BY a.created_at ASC LIMIT 60`, [agentId])).rows,
  },

  athletes_without_market: {
    description: 'Athletes whose school could not be matched to a town, so they get '
      + 'no local businesses. Use for "why is X getting nothing", "who has no market".',
    where: 'the athlete\'s profile, where the school can be corrected',
    run: async (pool, agentId) => {
      const AR = require('./athleteRecord');
      const { resolveSchool } = require('./schoolResolver');
      const rows = (await pool.query(
        `SELECT id, data FROM athletes WHERE agent_id = $1 ORDER BY created_at ASC`, [agentId])).rows;
      return rows
        .map((r) => AR.resolveAthlete(r, { schoolLocation: resolveSchool }))
        .filter((rec) => !rec.hasLocalMarket)
        .map((rec) => ({ name: rec.name, school: rec.school, why: rec.localLaneNote }))
        .slice(0, 60);
    },
  },

  nothing_sent_recently: {
    description: 'Whether anything has gone out lately, and what stopped it. Use for '
      + '"why did nothing send", "has anything gone out".',
    where: 'Home, under Ready to send',
    run: async (pool, agentId) => {
      const sendGuard = require('./sendGuard');
      const budget = await sendGuard.status(pool, agentId);
      const counts = (await pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'draft'    AND approved_at IS NULL)::int AS awaiting_approval,
                COUNT(*) FILTER (WHERE status = 'approved')::int                          AS scheduled,
                COUNT(*) FILTER (WHERE sent_at >= NOW() - INTERVAL '7 days')::int         AS sent_7d,
                COUNT(*) FILTER (WHERE send_error IS NOT NULL AND status <> 'sent')::int  AS failed
           FROM outreach_logs WHERE agent_id = $1`, [agentId])).rows[0];
      return [{
        emails_sent_last_7_days: Number(counts.sent_7d),
        waiting_on_your_approval: Number(counts.awaiting_approval),
        approved_and_scheduled: Number(counts.scheduled),
        failed_to_send: Number(counts.failed),
        daily_ceiling: budget.cap,
        used_today: budget.used,
        sending_blocked: budget.blocked,
        blocked_reason: budget.blockedReason,
      }];
    },
  },

  brand_thread: {
    description: 'What happened with one business by name: every outreach, whether it '
      + 'sent, whether they replied, and why a follow-up stopped. Use for "what '
      + 'happened to the <name> thread". Requires the `brand` argument.',
    where: 'Outreach',
    needs: ['brand'],
    run: async (pool, agentId, args) => {
      const q = String(args.brand || '').trim();
      if (!q) return [];
      return (await pool.query(
        `SELECT l.brand_name, l.subject, l.status, l.sent_at, l.replied_at,
                l.touch_no, l.cadence_stop_reason, l.send_error, l.last_inbound_kind,
                a.data->>'name' AS athlete
           FROM outreach_logs l
           JOIN athletes a ON a.id = l.athlete_id
          WHERE l.agent_id = $1 AND LOWER(l.brand_name) LIKE '%' || LOWER($2) || '%'
          ORDER BY l.created_at ASC LIMIT 25`, [agentId, q])).rows;
    },
  },

  replies_waiting: {
    description: 'Businesses that replied and have not been answered. Use for '
      + '"who replied", "is anyone waiting on me".',
    where: 'Home, under Needs you',
    run: async (pool, agentId) => (await pool.query(
      `SELECT l.brand_name, l.replied_at, a.data->>'name' AS athlete
         FROM outreach_logs l JOIN athletes a ON a.id = l.athlete_id
        WHERE l.agent_id = $1 AND l.replied_at IS NOT NULL
        ORDER BY l.replied_at DESC LIMIT 25`, [agentId])).rows,
  },

  roster_summary: {
    description: 'Roster size and how much of it has been worked. Use for "how many '
      + 'athletes do I have", "how is the roster doing".',
    where: 'Athletes',
    run: async (pool, agentId) => (await pool.query(
      `SELECT COUNT(*)::int AS athletes,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM outreach_queue q WHERE q.athlete_id = a.id))::int AS with_queue,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM deals d WHERE d.athlete_id = a.id))::int AS with_deals
         FROM athletes a WHERE a.agent_id = $1`, [agentId])).rows,
  },

  deals_by_stage: {
    description: 'The pipeline by stage, with values. Use for "what is in the '
      + 'pipeline", "how much is in flight".',
    where: 'Pipeline',
    run: async (pool, agentId) => (await pool.query(
      `SELECT COALESCE(NULLIF(d.data->>'stage',''), 'Unstaged') AS stage,
              COUNT(*)::int AS deals,
              SUM(COALESCE(NULLIF(d.data->>'value',''),'0')::numeric)::bigint AS total_value
         FROM deals d WHERE d.agent_id = $1
        GROUP BY 1 ORDER BY 2 DESC`, [agentId])).rows,
  },

  media_kit_status: {
    description: 'Which athletes have a media kit and when it was last refreshed. '
      + 'Use for "is X\'s kit current", "who has no media kit".',
    where: 'Media Kit',
    run: async (pool, agentId) => (await pool.query(
      `SELECT a.data->>'name' AS name, k.slug, k.updated_at AS last_refreshed,
              (k.id IS NULL) AS missing
         FROM athletes a LEFT JOIN media_kits k ON k.athlete_id = a.id
        WHERE a.agent_id = $1 ORDER BY a.created_at ASC LIMIT 60`, [agentId])).rows,
  },
};

function names() { return Object.keys(QUESTIONS); }

function toolDef() {
  const lines = Object.entries(QUESTIONS)
    .map(([k, v]) => `- ${k}: ${v.description}`).join('\n');
  return {
    name: 'look_up_data',
    description:
      'Look up a fact about THIS agent\'s own data before answering any question about '
      + 'their athletes, outreach, deals or media kits. You do not know these numbers '
      + 'and must never estimate them. If none of the questions below matches what was '
      + 'asked, do NOT call this tool and do not guess -- say you cannot answer that one '
      + 'and name the page that would.\n\nAvailable questions:\n' + lines,
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', enum: names(),
          description: 'Which fixed question to run.' },
        brand: { type: 'string',
          description: 'Business name, only for brand_thread.' },
      },
      required: ['question'],
    },
  };
}

// Runs one fixed question, scoped to the caller. Never throws into the tool loop:
// a database error becomes a stated failure, because "I could not look" and
// "there are none" must never be confused for each other.
async function run(pool, agentId, input = {}) {
  const key = String(input.question || '');
  const q = QUESTIONS[key];
  if (!q) {
    return { ok: false, answered: false,
      error: `There is no lookup for "${key}". Tell the agent you cannot answer that `
        + 'one from data and point them at the page.' };
  }
  for (const need of (q.needs || [])) {
    if (!input[need]) {
      return { ok: false, answered: false,
        error: `That lookup needs a ${need}. Ask the agent which one they mean.` };
    }
  }
  try {
    const rows = await q.run(pool, agentId, input);
    return {
      ok: true, answered: true, question: key,
      found: Array.isArray(rows) ? rows.length : 0,
      rows: Array.isArray(rows) ? rows : [],
      where: q.where,
      // Said explicitly so an empty result is reported as a finding rather than
      // filled in from the model's imagination.
      note: (Array.isArray(rows) && rows.length === 0)
        ? 'The query ran and matched nothing. That is the answer: none. Say so plainly.'
        : null,
    };
  } catch (e) {
    console.error('[assistantData] ' + key, e.message);
    return { ok: false, answered: false,
      error: 'The lookup failed, so you do not know the answer. Say that you could not '
        + `check, and point the agent at ${q.where}. Do not estimate.` };
  }
}

module.exports = { QUESTIONS, names, toolDef, run };
