#!/usr/bin/env node
'use strict';
// ── THE TWO THINGS MY BRANDS IS STILL SHOWING ───────────────────────────────
//
//   node scripts/mybrands-cleanup.js                 report only, changes nothing
//   node scripts/mybrands-cleanup.js --fix-owners    repair the owner fields
//   node scripts/mybrands-cleanup.js --delete-placeholders
//   node scripts/mybrands-cleanup.js --fix-owners --delete-placeholders
//
// Or through the admin script runner:
//   /api/admin/scripts/mybrands-cleanup?text=1
//   /api/admin/scripts/mybrands-cleanup?fixOwners=1&deletePlaceholders=1&text=1
//
// READ ONLY BY DEFAULT. It prints what it would do and exits. Nothing is
// deleted or rewritten until a flag says so, because this runs against the
// production database that live customers share.
//
// ── 1. PLACEHOLDER BUSINESS NAMES ───────────────────────────────────────────
// "Local Harrisburg Restaurant (independent)" and its kind are descriptions of
// a category dressed as a business. store.placeholderReason is the rule, and
// it is the SAME function the nightly fill refuses cards with, so this script
// can never disagree with the gate about what a placeholder is.
//
// ── 2. OWNER FIELDS THAT ARE NOT A NAME ─────────────────────────────────────
// services/ownerName is the rule. A value that holds a name with a title
// attached is repaired to the name; a value that is a sentence has the first
// person it names extracted; a value with no person in it is cleared. Every
// decision is printed with the before and the after.

const store = require('../server/store');
const OWN = require('../server/services/ownerName');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 3000;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const FIX_OWNERS = has('--fix-owners');
const DEL_PLACEHOLDERS = has('--delete-placeholders');

// A pg DATE/TIMESTAMP comes back as a Date, whose toString is "Fri Sep 11
// 2026 ...". The day is the whole point of section 1 -- it is what says
// whether these rows predate the gate -- so it is formatted, not stringified.
function day(v) {
  if (!v) return '(no date)';
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
}

function short(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > (n || 70) ? t.slice(0, (n || 70) - 1) + '…' : t;
}

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const pool = store.pool;
  console.log(`\nMY BRANDS CLEANUP  ${new Date().toISOString()}`);
  console.log(FIX_OWNERS || DEL_PLACEHOLDERS
    ? `MODE: WRITING (${[FIX_OWNERS ? '--fix-owners' : null, DEL_PLACEHOLDERS ? '--delete-placeholders' : null].filter(Boolean).join(' ')})`
    : 'MODE: report only. Nothing will be changed. Add --fix-owners and/or --delete-placeholders to act.');

  // ── 1. PLACEHOLDER BUSINESS NAMES ─────────────────────────────────────
  console.log('\n' + '='.repeat(78));
  console.log('1. PLACEHOLDER BUSINESS NAMES');
  const cards = (await pool.query(
    `SELECT id, agent_id, athlete_id, brand_name, state, created_at
       FROM outreach_queue WHERE brand_name IS NOT NULL AND brand_name <> ''
      ORDER BY created_at ASC`)).rows;
  const bad = [];
  for (const c of cards) {
    const why = store.placeholderReason(c.brand_name);
    if (why) bad.push({ ...c, why });
  }
  console.log(`  ${cards.length} card(s) checked, ${bad.length} with a placeholder name.`);
  if (bad.length) {
    // WHEN they were written is the answer to "old rows, or still happening".
    const byDay = new Map();
    for (const b of bad) {
      const d = day(b.created_at);
      byDay.set(d, (byDay.get(d) || 0) + 1);
    }
    console.log('  by the day they were found:');
    for (const [d, n] of [...byDay.entries()].sort()) console.log(`    ${d}  ${n}`);
    const newest = [...byDay.keys()].sort().pop();
    console.log(`  NEWEST: ${newest}. The name gate shipped 2026-09-16 (c46e3e7); anything after that`);
    console.log('  date means a write path is still getting past it and this is NOT just old rows.');
    console.log('  the rows:');
    for (const b of bad.slice(0, 40)) {
      console.log(`    ${day(b.created_at)}  ${short(b.brand_name, 52).padEnd(53)} ${b.why}`);
    }
    if (bad.length > 40) console.log(`    … and ${bad.length - 40} more`);
  }
  if (DEL_PLACEHOLDERS && bad.length) {
    // The DRAFTS these cards produced go too: a draft addressed to a category
    // is not a pitch anybody should be able to approve. Stopped, not deleted,
    // for the same reason a skip is stopped and not deleted.
    const ids = bad.map((b) => b.id);
    const stopped = await pool.query(
      `UPDATE outreach_logs SET cadence_stopped_at = NOW(),
              cadence_stop_reason = 'the business name was a placeholder, not a real business',
              updated_at = NOW()
        WHERE cadence_stopped_at IS NULL AND status = 'draft'
          AND id IN (SELECT outreach_log_id FROM outreach_queue
                      WHERE id = ANY($1::int[]) AND outreach_log_id IS NOT NULL)`,
      [ids]);
    const del = await pool.query(`DELETE FROM outreach_queue WHERE id = ANY($1::int[])`, [ids]);
    console.log(`  DELETED ${del.rowCount} card(s); stopped ${stopped.rowCount || 0} draft(s) they had written.`);
  }

  // ── 2. OWNER FIELDS ───────────────────────────────────────────────────
  console.log('\n' + '='.repeat(78));
  console.log('2. OWNER FIELDS THAT ARE NOT ONE PERSON’S NAME');
  const owners = (await pool.query(
    `SELECT id, agent_id, brand_name, contact_name, contact_title, created_at
       FROM outreach_queue WHERE contact_name IS NOT NULL AND contact_name <> ''
      ORDER BY LENGTH(contact_name) DESC`)).rows;

  // THE NUMBER ASKED FOR, on its own line.
  const over40 = owners.filter((o) => String(o.contact_name).trim().length > OWN.MAX_LEN);
  console.log(`  ${owners.length} card(s) carry an owner name.`);
  console.log(`  LONGER THAN ${OWN.MAX_LEN} CHARACTERS: ${over40.length}`);

  const problems = [];
  for (const o of owners) {
    const why = OWN.problem(o.contact_name, o.brand_name);
    if (!why) continue;
    const fixed = OWN.extract(o.contact_name, o.brand_name);
    problems.push({ ...o, why, fixed });
  }
  console.log(`  NOT A SINGLE PERSON'S NAME: ${problems.length}`);
  const repairable = problems.filter((p) => p.fixed);
  console.log(`    of those, ${repairable.length} hold a name that can be recovered, ${problems.length - repairable.length} do not and would be cleared.`);
  for (const p of problems.slice(0, 40)) {
    console.log(`    ${String(p.contact_name).trim().length.toString().padStart(3)}ch  ${short(p.brand_name, 26).padEnd(27)} ${p.fixed ? '-> ' + p.fixed : '-> (cleared)'}`);
    console.log(`           ${p.why}`);
    console.log(`           was: ${short(p.contact_name, 100)}`);
  }
  if (problems.length > 40) console.log(`    … and ${problems.length - 40} more`);

  if (FIX_OWNERS && problems.length) {
    let repaired = 0, cleared = 0;
    for (const p of problems) {
      await pool.query(`UPDATE outreach_queue SET contact_name = $2, updated_at = NOW() WHERE id = $1`,
        [p.id, p.fixed || null]);
      if (p.fixed) repaired++; else cleared++;
    }
    console.log(`  REPAIRED ${repaired} owner field(s); CLEARED ${cleared} that held no recoverable name.`);
  }

  console.log('');
  if (!FIX_OWNERS && !DEL_PLACEHOLDERS) console.log('Nothing was changed. Re-run with the flags above to act.\n');
  try { await pool.end(); } catch (_) {}
  process.exit(0);
}
main().catch((e) => { console.error('mybrands-cleanup: FAILED', e.message); process.exit(1); });
