'use strict';
// ── WHAT THE FOLLOW-UP PASS WILL DO, BEFORE IT DOES IT ──────────────────────
// Every first email sent in the lookback (services/followUps.LOOKBACK_DAYS),
// by agent: which touch is next, when it is due, and what stops it. Read-only:
// this writes nothing (the hourly poller does the writing, as drafts the agent
// approves).
//
//   node scripts/follow-up-plan.js
//   /api/admin/scripts/follow-up-plan?text=1
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const FUP = require(ROOT + 'server/services/followUps.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const d = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '?');

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const users = new Map((await P.query(`SELECT id, name, email FROM users`)).rows.map((u) => [String(u.id), u]));
  const items = await FUP.plan(P, {});
  console.log(`FOLLOW-UP PLAN: ${items.length} first emails sent in the last ${FUP.LOOKBACK_DAYS} days  (${new Date().toISOString().slice(0, 16)} UTC)\n`);
  const tally = { due: 0, notYet: 0, waiting: 0, stopped: 0, done: 0 };
  const byAgent = new Map();
  for (const it of items) {
    const k = it.root.agent_id;
    if (!byAgent.has(k)) byAgent.set(k, []);
    byAgent.get(k).push(it);
  }
  for (const [ag, list] of byAgent) {
    const u = users.get(String(ag)) || {};
    console.log(`== ${u.name || ag} <${u.email || '?'}>  (${list.length})`);
    for (const it of list) {
      let what;
      if (it.stop) { what = `STOPPED: ${it.stop}`; tally.stopped++; }
      else if (it.done) { what = `done: ${it.done}`; tally.done++; }
      else if (it.waiting) { what = `follow-up ${it.next - 1} written, waiting on the agent`; tally.waiting++; }
      else if (it.due) { what = `follow-up ${it.next - 1} DUE NOW: the next pass writes it`; tally.due++; }
      else { what = `follow-up ${it.next - 1} due ${d(it.dueAt)}`; tally.notYet++; }
      console.log(`  ${d(it.root.sent_at)}  ${String(it.root.brand_name || '').slice(0, 34).padEnd(34)} ${String(it.root.sent_to_email || '').slice(0, 30).padEnd(30)} ${what}`);
    }
    console.log('');
  }
  console.log(`SUMMARY  due now ${tally.due}   due later ${tally.notYet}   waiting on agents ${tally.waiting}   stopped ${tally.stopped}   done ${tally.done}`);
}
main().then(() => store.pool.end().catch(() => {})).then(() => process.exit(0))
  .catch((e) => { console.error('follow-up-plan failed:', e && e.stack || e); process.exit(1); });
