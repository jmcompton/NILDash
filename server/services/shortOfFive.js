'use strict';
// ── ATHLETES SHORT OF FIVE VERIFIED EMAILS, AT 5:30 CENTRAL ─────────────────
//
// EMAIL_FIVE_ON (jobs/outreachQueue): the nightly fill fills a slot only with
// an email card carrying a verified address for a named person. When an
// athlete still holds fewer than five of those at 5:30am Central, the admin
// gets one email that morning naming each one, how many they hold, and why
// the night stopped short -- read from the night's own run record.
//
// Once per Central date (claimed in short_five_alerts before sending, so two
// instances send one email). A morning with nobody short sends nothing and is
// recorded 'clear'.

const OQ = require('../jobs/outreachQueue');

const FIVE = 5;
const FROM_MINUTE = 5 * 60 + 30;   // 5:30am Central
const UNTIL_HOUR = 12;
const MAX_ATTEMPTS = 4;
const TO = () => process.env.ADMIN_ALERT_EMAIL || process.env.ADMIN_EMAIL || '';
const FROM = () => process.env.ADMIN_ALERT_FROM || process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>';

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS short_five_alerts (
    alert_date DATE PRIMARY KEY, status TEXT NOT NULL, athletes INT NOT NULL DEFAULT 0,
    subject TEXT, body TEXT, attempts INT NOT NULL DEFAULT 0, error TEXT,
    sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`).catch((e) => console.error('[short-of-five] table:', e.message));
}

function centralMinutes(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: OQ.CENTRAL_TZ, hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ms == null ? Date.now() : ms));
  const h = Number((parts.find((p) => p.type === 'hour') || {}).value) % 24;
  const m = Number((parts.find((p) => p.type === 'minute') || {}).value);
  return h * 60 + m;
}
function windowOpen(ms) {
  const m = centralMinutes(ms);
  return m >= FROM_MINUTE && m < UNTIL_HOUR * 60;
}

const STOPS = {
  time: 'the per-athlete time limit', cost: 'the per-athlete cost ceiling', ladder: 'every source of businesses, with nothing new left',
  'agent-cap': "the agent's nightly money cap", share: "this athlete's share of the agent's nightly money",
};

// WHY, IN ONE SENTENCE, FROM THE NIGHT'S RECORD. Pure.
//   d     the athlete's entry in outreach_queue_runs.details (or null: no run)
//   held  { verified, other, otherExpires } from the queue
function reasonFor(d, held, run) {
  const h = held || { verified: 0, other: 0 };
  const bits = [];
  if (!run) bits.push('the nightly run did not run for this agent');
  else if (!run.finished_at) bits.push('the run had not finished by 5:30');
  if (d && d.error) bits.push(`the fill crashed for this athlete: ${d.error}`);
  if (d && d.paused) bits.push(`paused: ${d.note || 'three nights with nothing found'}`);
  if (d && (d.noMarket || d.schoolProblem)) bits.push(`no local market (${d.schoolProblem || 'no school or town on file'})`);
  const loop = (d && d.loop) || {};
  const tried = (d && Array.isArray(d.tried)) ? d.tried : [];
  if (d && !d.error && !d.paused) {
    if (loop.stop && loop.stop !== 'floor') bits.push(`stopped by ${STOPS[loop.stop] || loop.stop}`);
    const dropped = tried.filter((t) => t && t.stage === 'email' && t.result === 'rejected');
    const why = {};
    for (const t of dropped) {
      const m = String(t.reason || '').match(/\(([^)]*)\)\s*$/);
      const k = m ? m[1].replace(/:.*$/, '').replace(/ after \d+ tr(y|ies)$/, '').slice(0, 60) : 'no address found';
      why[k] = (why[k] || 0) + 1;
    }
    const parts = [`${tried.length} business${tried.length === 1 ? '' : 'es'} tried`];
    if (dropped.length) parts.push(`${dropped.length} dropped with no verified email (${Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ')})`);
    const chains = tried.filter((t) => t && t.stage === 'selection').length;
    if (chains) parts.push(`${chains} chain or non-email lane skipped at selection`);
    const notRun = tried.filter((t) => t && t.result === 'deferred').length;
    if (notRun) parts.push(`${notRun} check(s) that could not run, retried`);
    const refused = tried.filter((t) => t && t.result === 'no_angle').length;
    if (refused) parts.push(`${refused} refused by the writer`);
    const noName = tried.filter((t) => t && t.result === 'no_name').length;
    if (noName) parts.push(`${noName} with nobody to name`);
    bits.push(parts.join('; '));
  }
  if (h.other > 0) bits.push(`${h.other} slot${h.other === 1 ? '' : 's'} held by earlier DM, call or unverified cards`
    + (h.otherExpires ? ` (first expires ${String(h.otherExpires).slice(0, 10)})` : ''));
  return bits.join('. ') + '.';
}

async function collect(pool, { now } = {}) {
  const runDate = OQ.today(now);
  const runs = (await pool.query(
    `SELECT r.agent_id, u.name AS agent_name, r.filled, r.note, r.details, r.finished_at
       FROM outreach_queue_runs r LEFT JOIN users u ON u.id = r.agent_id WHERE r.run_date = $1`, [runDate])).rows;
  const held = new Map((await pool.query(
    `SELECT athlete_id,
            COUNT(*) FILTER (WHERE channel = 'email' AND email_verified)::int AS verified,
            COUNT(*) FILTER (WHERE NOT (channel = 'email' AND email_verified))::int AS other,
            MIN(COALESCE(expire_from, created_at) + make_interval(days => $1)) FILTER (WHERE NOT (channel = 'email' AND email_verified)) AS other_expires
       FROM outreach_queue WHERE state = 'queued' GROUP BY athlete_id`, [require('./outreachQueue').EXPIRE_AFTER_DAYS || 7])).rows
    .map((r) => [r.athlete_id, { verified: r.verified, other: r.other, otherExpires: r.other_expires }]));
  const short = [];
  let athletes = 0, skippedByDesign = 0;
  for (const run of runs) {
    if (/^skipped: /.test(String(run.note || ''))) { skippedByDesign++; continue; }
    for (const d of (Array.isArray(run.details) ? run.details : [])) {
      if (!d || !d.athleteId) continue;
      athletes++;
      const h = held.get(d.athleteId) || { verified: 0, other: 0 };
      if (h.verified >= FIVE) continue;
      short.push({ agent: run.agent_name || run.agent_id, athlete: d.athleteName || d.athleteId, athleteId: d.athleteId,
        verified: h.verified, placedTonight: d.filled || 0, reason: reasonFor(d, h, run) });
    }
  }
  short.sort((a, b) => a.verified - b.verified || String(a.agent).localeCompare(String(b.agent)));
  return { runDate, athletes, short, skippedByDesign, fiveOn: process.env.EMAIL_FIVE_ON === '1' };
}

function render(r) {
  const subject = r.short.length
    ? `NILDash: ${r.short.length} athlete${r.short.length === 1 ? '' : 's'} under ${FIVE} verified emails (${r.runDate})`
    : `NILDash: every athlete has ${FIVE} verified emails (${r.runDate})`;
  const L = [`${r.short.length} of ${r.athletes} athlete(s) hold fewer than ${FIVE} email cards with a verified address for a named person, as of 5:30am Central.`, ''];
  let agent = null;
  for (const s of r.short) {
    if (s.agent !== agent) { L.push(String(s.agent)); agent = s.agent; }
    L.push(`  ${s.athlete}: ${s.verified} of ${FIVE} (${s.placedTonight} placed tonight). ${s.reason}`);
  }
  if (r.skippedByDesign) L.push('', `${r.skippedByDesign} agent(s) were not filled by design (not signed in recently).`);
  L.push('', 'Details: /api/admin/scripts/email-finder-report?text=1&days=1');
  const text = L.join('\n');
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return { subject, text, html: `<pre style="font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${esc(text)}</pre>` };
}

async function _send(msg) {
  if (!TO()) throw new Error('no alert destination: neither ADMIN_ALERT_EMAIL nor ADMIN_EMAIL is set');
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('./resendChecked').makeResend(process.env.RESEND_API_KEY);
  const r = await resend.emails.send({ from: FROM(), to: TO(), subject: msg.subject, text: msg.text, html: msg.html });
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}

// One tick. opts: { now, send (tests), force (ignore the switch and the time) }
async function runOnce(pool, opts = {}) {
  if (!opts.force && process.env.EMAIL_FIVE_ON !== '1') return { skipped: 'EMAIL_FIVE_ON is not set' };
  if (!opts.force && !windowOpen(opts.now)) return { skipped: 'before 5:30am Central' };
  await ensureTable(pool);
  const report = await collect(pool, opts);
  const day = report.runDate;
  const prior = (await pool.query(`SELECT status, attempts FROM short_five_alerts WHERE alert_date = $1`, [day])).rows[0];
  if (prior && ['sent', 'clear', 'sending'].includes(prior.status)) return { skipped: 'already ' + prior.status, report };
  if (prior && prior.status === 'failed' && prior.attempts >= MAX_ATTEMPTS) return { skipped: 'gave up', report };
  const msg = render(report);
  if (!report.short.length) {
    await pool.query(`INSERT INTO short_five_alerts (alert_date, status, athletes, subject) VALUES ($1, 'clear', 0, $2)
      ON CONFLICT (alert_date) DO NOTHING`, [day, msg.subject]);
    return { status: 'clear', report };
  }
  const claim = await pool.query(
    `INSERT INTO short_five_alerts (alert_date, status, athletes, subject, body, attempts) VALUES ($1, 'sending', $2, $3, $4, 1)
     ON CONFLICT (alert_date) DO UPDATE SET status = 'sending', attempts = short_five_alerts.attempts + 1,
       subject = EXCLUDED.subject, body = EXCLUDED.body, athletes = EXCLUDED.athletes
     WHERE short_five_alerts.status = 'failed' RETURNING attempts`, [day, report.short.length, msg.subject, msg.text]);
  if (!claim.rowCount) return { skipped: 'claimed elsewhere', report };
  try {
    await (opts.send || _send)(msg);
    await pool.query(`UPDATE short_five_alerts SET status = 'sent', sent_at = NOW(), error = NULL WHERE alert_date = $1`, [day]);
    return { status: 'sent', report, msg };
  } catch (e) {
    console.error(`[short-of-five] SEND FAILED: ${e.message}`);
    await pool.query(`UPDATE short_five_alerts SET status = 'failed', error = $2 WHERE alert_date = $1`, [day, String(e.message).slice(0, 500)]);
    return { status: 'failed', error: e.message, report, msg };
  }
}

module.exports = { runOnce, collect, render, reasonFor, windowOpen, centralMinutes, ensureTable, FIVE };
