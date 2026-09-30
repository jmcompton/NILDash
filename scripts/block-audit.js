'use strict';
// ── WHAT ELSE IS SLIPPING THROUGH THE BLOCK ─────────────────────────────────
//
// Los Alamitos Race Course reached a college team's slate because it was
// typed `restaurant` and the block only knew casinos and sportsbooks. The
// block now reads the name and Google's own description of the place, with
// racetracks, card rooms, OTB, bingo, keno, lottery and the betting brands
// added. This lists everything already in the pools that the stronger check
// catches, so "what else got through" is answered from the data.
//
//   node scripts/block-audit.js            report only; changes nothing
//   node scripts/block-audit.js --apply    mark the university pools, withdraw
//                                          (status 'rejected') any team ask
//                                          awaiting approval to a blocked
//                                          business, and PULL open agent cards
//                                          to a restricted business
//   /api/admin/scripts/block-audit?text=1  (&apply=1)
//
// COLLECTIVES (services/collectives) are reported on their own line and by
// athlete. A collective pays athletes and is never a sponsor, so --apply also
// REMOVES collective rows from the agent market pools (market_business_seen),
// not just their cards; the other categories stay in the pools and are
// decided per athlete at the card.
//
// THE AGENT SIDE. With --apply, open agent cards to a restricted business are
// PULLED (retired; the slot refills tonight). A card used to sit on an agent's
// screen until send, where the compliance gate stopped it; the nightly fill now
// refuses these by the same rule, and this clears the ones already there.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const TeamScan = require(ROOT + 'server/services/teamScan.js');
const Compliance = require(ROOT + 'server/services/compliance.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const APPLY = process.argv.includes('--apply');

// What an agent may never be pitched, and what is held by age: every
// compliance category the classifier knows, reported by name.
const REPORT_KEYS = ['collective', 'gambling', 'alcohol', 'cannabis', 'tobacco', 'firearms', 'adult'];

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const out = [];
  const say = (...lines) => out.push(...(lines.length ? lines : ['']));
  say(`BLOCK AUDIT  ${new Date().toISOString()}  ${APPLY ? 'APPLY' : 'report only (add --apply to change anything)'}`);

  // ── 1. UNIVERSITY POOLS ─────────────────────────────────────────────────
  say('', '== University pools (teams: blocked at any age) ==');
  const markets = (await P.query(`SELECT DISTINCT market_key FROM university_market_seen ORDER BY 1`)).rows.map((r) => r.market_key);
  let newly = 0;
  for (const mk of markets) {
    const rc = await TeamScan.recheckPool(P, mk, { dryRun: !APPLY });
    say(`  ${mk}: ${rc.checked} businesses, ${rc.blocked} blocked`
      + (rc.newlyBlocked.length ? `, ${rc.newlyBlocked.length} NEWLY BLOCKED (these were eligible for a slate)` : ', nothing new'));
    for (const b of rc.newlyBlocked) say(`      ${b.brand}  [filed as ${b.category || '?'}]  ->  ${b.reason}`);
    for (const c of rc.cleared) say(`      cleared: ${c.brand} (was ${c.was})`);
    newly += rc.newlyBlocked.length;
  }
  if (!markets.length) say('  no university pools');

  // ── 2. TEAM ASKS WAITING FOR APPROVAL ───────────────────────────────────
  say('', '== Team asks awaiting approval, addressed to a blocked business ==');
  const drafts = (await P.query(
    `SELECT d.id, d.brand_name, d.team_id, d.inventory_name, d.created_at, m.blocked_reason, m.types, m.primary_type, m.primary_type_label
       FROM university_drafts d
       LEFT JOIN university_teams t ON t.id = d.team_id
       LEFT JOIN university_market_seen m ON m.brand = d.brand_name AND m.market_key = t.market_key
      WHERE d.status = 'awaiting_approval' ORDER BY d.created_at`)).rows;
  const bad = [];
  for (const d of drafts) {
    const b = TeamScan.blockedFor({ name: d.brand_name, types: d.types || [], primary_type: d.primary_type, primary_type_label: d.primary_type_label });
    if (b) bad.push({ ...d, why: `${b.key}: ${b.why}` });
  }
  for (const d of bad) say(`  ${d.brand_name}  (${d.team_id}, ${d.inventory_name}, written ${new Date(d.created_at).toISOString().slice(0, 10)})  ->  ${d.why}`);
  if (!bad.length) say(`  none of the ${drafts.length} waiting ask(s)`);
  if (bad.length && APPLY) {
    const r = await P.query(`UPDATE university_drafts SET status = 'rejected', updated_at = NOW() WHERE id = ANY($1) AND status = 'awaiting_approval'`, [bad.map((d) => d.id)]);
    say(`  withdrawn: ${r.rowCount} (status 'rejected'); they will not appear for approval`);
  } else if (bad.length) say(`  ${bad.length} would be withdrawn with --apply`);

  // ── 3. THE AGENT SIDE ───────────────────────────────────────────────────
  // Open cards: the fill's own decision (services/outreachQueue.restrictedFor,
  // the send's classifier and age rule) for each card's athlete. With --apply a
  // flagged card is RETIRED, not deleted: state 'retired' frees the slot for
  // tonight's refill (which now refuses the same business by name), the row
  // stays for the record, outcome 'restricted'. Only 'queued' cards; nothing an
  // agent has already worked is touched.
  const Q = require(ROOT + 'server/services/outreachQueue.js');
  say('', '== Open agent cards to a restricted business ==');
  const cards = (await P.query(
    `SELECT q.id, q.brand_name, q.agent_id, q.athlete_id, q.lane, u.email, a.data
       FROM outreach_queue q LEFT JOIN users u ON u.id = q.agent_id LEFT JOIN athletes a ON a.id = q.athlete_id
      WHERE q.state = 'queued'`)).rows;
  // The business's category from the pools, so a card for a "Hair
  // Collective" filed as a salon is judged as the salon it is.
  const catOf = new Map();
  for (const r of (await P.query(`SELECT LOWER(brand) AS b, MAX(category) AS category FROM market_business_seen WHERE category IS NOT NULL GROUP BY 1`)).rows) catOf.set(r.b, r.category);
  const placeFor = (name) => { const c = catOf.get(String(name || '').toLowerCase()); return c ? { types: [], primaryTypeDisplayName: c } : null; };
  const openBad = [];
  for (const c of cards) {
    const rx = Q.restrictedFor(c.brand_name, placeFor(c.brand_name), c.data || {});
    if (rx) openBad.push({ c, rx });
  }
  for (const { c, rx } of openBad) {
    say(`  card ${c.id}: ${c.brand_name} for ${(c.data && c.data.name) || c.athlete_id} (${c.email || c.agent_id}) -- ${rx.why}`);
  }
  if (!openBad.length) say(`  none of the ${cards.length} open card(s)`);
  // COLLECTIVES, BY ATHLETE: who is looking at one right now.
  const colCards = openBad.filter((x) => x.rx.key === 'collective');
  if (colCards.length) {
    const byAth = new Map();
    for (const { c } of colCards) {
      const k = `${(c.data && c.data.name) || c.athlete_id} (${c.email || c.agent_id})`;
      if (!byAth.has(k)) byAth.set(k, []);
      byAth.get(k).push(c.brand_name);
    }
    say('', `  collective cards by athlete: ${colCards.length} card(s) for ${byAth.size} athlete(s)`);
    for (const [k, list] of byAth) say(`      ${k}: ${list.join('; ')}`);
  }
  if (openBad.length && APPLY) {
    const r = await P.query(
      `UPDATE outreach_queue SET state = 'retired', outcome = 'restricted', outcome_at = NOW(), updated_at = NOW()
        WHERE id = ANY($1::int[]) AND state = 'queued'`, [openBad.map((x) => x.c.id)]);
    say(`  pulled: ${r.rowCount} card(s) retired (outcome 'restricted'); each slot refills tonight`);
  } else if (openBad.length) say(`  ${openBad.length} would be pulled with --apply`);

  // Approved emails not yet sent, to a restricted business. The send gate
  // holds or blocks these; listed so nothing is a surprise.
  const logs = (await P.query(
    `SELECT l.id, l.brand_name, l.status, a.data FROM outreach_logs l LEFT JOIN athletes a ON a.id = l.athlete_id
      WHERE l.status = 'approved' AND l.sent_at IS NULL`).catch(() => ({ rows: [] }))).rows;
  const logBad = logs.map((l) => ({ l, rx: Q.restrictedFor(l.brand_name, placeFor(l.brand_name), l.data || {}) })).filter((x) => x.rx);
  say('', `  approved, unsent emails to a restricted business: ${logBad.length} (the send gate stops these)`);
  for (const { l, rx } of logBad.slice(0, 40)) say(`      log ${l.id}: ${l.brand_name} -- ${rx.why}`);

  // The agent pools: confirmed (a strong word, a Google type, or Google's own
  // description), and possible (a weak word alone, e.g. "adult" in a rec
  // centre's name), which blocks nothing and is listed for a person to look at.
  say('', '== Agent market pools ==');
  const rows = (await P.query(`SELECT market_key, brand, category FROM market_business_seen`)).rows;
  const flagged = {}, maybe = {};
  const colRows = [];
  for (const r of rows) {
    const cls = Compliance.classifyBusiness(r.brand, { types: [], category: r.category });
    if (cls.hits.some((h) => h.key === 'collective')) colRows.push(r);
    const hit = cls.hits.find((h) => REPORT_KEYS.includes(h.key));
    if (hit) { (flagged[hit.key] = flagged[hit.key] || []).push(`${r.brand} (${r.market_key}, filed as ${r.category || '?'}) -- ${hit.basis}`); continue; }
    const pos = (cls.possible || []).find((h) => REPORT_KEYS.includes(h.key));
    if (pos) (maybe[pos.key] = maybe[pos.key] || []).push(`${r.brand} (${r.market_key}) -- ${pos.basis}`);
  }
  for (const k of REPORT_KEYS) {
    const list = flagged[k] || [];
    say(`  ${k}: ${list.length} confirmed`);
    for (const l of list.slice(0, 40)) say(`      ${l}`);
    if (list.length > 40) say(`      ... and ${list.length - 40} more`);
  }
  // A collective is not a business anyone sponsors from: its pool rows are
  // removed, not just kept off cards. (The other categories stay in the pool;
  // whether they can be pitched depends on the athlete's age, decided at the
  // card.)
  if (colRows.length && APPLY) {
    let n = 0;
    for (const r of colRows) n += (await P.query(`DELETE FROM market_business_seen WHERE market_key = $1 AND brand = $2`, [r.market_key, r.brand])).rowCount;
    say(`  removed ${n} collective row(s) from the agent market pools`);
  } else if (colRows.length) say(`  ${colRows.length} collective row(s) would be removed from the agent market pools with --apply`);
  const maybeN = Object.values(maybe).reduce((s, l) => s + l.length, 0);
  say('', `  possible, NOT blocked (a weak word alone): ${maybeN}`);
  for (const k of REPORT_KEYS) for (const l of (maybe[k] || []).slice(0, 15)) say(`      ${k}: ${l}`);

  say('', `COLLECTIVES: ${colRows.length} agent-pool row(s), ${colCards.length} open agent card(s), `
    + `${bad.filter((d) => /^collective:/.test(d.why)).length} waiting university ask(s)${APPLY ? ' -- all removed / pulled / withdrawn' : ' (report only)'}`);
  say('', `SUMMARY: ${newly} university business(es) newly blocked, ${bad.length} waiting team ask(s) to a blocked business, `
    + `${openBad.length} open agent card(s) to a restricted business${APPLY ? ' (pulled)' : ''}, ${logBad.length} approved unsent email(s), `
    + `${Object.values(flagged).reduce((s, l) => s + l.length, 0)} agent-pool business(es) confirmed, ${maybeN} possible.`);
  console.log(out.join('\n'));
  try { await P.end(); } catch (_) {}
  process.exit(0);
}
if (require.main === module) main().catch((e) => { console.error('block-audit: FAILED', e.message); process.exit(1); });
