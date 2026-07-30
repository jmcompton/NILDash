// server/services/athleteReport.js
// Weekly Athlete Report — the client-facing proof-of-work email.
//
// WHY THIS EXISTS
// Deal Scan and outreach make an agent's job easier. This makes an agent's job
// SAFER. The conversation that loses an agent a client is a parent asking "what
// have you actually done for my son this month" and the agent having no answer.
// Every number below already lives in the database; nobody was ever showing it
// to the people who care most.
//
// AUDIENCE — three readers, one email:
//   Athlete: what do I have to do, and what am I making
//   Parent:  is my kid being looked after, is this legitimate, is it safe
//   Agent:   proof of work, near-zero effort to send
//
// SAFETY
//   - Reads only. Writes exclusively to athlete_reports.
//   - Never auto-sends. An agent approves every report before it leaves.
//   - Never sends an empty report. A "we did nothing this week" email is worse
//     than silence; the agent gets nudged privately instead.

'use strict';

const { pool } = require('../store');

const MIN_ACTIVITY_TO_SEND = 1; // below this, nudge the agent, do not email the family

// ─── Data collection ────────────────────────────────────────────────────────

/**
 * Gather every fact for one athlete over one window.
 * Each query is individually guarded: a missing table degrades one section
 * rather than killing the whole report.
 */
async function collectReportData(athleteId, agentId, since, until) {
  const q = async (sql, params, fallback) => {
    try { return (await pool.query(sql, params)).rows; }
    catch (e) { console.error('[athleteReport] query failed:', e.message); return fallback; }
  };

  const [athleteRow] = await q(
    `SELECT a.id, a.data, u.name AS agent_name, u.email AS agent_email
       FROM athletes a LEFT JOIN users u ON u.id = a.agent_id
      WHERE a.id = $1 AND a.agent_id = $2`, [athleteId, agentId], []);
  if (!athleteRow) return null;

  const ath = athleteRow.data || {};

  // Brands pitched in the window, with the strongest signal each produced.
  // opened_at and replied_at turn "we emailed people" into "three of them read
  // it and one wrote back", which is the difference between noise and progress.
  const pitched = await q(
    `SELECT brand_name,
            MIN(sent_at)     AS first_sent,
            BOOL_OR(opened_at  IS NOT NULL) AS opened,
            BOOL_OR(replied_at IS NOT NULL) AS replied
       FROM outreach_logs
      WHERE athlete_id = $1 AND agent_id = $2
        AND sent_at >= $3 AND sent_at < $4
      GROUP BY brand_name
      ORDER BY BOOL_OR(replied_at IS NOT NULL) DESC,
               BOOL_OR(opened_at IS NOT NULL) DESC,
               MIN(sent_at) ASC`,
    [athleteId, agentId, since, until], []);

  // Media kit opens. A named brand means a tracked link was used.
  const kitViews = await q(
    `SELECT COALESCE(variant_brand, '') AS brand, COUNT(*)::int AS views
       FROM media_kit_views
      WHERE athlete_id = $1 AND viewed_at >= $2 AND viewed_at < $3
      GROUP BY COALESCE(variant_brand, '')
      ORDER BY COUNT(*) DESC`,
    [athleteId, since, until], []);

  // Live pipeline, any age — a parent cares about what is still cooking, not
  // only what moved in the last seven days.
  const pipeline = await q(
    `SELECT brand_name, status, deal_value, brand_category
       FROM athlete_deal_pipeline
      WHERE athlete_id = $1
        AND COALESCE(status,'') NOT IN ('not_contacted','lost','declined')
      ORDER BY updated_at DESC LIMIT 12`,
    [athleteId], []);

  // Money closed in the window, and lifetime.
  const [earned] = await q(
    `SELECT COALESCE(SUM(deal_value) FILTER (WHERE closed_at >= $2 AND closed_at < $3),0)::numeric AS period,
            COALESCE(SUM(deal_value),0)::numeric AS lifetime,
            COUNT(*) FILTER (WHERE closed_at >= $2 AND closed_at < $3)::int AS period_count,
            COUNT(*)::int AS lifetime_count
       FROM deal_outcomes WHERE athlete_id = $1`,
    [athleteId, since, until], [{ period: 0, lifetime: 0, period_count: 0, lifetime_count: 0 }]);

  // What the athlete personally owes in the next two weeks. This is the section
  // that makes the email useful to the athlete rather than just flattering to
  // the agent.
  const upcoming = await q(
    `SELECT title, event_date, brand, status
       FROM athlete_calendar_events
      WHERE athlete_id = $1
        AND event_date >= CURRENT_DATE
        AND event_date <= CURRENT_DATE + INTERVAL '14 days'
        AND COALESCE(status,'') NOT IN ('completed','done','complete')
      ORDER BY event_date ASC LIMIT 10`,
    [athleteId], []);

  // Anything overdue gets called out plainly. Hiding it helps nobody.
  const overdue = await q(
    `SELECT title, event_date, brand
       FROM athlete_calendar_events
      WHERE athlete_id = $1 AND event_date < CURRENT_DATE
        AND COALESCE(status,'') NOT IN ('completed','done','complete')
      ORDER BY event_date ASC LIMIT 5`,
    [athleteId], []);

  // Lifetime outreach, for the "since we started" line.
  const [totals] = await q(
    `SELECT COUNT(DISTINCT brand_name)::int AS brands_all_time
       FROM outreach_logs WHERE athlete_id = $1 AND sent_at IS NOT NULL`,
    [athleteId], [{ brands_all_time: 0 }]);

  const namedKitViews = kitViews.filter(v => v.brand);
  const anonKitViews = kitViews.filter(v => !v.brand)
    .reduce((n, v) => n + v.views, 0);

  return {
    athlete: {
      id: athleteId,
      name: ath.name || 'Your athlete',
      firstName: String(ath.name || '').trim().split(/\s+/)[0] || 'there',
      sport: ath.sport || null,
      school: ath.school || null,
      email: ath.email || null,
      parentEmail: ath.parentEmail || ath.guardianEmail || null,
    },
    agent: {
      name: athleteRow.agent_name || 'Your agent',
      email: athleteRow.agent_email || null,
    },
    period: { since, until },
    pitched,
    replies: pitched.filter(p => p.replied),
    opens: pitched.filter(p => p.opened && !p.replied),
    namedKitViews,
    anonKitViews,
    pipeline,
    earned: {
      period: Number(earned.period) || 0,
      lifetime: Number(earned.lifetime) || 0,
      periodCount: earned.period_count || 0,
      lifetimeCount: earned.lifetime_count || 0,
    },
    upcoming,
    overdue,
    brandsAllTime: totals.brands_all_time || 0,
    activityScore: pitched.length + namedKitViews.length + anonKitViews,
  };
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString();
const shortDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const STATUS_LABEL = {
  contacted: 'Contacted', pitched: 'Pitched', negotiating: 'In negotiation',
  interested: 'Interested', verbal: 'Verbal agreement', signed: 'Signed', closed: 'Closed',
};

/**
 * Build the report email.
 * Tables and inline styles throughout: Outlook and Gmail both mangle flexbox,
 * and this email has to survive being forwarded to a parent on a phone.
 */
function renderReportHtml(d) {
  const P = '#0A0E1A', G = '#84CC16', TXT = '#1f2937', MUT = '#6b7280', LINE = '#e5e7eb';
  const section = (title) =>
    `<tr><td style="padding:26px 0 10px"><div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${MUT}">${esc(title)}</div></td></tr>`;
  const stat = (n, label, color) =>
    `<td width="33%" align="center" style="padding:14px 6px;background:#f9fafb;border-radius:8px">
       <div style="font-size:26px;font-weight:700;color:${color};line-height:1">${n}</div>
       <div style="font-size:11px;color:${MUT};margin-top:5px">${esc(label)}</div>
     </td>`;

  let body = '';

  body += `<tr><td style="padding:22px 0 4px">
    <div style="font-size:20px;font-weight:700;color:${TXT}">This week for ${esc(d.athlete.name)}</div>
    <div style="font-size:13px;color:${MUT};margin-top:4px">
      ${shortDate(d.period.since)} to ${shortDate(new Date(new Date(d.period.until).getTime() - 86400000))}
      ${d.athlete.school ? ' &middot; ' + esc(d.athlete.school) : ''}
    </div></td></tr>`;

  body += `<tr><td style="padding:14px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>
      ${stat(d.pitched.length, d.pitched.length === 1 ? 'business pitched' : 'businesses pitched', P)}
      ${stat(d.opens.length + d.replies.length, 'showed interest', G)}
      ${stat(money(d.earned.period), 'earned this week', P)}
    </tr></table></td></tr>`;

  // Named brands. "Nine businesses" is a claim; the list is evidence. This is
  // the single most important block in the email for a skeptical parent.
  if (d.pitched.length) {
    body += section('Who we contacted');
    body += `<tr><td>`;
    for (const p of d.pitched) {
      const badge = p.replied
        ? `<span style="font-size:10px;font-weight:700;color:#166534;background:#dcfce7;padding:3px 8px;border-radius:99px">Replied</span>`
        : p.opened
        ? `<span style="font-size:10px;font-weight:700;color:#854d0e;background:#fef9c3;padding:3px 8px;border-radius:99px">Opened it</span>`
        : `<span style="font-size:10px;color:${MUT}">Sent ${shortDate(p.first_sent)}</span>`;
      body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:9px 0;border-top:1px solid ${LINE};font-size:14px;color:${TXT}">${esc(p.brand_name)}</td>
        <td align="right" style="padding:9px 0;border-top:1px solid ${LINE}">${badge}</td></tr></table>`;
    }
    body += `</td></tr>`;
  }

  if (d.namedKitViews.length || d.anonKitViews) {
    body += section('Brands who looked at your media kit');
    body += `<tr><td>`;
    for (const v of d.namedKitViews) {
      body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:9px 0;border-top:1px solid ${LINE};font-size:14px;color:${TXT}">${esc(v.brand)}</td>
        <td align="right" style="padding:9px 0;border-top:1px solid ${LINE};font-size:12px;color:${MUT}">
          ${v.views} ${v.views === 1 ? 'view' : 'views'}</td></tr></table>`;
    }
    if (d.anonKitViews) {
      body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:9px 0;border-top:1px solid ${LINE};font-size:14px;color:${MUT}">
          ${d.anonKitViews} other ${d.anonKitViews === 1 ? 'view' : 'views'}</td></tr></table>`;
    }
    body += `</td></tr>`;
  }

  if (d.pipeline.length) {
    body += section('Deals in progress');
    body += `<tr><td>`;
    for (const p of d.pipeline) {
      const label = STATUS_LABEL[String(p.status || '').toLowerCase()] || 'In progress';
      const val = p.deal_value && String(p.deal_value).trim() ? esc(String(p.deal_value)) : '';
      body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:9px 0;border-top:1px solid ${LINE};font-size:14px;color:${TXT}">
          ${esc(p.brand_name)}<span style="color:${MUT};font-size:12px"> &middot; ${esc(label)}</span></td>
        <td align="right" style="padding:9px 0;border-top:1px solid ${LINE};font-size:13px;color:${TXT}">${val}</td>
      </tr></table>`;
    }
    body += `</td></tr>`;
  }

  // The athlete's own to-do list. Overdue first and stated plainly, because a
  // missed deliverable is a breach of a real contract.
  if (d.overdue.length) {
    body += section('Past due, please handle these');
    body += `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px"><tr><td style="padding:12px 14px">`;
    for (const o of d.overdue) {
      body += `<div style="font-size:13px;color:#991b1b;padding:3px 0">
        ${esc(o.title)}${o.brand ? ' for ' + esc(o.brand) : ''}
        <span style="color:#b91c1c">&middot; was due ${shortDate(o.event_date)}</span></div>`;
    }
    body += `</td></tr></table></td></tr>`;
  }

  if (d.upcoming.length) {
    body += section('Coming up in the next two weeks');
    body += `<tr><td>`;
    for (const u of d.upcoming) {
      body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:9px 0;border-top:1px solid ${LINE};font-size:14px;color:${TXT}">
          ${esc(u.title)}${u.brand ? '<span style="color:' + MUT + ';font-size:12px"> for ' + esc(u.brand) + '</span>' : ''}</td>
        <td align="right" style="padding:9px 0;border-top:1px solid ${LINE};font-size:13px;color:${MUT}">
          ${shortDate(u.event_date)}</td></tr></table>`;
    }
    body += `</td></tr>`;
  }

  // Cumulative context. One good week means little; the running total is what
  // shows a parent this is sustained work.
  body += `<tr><td style="padding:24px 0 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="background:${P};border-radius:8px"><tr><td style="padding:16px 18px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${G}">Since we started</div>
      <div style="font-size:14px;color:#e5e7eb;margin-top:7px;line-height:1.6">
        ${d.brandsAllTime} ${d.brandsAllTime === 1 ? 'business' : 'businesses'} contacted on
        ${esc(d.athlete.firstName)}'s behalf${d.earned.lifetimeCount
          ? `, ${d.earned.lifetimeCount} ${d.earned.lifetimeCount === 1 ? 'deal' : 'deals'} closed for ${money(d.earned.lifetime)} total`
          : ''}.
      </div></td></tr></table></td></tr>`;

  body += `<tr><td style="padding:22px 0 8px">
    <div style="font-size:13px;color:${MUT};line-height:1.6;border-top:1px solid ${LINE};padding-top:18px">
      Questions about anything here? Just reply to this email and it goes straight to ${esc(d.agent.name)}.
    </div></td></tr>`;

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0"
    style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
    <tr><td style="background:${P};padding:18px 28px">
      <span style="font-size:19px;font-weight:700;letter-spacing:.02em;color:#fff">NIL<span style="color:${G}">Dash</span></span>
    </td></tr>
    <tr><td style="padding:0 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table></td></tr>
    <tr><td style="padding:16px 28px 24px">
      <div style="font-size:11px;color:#9ca3af;line-height:1.6">Sent by ${esc(d.agent.name)} through NILDash.</div>
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

// Subject line leads with the best real news. A parent who sees "Barclay GMC
// replied about Marcus" opens it; "Weekly update" gets ignored.
function renderSubject(d) {
  if (d.replies.length) {
    const b = d.replies[0].brand_name;
    return d.replies.length === 1
      ? `${b} replied about ${d.athlete.firstName}`
      : `${d.replies.length} brands replied about ${d.athlete.firstName}`;
  }
  if (d.earned.periodCount) return `${d.athlete.firstName} closed a deal this week`;
  if (d.pitched.length) return `${d.pitched.length} ${d.pitched.length === 1 ? 'business' : 'businesses'} contacted for ${d.athlete.firstName} this week`;
  return `Weekly update for ${d.athlete.firstName}`;
}

module.exports = { collectReportData, renderReportHtml, renderSubject, MIN_ACTIVITY_TO_SEND };
