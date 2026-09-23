'use strict';
// ── WHAT AN AGENT ACTUALLY SENT OR REACHED ─────────────────────────────────
//
// The admin "Outreach" column and the funnel's "Sent outreach" step counted
// athlete_activity_log rows of type outreach_written / email_sent. The only
// writers of those two types are athlete-portal endpoints (an athlete drafting
// or emailing for themselves), so no agent send ever counted: every agent
// read 0 however much they had sent. The Outreach tab's own Send wrote
// 'email_sent' to workflow_events, a different table.
//
// This counts what happened on the agent side, from the records the sends
// themselves leave, as three numbers:
//
//   emails_sent   outreach_logs with a sent_at: the message left the agent's
//                 mailbox, whether the release scheduler sent it after
//                 approval or the agent pressed Send.
//                 NOT approval alone: an approved email that never left has
//                 no sent_at and is not counted.
//   cards_sent    queue cards marked sent that are not email: a DM, a call, a
//                 programme application. The agent did it off-platform and
//                 said so. EMAIL cards are excluded: approving the draft marks
//                 the card 'sent' at approval time (services/closer), before
//                 anything leaves, and the email itself is counted above once
//                 it really goes.
//   contacted     distinct businesses, per athlete, marked contacted or further
//                 (responded, closed, dead): the Deal Scan's "contacted", a DM
//                 copied from AI Outreach, and every real send. Owned through
//                 the ATHLETE's agent, because brand_engagement.agent_id is
//                 nullable.
//
// THEY OVERLAP, SO THEY ARE NEVER ADDED. One email sent through the platform
// is one email_sent AND one contacted business. They are shown side by side.
//
// One fragment, used by both admin endpoints, so the column and the funnel
// cannot count differently again. Expects the users table aliased as u.

const REACHED_STATES = ['contacted', 'responded', 'replied', 'closed', 'dead'];

const LATERAL = `
  LEFT JOIN LATERAL (
    SELECT
      (SELECT COUNT(*) FROM outreach_logs l
        WHERE l.agent_id = u.id AND l.sent_at IS NOT NULL)::int AS emails_sent,
      (SELECT COUNT(*) FROM outreach_queue q
        WHERE q.agent_id = u.id AND q.state = 'sent'
          AND q.sent_via IS DISTINCT FROM 'email')::int AS cards_sent,
      (SELECT COUNT(DISTINCT (be.athlete_id, be.brand_key)) FROM brand_engagement be
         JOIN athletes a ON a.id = be.athlete_id
        WHERE a.agent_id = u.id
          AND be.state IN (${REACHED_STATES.map((s) => `'${s}'`).join(',')}))::int AS contacted
  ) reach ON TRUE`;

// The columns the fragment adds, for a SELECT list.
const COLUMNS = 'reach.emails_sent, reach.cards_sent, reach.contacted';

// Did this agent reach anyone at all? The funnel's step.
function reachedAny(row) {
  return Number(row && row.emails_sent || 0) + Number(row && row.cards_sent || 0) + Number(row && row.contacted || 0) > 0;
}

module.exports = { LATERAL, COLUMNS, REACHED_STATES, reachedAny };
