'use strict';
// ── THE WEEKLY PORTAL REPORT ────────────────────────────────────────────────
//
// Mondays, 8 to 9am Central, to every agent who asked for a free Portal Board
// (portal_board_leads) and has not said stop: the 5 FBS schools thinnest at
// the position he looked up, the head coaching changes reported in the last
// 7 days, and the days to the window, with the free board and the trial.
// One per lead per week (claimed by the Monday's date). A signed one-click
// stop link in every email; stopped leads are never emailed again. Off with
// PORTAL_REPORT=off.

const crypto = require('crypto');
const P = require('./positions');
const Pages = require('./positionPages');
const WINDOWS = require('./windows');

const on = () => String(process.env.PORTAL_REPORT || '').toLowerCase() !== 'off';
const chicagoDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d || new Date());
const centralParts = (now) => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  return { weekday: f.find((x) => x.type === 'weekday').value, hour: parseInt(f.find((x) => x.type === 'hour').value, 10) };
};
const BASE = () => (process.env.APP_URL || 'https://mynildash.com').replace(/\/$/, '');
const secret = () => process.env.SESSION_SECRET || process.env.PORTAL_ALERT_SECRET || 'nildash-portal-alerts';
const sig = (email) => crypto.createHmac('sha256', secret()).update('portal-report-stop:' + String(email).toLowerCase()).digest('hex').slice(0, 32);
const stopUrl = (email) => `${BASE()}/portal-report/stop?e=${encodeURIComponent(email)}&s=${sig(email)}`;

async function stop(pool, email, s) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !s || String(s).length !== 32 || !crypto.timingSafeEqual(Buffer.from(String(s)), Buffer.from(sig(e)))) return false;
  await require('./freeBoard').ensureTable(pool);
  await pool.query(`UPDATE portal_board_leads SET unsubscribed = TRUE WHERE email = $1`, [e]);
  return true;
}

let _ready = null;
function ensureTable(pool) {
  if (_ready) return _ready;
  _ready = pool.query(`CREATE TABLE IF NOT EXISTS portal_report_sends (email TEXT NOT NULL, week DATE NOT NULL, sent_at TIMESTAMPTZ, error TEXT, PRIMARY KEY (email, week))`).catch((e) => { _ready = null; throw e; });
  return _ready;
}

function emailFor(lead, data, changes, now) {
  const first = String(lead.name || '').trim().split(/\s+/)[0] || 'there';
  const one = Pages.SINGULAR[data.group];
  const toOpen = Math.round((Date.parse(WINDOWS.football.main.opens + 'T00:00:00Z') - Date.parse(chicagoDay(now) + 'T00:00:00Z')) / 86400000);
  const lines = [`Hi ${first},`, ''];
  if (toOpen > 0) lines.push(`${toOpen} days until the portal window opens (Jan 2 to 16).`, '');
  lines.push(`The 5 FBS schools thinnest at ${one} this week, from ${data.rostersRead} rosters read:`);
  data.rows.slice(0, 5).forEach((r, i) => lines.push(`${i + 1}. ${r.school} (${r.level}): ${r.need.leaving} of ${r.need.on} seniors or older${r.coachingChange ? ', new head coach coming' : ''}`));
  lines.push(`Full list: ${BASE()}/portal-room/needs/${data.group.toLowerCase()}`, '');
  if (changes.length) {
    lines.push('Head coaching changes reported this week:');
    for (const c of changes) lines.push(`- ${c.school}: ${c.coach || 'head coach'} ${c.how === 'fired' ? 'fired' : c.how || 'left'}`);
    lines.push('');
  }
  lines.push(`Your client's own top 10, free: ${BASE()}/portal-board?position=${data.group.toLowerCase()}`,
    `The people to call at each school and a one-pager that shows you who opened it: ${BASE()}/try`, '',
    'JohnMark Compton', 'Founder, NILDash', '',
    `You get this because you asked for a Portal Board. Stop these emails: ${stopUrl(lead.email)}`,
    'Compton Group LLC, 3796 Turnberry Court, Duluth, GA 30096');
  return { subject: `Portal Report: who needs a ${one} this week`, text: lines.join('\n') };
}

async function _send(msg) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('../resendChecked').makeResend(process.env.RESEND_API_KEY);
  const r = await resend.emails.send({ from: process.env.PORTAL_BOARD_FROM || 'JohnMark at NILDash <noreply@mynildash.com>', reply_to: process.env.PORTAL_BOARD_REPLY_TO || 'john@comptongroupllc.com', to: msg.to, subject: msg.subject, text: msg.text,
    headers: { 'List-Unsubscribe': `<${msg.stop}>` } });
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}

// One week's run. -> { leads, sent }
async function run(pool, { now = new Date(), deps = {} } = {}) {
  await require('./freeBoard').ensureTable(pool);
  await ensureTable(pool);
  const week = chicagoDay(now);
  const leads = (await pool.query(`SELECT email, name, grp FROM portal_board_leads WHERE unsubscribed = FALSE ORDER BY id`)).rows;
  const coach = await require('./coachingChanges').load(pool, { now });
  const weekAgo = now.getTime() - 7 * 86400000;
  const changes = [...coach.values()].filter((c) => c.date && Date.parse(c.date + 'T12:00:00Z') >= weekAgo);
  const byGroup = {};
  let sent = 0;
  for (const lead of leads) {
    const group = P.GROUPS.includes(lead.grp) ? lead.grp : 'WR';
    const claim = await pool.query(`INSERT INTO portal_report_sends (email, week) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING email`, [lead.email, week]);
    if (!claim.rows.length) continue;
    byGroup[group] = byGroup[group] || await Pages.dataFor(pool, group, { now });
    const msg = emailFor(lead, byGroup[group], changes, now);
    try {
      await (deps.send || _send)({ to: lead.email, stop: stopUrl(lead.email), ...msg });
      await pool.query(`UPDATE portal_report_sends SET sent_at = NOW() WHERE email = $1 AND week = $2`, [lead.email, week]);
      sent++;
    } catch (e) { await pool.query(`UPDATE portal_report_sends SET error = $3 WHERE email = $1 AND week = $2`, [lead.email, week, String(e.message).slice(0, 300)]); }
  }
  return { leads: leads.length, sent };
}

async function tick(pool, { now = new Date(), deps = {} } = {}) {
  if (!on()) return { skipped: 'off' };
  const c = centralParts(now);
  if (c.weekday !== 'Mon' || c.hour !== 8) return { skipped: 'not the hour' };
  return run(pool, { now, deps });
}

module.exports = { on, run, tick, stop, stopUrl, emailFor };
