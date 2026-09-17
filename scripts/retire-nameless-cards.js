#!/usr/bin/env node
'use strict';
// ── NO NAME, NO CARD: THE CARDS ALREADY ON THE QUEUE ────────────────────────
//
//   node scripts/retire-nameless-cards.js              list them (writes nothing)
//   node scripts/retire-nameless-cards.js --apply      retire them
//   node scripts/retire-nameless-cards.js --agent cs@9091sportsagency.com [--apply]
//
// Every QUEUED card that fails the one rule every new card is saved under
// (services/outreachQueue.cardNameProblem, enforced in
// jobs/outreachQueue.insertCard): no real named person on the card, or a
// message that does not open "Hi <their first name>,". Counted per agent.
// --apply sets each to state 'retired' with outcome 'no_name' (frees the slot
// for tonight, keeps the record) and stops the linked email draft so it cannot
// be approved or sent. Nothing is deleted. The same audit runs from the
// browser at GET /api/admin/nameless-cards[?apply=1].

const store = require('../server/store');
const QA = require('../server/services/queueAudit');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;

process.exitCode = 1;
let settled = false;
process.on('beforeExit', () => { if (!settled) { console.log('retire-nameless-cards: main() never settled. Exiting 1.'); process.exit(1); } });
function fail(where, e) { const m = `retire-nameless-cards: FAILED (${where}): ${e && e.message ? e.message : e}`; console.log(m); console.error(m); settled = true; process.exit(1); }
function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; }
const APPLY = process.argv.includes('--apply');

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const agentEmail = arg('agent', null);
  let agentId = null;
  if (agentEmail) {
    const u = (await P.query(`SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`, [agentEmail]).catch((e) => fail('users', e))).rows;
    if (!u.length) return fail('args', new Error('no user with email ' + agentEmail));
    agentId = u[0].id;
  }
  const { total, bad, perAgent } = await QA.namelessCards(P, { agentId }).catch((e) => fail('queue', e));
  console.log(`retire-nameless-cards: ${total} queued card(s)${agentEmail ? ' for ' + agentEmail : ''}, ${bad.length} with no named contact or a greeting to nobody${APPLY ? '' : ' (dry run; add --apply to retire them)'}\n`);
  for (const c of bad) {
    console.log(`  #${String(c.id).padEnd(6)} ${String(c.agent_email || c.agent_id).padEnd(30)} ${String(c.athlete_name).padEnd(22)} ${String(c.brand_name).slice(0, 34).padEnd(34)} ${String(c.lane || '?').padEnd(8)} ${String(c.channel).padEnd(7)} ${String(c.created_at).slice(0, 10)}  ${c.problem}`);
  }
  if (bad.length) {
    console.log('\nPer agent:');
    for (const [k, n] of Object.entries(perAgent).sort((a, b) => b[1] - a[1])) console.log(`  ${String(k).padEnd(34)} ${n}`);
  }
  if (APPLY && bad.length) {
    const r = await QA.retireNameless(P, bad.map((x) => x.id)).catch((e) => fail('retire', e));
    console.log(`\nRetired ${r.retired} card(s) (state retired, outcome no_name); stopped ${r.stopped} linked email draft(s). Their slots refill tonight, with a name or not at all.`);
  } else if (!bad.length) {
    console.log('  none. Every queued card names a person and greets them.');
  }
  console.log('\nDone.\n');
  settled = true;
  await P.end().catch(() => {});
  process.exit(0);
}
main().catch((e) => fail('main', e));
