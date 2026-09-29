'use strict';
// ── THE MORNING ALERT ───────────────────────────────────────────────────────
//
// Every agent got nothing for three nights and it was found by accident, from
// a database query. The Places market build had been failing since Google
// disabled the legacy API, and the only trace was a console.warn nobody reads.
//
// So once each morning, after the nightly window closes, this checks last
// night and the last day of market builds, and emails the admin when:
//
//   an agent with athletes got no cards   the nightly run filled nothing while
//                                         at least one of their athletes had an
//                                         open slot, or it stopped early, or it
//                                         never ran for them at all
//   a Places market build failed          any build in the last 24 hours, with
//                                         Google's reason
//
// An agent whose slots are all full, or whom the run skipped by design (not
// signed in for two weeks), is not a problem and is not alerted; the skipped
// ones are counted in the email so the number is still visible.
//
// ONCE A DAY. admin_alerts holds one row per Central date, claimed before the
// send, so a restart or a second instance cannot mail it twice. A failed send
// is retried on the next tick, up to MAX_ATTEMPTS. A morning with nothing wrong
// sends nothing and records 'clear'.

const OQ = require('../jobs/outreachQueue');

const ALERT_FROM_HOUR = OQ.WINDOW_END_HOUR;   // the nightly window has closed
const ALERT_UNTIL_HOUR = 12;                   // still "the same morning"
const MAX_ATTEMPTS = 4;
const FROM = () => process.env.ADMIN_ALERT_FROM || process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>';
const TO = () => process.env.ADMIN_ALERT_EMAIL || process.env.ADMIN_EMAIL || 'johnmarkcompton@gmail.com';

function centralHour(ms) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: OQ.CENTRAL_TZ, hour: '2-digit', hour12: false })
    .format(new Date(ms == null ? Date.now() : ms));
  return Number(h === '24' ? '0' : h);
}
function windowOpen(ms) {
  const h = centralHour(ms);
  return h >= ALERT_FROM_HOUR && h < ALERT_UNTIL_HOUR;
}

// What went wrong for one agent last night, or null. Pure.
function agentProblem({ athletes, run, queueEnabled }) {
  if (!athletes) return null;
  if (!run) return queueEnabled ? { kind: 'no-run', text: 'the nightly run did not run for this agent' } : null;
  const note = String(run.note || '');
  if (/^skipped: /.test(note)) return null;                        // by design (inactive)
  if (run.filled > 0) return null;
  if (!run.finished_at) return { kind: 'unfinished', text: 'the run started and never finished' };
  if (/no agent name on file/i.test(note)) return { kind: 'no-name', text: note };
  if (/stopped early/.test(note)) return { kind: 'crashed', text: note };
  const details = Array.isArray(run.details) ? run.details : [];
  const open = details.filter((d) => d && (d.error || d.open == null || Number(d.open) > 0));
  if (details.length && !open.length) return null;                  // every slot already full
  return { kind: 'zero-cards', text: `no cards for ${athletes} athlete(s)` + (note ? `: ${note}` : ''),
    athletes: open.slice(0, 5).map((d) => `${d.athleteName || d.athleteId}: ${d.error || d.note || d.emptyReason || 'no reason recorded'}`) };
}

async function collect(pool, { now } = {}) {
  const runDate = OQ.today(now);
  const queueEnabled = OQ.ENABLED;
  const agents = (await pool.query(
    `SELECT u.id, u.name, u.email,
            (SELECT COUNT(*)::int FROM athletes a WHERE a.agent_id = u.id) AS athletes
       FROM users u WHERE u.role IN ('agent','admin') AND u.archived IS NOT TRUE
      ORDER BY u.created_at ASC`)).rows;
  const runs = new Map((await pool.query(
    `SELECT agent_id, filled, note, details, finished_at FROM outreach_queue_runs WHERE run_date = $1`, [runDate]))
    .rows.map((r) => [r.agent_id, r]));
  const out = { runDate, queueEnabled, problems: [], skippedByDesign: 0, agentsWithAthletes: 0, cardsLastNight: 0 };
  for (const a of agents) {
    if (!a.athletes) continue;
    out.agentsWithAthletes++;
    const run = runs.get(a.id) || null;
    if (run) out.cardsLastNight += Number(run.filled) || 0;
    if (run && /^skipped: /.test(String(run.note || ''))) out.skippedByDesign++;
    const p = agentProblem({ athletes: a.athletes, run, queueEnabled });
    if (p) out.problems.push({ agent: `${a.name || a.email} <${a.email}>`, ...p });
  }
  const b = (await pool.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE NOT ok)::int AS failed,
            COALESCE(SUM(pool_size) FILTER (WHERE ok), 0)::int AS pooled
       FROM places_market_builds WHERE at > NOW() - INTERVAL '24 hours'`)).rows[0];
  const failures = (await pool.query(
    `SELECT query, source, reason, COUNT(*)::int AS n, MAX(at) AS last
       FROM places_market_builds WHERE at > NOW() - INTERVAL '24 hours' AND NOT ok
      GROUP BY query, source, reason ORDER BY n DESC, last DESC LIMIT 12`)).rows;
  out.builds = { total: b.total, failed: b.failed, pooled: b.pooled, failures };
  out.newBusinesses24h = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM market_business_seen WHERE first_seen_at > NOW() - INTERVAL '24 hours'`)).rows[0].n;
  out.problemCount = out.problems.length + (b.failed ? 1 : 0);
  return out;
}

function render(r) {
  const lines = [];
  const bits = [];
  if (r.builds.failed) bits.push(`${r.builds.failed} Places market build(s) failed`);
  if (r.problems.length) bits.push(`${r.problems.length} agent(s) got no cards`);
  const subject = `NILDash alert ${r.runDate}: ${bits.join(', ')}`;
  lines.push(subject, '');
  if (r.builds.failed) {
    lines.push(`PLACES MARKET BUILDS, last 24 hours: ${r.builds.failed} of ${r.builds.total} FAILED.`,
      'A failed build means that market got no Places discovery; scans fell back to web search only.', '');
    for (const f of r.builds.failures) lines.push(`  ${f.n}x  ${f.query}  (${f.source || '?'})  ${f.reason}`);
    lines.push('');
  }
  if (r.problems.length) {
    lines.push(`AGENTS WITH ATHLETES AND NO CARDS LAST NIGHT (${r.runDate}): ${r.problems.length} of ${r.agentsWithAthletes}`, '');
    for (const p of r.problems) {
      lines.push(`  ${p.agent}: ${p.text}`);
      for (const a of p.athletes || []) lines.push(`      ${a}`);
    }
    lines.push('');
  }
  lines.push(`Context: ${r.cardsLastNight} card(s) placed last night across ${r.agentsWithAthletes} agent(s) with athletes`
    + (r.skippedByDesign ? `; ${r.skippedByDesign} skipped by design (not signed in recently)` : '') + '.',
  `New businesses discovered in the last 24 hours: ${r.newBusinesses24h}.`,
  r.queueEnabled ? '' : 'Note: the nightly queue is OFF on this deployment (OUTREACH_QUEUE_ENABLED is not 1).',
  'Details: /api/admin/scripts/nightly-run-report?agent=<email>&text=1');
  const text = lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return { subject, text, html: `<pre style="font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${esc(text)}</pre>` };
}

async function _send(msg) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const r = await resend.emails.send({ from: FROM(), to: TO(), subject: msg.subject, text: msg.text, html: msg.html });
  // Resend reports an API error in the result rather than throwing.
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}

// One tick. Returns what it did. opts: { now, send, force } -- `send` is
// injectable for tests; `force` ignores the time window (the admin preview).
async function runOnce(pool, opts = {}) {
  if (!opts.force && !windowOpen(opts.now)) return { skipped: 'outside the morning window' };
  const report = await collect(pool, opts);
  const day = report.runDate;
  const prior = (await pool.query(`SELECT status, attempts FROM admin_alerts WHERE alert_date = $1`, [day])).rows[0];
  if (prior && (prior.status === 'sent' || prior.status === 'clear' || prior.status === 'sending')) return { skipped: 'already ' + prior.status, report };
  if (prior && prior.status === 'failed' && prior.attempts >= MAX_ATTEMPTS) return { skipped: 'gave up after ' + prior.attempts + ' attempts', report };

  if (!report.problemCount) {
    await pool.query(`INSERT INTO admin_alerts (alert_date, status, problems) VALUES ($1, 'clear', 0)
                      ON CONFLICT (alert_date) DO NOTHING`, [day]);
    console.log(`[morning-alert] ${day}: all clear (${report.cardsLastNight} cards, ${report.builds.total} market builds, 0 failed)`);
    return { status: 'clear', report };
  }

  // CLAIM, then send. A second instance loses the claim and sends nothing.
  const msg = render(report);
  const claim = await pool.query(
    `INSERT INTO admin_alerts (alert_date, status, problems, subject, body, attempts) VALUES ($1, 'sending', $2, $3, $4, 1)
     ON CONFLICT (alert_date) DO UPDATE SET status = 'sending', attempts = admin_alerts.attempts + 1,
       subject = EXCLUDED.subject, body = EXCLUDED.body, problems = EXCLUDED.problems
     WHERE admin_alerts.status = 'failed'
     RETURNING attempts`, [day, report.problemCount, msg.subject, msg.text]);
  if (!claim.rowCount) return { skipped: 'claimed elsewhere', report };
  console.error(`[morning-alert] ${msg.subject}`);
  try {
    await (opts.send || _send)(msg);
    await pool.query(`UPDATE admin_alerts SET status = 'sent', sent_at = NOW(), error = NULL WHERE alert_date = $1`, [day]);
    return { status: 'sent', report, msg };
  } catch (e) {
    console.error(`[morning-alert] SEND FAILED (attempt ${claim.rows[0].attempts} of ${MAX_ATTEMPTS}): ${e.message}`);
    await pool.query(`UPDATE admin_alerts SET status = 'failed', error = $2 WHERE alert_date = $1`, [day, String(e.message).slice(0, 500)]);
    return { status: 'failed', error: e.message, report, msg };
  }
}

module.exports = { runOnce, collect, render, agentProblem, windowOpen, centralHour, MAX_ATTEMPTS, ALERT_FROM_HOUR, ALERT_UNTIL_HOUR };
