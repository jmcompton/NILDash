'use strict';
// What the assistant knows about the agent before it says anything, and which of the
// six situations they are actually in.
//
// THE STATE IS COMPUTED IN CODE, NOT BY THE MODEL. The model writes the sentence; it
// does not decide which situation the agent is in. That matters because the states
// are not equally important: "scans but nothing sent" is the one worth acting on,
// and a model left to judge for itself will sometimes call it "returning user" and
// say nothing useful.
//
// One query per assistant session, cached for its lifetime, so the bubble costs one
// round trip rather than one per message.

const { pool } = require('../store');

const NO_REPLY_DAYS = 7;

/**
 * Read the agent's real position. Every number comes from a table that already
 * exists; nothing here is estimated.
 */

// The athlete-shaped context. Same field names as the agent one so contextBlock and
// the state briefs need no athlete branch -- only the meanings differ: `athletes` is
// 1 (herself), and the counts are her own.
async function readAthleteContext(athleteId, t0) {
  const [q, me] = await Promise.all([
    pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM athlete_activity_log
          WHERE athlete_id = $1 AND activity_type = 'deal_scan') AS scans,
        (SELECT COUNT(*)::int FROM athlete_brand_outreach WHERE athlete_id = $1) AS sent,
        (SELECT MAX(created_at) FROM athlete_brand_outreach WHERE athlete_id = $1) AS last_sent_at,
        (SELECT COUNT(*)::int FROM athlete_self_deals
          WHERE athlete_id = $1 AND stage NOT IN ('Completed','Lost')) AS pipeline
    `, [athleteId]).catch(() => ({ rows: [{}] })),
    // An athlete's mailbox is columns ON the athletes row (gmail_refresh_token /
    // gmail_address), NOT a row in email_accounts -- that table keys on user_id and
    // has no athlete_id at all, so the obvious subquery throws and the catch below
    // would have swallowed her name and sport with it.
    pool.query(
      `SELECT id, data->>'name' AS name, data->>'sport' AS sport, data->>'school' AS school,
              gmail_refresh_token IS NOT NULL AS gmail_connected, gmail_address
         FROM athletes WHERE id = $1`, [athleteId]).catch(() => ({ rows: [] })),
  ]);
  const c = q.rows[0] || {};
  const m = me.rows[0] || {};
  const daysSinceSent = c.last_sent_at
    ? Math.floor((Date.now() - new Date(c.last_sent_at).getTime()) / 86400000)
    : null;
  return {
    agentName: m.name || null,          // her own name; the prompt addresses the caller
    athletes: m.id ? 1 : 0,
    scans: c.scans || 0,
    sent: c.sent || 0,
    replies: 0,                          // athlete outreach has no reply tracking yet
    pipeline: c.pipeline || 0,
    gmailConnected: m.gmail_connected === true,
    mailboxAddress: m.gmail_address || null,
    daysSinceSent,
    roster: m.id ? [{ id: m.id, name: m.name, sport: m.sport, school: m.school }] : [],
    isAthlete: true,
    _ms: Date.now() - t0,
  };
}

async function readContext(agentId, principal) {
  const t0 = Date.now();
  // An athlete is not an agent with a roster of one. Every query below keys on
  // agent_id, and a self-managed athlete's agent_id is NULL -- so running them for
  // an athlete returns zeroes across the board and the assistant greets her with
  // "0 athletes, 0 scans, no mailbox", which is wrong about her account rather than
  // merely unhelpful. Her context is read from her own rows instead.
  if (principal && principal.kind === 'athlete') return readAthleteContext(principal.id, t0);
  // BOTH QUERIES AT ONCE. They share nothing but the agent id, so running the roster
  // read after the counts finished was one round trip of latency bought for nothing.
  const [q, rr] = await Promise.all([
    pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM athletes WHERE agent_id = $1) AS athletes,
      (SELECT COUNT(*)::int FROM athlete_activity_log
        WHERE agent_id = $1 AND activity_type = 'deal_scan') AS scans,
      (SELECT COUNT(*)::int FROM outreach_logs
        WHERE agent_id = $1 AND status IN ('sent','replied')) AS sent,
      (SELECT COUNT(*)::int FROM outreach_logs
        WHERE agent_id = $1 AND replied_at IS NOT NULL) AS replies,
      (SELECT MAX(sent_at) FROM outreach_logs WHERE agent_id = $1 AND status IN ('sent','replied')) AS last_sent_at,
      (SELECT COUNT(*)::int FROM deals WHERE agent_id = $1
        -- 'Dead' is not a stage. The vocabulary is Prospecting, Contacted,
        -- Negotiating, Closed, Lost, Signed, and in-flight means NOT IN
        -- ('Closed','Lost') everywhere, so this agrees with the home page.
        AND COALESCE(data->>'stage','') NOT IN ('Closed','Lost')) AS pipeline,
      (SELECT COUNT(*)::int FROM email_accounts WHERE user_id = $1) AS mailboxes,
      (SELECT email_address FROM email_accounts WHERE user_id = $1
        ORDER BY (provider = 'gmail') DESC, created_at LIMIT 1) AS mailbox_address,
      (SELECT last_login FROM users WHERE id = $1) AS last_login,
      (SELECT name FROM users WHERE id = $1) AS agent_name
  `, [agentId]),

    // A few athletes by name, so the assistant can say "Fixture Alvarez" rather than
    // "one of your athletes". Ids come too, because every athlete-scoped action needs
    // one and the model must never be left to invent it.
    //
    // READ FROM data JSONB, NOT FROM COLUMNS. athletes has exactly id, agent_id, data,
    // created_at, updated_at; name, sport and school live inside data, which is why
    // every other query in the codebase reads data->>'name'. Selecting them as columns
    // threw "column name does not exist", which rejected readContext, 500ed the
    // greeting, and left the panel empty.
    pool.query(
      `SELECT id,
              data->>'name'   AS name,
              data->>'sport'  AS sport,
              data->>'school' AS school
         FROM athletes WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 8`,
      [agentId]),
  ]);
  const c = q.rows[0] || {};

  const daysSinceSent = c.last_sent_at
    ? Math.floor((Date.now() - new Date(c.last_sent_at).getTime()) / 86400000)
    : null;

  return {
    agentName: c.agent_name || null,
    athletes: c.athletes || 0,
    scans: c.scans || 0,
    sent: c.sent || 0,
    replies: c.replies || 0,
    pipeline: c.pipeline || 0,
    gmailConnected: (c.mailboxes || 0) > 0,
    mailboxAddress: c.mailbox_address || null,
    lastLogin: c.last_login || null,
    lastSentAt: c.last_sent_at || null,
    daysSinceSent,
    roster: rr.rows.map((a) => ({ id: a.id, name: a.name, sport: a.sport, school: a.school })),
    // Read by the route's timing line, which is how the greeting's cost gets split
    // between the database and the model instead of being guessed at. Safe to carry
    // here: both consumers name the fields they want (contextBlock builds a string
    // from named fields, the route sends four picked keys), so this reaches neither
    // the prompt nor the response.
    _ms: Date.now() - t0,
  };
}

/**
 * Which of the six situations is this. Ordered, and the order is the point: the
 * first match wins, and they are arranged so the blocking problem is found before
 * the pleasant one.
 */
function routeState(ctx) {
  if (!ctx.athletes) return 'no_athletes';
  if (!ctx.scans) return 'no_scans';
  // THE IMPORTANT ONE. Scans run and nothing sent means something is in the way, and
  // if there is no mailbox that is almost certainly it: nothing they wrote could
  // have gone out.
  if (!ctx.sent) return ctx.gmailConnected ? 'no_outreach' : 'no_outreach_no_gmail';
  if (ctx.sent && !ctx.replies && ctx.daysSinceSent != null && ctx.daysSinceSent >= NO_REPLY_DAYS) return 'no_replies';
  return 'returning';
}

// What the assistant should DO in each state, written out so the model is choosing
// words rather than choosing a goal. suggestionKey is what the never-nag rule
// suppresses once it has been offered and ignored.
const STATE_BRIEFS = {
  no_athletes: {
    suggestionKey: 'add_first_athlete',
    brief: 'They have no athletes yet. Offer to add their first one, and ask for the name, the sport and the school. '
      + 'All three: sport drives the fit scoring, so an athlete without one scores wrong rather than not at all.',
  },
  no_scans: {
    suggestionKey: 'first_scan',
    brief: 'They have athletes but have never run a Deal Scan. Name ONE of their athletes specifically and offer to scan for them.',
  },
  no_outreach_no_gmail: {
    suggestionKey: 'connect_gmail',
    brief: 'They have run scans and sent nothing, AND they have no mailbox connected. '
      + 'Say that plainly: without a connected mailbox nothing they write can be sent, so it is almost certainly the reason. '
      + 'Offer to connect Gmail. Ask if anything else is in the way.',
  },
  no_outreach: {
    suggestionKey: 'why_no_outreach',
    brief: 'They have run scans and sent nothing, and their mailbox IS connected, so the usual reason does not apply. '
      + 'Ask what is in the way. Do not guess at the answer and do not lecture. One short question.',
  },
  no_replies: {
    suggestionKey: 'draft_followups',
    brief: 'They have sent outreach and had no replies for a week or more. Say plainly that this is normal for cold outreach '
      + 'and offer to draft follow ups. Do not oversell the odds.',
  },
  returning: {
    suggestionKey: null,
    brief: 'Nothing is pending. Greet them briefly and stop. Do NOT invent a task, do not list features, '
      + 'do not ask what they are working on. One or two sentences at most.',
  },
};

// The context as the model sees it. Every value is labelled and fenced as DATA.
function contextBlock(ctx, state) {
  const roster = ctx.roster.length
    ? ctx.roster.map((a) => `  - id=${a.id} | ${a.name} | ${a.sport || 'sport unknown'} | ${a.school || 'school unknown'}`).join('\n')
    : '  (none)';
  return `AGENT SITUATION (read from the database, all of it true right now)
- Name: ${ctx.agentName || 'unknown'}
- Athletes on roster: ${ctx.athletes}
- Deal Scans ever run: ${ctx.scans}
- Outreach emails sent: ${ctx.sent}
- Replies received: ${ctx.replies}
- Deals in pipeline (not closed or lost): ${ctx.pipeline}
- Gmail / mailbox connected: ${ctx.gmailConnected ? 'YES (' + (ctx.mailboxAddress || 'address unknown') + ')' : 'NO'}
- Last login: ${ctx.lastLogin ? new Date(ctx.lastLogin).toISOString().slice(0, 10) : 'unknown'}
- Days since their last send: ${ctx.daysSinceSent == null ? 'never sent' : ctx.daysSinceSent}
- Situation: ${state}

THEIR ROSTER (use these ids for any athlete action, never invent one):
${roster}`;
}

module.exports = { readContext, routeState, STATE_BRIEFS, contextBlock, NO_REPLY_DAYS };
