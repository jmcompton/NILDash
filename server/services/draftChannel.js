'use strict';
// ── AN EMAIL DRAFT WITH NO ADDRESS IS NOT AN EMAIL CARD (agent side) ────────
//
// services/cardChannel holds the rule; this applies it to outreach_logs.
//
// fillAddress  A draft takes the address already on file for it before anyone
//              decides it has none: its own sent_to_email, the brand contact
//              it was written to (contact_id: the AI Outreach workflow never
//              stamped sent_to_email, so the batch page showed an address the
//              release queue could not see), or the nightly card it was linked
//              to (outreach_queue.email: a scan-time draft written before the
//              ladder finished stayed blank while its card had the address).
//
// refuse       What approve does with a draft that still has none: it is not
//              approved, and the reason is returned (cardChannel.canSend).
//              Nothing is accepted and then failed in the release queue.
//
// convert      A draft with no address whose card has a phone or an Instagram
//              handle becomes that card: the outreach_queue row it came from is
//              switched to a call or DM card, and the draft is retired with the
//              reason. No phone and no handle: it stays off the page and
//              cannot be approved.

const CHN = require('./cardChannel');

const norm = (e) => (CHN.hasEmail(e) ? String(e).trim().toLowerCase() : null);

// Fill sent_to_email from what is on file. ids: outreach_logs ids. Returns
// Map id -> address (only those that have one after this).
async function fillAddress(pool, ids) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  const rows = (await pool.query(
    `SELECT l.id, l.brand_name, l.sent_to_email, c.email AS contact_email, q.email AS queue_email
       FROM outreach_logs l
       LEFT JOIN brand_contacts c ON c.id = l.contact_id
       LEFT JOIN LATERAL (
         SELECT email FROM outreach_queue q2
          WHERE q2.athlete_id = l.athlete_id AND q2.email IS NOT NULL
            AND (q2.outreach_log_id = l.id OR LOWER(q2.brand_name) = LOWER(l.brand_name))
          ORDER BY (q2.outreach_log_id = l.id) DESC, q2.created_at DESC LIMIT 1
       ) q ON TRUE
      WHERE l.id = ANY($1::text[])`, [ids.map(String)]).catch(async () => (await pool.query(
    `SELECT l.id, l.brand_name, l.sent_to_email, NULL AS contact_email, NULL AS queue_email FROM outreach_logs l WHERE l.id = ANY($1::text[])`, [ids.map(String)])))).rows;
  for (const r of rows) {
    const have = norm(r.sent_to_email);
    if (have) { out.set(String(r.id), have); continue; }
    // THEN OUR OWN ADDRESS CACHE. Three of the 25 "no address to send to" rows
    // of 2026-09-23 had an address there all along (Central City Toyota's
    // mmisuraco@, HornsDownShop's info@): nothing asked it.
    const found = norm(r.contact_email) || norm(r.queue_email) || await cachedAddress(pool, r.brand_name);
    if (!found) continue;
    await pool.query(`UPDATE outreach_logs SET sent_to_email = $2, updated_at = NOW() WHERE id = $1 AND COALESCE(sent_to_email, '') = ''`, [r.id, found]);
    out.set(String(r.id), found);
  }
  return out;
}

// ── THE ADDRESS CACHE, BOTH LANES ───────────────────────────────────────────
// siteemail: the address read off the business's own website (draftAddress).
// contacts:  what a past contact lookup found for this business (the ladder's
//            address, a named person's, the inbox). Free: no lookup is made.
// An address that bounced or unsubscribed is not returned.
async function cachedAddress(pool, brand) {
  if (!brand) return null;
  const cand = [];
  try {
    const hit = await require('./draftAddress').lookupOne(pool, brand);
    if (hit && hit.email) cand.push(hit.email);
  } catch (_) { /* the other lane */ }
  try {
    const row = (await pool.query(
      `SELECT evidence FROM brand_evidence_cache WHERE lane = 'contacts' AND LOWER(brand) = LOWER($1) ORDER BY refreshed_at DESC LIMIT 1`, [brand])).rows[0];
    const ev = (row && row.evidence) || {};
    const ladder = ev.addressLadder || {};
    cand.push(ladder.email, ev.personalInbox, ...(Array.isArray(ev.contacts) ? ev.contacts.map((c) => c && c.email) : []), ev.genericInbox);
  } catch (_) { /* nothing cached */ }
  const sup = require('./suppression');
  for (const e of cand) {
    const a = norm(e);
    if (!a) continue;
    const s = await sup.isSuppressed(pool, a).catch(() => ({ suppressed: true }));
    if (!s.suppressed) return a;
  }
  return null;
}

// The sentence for a draft that cannot be sent, with its channel if it has one.
async function refusalFor(pool, id) {
  const q = (await pool.query(
    `SELECT q.phone, q.instagram FROM outreach_logs l
       LEFT JOIN LATERAL (SELECT phone, instagram FROM outreach_queue q2 WHERE q2.athlete_id = l.athlete_id
                            AND (q2.outreach_log_id = l.id OR LOWER(q2.brand_name) = LOWER(l.brand_name))
                          ORDER BY (q2.outreach_log_id = l.id) DESC, q2.created_at DESC LIMIT 1) q ON TRUE
      WHERE l.id = $1`, [id]).catch(() => ({ rows: [] }))).rows[0] || {};
  const v = CHN.canSend({ phone: q.phone, instagram: q.instagram });
  return v.channel
    ? `No email address for this business, so this email cannot be sent. ${v.channel === 'call' ? 'It is a call card now.' : 'It is an Instagram DM card now.'}`
    : 'No email address for this business, so this email cannot be sent, and there is no phone or Instagram to use instead.';
}

// The first sentences of an email, short enough for an Instagram DM, opening
// "Hi <first name>," as every card must (outreachQueue.cardNameProblem).
function dmFromEmail(subject, bodyHtml, contactName) {
  const first = String(contactName || '').trim().split(/\s+/)[0];
  const core = dmCore(bodyHtml);
  return first ? `Hi ${first},\n\n${core}` : core;
}
function dmCore(bodyHtml) {
  const text = String(bodyHtml || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const body = lines.filter((l) => !/^(hi|hello|hey|dear)\b/i.test(l)).join(' ');
  const sents = body.match(/[^.!?]+[.!?]+/g) || [body];
  let out = '';
  for (const s of sents) { if ((out + s).length > 420) break; out += s; }
  return (out || body.slice(0, 420)).trim();
}

// Switch address-less drafts to the call or DM card behind them. scope:
// { agentId, athleteId?, ids? }. Returns { call, dm, none, converted: [...] }.
async function convert(pool, scope = {}) {
  const args = [scope.agentId];
  let where = `l.agent_id = $1 AND l.status = 'draft' AND l.approved_at IS NULL AND l.cadence_stopped_at IS NULL AND COALESCE(l.sent_to_email, '') = ''`;
  if (scope.athleteId) { args.push(String(scope.athleteId)); where += ` AND l.athlete_id = $${args.length}`; }
  if (scope.ids) { args.push(scope.ids.map(String)); where += ` AND l.id = ANY($${args.length}::text[])`; }
  const drafts = (await pool.query(`SELECT l.id FROM outreach_logs l WHERE ${where}`, args)).rows.map((r) => String(r.id));
  const res = { call: 0, dm: 0, none: 0, converted: [] };
  if (!drafts.length) return res;
  const filled = await fillAddress(pool, drafts);
  const rest = drafts.filter((id) => !filled.has(id));
  for (const id of rest) {
    const r = (await pool.query(
      `SELECT l.id, l.subject, l.body_html, l.brand_name, q.id AS qid, q.phone, q.instagram, q.dm_text, q.state, q.contact_name
         FROM outreach_logs l
         LEFT JOIN LATERAL (SELECT id, phone, instagram, dm_text, state, contact_name FROM outreach_queue q2 WHERE q2.athlete_id = l.athlete_id AND q2.state = 'queued'
                              AND (q2.outreach_log_id = l.id OR LOWER(q2.brand_name) = LOWER(l.brand_name))
                            ORDER BY (q2.outreach_log_id = l.id) DESC, q2.created_at DESC LIMIT 1) q ON TRUE
        WHERE l.id = $1`, [id])).rows[0];
    if (!r) continue;
    const channel = r.qid ? CHN.channelOf({ phone: r.phone, instagram: r.instagram }) : null;
    if (!channel) { res.none++; continue; }   // stays off the page; approve refuses it
    // The card a queue row must be (outreachQueue.cardNameProblem): a real
    // named person, and a DM that opens with their first name.
    const dmText = channel === 'dm' ? (String(r.dm_text || '').trim() || dmFromEmail(r.subject, r.body_html, r.contact_name)) : null;
    const problem = require('./outreachQueue').cardNameProblem({ channel, contactName: r.contact_name, brandName: r.brand_name, dmText });
    if (problem) { res.none++; continue; }
    await pool.query(
      `UPDATE outreach_queue SET channel = $2, dm_text = CASE WHEN $2 = 'dm' THEN COALESCE(NULLIF(dm_text, ''), $3) ELSE dm_text END,
              outreach_log_id = NULL, updated_at = NOW()
        WHERE id = $1`, [r.qid, channel, dmText]);
    await pool.query(`UPDATE outreach_logs SET cadence_stopped_at = NOW(), cadence_stop_reason = $2, updated_at = NOW() WHERE id = $1 AND cadence_stopped_at IS NULL`,
      [id, `no email address: it is a ${channel === 'call' ? 'call' : 'DM'} card now`]);
    res[channel]++;
    res.converted.push({ draftId: id, queueId: r.qid, brand: r.brand_name, channel });
  }
  return res;
}

module.exports = { fillAddress, cachedAddress, refusalFor, convert, dmFromEmail };
