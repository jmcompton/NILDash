'use strict';
// ── EVERY REAL OUTCOME THIS PRODUCT HAS EVER PRODUCED ───────────────────────
//
// "Of the 52 contacted and 2 responded: who were they, which agents, and what
// happened next." Read-only. Five sections:
//
//   0  the ledger by state (brand_engagement), so the counts reconcile
//   1  EVERY business past "shown" in the ledger (contacted, responded,
//      closed, dead), grouped by agent, each with its timeline after contact:
//      the card, every email touch, every reply and what it said, why the
//      follow-ups stopped, the Pipeline stage history, and any logged deal
//   2  replies and outcomes the ledger never heard about (an email reply, a
//      card marked replied, on a business whose ledger row says otherwise)
//   3  the Pipeline past Outreach Sent, with where each row came from
//      (a row the agent typed in is their deal, not one this product found)
//   4  every logged deal (deal_outcomes)
//
// Internal and test accounts (services/coldAgent.isInternal) are marked
// [INTERNAL], not hidden, so nothing real can be filtered out by mistake.
//
//   node scripts/real-outcomes.js
//   /api/admin/scripts/real-outcomes?text=1
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

const d = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '?');
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n || 160);
const norm = (s) => String(s || '').toLowerCase().trim();

async function q(P, sql, params) {
  try { return (await P.query(sql, params)).rows; } catch (e) { return { error: e.message }; }
}
const rowsOf = (r) => (Array.isArray(r) ? r : []);

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  let internalOf = () => null;
  try { const CA = require(ROOT + 'server/services/coldAgent.js'); if (CA.isInternal) internalOf = (u) => CA.isInternal(u, {}); } catch (_) {}

  const users = new Map(rowsOf(await q(P, `SELECT id, name, email FROM users`)).map((u) => [String(u.id), u]));
  const athletes = new Map(rowsOf(await q(P, `SELECT id, agent_id, data->>'name' AS name, data->>'school' AS school FROM athletes`)).map((a) => [String(a.id), a]));
  const agentLabel = (id) => {
    const u = users.get(String(id));
    if (!u) return `agent ${id || '?'} (no user row)`;
    const inner = internalOf(u);
    return `${u.name || '(no name)'} <${u.email || '?'}>` + (inner ? '  [INTERNAL: ' + inner + ']' : '');
  };
  const athName = (id) => { const a = athletes.get(String(id)); return a ? `${a.name || id}${a.school ? ' (' + a.school + ')' : ''}` : `athlete ${id}`; };

  console.log(`EVERY REAL OUTCOME, as of ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n`);

  // ── 0. THE LEDGER BY STATE ───────────────────────────────────────────────
  const counts = rowsOf(await q(P, `SELECT state, COUNT(*)::int n, COUNT(*) FILTER (WHERE outcome IS NOT NULL)::int with_outcome FROM brand_engagement GROUP BY 1 ORDER BY 2 DESC`));
  console.log('0. THE LEDGER (brand_engagement) BY STATE');
  for (const c of counts) console.log(`   ${String(c.state).padEnd(11)} ${String(c.n).padStart(6)}${c.with_outcome ? `   (${c.with_outcome} with an outcome)` : ''}`);
  console.log('   (closed = a deal signed. retired = skipped on the card. shown = never contacted.)\n');

  // ── 1. EVERY BUSINESS PAST "SHOWN" ───────────────────────────────────────
  const led = rowsOf(await q(P, `
    SELECT * FROM brand_engagement
     WHERE state IN ('contacted', 'responded', 'closed', 'dead') OR outcome IS NOT NULL
     ORDER BY agent_id, athlete_id, COALESCE(contacted_at, updated_at)`));
  const seen = new Set();     // athlete|brand pairs covered here, for section 2
  const tally = { replies: 0, declined: 0, signed: 0, nothing: 0 };
  const realList = [];
  console.log(`1. EVERY BUSINESS CONTACTED OR BEYOND: ${led.length}, by agent\n`);
  const byAgent = new Map();
  for (const r of led) {
    const ag = r.agent_id || (athletes.get(String(r.athlete_id)) || {}).agent_id || null;
    if (!byAgent.has(ag)) byAgent.set(ag, []);
    byAgent.get(ag).push(r);
  }
  for (const [ag, rows] of byAgent) {
    console.log(`== ${agentLabel(ag)}  (${rows.length})`);
    for (const r of rows) {
      seen.add(String(r.athlete_id) + '|' + norm(r.brand_name));
      console.log(`  ${athName(r.athlete_id)}  ->  ${r.brand_name || r.brand_key}  [${r.lane || '?'}]`);
      console.log(`     ledger: ${r.state}${r.outcome ? ' / ' + r.outcome : ''}; contacted ${d(r.contacted_at)}${r.contacted_via ? ' via ' + r.contacted_via : ''}${r.source ? '; source ' + r.source : ''}`);
      const ev = [];
      const cards = rowsOf(await q(P, `
        SELECT id, state, channel, sent_via, sent_at, contact_name, contact_title, email, outcome, outcome_at, replied_at, created_at
          FROM outreach_queue
         WHERE athlete_id = $1 AND (brand_key = $2 OR LOWER(TRIM(brand_name)) = $3) ORDER BY created_at`,
        [r.athlete_id, r.brand_key, norm(r.brand_name)]));
      for (const c of cards) {
        ev.push([c.created_at, `card made (${c.channel || '?'}) for ${c.contact_name || 'no name'}${c.contact_title ? ', ' + c.contact_title : ''}${c.email ? ' <' + c.email + '>' : ''}; now ${c.state}`]);
        if (c.sent_at) ev.push([c.sent_at, `card sent via ${c.sent_via || c.channel || '?'}`]);
        if (c.replied_at) ev.push([c.replied_at, 'card: REPLIED']);
        if (c.outcome) ev.push([c.outcome_at || c.replied_at, `card outcome marked: ${c.outcome.toUpperCase()}`]);
      }
      const mails = rowsOf(await q(P, `
        SELECT id, touch_no, status, sent_to_email, sent_at, replied_at, reply_from, reply_subject, reply_text,
               last_inbound_kind, last_inbound_at, cadence_stopped_at, cadence_stop_reason, reply_handled_at, follow_up_count
          FROM outreach_logs
         WHERE athlete_id = $1 AND (brand_key = $2 OR LOWER(TRIM(brand_name)) = $3) ORDER BY COALESCE(sent_at, created_at)`,
        [r.athlete_id, r.brand_key, norm(r.brand_name)]));
      let replied = false;
      for (const m of mails) {
        if (m.sent_at) ev.push([m.sent_at, `email touch ${m.touch_no || 1} sent to ${m.sent_to_email || '?'}`]);
        else ev.push([m.cadence_stopped_at || null, `email touch ${m.touch_no || 1} never sent (${m.status}${m.cadence_stop_reason ? ': ' + m.cadence_stop_reason : ''})`]);
        if (m.replied_at) {
          replied = true;
          ev.push([m.replied_at, `EMAIL REPLY from ${m.reply_from || '?'}${m.reply_subject ? ' "' + clip(m.reply_subject, 60) + '"' : ''}: ${m.reply_text ? '"' + clip(m.reply_text, 220) + '"' : '(no text kept)'}`]);
        } else if (m.last_inbound_at) {
          ev.push([m.last_inbound_at, `inbound mail, not a reply: ${m.last_inbound_kind || 'unknown kind'}`]);
        }
        if (m.sent_at && m.cadence_stopped_at) ev.push([m.cadence_stopped_at, `follow-ups stopped: ${m.cadence_stop_reason || 'no reason kept'}`]);
        if (m.reply_handled_at) ev.push([m.reply_handled_at, 'agent marked the reply handled']);
      }
      const pipe = rowsOf(await q(P, `
        SELECT stage, stage_history, value, source, created_at FROM athlete_self_deals
         WHERE athlete_id = $1 AND LOWER(TRIM(brand_name)) = $2`, [r.athlete_id, norm(r.brand_name)]));
      for (const p of pipe) {
        const hist = Array.isArray(p.stage_history) ? p.stage_history : [];
        if (hist.length) for (const h of hist) ev.push([h.date || null, `pipeline -> ${h.stage}${h.note ? ' (' + clip(h.note, 80) + ')' : ''}`]);
        else ev.push([p.created_at, `pipeline row at ${p.stage} (source ${p.source || '?'})`]);
      }
      const deals = rowsOf(await q(P, `
        SELECT id, deal_value, deliverable, closed_at, undone_at FROM deal_outcomes
         WHERE athlete_id = $1 AND (brand_key = $2 OR LOWER(TRIM(brand)) = $3)`, [r.athlete_id, r.brand_key, norm(r.brand_name)]));
      for (const x of deals) ev.push([x.closed_at, `DEAL LOGGED${x.deal_value ? ' $' + x.deal_value : ' (no value)'}${x.deliverable ? ' - ' + clip(x.deliverable, 80) : ''}${x.undone_at ? ' (UNDONE)' : ''}`]);

      ev.sort((a, b) => (a[0] ? new Date(a[0]) : 0) - (b[0] ? new Date(b[0]) : 0));
      if (!ev.length) console.log('     next: nothing recorded after the contact');
      for (const [t, what] of ev) console.log(`     ${d(t)}  ${what}`);

      const signed = deals.some((x) => !x.undone_at) || r.state === 'closed' || cards.some((c) => c.outcome === 'closed');
      const declined = r.outcome === 'declined' || cards.some((c) => c.outcome === 'declined');
      const anyReply = replied || r.state === 'responded' || cards.some((c) => c.replied_at || c.outcome === 'replied');
      if (signed) { tally.signed++; realList.push(['DEAL', ag, r]); }
      else if (declined) { tally.declined++; realList.push(['DECLINED', ag, r]); }
      else if (anyReply) { tally.replies++; realList.push(['REPLY', ag, r]); }
      else tally.nothing++;
    }
    console.log('');
  }

  // ── 2. OUTCOMES THE LEDGER NEVER HEARD ABOUT ─────────────────────────────
  console.log('2. REPLIES AND OUTCOMES OUTSIDE THE LEDGER (not in section 1)');
  const loose = [];
  for (const m of rowsOf(await q(P, `
      SELECT agent_id, athlete_id, brand_name, sent_to_email, sent_at, replied_at, reply_from, reply_text, last_inbound_kind, source
        FROM outreach_logs WHERE replied_at IS NOT NULL ORDER BY replied_at`))) {
    if (seen.has(String(m.athlete_id) + '|' + norm(m.brand_name))) continue;
    loose.push(m);
    console.log(`  ${d(m.replied_at)}  ${agentLabel(m.agent_id)}\n     ${athName(m.athlete_id)} -> ${m.brand_name}: email reply from ${m.reply_from || '?'}${m.reply_text ? ': "' + clip(m.reply_text, 220) + '"' : ''}  (sent ${d(m.sent_at)}, source ${m.source || '?'})`);
  }
  for (const c of rowsOf(await q(P, `
      SELECT agent_id, athlete_id, brand_name, channel, sent_at, replied_at, outcome, outcome_at
        FROM outreach_queue WHERE replied_at IS NOT NULL OR outcome IS NOT NULL ORDER BY COALESCE(replied_at, outcome_at)`))) {
    if (seen.has(String(c.athlete_id) + '|' + norm(c.brand_name))) continue;
    loose.push(c);
    console.log(`  ${d(c.replied_at || c.outcome_at)}  ${agentLabel(c.agent_id)}\n     ${athName(c.athlete_id)} -> ${c.brand_name}: card ${c.outcome ? 'marked ' + c.outcome : 'replied'} (${c.channel || '?'}, sent ${d(c.sent_at)})`);
  }
  if (!loose.length) console.log('  none');
  console.log('');

  // ── 3. THE PIPELINE PAST OUTREACH SENT ───────────────────────────────────
  console.log('3. PIPELINE ROWS PAST "OUTREACH SENT" (source says whether this product found it or the agent typed it in)');
  const pipe = rowsOf(await q(P, `
    SELECT agent_id, athlete_id, brand_name, stage, value, source, created_at, updated_at FROM athlete_self_deals
     WHERE stage IN ('Negotiating', 'Closing', 'Closed', 'negotiating', 'closing', 'closed', 'Closed Won', 'Signed')
     ORDER BY agent_id, updated_at`));
  if (!pipe.length) console.log('  none');
  for (const p of pipe) console.log(`  ${String(p.stage).padEnd(12)} ${athName(p.athlete_id)} -> ${p.brand_name}${p.value ? ' $' + p.value : ''}  source ${p.source || '(none: typed in)'}; ${d(p.created_at)} -> ${d(p.updated_at)}\n     ${agentLabel(p.agent_id)}`);
  console.log('');

  // ── 4. EVERY LOGGED DEAL ─────────────────────────────────────────────────
  console.log('4. EVERY LOGGED DEAL (deal_outcomes)');
  const dl = rowsOf(await q(P, `SELECT * FROM deal_outcomes ORDER BY closed_at`));
  if (!dl.length) console.log('  none: no deal has ever been logged');
  for (const x of dl) console.log(`  ${d(x.closed_at)}  ${athName(x.athlete_id)} -> ${x.brand}${x.deal_value ? ' $' + x.deal_value : ' (no value)'}${x.deliverable ? ' - ' + clip(x.deliverable, 80) : ''}${x.undone_at ? ' UNDONE' : ''}\n     ${agentLabel(x.agent_id)}`);
  console.log('');

  // ── SUMMARY ──────────────────────────────────────────────────────────────
  console.log('SUMMARY');
  console.log(`  contacted or beyond in the ledger: ${led.length}`);
  console.log(`    deal signed: ${tally.signed}   replied, no: ${tally.declined}   replied: ${tally.replies}   nothing recorded after contact: ${tally.nothing}`);
  console.log(`  replies/outcomes outside the ledger: ${loose.length}   pipeline past Outreach Sent: ${pipe.length}   logged deals: ${dl.length}`);
  if (realList.length) {
    console.log('\n  THE REAL OUTCOMES, one line each:');
    for (const [kind, ag, r] of realList) {
      const u = users.get(String(ag)) || {};
      console.log(`    ${kind.padEnd(8)} ${d(r.outcome_at || r.updated_at)}  ${r.brand_name} for ${athName(r.athlete_id)}  - ${u.name || ag}${internalOf(u) ? ' [INTERNAL]' : ''}`);
    }
  }
}

main().then(() => store.pool.end().catch(() => {})).then(() => process.exit(0))
  .catch((e) => { console.error('real-outcomes failed:', e && e.stack || e); process.exit(1); });
