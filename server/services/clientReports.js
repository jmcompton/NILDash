'use strict';
// ── THIS WEEK'S CLIENT REPORTS, ONE TAP FROM THE NIGHTLY EMAIL ───────────────
//
// The weekly athlete report (services/athleteReport) is the email an agent
// forwards to make the work visible: who we contacted, who answered, who we
// followed up with, what was earned. It only went out when an agent opened
// the app and pressed Send, and agents do not open the app. So it never went.
//
// Now, from Monday on, the agent's nightly digest carries one more box:
// "This week's reports for Jordan and Riley are ready." One tap opens a page
// listing each athlete, who it goes to and what is in it, with one Send
// button. The GET changes nothing, so a mail scanner that follows every link
// sends nothing. The agent still chooses; NILDash never sends a report on its
// own.
//
// NOT A NEW EMAIL TO THE AGENT (services/agentEmail): it rides the digest.
//
// WHO GETS ONE. An athlete of the agent's with at least one pitch sent in the
// last 7 days (athleteReport.MIN_ACTIVITY_TO_SEND), an email on file for the
// athlete or a parent, both names on file, and no report sent in the last 6
// days. Every recipient passes sendRules (suppression) at send time.
//
// THE OFFER is one row per agent per week (Monday, Central), keyed by an
// unguessable token, good for 13 days, and sent at most once.

const crypto = require('crypto');
const AR = require('./athleteReport');

const DAY = 86400000;
const OFFER_DAYS = 13;
const APP_URL = () => (process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, '');

async function ensureTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS client_report_offers (
    token      TEXT PRIMARY KEY,
    agent_id   TEXT NOT NULL,
    week_start DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at    TIMESTAMPTZ,
    result     JSONB,
    UNIQUE (agent_id, week_start)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS athlete_report_sends (
    id SERIAL PRIMARY KEY, athlete_id TEXT, agent_id TEXT,
    period_start TIMESTAMPTZ, period_end TIMESTAMPTZ,
    recipients TEXT, summary JSONB, sent_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});
}

// Monday of this week in Central time, as YYYY-MM-DD.
function weekStart(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  const back = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[parts.weekday] || 0;
  const d = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - back * DAY);
  return d.toISOString().slice(0, 10);
}

// The report window: the 7 days through the end of today.
function windowFor(now = new Date()) {
  const until = new Date(now); until.setHours(0, 0, 0, 0); until.setDate(until.getDate() + 1);
  const since = new Date(until); since.setDate(since.getDate() - 7);
  return { since, until };
}

function recipientsOf(data) {
  const out = [];
  const ok = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '').trim());
  if (ok(data.athlete.email)) out.push(String(data.athlete.email).trim());
  const p = data.athlete.parentEmail;
  if (ok(p) && String(p).trim().toLowerCase() !== String(data.athlete.email || '').trim().toLowerCase()) out.push(String(p).trim());
  return out;
}

// Which athletes have a report worth sending right now. -> [{ athleteId, name, recipients, pitched, replies, followUps }]
async function ready(pool, agentId, { now = new Date() } = {}) {
  await ensureTables(pool);
  const { since, until } = windowFor(now);
  const athletes = (await pool.query(
    `SELECT a.id FROM athletes a
      WHERE a.agent_id = $1
        AND EXISTS (SELECT 1 FROM outreach_logs l WHERE l.athlete_id = a.id AND l.agent_id = $1 AND l.sent_at >= $2 AND l.sent_at < $3)
        AND NOT EXISTS (SELECT 1 FROM athlete_report_sends s WHERE s.athlete_id = a.id AND s.agent_id = $1 AND s.sent_at > $4)
      ORDER BY a.id`, [agentId, since, until, new Date(now.getTime() - 6 * DAY)])).rows;
  const out = [];
  for (const a of athletes) {
    const d = await AR.collectReportData(a.id, agentId, since, until);
    if (!d || d.missingName || d.activityScore < AR.MIN_ACTIVITY_TO_SEND) continue;
    const recipients = recipientsOf(d);
    if (!recipients.length) continue;
    out.push({ athleteId: a.id, name: d.athlete.name, recipients, pitched: d.pitched.length, replies: d.replies.length, followUps: (d.followedUp || []).length });
  }
  return out;
}

// For the digest: the link, or null when nothing is ready or this week's are sent.
// -> { url, names: [..], count } | null. Never throws.
async function offerFor(pool, agentId, { now = new Date() } = {}) {
  try {
    await ensureTables(pool);
    const wk = weekStart(now);
    const sent = (await pool.query(`SELECT sent_at FROM client_report_offers WHERE agent_id = $1 AND week_start = $2`, [agentId, wk])).rows[0];
    if (sent && sent.sent_at) return null;
    const list = await ready(pool, agentId, { now });
    if (!list.length) return null;
    const token = crypto.randomBytes(18).toString('hex');
    await pool.query(`INSERT INTO client_report_offers (token, agent_id, week_start) VALUES ($1,$2,$3) ON CONFLICT (agent_id, week_start) DO NOTHING`, [token, agentId, wk]);
    const row = (await pool.query(`SELECT token FROM client_report_offers WHERE agent_id = $1 AND week_start = $2`, [agentId, wk])).rows[0];
    return { url: `${APP_URL()}/client-reports/${row.token}`, names: list.map((x) => x.name), count: list.length };
  } catch (e) {
    console.error('[client-reports] offer:', e.message);
    return null;
  }
}

async function byToken(pool, token) {
  await ensureTables(pool);
  if (!/^[a-f0-9]{36}$/.test(String(token || ''))) return null;
  const r = (await pool.query(`SELECT * FROM client_report_offers WHERE token = $1`, [token])).rows[0];
  if (!r) return null;
  const age = Date.now() - new Date(r.created_at).getTime();
  return { ...r, expired: age > OFFER_DAYS * DAY };
}

// Sends one athlete's report. The one path for the app's Send button and the
// one-tap page. -> { ok, to } | { ok:false, status, error }
async function sendOne(pool, { agentId, athleteId, recipients, since, until, send }) {
  const SR = require('./sendRules');
  const wanted = (Array.isArray(recipients) ? recipients : []).map((e) => String(e || '').trim()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (!wanted.length) return { ok: false, status: 400, error: 'No valid recipients' };
  if (wanted.length > 6) return { ok: false, status: 400, error: 'Too many recipients' };
  const to = [];
  for (const e of wanted) { const rule = await SR.check(pool, { email: e, system: 'report' }); if (rule.ok) to.push(e); }
  if (!to.length) return { ok: false, status: 409, error: 'Every recipient is on the suppression list, so nothing was sent.' };
  const data = await AR.collectReportData(athleteId, agentId, since, until);
  if (!data) return { ok: false, status: 404, error: 'Athlete not found' };
  if (data.missingName) return { ok: false, status: 400, error: 'Not sent: ' + data.missingName + '.' };
  if (data.activityScore < AR.MIN_ACTIVITY_TO_SEND) return { ok: false, status: 400, error: 'Nothing happened this week. Sending an empty report does more harm than good.' };
  const res = await send({ from: 'NILDash <hello@mynildash.com>', to, replyTo: data.agent.email || undefined, subject: AR.renderSubject(data), html: AR.renderReportHtml(data) });
  // Resend answers a refusal with { error }, not a throw: never log it as sent.
  if (res && res.error) throw new Error(res.error.message || JSON.stringify(res.error));
  await ensureTables(pool);
  await pool.query(
    `INSERT INTO athlete_report_sends (athlete_id, agent_id, period_start, period_end, recipients, summary) VALUES ($1,$2,$3,$4,$5,$6)`,
    [athleteId, agentId, since, until, to.join(', '), JSON.stringify({ pitched: data.pitched.length, replies: data.replies.length, followUps: (data.followedUp || []).length, earned: data.earned.period })]
  ).catch((e) => console.error('[athlete-report] log failed:', e.message));
  console.log(`[athlete-report] sent for ${data.athlete.name} to ${to.join(', ')}`);
  return { ok: true, to, name: data.athlete.name };
}

// The one-tap page's Send: every ready report, once. -> { ok, sent: [..], failed: [..] }
async function sendAll(pool, token, { send, now = new Date() } = {}) {
  const offer = await byToken(pool, token);
  if (!offer) return { ok: false, status: 404, error: 'This link is not valid.' };
  if (offer.expired) return { ok: false, status: 410, error: 'This link has expired. Send reports from NILDash instead.' };
  const claim = await pool.query(`UPDATE client_report_offers SET sent_at = NOW() WHERE token = $1 AND sent_at IS NULL`, [token]);
  if (!claim.rowCount) return { ok: true, already: true, sent: [], failed: [] };
  const { since, until } = windowFor(now);
  const sent = [], failed = [];
  for (const a of await ready(pool, offer.agent_id, { now })) {
    try {
      const r = await sendOne(pool, { agentId: offer.agent_id, athleteId: a.athleteId, recipients: a.recipients, since, until, send });
      (r.ok ? sent : failed).push({ name: a.name, to: r.to || a.recipients, error: r.ok ? null : r.error });
    } catch (e) { failed.push({ name: a.name, to: a.recipients, error: e.message }); }
  }
  // Nothing went out: the link works again, so a retry is one tap.
  if (!sent.length) await pool.query(`UPDATE client_report_offers SET sent_at = NULL WHERE token = $1`, [token]).catch(() => {});
  await pool.query(`UPDATE client_report_offers SET result = $2 WHERE token = $1`, [token, JSON.stringify({ sent, failed })]).catch(() => {});
  return { ok: true, sent, failed };
}

// ── THE ONE-TAP PAGE ─────────────────────────────────────────────────────────
function page(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f6f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:560px;margin:0 auto;padding:28px 16px"><div style="background:#fff;border-radius:10px;padding:24px 20px">${inner}</div></div></body></html>`;
}
function esc(s) { return String(s == null ? '' : s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderOffer(token, list) {
  const n = list.length;
  const rows = list.map((a) => `<div style="padding:12px 0;border-top:1px solid #f3f4f6">
      <div style="font-size:15px;font-weight:600">${esc(a.name)}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px">${a.pitched} ${a.pitched === 1 ? 'business' : 'businesses'} contacted, ${a.followUps} followed up, ${a.replies} ${a.replies === 1 ? 'reply' : 'replies'}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px">To: ${a.recipients.map(esc).join(', ')}</div></div>`).join('');
  return page('This week\'s client reports', `<div style="font-size:18px;font-weight:700">This week's client reports</div>
    <div style="font-size:14px;color:#4b5563;margin-top:6px;line-height:1.5">Each family sees who was contacted, who answered, who got a follow-up and what was earned. Replies come to you.</div>
    <div style="margin-top:12px">${rows}</div>
    <form method="post" action="/client-reports/${esc(token)}" style="margin-top:16px">
      <button type="submit" style="background:#111827;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-size:15px;font-weight:600;cursor:pointer">Send ${n === 1 ? 'this report' : 'all ' + n + ' reports'}</button></form>`);
}

module.exports = { ensureTables, weekStart, windowFor, recipientsOf, ready, offerFor, byToken, sendOne, sendAll, page, renderOffer, esc, OFFER_DAYS };
