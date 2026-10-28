'use strict';
// ── AUTO-SEND (services/autoSend): WHO HAS IT ON, WHAT IT SENT, THE INVITE ──
//
//   /api/admin/scripts/auto-send?text=1                 status: switch, agents on, the last runs
//   /api/admin/scripts/auto-send?text=1&invite=1        the invite, dry run: who would get it and the email
//   /api/admin/scripts/auto-send?text=1&invite=1&send=1 send the invite (once per agent, ever)
//
// Counts come from auto_send_runs and, for what actually went out, from
// outreach_logs.sent_at on the emails each run approved.
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const AS = require(ROOT + 'server/services/autoSend.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const has = (f) => process.argv.includes(f);

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  await AS.ensureTables(P);
  console.log(`AUTO-SEND  ${new Date().toISOString()}  AUTO_SEND_ON ${AS.ON() ? 'on' : 'OFF'}`);

  if (has('--invite')) {
    const send = has('--send');
    const ex = process.argv.indexOf('--exclude');
    const exclude = ex > -1 ? String(process.argv[ex + 1] || '').split(',') : [];
    const r = await AS.invite(P, { send, exclude });
    if (r.skipped) { console.log(`\nINVITE: not sent. ${r.skipped}.`); return; }
    const go = r.list.filter((x) => !x.notReady && !x.excluded);
    console.log(`\nINVITE ${send ? 'SENT' : 'DRY RUN (add &send=1 to send)'}: ${go.length} agent(s)`);
    for (const x of go) console.log(`  ${x.email}${x.name ? ' (' + x.name + ')' : ''}${x.sent ? '  sent' : ''}${x.error ? '  FAILED: ' + x.error : ''}`);
    const held = r.list.filter((x) => x.notReady);
    if (held.length) console.log(`\nNOT READY, NOT SENT (they get the offer in the nightly email once ready): ${held.length}`);
    for (const x of held) console.log(`  ${x.email}${x.name ? ' (' + x.name + ')' : ''}  [needs: ${x.missing.join('; ')}]`);
    const exd = r.list.filter((x) => x.excluded);
    if (exd.length) console.log(`\nEXCLUDED: ${exd.map((x) => x.email).join(', ')}`);
    if (!send && go.length) {
      const m = AS.inviteFor(go[0], 'https://mynildash.com/auto-send/on?t=<their link>');
      console.log(`\nTHE EMAIL\nSubject: ${m.subject}\n\n${m.text}`);
    }
    return;
  }

  const on = (await P.query(`SELECT id, name, email, auto_send_since FROM users WHERE auto_send_on = TRUE AND archived IS NOT TRUE ORDER BY auto_send_since`)).rows;
  console.log(`\nAGENTS WITH IT ON: ${on.length}`);
  for (const u of on) console.log(`  ${u.name || ''} <${u.email}> since ${u.auto_send_since ? new Date(u.auto_send_since).toISOString().slice(0, 10) : '?'}`);
  const runs = (await P.query(
    `SELECT r.run_date::text AS d, u.email, r.approved, r.offered, r.sent, r.held, r.note, r.emailed_at, r.detail
       FROM auto_send_runs r JOIN users u ON u.id = r.agent_id ORDER BY r.run_date DESC, u.email LIMIT 60`)).rows;
  console.log(`\nLAST RUNS (sent = sent_at set on the approved email)`);
  if (!runs.length) console.log('  (none yet)');
  for (const r of runs) {
    const ids = ((r.detail && r.detail.items) || []).map((x) => x.id);
    const st = await AS.statusOf(P, ids);
    const sentNow = [...st.values()].filter((v) => v === 'sent').length;
    const pending = [...st.values()].filter((v) => v === 'pending').length;
    console.log(`  ${r.d}  ${r.email}  approved ${r.approved} of ${r.offered}  sent ${sentNow}${pending ? `  still sending ${pending}` : ''}`
      + `${r.emailed_at ? '  note emailed' : ''}${r.note ? '  · ' + r.note : ''}`);
  }
}
main().then(() => store.pool.end().catch(() => {}).then(() => process.exit(0)))
  .catch((e) => { console.error(e); process.exit(1); });
