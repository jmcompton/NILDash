#!/usr/bin/env node
'use strict';
// ── REMOVE ONE ATHLETE FROM AN AGENT'S ROSTER, AND EVERYTHING QUEUED FOR THEM ─
//
//   node scripts/remove-athlete.js --id ath-1789477661264                dry run
//   node scripts/remove-athlete.js --id ath-1789477661264 --commit       delete
//
// For a record that should never have been created (a high-school student
// imported by mistake). The dry run prints the athlete, whose roster they are
// on, and exactly what would go: the athlete row, every queued card, the
// on-demand claims and the athlete's fill state. Sent cards and their
// outreach_logs rows are HISTORY and are kept; the drafts behind the queued
// cards are cadence-stopped so Home cannot show them. With the row gone
// tonight's fill has nothing to fill: the job loads athletes by agent, so a
// deleted athlete is simply not on the list.
//
// Everything in --commit runs in one transaction.

const store = require('../server/store');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] !== undefined && !/^--/.test(process.argv[i + 1]) ? process.argv[i + 1] : dflt; }
function flag(name) { return process.argv.includes('--' + name); }
function target() {
  const url = process.env.DATABASE_URL;
  if (url) { try { const u = new URL(url); return `DATABASE_URL -> ${u.hostname}${u.pathname} (ssl)`; } catch (_) { return 'DATABASE_URL'; } }
  return `PG* env -> ${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}`;
}

// What the removal would touch, as counts and names. Pure read.
async function inspect(P, id) {
  const a = (await P.query(
    `SELECT a.id, a.agent_id, a.data->>'name' AS name, a.data->>'school' AS school, a.data->>'sport' AS sport,
            a.data->>'importedFrom' AS imported_from, a.created_at, u.email AS agent_email, u.name AS agent_name
       FROM athletes a LEFT JOIN users u ON u.id = a.agent_id WHERE a.id = $1`, [id])).rows[0];
  if (!a) return null;
  const q = (await P.query(`SELECT state, COUNT(*)::int AS n FROM outreach_queue WHERE athlete_id = $1 GROUP BY state`, [id])).rows;
  const queued = (await P.query(`SELECT id, brand_name, slot, outreach_log_id FROM outreach_queue WHERE athlete_id = $1 AND state = 'queued' ORDER BY slot`, [id])).rows;
  const ondemand = (await P.query(`SELECT COUNT(*)::int AS n FROM outreach_queue_ondemand WHERE athlete_id = $1`, [id]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  const state = (await P.query(`SELECT COUNT(*)::int AS n FROM athlete_state WHERE athlete_id = $1`, [id]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  const sent = q.filter((r) => r.state !== 'queued').reduce((s, r) => s + r.n, 0);
  return { athlete: a, byState: q, queued, ondemand, state, sent };
}

// The removal itself. Returns what it deleted.
async function remove(P, id) {
  const client = await P.connect();
  try {
    await client.query('BEGIN');
    const logIds = (await client.query(`SELECT outreach_log_id FROM outreach_queue WHERE athlete_id = $1 AND state = 'queued' AND outreach_log_id IS NOT NULL`, [id])).rows.map((r) => r.outreach_log_id);
    const drafts = logIds.length
      ? (await client.query(`UPDATE outreach_logs SET cadence_stopped_at = NOW(), cadence_stop_reason = 'athlete removed from the roster', updated_at = NOW() WHERE id = ANY($1) AND cadence_stopped_at IS NULL`, [logIds])).rowCount
      : 0;
    const cards = (await client.query(`DELETE FROM outreach_queue WHERE athlete_id = $1 AND state = 'queued'`, [id])).rowCount;
    // The two side tables may not exist on an older database. A failed
    // statement aborts the whole transaction, so each runs under a savepoint
    // that is rolled back on its own rather than swallowed.
    const optional = async (sql) => {
      await client.query('SAVEPOINT opt');
      try { const r = await client.query(sql, [id]); await client.query('RELEASE SAVEPOINT opt'); return r.rowCount; }
      catch (_) { await client.query('ROLLBACK TO SAVEPOINT opt'); return 0; }
    };
    const ondemand = await optional(`DELETE FROM outreach_queue_ondemand WHERE athlete_id = $1`);
    const state = await optional(`DELETE FROM athlete_state WHERE athlete_id = $1`);
    const athlete = (await client.query(`DELETE FROM athletes WHERE id = $1`, [id])).rowCount;
    await client.query('COMMIT');
    return { athlete, cards, drafts, ondemand, state };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

async function main() {
  const id = arg('id', null);
  if (!id) { console.log('remove-athlete: give --id <athlete id>'); process.exit(1); }
  const commit = flag('commit');
  console.log(`remove-athlete: ${commit ? 'COMMIT' : 'DRY RUN'}  id=${id}  via ${target()}`);
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const info = await inspect(P, id);
  if (!info) { console.log(`\nNo athlete with id ${id}. Nothing to do.`); await P.end(); process.exit(1); }
  const a = info.athlete;
  console.log(`\nATHLETE ${a.name} (${a.id})  ${a.sport || ''} ${a.school ? 'at ' + a.school : ''}  created ${String(a.created_at).slice(0, 10)}${a.imported_from ? '  imported from ' + a.imported_from : ''}`);
  console.log(`   on the roster of ${a.agent_email || a.agent_id}${a.agent_name ? ' (' + a.agent_name + ')' : ''}`);
  console.log(`   queue rows by state: ${info.byState.map((r) => r.state + '=' + r.n).join(', ') || 'none'}`);
  console.log(`\nWOULD DELETE`);
  console.log(`   the athlete row`);
  console.log(`   ${info.queued.length} queued card(s)${info.queued.length ? ': ' + info.queued.map((c) => `slot ${c.slot} ${c.brand_name}`).join('; ') : ''}`);
  console.log(`   ${info.ondemand} on-demand claim(s), ${info.state} fill-state row(s)`);
  console.log(`   (the drafts behind the queued cards are cadence-stopped, not deleted; ${info.sent} sent/actioned card(s) and their logs are kept as history)`);
  if (!commit) { console.log(`\nDry run: nothing changed. Re-run with --commit to remove ${a.name}.`); await P.end(); process.exit(0); }
  const r = await remove(P, id);
  console.log(`\nREMOVED ${a.name}: athlete row ${r.athlete}, queued cards ${r.cards}, drafts stopped ${r.drafts}, on-demand claims ${r.ondemand}, state rows ${r.state}.`);
  console.log(`Tonight's fill loads athletes by agent, so ${a.name} is not on the list.`);
  await P.end(); process.exit(0);
}

module.exports = { inspect, remove };
if (require.main === module) main().catch((e) => { console.error('remove-athlete: FAILED', e.message); process.exit(1); });
