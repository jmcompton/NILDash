'use strict';
// ── THE FIRST SESSION: THREE STEPS BEFORE HOME (AGENT_SETUP_ON) ────────────
//
// 39 agent accounts, 21 never logged in, and only the 6 with a connected
// mailbox ever sent an email. Nothing a new agent does on Home works until
// three things are true, so they are asked for first, in this order, one
// screen each:
//
//   1  connect your email (Gmail or Outlook)   nothing can be sent without it
//   2  your business address                   the law requires it in every email
//   3  add an athlete or import a roster       the nightly has nobody to work for
//
// None can be skipped: each is something nothing works without. The steps are
// read from the facts every time (a mailbox row, the address columns, an
// athlete), so leaving and coming back resumes exactly where they left off,
// and a step done elsewhere (Settings, the import) counts.
//
// WHO: agents who have never sent an email -- new agents, and existing ones
// who never got that far. Once all three are done it is finished for good;
// a later disconnect is the ordinary banners' business, not this screen's.
//
// EACH STEP IS STAMPED the first time it is seen done (agent_setup), for the
// onboarding funnel (services/onboardingFunnel).
//
// Off (the default), required is always false and nothing is written.

const ON = () => process.env.AGENT_SETUP_ON === '1';
const STEPS = ['mailbox', 'address', 'athlete'];
const LABELS = {
  mailbox: 'Connect your email',
  address: 'Your business address',
  athlete: 'Add your athletes',
};

let _ready = null;
function ensureTable(pool) {
  if (_ready) return _ready;
  _ready = pool.query(`CREATE TABLE IF NOT EXISTS agent_setup (
      user_id TEXT PRIMARY KEY,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      mailbox_at TIMESTAMPTZ, address_at TIMESTAMPTZ, athlete_at TIMESTAMPTZ,
      done_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
    .catch((e) => { _ready = null; throw e; });
  return _ready;
}

// The facts, read fresh. One query, scoped to the one account.
async function facts(pool, userId) {
  const r = (await pool.query(
    `SELECT u.id, u.role, u.business_street, u.business_city, u.business_state, u.business_zip,
            EXISTS (SELECT 1 FROM email_accounts ea WHERE ea.user_id = u.id
                     AND COALESCE(ea.status, 'active') <> 'disconnected' AND ea.can_send IS NOT FALSE) AS mailbox,
            EXISTS (SELECT 1 FROM email_accounts ea WHERE ea.user_id = u.id AND ea.can_send IS FALSE
                     AND COALESCE(ea.status, 'active') <> 'disconnected') AS mailbox_cannot_send,
            (SELECT COUNT(*)::int FROM athletes a WHERE a.agent_id = u.id) AS athletes,
            EXISTS (SELECT 1 FROM outreach_logs l WHERE l.agent_id = u.id AND l.sent_at IS NOT NULL) AS ever_sent
       FROM users u WHERE u.id = $1`, [userId])).rows[0];
  if (!r) return null;
  const CS = require('./canSpam');
  return { role: r.role, mailbox: !!r.mailbox, mailboxCannotSend: !!r.mailbox_cannot_send,
    address: !!CS.formatAddress(r), athletes: Number(r.athletes) || 0, everSent: !!r.ever_sent };
}

// Pure: who the screen is for, and where they are.
//   f    facts()        row  the agent_setup row or null
function evaluate(f, row, on = ON()) {
  const done = { mailbox: !!f.mailbox, address: !!f.address, athlete: f.athletes > 0 };
  const steps = STEPS.map((k) => ({ key: k, label: LABELS[k], done: done[k], at: row ? row[k + '_at'] || null : null }));
  const n = steps.filter((s) => s.done).length;
  const current = (steps.find((s) => !s.done) || {}).key || null;
  let required = false, why;
  if (!on) why = 'AGENT_SETUP_ON is off';
  else if (f.role !== 'agent') why = 'not an agent account';
  else if (row && row.done_at) why = 'finished';
  else if (f.everSent) why = 'has sent an email';
  else if (!current) why = 'all three are done';
  else { required = true; why = `${n} of ${STEPS.length} done`; }
  return { on, required, why, steps, done: n, total: STEPS.length, current, progress: `${n} of ${STEPS.length} done`,
    mailboxCannotSend: !!f.mailboxCannotSend };
}

// Read, stamp what is newly done, and answer. Off: answers, writes nothing.
async function state(pool, userId) {
  const f = await facts(pool, userId);
  if (!f) return { on: ON(), required: false, why: 'no such account', steps: [], done: 0, total: STEPS.length, current: null };
  if (!ON() || f.role !== 'agent') return evaluate(f, null);
  await ensureTable(pool);
  let row = (await pool.query(`SELECT * FROM agent_setup WHERE user_id = $1`, [userId])).rows[0] || null;
  const first = evaluate(f, row);
  // Not started, and nothing to do: never write a row for an agent the screen
  // was never for (they had sent, or had all three, before it existed).
  if (!row && !first.required) return first;
  if (!row) {
    row = (await pool.query(`INSERT INTO agent_setup (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW() RETURNING *`, [userId])).rows[0];
  }
  const sets = [];
  for (const s of first.steps) if (s.done && !row[s.key + '_at']) sets.push(`${s.key}_at = NOW()`);
  if (!first.current && !row.done_at) sets.push('done_at = NOW()');
  if (sets.length) {
    row = (await pool.query(`UPDATE agent_setup SET ${sets.join(', ')}, updated_at = NOW() WHERE user_id = $1 RETURNING *`, [userId])).rows[0];
  }
  return evaluate(f, row);
}

module.exports = { ON, STEPS, LABELS, ensureTable, facts, evaluate, state };
