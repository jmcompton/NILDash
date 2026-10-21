'use strict';
// ── WHY DOES THIS SAY SIGNED? ───────────────────────────────────────────────
//
// For one agent, every record that makes a business read "signed" anywhere,
// and where each came from. Read-only. Run it on the account that saw a
// signed card nobody signed:
//
//   node scripts/signed-why.js --agent <email or id> [--athlete <name>] [--brand <part of the name>]
//   /api/admin/scripts/signed-why?text=1&agent=<email or id>[&athlete=Amber][&brand=veterinary]
//
// What reads signed, and from what:
//   Home's sent list     a logged deal (deal_outcomes) or a card marked closed
//   My Brands            a card marked closed, the ledger at closed, or a deal
//                        in the old deals table at Closed
//   the Pipeline board   the Pipeline row at Closed
// Only "Mark deal signed" (services/dealLog) writes a logged deal. Everything
// else listed here is something that is not that, and says what it was.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : null; };
const d = (t) => (t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '?');
const low = (s) => String(s || '').trim().toLowerCase();

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  if (!arg('agent')) { console.log('Give --agent <email or id>.'); return; }
  const u = (await P.query(`SELECT id, name, email FROM users WHERE id = $1 OR LOWER(email) = LOWER($1) LIMIT 1`, [arg('agent')])).rows[0];
  if (!u) { console.log(`No agent matches "${arg('agent')}".`); return; }
  const A = String(u.id);
  const brandLike = arg('brand') ? '%' + low(arg('brand')) + '%' : '%';
  const athletes = (await P.query(`SELECT id, data->>'name' AS name FROM athletes WHERE agent_id = $1 AND ($2::text IS NULL OR LOWER(data->>'name') LIKE $2)`,
    [A, arg('athlete') ? '%' + low(arg('athlete')) + '%' : null])).rows;
  const ids = athletes.map((a) => String(a.id));
  const nameOf = new Map(athletes.map((a) => [String(a.id), a.name || a.id]));
  console.log(`WHY DOES IT SAY SIGNED: ${u.name || '?'} <${u.email || '?'}>, ${athletes.length} athlete(s)` + (arg('brand') ? `, businesses like "${arg('brand')}"` : ''));
  if (!ids.length) return;
  const q = async (sql, p) => { try { return (await P.query(sql, p)).rows; } catch (e) { console.log('   (could not read: ' + e.message + ')'); return []; } };

  const logged = await q(`SELECT id, athlete_id, brand, deal_value, closed_at, logged_by FROM deal_outcomes
     WHERE agent_id = $1 AND athlete_id = ANY($2::text[]) AND LOWER(brand) LIKE $3 ORDER BY closed_at`, [A, ids, brandLike]);
  const cards = await q(`SELECT id, athlete_id, brand_name, state, outcome, outcome_at, channel FROM outreach_queue
     WHERE agent_id = $1 AND athlete_id = ANY($2::text[]) AND outcome = 'closed' AND LOWER(brand_name) LIKE $3 ORDER BY outcome_at`, [A, ids, brandLike]);
  const ledger = await q(`SELECT athlete_id, brand_name, state, outcome, updated_at FROM brand_engagement
     WHERE athlete_id = ANY($1::text[]) AND (state = 'closed' OR outcome = 'closed') AND LOWER(brand_name) LIKE $2 ORDER BY updated_at`, [ids, brandLike]);
  const old = await q(`SELECT id, athlete_id, data->>'brand' AS brand, data->>'stage' AS stage, data->>'status' AS status, data->>'source' AS source,
            data->>'campaign' AS campaign, data->>'createdAt' AS created FROM deals
     WHERE agent_id = $1 AND athlete_id = ANY($2::text[]) AND LOWER(COALESCE(data->>'brand','')) LIKE $3
       AND (LOWER(COALESCE(data->>'stage','')) = 'closed' OR LOWER(COALESCE(data->>'status','')) = 'closed')`, [A, ids, brandLike]);
  const pipe = await q(`SELECT id, athlete_id, brand_name, stage, source, stage_history FROM athlete_self_deals
     WHERE athlete_id = ANY($1::text[]) AND LOWER(brand_name) LIKE $2 AND LOWER(stage) IN ('closed','won','paid','invoiced','closed won','deal_closed')`, [ids, brandLike]);

  // One line per business, with every record behind it.
  const by = new Map();
  const at = (ath, brand) => { const k = ath + '|' + low(brand); if (!by.has(k)) by.set(k, { ath, brand, why: [] }); return by.get(k); };
  for (const x of logged) at(x.athlete_id, x.brand).why.push(`LOGGED DEAL #${x.id} ${d(x.closed_at)}${x.deal_value != null ? ' $' + x.deal_value : ''}: "Mark deal signed" (or the assistant) by ${x.logged_by || '?'}. Shows on Home and My Brands.`);
  for (const x of cards) at(x.athlete_id, x.brand_name).why.push(`CARD #${x.id} (${x.channel || '?'}) outcome closed ${d(x.outcome_at)}: set with a logged deal, or by POST /api/agent/outreach-queue/:id/outcome. Shows on Home and My Brands.`);
  for (const x of ledger) at(x.athlete_id, x.brand_name).why.push(`LEDGER state ${x.state}, outcome ${x.outcome || '-'} ${d(x.updated_at)}: written by a logged deal or by a deal saved at Closed. Shows on My Brands.`);
  for (const x of old) at(x.athlete_id, x.brand).why.push(`OLD DEALS TABLE ${x.id} at ${x.stage || x.status} (source ${x.source || '?'}, campaign "${x.campaign || ''}", ${x.created || '?'})`
    + (x.campaign === 'Manual Entry' ? ': the Add Manual Deal form, which preselected Closed' : '') + '. Shows on My Brands.');
  for (const x of pipe) {
    const h = Array.isArray(x.stage_history) ? x.stage_history : [];
    const last = h.slice().reverse().find((e) => /closed/i.test(String(e.stage || ''))) || {};
    at(x.athlete_id, x.brand_name).why.push(`PIPELINE ROW #${x.id} at ${x.stage} (source ${x.source || '?'}), moved there ${d(last.date)} "${last.note || ''}". Shows on the Pipeline board.`);
  }
  if (!by.size) {
    console.log('\nNothing on record says signed for these. If a card read "Deal signed", it was the BUTTON:');
    console.log('every unsigned row carried a green "Deal signed" button that looked like the signed label. It now reads "Mark deal signed".');
    return;
  }
  for (const r of by.values()) {
    const fromLog = r.why.some((w) => w.startsWith('LOGGED DEAL'));
    console.log(`\n${r.brand} for ${nameOf.get(String(r.ath)) || r.ath}: ${fromLog ? 'signed with a logged deal' : 'NO LOGGED DEAL: signed by something other than Mark deal signed'}`);
    for (const w of r.why) console.log('   ' + w);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
