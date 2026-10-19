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
// recorded 'clear' -- unless, under MARKET_MIX_ON, a social or national seat
// was backfilled from the local lane, which is always said (services/dealMix,
// jobs/outreachQueue backfillMix): which seat, the card that filled it, why.
// Under MARKET_MIX_ON a program card on an official application page holds a
// slot beside the verified emails, as it does in the night, and counts here.

const OQ = require('../jobs/outreachQueue');
// HUNTER_PACE_ON: the email also carries Hunter's line (services/hunterPace),
// what last night cost (services/nightCost), and says so when the night ran
// in cache mode. With it on, the email goes every morning.
const HP = require('./hunterPace');

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
  cache: "cache mode: Hunter's credits for the night were spent, and every business with an address verified in the last 30 days was tried",
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
  // Under EMAIL_FIVE_ON these no longer hold a slot (jobs/outreachQueue
  // openSlotsFor): they are still on the agent's page, but they did not stop
  // the night. Said so, so the line is not read as the reason.
  // THE DEAL MIX: a brand seat moved to the local lane that it could not fill.
  const mix = loop.mix || null;
  if (mix && mix.backfillUnfilled > 0) bits.push(`${mix.backfillUnfilled} social or national seat(s) moved to the local lane, which found no verified named email for them either`);
  else if (mix && Array.isArray(mix.short) && mix.short.length) bits.push(`short in the mix: ${mix.short.join(', ')}`);
  if (h.other > 0) bits.push(`also on the page: ${h.other} earlier DM, call or unverified card${h.other === 1 ? '' : 's'}, which no longer hold a slot`
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
  // MARKET_MIX_ON: an official program card holds a slot too (DM.holdsUnderMix).
  const mixOn = process.env.MARKET_MIX_ON === '1';
  if (mixOn) {
    const DM = require('./dealMix');
    const pr = (await pool.query(`SELECT athlete_id, channel, email_verified, program_url FROM outreach_queue WHERE state = 'queued' AND channel = 'program'`)).rows;
    for (const r of pr) {
      if (!DM.holdsUnderMix(r, { five: true })) continue;
      const h = held.get(r.athlete_id) || { verified: 0, other: 0 };
      h.verified++; h.other = Math.max(0, h.other - 1); h.programs = (h.programs || 0) + 1;
      held.set(r.athlete_id, h);
    }
  }
  const short = [];
  const backfills = [];
  // NIGHTLY_SKIP_ON: each agent with no connected mailbox and each test
  // athlete the night left out, named, so the email says what was skipped.
  const skips = [];
  let athletes = 0, skippedByDesign = 0;
  for (const run of runs) {
    if (/^skipped: /.test(String(run.note || ''))) {
      skippedByDesign++;
      if (/^skipped: no connected mailbox/.test(run.note)) skips.push({ agent: run.agent_name || run.agent_id, athlete: null, why: String(run.note).replace(/^skipped: /, '') });
      continue;
    }
    for (const d of (Array.isArray(run.details) ? run.details : [])) {
      if (!d || !d.athleteId) continue;
      // A test athlete left off the night by design (NIGHTLY_SKIP_ON) is not short.
      if (d.skipped) {
        skippedByDesign++;
        skips.push({ agent: run.agent_name || run.agent_id, athlete: d.athleteName || d.athleteId, why: String(d.note || d.skipped).replace(/^skipped: /, '') });
        continue;
      }
      athletes++;
      const h = held.get(d.athleteId) || { verified: 0, other: 0 };
      for (const b of ((d.loop && d.loop.mix && d.loop.mix.backfilled) || [])) {
        backfills.push({ agent: run.agent_name || run.agent_id, athlete: d.athleteName || d.athleteId, athleteId: d.athleteId,
          tier: d.loop.mix.tier, seat: b.seat, brand: b.brand, contact: b.contact || null, email: b.email || null, why: b.why || null });
      }
      if (h.verified >= FIVE) continue;
      short.push({ agent: run.agent_name || run.agent_id, athlete: d.athleteName || d.athleteId, athleteId: d.athleteId,
        verified: h.verified, placedTonight: d.filled || 0, reason: reasonFor(d, h, run) });
    }
  }
  short.sort((a, b) => a.verified - b.verified || String(a.agent).localeCompare(String(b.agent)));
  backfills.sort((a, b) => String(a.agent).localeCompare(String(b.agent)) || String(a.athlete).localeCompare(String(b.athlete)));
  skips.sort((a, b) => String(a.agent).localeCompare(String(b.agent)) || String(a.athlete || '').localeCompare(String(b.athlete || '')));
  const out = { runDate, athletes, short, backfills, mixOn, skippedByDesign, skips, fiveOn: process.env.EMAIL_FIVE_ON === '1' };
  if (HP.ON()) {
    out.hunter = await HP.morningLines(pool, runDate).catch((e) => ({ lines: [`Hunter: the night's record could not be read (${e.message})`], warn: false }));
    out.cost = await require('./nightCost').forRunDate(pool, runDate).catch((e) => ({ error: e.message }));
    out.cache = cacheModeOf(runs);
  }
  return out;
}

// CACHE MODE (services/hunterPace): which athletes ran in it last night, and
// what it placed. Pure.
function cacheModeOf(runs) {
  const c = { athletes: 0, placed: 0, skipped: 0, why: null, at: null, rows: [] };
  for (const run of runs || []) {
    for (const d of (Array.isArray(run.details) ? run.details : [])) {
      const k = d && d.loop && d.loop.cache;
      if (!k) continue;
      c.athletes++; c.placed += k.placed || 0; c.skipped += k.skipped || 0;
      c.why = c.why || k.why || null;
      if (!c.at || (k.at && k.at < c.at)) c.at = k.at || c.at;
      c.rows.push({ agent: run.agent_name || run.agent_id, athlete: d.athleteName || d.athleteId, placed: k.placed || 0, cachedBusinesses: k.cachedBusinesses || 0 });
    }
  }
  return c.athletes ? c : null;
}

function render(r) {
  const bf = r.backfills || [];
  const bfNote = bf.length ? `, ${bf.length} brand seat${bf.length === 1 ? '' : 's'} backfilled from local` : '';
  const what = r.mixOn ? 'verified emails or official program cards' : 'verified emails';
  const loud = r.hunter && r.hunter.warn ? 'HUNTER LOW. ' : '';
  const cacheNote = r.cache ? ', cache mode' : '';
  const subject = loud + (r.short.length
    ? `NILDash: ${r.short.length} athlete${r.short.length === 1 ? '' : 's'} under ${FIVE} ${what}${bfNote}${cacheNote} (${r.runDate})`
    : `NILDash: every athlete has ${FIVE} ${what}${bfNote}${cacheNote} (${r.runDate})`);
  const L = [];
  // ── HUNTER AND THE NIGHT'S COST FIRST (HUNTER_PACE_ON) ─────────────────
  if (r.hunter) L.push(...r.hunter.lines);
  if (r.cache) {
    L.push(`CACHE MODE last night${r.cache.at ? ` from ${String(r.cache.at).slice(11, 16)} UTC` : ''}: ${r.cache.why || "Hunter's credits were spent"}. `
      + `${r.cache.placed} card${r.cache.placed === 1 ? '' : 's'} placed for ${r.cache.athletes} athlete${r.cache.athletes === 1 ? '' : 's'} from addresses already verified in the last 30 days; `
      + `${r.cache.skipped} business${r.cache.skipped === 1 ? '' : 'es'} skipped with no recently verified address.`);
  }
  if (r.cost) L.push(...(r.cost.error ? [`Last night's cost could not be read: ${r.cost.error}`] : require('./nightCost').render(r.cost)));
  if (L.length) L.push('');
  L.push(`${r.short.length} of ${r.athletes} athlete(s) hold fewer than ${FIVE} ${r.mixOn ? 'email cards with a verified address for a named person or program cards on an official application page' : 'email cards with a verified address for a named person'}, as of 5:30am Central.`, '');
  let agent = null;
  for (const s of r.short) {
    if (s.agent !== agent) { L.push(String(s.agent)); agent = s.agent; }
    L.push(`  ${s.athlete}: ${s.verified} of ${FIVE} (${s.placedTonight} placed tonight). ${s.reason}`);
  }
  // THE DEAL MIX'S BACKFILL: every seat that came to the local lane, and why.
  if (bf.length) {
    L.push('', `SEATS BACKFILLED FROM THE LOCAL LANE (MARKET_MIX_ON): ${bf.length}`);
    let ag = null;
    for (const b of bf) {
      if (b.agent !== ag) { L.push(String(b.agent)); ag = b.agent; }
      L.push(`  ${b.athlete}: the ${b.seat} seat -> ${b.brand}${b.contact ? `, ${b.contact}` : ''}${b.email ? ` <${b.email}>` : ''} (verified email). Why: ${b.why || 'no reason recorded'}`);
    }
  }
  // WHAT WAS SKIPPED (NIGHTLY_SKIP_ON): every one, by name and why.
  const sk = r.skips || [];
  if (sk.length) {
    L.push('', `SKIPPED LAST NIGHT, NO PAID RESEARCH: ${sk.length}`);
    for (const s of sk) L.push(`  ${s.agent}${s.athlete ? ' / ' + s.athlete : ''}: ${s.why}`);
  }
  const other = r.skippedByDesign - sk.length;
  if (other > 0) L.push('', `${other} agent(s) were not filled by design (not signed in recently).`);
  L.push('', 'Details: /api/admin/scripts/email-finder-report?text=1&days=1');
  const text = L.join('\n');
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return { subject, text, html: `<pre style="font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${esc(text)}</pre>` };
}

// An email goes out when an athlete is short, or when a brand seat was
// backfilled from the local lane (MARKET_MIX_ON): that is always said.
// HUNTER_PACE_ON: every morning, for Hunter's line and the night's cost.
// NIGHTLY_SKIP_ON: and whenever something was skipped, which is always said.
function needsEmail(r) { return (r.short || []).length > 0 || (r.backfills || []).length > 0 || !!r.hunter || (r.skips || []).length > 0; }

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
  if (!opts.force && process.env.EMAIL_FIVE_ON !== '1' && !HP.ON()) return { skipped: 'EMAIL_FIVE_ON is not set' };   // nor HUNTER_PACE_ON
  if (!opts.force && !windowOpen(opts.now)) return { skipped: 'before 5:30am Central' };
  await ensureTable(pool);
  const report = await collect(pool, opts);
  const day = report.runDate;
  const prior = (await pool.query(`SELECT status, attempts FROM short_five_alerts WHERE alert_date = $1`, [day])).rows[0];
  if (prior && ['sent', 'clear', 'sending'].includes(prior.status)) return { skipped: 'already ' + prior.status, report };
  if (prior && prior.status === 'failed' && prior.attempts >= MAX_ATTEMPTS) return { skipped: 'gave up', report };
  const msg = render(report);
  if (!needsEmail(report)) {
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

module.exports = { runOnce, collect, render, reasonFor, needsEmail, windowOpen, centralMinutes, ensureTable, cacheModeOf, FIVE };
