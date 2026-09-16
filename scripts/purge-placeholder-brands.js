#!/usr/bin/env node
'use strict';
// ── REAL BUSINESS NAMES ONLY: THE PLACEHOLDERS ALREADY IN THE TABLES ────────
//
//   node scripts/purge-placeholder-brands.js              list them (writes nothing)
//   node scripts/purge-placeholder-brands.js --apply      remove them
//
// "Local Harrisburg Barber/Salon (independent)" is a description the model
// wrote when it could not name a business. Every writer now refuses such a
// name (store.placeholderReason), and the slate and the card writer refuse
// them again by name. This clears the ones written before that, from the
// four places they live:
//   brand_engagement          the scan's "shown" ledger, which the nightly
//                             slate reads. Rows in state 'shown' are deleted;
//                             rows in any other state are listed and kept
//                             (somebody acted on them, and that is a record).
//   market_business_seen      the market pool. Deleted.
//   deal_scan_market_cache    the cached pool. The names are removed from the
//                             candidate lists; the rows stay.
//   outreach_queue            queued cards. Retired with outcome 'placeholder'
//                             and their email drafts stopped, like
//                             retire-nameless-cards. Nothing is deleted there.

const store = require('../server/store');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;
const APPLY = process.argv.includes('--apply');

process.exitCode = 1;
let settled = false;
process.on('beforeExit', () => { if (!settled) { console.log('purge-placeholder-brands: main() never settled. Exiting 1.'); process.exit(1); } });
function fail(where, e) { const m = `purge-placeholder-brands: FAILED (${where}): ${e && e.message ? e.message : e}`; console.log(m); console.error(m); settled = true; process.exit(1); }
const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n);

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const why = (n) => store.placeholderReason(n);
  console.log(`purge-placeholder-brands: ${APPLY ? 'APPLYING' : 'dry run (add --apply to remove)'}\n`);

  // 1. brand_engagement
  const eng = (await P.query(`SELECT id, athlete_id, brand_name, state, lane FROM brand_engagement WHERE brand_name IS NOT NULL`).catch((e) => fail('brand_engagement', e))).rows;
  const engBad = eng.map((r) => ({ r, why: why(r.brand_name) })).filter((x) => x.why);
  const engShown = engBad.filter((x) => x.r.state === 'shown');
  const engKept = engBad.filter((x) => x.r.state !== 'shown');
  console.log(`brand_engagement: ${engBad.length} placeholder row(s) of ${eng.length}; ${engShown.length} in state shown (removed), ${engKept.length} acted on (kept, listed)`);
  for (const x of engBad.slice(0, 40)) console.log(`  ${pad(x.r.state, 10)} ${pad(x.r.athlete_id, 22)} ${pad(String(x.r.brand_name).slice(0, 50), 50)} ${x.why}`);
  if (engBad.length > 40) console.log(`  ... and ${engBad.length - 40} more`);

  // 2. market_business_seen
  const seen = (await P.query(`SELECT market_key, brand FROM market_business_seen`).catch((e) => fail('market_business_seen', e))).rows;
  const seenBad = seen.map((r) => ({ r, why: why(r.brand) })).filter((x) => x.why);
  console.log(`\nmarket_business_seen: ${seenBad.length} placeholder row(s) of ${seen.length}`);
  for (const x of seenBad.slice(0, 30)) console.log(`  ${pad(x.r.market_key, 26)} ${pad(String(x.r.brand).slice(0, 50), 50)} ${x.why}`);
  if (seenBad.length > 30) console.log(`  ... and ${seenBad.length - 30} more`);

  // 3. deal_scan_market_cache
  const cache = (await P.query(`SELECT cache_key, candidates FROM deal_scan_market_cache`).catch((e) => fail('deal_scan_market_cache', e))).rows;
  const cacheFix = [];
  for (const row of cache) {
    const list = Array.isArray(row.candidates) ? row.candidates : [];
    const keep = list.filter((c) => !why(c && (c.name || c.brand)));
    if (keep.length !== list.length) cacheFix.push({ key: row.cache_key, before: list.length, after: keep.length, keep, dropped: list.filter((c) => why(c && (c.name || c.brand))).map((c) => c.name || c.brand) });
  }
  console.log(`\ndeal_scan_market_cache: ${cacheFix.length} pool(s) of ${cache.length} carry placeholders`);
  for (const x of cacheFix.slice(0, 20)) console.log(`  ${pad(x.key, 40)} ${x.before} -> ${x.after}: ${x.dropped.slice(0, 3).map((d) => JSON.stringify(String(d).slice(0, 40))).join(', ')}${x.dropped.length > 3 ? ' ...' : ''}`);

  // 4. outreach_queue
  const cards = (await P.query(
    `SELECT q.id, q.brand_name, q.lane, q.channel, q.outreach_log_id, a.data->>'name' AS athlete_name, u.email AS agent_email
       FROM outreach_queue q JOIN athletes a ON a.id = q.athlete_id LEFT JOIN users u ON u.id = q.agent_id
      WHERE q.state = 'queued'`).catch((e) => fail('outreach_queue', e))).rows;
  const cardBad = cards.map((r) => ({ r, why: why(r.brand_name) })).filter((x) => x.why);
  console.log(`\noutreach_queue: ${cardBad.length} queued card(s) of ${cards.length} carry a placeholder name`);
  for (const x of cardBad) console.log(`  #${pad(x.r.id, 6)} ${pad(x.r.agent_email, 30)} ${pad(x.r.athlete_name, 22)} ${pad(String(x.r.brand_name).slice(0, 44), 44)} ${pad(x.r.lane || '?', 8)} ${x.why}`);

  if (APPLY) {
    let n1 = 0, n2 = 0, n3 = 0, n4 = 0, n5 = 0;
    if (engShown.length) n1 = (await P.query(`DELETE FROM brand_engagement WHERE id = ANY($1::int[]) AND state = 'shown'`, [engShown.map((x) => x.r.id)]).catch((e) => fail('delete brand_engagement', e))).rowCount;
    for (const x of seenBad) n2 += (await P.query(`DELETE FROM market_business_seen WHERE market_key = $1 AND brand = $2`, [x.r.market_key, x.r.brand]).catch((e) => fail('delete market_business_seen', e))).rowCount;
    for (const x of cacheFix) { await P.query(`UPDATE deal_scan_market_cache SET candidates = $2::jsonb WHERE cache_key = $1`, [x.key, JSON.stringify(x.keep)]).catch((e) => fail('update cache', e)); n3++; }
    if (cardBad.length) {
      n4 = (await P.query(`UPDATE outreach_queue SET state = 'retired', outcome = 'placeholder', outcome_at = NOW(), updated_at = NOW() WHERE id = ANY($1::int[]) AND state = 'queued'`, [cardBad.map((x) => x.r.id)]).catch((e) => fail('retire cards', e))).rowCount;
      const logIds = cardBad.map((x) => x.r.outreach_log_id).filter(Boolean);
      if (logIds.length) n5 = (await P.query(`UPDATE outreach_logs SET cadence_stopped_at = NOW(), cadence_stop_reason = 'retired: not a real business name', updated_at = NOW() WHERE id = ANY($1::text[]) AND status = 'draft' AND approved_at IS NULL AND cadence_stopped_at IS NULL`, [logIds]).catch((e) => fail('stop drafts', e))).rowCount;
    }
    console.log(`\nRemoved ${n1} shown ledger row(s), ${n2} market pool row(s); cleaned ${n3} cached pool(s); retired ${n4} card(s) and stopped ${n5} draft(s).`);
  }
  console.log('\nDone.\n');
  settled = true;
  await P.end().catch(() => {});
  process.exit(0);
}
main().catch((e) => fail('main', e));
