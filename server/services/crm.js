'use strict';
// ── THE AGENT'S CRM (CRM_ON) ────────────────────────────────────────────────
//
// What happened, what comes next, and why, on every deal:
//
//   WHAT HAPPENED   Replied / No reply yet / Declined / Got a bounce email
//   ASK FIRST       an optional first stage before anything is sent:
//                   "Ask the athlete"
//   AFTER REPLIED   Proposal and negotiation, Contract signed, Filed with
//                   NIL Go, Cleared, Paid
//   NEXT STEP       the agent's to-do on the deal, listed on Home
//   WHY             a decline needs a reason; a signed or paid deal asks why
//                   it worked. "Other" takes a short note.
//
// The deal is the Pipeline row (athlete_self_deals), one per athlete and
// business. Its board stage (services/pipeline) still moves the way it always
// has; crm_stage is the finer stage the agent sets. A deal shows signed only
// when the agent marks it: Contract signed and everything after it need a
// logged deal (services/dealLog), which only "Mark deal signed" writes.
//
// Existing deals keep their status: every column is new and nullable, and a
// deal with no crm_stage reads its stage off the board as before.

const PIPE = require('./pipeline');

const ON = () => process.env.CRM_ON === '1';

const WHAT = [
  ['replied', 'Replied'],
  ['no_reply', 'No reply yet'],
  ['declined', 'Declined'],
  ['bounced', 'Got a bounce email'],
];
const ASK = ['ask_athlete', 'Ask the athlete'];
const STAGES = [
  ['proposal', 'Proposal and negotiation'],
  ['contract_signed', 'Contract signed'],
  ['filed_nil_go', 'Filed with NIL Go'],
  ['cleared', 'Cleared'],
  ['paid', 'Paid'],
];
const NEXT = [
  ['ask_athlete', 'Ask the athlete'],
  ['talk_athlete', 'Talk to athlete'],
  ['draft_proposal', 'Draft proposal'],
  ['negotiate', 'Negotiate'],
  ['send_contract', 'Send contract'],
  ['file_nil_go', 'File with NIL Go'],
  ['waiting_payment', 'Waiting on payment'],
  ['done', 'Done'],
];
const DECLINE = [
  ['no_budget', 'No budget'],
  ['no_nil', "Doesn't understand NIL"],
  ['no_value', "Doesn't see the value in the athlete"],
  ['few_followers', "Athlete doesn't have enough followers"],
  ['agency', 'Not comfortable with the agency'],
  ['not_fit', 'Not the right fit'],
  ['timing', 'Bad timing'],
  ['other', 'Other'],
];
const WIN = [
  ['loved_athlete', 'Loved the athlete'],
  ['loved_offer', 'Loved the offer or menu item'],
  ['campus_brand', 'Wanted brand recognition on campus'],
  ['specials', 'Promoting their specials'],
  ['other', 'Other'],
];
// Every stage the agent can set, and the ones that mean a deal was signed.
const CRM_STAGES = ['ask_athlete', 'sent', 'replied', 'declined', 'bounced', ...STAGES.map((s) => s[0])];
const SIGNED = ['contract_signed', 'filed_nil_go', 'cleared', 'paid'];
const NOTE_MAX = 200;

const labelIn = (list, key) => { const x = list.find((p) => p[0] === key); return x ? x[1] : null; };
const asItems = (list) => list.map(([key, label]) => ({ key, label }));
function stageLabel(key) {
  if (key === ASK[0]) return ASK[1];
  if (key === 'sent') return 'No reply yet';
  return labelIn(WHAT, key) || labelIn(STAGES, key);
}

function vocab() {
  return { what: asItems(WHAT), ask: { key: ASK[0], label: ASK[1] }, stages: asItems(STAGES), next: asItems(NEXT),
    decline: asItems(DECLINE), win: asItems(WIN), signed: SIGNED.slice() };
}

// A reason from the list, and a note when it is "Other". kind: 'declined' | 'won'.
function checkReason(kind, reason, note) {
  const list = kind === 'declined' ? DECLINE : WIN;
  const key = String(reason || '').trim();
  if (!labelIn(list, key)) {
    return { ok: false, error: kind === 'declined' ? 'Pick why they declined.' : 'Pick why it worked.' };
  }
  const n = String(note == null ? '' : note).replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
  if (key === 'other' && !n) return { ok: false, error: 'Add a short note for Other.' };
  return { ok: true, reason: key, note: key === 'other' ? n : (n || null), label: labelIn(list, key) };
}

// ── THE COLUMNS ─────────────────────────────────────────────────────────────
// store.js adds the same columns at boot; this is for a caller that runs
// before that has, and it is idempotent.
let _cols = null;
function ensureColumns(pool) {
  if (_cols) return _cols;
  _cols = (async () => {
    const add = [
      ['athlete_self_deals', ['crm_stage TEXT', 'crm_stage_at TIMESTAMPTZ', 'next_step TEXT', 'next_step_at TIMESTAMPTZ',
        'decline_reason TEXT', 'decline_note TEXT', 'win_reason TEXT', 'win_note TEXT']],
      ['outreach_queue', ['decline_reason TEXT', 'decline_note TEXT']],
      ['deal_outcomes', ['win_reason TEXT', 'win_note TEXT']],
    ];
    for (const [t, cols] of add) {
      for (const c of cols) await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c}`).catch(() => {});
    }
  })();
  return _cols;
}

// ── THE DEAL ────────────────────────────────────────────────────────────────
async function dealFor(pool, agentId, athleteId, brand) {
  return (await pool.query(
    `SELECT d.* FROM athlete_self_deals d JOIN athletes a ON a.id = d.athlete_id AND a.agent_id = $2
      WHERE d.athlete_id = $1 AND LOWER(TRIM(d.brand_name)) = LOWER(TRIM($3))
      ORDER BY d.created_at ASC LIMIT 1`, [athleteId, agentId, brand])).rows[0] || null;
}

// What a request names -> the athlete, the business, and the deal if there is
// one. ref: { dealId } | { cardId: 'queue:<id>' | 'email:<id>' } | { athleteId, brand }.
// Always this agent's own; anything else is null.
async function resolve(pool, agentId, ref = {}) {
  let athleteId = null, brand = null, deal = null, queueId = null, logId = null, sent = false;
  if (ref.dealId != null && ref.dealId !== '') {
    deal = (await pool.query(
      `SELECT d.* FROM athlete_self_deals d JOIN athletes a ON a.id = d.athlete_id AND a.agent_id = $2 WHERE d.id = $1`,
      [Number(ref.dealId) || 0, agentId])).rows[0] || null;
    if (!deal) return null;
    athleteId = deal.athlete_id; brand = deal.brand_name;
  } else if (ref.cardId) {
    const m = /^(queue|email):(.+)$/.exec(String(ref.cardId));
    if (!m) return null;
    if (m[1] === 'queue') {
      const c = (await pool.query(`SELECT id, athlete_id, brand_name, outreach_log_id, state, sent_at FROM outreach_queue WHERE id = $1 AND agent_id = $2`,
        [Number(m[2]) || 0, agentId])).rows[0];
      if (!c) return null;
      athleteId = c.athlete_id; brand = c.brand_name; queueId = c.id; logId = c.outreach_log_id || null;
      sent = c.state === 'sent' || !!c.sent_at;
    } else {
      const l = (await pool.query(`SELECT id, athlete_id, brand_name, sent_at FROM outreach_logs WHERE id = $1 AND agent_id = $2`, [m[2], agentId])).rows[0];
      if (!l) return null;
      athleteId = l.athlete_id; brand = l.brand_name; logId = l.id; sent = !!l.sent_at;
      const c = (await pool.query(`SELECT id FROM outreach_queue WHERE outreach_log_id = $1 AND agent_id = $2 ORDER BY id DESC LIMIT 1`, [l.id, agentId])).rows[0];
      if (c) queueId = c.id;
    }
  } else if (ref.athleteId && ref.brand) {
    const own = (await pool.query(`SELECT 1 FROM athletes WHERE id = $1 AND agent_id = $2`, [ref.athleteId, agentId])).rows[0];
    if (!own) return null;
    athleteId = ref.athleteId; brand = String(ref.brand).trim();
  } else return null;
  if (!athleteId || !brand) return null;
  if (!deal) deal = await dealFor(pool, agentId, athleteId, brand);
  if (!sent) {
    sent = !!(await pool.query(
      `SELECT 1 FROM outreach_queue WHERE agent_id = $1 AND athlete_id = $2 AND LOWER(TRIM(brand_name)) = LOWER(TRIM($3))
          AND (state = 'sent' OR sent_at IS NOT NULL)
       UNION ALL
       SELECT 1 FROM outreach_logs WHERE agent_id = $1 AND athlete_id = $2 AND LOWER(TRIM(brand_name)) = LOWER(TRIM($3)) AND sent_at IS NOT NULL
       LIMIT 1`, [agentId, athleteId, brand])).rows[0];
  }
  return { athleteId, brand, deal, queueId, logId, sent };
}

// The deal row, made when there is none yet, at the board stage that matches.
async function ensureDeal(pool, agentId, r, boardStage, note) {
  if (r.deal) return r.deal;
  const moved = await PIPE.enterStage(pool, { athleteId: r.athleteId, agentId, brandName: r.brand,
    stage: boardStage || (r.sent ? PIPE.OUTREACH_SENT : PIPE.FIRST), note: note || 'Added from the CRM', source: 'crm' });
  r.deal = (moved && moved.deal) || await dealFor(pool, agentId, r.athleteId, r.brand);
  return r.deal;
}

// A logged deal (deal_outcomes) for this athlete and business: the one thing
// that makes a deal signed.
async function loggedDeal(pool, agentId, athleteId, brand) {
  return (await pool.query(
    `SELECT id, win_reason FROM deal_outcomes WHERE agent_id = $1 AND athlete_id = $2 AND LOWER(TRIM(brand)) = LOWER(TRIM($3))
      ORDER BY id DESC LIMIT 1`, [agentId, athleteId, brand]).catch(() => ({ rows: [] }))).rows[0] || null;
}

// ── THE AGENT SETS A STAGE OR A NEXT STEP ───────────────────────────────────
// change: { stage, nextStep, reason, note }. -> { ok, deal } | { ok:false, status, error, needs }
async function update(pool, agentId, ref, change = {}) {
  await ensureColumns(pool);
  const r = await resolve(pool, agentId, ref);
  if (!r) return { ok: false, status: 404, error: 'That deal is not one of yours.' };
  const stage = change.stage != null && change.stage !== '' ? String(change.stage) : null;
  const hasNext = Object.prototype.hasOwnProperty.call(change, 'nextStep');
  const nextStep = hasNext ? (change.nextStep ? String(change.nextStep) : null) : undefined;
  if (stage && stage !== ASK[0] && !labelIn(STAGES, stage)) return { ok: false, status: 400, error: 'Unknown stage.' };
  if (hasNext && nextStep && !labelIn(NEXT, nextStep)) return { ok: false, status: 400, error: 'Unknown next step.' };
  if (!stage && !hasNext) return { ok: false, status: 400, error: 'Nothing to change.' };

  let why = null;
  if (stage === ASK[0] && r.sent) return { ok: false, status: 409, error: 'This one has gone out already. Ask the athlete is the step before sending.' };
  if (stage && SIGNED.includes(stage)) {
    // SIGNED ONLY WHEN THE AGENT MARKS IT: a logged deal first, and why it worked.
    const logged = await loggedDeal(pool, agentId, r.athleteId, r.brand);
    if (!logged) return { ok: false, status: 409, needs: 'deal', error: 'Mark the deal signed first: it asks the amount and why it worked.' };
    const have = (r.deal && r.deal.win_reason) || logged.win_reason;
    if (change.reason) {
      why = checkReason('won', change.reason, change.note);
      if (!why.ok) return { ok: false, status: 400, needs: 'why', error: why.error };
    } else if (!have) return { ok: false, status: 400, needs: 'why', error: 'Pick why it worked.' };
  }

  const board = stage === ASK[0] ? PIPE.FIRST : stage === 'proposal' ? 'Negotiating' : null;
  const deal = await ensureDeal(pool, agentId, r, board);
  if (!deal) return { ok: false, status: 500, error: 'Could not find or make the deal.' };
  if (stage === 'proposal') {
    await PIPE.enterStage(pool, { athleteId: r.athleteId, agentId, brandName: r.brand, stage: 'Negotiating', note: 'Proposal and negotiation', source: 'crm' });
  }
  const sets = [], vals = [deal.id];
  const put = (sql, v) => { vals.push(v); sets.push(sql.replace('?', '$' + vals.length)); };
  if (stage) {
    put('crm_stage = ?', stage); sets.push('crm_stage_at = NOW()');
    if (stage === 'paid') sets.push('paid_date = COALESCE(paid_date, CURRENT_DATE)');
    // Asking the athlete first is the deal's next step too, unless one is set.
    if (stage === ASK[0] && !hasNext && !deal.next_step) { put('next_step = ?', ASK[0]); sets.push('next_step_at = NOW()'); }
  }
  if (why) { put('win_reason = ?', why.reason); put('win_note = ?', why.note); }
  if (hasNext) { put('next_step = ?', nextStep); sets.push('next_step_at = NOW()'); }
  sets.push('updated_at = NOW()');
  const out = (await pool.query(`UPDATE athlete_self_deals SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals)).rows[0];
  if (why) {
    await pool.query(
      `UPDATE deal_outcomes SET win_reason = $4, win_note = $5
        WHERE id = (SELECT id FROM deal_outcomes WHERE agent_id = $1 AND athlete_id = $2 AND LOWER(TRIM(brand)) = LOWER(TRIM($3)) ORDER BY id DESC LIMIT 1)`,
      [agentId, r.athleteId, r.brand, why.reason, why.note]).catch(() => {});
  }
  return { ok: true, deal: payloadOf(out) };
}

// ── WHAT HAPPENED, FROM A CARD ──────────────────────────────────────────────
// The card outcome route (index.js) has already marked the card; this keeps
// the deal's stage and the decline reason with it. Never moves a deal that is
// past Replied back to an earlier answer.
async function afterCardOutcome(pool, card, outcome, why) {
  if (!card) return;
  await ensureColumns(pool);
  const r = { athleteId: card.athlete_id, brand: card.brand_name, sent: true, deal: await dealFor(pool, card.agent_id, card.athlete_id, card.brand_name) };
  const answerStages = [null, ASK[0], 'sent', 'replied', 'declined', 'bounced'];
  if (outcome === 'declined') {
    await pool.query(`UPDATE outreach_queue SET decline_reason = $2, decline_note = $3 WHERE id = $1`, [card.id, why.reason, why.note]);
    const deal = await ensureDeal(pool, card.agent_id, r, PIPE.OUTREACH_SENT);
    if (deal && answerStages.includes(deal.crm_stage || null)) {
      await pool.query(`UPDATE athlete_self_deals SET crm_stage = 'declined', crm_stage_at = NOW(), decline_reason = $2, decline_note = $3, updated_at = NOW() WHERE id = $1`,
        [deal.id, why.reason, why.note]);
    }
  } else if (outcome === 'replied' || outcome === 'no_reply') {
    const deal = r.deal;
    if (deal && answerStages.includes(deal.crm_stage || null)) {
      await pool.query(`UPDATE athlete_self_deals SET crm_stage = $2, crm_stage_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [deal.id, outcome === 'replied' ? 'replied' : 'sent']);
    }
  }
}

// ── WHAT HAPPENED, FROM THE TRACKER (an email, by its log) ──────────────────
// Declined: they answered, so the thread is replied (follow-ups stop, the
// ledger hears it), the card and the ledger say declined, and the reason is
// kept. Needs a sent email.
async function declineLog(pool, agentId, logId, reason, note) {
  await ensureColumns(pool);
  const why = checkReason('declined', reason, note);
  if (!why.ok) return { ok: false, status: 400, error: why.error };
  const log = (await pool.query(`SELECT * FROM outreach_logs WHERE id = $1 AND agent_id = $2`, [logId, agentId])).rows[0];
  if (!log) return { ok: false, status: 404, error: 'Outreach not found' };
  if (!log.sent_at) return { ok: false, status: 400, error: 'Send this outreach before marking what happened.' };
  if (!log.replied_at) await require('./followUpAutomation').markReplied(log.id);
  const cards = (await pool.query(
    `UPDATE outreach_queue SET outcome = 'declined', outcome_at = NOW(), updated_at = NOW(), replied_at = COALESCE(replied_at, NOW()),
            decline_reason = $3, decline_note = $4
      WHERE agent_id = $1 AND (outreach_log_id = $2 OR (athlete_id = $5 AND LOWER(TRIM(brand_name)) = LOWER(TRIM($6)) AND state = 'sent'))
        AND COALESCE(outcome, '') <> 'closed'
      RETURNING id`, [agentId, log.id, why.reason, why.note, log.athlete_id, log.brand_name || ''])).rows;
  await pool.query(
    `UPDATE brand_engagement SET outcome = 'declined', outcome_at = NOW(), updated_at = NOW()
      WHERE athlete_id = $1 AND LOWER(TRIM(brand_name)) = LOWER(TRIM($2)) AND state <> 'closed'`, [log.athlete_id, log.brand_name || '']).catch(() => {});
  const r = { athleteId: log.athlete_id, brand: log.brand_name, sent: true, deal: await dealFor(pool, agentId, log.athlete_id, log.brand_name) };
  const deal = await ensureDeal(pool, agentId, r, PIPE.OUTREACH_SENT);
  if (deal && !SIGNED.includes(deal.crm_stage)) {
    await pool.query(`UPDATE athlete_self_deals SET crm_stage = 'declined', crm_stage_at = NOW(), decline_reason = $2, decline_note = $3, updated_at = NOW() WHERE id = $1`,
      [deal.id, why.reason, why.note]);
  }
  return { ok: true, cards: cards.map((c) => c.id), reason: why.label };
}

// The tracker's Replied and No reply yet keep the deal's stage with the log.
async function afterLogReply(pool, agentId, logId, replied) {
  await ensureColumns(pool);
  const log = (await pool.query(`SELECT athlete_id, brand_name FROM outreach_logs WHERE id = $1 AND agent_id = $2`, [logId, agentId])).rows[0];
  if (!log) return;
  const deal = await dealFor(pool, agentId, log.athlete_id, log.brand_name);
  if (deal && [null, ASK[0], 'sent', 'replied', 'declined', 'bounced'].includes(deal.crm_stage || null)) {
    await pool.query(`UPDATE athlete_self_deals SET crm_stage = $2, crm_stage_at = NOW(), updated_at = NOW() WHERE id = $1`, [deal.id, replied ? 'replied' : 'sent']);
  }
}

// Got a bounce email: the address gets no more email, the thread's follow-ups
// stop, and the deal says so. The same steps as the send gate's "This
// bounced" (routes/outreach), with or without the gate on.
async function bounceLog(pool, agentId, logId) {
  await ensureColumns(pool);
  const SG = require('./sendGate');
  await SG.ensureColumns(pool);
  const log = (await pool.query(`SELECT * FROM outreach_logs WHERE id = $1 AND agent_id = $2`, [logId, agentId])).rows[0];
  if (!log) return { ok: false, status: 404, error: 'Outreach log not found' };
  if (!log.sent_at) return { ok: false, status: 400, error: 'Only an email that was sent can bounce.' };
  if (!log.sent_to_email) return { ok: false, status: 400, error: 'This email has no address on record.' };
  const sup = await require('./sendRules').suppressManually(pool, log.sent_to_email, {
    reason: `bounced: reported from the agent's inbox (${log.brand_name || 'outreach'})`, by: agentId, kind: 'bounce' });
  if (!sup.ok) return { ok: false, status: 400, error: sup.error };
  const thread = await require('./suppression').stopCadence(pool, log, 'the first email bounced (reported by the agent)');
  await pool.query(`UPDATE outreach_logs SET bounced_at = COALESCE(bounced_at, NOW()), bounced_by = $2, updated_at = NOW() WHERE id = $1`, [log.id, agentId]);
  const deal = await dealFor(pool, agentId, log.athlete_id, log.brand_name);
  if (deal && [null, ASK[0], 'sent', 'replied', 'declined'].includes(deal.crm_stage || null)) {
    await pool.query(`UPDATE athlete_self_deals SET crm_stage = 'bounced', crm_stage_at = NOW(), updated_at = NOW() WHERE id = $1`, [deal.id]);
  }
  return { ok: true, suppressed: sup.email, stopped: (sup.stopped || 0) + (thread || 0) };
}

// ── WHAT THE PAGE READS ─────────────────────────────────────────────────────
function payloadOf(d) {
  if (!d) return null;
  const board = PIPE.normalizeStage(d.stage);
  // A deal from before the CRM reads its stage off the board: a closed deal
  // was signed; nothing else is assumed.
  const stage = d.crm_stage || (board === 'Closed' ? 'contract_signed' : null);
  return {
    dealId: d.id, stage, stageLabel: stage ? stageLabel(stage) : null, board,
    nextStep: d.next_step || null, nextStepLabel: d.next_step ? labelIn(NEXT, d.next_step) : null,
    declineReason: d.decline_reason || null, declineLabel: d.decline_reason ? labelIn(DECLINE, d.decline_reason) : null, declineNote: d.decline_note || null,
    winReason: d.win_reason || null, winLabel: d.win_reason ? labelIn(WIN, d.win_reason) : null, winNote: d.win_note || null,
  };
}

// The agent's to-do list: every deal with a next step that is not Done,
// oldest first.
async function todo(pool, agentId, limit) {
  await ensureColumns(pool);
  const rows = (await pool.query(
    `SELECT d.*, a.data->>'name' AS athlete_name
       FROM athlete_self_deals d JOIN athletes a ON a.id = d.athlete_id
      WHERE a.agent_id = $1 AND d.next_step IS NOT NULL AND d.next_step <> 'done'
      ORDER BY d.next_step_at ASC NULLS LAST, d.id ASC LIMIT $2`, [agentId, Math.min(100, Math.max(1, Number(limit) || 30))])).rows;
  return rows.map((d) => ({ ...payloadOf(d), athleteId: d.athlete_id, athlete: d.athlete_name || null, business: d.brand_name, since: d.next_step_at || null }));
}

module.exports = { ON, WHAT, ASK, STAGES, NEXT, DECLINE, WIN, CRM_STAGES, SIGNED, vocab, labelIn, stageLabel, checkReason,
  ensureColumns, dealFor, resolve, update, afterCardOutcome, declineLog, afterLogReply, bounceLog, payloadOf, todo, loggedDeal };
