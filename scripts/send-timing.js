'use strict';
// ── ONE AGENT'S SENDS: HOW LONG EACH TOOK, AND ANY BUSINESS PITCHED TWICE ───
//
// Read-only. For every email the agent approved or sent in the window:
//   which path it took   approved (Home / digest Approve: the release queue
//                        sends it) or by hand (Send in the outreach editor:
//                        the request waits for the mail provider)
//   the clock            the approve click (pitch_actions), approved_at, the
//                        queue's claim, sent_at, and the gaps between them
//   what went wrong      send failures, hold reasons, send errors
// Then the release queue's own faults in the window, and every business
// (address or name) that received more than one email from this account,
// with whether the subject was the same: the double sends.
//
//   node scripts/send-timing.js --agent jdubose@truepathmgmt.org [--days 7]
//   /api/admin/scripts/send-timing?agent=jdubose@truepathmgmt.org&days=7&text=1
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const t = (v) => (v ? new Date(v).toISOString().replace('T', ' ').slice(5, 19) : '-');
const secs = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 1000) : null);
const dur = (s) => (s === null ? '-' : s < 120 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const who = String(arg('agent', '') || '').trim();
  const days = Math.max(1, Math.min(60, parseInt(arg('days', '7'), 10) || 7));
  if (!who) { console.log('--agent <email or id> is required'); return; }
  const agent = (await P.query(`SELECT id, name, email FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`, [who])).rows[0];
  if (!agent) { console.log(`No user "${who}".`); return; }
  console.log(`SEND TIMING  ${agent.name} <${agent.email}>  last ${days} day(s)  (times UTC)  now ${t(new Date())}\n`);

  const rows = (await P.query(`
    SELECT l.id, l.brand_name, l.subject, l.status, l.sent_to_email, l.touch_no, l.created_at, l.approved_at,
           l.scheduled_send_at, l.send_claimed_at, l.sent_at, l.send_failures, l.send_attempts, l.send_error,
           l.send_hold_reason, l.cadence_stopped_at, l.cadence_stop_reason, l.athlete_id,
           a.data->>'name' AS athlete, a.data->>'sport' AS sport,
           (SELECT MIN(pa.created_at) FROM pitch_actions pa WHERE pa.pitch_id = l.id AND pa.action = 'approve') AS clicked_at,
           (SELECT string_agg(DISTINCT pa.source, ',') FROM pitch_actions pa WHERE pa.pitch_id = l.id AND pa.action = 'approve') AS click_source,
           (SELECT COUNT(*)::int FROM pitch_actions pa WHERE pa.pitch_id = l.id AND pa.action = 'approve') AS approve_clicks
      FROM outreach_logs l LEFT JOIN athletes a ON a.id = l.athlete_id
     WHERE l.agent_id = $1
       AND GREATEST(l.approved_at, l.sent_at, l.send_claimed_at, l.cadence_stopped_at) > NOW() - ($2 || ' days')::interval
     ORDER BY COALESCE(l.sent_at, l.approved_at) DESC`, [agent.id, String(days)])).rows;

  console.log(`1. EVERY EMAIL APPROVED OR SENT (${rows.length})`);
  console.log('   path: APPROVED = Approve on Home or the digest (the queue sends it); BY HAND = Send in the outreach editor (the request waits for the provider)');
  for (const r of rows) {
    const p = r.approved_at ? 'APPROVED' : (r.sent_at ? 'BY HAND' : '?');
    console.log(`\n   ${r.athlete || r.athlete_id} (${r.sport || '?'})  ->  ${r.brand_name}  <${r.sent_to_email || 'no address'}>  [${r.status}${r.touch_no > 1 ? `, touch ${r.touch_no}` : ''}]  ${p}`);
    console.log(`     subject   ${r.subject || ''}`);
    console.log(`     clicked ${t(r.clicked_at)}${r.click_source ? ` (${r.click_source}${r.approve_clicks > 1 ? `, ${r.approve_clicks} approve clicks logged` : ''})` : ''}  approved ${t(r.approved_at)}  claimed ${t(r.send_claimed_at)}  sent ${t(r.sent_at)}`);
    console.log(`     approved->sent ${dur(secs(r.approved_at, r.sent_at))}   claimed->sent ${dur(secs(r.send_claimed_at, r.sent_at))}`
      + (r.send_failures ? `   FAILURES ${r.send_failures}` : '') + (r.send_attempts ? `   attempts ${r.send_attempts}` : ''));
    if (r.send_error) console.log(`     send error: ${String(r.send_error).slice(0, 300)}`);
    if (r.send_hold_reason) console.log(`     HELD: ${r.send_hold_reason}`);
    if (r.cadence_stopped_at) console.log(`     stopped ${t(r.cadence_stopped_at)}: ${r.cadence_stop_reason || ''}`);
  }

  // ── THE REQUESTS THEMSELVES (services/sendTimings, from the deploy that
  // added it): how long Approve, Send and the slow Home reloads took before
  // they answered, step by step.
  const timings = (await P.query(`
    SELECT at, route, ms, steps, status, note FROM send_request_timings
     WHERE agent_id = $1 AND at > NOW() - ($2 || ' days')::interval ORDER BY at DESC LIMIT 60`,
    [agent.id, String(days)]).catch(() => ({ rows: null }))).rows;
  if (timings === null) console.log('1b. REQUEST TIMINGS: not recorded yet (the table arrives with the deploy that measures them)\n');
  else {
    const byRoute = {};
    for (const r of timings) (byRoute[r.route] = byRoute[r.route] || []).push(r.ms);
    console.log(`1b. REQUEST TIMINGS (${timings.length})  ` + Object.entries(byRoute).map(([k, v]) => {
      const sorted = v.slice().sort((a, b) => a - b);
      return `${k}: n=${v.length} median ${sorted[Math.floor(sorted.length / 2)]}ms max ${sorted[sorted.length - 1]}ms`;
    }).join('   '));
    for (const r of timings.slice(0, 25)) {
      console.log(`   ${t(r.at)}  ${r.route.padEnd(15)} ${String(r.ms).padStart(6)}ms  ${r.status}  ${Object.entries(r.steps || {}).map(([k, v]) => `${k}=${v}`).join(' ')}${r.note ? '  (' + r.note + ')' : ''}`);
    }
    console.log('');
  }

  // The release queue's own faults while this agent had mail waiting.
  const faults = (await P.query(`
    SELECT at, service, reason, context FROM service_faults
     WHERE at > NOW() - ($1 || ' days')::interval
       AND (service IN ('release-queue', 'send') OR context ILIKE '%closer%' OR context ILIKE '%' || $2 || '%')
     ORDER BY at DESC LIMIT 40`, [String(days), agent.id]).catch(() => ({ rows: [] }))).rows;
  console.log(`\n2. RELEASE QUEUE AND SEND FAULTS IN THE WINDOW (${faults.length})`);
  for (const f of faults) console.log(`   ${t(f.at)}  ${f.service}  ${String(f.reason).slice(0, 200)}  [${f.context || ''}]`);

  // Every email this account put on the wire, from both ledgers: outreach_logs
  // and email_sends (which also holds manual sends from the inbox).
  const sends = (await P.query(`
    SELECT 'log' AS src, l.id AS ref, LOWER(TRIM(l.sent_to_email)) AS email, l.brand_name, l.subject, l.sent_at,
           l.athlete_id, a.data->>'name' AS athlete
      FROM outreach_logs l LEFT JOIN athletes a ON a.id = l.athlete_id
     WHERE l.agent_id = $1 AND l.sent_at > NOW() - ($2 || ' days')::interval
    UNION ALL
    SELECT 'ledger', s.ref_id, s.email, NULL, s.subject, s.sent_at, NULL, NULL
      FROM email_sends s
     WHERE s.agent_id = $1 AND s.sent_at > NOW() - ($2 || ' days')::interval
       AND NOT EXISTS (SELECT 1 FROM outreach_logs l WHERE l.id = s.ref_id)
     ORDER BY sent_at`, [agent.id, String(days)]).catch(() => ({ rows: [] }))).rows;
  const ledgerByRef = (await P.query(`
    SELECT ref_id, COUNT(*)::int n, array_agg(sent_at ORDER BY sent_at) ats FROM email_sends
     WHERE agent_id = $1 AND sent_at > NOW() - ($2 || ' days')::interval AND ref_id IS NOT NULL
     GROUP BY ref_id HAVING COUNT(*) > 1`, [agent.id, String(days)]).catch(() => ({ rows: [] }))).rows;

  console.log(`\n3. DOUBLE SENDS  (${sends.length} email(s) on the wire from this account in the window)`);
  // a. One draft recorded as sent more than once: the same email, twice.
  console.log(`   a. the same draft sent more than once (email_sends rows per draft): ${ledgerByRef.length ? '' : 'none'}`);
  for (const x of ledgerByRef) {
    const l = sends.find((s) => s.ref === x.ref_id) || {};
    console.log(`      ${l.brand_name || x.ref_id} <${l.email || ''}> ${x.n} times: ${x.ats.map(t).join(', ')}`);
  }
  // b. One business, more than one email: by address, then by business name.
  const groups = new Map();
  for (const s of sends) {
    const keys = new Set([s.email ? 'addr:' + s.email : null, s.brand_name ? 'biz:' + norm(s.brand_name) : null].filter(Boolean));
    for (const k of keys) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
  }
  const seen = new Set();
  const dupes = [];
  for (const [k, list] of groups) {
    const ids = list.map((s) => s.src + s.ref + s.sent_at).sort().join('|');
    if (list.length < 2 || seen.has(ids)) continue;
    seen.add(ids);
    dupes.push({ k, list });
  }
  console.log(`   b. one business, more than one email: ${dupes.length ? '' : 'none'}`);
  for (const { k, list } of dupes) {
    const sameSubject = new Set(list.map((s) => norm(s.subject))).size < list.length;
    const sameAthlete = new Set(list.map((s) => s.athlete_id || '')).size < list.length;
    const gap = secs(list[0].sent_at, list[list.length - 1].sent_at);
    const verdict = sameSubject ? 'SAME PITCH TWICE' : sameAthlete ? 'same athlete, different subject' : 'different athletes';
    console.log(`      ${k.replace(/^(addr|biz):/, '')}  ${list.length} emails within ${dur(gap)}  -> ${verdict}`);
    for (const s of list) console.log(`        ${t(s.sent_at)}  ${s.athlete || '-'}  "${s.subject || ''}"  <${s.email || ''}>  [${s.src} ${s.ref || ''}]`);
  }

  // c. Approve clicked more than once on one draft (the click before the
  // freeze, then again): harmless if it sent once, listed so it can be seen.
  const multi = rows.filter((r) => r.approve_clicks > 1);
  console.log(`   c. drafts with more than one approve logged: ${multi.length ? '' : 'none'}`);
  for (const r of multi) console.log(`      ${r.brand_name}  ${r.approve_clicks} approves, sent ${t(r.sent_at)}`);
}

main()
  .catch((e) => { console.error('send-timing FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => { try { await store.pool.end(); } catch (_) {} });
