'use strict';
// ── WHY BUSINESSES SAY NO, AND WHY THE DEALS THAT CLOSED WORKED ─────────────
//
// The reasons agents record in the CRM (services/crm, CRM_ON), counted by
// business type and by the offer on the table. Read-only. The admin script
// deal-reasons prints it.
//
//   declines   every card or deal marked Declined with a reason: the card's
//              business type and offer (outreach_queue), or the deal's when
//              the decline was marked on an email with no card
//   wins       every logged deal with "why it worked" (deal_outcomes): its
//              business type and the amount offered
//
// An offer reads "$250", "$500 in product", or "no offer recorded".

const CRM = require('./crm');

const offerLabel = (amount, kind) => (amount == null || amount === '' ? 'no offer recorded'
  : '$' + Number(amount).toLocaleString('en-US') + (kind === 'product' ? ' in product' : ''));

async function gather(pool, { days, agentId } = {}) {
  await CRM.ensureColumns(pool);
  const since = days ? new Date(Date.now() - Number(days) * 86400000) : null;
  const p = [since, agentId || null];
  const declines = (await pool.query(
    `SELECT 'card' AS src, q.agent_id, q.athlete_id, q.brand_name, q.decline_reason AS reason, q.decline_note AS note,
            q.business_category AS type, q.offer_amount AS offer, q.offer_kind AS kind, q.outcome_at AS at
       FROM outreach_queue q
      WHERE q.decline_reason IS NOT NULL AND ($1::timestamptz IS NULL OR q.outcome_at >= $1) AND ($2::text IS NULL OR q.agent_id = $2)
     UNION ALL
     SELECT 'deal', a.agent_id, d.athlete_id, d.brand_name, d.decline_reason, d.decline_note,
            d.category, d.offered_value, d.offer_kind, d.crm_stage_at
       FROM athlete_self_deals d JOIN athletes a ON a.id = d.athlete_id
      WHERE d.decline_reason IS NOT NULL AND ($1::timestamptz IS NULL OR d.crm_stage_at >= $1) AND ($2::text IS NULL OR a.agent_id = $2)
        AND NOT EXISTS (SELECT 1 FROM outreach_queue q2
                         WHERE q2.agent_id = a.agent_id AND q2.athlete_id = d.athlete_id AND q2.decline_reason IS NOT NULL
                           AND LOWER(TRIM(q2.brand_name)) = LOWER(TRIM(d.brand_name)))`, p)).rows;
  const wins = (await pool.query(
    `SELECT o.agent_id, o.athlete_id, o.brand AS brand_name, o.win_reason AS reason, o.win_note AS note,
            o.business_category AS type, o.offered_value AS offer, o.offer_kind AS kind, o.deal_value, o.closed_at AS at
       FROM deal_outcomes o
      WHERE o.win_reason IS NOT NULL AND ($1::timestamptz IS NULL OR o.closed_at >= $1) AND ($2::text IS NULL OR o.agent_id = $2)`, p)).rows;
  return { declines, wins, since, agentId: agentId || null };
}

// rows -> [{ reason, label, total, byType: [{type, n}], byOffer: [{offer, n}], cells: [{type, offer, n}], notes }]
function tally(rows, list) {
  const out = new Map();
  for (const r of rows) {
    const key = r.reason;
    if (!out.has(key)) out.set(key, { reason: key, label: CRM.labelIn(list, key) || key, total: 0, byType: new Map(), byOffer: new Map(), cells: new Map(), notes: [] });
    const t = out.get(key);
    const type = r.type || 'unknown type';
    const offer = offerLabel(r.offer, r.kind);
    t.total++;
    t.byType.set(type, (t.byType.get(type) || 0) + 1);
    t.byOffer.set(offer, (t.byOffer.get(offer) || 0) + 1);
    t.cells.set(type + '\u0000' + offer, (t.cells.get(type + '\u0000' + offer) || 0) + 1);
    if (r.note) t.notes.push({ brand: r.brand_name, note: r.note });
  }
  const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  // In the order the agent sees them on the page.
  const order = list.map((x) => x[0]);
  return [...out.values()].sort((a, b) => order.indexOf(a.reason) - order.indexOf(b.reason)).map((t) => ({
    reason: t.reason, label: t.label, total: t.total,
    byType: sorted(t.byType).map(([type, n]) => ({ type, n })),
    byOffer: sorted(t.byOffer).map(([offer, n]) => ({ offer, n })),
    cells: sorted(t.cells).map(([k, n]) => { const [type, offer] = k.split('\u0000'); return { type, offer, n }; }),
    notes: t.notes,
  }));
}

function summarize(data) {
  return { declines: tally(data.declines, CRM.DECLINE), wins: tally(data.wins, CRM.WIN),
    declineTotal: data.declines.length, winTotal: data.wins.length };
}

function render(data) {
  const s = summarize(data);
  const L = [];
  L.push('DEAL REASONS' + (data.since ? ' since ' + data.since.toISOString().slice(0, 10) : ', all time') + (data.agentId ? ' for agent ' + data.agentId : ', every agent'));
  L.push('Recorded in the CRM (CRM_ON): why a business declined, and why a signed deal worked.');
  if (!CRM.ON()) L.push('Note: CRM_ON is off here, so agents are not being asked for reasons.');
  const section = (title, rows, total) => {
    L.push('');
    L.push(`${title}: ${total}`);
    if (!rows.length) { L.push('   none recorded yet'); return; }
    for (const t of rows) {
      L.push(`   ${t.label.padEnd(40)} ${String(t.total).padStart(4)}`);
      L.push('      by business type:  ' + t.byType.map((x) => `${x.type} ${x.n}`).join(', '));
      L.push('      by offer amount:   ' + t.byOffer.map((x) => `${x.offer} ${x.n}`).join(', '));
      L.push('      type x offer:      ' + t.cells.map((x) => `${x.type} at ${x.offer}: ${x.n}`).join('; '));
      for (const n of t.notes.slice(0, 20)) L.push(`      note: "${n.note}" (${n.brand || '?'})`);
    }
  };
  section('WHY THEY DECLINED', s.declines, s.declineTotal);
  section('WHY IT WORKED', s.wins, s.winTotal);
  return L.join('\n');
}

module.exports = { gather, tally, summarize, render, offerLabel };
