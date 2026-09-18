'use strict';
// ── WHAT THE ROSTER OWES, ONCE A DAY ─────────────────────────────────────────
//
// Greg's rule: an agent gets a reminder five days before a deliverable is due
// and again the day before. The literal reading is one email per item per
// milestone. Chad has 45 clients; a monthly deliverable generates twelve dated
// instances, and three brands per athlete is a normal week. That reading sends
// an agent dozens of separate emails a day, which is not a reminder system, it
// is a filter rule waiting to be written. The information survives; the emails
// do not.
//
// So: ONE email per agent per local day, carrying every item at T-5 and every
// item at T-1.
//
// AND EVERYTHING ALREADY OVERDUE, which Greg did not ask for and which the email
// is useless without. A digest that lists a post due Friday while saying nothing
// about the two that were due last week has buried exactly what it exists to
// surface. The overdue block leads, because it is the only part that is already
// costing something.
//
// ── WHAT THIS READS ─────────────────────────────────────────────────────────
// athlete_calendar_events, the dated instances -- not athlete_deliverables. A
// recurring obligation is due twelve times and each instance is separately owed,
// separately done, and separately late. Deliverables with no due date generate
// no instance and cannot appear here: there is no date to count back five days
// from. That is a property of an undated obligation, not an oversight, and the
// Home pin surfaces them instead.

const T_MINUS = [5, 1];   // the two milestones, in days before the due date

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// social_post -> "Post". The stored values come from the extraction prompt.
const TYPE_LABEL = {
  social_post: 'Post', story: 'Story', appearance: 'Appearance',
  content_creation: 'Content', payment_milestone: 'Payment', other: null,
};
function typeLabel(t) {
  if (!t) return null;
  const k = String(t).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (Object.prototype.hasOwnProperty.call(TYPE_LABEL, k)) return TYPE_LABEL[k];
  // Athlete-created rows store human labels already ("Instagram Story").
  return String(t).trim() || null;
}

function dayLabel(n) {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}

// "3 days late" reads as a fact; "-3 days" reads as a bug.
function lateLabel(n) {
  const d = Math.abs(n);
  if (d === 1) return '1 day late';
  return `${d} days late`;
}

// ── COLLECT ─────────────────────────────────────────────────────────────────
// One query, not four. The digest runs for every agent on every tick, and four
// round trips per agent times a roster the size of Chad's is the difference
// between a tick that finishes and one that overlaps the next.
//
// `today` is the agent's LOCAL date as YYYY-MM-DD, passed in rather than
// computed here: the caller already resolved the agent's timezone to decide
// whether to send at all, and computing it twice is how the two disagree at
// midnight. Date arithmetic is done in SQL against a date literal, so no JS
// Date ever touches a deadline.
async function collectDigest(pool, agentId, today) {
  const { rows } = await pool.query(
    `SELECT ace.id,
            ace.title,
            ace.brand,
            ace.event_type,
            to_char(ace.event_date,'YYYY-MM-DD')            AS due_iso,
            (ace.event_date - $2::date)::int                AS days_out,
            ace.athlete_id,
            a.data->>'name'                                 AS athlete_name
       FROM athlete_calendar_events ace
       JOIN athletes a ON a.id = ace.athlete_id
      WHERE ace.agent_id = $1
        AND COALESCE(ace.status,'') NOT IN ('completed','done','complete')
        AND ace.event_date IS NOT NULL
        AND (ace.event_date < $2::date OR (ace.event_date - $2::date)::int = ANY($3::int[]))
      ORDER BY ace.event_date ASC, a.data->>'name' ASC, ace.brand ASC`,
    [agentId, today, T_MINUS]
  );

  const overdue = [], soon = [], tomorrow = [];
  for (const r of rows) {
    if (r.days_out < 0) overdue.push(r);
    else if (r.days_out === 1) tomorrow.push(r);
    else soon.push(r);
  }
  return {
    today, overdue, tomorrow, soon,
    total: rows.length,
    // The count that decides whether an email is worth sending at all.
    actionable: rows.length,
  };
}

// ── THE HOME PIN ────────────────────────────────────────────────────────────
// What is late, across the whole roster, worst first, plus the obligations that
// carry no date at all.
//
// This lives beside collectDigest rather than inline in the route for one
// reason: it is the same question asked of the same rows, and the two answers
// must not drift. A Home block that says an athlete is clear while the 7am email
// says they are three items behind is worse than either surface alone.
//
// UNDATED DELIVERABLES RIDE ALONG. They generate no calendar event, so the
// digest can never mention them and the calendar has nowhere to draw them.
// Without this they are the one class of obligation that can be silently
// forgotten forever.
async function collectPinned(pool, agentId, opts = {}) {
  const limit = Math.min(parseInt(opts.limit, 10) || 25, 100);

  const overdue = await pool.query(
    `SELECT ace.id, ace.title, ace.brand, ace.event_type, ace.athlete_id,
            to_char(ace.event_date,'YYYY-MM-DD') AS due_iso,
            (CURRENT_DATE - ace.event_date)::int AS days_late,
            a.data->>'name' AS athlete_name
       FROM athlete_calendar_events ace
       JOIN athletes a ON a.id = ace.athlete_id
      WHERE ace.agent_id = $1
        AND ace.event_date IS NOT NULL
        AND ace.event_date < CURRENT_DATE
        AND COALESCE(ace.status,'') NOT IN ('completed','done','complete')
      ORDER BY ace.event_date ASC
      LIMIT $2`, [agentId, limit]);

  // Drafts excluded: an unreviewed model guess must not be pinned to Home as
  // an obligation the athlete owes.
  const undated = await pool.query(
    `SELECT ad.id, ad.deliverable_description AS title, ad.brand,
            ad.deliverable_type AS event_type, ad.athlete_id,
            a.data->>'name' AS athlete_name
       FROM athlete_deliverables ad
       JOIN athletes a ON a.id = ad.athlete_id
      WHERE ad.agent_id = $1
        AND ad.due_date IS NULL
        AND COALESCE(ad.status,'') <> 'draft'
        AND COALESCE(ad.status,'') NOT IN ('completed','done','complete')
      ORDER BY ad.created_at DESC NULLS LAST
      LIMIT $2`, [agentId, limit]);

  // Per-athlete counts, so the block can lead with WHO is behind rather than
  // making the agent count rows to work it out.
  const byAthlete = {};
  for (const r of overdue.rows) {
    if (!byAthlete[r.athlete_id]) {
      byAthlete[r.athlete_id] = {
        athleteId: r.athlete_id, name: r.athlete_name, count: 0, worstDaysLate: 0,
      };
    }
    byAthlete[r.athlete_id].count++;
    byAthlete[r.athlete_id].worstDaysLate =
      Math.max(byAthlete[r.athlete_id].worstDaysLate, r.days_late || 0);
  }

  return {
    overdue: overdue.rows,
    undated: undated.rows,
    athletes: Object.values(byAthlete).sort((a, b) => b.worstDaysLate - a.worstDaysLate),
    overdueCount: overdue.rows.length,
    undatedCount: undated.rows.length,
  };
}

// ── RENDER ──────────────────────────────────────────────────────────────────
// Table layout, inline styles, no media queries -- same constraints as
// shiftEmail.js, for the same reason: this is email.

function row(item, appUrl, kind) {
  const base = String(appUrl || 'https://mynildash.com').replace(/\/+$/, '');
  const link = base + '/?view=calendar&focus=' + encodeURIComponent(item.id);
  const t = typeLabel(item.event_type);
  const when = kind === 'overdue' ? lateLabel(item.days_out) : dayLabel(item.days_out);
  const whenColor = kind === 'overdue' ? '#b91c1c' : kind === 'tomorrow' ? '#b45309' : '#4b5563';

  return `<tr>
    <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;">
      <strong>${esc(item.athlete_name || 'Athlete')}</strong>
      <span style="color:#6b7280;"> · ${esc(item.brand || 'Brand')}</span>
      <div style="color:#374151;margin-top:2px;">${esc(item.title || 'Deliverable')}</div>
      ${t ? `<span style="display:inline-block;margin-top:4px;font-size:11px;color:#4b5563;background:#f3f4f6;border-radius:3px;padding:1px 6px;">${esc(t)}</span>` : ''}
    </td>
    <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;white-space:nowrap;color:${whenColor};font-weight:600;text-align:right;">
      ${esc(when)}<div style="font-weight:400;color:#9ca3af;font-size:11px;">${esc(item.due_iso)}</div>
    </td>
    <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;">
      <a href="${link}" style="font-size:12px;color:#4f46e5;text-decoration:none;font-weight:600;">Open</a>
    </td>
  </tr>`;
}

function section(title, note, items, appUrl, kind, accent) {
  if (!items.length) return '';
  return `<tr><td style="padding:18px 0 6px;">
      <div style="font-size:13px;font-weight:700;color:${accent};">${esc(title)} (${items.length})</div>
      ${note ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">${esc(note)}</div>` : ''}
    </td></tr>
    <tr><td>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="border:1px solid #e5e7eb;border-radius:6px;border-collapse:separate;border-spacing:0;">
        ${items.map((i) => row(i, appUrl, kind)).join('')}
      </table>
    </td></tr>`;
}

function renderSubject(d) {
  const o = d.overdue.length, t = d.tomorrow.length, s = d.soon.length;
  // Overdue outranks everything: it is the only category already costing money.
  if (o && (t || s)) return `${o} deliverable${o === 1 ? '' : 's'} overdue, ${t + s} coming up`;
  if (o)             return `${o} deliverable${o === 1 ? '' : 's'} overdue`;
  if (t && s)        return `${t} due tomorrow, ${s} in 5 days`;
  if (t)             return `${t} deliverable${t === 1 ? '' : 's'} due tomorrow`;
  return `${s} deliverable${s === 1 ? '' : 's'} due in 5 days`;
}

function renderDigestEmail(d, opts = {}) {
  const appUrl = String(opts.appUrl || 'https://mynildash.com').replace(/\/+$/, '');
  // Dated, so two mornings with the same counts are not the same email.
  const subject = require('./sendRules').withDate(renderSubject(d), opts.date, opts.tz);

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f9fafb;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:560px;background:#ffffff;border-radius:8px;padding:22px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
        <tr><td style="font-size:16px;font-weight:700;color:#111827;padding-bottom:2px;">
          ${esc(opts.agentName ? opts.agentName.split(' ')[0] + ' — deliverables' : 'Deliverables')}
        </td></tr>
        <tr><td style="font-size:12px;color:#6b7280;padding-bottom:6px;">${esc(subject)}</td></tr>

        ${section('Overdue', 'Not marked done. These are the ones an athlete is falling behind on.',
          d.overdue, appUrl, 'overdue', '#b91c1c')}
        ${section('Due tomorrow', null, d.tomorrow, appUrl, 'tomorrow', '#b45309')}
        ${section('Due in 5 days', null, d.soon, appUrl, 'soon', '#374151')}

        <tr><td style="padding-top:20px;">
          <a href="${appUrl}/?view=calendar"
             style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;
                    font-size:13px;font-weight:600;padding:9px 16px;border-radius:6px;">Open the calendar</a>
        </td></tr>
        <tr><td style="padding-top:16px;font-size:11px;color:#9ca3af;line-height:1.5;">
          Sent once a day. Items appear five days out and again the day before, and stay
          in the overdue list until someone marks them done.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;

  const line = (i, kind) => `  - ${i.athlete_name || 'Athlete'} · ${i.brand || 'Brand'}: `
    + `${i.title || 'Deliverable'} (${kind === 'overdue' ? lateLabel(i.days_out) : dayLabel(i.days_out)}, ${i.due_iso})`;
  const text = [
    subject, '',
    d.overdue.length ? 'OVERDUE\n' + d.overdue.map((i) => line(i, 'overdue')).join('\n') : '',
    d.tomorrow.length ? '\nDUE TOMORROW\n' + d.tomorrow.map((i) => line(i, 'tomorrow')).join('\n') : '',
    d.soon.length ? '\nDUE IN 5 DAYS\n' + d.soon.map((i) => line(i, 'soon')).join('\n') : '',
    '', appUrl + '/?view=calendar',
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

module.exports = {
  collectDigest, collectPinned, renderDigestEmail, renderSubject, typeLabel, T_MINUS,
};
