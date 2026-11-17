'use strict';
// ── NIL GO, MADE EASY (the agent's NIL Go tab) ──────────────────────────────
//
// Under the House settlement every Division I athlete reports each third-party
// NIL deal worth $600 or more (in total, bonuses and royalties included) to
// NIL Go, the College Sports Commission's clearinghouse, within 5 business days
// of signing. The athlete submits, or one representative they name. Missing it
// can cost eligibility. A deal comes back cleared, sent back for changes, or
// not cleared (revise, cancel and refund, or appeal to arbitration).
// Source: collegesportscommission.org/for-student-athletes.
//
// NIL Go takes no submissions from outside apps, so NILDash does the part
// around it: every signed deal is listed with its deadline, the facts NIL Go
// asks for are laid out to copy, the one question only the agent can answer
// (is this business tied to the school, a booster or a collective) is asked,
// and the status is tracked: to file, filed, cleared, sent back, not cleared,
// or not needed.
//
// WHICH DEALS. A Pipeline deal (athlete_self_deals) that is signed: its CRM
// stage is contract signed or later, its board stage is Closed, or a signed
// deal was logged for it (deal_outcomes). $600 or more needs NIL Go; no amount
// on file asks for the amount; under $600 is not needed (filing anyway is
// allowed).
//
// THE DEADLINE counts 5 business days (Monday to Friday) from the day the deal
// was first seen signed, kept on the row so it never drifts. Holidays are not
// counted out; the page says so.

const THRESHOLD = 600;
const STATUSES = ['to_file', 'filed', 'cleared', 'returned', 'not_cleared', 'not_needed'];
const LABEL = { to_file: 'To file', filed: 'Filed, waiting', cleared: 'Cleared', returned: 'Sent back for changes', not_cleared: 'Not cleared', not_needed: 'Not needed' };
const ASSOCIATED = ['no', 'yes', 'unsure'];
const SIGNED_CRM = ['contract_signed', 'filed_nil_go', 'cleared', 'paid'];

async function ensureColumns(pool) {
  for (const c of ['nil_go_status TEXT', 'nil_go_signed_at TIMESTAMPTZ', 'nil_go_filed_at TIMESTAMPTZ', 'nil_go_cleared_at TIMESTAMPTZ',
    'nil_go_note TEXT', 'nil_go_associated TEXT', 'nil_go_updated_at TIMESTAMPTZ']) {
    await pool.query(`ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS ${c}`).catch(() => {});
  }
  for (const c of ['crm_stage TEXT', 'crm_stage_at TIMESTAMPTZ']) await pool.query(`ALTER TABLE athlete_self_deals ADD COLUMN IF NOT EXISTS ${c}`).catch(() => {});
}

// 5 business days after a date (Mon to Fri). -> Date at the end of that day, UTC.
function deadlineFrom(signed) {
  const d = new Date(signed);
  let left = 5;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  d.setUTCHours(23, 59, 59, 0);
  return d;
}
function daysLeft(deadline, now = new Date()) {
  return Math.ceil((new Date(deadline).getTime() - now.getTime()) / 86400000);
}

const money = (v) => (v == null || v === '' ? null : Number(v));

// The agent's signed deals with what NIL Go needs. -> [deal]
async function list(pool, agentId, { now = new Date() } = {}) {
  await ensureColumns(pool);
  // First time a deal is seen signed: remember when, so the deadline holds.
  await pool.query(
    `UPDATE athlete_self_deals d SET nil_go_signed_at = COALESCE(
        (SELECT MIN(o.closed_at) FROM deal_outcomes o WHERE o.deal_id = d.id::text),
        CASE WHEN d.crm_stage = ANY($2::text[]) THEN d.crm_stage_at END,
        d.updated_at, NOW())
      WHERE d.agent_id = $1 AND d.nil_go_signed_at IS NULL
        AND (d.crm_stage = ANY($2::text[]) OR d.stage = 'Closed'
             OR EXISTS (SELECT 1 FROM deal_outcomes o WHERE o.deal_id = d.id::text))`, [agentId, SIGNED_CRM]).catch((e) => console.warn('[nil-go] signed stamp:', e.message));
  const rows = (await pool.query(
    `SELECT d.*, a.data->>'name' AS athlete_name, a.data->>'school' AS school, a.data->>'sport' AS sport,
            (SELECT o.deal_value FROM deal_outcomes o WHERE o.deal_id = d.id::text ORDER BY o.closed_at DESC LIMIT 1) AS logged_value,
            (SELECT o.deliverable FROM deal_outcomes o WHERE o.deal_id = d.id::text ORDER BY o.closed_at DESC LIMIT 1) AS logged_deliverable
       FROM athlete_self_deals d JOIN athletes a ON a.id = d.athlete_id AND a.agent_id = $1
      WHERE d.agent_id = $1 AND d.nil_go_signed_at IS NOT NULL
      ORDER BY d.nil_go_signed_at DESC`, [agentId])).rows;
  return rows.map((d) => shape(d, now));
}

function shape(d, now) {
  const value = money(d.value) != null ? money(d.value) : money(d.logged_value);
  let status = STATUSES.includes(d.nil_go_status) ? d.nil_go_status : null;
  if (!status) status = d.crm_stage === 'cleared' ? 'cleared' : d.crm_stage === 'filed_nil_go' ? 'filed' : (value != null && value < THRESHOLD ? 'not_needed' : 'to_file');
  const deadline = deadlineFrom(d.nil_go_signed_at);
  const left = daysLeft(deadline, now);
  const needsAmount = value == null;
  const fields = [
    ['Athlete', d.athlete_name],
    ['School and sport', [d.school, d.sport].filter(Boolean).join(', ') || null],
    ['Who is paying (business name)', d.brand_name],
    ['Business contact', [d.contact_name, d.contact_email].filter(Boolean).join(', ') || null],
    ['Total compensation', value != null ? '$' + value.toLocaleString('en-US') : null],
    ['Payment terms', d.timeline || null],
    ['What the athlete delivers', d.deliverables || d.logged_deliverable || d.description || null],
    ['Start date', d.start_date ? String(d.start_date instanceof Date ? d.start_date.toISOString().slice(0, 10) : d.start_date).slice(0, 10) : null],
    ['Date signed', new Date(d.nil_go_signed_at).toISOString().slice(0, 10)],
    ['Tied to the school, a booster or a collective', d.nil_go_associated === 'no' ? 'No' : d.nil_go_associated === 'yes' ? 'Yes' : d.nil_go_associated === 'unsure' ? 'Not sure' : null],
  ].map(([label, v]) => ({ label, value: v || null }));
  const missing = fields.filter((f) => !f.value).map((f) => f.label);
  return {
    id: d.id, athlete: d.athlete_name, brand: d.brand_name, value, status, statusLabel: LABEL[status],
    signedAt: d.nil_go_signed_at, deadline: deadline.toISOString(), daysLeft: left,
    overdue: status === 'to_file' && left < 0, dueSoon: status === 'to_file' && left >= 0 && left <= 2,
    needsAmount, associated: d.nil_go_associated || null, note: d.nil_go_note || null,
    hasContract: !!(d.agreement_text || d.agreement_json), fields, missing,
  };
}

// The agent sets the status, the association answer or a note. Filed and
// cleared move the CRM stage with it. -> { ok, deal } | { ok:false, status, error }
async function update(pool, agentId, dealId, body = {}) {
  await ensureColumns(pool);
  const d = (await pool.query(`SELECT d.id FROM athlete_self_deals d JOIN athletes a ON a.id = d.athlete_id AND a.agent_id = $1 WHERE d.id = $2 AND d.agent_id = $1`,
    [agentId, Number(dealId) || 0])).rows[0];
  if (!d) return { ok: false, status: 404, error: 'Deal not found.' };
  const sets = ['nil_go_updated_at = NOW()'], vals = [d.id];
  const put = (sql, v) => { vals.push(v); sets.push(sql.replace('?', '$' + vals.length)); };
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) return { ok: false, status: 400, error: 'Unknown status.' };
    put('nil_go_status = ?', body.status);
    if (body.status === 'filed') { sets.push('nil_go_filed_at = COALESCE(nil_go_filed_at, NOW())'); sets.push(`crm_stage = 'filed_nil_go'`, 'crm_stage_at = NOW()'); }
    if (body.status === 'cleared') { sets.push('nil_go_cleared_at = COALESCE(nil_go_cleared_at, NOW())', 'nil_go_filed_at = COALESCE(nil_go_filed_at, NOW())'); sets.push(`crm_stage = 'cleared'`, 'crm_stage_at = NOW()'); }
  }
  if (body.associated !== undefined) {
    if (body.associated !== null && !ASSOCIATED.includes(body.associated)) return { ok: false, status: 400, error: 'Answer yes, no or not sure.' };
    put('nil_go_associated = ?', body.associated);
  }
  if (body.note !== undefined) put('nil_go_note = ?', String(body.note || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 500) || null);
  if (body.value !== undefined) {
    const v = Number(String(body.value).replace(/[$,\s]/g, ''));
    if (!(v >= 0) || v > 100000000) return { ok: false, status: 400, error: 'Enter the amount in dollars.' };
    put('value = ?', v);
  }
  await pool.query(`UPDATE athlete_self_deals SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, vals);
  const deal = (await list(pool, agentId)).find((x) => x.id === d.id) || null;
  return { ok: true, deal };
}

// Counts for a badge: deals to file, and how many are late.
function summary(deals) {
  const toFile = deals.filter((x) => x.status === 'to_file');
  return { toFile: toFile.length, overdue: toFile.filter((x) => x.overdue).length, dueSoon: toFile.filter((x) => x.dueSoon).length };
}

module.exports = { ensureColumns, deadlineFrom, daysLeft, list, update, summary, THRESHOLD, STATUSES, LABEL };
