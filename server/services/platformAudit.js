'use strict';
// ── LIVE CARDS AT A PLATFORM'S ADDRESS (admin script platform-address-audit) ──
//
// ce@squareup.com was put on a card for "Eyebrows by Corrina": Square's own
// domain, taken for a salon that books through Square. The finder and the
// send gate refuse such an address now (services/websiteValidation
// platformDomainOf). This finds the ones already placed, by agent:
//
//   EMAILS that could still leave (a queued email card, a draft on Home, an
//   approved email not yet sent, a scheduled follow-up), the same set
//   stop-unverified reads, whose address is on a platform's domain.
//   CARDS still on Home (queued) that carry such an address with no email
//   that could still leave: a call or DM card showing it, or an email card
//   with no draft.
//
// PRINT FIRST. Nothing changes unless apply. On apply:
//   an email stops with the reason, the address comes off its card, and the
//   card becomes the call or DM instead where there is a phone or a handle
//   (the gate's own blockAndOffer):
//   "Not sent: squareup.com is the platform's address, not the business's.
//   Call them instead: <phone>."
//   the platform's address comes off the card, which says why.
// Never touched: anything sent, any email on a thread with a reply, a card
// marked done or replied to, a card being sent right now.
//
// No credit is spent: nothing is verified.

const SG = require('./sendGate');
const SU = require('./stopUnverified');

const lc = (s) => String(s || '').trim().toLowerCase();

// Queued cards carrying a platform's address and no email that could still
// leave. The never-touch guards are in the SQL, and again in the UPDATE.
const CARD_GUARD = `q.state = 'queued' AND q.sent_at IS NULL AND q.sent_via IS NULL AND q.outcome IS NULL AND q.replied_at IS NULL`;
async function gatherCards(pool, opts = {}) {
  const params = [];
  let scope = '';
  if (opts.agentId) { params.push(String(opts.agentId)); scope = ` AND q.agent_id = $${params.length}`; }
  return (await pool.query(
    `SELECT q.id, q.agent_id, q.athlete_id, q.brand_name, q.channel, q.email, q.phone, q.instagram, q.contact_name,
            q.outreach_log_id, q.email_note,
            u.name AS agent_name, u.email AS agent_email, a.data->>'name' AS athlete_name
       FROM outreach_queue q
       LEFT JOIN users u ON u.id = q.agent_id
       LEFT JOIN athletes a ON a.id = q.athlete_id
      WHERE ${CARD_GUARD} AND NULLIF(TRIM(q.email), '') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM outreach_logs r WHERE r.agent_id = q.agent_id AND r.athlete_id = q.athlete_id
                         AND LOWER(TRIM(r.brand_name)) = LOWER(TRIM(q.brand_name)) AND r.replied_at IS NOT NULL)${scope}
      ORDER BY u.name NULLS LAST, q.agent_id, a.data->>'name' NULLS LAST, q.id`, params)).rows
    .filter((r) => SG.platformProblem(r.email));
}

function kindOfCard(c) {
  if (c.channel === 'call') return 'call card showing it';
  if (c.channel === 'dm') return 'DM card showing it';
  if (c.channel === 'email') return 'email card, no draft';
  return `${c.channel || 'unknown'} card showing it`;
}

// The platform's address off a card that is still on Home, saying why.
async function clearCard(pool, cardId, email, note) {
  const u = await pool.query(
    `UPDATE outreach_queue q SET email = NULL, email_verified = FALSE, email_label = NULL,
            email_note = $3, updated_at = NOW()
      WHERE q.id = $1 AND LOWER(TRIM(q.email)) = $2 AND ${CARD_GUARD}`,
    [cardId, lc(email), String(note).slice(0, 400)]);
  return (u.rowCount || 0) > 0;
}

async function run(pool, opts = {}) {
  await SG.ensureColumns(pool);
  const emails = (await SU.gather(pool, opts)).filter((r) => SG.platformProblem(r.address));
  const live = new Set(emails.map((r) => String(r.id)));
  const cards = (await gatherCards(pool, opts)).filter((c) => !(c.outreach_log_id && live.has(String(c.outreach_log_id))));
  const out = { apply: !!opts.apply, emails: emails.length, cards: cards.length, stopped: 0, cleared: 0,
    converted: { call: 0, dm: 0, none: 0 }, domains: {}, agents: new Map() };
  const agentOf = (r) => {
    if (!out.agents.has(r.agent_id)) out.agents.set(r.agent_id, { agentId: r.agent_id, name: r.agent_name || null, email: r.agent_email || null, items: [] });
    return out.agents.get(r.agent_id);
  };
  const tally = (email) => { const d = lc(email).split('@').pop(); out.domains[d] = (out.domains[d] || 0) + 1; };

  for (const r of emails) {
    const p = SG.platformProblem(r.address);
    tally(r.address);
    const item = { type: 'email', id: r.id, kind: SU.kindOf(r), athlete: r.athlete_name || r.athlete_id, brand: r.brand_name,
      address: lc(r.address), contactName: r.contact_name || r.queue_contact || null, why: p.why };
    if (opts.apply) {
      // The gate's own stop: the card becomes the call or DM, and the
      // platform's address comes off it.
      const b = await SG.blockAndOffer(pool, { ...r, sent_to_email: r.address }, p, {});
      item.result = b.converted ? `stopped; a ${b.offer.channel} card now` : (b.offer ? `stopped; ${b.offer.channel} offered` : 'stopped; no phone or handle on file');
      item.message = b.message;
      out.stopped++;
      if (b.converted) out.converted[b.offer.channel]++; else out.converted.none++;
    }
    agentOf(r).items.push(item);
  }
  for (const c of cards) {
    const p = SG.platformProblem(c.email);
    tally(c.email);
    const offer = SG.offerSentence(c.phone ? { channel: 'call', phone: c.phone } : c.instagram ? { channel: 'dm', instagram: c.instagram } : null, null);
    const note = `Removed ${lc(c.email)}: ${p.why}. ${offer}`;
    const item = { type: 'card', id: c.id, kind: kindOfCard(c), athlete: c.athlete_name || c.athlete_id, brand: c.brand_name,
      address: lc(c.email), contactName: c.contact_name || null, why: p.why };
    if (opts.apply) {
      const ok = await clearCard(pool, c.id, c.email, note);
      item.result = ok ? 'address removed from the card' : 'changed since it was read; left as it is';
      item.message = ok ? note : null;
      if (ok) out.cleared++;
    }
    agentOf(c).items.push(item);
  }
  return out;
}

function format(r) {
  const L = [];
  const total = r.emails + r.cards;
  L.push(`PLATFORM ADDRESS AUDIT: ${total} live card(s) whose email is on a platform's domain (Square, Wix, Shopify, Vagaro, Google, Facebook and the rest).`);
  L.push(`${r.emails} email(s) that could still leave (queued cards, drafts on Home, approved not sent, scheduled follow-ups); ${r.cards} card(s) on Home showing the address with no email that could leave.`);
  L.push('An address at a platform\'s domain is the platform\'s, never the business\'s.');
  L.push(r.apply ? 'APPLIED: each email below was stopped and each address taken off its card, with the reason on the card.' : 'DRY RUN: nothing was changed. Add &apply=1 to stop them.');
  L.push('');
  for (const A of r.agents.values()) {
    const n = (t) => A.items.filter((x) => x.type === t).length;
    L.push(`${A.name || A.agentId}${A.email ? ' <' + A.email + '>' : ''}: ${A.items.length} (${n('email')} email(s), ${n('card')} card(s))`);
    for (const it of A.items) {
      L.push(`  ${r.apply ? (it.type === 'email' ? 'STOPPED' : 'CLEARED') : (it.type === 'email' ? 'stop ' : 'clear')}  [${it.kind}] ${it.athlete} -> ${it.brand}: ${it.address}${it.contactName ? ' (' + it.contactName + ')' : ''}`);
      L.push(`         why: ${it.why}${it.result ? '; ' + it.result : ''}`);
      if (it.message) L.push(`         card says: ${it.message}`);
    }
    L.push('');
  }
  if (!total) L.push('Nothing to stop: no live card carries a platform\'s address.', '');
  const doms = Object.entries(r.domains).sort((a, b) => b[1] - a[1]).map(([d, k]) => `${d} ${k}`).join(', ');
  L.push(`TOTAL: ${r.emails} email(s) to stop, ${r.cards} card(s) to clear${doms ? ` (${doms})` : ''}.`);
  if (r.apply) L.push(`Stopped ${r.stopped}: ${r.converted.call} became call cards, ${r.converted.dm} DM cards, ${r.converted.none} have no phone or handle on file. Cleared ${r.cleared} card(s).`);
  return L.join('\n');
}

module.exports = { run, format, gatherCards, clearCard, kindOfCard };
