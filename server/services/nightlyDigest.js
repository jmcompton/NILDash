'use strict';
// ── THE NIGHTLY DIGEST: "YOUR ATHLETES HAVE NEW PITCHES READY" ───────────────
//
// Sent to an agent the moment the overnight fill finishes for them, when at
// least one athlete got a new card that night. Nothing else: no schedule, no
// marketing, no feature copy. One line at the top, one row per athlete who
// received cards THAT NIGHT, one line at the bottom.
//
// WHO DOES NOT GET IT. An agent the fill skipped as dormant (inactiveSkip)
// never reaches fillAgent's end, so never reaches this. An agent whose fill
// placed nothing is skipped here. An agent who unsubscribed
// (users.digest_unsubscribed, the same flag and link the weekly digest uses)
// is skipped here. And nightly_digest_sends is UNIQUE on (agent, night): the
// row is claimed before the send, so two workers, a retry, or a second run
// for the same night cannot send twice.
//
// The from address is the one every other NILDash email uses.

const APP_URL = () => process.env.APP_URL || 'https://mynildash.com';
const FROM = () => process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>';

// NIGHTLY_DIGEST_ALLOWLIST: when set, a comma-separated list of the only
// addresses the digest may go to, so a night can be verified in one inbox
// before customers see it. An agent not on it is skipped BEFORE the claim,
// so nothing is recorded and the send happens on the first night the list
// is lifted. Unset or empty means everyone. Case and spaces do not matter.
function allowlist() {
  const raw = String(process.env.NIGHTLY_DIGEST_ALLOWLIST || '').trim();
  if (!raw) return null;
  const set = new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return set.size ? set : null;
}
function allowed(email) {
  const set = allowlist();
  return !set || set.has(String(email || '').trim().toLowerCase());
}
const SUBJECT = 'Your athletes have new pitches ready';   // the pre-count wording; rows sent before it carry this
function subjectFor(n) { return `${n} pitch${n === 1 ? '' : 'es'} ready`; }
const INTRO = "NILDash found new opportunities for your athletes last night. Here's what's ready.";
const FOOTER = 'Pitches expire in 14 days. NILDash refills automatically each night.';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// What the row says under the name: the school for a college athlete, the
// city for a pro. Never invented: an athlete with neither shows nothing.
function placeOf(a) {
  if (!a) return '';
  if (a.athleteType === 'pro') return String(a.city || a.team || '').trim();
  return String(a.school || '').trim();
}

// rows: [{ name, place, count }]. Plain, one column on a phone, table-based so
// every mail client renders it the same way.
function render({ rows, reviewUrl, unsubUrl, date, tz }) {
  const n = rows.reduce((s, r) => s + (r.count || 0), 0);
  // THE COUNT AND THE DATE: "3 pitches ready, Fri Sep 18". Never a fixed
  // subject: one subject for every night reads as one email sent thirty
  // times, and the count is the one fact the agent opens it for.
  const subject = require('./sendRules').withDate(subjectFor(n), date, tz);
  const review = esc(reviewUrl);
  const tr = rows.map((r) => `
      <tr>
        <td style="padding:12px 0;border-top:1px solid #e5e7eb;vertical-align:top">
          <div style="font-size:15px;font-weight:600;color:#111827">${esc(r.name)}</div>
          ${r.place ? `<div style="font-size:13px;color:#6b7280;margin-top:2px">${esc(r.place)}</div>` : ''}
        </td>
        <td style="padding:12px 8px;border-top:1px solid #e5e7eb;vertical-align:top;white-space:nowrap;text-align:right">
          <span style="font-size:14px;color:#111827">${r.count} new pitch${r.count === 1 ? '' : 'es'}</span>
        </td>
        <td style="padding:12px 0 12px 8px;border-top:1px solid #e5e7eb;vertical-align:top;text-align:right;white-space:nowrap">
          <a href="${review}" style="display:inline-block;padding:7px 12px;border:1px solid #111827;border-radius:6px;font-size:13px;font-weight:600;color:#111827;text-decoration:none">Review</a>
        </td>
      </tr>`).join('');
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827">
  <div style="display:none;max-height:0;overflow:hidden;color:#f6f6f4">${esc(rows.length)} athlete${rows.length === 1 ? '' : 's'}, ${n} new pitch${n === 1 ? '' : 'es'}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f4">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;padding:24px 20px">
        <tr><td style="font-size:15px;line-height:1.5;color:#111827;padding-bottom:8px">${esc(INTRO)}</td></tr>
        <tr><td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e5e7eb">${tr}
          </table>
        </td></tr>
        <tr><td style="padding-top:16px;font-size:13px;line-height:1.5;color:#6b7280">${esc(FOOTER)}</td></tr>
      </table>
      ${unsubUrl ? `<div style="max-width:560px;padding:12px 4px 0;font-size:11px;color:#9ca3af"><a href="${esc(unsubUrl)}" style="color:#9ca3af">Unsubscribe from these emails</a></div>` : ''}
    </td></tr>
  </table>
</body></html>`;
  const text = [INTRO, '', ...rows.map((r) => `${r.name}${r.place ? ` (${r.place})` : ''}: ${r.count} new pitch${r.count === 1 ? '' : 'es'}. Review: ${reviewUrl}`), '', FOOTER, unsubUrl ? `\nUnsubscribe: ${unsubUrl}` : ''].join('\n');
  return { subject, html, text };
}

// The night's per-athlete results (the run row's details) -> the rows, with
// each athlete's school or city read from the athletes table. Only athletes
// with at least one card placed that night.
async function rowsFor(pool, agentId, details) {
  const got = (Array.isArray(details) ? details : []).filter((d) => d && d.athleteId && (d.filled || 0) > 0);
  if (!got.length) return [];
  const ids = got.map((d) => d.athleteId);
  const r = await pool.query(
    `SELECT id, data->>'name' AS name, data->>'school' AS school, data->>'city' AS city,
            data->>'team' AS team, data->>'athleteType' AS "athleteType"
       FROM athletes WHERE agent_id = $1 AND id = ANY($2)`, [agentId, ids]);
  const by = new Map(r.rows.map((a) => [a.id, a]));
  return got.map((d) => {
    const a = by.get(d.athleteId);
    return { athleteId: d.athleteId, name: (a && a.name) || d.athleteName || 'Athlete', place: placeOf(a), count: d.filled };
  }).filter((x) => x.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

async function unsubToken(pool, user) {
  if (user.digest_unsub_token) return user.digest_unsub_token;
  const token = require('crypto').randomBytes(24).toString('hex');
  await pool.query('UPDATE users SET digest_unsub_token = $1 WHERE id = $2 AND digest_unsub_token IS NULL', [token, user.id]);
  const r = await pool.query('SELECT digest_unsub_token FROM users WHERE id = $1', [user.id]);
  return (r.rows[0] && r.rows[0].digest_unsub_token) || token;
}

// Called by the fill when it finishes for one agent. Returns what it did.
//   { sent: bool, reason, athletes, cards }
// opts.send(message) replaces Resend (tests); opts.now for the date.
async function sendForRun(pool, { agentId, runDate, details }, opts = {}) {
  const rows = await rowsFor(pool, agentId, details);
  const cards = rows.reduce((s, r) => s + r.count, 0);
  if (!rows.length || !cards) return { sent: false, reason: 'no new cards', athletes: 0, cards: 0 };
  const u = (await pool.query(
    `SELECT id, name, email, role, archived, digest_unsubscribed, digest_unsub_token, report_tz FROM users WHERE id = $1`, [agentId])).rows[0];
  if (!u || !u.email) return { sent: false, reason: 'no such agent, or no email', athletes: rows.length, cards };
  if (u.archived === true) return { sent: false, reason: 'archived', athletes: rows.length, cards };
  if (u.digest_unsubscribed === true) return { sent: false, reason: 'unsubscribed', athletes: rows.length, cards };
  // The suppression list stops everything, this included.
  const rule = await require('./sendRules').check(pool, { email: u.email, subject: subjectFor(cards), system: 'nightly-digest' });
  if (!rule.ok) return { sent: false, reason: 'suppressed: ' + rule.reason, athletes: rows.length, cards };
  if (!allowed(u.email)) {
    console.log(`[nightly-digest] HELD ${u.email} night=${runDate} athletes=${rows.length} cards=${cards}: not on NIGHTLY_DIGEST_ALLOWLIST (nothing recorded; sends when the list is lifted)`);
    return { sent: false, reason: 'not on NIGHTLY_DIGEST_ALLOWLIST', athletes: rows.length, cards };
  }

  // The claim: one row per agent per night, taken before anything is sent.
  const claim = await pool.query(
    `INSERT INTO nightly_digest_sends (agent_id, run_date, email, athletes, cards, status)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'claimed')
     ON CONFLICT (agent_id, run_date) DO NOTHING RETURNING id`,
    [agentId, runDate, u.email, JSON.stringify(rows.map((r) => ({ athleteId: r.athleteId, name: r.name, place: r.place, count: r.count }))), cards]);
  if (!claim.rows[0]) return { sent: false, reason: 'already sent tonight', athletes: rows.length, cards };
  const id = claim.rows[0].id;

  const token = await unsubToken(pool, u);
  const unsubUrl = `${APP_URL()}/api/digest/unsubscribe?token=${encodeURIComponent(token)}`;
  const msg = render({ rows, reviewUrl: `${APP_URL()}/`, unsubUrl, date: opts.now || new Date(), tz: u.report_tz });
  await pool.query(`UPDATE nightly_digest_sends SET subject = $2 WHERE id = $1`, [id, msg.subject]).catch(() => {});
  try {
    const send = opts.send || (async (m) => {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      return resend.emails.send(m);
    });
    const result = await send({
      from: FROM(), to: u.email, subject: msg.subject, html: msg.html, text: msg.text,
      headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
    if (result && result.error) throw new Error(result.error.message || JSON.stringify(result.error));
    const providerId = result && result.data && result.data.id;
    await pool.query(`UPDATE nightly_digest_sends SET status = 'sent', provider_id = $2, sent_at = NOW() WHERE id = $1`, [id, providerId || null]);
    console.log(`[nightly-digest] SENT ${u.email} night=${runDate} athletes=${rows.length} cards=${cards}`);
    return { sent: true, reason: null, athletes: rows.length, cards, providerId: providerId || null };
  } catch (e) {
    await pool.query(`UPDATE nightly_digest_sends SET status = 'failed', error = $2 WHERE id = $1`, [id, String(e.message || e).slice(0, 500)]).catch(() => {});
    console.error(`[nightly-digest] send FAILED ${u.email} night=${runDate}: ${e.message}`);
    return { sent: false, reason: 'send failed: ' + e.message, athletes: rows.length, cards };
  }
}

module.exports = { render, rowsFor, placeOf, sendForRun, allowlist, allowed, subjectFor, SUBJECT, INTRO, FOOTER, FROM };
