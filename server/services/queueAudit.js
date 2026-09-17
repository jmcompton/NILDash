'use strict';
// ── THE LIVE QUEUE, AUDITED AGAINST THE ONE RULE ────────────────────────────
//
// services/outreachQueue.cardNameProblem is the rule (a real named person on
// the card, and the message opens to them); jobs/outreachQueue.insertCard is
// where it is enforced for every new card. This is the same rule read back
// over the cards that already exist, for three callers:
//
//   scripts/retire-nameless-cards.js         list, or retire, from a terminal
//   GET /api/admin/nameless-cards[?apply=1]  the same from the browser
//   scripts/spend-breakdown.js               "live cards with no named
//                                             contact: N (must be 0)"
//
// And the email side of the same card: a card whose address shows "Not
// checked yet" has no email_verification row. checkQueuedEmails runs the
// verifier (services/emailVerify) over every such address.

const Q = require('./outreachQueue');

// Every queued card, with the draft body when it is an email card, and the
// problem (or null) beside it.
async function namelessCards(pool, opts = {}) {
  const params = [];
  let where = `q.state = 'queued'`;
  if (opts.agentId) { params.push(opts.agentId); where += ` AND q.agent_id = $${params.length}`; }
  const r = await pool.query(
    `SELECT q.id, q.agent_id, q.athlete_id, q.brand_name, q.lane, q.channel, q.contact_name, q.contact_title,
            q.dm_text, q.email, q.email_note, q.outreach_log_id, q.created_at, q.slot,
            a.data->>'name' AS athlete_name, u.email AS agent_email, l.body_html AS draft_body, l.source AS draft_source
       FROM outreach_queue q
       JOIN athletes a ON a.id = q.athlete_id
       LEFT JOIN users u ON u.id = q.agent_id
       LEFT JOIN outreach_logs l ON l.id = q.outreach_log_id
      WHERE ${where}
      ORDER BY u.email, a.data->>'name', q.slot`, params);
  const rows = r.rows.map((c) => ({ ...c, problem: Q.cardNameProblem(c) }));
  const bad = rows.filter((c) => c.problem);
  const perAgent = {};
  for (const c of bad) {
    const k = c.agent_email || c.agent_id;
    perAgent[k] = (perAgent[k] || 0) + 1;
  }
  return { total: rows.length, bad, perAgent };
}

// Retire them: state 'retired', outcome 'no_name' (frees the slot for tonight,
// keeps the record), and stop the linked email draft so it cannot be approved.
async function retireNameless(pool, ids) {
  const list = (ids || []).map((x) => parseInt(x, 10)).filter(Boolean);
  if (!list.length) return { retired: 0, stopped: 0 };
  const r1 = await pool.query(
    `UPDATE outreach_queue SET state = 'retired', outcome = 'no_name', outcome_at = NOW(), updated_at = NOW()
      WHERE id = ANY($1::int[]) AND state = 'queued' RETURNING outreach_log_id`, [list]);
  const logIds = r1.rows.map((x) => x.outreach_log_id).filter(Boolean);
  let stopped = 0;
  if (logIds.length) {
    const r2 = await pool.query(
      `UPDATE outreach_logs SET cadence_stopped_at = NOW(), cadence_stop_reason = 'retired: no contact name to greet', updated_at = NOW()
        WHERE id = ANY($1::text[]) AND status = 'draft' AND approved_at IS NULL AND cadence_stopped_at IS NULL`, [logIds]);
    stopped = r2.rowCount;
  }
  return { retired: r1.rowCount, stopped };
}

// The count the spend report prints. Zero is the only acceptable number.
async function namelessLiveCount(pool) {
  const { total, bad } = await namelessCards(pool);
  return { live: total, nameless: bad.length, sample: bad.slice(0, 8).map((c) => ({ id: c.id, agent: c.agent_email || c.agent_id, athlete: c.athlete_name, brand: c.brand_name, problem: c.problem })) };
}

// ── "NOT CHECKED YET": RUN THE CHECK ────────────────────────────────────────
// Every queued email card whose address has no email_verification row. With
// apply, the verifier runs on each (MX, then the mailbox verifier when a key is
// set) and records what it found; without, it only lists them.
async function checkQueuedEmails(pool, opts = {}) {
  const r = await pool.query(
    `SELECT q.id, q.agent_id, q.brand_name, q.email, u.email AS agent_email, a.data->>'name' AS athlete_name
       FROM outreach_queue q
       JOIN athletes a ON a.id = q.athlete_id
       LEFT JOIN users u ON u.id = q.agent_id
      WHERE q.state = 'queued' AND q.channel = 'email' AND q.email IS NOT NULL AND q.email <> ''
        AND NOT EXISTS (SELECT 1 FROM email_verification v WHERE v.email = LOWER(TRIM(q.email)))
      ORDER BY u.email, q.id`);
  const cards = r.rows;
  const emails = [...new Set(cards.map((c) => String(c.email).trim().toLowerCase()))];
  if (!opts.apply || !emails.length) return { cards: cards.length, addresses: emails.length, applied: false, results: null };
  const EV = require('./emailVerify');
  const res = await EV.verifyMany(pool, emails, { concurrency: opts.concurrency || 4, deadlineMs: opts.deadlineMs || 120000 });
  const tally = {};
  const byCard = [];
  for (const c of cards) {
    const v = res.get(String(c.email).trim().toLowerCase()) || { result: 'unknown', detail: 'no answer', source: 'none' };
    tally[v.result] = (tally[v.result] || 0) + 1;
    byCard.push({ id: c.id, agent: c.agent_email || c.agent_id, athlete: c.athlete_name, brand: c.brand_name, email: c.email, result: v.result, detail: v.detail || null, source: v.source || null });
  }
  return { cards: cards.length, addresses: emails.length, applied: true, tally, results: byCard };
}

module.exports = { namelessCards, retireNameless, namelessLiveCount, checkQueuedEmails };
