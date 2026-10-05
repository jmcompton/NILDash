'use strict';
// ── CARDS WHOSE EMAIL IS NOT THE NAMED PERSON'S ────────────────────────────
//
// A Domino's card read "Greg Neichter, owner" with austin.mitchell@dominos.com:
// the person from one source, somebody else's mailbox from another. The
// builder no longer pairs them (services/outreachQueue.inboxOf); this lists the
// ones already made: waiting on agents' screens, approved and not yet sent, and
// sent in the last 30 days. "Not theirs" = the address carries neither the
// person's first nor last name. Read-only.
//
//   node scripts/contact-mismatch-audit.js
//   /api/admin/scripts/contact-mismatch-audit?text=1
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const Q = require(ROOT + 'server/services/outreachQueue.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const rows = (await P.query(`
    SELECT q.id, q.state, q.brand_name, q.contact_name, COALESCE(l.sent_to_email, q.email) AS email, q.email_kind,
           l.id AS log_id, l.status AS log_status, l.sent_at, q.created_at,
           u.name AS agent, u.email AS agent_email, a.data->>'name' AS athlete
      FROM outreach_queue q
      LEFT JOIN outreach_logs l ON l.id = q.outreach_log_id
      JOIN users u ON u.id = q.agent_id
      LEFT JOIN athletes a ON a.id = q.athlete_id
     WHERE q.contact_name IS NOT NULL AND COALESCE(l.sent_to_email, q.email) IS NOT NULL
       AND (q.state IN ('queued', 'sending') OR l.sent_at > NOW() - INTERVAL '30 days')
     ORDER BY q.created_at DESC`)).rows;
  const bad = rows.filter((r) => !Q.addressIsTheirs(r.email, r.contact_name));
  const waiting = bad.filter((r) => r.state === 'queued' && !(r.log_status === 'approved' || r.sent_at));
  const going = bad.filter((r) => r.log_status === 'approved' && !r.sent_at);
  const sent = bad.filter((r) => r.sent_at);
  console.log(`CONTACT MISMATCH AUDIT  ${new Date().toISOString()}  ${rows.length} cards with a named person and an email checked\n`);
  const show = (title, list) => {
    console.log(`${title}: ${list.length}`);
    for (const r of list) console.log(`   ${r.brand_name}: "${r.contact_name}" <${r.email}>  (${r.athlete || '?'}, agent ${r.agent})${r.sent_at ? '  sent ' + new Date(r.sent_at).toISOString().slice(0, 10) : ''}`);
    console.log('');
  };
  show('1. ON AN AGENT\'S SCREEN NOW, NOT APPROVED', waiting);
  show('2. APPROVED AND NOT YET SENT', going);
  show('3. SENT IN THE LAST 30 DAYS', sent);
  console.log('Not every one is wrong: a person can have an address that does not carry their name (a franchise number, a shared mailbox). Every one is a pairing nothing confirmed.');
}
main()
  .catch((e) => { console.error('contact-mismatch-audit FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => { try { await store.pool.end(); } catch (_) {} });
