#!/usr/bin/env node
'use strict';
// ── WHAT IS THIS BRAND, AND WHY IS IT ON EVERY ATHLETE ───────────────────────
//
//   node scripts/inspect-social-brand.js "Bfitamazing"
//   node scripts/inspect-social-brand.js "Bfitamazing" --deactivate
//
// The social index (social_brands) is grown by the nightly discovery job
// (jobs/socialDiscovery): a web search names brands, the server finds a page
// on the brand's own site that mentions an ambassador, affiliate or creator
// program, and the row goes in with whatever the search said about it. This
// prints that row: the website, the page that passed the gate and the words
// on it that did, the sports and follower band it matches, when it was added,
// and every card that carries it. --deactivate sets active=false so the
// slate never draws it again (the row stays, so discovery does not re-add it).

const store = require('../server/store');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;
const DEACTIVATE = process.argv.includes('--deactivate');
const needle = process.argv.slice(2).find((a) => !a.startsWith('--')) || '';

process.exitCode = 1;
let settled = false;
process.on('beforeExit', () => { if (!settled) { console.log('inspect-social-brand: main() never settled. Exiting 1.'); process.exit(1); } });
function fail(where, e) { const m = `inspect-social-brand: FAILED (${where}): ${e && e.message ? e.message : e}`; console.log(m); console.error(m); settled = true; process.exit(1); }

async function main() {
  if (!needle) return fail('args', new Error('a brand name, e.g. node scripts/inspect-social-brand.js "Bfitamazing"'));
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const rows = (await P.query(`SELECT * FROM social_brands WHERE brand ILIKE $1 ORDER BY proof_date DESC`, ['%' + needle + '%']).catch((e) => fail('social_brands', e))).rows;
  console.log(`inspect-social-brand: ${rows.length} row(s) matching "${needle}"\n`);
  for (const b of rows) {
    console.log(`${b.brand}  (id ${b.id}, ${b.active ? 'active' : 'INACTIVE'})`);
    console.log(`   website:      ${b.website || '(none)'}`);
    console.log(`   program page: ${b.proof_url || '(none)'}`);
    console.log(`   the words that passed the gate: ${b.proof_snippet ? JSON.stringify(String(b.proof_snippet).slice(0, 220)) : '(no snippet stored)'}`);
    console.log(`   category ${b.category || '?'}; deal ${b.deal_structure || '?'}; size ${b.brand_size || '?'}; sports ${JSON.stringify(b.sports)}; followers ${b.tier_min}..${b.tier_max}${b.tier_stated ? ' (stated on the page)' : ' (the search\'s guess)'}`);
    console.log(`   added/refreshed ${b.proof_date ? String(b.proof_date).slice(0, 10) : '?'}; offer: ${b.offer_summary ? String(b.offer_summary).slice(0, 200) : '(none)'}`);
    const cards = (await P.query(
      `SELECT q.state, q.outcome, q.channel, q.created_at, a.data->>'name' AS athlete, u.email AS agent
         FROM outreach_queue q JOIN athletes a ON a.id = q.athlete_id LEFT JOIN users u ON u.id = q.agent_id
        WHERE LOWER(q.brand_name) = LOWER($1) ORDER BY q.created_at DESC`, [b.brand]).catch(() => ({ rows: [] }))).rows;
    const byState = {};
    for (const c of cards) byState[c.state + (c.outcome ? '/' + c.outcome : '')] = (byState[c.state + (c.outcome ? '/' + c.outcome : '')] || 0) + 1;
    console.log(`   cards: ${cards.length} across ${new Set(cards.map((c) => c.athlete)).size} athlete(s) and ${new Set(cards.map((c) => c.agent)).size} agent(s): ${Object.entries(byState).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`);
    for (const c of cards.slice(0, 12)) console.log(`      ${String(c.created_at).slice(0, 10)}  ${c.state}${c.outcome ? '/' + c.outcome : ''}  ${c.channel}  ${c.athlete}  (${c.agent})`);
    if (cards.length > 12) console.log(`      ... and ${cards.length - 12} more`);
    if (DEACTIVATE && b.active) {
      await P.query(`UPDATE social_brands SET active = false, updated_at = NOW() WHERE id = $1`, [b.id]).catch((e) => fail('deactivate', e));
      console.log(`   DEACTIVATED: the slate will not draw it again.`);
    }
    console.log('');
  }
  if (!rows.length) console.log('Nothing in social_brands matches. The card\'s brand_name may differ from the index row; try a shorter part of the name.');
  console.log('Done.\n');
  settled = true;
  await P.end().catch(() => {});
  process.exit(0);
}
main().catch((e) => fail('main', e));
