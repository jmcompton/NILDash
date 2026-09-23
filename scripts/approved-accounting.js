'use strict';
// ── WHERE DID EVERY APPROVED EMAIL GO? ──────────────────────────────────────
//
// Before the release queue shipped, send-status counted "approved, waiting"
// as status='approved' AND sent_at IS NULL -- including rows whose cadence had
// already been STOPPED (a reply, a bounce, a suppression, a cancelled
// compliance hold). The new send-status leaves stopped rows out of every line,
// and the queue itself stops a draft at send time for a same-subject repeat,
// a suppressed address or a reply. So "41 waiting" before and "12 sent, 3 held,
// 0 waiting" after do not have to add up, and this is the reconciliation: every
// email that was approved and unsent at the cutoff, by business, with what
// became of it.
//
// No code path deletes an outreach_logs row (no cascades; the only DELETE is
// the one-off email-channel backfill, scoped to its own source), so every one
// of them is still in the table and is listed here.
//
// THE CUTOFF is the deploy: the first moment the new queue touched anything
// (a send_hold_at, a send_claimed_at, or a release-queue row in email_sends --
// none of which the old code wrote). Override with --before=<ISO time>.
//
//   node scripts/approved-accounting.js [--before=2026-09-23T15:00:00Z]
//   /api/admin/scripts/approved-accounting?text=1[&before=...]
//
// Read-only.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

const d = (v) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) : '-');
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : null;
};

// What a cadence_stop_reason means, in the user's words. Matched on the exact
// strings the writers use (services/closer, sendRules, suppression, index.js).
function classifyStop(reason) {
  const r = String(reason || '');
  if (/was already sent to/.test(r)) return 'DEDUPED (same subject already sent)';
  if (/replied/.test(r)) return 'STOPPED (they replied)';
  if (/suppress|bounced|deferred|unsubscrib|no address to send to/.test(r)) return 'STOPPED (suppressed / bounced / no address)';
  if (/compliance/.test(r)) return 'STOPPED (compliance hold cancelled)';
  if (/you skipped/.test(r)) return 'SKIPPED';
  if (/retired|slot was taken/.test(r)) return 'RETIRED';
  return 'STOPPED (other)';
}

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;

  let cutoff = arg('before');
  let cutoffWhy = 'given with --before';
  if (!cutoff) {
    const c = (await P.query(`
      SELECT LEAST(
        (SELECT MIN(send_hold_at)    FROM outreach_logs),
        (SELECT MIN(send_claimed_at) FROM outreach_logs),
        (SELECT MIN(sent_at) FROM email_sends WHERE system IN ('closer','follow-up'))) AS t`)).rows[0];
    cutoff = c && c.t ? new Date(c.t).toISOString() : new Date().toISOString();
    cutoffWhy = c && c.t ? 'first thing the release queue did' : 'nothing released yet, so now';
  }
  console.log('APPROVED-EMAIL ACCOUNTING  ' + new Date().toISOString());
  console.log(`cutoff ${d(cutoff)} UTC  (${cutoffWhy})\n`);

  // THE SET: approved before the cutoff and not sent before it. This is what
  // the old send-status called "approved, waiting" at the cutoff.
  const rows = (await P.query(`
    SELECT l.id, l.brand_name, l.status, l.approved_at, l.sent_at, l.sent_to_email, l.subject,
           l.cadence_stopped_at, l.cadence_stop_reason, l.send_hold_reason, l.send_failures, l.send_error,
           a.data->>'name' AS athlete, u.email AS agent,
           (SELECT s.system FROM email_sends s WHERE s.ref_id = l.id ORDER BY s.sent_at DESC LIMIT 1) AS sent_by,
           q.state AS card_state
      FROM outreach_logs l
      LEFT JOIN athletes a ON a.id = l.athlete_id
      LEFT JOIN users u ON u.id = l.agent_id
      LEFT JOIN LATERAL (SELECT state FROM outreach_queue q WHERE q.outreach_log_id = l.id ORDER BY q.id DESC LIMIT 1) q ON TRUE
     WHERE l.approved_at IS NOT NULL AND l.approved_at < $1
       AND (l.sent_at IS NULL OR l.sent_at >= $1)
     ORDER BY l.approved_at`, [cutoff])).rows;

  const out = [];
  for (const r of rows) {
    let outcome, detail = '';
    if (r.sent_at) {
      outcome = r.sent_by === 'manual' ? 'SENT BY HAND (Outreach tab, after approval)' : 'SENT (release queue)';
      detail = 'sent ' + d(r.sent_at);
    } else if (r.cadence_stopped_at) {
      outcome = classifyStop(r.cadence_stop_reason);
      if (new Date(r.cadence_stopped_at) < new Date(cutoff)) outcome += ' -- before the deploy';
      detail = String(r.cadence_stop_reason || '').slice(0, 160) + '  (' + d(r.cadence_stopped_at) + ')';
      if (/was already sent to/.test(r.cadence_stop_reason || '')) {
        // WHICH EARLIER SEND made it a repeat, so a dedupe can be checked, not trusted.
        const addr = String(r.sent_to_email || '').trim().toLowerCase();
        const key = String(r.subject || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const prior = (await P.query(`
          SELECT s.system, s.ref_id, s.sent_at, l2.approved_at IS NULL AS hand
            FROM email_sends s LEFT JOIN outreach_logs l2 ON l2.id = s.ref_id
           WHERE s.email = $1 AND s.subject_key = $2 AND s.ref_id IS DISTINCT FROM $3
           ORDER BY s.sent_at LIMIT 1`, [addr, key, r.id])).rows[0];
        if (prior) detail += `\n        earlier send: ${prior.system}, row ${prior.ref_id || '?'}, ${d(prior.sent_at)}${prior.hand ? ', a hand-sent row (in the "sent by hand" count)' : ''}`;
      }
    } else if (r.status !== 'approved') {
      outcome = 'STATUS CHANGED to ' + r.status + ' without sending';
    } else if (r.send_hold_reason) {
      outcome = 'HELD';
      detail = String(r.send_hold_reason).slice(0, 160) + (r.send_failures ? `  (${r.send_failures} failed attempt(s))` : '');
    } else {
      outcome = 'WAITING (in the queue, not held)';
    }
    out.push({ r, outcome, detail });
  }

  const tally = new Map();
  for (const o of out) {
    const k = o.outcome.replace(/ -- before the deploy$/, '');
    tally.set(k, (tally.get(k) || 0) + 1);
  }
  console.log(`TOTAL approved and unsent at the cutoff: ${out.length}`);
  for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  const early = out.filter((o) => / -- before the deploy$/.test(o.outcome)).length;
  if (early) console.log(`  (${early} of these were already stopped BEFORE the deploy: the old count included them, the new one never did)`);
  console.log('');

  console.log('EVERY EMAIL, BY BUSINESS');
  for (const { r, outcome, detail } of out) {
    console.log(`  ${String(r.brand_name || '(no business name)').slice(0, 40).padEnd(42)}${outcome}`);
    console.log(`        for ${r.athlete || '?'} · to ${r.sent_to_email || '(no address)'} · agent ${r.agent || '?'} · approved ${d(r.approved_at)} · card ${r.card_state || '-'} · row ${r.id}`);
    if (detail) console.log('        ' + detail);
  }
  console.log('');

  // ── IS "SENT BY HAND" THE SAME SET? ─────────────────────────────────────
  // send-status's "sent by hand" is approved_at IS NULL AND sent_at IS NOT
  // NULL. Every row above has an approved_at, and neither send path clears it
  // (a manual Send from the Outreach tab updates the same row and leaves
  // approved_at set), so the two cannot share a row. They CAN share a
  // business: a hand-sent row to the same address, which is what would make
  // an approved one a same-subject repeat or hold it on the 4-day rule.
  const hand = (await P.query(`
    SELECT l.id, l.brand_name, LOWER(l.sent_to_email) AS addr, l.sent_at, l.subject
      FROM outreach_logs l WHERE l.approved_at IS NULL AND l.sent_at IS NOT NULL ORDER BY l.sent_at`)).rows;
  const setAddrs = new Map();
  for (const { r } of out) {
    const a = String(r.sent_to_email || '').trim().toLowerCase();
    if (a) setAddrs.set(a, r);
  }
  const overlapRows = out.filter(({ r }) => r.approved_at == null).length;
  const sameBiz = hand.filter((h) => h.addr && setAddrs.has(h.addr));
  console.log(`"SENT BY HAND" (${hand.length} rows, all time) AGAINST THE ${out.length} ABOVE`);
  console.log(`  rows in both: ${overlapRows}  (by construction: every row above was approved)`);
  console.log(`  hand-sent rows to an address that is also in the list above: ${sameBiz.length}`);
  for (const h of sameBiz) {
    const r = setAddrs.get(h.addr);
    console.log(`    ${String(h.brand_name || '?').slice(0, 36).padEnd(38)} hand-sent ${d(h.sent_at)} to ${h.addr} (row ${h.id}); approved row ${r.id}`);
  }
  try { await P.end(); } catch (_) {}
  process.exit(0);
}
main().catch((e) => { console.error('approved-accounting: FAILED', e); process.exit(1); });
