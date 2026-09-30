'use strict';
// ── UNSENT DRAFTS SIGNED WITH THE LOGIN EMAIL ───────────────────────────────
//
// The outreach workflow signed every draft with users.email (the login) while
// the send went out from the connected mailbox. New drafts are signed with the
// sending mailbox (emailStore.sendingMailbox). Drafts already written still
// carry the login address in their stored body -- which the agent reads in
// every preview AND which would go to the business in the email.
//
// This rewrites ONLY the exact signature line the workflow generated,
//   <div><a href="mailto:LOGIN" style="color:#1a73e8;text-decoration:none">LOGIN</a></div>
// in drafts that have not been sent (status draft or approved, sent_at null),
// for agents whose connected sending mailbox is a DIFFERENT address. The line
// becomes the sending mailbox. An agent with no mailbox keeps the signup email,
// which is the right fallback, so those drafts are not wrong and not counted.
// Nothing else in a body is touched; a line an agent typed themselves does not
// match and is left alone.
//
// The report is the count to decide on: fix the line in place with --apply, or
// regenerate the drafts instead.
//
//   node scripts/fix-draft-sender.js            report only
//   node scripts/fix-draft-sender.js --apply
//   /api/admin/scripts/fix-draft-sender?text=1  (&apply=1)
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const emailStore = require(ROOT + 'server/services/emailStore.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const APPLY = process.argv.includes('--apply');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sigLine = (addr) => `<div><a href="mailto:${addr}" style="color:#1a73e8;text-decoration:none">${addr}</a></div>`;

// The rewritten body, or null when this body has no generated login line.
function rewrite(body, login, mailbox) {
  if (!body || !login || !mailbox) return null;
  const re = new RegExp(esc(sigLine(login)), 'g');
  if (!re.test(body)) return null;
  if (mailbox && mailbox.toLowerCase() === login.toLowerCase()) return null;   // already right
  return body.replace(re, sigLine(mailbox));
}

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const rows = (await P.query(
    `SELECT l.id, l.agent_id, l.brand_name, l.status, l.body_html, u.email AS login, u.name
       FROM outreach_logs l JOIN users u ON u.id = l.agent_id
      WHERE l.status IN ('draft', 'approved') AND l.sent_at IS NULL AND u.email IS NOT NULL`)).rows;
  const mailboxOf = new Map();
  const changes = [];
  for (const r of rows) {
    if (!mailboxOf.has(r.agent_id)) mailboxOf.set(r.agent_id, await emailStore.sendingMailbox(r.agent_id).catch(() => null));
    const mb = mailboxOf.get(r.agent_id);
    const next = rewrite(r.body_html, r.login, mb && mb.address);
    if (next !== null) changes.push({ ...r, next, mailbox: mb && mb.address });
  }
  const byAgent = new Map();
  for (const c of changes) {
    const k = `${c.name || c.agent_id} <${c.login}>`;
    if (!byAgent.has(k)) byAgent.set(k, { mailbox: c.mailbox, n: 0, draft: 0, approved: 0 });
    byAgent.get(k).n++; byAgent.get(k)[c.status === 'approved' ? 'approved' : 'draft']++;
  }
  console.log(`UNSENT DRAFTS SIGNED WITH THE LOGIN EMAIL  ${APPLY ? 'APPLY' : 'report only (add --apply to change them)'}`);
  console.log(`${changes.length} of ${rows.length} unsent draft(s) carry the signup email while outreach sends from another mailbox, across ${byAgent.size} agent(s)`);
  for (const [k, v] of byAgent) {
    console.log(`  ${k}: ${v.n} draft(s) (${v.draft} awaiting approval, ${v.approved} approved not yet sent) -> should say ${v.mailbox}`);
  }
  if (APPLY && changes.length) {
    let n = 0;
    for (const c of changes) {
      const u = await P.query(`UPDATE outreach_logs SET body_html = $2, updated_at = NOW()
                                WHERE id = $1 AND sent_at IS NULL AND body_html = $3`, [c.id, c.next, c.body_html]);
      n += u.rowCount;
    }
    console.log(`updated ${n} draft(s)`);
  }
  try { await P.end(); } catch (_) {}
  process.exit(0);
}
if (require.main === module) main().catch((e) => { console.error('fix-draft-sender: FAILED', e.message); process.exit(1); });
module.exports = { rewrite, sigLine };
