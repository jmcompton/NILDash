#!/usr/bin/env node
'use strict';
// ── ONE BUSINESS, ONE CARD PER ATHLETE ───────────────────────────────────────
//
//   node scripts/clear-duplicate-cards.js                 dry run, changes nothing
//   node scripts/clear-duplicate-cards.js --apply
//   node scripts/clear-duplicate-cards.js --apply --agent <id|email>
//   node scripts/clear-duplicate-cards.js --apply --backfill-keys
//
// The identity dedupe stops NEW duplicates. This clears the ones already queued
// and already drafted, grouping on brandIdentity -- the same function the slate
// and the unique index now use, so this script and the running product cannot
// disagree about what "the same business" means.
//
// NOT A DELETE, the same stance as clear-unaddressed-cards. Each losing row is a
// real card someone was paid to research and write; the reason there are two is
// a comparison bug, not anything wrong with either copy. So:
//
//   outreach_queue   state -> 'duplicate', with a note naming the winner.
//   outreach_logs    cadence_stopped_at + reason, which is what buildHome
//                    already filters on.
//
// Both are one UPDATE to reverse, printed at the end.
//
// WHICH COPY WINS. The oldest queued row for a business, because the agent may
// already have looked at it, and its slot is the one the ledger and any
// follow-up refer to. For drafts, the one with an address beats one without,
// then the oldest -- a draft that can actually be sent is worth more than its
// twin.
//
// --backfill-keys also writes identity_key onto surviving queued rows, so the
// new unique index has something to enforce on rows that predate it.

const path = require('path');

const QUEUE_STATE = 'duplicate';
const LOG_REASON = 'duplicate of another card for this athlete';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

(async () => {
  const apply = process.argv.includes('--apply');
  const backfill = process.argv.includes('--backfill-keys');
  const who = arg('agent', null);

  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    console.error('DATABASE_URL is not set, so this would act on the wrong database.');
    process.exit(1);
  }
  const ROOT = path.join(__dirname, '..');
  const store = require(path.join(ROOT, 'server', 'store'));
  const BI = require(path.join(ROOT, 'server', 'services', 'brandIdentity'));
  const pool = store.pool;

  let agentId = null;
  if (who) {
    const r = await pool.query(
      `SELECT id FROM users WHERE id = $1 OR LOWER(email) = LOWER($1)`, [who]);
    if (!r.rows[0]) { console.error('No agent matches ' + who); process.exit(1); }
    agentId = r.rows[0].id;
  }

  // Group a set of rows by identity, scoped per athlete. Returns groups of two
  // or more only -- a single card is not a duplicate of anything.
  const groupByIdentity = (rows, marketByAthlete) => {
    const groups = new Map();
    for (const r of rows) {
      const ids = BI.identitiesOf(r, { market: marketByAthlete.get(r.athlete_id) || null });
      if (!ids.length) continue;
      // Join on ANY shared identity: find an existing group this row touches.
      let g = null;
      for (const id of ids) {
        const key = r.athlete_id + '|' + id.key;
        if (groups.has(key)) { g = groups.get(key); break; }
      }
      if (!g) g = { rows: [], basis: ids[0].basis };
      g.rows.push(r);
      for (const id of ids) groups.set(r.athlete_id + '|' + id.key, g);
    }
    return [...new Set(groups.values())].filter((g) => g.rows.length > 1);
  };

  const athletes = (await pool.query(
    `SELECT a.id, COALESCE(a.data->>'name','(unknown)') AS name, a.data->>'school' AS school
       FROM athletes a WHERE ($1::text IS NULL OR a.agent_id = $1)`, [agentId])).rows;
  const nameById = new Map(athletes.map((a) => [a.id, a.name]));
  // The market a name-only identity is scoped to. Best effort: the athlete's
  // school city is what the market pool keys on.
  const marketByAthlete = new Map();
  for (const a of athletes) marketByAthlete.set(a.id, BI.normMarket(a.school || ''));

  // ── outreach_queue ────────────────────────────────────────────────────────
  const qRows = (await pool.query(
    `SELECT id, agent_id, athlete_id, slot, brand_name, brand_key, identity_key, lane, created_at
       FROM outreach_queue
      WHERE state = 'queued' AND ($1::text IS NULL OR agent_id = $1)
      ORDER BY athlete_id, created_at ASC`, [agentId])).rows;
  const qGroups = groupByIdentity(qRows, marketByAthlete);

  // ── outreach_logs (the Home cards) ────────────────────────────────────────
  const lRows = (await pool.query(
    `SELECT id, agent_id, athlete_id, brand_name, brand_key, sent_to_email, created_at
       FROM outreach_logs
      WHERE status = 'draft' AND approved_at IS NULL AND cadence_stopped_at IS NULL
        AND ($1::text IS NULL OR agent_id = $1)
      ORDER BY athlete_id, created_at ASC`, [agentId])).rows;
  const lGroups = groupByIdentity(lRows, marketByAthlete);

  const qLosers = [];
  for (const g of qGroups) {
    const sorted = g.rows.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const winner = sorted[0];
    for (const l of sorted.slice(1)) qLosers.push({ ...l, winner, basis: g.basis });
  }
  const lLosers = [];
  for (const g of lGroups) {
    // An addressable draft beats one with no address; then oldest.
    const sorted = g.rows.slice().sort((a, b) => {
      const aa = a.sent_to_email ? 0 : 1, bb = b.sent_to_email ? 0 : 1;
      return aa - bb || (new Date(a.created_at) - new Date(b.created_at));
    });
    const winner = sorted[0];
    for (const l of sorted.slice(1)) lLosers.push({ ...l, winner, basis: g.basis });
  }

  console.log('');
  console.log(`Queue: ${qRows.length} queued card(s), ${qGroups.length} duplicated business(es), `
    + `${qLosers.length} losing card(s).`);
  console.log(`Drafts: ${lRows.length} live draft(s), ${lGroups.length} duplicated business(es), `
    + `${lLosers.length} losing draft(s).`);

  const show = (list, label) => {
    if (!list.length) return;
    console.log('');
    console.log(label);
    for (const x of list.slice(0, 40)) {
      console.log('  ' + pad(nameById.get(x.athlete_id) || x.athlete_id, 20)
        + pad('keep: ' + x.winner.brand_name, 40)
        + pad('stop: ' + x.brand_name, 40) + 'basis=' + x.basis);
    }
    if (list.length > 40) console.log('  … and ' + (list.length - 40) + ' more');
  };
  show(qLosers, 'QUEUE — losing cards:');
  show(lLosers, 'DRAFTS — losing cards:');

  // ── PER-ATHLETE COUNTS, BEFORE AND AFTER ──────────────────────────────────
  // A cleanup that thins a roster without saying by how much is how somebody
  // finds out at 7am.
  const byAthlete = new Map();
  const bump = (id, field, n) => {
    const e = byAthlete.get(id) || { queue: 0, drafts: 0, qLost: 0, lLost: 0 };
    e[field] += n; byAthlete.set(id, e);
  };
  for (const r of qRows) bump(r.athlete_id, 'queue', 1);
  for (const r of lRows) bump(r.athlete_id, 'drafts', 1);
  for (const r of qLosers) bump(r.athlete_id, 'qLost', 1);
  for (const r of lLosers) bump(r.athlete_id, 'lLost', 1);

  console.log('');
  console.log(pad('ATHLETE', 22) + pad('QUEUE now', 11) + pad('after', 8)
    + pad('DRAFTS now', 12) + 'after');
  console.log('-'.repeat(62));
  for (const [id, e] of [...byAthlete.entries()].sort((a, b) => (b[1].qLost + b[1].lLost) - (a[1].qLost + a[1].lLost))) {
    console.log(pad(nameById.get(id) || id, 22)
      + pad(e.queue, 11) + pad(e.queue - e.qLost, 8)
      + pad(e.drafts, 12) + (e.drafts - e.lLost));
  }

  if (!apply) {
    console.log('');
    console.log('DRY RUN. Nothing was changed. Re-run with --apply'
      + (backfill ? '' : ', and --backfill-keys to stamp identity_key on the survivors') + '.');
    process.exit(0);
  }

  let qn = 0, ln = 0, bn = 0;
  if (qLosers.length) {
    const r = await pool.query(
      `UPDATE outreach_queue
          SET state = $2, outcome = $3, outcome_at = NOW(), updated_at = NOW()
        WHERE id = ANY($1::int[]) AND state = 'queued'
        RETURNING id`,
      [qLosers.map((x) => x.id), QUEUE_STATE, LOG_REASON]);
    qn = r.rowCount;
  }
  if (lLosers.length) {
    const r = await pool.query(
      `UPDATE outreach_logs
          SET cadence_stopped_at = NOW(), cadence_stop_reason = $2, updated_at = NOW()
        WHERE id = ANY($1::text[]) AND cadence_stopped_at IS NULL
        RETURNING id`,
      [lLosers.map((x) => x.id), LOG_REASON]);
    ln = r.rowCount;
  }
  if (backfill) {
    // Survivors only, and only where it is still blank, so this never overwrites
    // a key the running product wrote.
    const survivors = qRows.filter((r) => !qLosers.some((l) => l.id === r.id) && !r.identity_key);
    for (const r of survivors) {
      const k = BI.keyOf(r, { market: marketByAthlete.get(r.athlete_id) || null });
      if (!k) continue;
      const u = await pool.query(
        `UPDATE outreach_queue SET identity_key = $2 WHERE id = $1 AND identity_key IS NULL
         RETURNING id`, [r.id, k]).catch(() => ({ rowCount: 0 }));
      bn += u.rowCount || 0;
    }
  }

  console.log('');
  console.log(`Stopped ${qn} queue card(s) and ${ln} draft(s).`
    + (backfill ? ` Stamped identity_key on ${bn} surviving queue row(s).` : ''));
  console.log('Nothing was deleted. Both are reversible:');
  console.log(`  UPDATE outreach_queue SET state='queued', outcome=NULL, outcome_at=NULL`);
  console.log(`   WHERE state='${QUEUE_STATE}' AND outcome='${LOG_REASON}';`);
  console.log(`  UPDATE outreach_logs SET cadence_stopped_at=NULL, cadence_stop_reason=NULL`);
  console.log(`   WHERE cadence_stop_reason='${LOG_REASON}';`);
  process.exit(0);
})().catch((e) => { console.error('clear-duplicate-cards failed:', e.message); process.exit(1); });
