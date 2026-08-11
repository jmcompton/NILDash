'use strict';
// Weekly digest email.
//
// WHY THIS EXISTS. Most accounts never log in. The digest is the only thing that
// reaches them, so it has to earn the open every single time. Two rules follow from
// that and everything else is detail:
//
//   1. NEVER SEND AN EMPTY DIGEST. An email that sometimes says "no updates" teaches
//      people to ignore the ones that matter. shouldSend() is the gate, and it
//      requires real content, not a nonzero count.
//   2. THE SUBJECT NAMES THE CONTENT. "Your weekly summary" is indistinguishable
//      from every other ignorable email. "3 new deals for Duncan and 2 people
//      waiting on you" is not.
//
// SENDING DOMAIN. DIGEST_FROM is an env var on purpose. A bulk weekly email to
// people who rarely log in will draw complaints, and sharing a from-domain with
// password resets puts those resets' deliverability at risk. Point DIGEST_FROM at a
// dedicated subdomain with its own DKIM before this goes wide.

const CENTRAL_TZ = 'America/Chicago';
const SEND_HOUR_CENTRAL = 7;        // Monday 7am Central
const COLD_DAYS = 14;               // no reply this long = going cold
const MAX_NEW_OPPS = 3;
const FOLLOW_UP_MIN_DAYS = 3;       // do not nag about something sent yesterday

// ── Time, in Central, without a timezone library ─────────────────────────────
// The server runs UTC and Central shifts with DST, so the offset cannot be
// hardcoded. Intl knows the rules; this reads the wall-clock parts back out.
function centralParts(ms) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: CENTRAL_TZ, weekday: 'short', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour === '24' ? '0' : p.hour), minute: Number(p.minute),
    dow: DOW[p.weekday],
  };
}

// The Monday that starts this agent's digest week, as YYYY-MM-DD in Central. This
// is the dedupe key: one row per agent per week in digest_sends.
function weekStartCentral(ms) {
  const p = centralParts(ms);
  // Step back to Monday using the Central day-of-week, then re-read the date so a
  // DST boundary inside the step cannot shift it.
  const back = (p.dow + 6) % 7;
  const probe = centralParts(ms - back * 86400000);
  const mm = String(probe.month).padStart(2, '0');
  const dd = String(probe.day).padStart(2, '0');
  return `${probe.year}-${mm}-${dd}`;
}

// Has this week's Monday 7am Central passed? A poller cannot land on an instant, so
// the rule is "the window has opened and this agent has not been sent yet". A
// restart at 7:03 still sends; it does not skip the week.
function sendWindowOpen(ms) {
  const p = centralParts(ms);
  if (p.dow === 1) return p.hour >= SEND_HOUR_CENTRAL;
  return true; // Tue-Sun: this week's Monday is already behind us
}

// ── Data ─────────────────────────────────────────────────────────────────────
// Every query is scoped by agent_id. There is no cross-agent read anywhere in this
// file: one agent's digest can never contain another agent's pipeline.

async function gatherAgentDigest(pool, agent, nowMs) {
  const now = nowMs || Date.now();
  const agentId = agent.id;

  // New opportunities surfaced in the last 7 days, with the fit score and the best
  // contact we found. LEFT JOINs throughout: a brand with no score or no contact is
  // still worth showing, just with less on it.
  const oppsQ = await pool.query(`
    SELECT be.brand_name, be.lane, be.athlete_id, be.first_shown_at,
           a.data->>'name' AS athlete_name,
           bms.compatibility_score, bms.reasoning,
           bc.name AS contact_name, bc.title AS contact_title,
           bc.email AS contact_email, bc.phone AS contact_phone
    FROM brand_engagement be
    LEFT JOIN athletes a ON a.id = be.athlete_id
    LEFT JOIN LATERAL (
      SELECT compatibility_score, reasoning FROM brand_match_scores s
      WHERE s.agent_id = be.agent_id AND s.athlete_id = be.athlete_id
        AND LOWER(s.brand_name) = LOWER(be.brand_name)
      ORDER BY s.created_at DESC LIMIT 1
    ) bms ON TRUE
    LEFT JOIN LATERAL (
      SELECT name, title, email, phone FROM brand_contacts c
      WHERE c.agent_id = be.agent_id AND LOWER(c.brand_name) = LOWER(be.brand_name)
      ORDER BY c.priority_rank ASC, c.confidence_score DESC LIMIT 1
    ) bc ON TRUE
    WHERE be.agent_id = $1
      AND be.state = 'shown'
      AND be.first_shown_at >= NOW() - INTERVAL '7 days'
    ORDER BY bms.compatibility_score DESC NULLS LAST, be.first_shown_at DESC
    LIMIT $2
  `, [agentId, MAX_NEW_OPPS]);

  // The full count is separate from the shown-in-email list: "5 new" with 3 listed
  // is honest, "3 new" when there are 5 is not.
  const newCountQ = await pool.query(`
    SELECT COUNT(*)::int AS n FROM brand_engagement
    WHERE agent_id = $1 AND state = 'shown' AND first_shown_at >= NOW() - INTERVAL '7 days'
  `, [agentId]);

  // Sent, never replied. Split at COLD_DAYS so the two header numbers do not
  // double-count the same person.
  const waitingQ = await pool.query(`
    SELECT ol.id, ol.brand_name, ol.subject, ol.body_html, ol.sent_at, ol.athlete_id,
           ol.follow_up_count,
           a.data->>'name' AS athlete_name,
           bc.name AS contact_name, bc.title AS contact_title, bc.email AS contact_email,
           EXTRACT(EPOCH FROM (NOW() - ol.sent_at)) / 86400 AS days_since
    FROM outreach_logs ol
    LEFT JOIN athletes a ON a.id = ol.athlete_id
    LEFT JOIN brand_contacts bc ON bc.id = ol.contact_id
    WHERE ol.agent_id = $1
      AND ol.sent_at IS NOT NULL
      AND ol.replied_at IS NULL
    ORDER BY ol.sent_at ASC
  `, [agentId]);

  const waiting = waitingQ.rows.map((r) => ({ ...r, days_since: Math.floor(Number(r.days_since || 0)) }));
  const awaitingReply = waiting.filter((r) => r.days_since < COLD_DAYS);
  const goingCold = waiting.filter((r) => r.days_since >= COLD_DAYS);

  // DO THIS FIRST: the single most overdue unanswered email that is old enough to
  // be worth chasing. Oldest first, because that is the one about to die.
  const candidates = waiting.filter((r) => r.days_since >= FOLLOW_UP_MIN_DAYS);
  const action = candidates.length ? candidates[0] : null;

  return {
    agent,
    weekStart: weekStartCentral(now),
    counts: {
      newMatches: newCountQ.rows[0] ? newCountQ.rows[0].n : 0,
      awaitingReply: awaitingReply.length,
      goingCold: goingCold.length,
    },
    action,
    newOpps: oppsQ.rows,
  };
}

// ── The gate ─────────────────────────────────────────────────────────────────
// Counts alone are NOT content. An agent with "0 new, 2 awaiting, 1 cold" and no
// actionable follow-up gets nothing: there is no action in that email, only guilt.
function shouldSend(digest) {
  if (!digest) return false;
  if (digest.agent && digest.agent.digest_unsubscribed) return false;
  return !!digest.action || (digest.newOpps && digest.newOpps.length > 0);
}

// Why an agent was skipped, for the dry run. A skip list that does not say why is
// impossible to act on.
function skipReason(digest) {
  if (!digest) return 'no data';
  if (digest.agent && digest.agent.digest_unsubscribed) return 'unsubscribed';
  if (!digest.action && !(digest.newOpps || []).length) {
    return `nothing to say (${digest.counts.newMatches} new, ${digest.counts.awaitingReply} awaiting, ${digest.counts.goingCold} cold, no follow-up old enough)`;
  }
  return null;
}

// ── Subject ──────────────────────────────────────────────────────────────────
// Names the actual content and the actual people. Never generic.
function firstName(s) {
  const v = String(s || '').trim().split(/\s+/)[0];
  return v || '';
}

function buildSubject(digest) {
  const parts = [];
  const opps = digest.newOpps || [];
  const athletes = [...new Set(opps.map((o) => firstName(o.athlete_name)).filter(Boolean))];
  const n = digest.counts.newMatches;

  if (n > 0) {
    const who = athletes.length === 1 ? ` for ${athletes[0]}`
      : athletes.length === 2 ? ` for ${athletes[0]} and ${athletes[1]}`
      : '';
    parts.push(`${n} new deal${n === 1 ? '' : 's'}${who}`);
  }
  const waiting = digest.counts.awaitingReply + digest.counts.goingCold;
  if (waiting > 0) parts.push(`${waiting} ${waiting === 1 ? 'person' : 'people'} waiting on you`);

  if (!parts.length && digest.action) {
    return `${digest.action.brand_name} has not replied in ${digest.action.days_since} days`;
  }
  return parts.join(' and ');
}

// ── Rendering ────────────────────────────────────────────────────────────────
// MOBILE FIRST. Single column, no side-by-side anything, 44px minimum tap targets.
// Table-based because email clients are not browsers, and inline styles because
// Gmail strips <style> blocks.

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const BTN = 'display:block;width:100%;box-sizing:border-box;min-height:44px;line-height:24px;'
  + 'padding:10px 16px;text-align:center;text-decoration:none;border-radius:8px;'
  + 'font-weight:700;font-size:16px;font-family:Arial,Helvetica,sans-serif';

function renderCount(label, value, color) {
  return `<td align="center" style="padding:10px 4px">
    <div style="font-size:28px;font-weight:800;color:${color};font-family:Arial,Helvetica,sans-serif;line-height:1.1">${value}</div>
    <div style="font-size:12px;color:#6b7280;font-family:Arial,Helvetica,sans-serif;margin-top:4px">${esc(label)}</div>
  </td>`;
}

function renderHtml(digest, opts = {}) {
  const appUrl = opts.appUrl || 'https://mynildash.com';
  const unsubUrl = opts.unsubUrl || `${appUrl}/api/digest/unsubscribe?token=${encodeURIComponent(opts.unsubToken || '')}`;
  const c = digest.counts;
  const a = digest.action;
  const name = firstName(digest.agent.name) || 'there';

  let html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(buildSubject(digest))}</title></head>
<body style="margin:0;padding:0;background:#f4f4f2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2">
<tr><td align="center" style="padding:16px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden">

<tr><td style="padding:20px 20px 8px 20px;font-family:Arial,Helvetica,sans-serif">
  <div style="font-size:13px;color:#6b7280">NILDash weekly</div>
  <div style="font-size:20px;font-weight:800;color:#111827;margin-top:4px">Morning, ${esc(name)}.</div>
</td></tr>

<tr><td style="padding:4px 12px 12px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    ${renderCount('new matches', c.newMatches, '#7c3aed')}
    ${renderCount('awaiting reply', c.awaitingReply, '#2563eb')}
    ${renderCount('going cold', c.goingCold, '#d97706')}
  </tr></table>
</td></tr>`;

  // DO THIS FIRST. The most important block in the email, so it leads, it is the
  // only thing in a coloured box, and the draft is already written.
  if (a) {
    const who = a.contact_name ? `${a.contact_name}${a.contact_title ? `, ${a.contact_title}` : ''}` : 'the contact';
    const mailto = a.contact_email
      ? `mailto:${encodeURIComponent(a.contact_email)}?subject=${encodeURIComponent(a.followUpSubject || ('Re: ' + (a.subject || a.brand_name)))}&body=${encodeURIComponent(a.followUpBody || '')}`
      : `${appUrl}/#outreach`;
    html += `
<tr><td style="padding:0 12px 16px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px">
    <tr><td style="padding:16px;font-family:Arial,Helvetica,sans-serif">
      <div style="font-size:11px;font-weight:800;color:#c2410c;letter-spacing:0.08em">DO THIS FIRST</div>
      <div style="font-size:17px;font-weight:700;color:#111827;margin-top:8px;line-height:1.35">
        Follow up with ${esc(who)} at ${esc(a.brand_name)}
      </div>
      <div style="font-size:14px;color:#4b5563;margin-top:6px;line-height:1.45">
        You emailed them ${a.days_since} days ago about ${esc(a.athlete_name || 'your client')} and have not heard back.
      </div>
      <div style="background:#ffffff;border:1px solid #fed7aa;border-radius:8px;padding:12px;margin-top:12px;font-size:14px;color:#374151;line-height:1.5;white-space:pre-wrap">${esc(a.followUpBody || '')}</div>
      <div style="margin-top:14px">
        <a href="${esc(mailto)}" style="${BTN};background:#ea580c;color:#ffffff">Send this follow-up</a>
      </div>
    </td></tr>
  </table>
</td></tr>`;
  }

  const opps = digest.newOpps || [];
  if (opps.length) {
    html += `
<tr><td style="padding:0 20px 4px 20px;font-family:Arial,Helvetica,sans-serif">
  <div style="font-size:13px;font-weight:800;color:#111827">New this week</div>
</td></tr>`;
    for (const o of opps) {
      const score = o.compatibility_score != null ? Math.round(Number(o.compatibility_score)) : null;
      const contact = o.contact_name
        ? `${o.contact_name}${o.contact_title ? `, ${o.contact_title}` : ''}${o.contact_email ? ` &middot; ${o.contact_email}` : ''}`
        : 'No contact found yet';
      html += `
<tr><td style="padding:6px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px">
    <tr><td style="padding:14px;font-family:Arial,Helvetica,sans-serif">
      <div style="font-size:16px;font-weight:700;color:#111827;line-height:1.3">${esc(o.brand_name)}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:4px">for ${esc(o.athlete_name || 'your client')}${score != null ? ` &middot; fit ${score}` : ''}</div>
      <div style="font-size:13px;color:#374151;margin-top:8px;line-height:1.45">${esc(contact)}</div>
    </td></tr>
  </table>
</td></tr>`;
    }
  }

  html += `
<tr><td style="padding:16px 12px 20px 12px">
  <a href="${esc(appUrl)}/#deal-scan" style="${BTN};background:#111827;color:#ffffff">Open Deal Scan</a>
</td></tr>

<tr><td style="padding:0 20px 20px 20px;font-family:Arial,Helvetica,sans-serif">
  <div style="border-top:1px solid #e5e7eb;padding-top:14px;font-size:12px;color:#9ca3af;line-height:1.5">
    You are getting this because you have an active NILDash account.
    <a href="${esc(unsubUrl)}" style="color:#6b7280;display:inline-block;min-height:44px;line-height:44px">Unsubscribe from the weekly digest</a>
  </div>
</td></tr>

</table></td></tr></table></body></html>`;
  return html;
}

function renderText(digest) {
  const c = digest.counts;
  const a = digest.action;
  const lines = [
    `NILDash weekly`,
    ``,
    `${c.newMatches} new matches | ${c.awaitingReply} awaiting reply | ${c.goingCold} going cold`,
    ``,
  ];
  if (a) {
    lines.push(`DO THIS FIRST`);
    lines.push(`Follow up with ${a.contact_name || 'the contact'} at ${a.brand_name}.`);
    lines.push(`Emailed ${a.days_since} days ago about ${a.athlete_name || 'your client'}, no reply.`);
    lines.push('');
    lines.push(a.followUpBody || '');
    lines.push('');
  }
  for (const o of (digest.newOpps || [])) {
    const score = o.compatibility_score != null ? ` (fit ${Math.round(Number(o.compatibility_score))})` : '';
    lines.push(`- ${o.brand_name} for ${o.athlete_name || 'your client'}${score}`);
    if (o.contact_name) lines.push(`  ${o.contact_name}${o.contact_email ? ' ' + o.contact_email : ''}`);
  }
  return lines.join('\n');
}

// ── The drafted follow-up ────────────────────────────────────────────────────
// Sonnet via ai.oneShot, whose default model IS Sonnet. Never Opus. One call per
// agent at most, and a deterministic fallback so a model outage degrades the email
// instead of killing the send.
async function draftFollowUp(action, ai) {
  if (!action) return null;
  const fallback = `Hi ${firstName(action.contact_name) || 'there'}, following up on my note about a partnership with `
    + `${action.athlete_name || 'one of our athletes'}. I know inboxes get busy. `
    + `Would a quick call this week work, or should I check back later this month?`;
  if (!ai || typeof ai.oneShot !== 'function') return { subject: `Re: ${action.subject || action.brand_name}`, body: fallback };
  try {
    const raw = await ai.oneShot(
      `Write a short follow-up email body. Return ONLY JSON: {"subject":"","body":""}\n`
      + `Original subject: ${action.subject || '(none)'}\n`
      + `Business: ${action.brand_name}\nContact: ${action.contact_name || 'unknown'}\n`
      + `Athlete: ${action.athlete_name || 'our client'}\nDays since the original: ${action.days_since}\n`
      + `Three sentences maximum. Reference the earlier email. One clear ask. No markdown, no placeholders in brackets.`,
      'You write brief follow-up emails for a sports agency. Plain text only. Never invent facts about the business or the athlete.',
      400,
    );
    const s = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i === -1 || j <= i) throw new Error('no json');
    const o = JSON.parse(s.slice(i, j + 1));
    return {
      subject: (o.subject && String(o.subject).trim()) || `Re: ${action.subject || action.brand_name}`,
      body: (o.body && String(o.body).trim()) || fallback,
    };
  } catch (e) {
    console.warn('[weeklyDigest] follow-up draft failed, using the template:', e.message);
    return { subject: `Re: ${action.subject || action.brand_name}`, body: fallback };
  }
}

module.exports = {
  CENTRAL_TZ, SEND_HOUR_CENTRAL, COLD_DAYS, MAX_NEW_OPPS, FOLLOW_UP_MIN_DAYS,
  centralParts, weekStartCentral, sendWindowOpen,
  gatherAgentDigest, shouldSend, skipReason, buildSubject,
  renderHtml, renderText, draftFollowUp, firstName, esc,
};
