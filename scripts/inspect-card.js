#!/usr/bin/env node
'use strict';
// ── WHY DOES THIS CARD SAY WHAT IT SAYS ──────────────────────────────────────
//
//   node scripts/inspect-card.js "Deep Water"
//   node scripts/inspect-card.js "Deep Water" --agent cs@9091sportsagency.com
//
// Report only. Writes nothing. For every queue card whose business name
// contains the text: when it was made, the lane and channel, the contact on
// the card and where the name came from, the first line of the DM or of the
// linked email draft (the greeting), and what the run row recorded for that
// business that night (the attempt, its result and reason, the last-door
// search, whether the writer was retried or the greeting repaired). That is
// enough to say which path let a "Hi," through.

const store = require('../server/store');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;

process.exitCode = 1;
let settled = false;
process.on('beforeExit', () => { if (!settled) { console.log('inspect-card: main() never settled. Exiting 1.'); process.exit(1); } });
function fail(where, e) { const m = `inspect-card: FAILED (${where}): ${e && e.message ? e.message : e}`; console.log(m); console.error(m); settled = true; process.exit(1); }
function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; }
const needle = process.argv.slice(2).find((a) => !a.startsWith('--')) || '';
const firstLine = (s) => { const t = String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&'); const l = t.split('\n').map((x) => x.trim()).find(Boolean); return l || '(empty)'; };

async function main() {
  if (!needle) return fail('args', new Error('name part of the business, e.g. node scripts/inspect-card.js "Deep Water"'));
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const agentEmail = arg('agent', null);
  let agentIds = null;
  if (agentEmail) {
    const u = (await P.query(`SELECT id FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))`, [agentEmail]).catch((e) => fail('users', e))).rows;
    if (!u.length) return fail('args', new Error('no user with email ' + agentEmail));
    agentIds = u.map((x) => x.id);
  }
  const cards = (await P.query(
    `SELECT q.*, a.data->>'name' AS athlete_name, u.email AS agent_email,
            l.body_html AS draft_body, l.status AS draft_status, l.cadence_stopped_at AS draft_stopped, l.approved_at AS draft_approved
       FROM outreach_queue q
       JOIN athletes a ON a.id = q.athlete_id
       LEFT JOIN users u ON u.id = q.agent_id
       LEFT JOIN outreach_logs l ON l.id = q.outreach_log_id
      WHERE q.brand_name ILIKE $1 ${agentIds ? 'AND q.agent_id = ANY($2)' : ''}
      ORDER BY q.created_at DESC LIMIT 20`, agentIds ? ['%' + needle + '%', agentIds] : ['%' + needle + '%']).catch((e) => fail('queue', e))).rows;
  console.log(`inspect-card: ${cards.length} card(s) matching "${needle}"${agentEmail ? ' for ' + agentEmail : ''}\n`);
  for (const c of cards) {
    const greeting = c.channel === 'email' ? firstLine(c.draft_body) : firstLine(c.dm_text);
    console.log(`#${c.id}  ${c.brand_name}  for ${c.athlete_name} (${c.agent_email || c.agent_id})`);
    console.log(`   made ${new Date(c.created_at).toISOString()}  state=${c.state}${c.outcome ? ' outcome=' + c.outcome : ''}  lane=${c.lane || '(unknown)'}  channel=${c.channel}  slot=${c.slot}`);
    console.log(`   contact: ${c.contact_name || '(none)'}${c.contact_title ? ', ' + c.contact_title : ''}${c.affiliation_scope ? '  scope=' + c.affiliation_scope : ''}`);
    if (c.source_note) console.log(`   source:  ${String(c.source_note).slice(0, 160)}`);
    console.log(`   greeting: "${greeting}"${c.channel === 'email' ? `  (draft ${c.outreach_log_id || '(none)'} ${c.draft_status || ''}${c.draft_stopped ? ' stopped' : ''}${c.draft_approved ? ' approved' : ''})` : ''}`);
    const who = greeting.replace(/^(hi|hello|hey|dear)\s*/i, '').replace(/[,:]\s*$/, '').trim();
    console.log(`   verdict:  ${!who ? 'GREETS NOBODY' : (c.contact_name && String(c.contact_name).toLowerCase().includes(who.toLowerCase()) ? 'greets the contact on the card' : 'greets "' + who + '", which is not the contact on the card')}`);
    // The night it was made, from the run row: the attempt for this business.
    const runs = (await P.query(
      `SELECT run_date, details FROM outreach_queue_runs
        WHERE agent_id = $1 AND finished_at >= $2::timestamptz - INTERVAL '1 day' AND finished_at <= $2::timestamptz + INTERVAL '1 day'
        ORDER BY finished_at DESC`, [c.agent_id, c.created_at]).catch(() => ({ rows: [] }))).rows;
    let shown = 0;
    for (const r of runs) {
      for (const d of (Array.isArray(r.details) ? r.details : [])) {
        if (d.athleteId !== c.athlete_id) continue;
        for (const t of (Array.isArray(d.tried) ? d.tried : [])) {
          if (!t || String(t.brand || '').toLowerCase() !== String(c.brand_name || '').toLowerCase()) continue;
          shown++;
          console.log(`   run ${String(r.run_date).slice(0, 10)}: result=${t.result}${t.reason ? ' reason=' + JSON.stringify(t.reason).slice(0, 140) : ''}${t.lane ? ' lane=' + t.lane : ''}`
            + `${t.why && t.why.finalName ? '  last-door=' + t.why.finalName.name + ' (' + t.why.finalName.title + ', ' + t.why.finalName.query + ')' : ''}`
            + `${typeof t.writerRetried === 'boolean' ? '  writerRetried=' + t.writerRetried : ''}${t.greetingRepaired ? '  greetingRepaired from ' + JSON.stringify(t.greetingRepaired) : ''}`);
        }
      }
    }
    if (!shown) console.log('   run row: no attempt recorded for this business around that date (an on-demand fill records no run row; or the card predates the run-row detail)');
    console.log('');
  }
  if (!cards.length) console.log('Nothing matched. The business name on the card may differ; try a shorter part of it.');
  console.log('Done.\n');
  settled = true;
  await P.end().catch(() => {});
  process.exit(0);
}
main().catch((e) => fail('main', e));
