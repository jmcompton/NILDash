'use strict';
// A mailbox marked disconnected (services/emailStore's own state): it is not
// deleted, its threads stay, the preflight stops checking it, and nothing is
// sent from it until the agent reconnects. Dry run unless --apply.
//
//   node scripts/disconnect-mailbox.js --email johnharrison460@gmail.com [--apply]
//   /api/admin/scripts/disconnect-mailbox?email=johnharrison460@gmail.com&text=1            dry run
//   /api/admin/scripts/disconnect-mailbox?email=johnharrison460@gmail.com&apply=1&text=1    do it
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : null; };

async function run(pool, email, apply) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return { ok: false, lines: ['--email is required'] };
  const rows = (await pool.query(
    `SELECT a.id, a.user_id, a.provider, a.email_address, COALESCE(a.status, 'active') AS status, u.name, u.email AS login
       FROM email_accounts a JOIN users u ON u.id = a.user_id
      WHERE LOWER(a.email_address) = $1 OR LOWER(u.email) = $1 ORDER BY a.id`, [e])).rows;
  const L = [`${apply ? 'DISCONNECT' : 'DRY RUN (add apply=1 to do it)'}: mailboxes for ${e}`];
  if (!rows.length) { L.push('  none found'); return { ok: true, lines: L, changed: 0 }; }
  const MN = require(ROOT + 'server/services/mailboxNotice.js');
  let changed = 0;
  for (const r of rows) {
    const c = await MN.consequence(pool, r.user_id);
    L.push(`  ${r.provider} ${r.email_address} (agent ${r.name || r.login}): ${r.status}; ${c.queued} card(s) waiting, ${c.approved} approval(s) not sent`);
    if (r.status === 'disconnected') continue;
    if (apply) {
      await pool.query(`UPDATE email_accounts SET status = 'disconnected', updated_at = NOW() WHERE id = $1`, [r.id]);
      await MN.clear(pool, r.id).catch(() => {});
      changed++;
      L.push('    -> disconnected');
    } else L.push('    -> would be disconnected');
  }
  return { ok: true, lines: L, changed };
}

if (require.main === module) {
  (async () => {
    await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
    const out = await run(store.pool, arg('email'), arg('apply') === true);
    console.log(out.lines.join('\n'));
    process.exit(out.ok ? 0 : 1);
  })().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
module.exports = { run };
