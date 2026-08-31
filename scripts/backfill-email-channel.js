#!/usr/bin/env node
'use strict';
// ── THE ADDRESS THE CARD ALREADY HAD ────────────────────────────────────────
//
// buildCard's channel decision was `dmable ? 'dm' : 'call'` and outreach_queue
// had no email column, so a local business with a general inbox and no handle
// became a CALL card and the address was dropped on the floor between passesBar
// (which counted the inbox as reachable) and the card that was written.
//
// The address is not gone. The contact ladder wrote it to brand_evidence_cache
// lane 'siteemail' at the time, and that row is still there. So this recovers
// what was discarded rather than re-paying for the lookup: nothing here calls
// Hunter, Places, or a model, and it spends nothing.
//
// WHAT IT DOES, per queued card with channel='call' and no email:
//   1. reads the cached siteemail row for that brand
//   2. screens the address the same way the scraper does (siteEmail.screenEmail),
//      so "a usable address" means one thing in this codebase and not two
//   3. skips anything on the suppression list -- a bounced address is not a
//      recovery, it is a repeat of a known failure
//   4. writes email/email_kind, flips channel to 'email', and creates the
//      outreach_logs draft that will actually send it
//
// DRY RUN BY DEFAULT. --apply is required to write. Per-athlete counts are
// printed before anything is written, either way.
//
// REVERSIBLE, AND NOTHING IS DELETED. Every card it touches keeps its phone,
// its handle, its why and its contact. --undo puts the channel back to 'call'
// and cadence-stops the drafts it created; it never drops a row. The drafts are
// stamped source='backfill-email-channel' so they can be found again by anything,
// including by hand.
//
//   node scripts/backfill-email-channel.js                  # dry run, all agents
//   node scripts/backfill-email-channel.js --agent <id>     # dry run, one agent
//   node scripts/backfill-email-channel.js --apply
//   node scripts/backfill-email-channel.js --undo --apply

const store = require('../server/store');
const Q = require('../server/services/outreachQueue');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const UNDO = args.includes('--undo');
const AGENT = (() => { const i = args.indexOf('--agent'); return i === -1 ? null : args[i + 1]; })();
const SOURCE = 'backfill-email-channel';

function screen(addr) {
  try { return require('../server/services/siteEmail').screenEmail(addr, null); }
  catch (e) { return { ok: true }; }   // cannot screen: do not invent a rejection
}

function textToParagraphs(text) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(text || '').split(/\n\s*\n+/)
    .map((p) => p.trim()).filter(Boolean)
    .map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>')
    .join('');
}

async function undo(pool) {
  const rows = (await pool.query(
    `SELECT q.id, q.brand_name, q.outreach_log_id,
            COALESCE(a.data->>'name','an athlete') AS athlete
       FROM outreach_queue q
       LEFT JOIN athletes a ON a.id = q.athlete_id
      WHERE q.channel = 'email' AND q.state = 'queued'
        AND q.outreach_log_id IN (SELECT id FROM outreach_logs WHERE source = $1)
        AND ($2::text IS NULL OR q.agent_id = $2)
      ORDER BY athlete, q.brand_name`, [SOURCE, AGENT])).rows;
  console.log(`\n${rows.length} card(s) would go back to 'call'.`);
  for (const r of rows) console.log(`  ${r.athlete.padEnd(22)} ${r.brand_name}`);
  if (!APPLY) { console.log('\nDRY RUN. Add --apply to write.'); return; }
  for (const r of rows) {
    // The draft is STOPPED, not deleted. Its body, its address and its reason
    // survive, which is the same stance every other retirement here takes.
    await pool.query(
      `UPDATE outreach_logs SET cadence_stopped_at = NOW(),
          cadence_stop_reason = 'the email-channel backfill was undone', updated_at = NOW()
        WHERE id = $1 AND status = 'draft'`, [r.outreach_log_id]).catch(() => {});
    await pool.query(
      `UPDATE outreach_queue SET channel = 'call', outreach_log_id = NULL, updated_at = NOW()
        WHERE id = $1`, [r.id]);
  }
  console.log(`\nReverted ${rows.length}. The addresses stay on the cards; only the channel moved back.`);
}

(async () => {
  const pool = store.pool;
  if (UNDO) { await undo(pool); await pool.end().catch(() => {}); return; }

  // Every queued call card that has no address on it yet, with whatever the
  // contact ladder cached for that brand at the time.
  const rows = (await pool.query(
    `SELECT q.id, q.agent_id, q.athlete_id, q.brand_name, q.brand_key, q.why,
            q.dm_text, q.angle, q.angle_key, q.category_key, q.ask,
            COALESCE(a.data->>'name','an athlete') AS athlete,
            b.evidence->>'email' AS cached_email,
            b.evidence->>'kind'  AS cached_kind
       FROM outreach_queue q
       LEFT JOIN athletes a ON a.id = q.athlete_id
       LEFT JOIN LATERAL (
         SELECT evidence FROM brand_evidence_cache b2
          WHERE b2.lane = 'siteemail'
            AND (b2.brand_key = LOWER(q.brand_name) OR LOWER(b2.brand) = LOWER(q.brand_name))
          ORDER BY b2.refreshed_at DESC LIMIT 1
       ) b ON TRUE
      WHERE q.state = 'queued' AND q.channel = 'call'
        AND (q.email IS NULL OR q.email = '')
        AND ($1::text IS NULL OR q.agent_id = $1)
      ORDER BY athlete, q.brand_name`, [AGENT])).rows;

  const addrs = rows.map((r) => r.cached_email).filter(Boolean)
    .map((e) => String(e).trim().toLowerCase());
  let suppressed = new Set();
  if (addrs.length) {
    try { suppressed = await require('../server/services/suppression').suppressedSet(pool, addrs); }
    catch (e) { console.error('suppression read failed, treating none as suppressed: ' + e.message); }
  }

  const plan = [];
  const held = [];
  for (const r of rows) {
    const raw = r.cached_email ? String(r.cached_email).trim().toLowerCase() : null;
    if (!raw) { held.push({ ...r, why: 'no cached address for this brand' }); continue; }
    const s = screen(raw);
    if (!s.ok) { held.push({ ...r, why: s.reason || 'the address did not pass the screen' }); continue; }
    if (suppressed.has(raw)) { held.push({ ...r, why: 'this address bounced before' }); continue; }
    plan.push({ ...r, email: raw, kind: r.cached_kind || null });
  }

  // ── PER ATHLETE, BEFORE ANYTHING IS WRITTEN ───────────────────────────────
  const byAthlete = new Map();
  for (const p of plan) {
    if (!byAthlete.has(p.athlete)) byAthlete.set(p.athlete, []);
    byAthlete.get(p.athlete).push(p);
  }
  console.log(`\n${rows.length} queued call card(s) with no address examined.\n`);
  console.log('WOULD FLIP TO EMAIL');
  if (!plan.length) console.log('  (none)');
  for (const [ath, list] of byAthlete) {
    console.log(`  ${ath} — ${list.length}`);
    for (const p of list) console.log(`      ${p.brand_name.padEnd(30)} ${p.email}`);
  }

  const heldBy = new Map();
  for (const h of held) heldBy.set(h.why, (heldBy.get(h.why) || 0) + 1);
  console.log('\nLEFT AS CALL CARDS');
  if (!held.length) console.log('  (none)');
  for (const [why, n] of heldBy) console.log(`  ${String(n).padStart(4)}  ${why}`);

  console.log(`\n${plan.length} to flip, ${held.length} unchanged, `
    + `${rows.length} examined. Nothing is deleted and no lookup is paid for.`);

  if (!APPLY) {
    console.log('\nDRY RUN. Add --apply to write. Reverse with --undo --apply.');
    await pool.end().catch(() => {});
    return;
  }

  let flipped = 0;
  let failed = 0;
  for (const p of plan) {
    const logId = 'bf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    try {
      // The draft first: a card claiming an address it cannot send to is worse
      // than a card left alone.
      await pool.query(
        `INSERT INTO outreach_logs
           (id, agent_id, athlete_id, brand_name, brand_key, subject, body_html, status, source,
            sent_to_email, email_kind, angle, angle_key, category_key, ask, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())`,
        [logId, p.agent_id, p.athlete_id, p.brand_name, p.brand_key,
          Q.subjectFor(p.brand_name),
          // The pitch this card already carried where there is one. A call card
          // written before dm_text existed has none, so the plain fallback is
          // used and the angle stays null -- nothing downstream can mistake one
          // for a reasoned pitch.
          textToParagraphs(p.dm_text || Q.writeDm(p.athlete, p.brand_name, p.why)),
          SOURCE, p.email, p.kind,
          p.angle, p.angle_key, p.category_key, p.ask]);
      await pool.query(
        `UPDATE outreach_queue
            SET channel = 'email', email = $2, email_kind = $3, outreach_log_id = $4,
                updated_at = NOW()
          WHERE id = $1 AND state = 'queued'`, [p.id, p.email, p.kind, logId]);
      flipped++;
    } catch (e) {
      failed++;
      console.error(`  FAILED ${p.brand_name}: ${e.message}`);
      await pool.query(`DELETE FROM outreach_logs WHERE id = $1 AND source = $2`, [logId, SOURCE])
        .catch(() => {});
    }
  }
  console.log(`\nFlipped ${flipped} card(s) to email.`
    + (failed ? ` ${failed} failed and were left as call cards.` : '')
    + `\nEvery one keeps its phone, handle, contact and why. Reverse with --undo --apply.`);
  await pool.end().catch(() => {});
})().catch((e) => { console.error(e); process.exit(1); });
