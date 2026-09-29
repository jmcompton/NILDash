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
//   node scripts/block-audit.js --apply    mark the university pools, and
//                                          withdraw (status 'rejected') any
//                                          team ask awaiting approval that is
//                                          addressed to a blocked business
//   /api/admin/scripts/block-audit?text=1  (&apply=1)
//
// THE AGENT SIDE IS REPORTED, NOT CHANGED. An agent's card is checked again by
// the compliance gate at send, which uses the same classifier, so a flagged
// business there is held or blocked at the send. This lists them so you can
// see how many there were.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const TeamScan = require(ROOT + 'server/services/teamScan.js');
const Compliance = require(ROOT + 'server/services/compliance.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const APPLY = process.argv.includes('--apply');

// What an agent may never be pitched, and what is held by age: every
// compliance category the classifier knows, reported by name.
const REPORT_KEYS = ['gambling', 'alcohol', 'cannabis', 'tobacco', 'firearms', 'adult'];

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

  // ── 3. THE AGENT SIDE, REPORTED ─────────────────────────────────────────
  say('', '== Agent market pools and open cards (reported; the send gate re-checks) ==');
  const rows = (await P.query(`SELECT market_key, brand, category FROM market_business_seen`)).rows;
  const flagged = {};
  for (const r of rows) {
    const hit = Compliance.classifyBusiness(r.brand, { types: [] }).hits.find((h) => REPORT_KEYS.includes(h.key));
    if (hit) (flagged[hit.key] = flagged[hit.key] || []).push(`${r.brand} (${r.market_key}, filed as ${r.category || '?'}) -- ${hit.basis}`);
  }
  for (const k of REPORT_KEYS) {
    const list = flagged[k] || [];
    say(`  ${k}: ${list.length}`);
    for (const l of list.slice(0, 40)) say(`      ${l}`);
    if (list.length > 40) say(`      ... and ${list.length - 40} more`);
  }
  const cards = (await P.query(`SELECT q.id, q.brand_name, q.agent_id, q.athlete_id, u.email FROM outreach_queue q LEFT JOIN users u ON u.id = q.agent_id WHERE q.state = 'queued'`)).rows;
  const openBad = cards.map((c) => ({ c, hit: Compliance.classifyBusiness(c.brand_name, { types: [] }).hits.find((h) => REPORT_KEYS.includes(h.key)) })).filter((x) => x.hit);
  say('', `  open agent cards to a flagged business: ${openBad.length} of ${cards.length}`);
  for (const { c, hit } of openBad.slice(0, 40)) say(`      card ${c.id}: ${c.brand_name} for ${c.athlete_id} (${c.email || c.agent_id}) -- ${hit.key}: ${hit.basis}`);

  say('', `SUMMARY: ${newly} university business(es) newly blocked, ${bad.length} waiting team ask(s) to a blocked business, `
    + `${Object.values(flagged).reduce((s, l) => s + l.length, 0)} agent-pool business(es) flagged, ${openBad.length} open agent card(s) flagged.`);
  console.log(out.join('\n'));
  try { await P.end(); } catch (_) {}
  process.exit(0);
}
if (require.main === module) main().catch((e) => { console.error('block-audit: FAILED', e.message); process.exit(1); });
