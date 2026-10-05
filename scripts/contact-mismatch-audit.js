'use strict';
// ── CARDS WHOSE EMAIL IS NOT THE NAMED PERSON'S, AND WHAT TO DO WITH THEM ──
//
// A Domino's card read "Greg Neichter, owner" with austin.mitchell@dominos.com.
// The builder no longer pairs a person with an address that is not theirs
// (services/outreachQueue.inboxOf). This handles the ones built before that.
//
// Each address that does not carry the named person's name is one of two
// things (outreachQueue.addressKind):
//   OTHER PERSON  clearly another human's mailbox (first.last shaped, not a
//                 role or the shop's own name): "Hi Chris" would go to Sarah.
//                 The card becomes a CALL (if it has a number) or a DM (if it
//                 has a location handle), with the same pitch; the email draft
//                 is withdrawn. Neither: the card is withdrawn.
//   GENERIC       a shop or role inbox, or nothing clearly a person: the
//                 email stays, the first name comes out of the greeting
//                 ("Hi Chris," -> "Hi,").
//
//   1. on agents' screens, not approved     -> fixed with --apply
//   2. approved, not yet sent               -> OTHER PERSON stopped with --apply
//   3. sent in the last 30 days, by agent   -> report only
//
//   node scripts/contact-mismatch-audit.js [--apply]
//   /api/admin/scripts/contact-mismatch-audit?text=1   (&apply=1)
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const Q = require(ROOT + 'server/services/outreachQueue.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const APPLY = process.argv.includes('--apply');

// "Hi Chris," / "Hello Chris Lee," at the top of the first paragraph -> "Hi,".
function dropGreetingName(html) {
  return String(html || '').replace(/^(\s*(?:<p>)?\s*)(hi|hello|hey|dear|good (?:morning|afternoon))\s+[^,<\n]{1,40},/i, '$1Hi,');
}
function htmlToText(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p>/gi, '\n\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const rows = (await P.query(`
    SELECT q.id, q.state, q.channel, q.brand_name, q.contact_name, q.phone, q.instagram, q.instagram_scope, q.dm_text,
           COALESCE(l.sent_to_email, q.email) AS email, l.id AS log_id, l.status AS log_status, l.sent_at, l.subject,
           l.body_html, l.approved_at, l.cadence_stopped_at, q.created_at, q.agent_id,
           u.name AS agent, u.email AS agent_email, a.data->>'name' AS athlete
      FROM outreach_queue q
      LEFT JOIN outreach_logs l ON l.id = q.outreach_log_id
      JOIN users u ON u.id = q.agent_id
      LEFT JOIN athletes a ON a.id = q.athlete_id
     WHERE q.contact_name IS NOT NULL AND COALESCE(l.sent_to_email, q.email) IS NOT NULL
       AND (q.state IN ('queued', 'sending') OR l.sent_at > NOW() - INTERVAL '30 days')
     ORDER BY u.name, q.created_at DESC`)).rows;
  const bad = rows.map((r) => ({ ...r, kind: Q.addressKind(r.email, r.contact_name, r.brand_name) })).filter((r) => r.kind !== 'theirs');
  const onScreenAll = bad.filter((r) => r.state === 'queued' && !r.sent_at && !r.approved_at && r.log_status === 'draft');
  const going = bad.filter((r) => r.approved_at && !r.sent_at && !r.cadence_stopped_at);
  const sent = bad.filter((r) => r.sent_at);
  const label = (k) => (k === 'other-person' ? 'DIFFERENT PERSON' : 'generic inbox');

  console.log(`CONTACT MISMATCH  ${new Date().toISOString()}  ${rows.length} cards with a named person and an email; ${bad.length} not tied together${APPLY ? '  -- APPLYING' : '  -- report only; &apply=1 fixes sections 1 and 2'}\n`);

  // The withdrawals are decided first, so a card that is withdrawn (a
  // university department, a figurehead) is not also converted in section 1.
  const ONS = require(ROOT + 'server/services/ownerNameSearch.js');
  const NAS = require(ROOT + 'server/services/notASponsor.js');
  const heads = (await P.query(`
    SELECT q.id, q.brand_name, q.contact_name, q.contact_title, q.source_note, q.market_key, q.outreach_log_id,
           COALESCE(l.sent_to_email, q.email) AS email, u.name AS agent, a.data->>'name' AS athlete
      FROM outreach_queue q JOIN users u ON u.id = q.agent_id LEFT JOIN athletes a ON a.id = q.athlete_id
      LEFT JOIN outreach_logs l ON l.id = q.outreach_log_id
     WHERE q.state = 'queued' AND q.contact_name IS NOT NULL`)).rows
    .map((r) => {
      const edu = NAS.detect(r.brand_name, { email: r.email });
      if (edu && edu.kind === 'university-department') return { ...r, why: edu.why, kind: 'UNIVERSITY DEPARTMENT' };
      const t = r.contact_title ? ONS.titleProblem(r.contact_title, { brand: r.brand_name, city: (r.market_key || '').split(',')[0] }) : null;
      if (!t) return r;
      return { ...r, why: t, kind: /parent company/.test(t) ? 'CHAIN / CORPORATE PARENT' : 'NEVER A SIGNER (emeritus, board, school leadership)' };
    })
    .filter((r) => r.why);
  const withdrawIds = new Set(heads.map((r) => r.id));

  // ── 1. ON SCREENS ──
  const onScreen = onScreenAll.filter((r) => !withdrawIds.has(r.id));
  const plan = { call: 0, dm: 0, withdrawn: 0, greeting: 0 };
  console.log(`1. ON AN AGENT'S SCREEN NOW, NOT APPROVED: ${onScreen.length}`);
  for (const r of onScreen) {
    let action;
    if (r.kind === 'other-person') {
      const dmable = r.instagram && r.instagram_scope !== 'brand';
      action = r.phone ? 'call' : dmable ? 'dm' : 'withdrawn';
      plan[action]++;
      if (APPLY) {
        if (action === 'withdrawn') {
          await P.query(`UPDATE outreach_queue SET state = 'expired', expired_at = NOW(), outcome = $2, outcome_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [r.id, `withdrawn: ${r.email} is not ${r.contact_name}'s address, and there is no number or handle to reach them`]);
        } else {
          await P.query(`UPDATE outreach_queue SET channel = $2, outreach_log_id = NULL, email = NULL,
                           dm_text = CASE WHEN $2 = 'dm' THEN COALESCE(dm_text, $3) ELSE dm_text END,
                           phone_ask_for = CASE WHEN $2 = 'call' THEN COALESCE(phone_ask_for, $4) ELSE phone_ask_for END,
                           updated_at = NOW() WHERE id = $1`,
            [r.id, action, htmlToText(r.body_html), Q.askFirstName(r.contact_name) || null]);
        }
        await P.query(`UPDATE outreach_logs SET status = 'expired', cadence_stopped_at = NOW(),
                         cadence_stop_reason = $2, updated_at = NOW() WHERE id = $1 AND status = 'draft'`,
          [r.log_id, `contact check: ${r.email} is not ${r.contact_name}'s address`]);
      }
    } else {
      action = 'greeting';
      plan.greeting++;
      if (APPLY) {
        await P.query(`UPDATE outreach_logs SET body_html = $2, updated_at = NOW() WHERE id = $1 AND status = 'draft'`, [r.log_id, dropGreetingName(r.body_html)]);
      }
    }
    const what = action === 'greeting' ? 'keep the email, greeting "Hi,"' : action === 'withdrawn' ? 'WITHDRAW (no number, no handle)' : `make it a ${action.toUpperCase()}`;
    console.log(`   [${label(r.kind)}] ${r.brand_name}: "${r.contact_name}" <${r.email}>  (${r.athlete || '?'}, agent ${r.agent})  -> ${what}`);
  }
  console.log(`   -> ${plan.call} to calls, ${plan.dm} to DMs, ${plan.withdrawn} withdrawn, ${plan.greeting} kept with the first name dropped${APPLY ? '  (DONE)' : ''}\n`);

  // ── 1b. FIGUREHEADS ON SCREENS ──
  // A parent company's founder / CEO named for a local franchise or chain
  // location (ownerNameSearch.titleProblem with the chain context): Ernest
  // Garcia III for Carvana Tempe. Nobody we can re-find instantly, so the card
  // is withdrawn and the slot fills again tonight.
  console.log(`1b. WITHDRAWN FROM SCREENS: a chain's or corporate parent's leadership, someone who never signs, or a university department: ${heads.length}`);
  for (const r of heads) {
    console.log(`   [${r.kind}] ${r.brand_name}: "${r.contact_name}", ${r.contact_title || 'no title'} <${r.email || ''}>  (${r.athlete || '?'}, agent ${r.agent})  -> WITHDRAW`);
    console.log(`      ${r.why}`);
    if (APPLY) {
      await P.query(`UPDATE outreach_queue SET state = 'expired', expired_at = NOW(), outcome = $2, outcome_at = NOW(), updated_at = NOW() WHERE id = $1 AND state = 'queued'`,
        [r.id, 'withdrawn: ' + r.why]);
      if (r.outreach_log_id) await P.query(`UPDATE outreach_logs SET status = 'expired', cadence_stopped_at = NOW(), cadence_stop_reason = $2, updated_at = NOW() WHERE id = $1 AND status = 'draft'`,
        [r.outreach_log_id, 'contact check: ' + r.why]);
    }
  }
  console.log(`   ${APPLY ? '(DONE)' : ''}\n`);

  // ── 2. APPROVED, NOT SENT ──
  console.log(`2. APPROVED AND NOT YET SENT: ${going.length}`);
  for (const r of going) {
    const stop = r.kind === 'other-person';
    if (APPLY && stop) {
      await P.query(`UPDATE outreach_logs SET cadence_stopped_at = NOW(), cadence_stop_reason = $2, updated_at = NOW()
                      WHERE id = $1 AND sent_at IS NULL`, [r.log_id, `contact check: ${r.email} is not ${r.contact_name}'s address`]);
    }
    if (APPLY && !stop) {
      await P.query(`UPDATE outreach_logs SET body_html = $2, updated_at = NOW() WHERE id = $1 AND sent_at IS NULL`, [r.log_id, dropGreetingName(r.body_html)]);
    }
    console.log(`   [${label(r.kind)}] ${r.brand_name}: "${r.contact_name}" <${r.email}>  (agent ${r.agent})  -> ${stop ? 'STOP' : 'greeting "Hi,"'}`);
  }
  console.log('');

  // ── 3. SENT, BY AGENT ──
  const byAgent = new Map();
  for (const r of sent) { const k = `${r.agent} <${r.agent_email}>`; if (!byAgent.has(k)) byAgent.set(k, []); byAgent.get(k).push(r); }
  const nOther = sent.filter((r) => r.kind === 'other-person').length;
  console.log(`3. ALREADY SENT IN THE LAST 30 DAYS: ${sent.length}  (${nOther} to a DIFFERENT PERSON, ${sent.length - nOther} to a generic inbox)`);
  for (const [agent, list] of byAgent) {
    const o = list.filter((r) => r.kind === 'other-person').length;
    console.log(`\n   ${agent}: ${list.length} (${o} to a different person)`);
    for (const r of list.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'other-person' ? -1 : 1))) {
      console.log(`     [${label(r.kind)}] ${new Date(r.sent_at).toISOString().slice(0, 10)}  ${r.brand_name}: greeted "${r.contact_name}", sent to <${r.email}>  (${r.athlete || '?'})  "${r.subject || ''}"`);
    }
  }
  console.log('\n"Different person" = the address is shaped like another named human\'s (first.last). "Generic" = a shop, role or numbered inbox, or not clearly a person.');
}
main()
  .catch((e) => { console.error('contact-mismatch-audit FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => { try { await store.pool.end(); } catch (_) {} });
