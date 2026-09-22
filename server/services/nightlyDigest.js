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
const INTRO = 'NILDash found new opportunities for your athletes last night. Approve or skip each one right here.';
const FOOTER = 'Pitches expire in 14 days. Approving schedules the email for Tuesday to Thursday morning, in the business’s own timezone.';

// ── THE OTHER KIND OF NIGHT ─────────────────────────────────────────────────
// Nothing new was written, but pitches are still sitting there unapproved.
// That is the exact situation the one-tap buttons exist for, and staying
// silent about it is what let a queue build up in the first place. Same email,
// same rules, a subject that does not claim a fill that did not happen -- and
// at most once every WAITING_EVERY_DAYS days, so it is a nudge and not a drip.
function waitingSubjectFor(n) { return `${n} pitch${n === 1 ? '' : 'es'} waiting for you`; }
const WAITING_INTRO = 'Nothing new was found last night, but these are still waiting on you. Approve or skip each one right here.';
const WAITING_EVERY_DAYS = 3;

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

// ── THE FIRST SENTENCE OF THE PITCH ─────────────────────────────────────────
// Enough to recognise the pitch without opening it, and no more: the email is
// a decision aid, not a reading copy. Markup out first -- the draft is HTML,
// and a paragraph tag in an email that is already HTML would render as nothing
// or as a stray tag depending on the client.
//
// The greeting is dropped. "Hi Dana," is the first sentence of every pitch we
// write, so showing it would give every row the same line.
const MAX_PREVIEW = 180;
function firstSentence(html) {
  let s = String(html == null ? '' : html)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^(hi|hey|hello|dear)\b[^.!?]{0,40}?[,:]\s*/i, '');
  const m = s.match(/^[\s\S]*?[.!?](?=\s|$)/);
  let out = (m ? m[0] : s).trim();
  if (out.length > MAX_PREVIEW) out = out.slice(0, MAX_PREVIEW - 1).replace(/\s+\S*$/, '') + '…';
  return out;
}

// ── THE BUTTONS ─────────────────────────────────────────────────────────────
// Table-based, not <a style="display:inline-block">. Outlook on Windows renders
// through Word, which ignores padding on an inline-block anchor and collapses
// the button to bare underlined text. A single-cell table with the padding on
// the <td> is the shape that survives Gmail, Outlook and iPhone Mail alike.
function button(href, label, { primary } = {}) {
  const bg = primary ? '#111827' : '#ffffff';
  const fg = primary ? '#ffffff' : '#374151';
  const border = primary ? '#111827' : '#d1d5db';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-block;margin:0 6px 0 0">
                <tr><td style="background:${bg};border:1px solid ${border};border-radius:6px">
                  <a href="${esc(href)}" style="display:block;padding:9px 18px;font-size:14px;font-weight:600;color:${fg};text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">${esc(label)}</a>
                </td></tr>
              </table>`;
}

// ── ONE LINE PER PITCH, GROUPED BY ATHLETE ──────────────────────────────────
//
// This used to be one row per athlete and a count -- "Marcus Webb, 3 new
// pitches, Review" -- with one link to the dashboard. Agents were not clicking
// it, so pitches sat and deals stalled. The email now carries the pitches
// themselves, each with the two buttons that are the whole decision.
//
// rows: [{ athleteId, name, place, pitches: [{ id, brand, owner, preview,
//          approveUrl, skipUrl }], approveAllUrl }]
//
// AT MOST TEN ATHLETES. A roster of forty produces an email nobody scrolls,
// and Gmail clips a message over ~102KB with a "View entire message" link that
// hides the buttons below it. Ten athletes is the cap; the rest are a line and
// a link.
const MAX_ATHLETES = 10;

function render({ rows, reviewUrl, unsubUrl, date, tz, waiting, moreAthletes }) {
  const all = Array.isArray(rows) ? rows : [];
  const shown = all.slice(0, MAX_ATHLETES);
  const hidden = typeof moreAthletes === 'number' ? moreAthletes : Math.max(0, all.length - shown.length);
  const n = all.reduce((s, r) => s + ((r.pitches && r.pitches.length) || r.count || 0), 0);
  // THE COUNT AND THE DATE: "3 pitches ready, Fri Sep 18". Never a fixed
  // subject: one subject for every night reads as one email sent thirty
  // times, and the count is the one fact the agent opens it for.
  //
  // `waiting` is the other kind of night: nothing new was written, but pitches
  // are still sitting there. Same email, different first line, and a subject
  // that says what it is rather than claiming a fill that did not happen.
  const subject = require('./sendRules').withDate(waiting ? waitingSubjectFor(n) : subjectFor(n), date, tz);
  const intro = waiting ? WAITING_INTRO : INTRO;
  const review = esc(reviewUrl);

  const block = (r) => {
    const pitches = (r.pitches || []).map((p) => `
            <tr>
              <td style="padding:10px 0 14px;border-top:1px solid #f3f4f6">
                <div style="font-size:15px;font-weight:600;color:#111827">${esc(p.brand)}</div>
                ${p.owner ? `<div style="font-size:13px;color:#6b7280;margin-top:1px">${esc(p.owner)}</div>` : ''}
                ${p.preview ? `<div style="font-size:13px;line-height:1.5;color:#4b5563;margin-top:6px">${esc(p.preview)}</div>` : ''}
                <div style="margin-top:10px">
                  ${button(p.approveUrl, 'Approve', { primary: true })}${button(p.skipUrl, 'Skip')}
                </div>
              </td>
            </tr>`).join('');
    return `
      <tr><td style="padding-top:18px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding-bottom:2px;vertical-align:bottom">
              <span style="font-size:16px;font-weight:700;color:#111827">${esc(r.name)}</span>
              ${r.place ? `<span style="font-size:13px;color:#6b7280">&nbsp;·&nbsp;${esc(r.place)}</span>` : ''}
            </td>
            <td style="padding-bottom:2px;text-align:right;white-space:nowrap;vertical-align:bottom">
              <span style="font-size:13px;color:#6b7280">${(r.pitches || []).length} pitch${(r.pitches || []).length === 1 ? '' : 'es'}</span>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${pitches}
        </table>
        ${r.approveAllUrl && (r.pitches || []).length > 1 ? `<div style="padding:2px 0 4px">${button(r.approveAllUrl, `Approve all ${(r.pitches || []).length} for ${firstNameOf(r.name)}`)}</div>` : ''}
      </td></tr>`;
  };

  const more = hidden > 0 ? `
      <tr><td style="padding-top:18px;border-top:1px solid #e5e7eb">
        <div style="font-size:14px;color:#4b5563">${hidden} more athlete${hidden === 1 ? ' has' : 's have'} pitches waiting.</div>
        <div style="margin-top:8px">${button(reviewUrl, 'See the rest in NILDash')}</div>
      </td></tr>` : '';

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827">
  <div style="display:none;max-height:0;overflow:hidden;color:#f6f6f4">${esc(String(all.length))} athlete${all.length === 1 ? '' : 's'}, ${n} pitch${n === 1 ? '' : 'es'}. Approve or skip each one from here.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f4">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;padding:24px 20px">
        <tr><td style="font-size:15px;line-height:1.5;color:#111827">${esc(intro)}</td></tr>
        ${shown.map(block).join('')}
        ${more}
        <tr><td style="padding-top:20px;border-top:1px solid #e5e7eb;font-size:13px;line-height:1.5;color:#6b7280">${esc(FOOTER)}</td></tr>
        <tr><td style="padding-top:8px;font-size:13px;color:#6b7280"><a href="${review}" style="color:#4b5563">Open NILDash</a></td></tr>
      </table>
      ${unsubUrl ? `<div style="max-width:560px;padding:12px 4px 0;font-size:11px;color:#9ca3af"><a href="${esc(unsubUrl)}" style="color:#9ca3af">Unsubscribe from these emails</a></div>` : ''}
    </td></tr>
  </table>
</body></html>`;

  const lines = [intro, ''];
  for (const r of shown) {
    lines.push(`${r.name}${r.place ? ` (${r.place})` : ''} — ${(r.pitches || []).length} pitch${(r.pitches || []).length === 1 ? '' : 'es'}`);
    for (const p of r.pitches || []) {
      lines.push(`  ${p.brand}${p.owner ? ` (${p.owner})` : ''}`);
      if (p.preview) lines.push(`    ${p.preview}`);
      lines.push(`    Approve: ${p.approveUrl}`);
      lines.push(`    Skip:    ${p.skipUrl}`);
    }
    if (r.approveAllUrl && (r.pitches || []).length > 1) lines.push(`  Approve all ${(r.pitches || []).length}: ${r.approveAllUrl}`);
    lines.push('');
  }
  if (hidden > 0) lines.push(`${hidden} more athlete${hidden === 1 ? ' has' : 's have'} pitches waiting. See the rest in NILDash: ${reviewUrl}`, '');
  lines.push(FOOTER, `Open NILDash: ${reviewUrl}`);
  if (unsubUrl) lines.push('', `Unsubscribe: ${unsubUrl}`);
  return { subject, html, text: lines.join('\n') };
}

function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || String(name || '').trim();
}

// ── THE PITCHES THEMSELVES ──────────────────────────────────────────────────
// Every draft still waiting on this agent, grouped by athlete, most pitches
// first. THE DRAFTS ARE THE SOURCE, not the run's per-athlete counts: a count
// cannot carry a button, and a pitch written two nights ago and still
// unapproved is exactly the one an agent needs to see.
//
// The same conditions approveBatch uses to decide what is approvable -- draft,
// unapproved, cadence not stopped, a follow-up not before it is due. A row in
// this email that approveBatch would refuse is a button that does nothing.
//
// `athleteIds`, when given, narrows to the athletes who got cards tonight; the
// waiting digest passes nothing and gets the whole backlog.
async function pitchesFor(pool, agentId, opts = {}) {
  const only = Array.isArray(opts.athleteIds) && opts.athleteIds.length ? opts.athleteIds : null;
  const r = await pool.query(
    `SELECT l.id, l.athlete_id, l.brand_name, l.body_html, l.created_at,
            a.data->>'name' AS athlete_name, a.data->>'school' AS school,
            a.data->>'city' AS city, a.data->>'team' AS team,
            a.data->>'athleteType' AS "athleteType",
            q.contact_name
       FROM outreach_logs l
       JOIN athletes a ON a.id = l.athlete_id
       LEFT JOIN LATERAL (
         SELECT contact_name FROM outreach_queue q2
          WHERE q2.athlete_id = l.athlete_id AND LOWER(q2.brand_name) = LOWER(l.brand_name)
          ORDER BY q2.created_at DESC LIMIT 1
       ) q ON TRUE
      WHERE l.agent_id = $1
        AND l.status = 'draft' AND l.approved_at IS NULL AND l.cadence_stopped_at IS NULL
        AND (l.next_follow_up_at IS NULL OR l.next_follow_up_at <= $3)
        AND ($2::text[] IS NULL OR l.athlete_id = ANY($2::text[]))
      ORDER BY l.athlete_id, l.created_at ASC`,
    [agentId, only, opts.now ? new Date(opts.now) : new Date()]);

  const by = new Map();
  for (const row of r.rows) {
    if (!by.has(row.athlete_id)) {
      by.set(row.athlete_id, {
        athleteId: row.athlete_id,
        name: row.athlete_name || 'Athlete',
        place: placeOf({ athleteType: row.athleteType, school: row.school, city: row.city, team: row.team }),
        pitches: [],
      });
    }
    by.get(row.athlete_id).pitches.push({
      id: row.id,
      brand: row.brand_name || 'A local business',
      owner: String(row.contact_name || '').trim(),
      preview: firstSentence(row.body_html),
    });
  }
  return [...by.values()]
    .filter((g) => g.pitches.length)
    .sort((a, b) => b.pitches.length - a.pitches.length || a.name.localeCompare(b.name));
}

// The links. One approve and one skip token per pitch, one approve-all per
// athlete, all of them 72-hour single-use (services/pitchActionTokens). The
// groups are mutated in place and returned.
async function attachActionUrls(pool, agentId, groups, opts = {}) {
  const T = require('./pitchActionTokens');
  const base = (opts.appUrl || APP_URL()).replace(/\/+$/, '');
  for (const g of groups) {
    const pairs = await T.issueForMany(pool, agentId,
      g.pitches.map((p) => ({ id: p.id, athleteId: g.athleteId })), { ttlMs: opts.ttlMs });
    for (const p of g.pitches) {
      const t = pairs.get(String(p.id));
      p.approveUrl = t ? `${base}/a/${t.approve}` : base + '/';
      p.skipUrl = t ? `${base}/a/${t.skip}` : base + '/';
    }
    if (g.pitches.length > 1) {
      try {
        const all = await T.issueApproveAll(pool, { agentId, athleteId: g.athleteId, ttlMs: opts.ttlMs });
        g.approveAllUrl = `${base}/a/${all.approveAll}`;
      } catch (e) { console.error('[nightly-digest] approve-all token:', e.message); }
    }
  }
  return groups;
}

// KEPT: the per-athlete counts the run produced. nightly_digest_sends records
// them, the admin page reads them, and tests pin them. The email no longer
// renders from this, but "which athletes got cards tonight" is still the
// question that decides whether a digest goes out at all.
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

  // ── THE PITCHES AND THEIR BUTTONS ──────────────────────────────────────
  // Read AFTER the claim, so two workers cannot both mint tokens for the same
  // night. Narrowed to the athletes who got cards tonight; if none of their
  // drafts are approvable (all edited away, all cadence-stopped between the
  // fill finishing and this running) the email falls back to the plain
  // per-athlete counts rather than going out with no rows in it.
  let groups = await pitchesFor(pool, agentId, { athleteIds: rows.map((r) => r.athleteId), now: opts.now });
  if (groups.length) await attachActionUrls(pool, agentId, groups, opts);
  else groups = rows.map((r) => ({ ...r, pitches: [] }));

  const token = await unsubToken(pool, u);
  const unsubUrl = `${APP_URL()}/api/digest/unsubscribe?token=${encodeURIComponent(token)}`;
  const msg = render({ rows: groups, reviewUrl: `${APP_URL()}/`, unsubUrl, date: opts.now || new Date(), tz: u.report_tz });
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

// ── "12 PITCHES WAITING FOR YOU" ────────────────────────────────────────────
//
// The night found nothing new, so sendForRun sent nothing -- and the pitches
// already written sat there for another day. That silence is what let a queue
// build up in the first place, and the one-tap buttons only help an agent who
// receives them.
//
// NOT A SECOND EMAIL. services/agentEmail still lists exactly one thing that
// mails an agent, and this is it: the same digest, the same template, the same
// suppression and unsubscribe rules, the same nightly_digest_sends claim. Only
// the first line and the subject differ.
//
// AT MOST ONCE EVERY THREE DAYS. A nudge, not a drip. The floor is the last
// digest of any kind that went to this agent, read from nightly_digest_sends,
// so a night that DID find cards also resets the clock -- an agent who got
// yesterday's digest is not told again today that the same pitches are waiting.
//
// Returns the same shape as sendForRun.
async function sendWaiting(pool, { agentId, runDate }, opts = {}) {
  const everyDays = Number(opts.everyDays) || WAITING_EVERY_DAYS;
  const now = opts.now ? new Date(opts.now) : new Date();

  const groups = await pitchesFor(pool, agentId, { now });
  const cards = groups.reduce((s, g) => s + g.pitches.length, 0);
  if (!cards) return { sent: false, reason: 'nothing waiting', athletes: 0, cards: 0 };

  const u = (await pool.query(
    `SELECT id, name, email, role, archived, digest_unsubscribed, digest_unsub_token, report_tz FROM users WHERE id = $1`, [agentId])).rows[0];
  if (!u || !u.email) return { sent: false, reason: 'no such agent, or no email', athletes: groups.length, cards };
  if (u.archived === true) return { sent: false, reason: 'archived', athletes: groups.length, cards };
  if (u.digest_unsubscribed === true) return { sent: false, reason: 'unsubscribed', athletes: groups.length, cards };

  // THE THREE-DAY FLOOR, against every digest, not just waiting ones.
  // opts.force skips it and the once-per-night claim below. It is reachable
  // ONLY from the admin test endpoint, which sends to the caller's own
  // account: the floor is there to stop a drip reaching a customer, and
  // "send me one now so I can tap the buttons" is not a drip.
  if (!opts.force) {
    const last = await pool.query(
      `SELECT MAX(COALESCE(sent_at, created_at)) AS at FROM nightly_digest_sends
        WHERE agent_id = $1 AND status = 'sent'`, [agentId]).catch(() => ({ rows: [] }));
    const at = last.rows && last.rows[0] && last.rows[0].at;
    if (at) {
      const days = (now.getTime() - new Date(at).getTime()) / 86400000;
      if (days < everyDays) {
        return { sent: false, reason: `last digest was ${days.toFixed(1)} days ago; the floor is ${everyDays}`, athletes: groups.length, cards };
      }
    }
  }

  const rule = await require('./sendRules').check(pool, { email: u.email, subject: waitingSubjectFor(cards), system: 'nightly-digest' });
  if (!rule.ok) return { sent: false, reason: 'suppressed: ' + rule.reason, athletes: groups.length, cards };
  if (!allowed(u.email)) {
    console.log(`[nightly-digest] HELD ${u.email} waiting=${cards}: not on NIGHTLY_DIGEST_ALLOWLIST`);
    return { sent: false, reason: 'not on NIGHTLY_DIGEST_ALLOWLIST', athletes: groups.length, cards };
  }

  // The same claim table and the same unique (agent, night): a waiting digest
  // and a new-cards digest cannot both go out on one night.
  //
  // A forced test clears its own claim first, so the endpoint can be hit twice
  // in a minute. It only ever deletes the row for THIS agent and THIS date,
  // and the endpoint only ever names the caller, so a test cannot free a real
  // agent's night and let them be mailed twice.
  if (opts.force) {
    await pool.query(
      `DELETE FROM nightly_digest_sends WHERE agent_id = $1 AND run_date = $2`, [agentId, runDate])
      .catch((e) => console.error('[nightly-digest] force: could not clear the claim:', e.message));
  }
  const claim = await pool.query(
    `INSERT INTO nightly_digest_sends (agent_id, run_date, email, athletes, cards, status)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'claimed')
     ON CONFLICT (agent_id, run_date) DO NOTHING RETURNING id`,
    [agentId, runDate, u.email,
     JSON.stringify(groups.map((g) => ({ athleteId: g.athleteId, name: g.name, place: g.place, count: g.pitches.length }))), cards]);
  if (!claim.rows[0]) return { sent: false, reason: 'already sent tonight', athletes: groups.length, cards };
  const id = claim.rows[0].id;

  await attachActionUrls(pool, agentId, groups, opts);
  const token = await unsubToken(pool, u);
  const unsubUrl = `${APP_URL()}/api/digest/unsubscribe?token=${encodeURIComponent(token)}`;
  const msg = render({ rows: groups, reviewUrl: `${APP_URL()}/`, unsubUrl, date: now, tz: u.report_tz, waiting: true });
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
    console.log(`[nightly-digest] SENT (waiting) ${u.email} night=${runDate} athletes=${groups.length} pitches=${cards}`);
    return { sent: true, reason: null, waiting: true, athletes: groups.length, cards, providerId: providerId || null };
  } catch (e) {
    await pool.query(`UPDATE nightly_digest_sends SET status = 'failed', error = $2 WHERE id = $1`, [id, String(e.message || e).slice(0, 500)]).catch(() => {});
    console.error(`[nightly-digest] waiting send FAILED ${u.email}: ${e.message}`);
    return { sent: false, reason: 'send failed: ' + e.message, athletes: groups.length, cards };
  }
}

module.exports = {
  render, rowsFor, pitchesFor, attachActionUrls, placeOf, firstSentence, button, firstNameOf,
  sendForRun, sendWaiting, allowlist, allowed, subjectFor, waitingSubjectFor,
  SUBJECT, INTRO, WAITING_INTRO, FOOTER, FROM, MAX_ATHLETES, MAX_PREVIEW, WAITING_EVERY_DAYS,
};
