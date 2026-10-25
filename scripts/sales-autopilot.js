'use strict';
// ── THE SALES AUTOPILOT, IN NUMBERS (services/salesAutopilot) ───────────────
//
//   /api/admin/scripts/sales-autopilot?text=1                 the last 7 days
//   /api/admin/scripts/sales-autopilot?text=1&days=30
//   /api/admin/scripts/sales-autopilot?text=1&from=2026-10-01&to=2026-10-25
//     sent (first emails and follow-ups), replies by tag, interested, trials
//     started, bounces, demos booked, drafted, and the warm-up level; the
//     switches, the mailbox, and whether it is stopped.
//   /api/admin/scripts/sales-autopilot?text=1&dry=1
//     the night's find-and-draft, now: SALES_DAILY_NEW prospects (10 agencies,
//     10 schools) with verified addresses, each email in full, and what would
//     send on day 1. NOTHING IS SENT, whatever the switches say.
//   /api/admin/scripts/sales-autopilot?text=1&plan=1     the next sending day's plan
//   /api/admin/scripts/sales-autopilot?text=1&resume=1   turn it back on after a stop
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

function arg(argv, name) { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; }
const pad = (s, n) => String(s).padEnd(n);
const onOff = (b) => (b ? 'on' : 'off');

async function header(pool, SA) {
  const MB = require(ROOT + 'server/services/salesMailbox');
  const mb = await MB.account(pool);
  const st = await SA.getState(pool);
  const today = SA.centralDay().date;
  const w = await SA.warmup(pool, today);
  const waiting = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE e.step = 1 AND e.state = 'draft' AND p.status = 'drafted')::int AS drafts,
            COUNT(*) FILTER (WHERE e.state = 'scheduled')::int AS scheduled,
            COUNT(*) FILTER (WHERE e.state IN ('failed', 'unknown'))::int AS failed
       FROM sales_emails e JOIN sales_prospects p ON p.id = e.prospect_id`)).rows[0];
  const L = [];
  L.push(`Switches: SALES_AUTOPILOT_ON ${onOff(SA.ON())}, SALES_AUTOSEND_ON ${onOff(SA.SEND_ON())}, SALES_TRIAL_ON ${onOff(SA.TRIAL_ON())}. `
    + `SALES_DAILY_NEW ${SA.DAILY_NEW()}, SALES_DAILY_CAP ${SA.DAILY_CAP()}, SALES_HUNTER_MAX ${SA.HUNTER_MAX()}, SALES_MAX_QUEUE ${SA.MAX_QUEUE()}.`);
  L.push(mb.ok
    ? `Mailbox: ${mb.address} connected. Send ${mb.canSend ? 'yes' : 'NO'}, read ${mb.canRead ? 'yes' : 'NO'}, move to "${MB.FOLDER}" ${mb.canMove ? 'yes' : 'NO (reconnect at /admin/sales/connect-mailbox to allow it)'}, calendar ${mb.canCalendar ? 'yes' : 'no'}.`
    : `Mailbox: NOT READY. ${mb.why}`);
  L.push(st.paused ? `STOPPED since ${new Date(st.paused_at).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${st.paused_reason}. Resume: /api/admin/scripts/sales-autopilot?resume=1&text=1`
    : 'Running: not stopped.');
  L.push(`Warm-up today (${today}): day ${w.day}, up to ${w.cap} sends (cap ${w.dailyCap}). Waiting: ${waiting.drafts} first email(s) drafted, ${waiting.scheduled} scheduled${waiting.failed ? `, ${waiting.failed} failed or interrupted` : ''}.`);
  L.push(`The link in every email: ${SA.link()}`);
  return L;
}

function numbersLines(n) {
  return [
    `  drafted ${n.drafted} (${n.draftedAgencies} agencies, ${n.draftedSchools} schools)`,
    `  sent ${n.sent} (${n.firstEmails} first emails, ${n.followups} follow-ups)`,
    `  replies ${n.replies}: interested ${n.interested}, not now ${n.not_now}, wrong person ${n.wrong_person}, unsubscribe ${n.unsubscribes}`,
    `  bounces ${n.bounces}${n.sent ? ` (${(100 * n.bounces / n.sent).toFixed(1)}% of sends)` : ''}, spam complaints ${n.complaints}, demos booked ${n.booked}, trials started ${n.trials}`,
  ];
}

async function reportText(pool, { from, to }) {
  const SA = require(ROOT + 'server/services/salesAutopilot');
  await SA.ensureTables(pool);
  const L = [`SALES AUTOPILOT, ${from} to ${to} (Central dates)`, ''];
  L.push(...await header(pool, SA), '');
  L.push('TOTALS', ...numbersLines(await SA.numbers(pool, from, to)), '');
  L.push('BY DAY');
  L.push(`  ${pad('date', 11)}${pad('drafted', 9)}${pad('sent', 6)}${pad('f-ups', 7)}${pad('replies', 9)}${pad('intrst', 8)}${pad('bounce', 8)}${pad('booked', 8)}trials`);
  for (let d = from; d <= to; d = SA.addDays(d, 1)) {
    const n = await SA.numbers(pool, d, d);
    L.push(`  ${pad(d, 11)}${pad(n.drafted, 9)}${pad(n.firstEmails, 6)}${pad(n.followups, 7)}${pad(n.replies, 9)}${pad(n.interested, 8)}${pad(n.bounces, 8)}${pad(n.booked, 8)}${n.trials}`);
  }
  const runs = (await pool.query(`SELECT run_date, trigger, drafted, credits, note FROM sales_runs WHERE run_date BETWEEN $1::date AND $2::date ORDER BY id DESC LIMIT 10`, [from, to])).rows;
  if (runs.length) {
    L.push('', 'RUNS (newest first)');
    for (const r of runs) L.push(`  ${String(r.run_date instanceof Date ? r.run_date.toISOString() : r.run_date).slice(0, 10)} ${r.trigger}: ${r.note || '(running)'}`);
  }
  const stops = (await pool.query(
    `SELECT p.person, p.org, p.email, p.status, p.tag, p.stop_reason FROM sales_prospects p
      WHERE p.status NOT IN ('drafted', 'active') AND (p.updated_at AT TIME ZONE 'America/Chicago')::date BETWEEN $1::date AND $2::date
      ORDER BY p.updated_at DESC LIMIT 40`, [from, to])).rows;
  if (stops.length) {
    L.push('', 'SEQUENCES THAT ENDED');
    for (const s of stops) L.push(`  ${s.person}${s.org ? `, ${s.org}` : ''} <${s.email}>: ${s.status}${s.tag ? ` (${s.tag})` : ''}. ${s.stop_reason || ''}`);
  }
  return L.join('\n');
}

// The day-1 plan: the first weekday the autopilot could send, from 7:00
// Central, with nothing written.
function dayOne(SA, now) {
  const c = SA.centralDay(now);
  const weekday = !['Sat', 'Sun'].includes(c.weekday);
  const date = weekday && c.minutes < SA.PLAN_AT ? c.date : SA.nextWeekday(c.date);
  return { date, now: SA.zonedTime(date, SA.PLAN_AT, SA.CENTRAL) };
}
function planLines(plan) {
  const L = [];
  if (!plan.ok) return [`  ${plan.why}`];
  const firsts = plan.planned.filter((p) => p.step === 1).length;
  L.push(`Warm-up day ${plan.warmup.day}: up to ${plan.warmup.cap} sends. ${plan.planned.length} planned (${firsts} first email${firsts === 1 ? '' : 's'}, ${plan.planned.length - firsts} follow-up${plan.planned.length - firsts === 1 ? '' : 's'}); ${plan.waiting} first email(s) wait for later days.`);
  for (const p of plan.planned) {
    L.push(`  ${p.central} Central (${p.local} theirs, ${p.tz})  ${p.person} <${p.email}>  ${p.step === 1 ? 'first email' : `follow-up ${p.step - 1}`}  "${p.subject}"`);
  }
  for (const n of (plan.notToday || [])) L.push(`  not today: ${n.person} <${n.email}>: ${n.why}`);
  return L;
}

async function dryRunText(pool, { deps, now } = {}) {
  const SA = require(ROOT + 'server/services/salesAutopilot');
  await SA.ensureTables(pool);
  const r = await SA.runOnce(pool, { trigger: 'dry-run', now, deps: deps || {} });
  const L = [`SALES AUTOPILOT DRY RUN (${SA.centralDay(now).date}). Nothing was sent.`, ''];
  if (!r.ok) { L.push('The run failed: ' + (r.error || 'unknown')); return { text: L.join('\n'), run: r }; }
  L.push(r.note, '');
  for (const lane of ['agency', 'school']) {
    const l = r.lanes[lane];
    const sk = Object.entries(l.skipped).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join('; ');
    L.push(`${lane === 'agency' ? 'Agencies' : 'Schools'}: ${l.drafted.length} of ${l.want} drafted, ${l.searches} web search(es).${sk ? ' Not drafted: ' + sk + '.' : ''}`);
  }
  L.push('', `DRAFTED (${r.prospects.length})`);
  r.prospects.forEach((p, i) => {
    L.push('', `${i + 1}. ${p.person}${p.title ? `, ${p.title}` : ''}, ${p.org || ''} (${p.lane}${p.state ? ', ' + p.state : ''})`);
    L.push(`   ${p.email}  Hunter: ${p.verify.status || p.verify.result}, verified ${String(p.verify.at).slice(0, 16).replace('T', ' ')} UTC (found by ${p.foundBy})`);
    L.push(`   Subject: ${p.subject}   [written by: ${p.writtenBy}]`);
    for (const line of String(p.body).split('\n')) L.push('   | ' + line);
  });
  const d1 = dayOne(SA, now);
  const plan = await SA.planDay(pool, { now: d1.now, save: false, date: d1.date });
  L.push('', `DAY 1: WHAT WILL SEND ON ${d1.date} ONCE SALES_AUTOSEND_ON IS ON`, ...planLines(plan));
  L.push('', 'Each email goes out as plain text from ' + require(ROOT + 'server/services/salesMailbox').fromAddress()
    + ', with the CAN-SPAM footer (unsubscribe link and mailing address) under it.');
  return { text: L.join('\n'), run: r, plan };
}

async function main() {
  const argv = process.argv.slice(2);
  const store = require(ROOT + 'server/store.js');
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const pool = store.pool;
  const SA = require(ROOT + 'server/services/salesAutopilot');
  await SA.ensureTables(pool);
  if (argv.includes('--resume')) {
    await SA.resume(pool);
    console.log('Resumed: the sales autopilot is no longer stopped.' + (SA.SEND_ON() ? ' It sends from the next planned time.' : ' SALES_AUTOSEND_ON is off, so it still sends nothing.'));
    console.log('');
  }
  if (argv.includes('--dry')) {
    console.log((await dryRunText(pool)).text);
  } else if (argv.includes('--plan')) {
    const d1 = dayOne(SA);
    const plan = await SA.planDay(pool, { now: d1.now, save: false, date: d1.date });
    console.log([`THE PLAN FOR ${d1.date} (a preview; nothing is written)`, ...await header(pool, SA), '', ...planLines(plan)].join('\n'));
  } else {
    const today = SA.centralDay().date;
    const days = Math.max(1, Math.min(366, parseInt(arg(argv, '--days'), 10) || 7));
    const to = /^\d{4}-\d{2}-\d{2}$/.test(arg(argv, '--to') || '') ? arg(argv, '--to') : today;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(arg(argv, '--from') || '') ? arg(argv, '--from') : SA.addDays(to, -(days - 1));
    console.log(await reportText(pool, { from, to }));
  }
  try { await pool.end(); } catch (_) {}
  process.exit(0);
}
if (require.main === module) main().catch((e) => { console.error('sales-autopilot: FAILED', e.message); process.exit(1); });

module.exports = { reportText, dryRunText, dayOne, planLines, numbersLines };
