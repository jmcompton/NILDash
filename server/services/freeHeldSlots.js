'use strict';
// ── FREE THE SLOTS HELD BY CARDS THAT CAN NEVER COUNT ───────────────────────
//
// One-time, for the switch to EMAIL_FIVE_ON. Every athlete's five slots were
// held by DM, call and unverified email cards placed before the five rule, so
// the night had nowhere to put a verified email. This retires those cards --
// state 'retired', outcome 'freed_for_email', the same way queueAudit retires
// a nameless card -- and stops each one's unapproved email draft so it leaves
// the agent's page with the card.
//
// RETIRED: a QUEUED card that is
//   a DM card, a call card, or an email card whose address is not a verified
//   address for a named person.
// NEVER TOUCHED, whatever its channel:
//   anything sent (sent_at, sent_via), marked done (an outcome), or with a reply
//   -- on the card, on its email, or from that business about that athlete on
//   any card or email -- and any card whose email the agent approved or edited.
// KEPT, and said why: a verified email card (named person, or the one General
//   inbox card), and a program card (not a DM, call or email card).
//
// An email card from before the email_verified flag existed is judged by its
// address: valid in email_verification, carries the contact's name, and not a
// desk or role inbox. One that passes is kept, and on apply its flag is set so
// it holds its slot tonight and the 5:30 list counts it.
//
// DRY RUN unless apply. The same guards are written into the UPDATE itself, so
// a card the agent approves between the read and the write is not retired.

const EF = require('./emailFinder');

const OUTCOME = 'freed_for_email';
const STOP_REASON = 'retired: slot freed for a verified email (free-held-slots)';
const FIVE = 5;

const lc = (s) => String(s || '').trim().toLowerCase();

// The never-touch guards, in SQL. Used to read and again inside the UPDATE.
const UNTOUCHED_SQL = `q.state = 'queued' AND q.sent_at IS NULL AND q.sent_via IS NULL AND q.outcome IS NULL AND q.replied_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM outreach_logs l WHERE l.id = q.outreach_log_id
        AND (l.approved_at IS NOT NULL OR l.status IS DISTINCT FROM 'draft' OR l.sent_at IS NOT NULL
             OR l.replied_at IS NOT NULL OR COALESCE(l.edited_before_approval, FALSE)))
  AND NOT EXISTS (SELECT 1 FROM outreach_logs r WHERE r.agent_id = q.agent_id AND r.athlete_id = q.athlete_id
        AND LOWER(TRIM(r.brand_name)) = LOWER(TRIM(q.brand_name)) AND r.replied_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM outreach_queue o WHERE o.athlete_id = q.athlete_id AND o.id <> q.id
        AND LOWER(TRIM(o.brand_name)) = LOWER(TRIM(q.brand_name))
        AND (o.replied_at IS NOT NULL OR o.outcome IN ('replied', 'closed', 'declined')))`;

async function gather(pool, opts = {}) {
  const params = [];
  let scope = '';
  const agents = opts.agentIds || (opts.agentId ? [opts.agentId] : null);
  if (agents) { params.push(agents.map(String)); scope = ` AND q.agent_id = ANY($${params.length}::text[])`; }
  return (await pool.query(
    `SELECT q.id, q.agent_id, q.athlete_id, q.slot, q.brand_name, q.channel, q.state,
            COALESCE(NULLIF(TRIM(q.email), ''), l.sent_to_email) AS email,
            q.email_verified, q.email_label, q.contact_name, q.sent_at, q.sent_via, q.outcome, q.replied_at,
            q.outreach_log_id, q.created_at,
            u.name AS agent_name, u.email AS agent_email, a.data->>'name' AS athlete_name,
            l.id AS log_id, l.status AS log_status, l.approved_at AS log_approved_at, l.sent_at AS log_sent_at,
            l.replied_at AS log_replied_at, COALESCE(l.edited_before_approval, FALSE) AS log_edited,
            v.result AS verify_result,
            EXISTS (SELECT 1 FROM outreach_logs r WHERE r.agent_id = q.agent_id AND r.athlete_id = q.athlete_id
                     AND LOWER(TRIM(r.brand_name)) = LOWER(TRIM(q.brand_name)) AND r.replied_at IS NOT NULL) AS brand_replied,
            EXISTS (SELECT 1 FROM outreach_queue o WHERE o.athlete_id = q.athlete_id AND o.id <> q.id
                     AND LOWER(TRIM(o.brand_name)) = LOWER(TRIM(q.brand_name))
                     AND (o.replied_at IS NOT NULL OR o.outcome IN ('replied', 'closed', 'declined'))) AS card_replied
       FROM outreach_queue q
       LEFT JOIN users u ON u.id = q.agent_id
       LEFT JOIN athletes a ON a.id = q.athlete_id
       LEFT JOIN outreach_logs l ON l.id = q.outreach_log_id
       LEFT JOIN email_verification v ON v.email = LOWER(TRIM(COALESCE(NULLIF(TRIM(q.email), ''), l.sent_to_email)))
      WHERE q.state = 'queued'${scope}
      ORDER BY u.name NULLS LAST, q.agent_id, a.data->>'name' NULLS LAST, q.athlete_id, q.slot`, params)).rows;
}

// A verified address for a named person, read off the address itself, for a
// card placed before email_verified existed.
function namedVerified(c) {
  const e = lc(c.email);
  if (!e || !e.includes('@')) return false;
  if (c.verify_result !== 'valid') return false;
  if (EF.isDesk(e)) return false;
  return !!(c.contact_name && EF.carriesName(e, c.contact_name));
}

// ── ONE CARD, ONE DECISION. Pure. ───────────────────────────────────────────
// { action: 'retire' | 'keep', why, kind, backfill? }
function classify(c) {
  if (!c || c.state !== 'queued') return { action: 'keep', why: 'not queued', kind: 'protected', label: 'not queued' };
  if (c.sent_at || c.sent_via || c.log_sent_at) return { action: 'keep', why: 'sent', kind: 'protected', label: 'sent' };
  if (c.outcome) return { action: 'keep', why: `marked done (${c.outcome})`, kind: 'protected', label: 'marked done' };
  if (c.replied_at || c.log_replied_at || c.brand_replied || c.card_replied) return { action: 'keep', why: 'has a reply', kind: 'protected', label: 'reply' };
  if (c.log_id && (c.log_approved_at || c.log_status !== 'draft')) {
    return { action: 'keep', why: 'the agent approved its email', kind: 'protected', label: 'approved' };
  }
  if (c.log_edited) return { action: 'keep', why: 'the agent edited its email', kind: 'protected', label: 'edited' };
  const ch = c.channel;
  if (ch === 'email') {
    if (c.email_verified === true) {
      return c.email_label === 'General inbox'
        ? { action: 'keep', why: 'verified General inbox card', kind: 'verified', label: 'General inbox' }
        : { action: 'keep', why: 'verified named-person email', kind: 'verified', label: 'verified email' };
    }
    if (namedVerified(c)) return { action: 'keep', why: 'verified named-person email, placed before the flag existed (flagged on apply)', kind: 'verified', label: 'verified email', backfill: true };
    const e = lc(c.email);
    const sub = !e ? 'no address'
      : EF.isDesk(e) ? 'a desk or role address'
      : c.verify_result === 'valid' ? 'valid, but not the named person\'s address'
      : c.verify_result ? `address ${c.verify_result}`
      : 'address never verified';
    return { action: 'retire', why: `email card, not a verified named-person address: ${sub}`, kind: 'email', label: 'unverified email' };
  }
  if (ch === 'dm') return { action: 'retire', why: 'DM card', kind: 'dm', label: 'DM' };
  if (ch === 'call') return { action: 'retire', why: 'call card', kind: 'call', label: 'call' };
  return { action: 'keep', why: `${ch || 'unknown'} card (not a DM, call or email card)`, kind: 'other', label: ch || 'unknown' };
}

// ── THE PLAN, PER AGENT AND ATHLETE. Pure. ──────────────────────────────────
function plan(rows) {
  const agents = new Map();
  const totals = { cards: 0, retire: 0, keep: 0, retireBy: {}, keepBy: {}, athletes: 0, backfill: 0 };
  const cards = [];
  for (const c of rows) {
    const d = classify(c);
    cards.push({ ...c, decision: d });
    totals.cards++;
    const ak = c.agent_id;
    if (!agents.has(ak)) agents.set(ak, { agentId: ak, name: c.agent_name || null, email: c.agent_email || null, retire: 0, keep: 0, athletes: new Map() });
    const A = agents.get(ak);
    if (!A.athletes.has(c.athlete_id)) { A.athletes.set(c.athlete_id, { athleteId: c.athlete_id, name: c.athlete_name || c.athlete_id, retire: 0, keep: 0, retireBy: {}, keepBy: {}, verifiedAfter: 0 }); totals.athletes++; }
    const T = A.athletes.get(c.athlete_id);
    const bucket = d.label;
    if (d.action === 'retire') {
      A.retire++; T.retire++; totals.retire++;
      T.retireBy[bucket] = (T.retireBy[bucket] || 0) + 1;
      totals.retireBy[d.why] = (totals.retireBy[d.why] || 0) + 1;
    } else {
      A.keep++; T.keep++; totals.keep++;
      T.keepBy[bucket] = (T.keepBy[bucket] || 0) + 1;
      totals.keepBy[d.why] = (totals.keepBy[d.why] || 0) + 1;
      if (d.kind === 'verified') T.verifiedAfter++;
      if (d.backfill) totals.backfill++;
    }
  }
  return { agents: [...agents.values()].map((a) => ({ ...a, athletes: [...a.athletes.values()] })), totals, cards };
}

// ── RUN ─────────────────────────────────────────────────────────────────────
// opts: { apply, agentId } (agentIds: several, for tests)
async function run(pool, opts = {}) {
  const rows = await gather(pool, opts);
  const p = plan(rows);
  const out = { apply: !!opts.apply, fiveOn: process.env.EMAIL_FIVE_ON === '1', ...p, retired: 0, draftsStopped: 0, flagged: 0, raced: 0 };
  if (!opts.apply) return out;
  const ids = p.cards.filter((c) => c.decision.action === 'retire').map((c) => c.id);
  const flagIds = p.cards.filter((c) => c.decision.backfill).map((c) => c.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (ids.length) {
      // The guards again, inside the write: a card approved, sent, marked or
      // replied to since the read is skipped, and counted as raced.
      const r = await client.query(
        `UPDATE outreach_queue q SET state = 'retired', outcome = $2, outcome_at = NOW(), updated_at = NOW()
          WHERE q.id = ANY($1::int[]) AND ${UNTOUCHED_SQL}
            AND (q.channel IN ('dm', 'call') OR (q.channel = 'email' AND q.email_verified IS NOT TRUE))
          RETURNING q.id, q.outreach_log_id`, [ids, OUTCOME]);
      out.retired = r.rowCount;
      out.raced = ids.length - r.rowCount;
      const logIds = r.rows.map((x) => x.outreach_log_id).filter(Boolean);
      if (logIds.length) {
        const s = await client.query(
          `UPDATE outreach_logs SET cadence_stopped_at = NOW(), cadence_stop_reason = $2, updated_at = NOW()
            WHERE id = ANY($1::text[]) AND status = 'draft' AND approved_at IS NULL AND sent_at IS NULL AND cadence_stopped_at IS NULL`,
          [logIds, STOP_REASON]);
        out.draftsStopped = s.rowCount;
      }
    }
    if (flagIds.length) {
      const f = await client.query(
        `UPDATE outreach_queue SET email_verified = TRUE, updated_at = NOW()
          WHERE id = ANY($1::int[]) AND state = 'queued' AND channel = 'email' AND email_verified IS NOT TRUE`, [flagIds]);
      out.flagged = f.rowCount;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return out;
}

// ── THE PRINTOUT ────────────────────────────────────────────────────────────
function format(r) {
  const L = [];
  const t = r.totals;
  const tally = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  const [rv, kv] = r.apply ? ['retired', 'kept'] : ['retire', 'keep'];
  L.push(r.apply ? 'FREE HELD SLOTS: APPLIED' : 'FREE HELD SLOTS: DRY RUN (nothing changed; add &apply=1 to retire)');
  L.push(`EMAIL_FIVE_ON is ${r.fiveOn ? 'ON' : 'OFF'} here. ${r.fiveOn
    ? 'Tonight only verified email cards hold a slot.'
    : 'Off: every queued card still holds its slot, so retiring is what frees them.'}`);
  L.push('');
  const lines = (o) => Object.entries(o).sort((x, y) => y[1] - x[1]).map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`);
  L.push(`Queued cards: ${t.cards} across ${t.athletes} athlete(s), ${r.agents.length} agent(s).`);
  L.push('');
  L.push(`${r.apply ? 'RETIRED' : 'WOULD RETIRE'}: ${r.apply ? r.retired : t.retire}`);
  L.push(...lines(t.retireBy));
  if (r.apply) {
    L.push(`  email drafts stopped with their card: ${r.draftsStopped}`);
    if (r.raced) L.push(`  not retired, because the agent acted on them since the read: ${r.raced}`);
  }
  L.push('');
  L.push(`KEPT: ${t.keep}`);
  L.push(...lines(t.keepBy));
  if (t.backfill && r.apply) L.push(`  older verified named cards flagged verified: ${r.flagged}`);
  L.push('');
  L.push('Never touched, whatever the channel: sent, marked done, any reply, or an email the agent approved or edited.');
  L.push('');
  L.push('PER AGENT AND ATHLETE');
  L.push('  "verified after" = verified email cards still held; "open tonight" = slots the night will fill under EMAIL_FIVE_ON.');
  for (const a of r.agents) {
    L.push('');
    L.push(`${a.name || a.agentId}${a.email ? ` <${a.email}>` : ''}: ${rv} ${a.retire}, ${kv} ${a.keep}`);
    for (const x of a.athletes) {
      const rb = tally(x.retireBy);
      const kb = tally(x.keepBy);
      L.push(`  ${x.name}: ${rv} ${x.retire}${rb ? ` (${rb})` : ''}; ${kv} ${x.keep}${kb ? ` (${kb})` : ''}; `
        + `verified after ${x.verifiedAfter}, open tonight ${Math.max(0, FIVE - x.verifiedAfter)}`);
    }
  }
  const odd = r.cards.filter((c) => c.decision.action === 'keep' && c.decision.kind !== 'verified');
  if (odd.length) {
    L.push('');
    L.push('KEPT FOR A REASON OTHER THAN A VERIFIED EMAIL');
    for (const c of odd.slice(0, 300)) {
      L.push(`  #${c.id} ${c.agent_name || c.agent_id} / ${c.athlete_name || c.athlete_id} / ${c.brand_name} (${c.channel}): ${c.decision.why}`);
    }
    if (odd.length > 300) L.push(`  ... and ${odd.length - 300} more`);
  }
  return L.join('\n');
}

module.exports = { gather, classify, plan, run, format, namedVerified, OUTCOME, STOP_REASON, UNTOUCHED_SQL };
