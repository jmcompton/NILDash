'use strict';
// ── STOP WHAT IS QUEUED NOW (admin script stop-unverified) ──────────────────
//
// The send gate (services/sendGate) holds every email from the moment it is
// switched on. This is for what was already waiting when it was: every email
// that could still leave -- a queued email card, an email draft waiting on
// Home, an approved email not yet sent, a scheduled follow-up -- whose address
// is not a named person's with a valid verification in the last 30 days.
//
// PRINT FIRST. Nothing changes unless apply. On apply each one stops with the
// reason on the card, and its card becomes the call or DM instead where there
// is a phone or a handle (the gate's own blockAndOffer). Never touched: an
// email that was sent, or any email on a thread that has a reply.
//
// No credit is spent: the verdict is the cache as it stands (sendGate.peek).
// A valid verification older than 30 days is kept and listed: the gate
// checks it again, live, before it can send.

const SG = require('./sendGate');

function kindOf(r) {
  if (Number(r.touch_no || 1) > 1) return 'scheduled follow-up';
  if (r.status === 'approved') return 'approved, not sent';
  if (r.queue_id) return 'queued card';
  return 'draft on Home';
}

async function gather(pool, opts = {}) {
  await SG.ensureColumns(pool);
  const params = [];
  let scope = '';
  if (opts.agentId) { params.push(String(opts.agentId)); scope = ` AND l.agent_id = $${params.length}`; }
  return (await pool.query(
    `SELECT l.id, l.agent_id, l.athlete_id, l.brand_name, l.subject, l.body_html, l.touch_no, l.parent_id, l.status,
            l.approved_at, l.source, l.contact_name, l.contact_id, l.created_at, l.scheduled_send_at,
            COALESCE(NULLIF(TRIM(l.sent_to_email), ''), q.email) AS address,
            q.id AS queue_id, q.contact_name AS queue_contact, q.email_verified AS queue_verified,
            u.name AS agent_name, u.email AS agent_email, a.data->>'name' AS athlete_name
       FROM outreach_logs l
       LEFT JOIN users u ON u.id = l.agent_id
       LEFT JOIN athletes a ON a.id = l.athlete_id
       LEFT JOIN LATERAL (SELECT id, contact_name, email, email_verified FROM outreach_queue q2
                           WHERE q2.outreach_log_id = l.id ORDER BY q2.created_at DESC LIMIT 1) q ON TRUE
      WHERE l.sent_at IS NULL AND l.cadence_stopped_at IS NULL AND l.status IN ('draft', 'approved')
        AND COALESCE(NULLIF(TRIM(l.sent_to_email), ''), q.email) IS NOT NULL
        AND l.replied_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM outreach_logs r
                         WHERE (r.id = COALESCE(l.parent_id, l.id) OR r.parent_id = COALESCE(l.parent_id, l.id))
                           AND r.replied_at IS NOT NULL)${scope}
      ORDER BY u.name NULLS LAST, l.agent_id, a.data->>'name' NULLS LAST, l.created_at`, params)).rows;
}

// One email, one decision. -> { action: 'stop' | 'keep', why, verdict }
async function classify(pool, r) {
  const who = String(r.contact_name || '').trim() || r.queue_contact || await SG.contactNameFor(pool, r).catch(() => null);
  const v = await SG.peek(pool, r.address, who, { brand: r.brand_name });
  if (v.verified) return { action: 'keep', why: 'valid within 30 days', verdict: v, contactName: who };
  if (v.stale) return { action: 'keep', why: v.why, verdict: v, contactName: who, stale: true };
  return { action: 'stop', why: v.why, code: v.code, verdict: v, contactName: who };
}

async function run(pool, opts = {}) {
  const rows = await gather(pool, opts);
  const out = { apply: !!opts.apply, considered: rows.length, stop: 0, keep: 0, stale: 0, stopped: 0,
    converted: { call: 0, dm: 0, none: 0 }, agents: new Map() };
  for (const r of rows) {
    const d = await classify(pool, r);
    const key = r.agent_id;
    if (!out.agents.has(key)) out.agents.set(key, { agentId: key, name: r.agent_name || null, email: r.agent_email || null, stop: [], keep: 0, stale: 0, byKind: {} });
    const A = out.agents.get(key);
    const item = { id: r.id, kind: kindOf(r), athlete: r.athlete_name || r.athlete_id, brand: r.brand_name, address: r.address,
      contactName: d.contactName || null, why: d.why, code: d.code || null };
    if (d.action === 'keep') { out.keep++; A.keep++; if (d.stale) { out.stale++; A.stale++; } continue; }
    out.stop++; A.byKind[item.kind] = (A.byKind[item.kind] || 0) + 1;
    if (opts.apply) {
      const b = await SG.blockAndOffer(pool, { ...r, sent_to_email: r.address }, { code: d.code || 'unverified', why: d.why }, { contactName: d.contactName });
      item.result = b.converted ? `stopped; a ${b.offer.channel} card now` : (b.offer ? `stopped; ${b.offer.channel} offered` : 'stopped; no phone or handle on file');
      out.stopped++;
      if (b.converted) out.converted[b.offer.channel]++; else out.converted.none++;
    }
    A.stop.push(item);
  }
  return out;
}

function format(r) {
  const L = [];
  L.push(`STOP UNVERIFIED: ${r.considered} email(s) that could still leave (queued cards, drafts on Home, approved not sent, scheduled follow-ups).`);
  L.push('Rule: a named person\'s address with a valid verification in the last 30 days. Never a department or shared inbox.');
  L.push(r.apply ? 'APPLIED: each one below was stopped, with the reason on the card.' : 'DRY RUN: nothing was changed. Add &apply=1 to stop them.');
  L.push('');
  for (const A of r.agents.values()) {
    if (!A.stop.length) continue;
    const kinds = Object.entries(A.byKind).map(([k, n]) => `${n} ${k}`).join(', ');
    L.push(`${A.name || A.agentId}${A.email ? ' <' + A.email + '>' : ''}: ${A.stop.length} to stop (${kinds}); ${A.keep} verified${A.stale ? ` (${A.stale} re-checked at send)` : ''}`);
    for (const it of A.stop) {
      L.push(`  ${r.apply ? 'STOPPED' : 'stop'}  [${it.kind}] ${it.athlete} -> ${it.brand}: ${it.address}${it.contactName ? ' (' + it.contactName + ')' : ''}`);
      L.push(`         why: ${it.why}${it.result ? '; ' + it.result : ''}`);
    }
    L.push('');
  }
  const clean = [...r.agents.values()].filter((A) => !A.stop.length);
  if (clean.length) L.push(`Nothing to stop for ${clean.length} other agent(s).`, '');
  L.push(`TOTAL: ${r.stop} to stop, ${r.keep} verified (${r.stale} of them re-checked live before they send).`);
  if (r.apply) L.push(`Stopped ${r.stopped}: ${r.converted.call} became call cards, ${r.converted.dm} DM cards, ${r.converted.none} have no phone or handle on file.`);
  return L.join('\n');
}

module.exports = { gather, classify, run, format, kindOf };
