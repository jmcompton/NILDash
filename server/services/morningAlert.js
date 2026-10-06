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
// is retried on the next tick, up to MAX_ATTEMPTS.
//
// A MORNING WITH NOTHING WRONG STILL SENDS ONE LINE, the all-clear. Silence
// looked identical to healthy for three days; with a daily all-clear, a missing
// email means the alert itself is broken, and that is a thing you can notice.

const OQ = require('../jobs/outreachQueue');

const ALERT_FROM_HOUR = OQ.WINDOW_END_HOUR;   // the nightly window has closed
const ALERT_UNTIL_HOUR = 12;                   // still "the same morning"
const MAX_ATTEMPTS = 4;
// A DATE column comes back from pg as a Date at LOCAL midnight; String() of it
// is "Wed Apr 09 ..." and toISOString() can shift it a day. Read the parts.
const ymd = (v) => {
  if (!(v instanceof Date)) return String(v == null ? '' : v).slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
};
const STATUS_URL = () => String(process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, '') + '/admin/status';
const FROM = () => process.env.ADMIN_ALERT_FROM || process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>';
// No hard-coded fallback: an alert sent to an address nobody configured is
// worse than none. Unset means the send fails loudly and the preflight says so.
const TO = () => process.env.ADMIN_ALERT_EMAIL || process.env.ADMIN_EMAIL || '';

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
  const out = { runDate, queueEnabled, problems: [], skippedByDesign: 0, agentsWithAthletes: 0, cardsLastNight: 0,
    floor: { athletes: 0, hit: 0, short: [] } };
  for (const a of agents) {
    if (!a.athletes) continue;
    out.agentsWithAthletes++;
    const run = runs.get(a.id) || null;
    if (run) out.cardsLastNight += Number(run.filled) || 0;
    if (run && /^skipped: /.test(String(run.note || ''))) out.skippedByDesign++;
    const p = agentProblem({ athletes: a.athletes, run, queueEnabled });
    if (p) out.problems.push({ agent: `${a.name || a.email} <${a.email}>`, ...p });
    // ── FIVE EVERY MORNING (the loop's numbers, details[].loop) ─────────────
    for (const d of (run && Array.isArray(run.details) ? run.details : [])) {
      if (!d || !d.loop) continue;
      out.floor.athletes++;
      if (d.loop.held >= d.loop.floor) { out.floor.hit++; continue; }
      out.floor.short.push({ agent: a.name || a.email, athlete: d.athleteName || d.athleteId, held: d.loop.held, floor: d.loop.floor,
        candidates: d.loop.candidates, stop: d.loop.stop, rungs: d.loop.rungs || [] });
    }
  }
  out.floor.short.sort((x, y) => x.held - y.held);
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
  // ── THE REST OF WHAT HAS TO WORK OVERNIGHT ────────────────────────────────
  // The first version only looked at cards and market builds, so a morning
  // where every digest failed and every approved email bounced still read
  // "all clear". Each of these is read, and each can make the morning not clear.
  const q = async (sql, params, fallback) => {
    try { return (await pool.query(sql, params)).rows; }
    catch (e) { out.readErrors = (out.readErrors || []).concat(e.message); return fallback; }
  };
  // Digests for last night: failed, held by the allowlist, or stuck claimed.
  const dg = (await q(`SELECT status, COUNT(*)::int AS n, MIN(error) AS error FROM nightly_digest_sends
      WHERE run_date = $1 GROUP BY status`, [runDate], []));
  const dcount = (st) => ((dg.find((x) => x.status === st) || {}).n || 0);
  const stuck = ((await q(`SELECT COUNT(*)::int AS n FROM nightly_digest_sends WHERE run_date = $1 AND status = 'claimed'
      AND created_at < NOW() - INTERVAL '1 hour'`, [runDate], [{ n: 0 }]))[0] || {}).n || 0;
  out.digests = { sent: dcount('sent'), failed: dcount('failed'), held: dcount('held'), stuck,
    failReason: (dg.find((x) => x.status === 'failed') || {}).error || null };
  // Approved emails more than two hours past their send time, and why.
  const ov = await q(`SELECT COALESCE(send_hold_reason, send_error, 'no reason recorded') AS why, COUNT(*)::int AS n
      FROM outreach_logs WHERE status = 'approved' AND sent_at IS NULL
        AND scheduled_send_at IS NOT NULL AND scheduled_send_at < NOW() - INTERVAL '2 hours'
        -- A STOPPED ROW IS NOT LATE, IT IS DEAD: it will never send. It is
        -- reported once below, the morning after it stopped, and not again
        -- every morning forever (the 40 rows of 2026-09-23 were).
        AND cadence_stopped_at IS NULL
      GROUP BY 1 ORDER BY n DESC LIMIT 6`, [], []);
  out.overdueSends = { total: ov.reduce((t, r) => t + r.n, 0), reasons: ov };
  const st = await q(`SELECT COALESCE(cadence_stop_reason, 'stopped') AS why, COUNT(*)::int AS n
      FROM outreach_logs WHERE status = 'approved' AND sent_at IS NULL
        AND cadence_stopped_at > NOW() - INTERVAL '24 hours'
      GROUP BY 1 ORDER BY n DESC LIMIT 6`, [], []);
  out.stoppedApproved = { total: st.reduce((t, r) => t + r.n, 0), reasons: st };
  // Every one of our failures in the last day, by service (services/ourFault).
  out.faults24h = await q(`SELECT service, SUM(1 + COALESCE(suppressed, 0))::int AS n, MAX(at) AS last,
      (ARRAY_AGG(reason ORDER BY (kind = 'billing') DESC, at DESC))[1] AS reason, BOOL_OR(kind = 'billing') AS billing
      FROM service_faults WHERE at > NOW() - INTERVAL '24 hours' GROUP BY service
     ORDER BY BOOL_OR(kind = 'billing') DESC, BOOL_OR(kind IS NOT NULL) DESC, n DESC LIMIT 20`, [], []);
  // A vendor we have not paid: first in the subject and first in the body.
  out.paymentFailures = (out.faults24h || []).filter((f) => f.billing);
  // Last night's preflight.
  out.preflight = ((await q(`SELECT night, status, failed, alert FROM preflight_runs ORDER BY night DESC LIMIT 1`, [], []))[0]) || null;
  out.preflightFailures = out.preflight && out.preflight.status === 'failed'
    ? await q(`SELECT service, error FROM service_checks WHERE run_id = (SELECT run_id FROM preflight_runs WHERE night = $1) AND NOT ok`, [ymd(out.preflight.night)], [])
    : [];
  // ── ATHLETICS DEPARTMENTS ─────────────────────────────────────────────────
  // A university with teams and inventory for sale should be getting sponsor
  // asks. Two ways it goes quiet: a team scan ran in the last day and wrote no
  // ask, or it has had asks before and none for a week. Every department is
  // listed in the context lines either way, with its last ask, so "no scan is
  // scheduled" is visible rather than silent.
  out.universities = await q(`
    SELECT u.id, u.name,
      (SELECT COUNT(*)::int FROM university_teams t WHERE t.university_id = u.id) AS teams,
      (SELECT COUNT(*)::int FROM university_inventory i WHERE i.university_id = u.id AND i.status = 'available') AS items,
      (SELECT COUNT(*)::int FROM university_drafts d WHERE d.university_id = u.id AND d.created_at > NOW() - INTERVAL '24 hours') AS asks24h,
      (SELECT MAX(d.created_at) FROM university_drafts d WHERE d.university_id = u.id) AS last_ask,
      (SELECT COUNT(*)::int FROM university_research_claims c JOIN university_teams t ON t.id = c.team_id
        WHERE t.university_id = u.id AND c.at > NOW() - INTERVAL '24 hours') AS researched24h
    FROM universities u
    WHERE EXISTS (SELECT 1 FROM university_teams t WHERE t.university_id = u.id)
    ORDER BY u.name`, [], []);
  out.universityProblems = [];
  for (const u of out.universities) {
    if (!u.items) continue;
    if (u.researched24h > 0 && !u.asks24h) {
      out.universityProblems.push({ university: u.name, text: `a team scan ran in the last 24 hours (${u.researched24h} business(es) researched) and wrote no sponsor ask` });
    } else if (u.last_ask && !u.asks24h && (Date.now() - new Date(u.last_ask).getTime()) > 7 * 86400000) {
      out.universityProblems.push({ university: u.name, text: `no sponsor ask for ${Math.floor((Date.now() - new Date(u.last_ask).getTime()) / 86400000)} days (last ${new Date(u.last_ask).toISOString().slice(0, 10)})` });
    }
  }

  // No preflight row for last night is itself a problem: the check that exists
  // to stop a silent night did not run, which is silent.
  out.preflightMissing = (!out.preflight || ymd(out.preflight.night) !== ymd(runDate));

  out.problemCount = out.problems.length + (b.failed ? 1 : 0) + out.floor.short.length
    + (out.preflightMissing && !(out.readErrors || []).length ? 1 : 0)
    + ((out.digests.failed || out.digests.held || out.digests.stuck) ? 1 : 0)
    + (out.overdueSends.total ? 1 : 0)
    + (out.faults24h.length ? 1 : 0)
    + (out.preflight && out.preflight.status === 'failed' ? 1 : 0)
    + out.universityProblems.length
    + (out.readErrors && out.readErrors.length ? 1 : 0);
  return out;
}

function render(r) {
  if (!r.problemCount) {
    const subject = `NILDash all clear ${r.runDate}: ${r.cardsLastNight} card(s) last night, `
      + `${r.builds.total} market build(s) and none failed, ${r.newBusinesses24h} new business(es)`;
    const text = [subject, '',
      (r.floor && r.floor.athletes ? `Five every morning: ${r.floor.hit} of ${r.floor.athletes} athlete(s) reached five.` : ''),
      `${r.agentsWithAthletes} agent(s) with athletes; every one either got cards or had every slot already full`
        + (r.skippedByDesign ? `; ${r.skippedByDesign} skipped by design (not signed in recently)` : '') + '.',
      r.digests ? `Agent digests last night: ${r.digests.sent} sent, none failed or held.` : '',
      `Preflight for ${r.runDate}: every service answered.`,
      ...(r.universities || []).map((u) => `${u.name}: ${u.teams} team(s), ${u.items} item(s) for sale, ${u.asks24h} sponsor ask(s) in 24h, last ask ${u.last_ask ? new Date(u.last_ask).toISOString().slice(0, 10) : 'never'}.`),
      r.queueEnabled ? '' : 'Note: the nightly queue is OFF on this deployment (OUTREACH_QUEUE_ENABLED is not 1).',
      'Status: ' + STATUS_URL(),
      'This email comes every morning. If one does not arrive, the alert itself is broken.',
    ].filter((l, i, a) => l !== undefined && !(l === '' && a[i - 1] === '')).join('\n');
    const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return { subject, text, html: `<pre style="font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${esc(text)}</pre>` };
  }
  const lines = [];
  const bits = [];
  if (r.preflightMissing) bits.push('no preflight ran for last night');
  if (r.preflight && r.preflight.status === 'failed') bits.push(`preflight failed (${(r.preflightFailures || []).map((f) => f.service).join(', ') || r.preflight.failed})`);
  if (r.builds.failed) bits.push(`${r.builds.failed} Places market build(s) failed`);
  if ((r.floor || {}).short && r.floor.short.length) {
    const zero = r.floor.short.filter((x) => !x.held).length;
    bits.push(`${r.floor.short.length} athlete(s) short of five${zero ? ` (${zero} with ZERO)` : ''}`);
  }
  if (r.problems.length) bits.push(`${r.problems.length} agent(s) got no cards`);
  if ((r.universityProblems || []).length) bits.push(`${r.universityProblems.length} athletics department(s) went quiet`);
  if (r.digests && (r.digests.failed || r.digests.stuck)) bits.push(`${r.digests.failed + r.digests.stuck} digest(s) not sent`);
  if (r.digests && r.digests.held) bits.push(`${r.digests.held} digest(s) held by the allowlist`);
  if (r.overdueSends && r.overdueSends.total) bits.push(`${r.overdueSends.total} approved email(s) not sent`);
  if ((r.faults24h || []).length) bits.push(`our failures in ${r.faults24h.length} service(s)`);
  if ((r.paymentFailures || []).length) bits.unshift(`PAYMENT FAILURE: ${r.paymentFailures.map((f) => f.service).join(', ')}`);
  const subject = `NILDash alert ${r.runDate}: ${bits.join(', ')}`;
  lines.push(subject, '');
  if ((r.paymentFailures || []).length) {
    lines.push('*** PAYMENT FAILURE: every call to these fails until billing is fixed ***');
    for (const f of r.paymentFailures) lines.push(`  ${String(f.n).padStart(5)}x  ${f.service}: ${String(f.reason || '').slice(0, 200)}`);
    lines.push('');
  }
  if ((r.floor || {}).short && r.floor.short.length) {
    lines.push(`ATHLETES SHORT OF FIVE (${r.runDate}): ${r.floor.short.length} of ${r.floor.athletes}; ${r.floor.hit} reached five. The bar did not move; what passed shipped.`);
    for (const x of r.floor.short) {
      lines.push(`  ${x.held ? '' : 'EMERGENCY '}${x.athlete} (${x.agent}): ${x.held} of ${x.floor} after ${x.candidates} candidate(s); `
        + `stopped by ${x.stop}; rungs tried: ${x.rungs.join(', ')}`);
    }
    lines.push('');
  }
  if (r.builds.failed) {
    lines.push(`PLACES MARKET BUILDS, last 24 hours: ${r.builds.failed} of ${r.builds.total} FAILED.`,
      'A failed build means that market got no Places discovery; scans fell back to web search only.', '');
    for (const f of r.builds.failures) lines.push(`  ${f.n}x  ${f.query}  (${f.source || '?'})  ${f.reason}`);
    lines.push('');
  }
  if (r.preflightMissing) {
    lines.push(`NO PREFLIGHT RAN for ${r.runDate}` + (r.preflight ? ` (the last one was for ${ymd(r.preflight.night)})` : ' (none has ever run)')
      + '. Nobody checked the outside services before the night started.', '');
  }
  if (r.preflight && r.preflight.status === 'failed') {
    lines.push(`PREFLIGHT for ${ymd(r.preflight.night)} FAILED (alert: ${r.preflight.alert || 'not sent'}):`);
    for (const f of r.preflightFailures || []) lines.push(`  ${f.service}: ${f.error}`);
    lines.push('');
  }
  if ((r.faults24h || []).length) {
    lines.push('OUR FAILURES, last 24 hours (recorded as faults, never as facts about a market):');
    for (const f of r.faults24h) lines.push(`  ${String(f.n).padStart(5)}x  ${f.service}: ${String(f.reason || '').slice(0, 160)}`);
    lines.push('');
  }
  if (r.digests && (r.digests.failed || r.digests.stuck || r.digests.held)) {
    lines.push(`AGENT DIGESTS for ${r.runDate}: ${r.digests.sent} sent, ${r.digests.failed} failed, ${r.digests.stuck} stuck, ${r.digests.held} held by NIGHTLY_DIGEST_ALLOWLIST`
      + (r.digests.failReason ? `. First failure: ${r.digests.failReason}` : ''), '');
  }
  if (r.stoppedApproved && r.stoppedApproved.total) {
    lines.push(`APPROVED EMAILS STOPPED IN THE LAST DAY (they will not send; reported once): ${r.stoppedApproved.total}`);
    for (const x of r.stoppedApproved.reasons) lines.push(`  ${String(x.n).padStart(4)}x  ${String(x.why).slice(0, 160)}`);
  }
  if (r.overdueSends && r.overdueSends.total) {
    lines.push(`APPROVED EMAILS NOT SENT, more than 2 hours late: ${r.overdueSends.total}`);
    for (const x of r.overdueSends.reasons) lines.push(`  ${String(x.n).padStart(4)}x  ${String(x.why).slice(0, 160)}`);
    lines.push('');
  }
  if ((r.universityProblems || []).length) {
    lines.push('ATHLETICS DEPARTMENTS THAT WENT QUIET:');
    for (const u of r.universityProblems) lines.push(`  ${u.university}: ${u.text}`);
    lines.push('');
  }
  if (r.readErrors && r.readErrors.length) lines.push('Some of this could not be read: ' + r.readErrors.join('; '), '');
  if (r.problems.length) {
    lines.push(`AGENTS WITH ATHLETES AND NO CARDS LAST NIGHT (${r.runDate}): ${r.problems.length} of ${r.agentsWithAthletes}`, '');
    for (const p of r.problems) {
      lines.push(`  ${p.agent}: ${p.text}`);
      for (const a of p.athletes || []) lines.push(`      ${a}`);
    }
    lines.push('');
  }
  for (const u of r.universities || []) {
    lines.push(`${u.name}: ${u.teams} team(s), ${u.items} item(s) for sale, ${u.asks24h} sponsor ask(s) in 24h, last ask ${u.last_ask ? new Date(u.last_ask).toISOString().slice(0, 10) : 'never'}.`);
  }
  lines.push(`Context: ${r.cardsLastNight} card(s) placed last night across ${r.agentsWithAthletes} agent(s) with athletes`
    + (r.skippedByDesign ? `; ${r.skippedByDesign} skipped by design (not signed in recently)` : '') + '.',
  `New businesses discovered in the last 24 hours: ${r.newBusinesses24h}.`,
  r.queueEnabled ? '' : 'Note: the nightly queue is OFF on this deployment (OUTREACH_QUEUE_ENABLED is not 1).',
  'Status: ' + STATUS_URL(),
  'Details: /api/admin/scripts/nightly-run-report?agent=<email>&text=1');
  const text = lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return { subject, text, html: `<pre style="font:13px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${esc(text)}</pre>` };
}

async function _send(msg) {
  if (!TO()) throw new Error('no alert destination: neither ADMIN_ALERT_EMAIL nor ADMIN_EMAIL is set');
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('./resendChecked').makeResend(process.env.RESEND_API_KEY);
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

  // CLAIM, then send. A second instance loses the claim and sends nothing.
  const msg = render(report);
  const claim = await pool.query(
    `INSERT INTO admin_alerts (alert_date, status, problems, subject, body, attempts) VALUES ($1, 'sending', $2, $3, $4, 1)
     ON CONFLICT (alert_date) DO UPDATE SET status = 'sending', attempts = admin_alerts.attempts + 1,
       subject = EXCLUDED.subject, body = EXCLUDED.body, problems = EXCLUDED.problems
     WHERE admin_alerts.status = 'failed'
     RETURNING attempts`, [day, report.problemCount, msg.subject, msg.text]);
  if (!claim.rowCount) return { skipped: 'claimed elsewhere', report };
  (report.problemCount ? console.error : console.log)(`[morning-alert] ${msg.subject}`);
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
