#!/usr/bin/env node
'use strict';
// ── NO NAME, NO CARD: THE CARDS ALREADY ON THE QUEUE ────────────────────────
//
//   node scripts/retire-nameless-cards.js              list them (writes nothing)
//   node scripts/retire-nameless-cards.js --apply      retire them
//   node scripts/retire-nameless-cards.js --agent cs@9091sportsagency.com [--apply]
//
// Every QUEUED card whose message greets nobody ("Hi," / "Hi there," / no
// greeting line) or greets someone who is not the contact on the card. The
// nightly job no longer makes these; this clears the ones made before it
// stopped. --apply sets the card to state 'retired' with outcome 'no_name'
// (the same shape the wrong-market retire uses, so it frees the slot for
// tonight and stays for the record) and stops the linked email draft so it
// cannot be approved or sent. Nothing is deleted.

const store = require('../server/store');
const GG = require('../server/services/greetingGuard');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;

process.exitCode = 1;
let settled = false;
process.on('beforeExit', () => { if (!settled) { console.log('retire-nameless-cards: main() never settled. Exiting 1.'); process.exit(1); } });
function fail(where, e) { const m = `retire-nameless-cards: FAILED (${where}): ${e && e.message ? e.message : e}`; console.log(m); console.error(m); settled = true; process.exit(1); }
function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; }
const APPLY = process.argv.includes('--apply');
const text = (html) => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const firstLine = (s) => String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';

// null = fine (greets the named contact); otherwise the reason it must go.
function problemOf(card) {
  const body = card.channel === 'email' ? text(card.draft_body) : String(card.dm_text || '');
  const line = firstLine(body);
  if (!line) return 'empty message';
  const who = GG.addresseeOf(line);
  if (who === null) return `no greeting line (opens "${line.slice(0, 40)}")`;
  if (who === '' || GG.isHonorificOnly(who)) return `greets nobody ("${line}")`;
  if (!card.contact_name) return `greets "${who}" but the card names no contact`;
  const allowed = GG.allowedGreetingNames([{ name: card.contact_name }]);
  if (!allowed.has(String(who).trim().toLowerCase())) return `greets "${who}", not the contact on the card (${card.contact_name})`;
  return null;
}

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const agentEmail = arg('agent', null);
  let agentIds = null;
  if (agentEmail) {
    const u = (await P.query(`SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`, [agentEmail]).catch((e) => fail('users', e))).rows;
    if (!u.length) return fail('args', new Error('no user with email ' + agentEmail));
    agentIds = u.map((x) => x.id);
  }
  const rows = (await P.query(
    `SELECT q.id, q.agent_id, q.athlete_id, q.brand_name, q.lane, q.channel, q.contact_name, q.contact_title, q.dm_text, q.outreach_log_id, q.created_at,
            a.data->>'name' AS athlete_name, u.email AS agent_email, l.body_html AS draft_body
       FROM outreach_queue q
       JOIN athletes a ON a.id = q.athlete_id
       LEFT JOIN users u ON u.id = q.agent_id
       LEFT JOIN outreach_logs l ON l.id = q.outreach_log_id
      WHERE q.state = 'queued' ${agentIds ? 'AND q.agent_id = ANY($1)' : ''}
      ORDER BY u.email, a.data->>'name', q.slot`, agentIds ? [agentIds] : []).catch((e) => fail('queue', e))).rows;
  const bad = rows.map((c) => ({ c, why: problemOf(c) })).filter((x) => x.why);
  console.log(`retire-nameless-cards: ${rows.length} queued card(s)${agentEmail ? ' for ' + agentEmail : ''}, ${bad.length} greet nobody or the wrong person${APPLY ? '' : ' (dry run; add --apply to retire them)'}\n`);
  for (const { c, why } of bad) {
    console.log(`  #${String(c.id).padEnd(6)} ${String(c.agent_email || c.agent_id).padEnd(30)} ${String(c.athlete_name).padEnd(22)} ${String(c.brand_name).slice(0, 34).padEnd(34)} ${String(c.lane || '?').padEnd(8)} ${String(c.channel).padEnd(7)} ${why}`);
  }
  if (APPLY && bad.length) {
    const ids = bad.map((x) => x.c.id);
    const r1 = await P.query(
      `UPDATE outreach_queue SET state = 'retired', outcome = 'no_name', outcome_at = NOW(), updated_at = NOW()
        WHERE id = ANY($1::int[]) AND state = 'queued'`, [ids]).catch((e) => fail('retire', e));
    const logIds = bad.map((x) => x.c.outreach_log_id).filter(Boolean);
    let stopped = 0;
    if (logIds.length) {
      const r2 = await P.query(
        `UPDATE outreach_logs SET cadence_stopped_at = NOW(), cadence_stop_reason = 'retired: no contact name to greet', updated_at = NOW()
          WHERE id = ANY($1::text[]) AND status = 'draft' AND approved_at IS NULL AND cadence_stopped_at IS NULL`, [logIds]).catch((e) => fail('drafts', e));
      stopped = r2.rowCount;
    }
    console.log(`\nRetired ${r1.rowCount} card(s) (state retired, outcome no_name); stopped ${stopped} linked email draft(s). Their slots refill tonight, with a name or not at all.`);
  } else if (!bad.length) {
    console.log('  none. Every queued card greets the person named on it.');
  }
  console.log('\nDone.\n');
  settled = true;
  await P.end().catch(() => {});
  process.exit(0);
}
main().catch((e) => fail('main', e));
