'use strict';
// ── PLATFORM ADDRESSES ON LIVE CARDS (admin script platform-address-audit) ──
//
// The email finder put ce@squareup.com on the card for "Eyebrows by Corrina".
// squareup.com is Square's own domain: an address there is Square's, never the
// business's. The finder and the send gate refuse them from now on
// (services/emailFinder, services/sendGate). This lists the ones already
// waiting: every live card whose email is on a platform's domain
// (services/websiteValidation.platformDomainOf), by agent.
//
// LIVE: a card that can still send. A queued card not yet sent, an email draft
// waiting on Home, an approved email not yet sent, a scheduled follow-up.
// Never an email that was sent.
//
// READ-ONLY UNLESS apply. On apply each one stops with the reason on the card
// ("Not sent: squareup.com is the platform's address, not the business's.
// Call them instead: <phone>."), and its card becomes the call or DM where
// there is a phone or a handle (the gate's own blockAndOffer). No credit is
// spent either way.

const SG = require('./sendGate');
const WV = require('./websiteValidation');

const ALL_PLATFORM_DOMAINS = () => [...new Set([...WV.PLATFORM_COMPANY_DOMAINS, ...WV.PLATFORM_HOSTS, ...WV.SOCIAL_HOSTS])];

// The address's domain is one of the list, or a subdomain of one.
const ON_PLATFORM_SQL = (col) => `EXISTS (SELECT 1 FROM unnest($1::text[]) AS pd(d)
  WHERE LOWER(SPLIT_PART(TRIM(${col}), '@', 2)) = pd.d OR LOWER(SPLIT_PART(TRIM(${col}), '@', 2)) LIKE '%.' || pd.d)`;

function kindOf(r) {
  if (!r.log_id) return 'queued card';
  if (Number(r.touch_no || 1) > 1) return 'scheduled follow-up';
  if (r.status === 'approved') return 'approved, not sent';
  if (r.queue_id) return 'queued card';
  return 'draft on Home';
}

async function gather(pool, opts = {}) {
  await SG.ensureColumns(pool);
  const doms = ALL_PLATFORM_DOMAINS();
  const scope = (col) => (opts.agentId ? ` AND ${col} = $2` : '');
  const params = opts.agentId ? [doms, String(opts.agentId)] : [doms];
  // 1. Emails written and not sent: their own address, else their card's.
  const logs = (await pool.query(
    `SELECT l.id AS log_id, l.agent_id, l.athlete_id, l.brand_name, l.subject, l.body_html, l.touch_no, l.parent_id,
            l.status, l.source, l.contact_name, l.contact_id, l.created_at,
            COALESCE(NULLIF(TRIM(l.sent_to_email), ''), q.email) AS address,
            q.id AS queue_id, q.contact_name AS queue_contact,
            u.name AS agent_name, u.email AS agent_email, a.data->>'name' AS athlete_name
       FROM outreach_logs l
       LEFT JOIN users u ON u.id = l.agent_id
       LEFT JOIN athletes a ON a.id = l.athlete_id
       LEFT JOIN LATERAL (SELECT id, contact_name, email FROM outreach_queue q2
                           WHERE q2.outreach_log_id = l.id ORDER BY q2.created_at DESC LIMIT 1) q ON TRUE
      WHERE l.sent_at IS NULL AND l.cadence_stopped_at IS NULL AND l.status IN ('draft', 'approved')
        AND COALESCE(NULLIF(TRIM(l.sent_to_email), ''), q.email) IS NOT NULL
        AND ${ON_PLATFORM_SQL("COALESCE(NULLIF(TRIM(l.sent_to_email), ''), q.email)")}${scope('l.agent_id')}`, params)).rows;
  // 2. Queued email cards with no unsent email of their own yet.
  const cards = (await pool.query(
    `SELECT NULL AS log_id, q.agent_id, q.athlete_id, q.brand_name, q.contact_name AS queue_contact, q.created_at,
            TRIM(q.email) AS address, q.id AS queue_id, q.phone, q.instagram, q.channel,
            u.name AS agent_name, u.email AS agent_email, a.data->>'name' AS athlete_name
       FROM outreach_queue q
       LEFT JOIN users u ON u.id = q.agent_id
       LEFT JOIN athletes a ON a.id = q.athlete_id
      WHERE q.sent_at IS NULL AND q.state IN ('queued', 'sending') AND q.channel = 'email'
        AND q.email IS NOT NULL AND TRIM(q.email) <> ''
        AND NOT EXISTS (SELECT 1 FROM outreach_logs l WHERE l.id = q.outreach_log_id AND l.sent_at IS NULL
                          AND l.cadence_stopped_at IS NULL AND l.status IN ('draft', 'approved'))
        AND ${ON_PLATFORM_SQL('q.email')}${scope('q.agent_id')}`, params)).rows;
  // The SQL narrows; the one rule decides.
  return [...logs, ...cards]
    .map((r) => ({ ...r, platform: WV.platformDomainOf(r.address) }))
    .filter((r) => r.platform)
    .sort((a, b) => String(a.agent_name || '').localeCompare(String(b.agent_name || ''))
      || String(a.agent_id).localeCompare(String(b.agent_id))
      || String(a.athlete_name || '').localeCompare(String(b.athlete_name || ''))
      || new Date(a.created_at) - new Date(b.created_at));
}

// A queued card with no email to stop: the card itself becomes the call or
// DM, with the reason on it. No phone or handle: it stays, and the send gate
// refuses it if anyone tries to send it.
async function stopCard(pool, r, verdict) {
  const CHN = require('./cardChannel');
  const offer = await SG.offerFor(pool, { id: '', athlete_id: r.athlete_id, brand_name: r.brand_name }).catch(() => null);
  const phone = r.phone || (offer && offer.phone) || null;
  const instagram = r.instagram || (offer && offer.instagram) || null;
  const channel = CHN.channelOf({ phone, instagram });
  const o = channel ? { channel, phone, instagram } : null;
  const message = `Not sent: ${verdict.why}. ${SG.offerSentence(o, null)}`;
  if (!channel) {
    await pool.query(`UPDATE outreach_queue SET email_note = $2, updated_at = NOW() WHERE id = $1 AND sent_at IS NULL`,
      [r.queue_id, message.slice(0, 400)]);
    return { message, offer: null, converted: false };
  }
  const u = await pool.query(
    `UPDATE outreach_queue SET channel = $2, phone = COALESCE(NULLIF(phone, ''), $4),
            email_note = $3, updated_at = NOW()
      WHERE id = $1 AND sent_at IS NULL AND state IN ('queued', 'sending')`,
    [r.queue_id, channel, message.slice(0, 400), phone]);
  return { message, offer: o, converted: (u.rowCount || 0) > 0 };
}

async function run(pool, opts = {}) {
  const rows = await gather(pool, opts);
  const out = { apply: !!opts.apply, found: rows.length, stopped: 0, converted: { call: 0, dm: 0, none: 0 }, byDomain: {}, agents: new Map() };
  for (const r of rows) {
    const verdict = SG.platformProblem(r.address);
    const key = r.agent_id;
    if (!out.agents.has(key)) out.agents.set(key, { agentId: key, name: r.agent_name || null, email: r.agent_email || null, items: [] });
    const item = { logId: r.log_id || null, cardId: r.queue_id || null, kind: kindOf(r), athlete: r.athlete_name || r.athlete_id,
      brand: r.brand_name, address: r.address, platform: r.platform, why: verdict.why };
    out.byDomain[r.platform] = (out.byDomain[r.platform] || 0) + 1;
    if (opts.apply) {
      const b = r.log_id
        ? await SG.blockAndOffer(pool, { ...r, id: r.log_id, sent_to_email: r.address }, verdict, { contactName: null })
        : await stopCard(pool, r, verdict);
      item.result = b.converted ? `stopped; a ${b.offer.channel} card now` : (b.offer ? `stopped; ${b.offer.channel} offered` : 'stopped; no phone or handle on file');
      item.message = b.message;
      out.stopped++;
      if (b.converted) out.converted[b.offer.channel]++; else out.converted.none++;
    }
    out.agents.get(key).items.push(item);
  }
  return out;
}

function format(r) {
  const L = [];
  L.push(`PLATFORM ADDRESS AUDIT: ${r.found} live card(s) whose email is at a platform's own domain (Square, Wix, Vagaro, Google, Instagram and the rest).`);
  L.push("Rule: an address at a platform's domain is the platform's, never the business's.");
  L.push(r.apply ? 'APPLIED: each one below was stopped, with the reason on the card.' : 'READ-ONLY: nothing was changed. Add &apply=1 to stop them.');
  L.push('');
  for (const A of r.agents.values()) {
    L.push(`${A.name || A.agentId}${A.email ? ' <' + A.email + '>' : ''}: ${A.items.length}`);
    for (const it of A.items) {
      L.push(`  ${r.apply ? 'STOPPED' : 'found'}  [${it.kind}] ${it.athlete} -> ${it.brand}: ${it.address}`);
      L.push(`         why: ${it.why}${it.result ? '; ' + it.result : ''}`);
    }
    L.push('');
  }
  const doms = Object.entries(r.byDomain).sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d} ${n}`).join(', ');
  L.push(`TOTAL: ${r.found}${doms ? ` (${doms})` : ''}.`);
  if (r.apply) L.push(`Stopped ${r.stopped}: ${r.converted.call} became call cards, ${r.converted.dm} DM cards, ${r.converted.none} have no phone or handle on file.`);
  return L.join('\n');
}

module.exports = { gather, run, format, kindOf, stopCard, ALL_PLATFORM_DOMAINS };
