'use strict';
// ── UNDO THE STOPS THE OLD NAME RULE GOT WRONG (admin script restore-false-stops)
//
// stop-unverified (and the gate at send time) stopped emails whose address
// did not contain the person's first or last name: rob@ for Robert, jj@ for
// JJ, dj@ for D.J. The rule now knows initials and nicknames
// (services/nameMatch). This finds every email the gate stopped as "not their
// address" (gate_reason 'not-theirs') whose address passes the corrected rule
// AND has a valid verification in the last 30 days, and puts it back.
//
// PRINT FIRST. Nothing changes unless apply. On apply, each one:
//   - is un-stopped as a DRAFT, waiting for the agent's approval. One the
//     agent had approved before it was stopped comes back as a draft too, for
//     a fresh approval: nothing sends on its own;
//   - gets its card back as the email card on Home (the stop had turned it
//     into a call or DM card), with a note saying why it is back.
//
// Left stopped, and listed with the reason: an address that still fails the
// rule (a single letter that is not their own small business), one with no
// valid verification in the last 30 days, a suppressed address, an email
// stopped for another reason before the gate, and anything the agent has
// since acted on: sent, replied to, or its call or DM card marked done.

const SG = require('./sendGate');
const SU = require('./stopUnverified');
const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '?');

let _cols = null;
function ensureColumns(pool) {
  if (_cols) return _cols;
  _cols = (async () => {
    await SG.ensureColumns(pool);
    for (const sql of [
      `ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS gate_restored_at TIMESTAMPTZ`,
      `ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS gate_restored_why TEXT`,
    ]) await pool.query(sql).catch((e) => console.error('[restore-false-stops] ' + e.message));
  })();
  return _cols;
}

async function gather(pool, opts = {}) {
  await ensureColumns(pool);
  const params = [];
  let scope = '';
  if (opts.agentId) { params.push(String(opts.agentId)); scope = ` AND l.agent_id = $${params.length}`; }
  return (await pool.query(
    `SELECT l.id, l.agent_id, l.athlete_id, l.brand_name, l.subject, l.touch_no, l.parent_id, l.status, l.source,
            l.contact_name, l.contact_id, l.approved_at, l.cadence_stopped_at, l.cadence_stop_reason,
            l.gate_blocked_at, l.gate_reason, l.sent_at, l.replied_at,
            LOWER(TRIM(l.sent_to_email)) AS address,
            u.name AS agent_name, u.email AS agent_email, a.data->>'name' AS athlete_name,
            EXISTS (SELECT 1 FROM outreach_logs r
                     WHERE (r.id = COALESCE(l.parent_id, l.id) OR r.parent_id = COALESCE(l.parent_id, l.id))
                       AND r.replied_at IS NOT NULL) AS thread_replied
       FROM outreach_logs l
       LEFT JOIN users u ON u.id = l.agent_id
       LEFT JOIN athletes a ON a.id = l.athlete_id
      WHERE l.gate_reason = 'not-theirs' AND l.gate_blocked_at IS NOT NULL
        AND l.cadence_stopped_at IS NOT NULL AND l.gate_restored_at IS NULL
        AND NULLIF(TRIM(l.sent_to_email), '') IS NOT NULL${scope}
      ORDER BY u.name NULLS LAST, l.agent_id, a.data->>'name' NULLS LAST, l.gate_blocked_at`, params)).rows;
}

// The card the stop turned over: still linked when there was nothing to turn
// it into, else unlinked, on the same athlete and address, carrying the stop.
async function cardOf(pool, r) {
  return (await pool.query(
    `SELECT id, state, channel, sent_at, outcome, contact_name, contact_title, lane, size_band, email_note, outreach_log_id
       FROM outreach_queue
      WHERE outreach_log_id = $1
         OR (outreach_log_id IS NULL AND athlete_id = $2 AND LOWER(TRIM(email)) = $3 AND email_note LIKE 'Not sent:%')
      ORDER BY (outreach_log_id = $1) DESC NULLS LAST, updated_at DESC LIMIT 1`,
    [String(r.id), r.athlete_id || null, r.address]).catch(() => ({ rows: [] }))).rows[0] || null;
}

// One stopped email, one decision. -> { action: 'restore' | 'stay', why, how? }
async function classify(pool, r, opts = {}) {
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  const card = Number(r.touch_no || 1) <= 1 ? await cardOf(pool, r) : null;
  const who = String(r.contact_name || '').trim() || (card && card.contact_name) || await SG.contactNameFor(pool, r).catch(() => null);
  const base = { card, contactName: who };
  if (r.sent_at) return { ...base, action: 'stay', why: 'it was sent since' };
  if (r.replied_at || r.thread_replied) return { ...base, action: 'stay', why: 'the thread has a reply' };
  if (!['draft', 'approved'].includes(r.status)) return { ...base, action: 'stay', why: `it is ${r.status} now` };
  if (r.gate_blocked_at && r.cadence_stopped_at
    && new Date(r.cadence_stopped_at).getTime() < new Date(r.gate_blocked_at).getTime() - 10000) {
    return { ...base, action: 'stay', why: `it was stopped on ${day(r.cadence_stopped_at)}, before the gate, for another reason` };
  }
  if (card && (card.sent_at || card.outcome || card.state !== 'queued')) {
    return { ...base, action: 'stay', why: `the agent has acted on its ${card.channel || ''} card since (${card.outcome || card.state})`.replace('  ', ' ') };
  }
  const ctx = await SG.contextFor(pool, r.address, { brand: r.brand_name, athleteId: r.athlete_id || null,
    title: card && card.contact_title, lane: card && card.lane, sizeBand: card && card.size_band });
  const prob = SG.addressProblem(r.address, who, ctx);
  if (prob) return { ...base, action: 'stay', why: `still not theirs under the corrected rule: ${prob.why}` };
  const how = require('./nameMatch').match(r.address, who, ctx).how;
  const v = await SG.verificationOf(pool, r.address);
  const fresh = v && v.result === 'valid' && v.checked_at && (now - new Date(v.checked_at).getTime()) <= SG.FRESH_DAYS * 86400000;
  if (!fresh) {
    return { ...base, how, action: 'stay', why: `it is ${who}'s address (${how}), but there is no valid verification in the last ${SG.FRESH_DAYS} days`
      + (v && v.result ? ` (${SG.categoryOf(v)}, checked ${day(v.checked_at)})` : ' (never verified)') };
  }
  // Fails closed, like the list itself: a read error is treated as suppressed.
  const sup = await require('./suppression').isSuppressed(pool, r.address).catch(() => ({ suppressed: true, reason: 'the list could not be read' }));
  if (!sup || sup.suppressed) return { ...base, how, action: 'stay', why: `the address is on the suppression list (${(sup && sup.reason) || 'unknown'})` };
  return { ...base, how, verifiedAt: v.checked_at, action: 'restore', why: `${who}'s address (${how}), verified valid ${day(v.checked_at)}` };
}

async function restoreOne(pool, r, d) {
  const why = `Restored: ${r.address} is ${d.contactName}'s address (${d.how}), verified valid ${day(d.verifiedAt)}. Stopped earlier by the old name rule.`;
  const first = Number(r.touch_no || 1) <= 1;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query(
      `UPDATE outreach_logs SET cadence_stopped_at = NULL, cadence_stop_reason = NULL, send_error = NULL,
              gate_blocked_at = NULL, gate_reason = NULL, gate_offer = NULL,
              status = 'draft', approved_at = NULL, approved_by = NULL,
              scheduled_send_at = CASE WHEN $3 THEN NULL ELSE scheduled_send_at END,
              gate_restored_at = NOW(), gate_restored_why = $2, updated_at = NOW()
        WHERE id = $1 AND sent_at IS NULL AND gate_reason = 'not-theirs' AND status IN ('draft', 'approved')`,
      [String(r.id), why, first]);
    if (!u.rowCount) { await client.query('ROLLBACK'); return { restored: false, why: 'it changed while this ran' }; }
    let card = false;
    if (d.card) {
      const c = await client.query(
        `UPDATE outreach_queue SET channel = 'email', outreach_log_id = $2, email_note = $3,
                dm_text = CASE WHEN channel = 'email' THEN dm_text ELSE NULL END, updated_at = NOW()
          WHERE id = $1 AND sent_at IS NULL AND outcome IS NULL AND state = 'queued'`,
        [d.card.id, String(r.id), why.slice(0, 400)]);
      card = (c.rowCount || 0) > 0;
    }
    await client.query('COMMIT');
    console.log(`[restore-false-stops] ${r.id} "${r.brand_name}" ${r.address} restored as a draft${card ? `; card ${d.card.id} is an email card again` : ''}`);
    return { restored: true, card };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[restore-false-stops] ' + r.id + ': ' + e.message);
    return { restored: false, why: e.message };
  } finally { client.release(); }
}

async function run(pool, opts = {}) {
  const rows = await gather(pool, opts);
  const out = { apply: !!opts.apply, considered: rows.length, restore: 0, stay: 0, restored: 0, cards: 0, failed: 0, agents: new Map() };
  for (const r of rows) {
    const d = await classify(pool, r, opts);
    if (!out.agents.has(r.agent_id)) out.agents.set(r.agent_id, { agentId: r.agent_id, name: r.agent_name || null, email: r.agent_email || null, restore: [], stay: [] });
    const A = out.agents.get(r.agent_id);
    const item = { id: r.id, kind: Number(r.touch_no || 1) > 1 ? 'follow-up' : (r.status === 'approved' ? 'approved, not sent' : (d.card ? 'queued card' : 'draft on Home')),
      athlete: r.athlete_name || r.athlete_id, brand: r.brand_name, address: r.address, contactName: d.contactName || null, why: d.why };
    if (d.action !== 'restore') { out.stay++; A.stay.push(item); continue; }
    out.restore++;
    if (opts.apply) {
      const res = await restoreOne(pool, r, d);
      if (res.restored) { out.restored++; if (res.card) out.cards++; item.result = res.card ? 'restored; back on Home as an email card' : 'restored as a draft'; }
      else { out.failed++; item.result = 'not restored: ' + res.why; }
    }
    A.restore.push(item);
  }
  return out;
}

function format(r) {
  const L = [];
  L.push(`RESTORE FALSE STOPS: ${r.considered} email(s) the send gate stopped because the address did not look like the person's.`);
  L.push('Corrected rule: their first or last name, initials, first initial + last name, first name + last initial, or a common nickname;');
  L.push('a single letter only when it is their first initial on their own small business; and still a valid verification in the last 30 days.');
  L.push(r.apply ? 'APPLIED: each "RESTORED" below is a draft again, back on Home for the agent to approve. Nothing sends without an approval.'
    : 'DRY RUN: nothing was changed. Add &apply=1 to restore the ones marked "restore" (as drafts for the agent to approve).');
  L.push('');
  for (const A of r.agents.values()) {
    L.push(`${A.name || A.agentId}${A.email ? ' <' + A.email + '>' : ''}: ${A.restore.length} to restore, ${A.stay.length} stay stopped`);
    for (const it of A.restore) {
      L.push(`  ${r.apply ? 'RESTORED' : 'restore'}  [${it.kind}] ${it.athlete} -> ${it.brand}: ${it.address}${it.contactName ? ' (' + it.contactName + ')' : ''}`);
      L.push(`           ${it.why}${it.result ? '; ' + it.result : ''}`);
    }
    for (const it of A.stay) {
      L.push(`  stays    [${it.kind}] ${it.athlete} -> ${it.brand}: ${it.address}${it.contactName ? ' (' + it.contactName + ')' : ''}`);
      L.push(`           why: ${it.why}`);
    }
    L.push('');
  }
  L.push(`TOTAL: ${r.restore} to restore, ${r.stay} stay stopped.`);
  if (r.apply) L.push(`Restored ${r.restored} (${r.cards} back on Home as email cards)${r.failed ? `; ${r.failed} could not be restored` : ''}.`);
  return L.join('\n');
}

module.exports = { gather, classify, run, format, restoreOne, ensureColumns, cardOf, kindOf: SU.kindOf };
