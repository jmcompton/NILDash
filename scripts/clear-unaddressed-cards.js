#!/usr/bin/env node
'use strict';
// ── TAKE THE ADDRESSLESS CARDS OUT OF THE QUEUE ──────────────────────────────
//
//   node scripts/clear-unaddressed-cards.js              dry run, changes nothing
//   node scripts/clear-unaddressed-cards.js --apply      do it
//   node scripts/clear-unaddressed-cards.js --apply --agent <id|email>
//   node scripts/clear-unaddressed-cards.js --apply --address-first
//
// The gate in buildHome stops NEW addressless cards reaching the page. This
// clears the ones already sitting there.
//
// NOT A DELETE. Every one of these rows is a real pitch a model was paid to
// write, and the reason it has no address is a race in the pipeline, not
// anything wrong with the pitch. So this sets cadence_stopped_at with a reason,
// which is the mechanism the product already uses for "out of play" -- buildHome
// filters on `cadence_stopped_at IS NULL`, so the card leaves the queue -- and
// it is one UPDATE to undo:
//
//   UPDATE outreach_logs SET cadence_stopped_at = NULL, cadence_stop_reason = NULL
//    WHERE cadence_stop_reason = 'no usable email address';
//
// --address-first runs draftAddress.attach over the candidates before judging
// them, so a card whose address exists in the cache and was simply never stamped
// on gets rescued instead of stopped. Slower, and worth it: on the last count
// that was most of them. It spends Hunter credits, so it is opt-in.

const path = require('path');

const REASON = 'no usable email address';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

(async () => {
  const apply = process.argv.includes('--apply');
  const addressFirst = process.argv.includes('--address-first');
  const who = arg('agent', null);

  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    console.error('DATABASE_URL is not set, so this would act on the wrong database.');
    process.exit(1);
  }
  const ROOT = path.join(__dirname, '..');
  const store = require(path.join(ROOT, 'server', 'store'));
  const pool = store.pool;

  // Resolve --agent to an id once, so the queries below stay simple.
  let agentId = null;
  if (who) {
    const r = await pool.query(
      `SELECT id FROM users WHERE id = $1 OR LOWER(email) = LOWER($1)`, [who]);
    if (!r.rows[0]) { console.error('No agent matches ' + who); process.exit(1); }
    agentId = r.rows[0].id;
  }

  const LIVE = `status = 'draft' AND approved_at IS NULL AND cadence_stopped_at IS NULL`;

  if (addressFirst) {
    const DA = require(path.join(ROOT, 'server', 'services', 'draftAddress'));
    const agents = agentId ? [{ id: agentId }] : (await pool.query(
      `SELECT DISTINCT agent_id AS id FROM outreach_logs WHERE ${LIVE}
        AND (sent_to_email IS NULL OR sent_to_email = '')`)).rows;
    for (const a of agents) {
      // No athleteId and no budget: this is a deliberate operator action, not a
      // page load, so it is not held to the per-athlete display budget. The
      // monthly Hunter ceiling in hunterLookup still applies.
      const res = await DA.attach(pool, { agentId: a.id, limit: 2000 });
      console.log(`[address-first] agent=${a.id} considered=${res.considered} `
        + `attached=${res.attached} stillMissing=${res.missing} rejected=${res.rejected || 0}`);
    }
  }

  // The same definition of unusable the page gate applies: no address, or one
  // that does not survive screenEmail.
  const { screenEmail } = require(path.join(ROOT, 'server', 'services', 'siteEmail'));
  const rows = (await pool.query(
    `SELECT l.id, l.agent_id, l.athlete_id, l.brand_name, l.sent_to_email,
            COALESCE(a.data->>'name','(unknown athlete)') AS athlete
       FROM outreach_logs l
       LEFT JOIN athletes a ON a.id = l.athlete_id
      WHERE ${LIVE}
        AND ($1::text IS NULL OR l.agent_id = $1)
      ORDER BY l.agent_id, l.athlete_id, l.created_at DESC`, [agentId])).rows;

  const doomed = [];
  for (const r of rows) {
    const addr = String(r.sent_to_email || '').trim();
    if (!addr) { doomed.push({ ...r, why: 'no address' }); continue; }
    const s = screenEmail(addr.toLowerCase(), null);
    if (!s.ok) doomed.push({ ...r, why: s.reason });
  }

  console.log('');
  console.log(rows.length + ' live draft(s) examined, ' + doomed.length + ' with no usable address.');
  if (doomed.length) {
    console.log('');
    const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
    for (const d of doomed.slice(0, 40)) {
      console.log('  ' + pad(d.athlete, 22) + pad(d.brand_name, 34)
        + pad(d.sent_to_email || '(none)', 30) + d.why);
    }
    if (doomed.length > 40) console.log('  … and ' + (doomed.length - 40) + ' more');
  }

  // What the agent is left holding. A cleanup that empties a roster without
  // saying so is how somebody finds out at 7am.
  const after = (await pool.query(
    `SELECT COALESCE(a.data->>'name','(unknown)') AS athlete, COUNT(*)::int AS n
       FROM outreach_logs l LEFT JOIN athletes a ON a.id = l.athlete_id
      WHERE ${LIVE} AND ($1::text IS NULL OR l.agent_id = $1)
        AND l.sent_to_email IS NOT NULL AND l.sent_to_email <> ''
        AND NOT (l.id = ANY($2::text[]))
      GROUP BY 1 ORDER BY 2 DESC`, [agentId, doomed.map((d) => d.id)])).rows;
  console.log('');
  console.log('Cards left per athlete after this runs:');
  if (!after.length) console.log('  none — every live draft in scope has no usable address');
  for (const a of after) console.log('  ' + String(a.athlete).padEnd(24) + a.n);

  if (!apply) {
    console.log('');
    console.log('DRY RUN. Nothing was changed. Re-run with --apply to stop these cards'
      + (addressFirst ? '' : ', or with --address-first to try to rescue them first') + '.');
    process.exit(0);
  }
  if (!doomed.length) { console.log('\nNothing to do.'); process.exit(0); }

  const r = await pool.query(
    `UPDATE outreach_logs
        SET cadence_stopped_at = NOW(), cadence_stop_reason = $2, updated_at = NOW()
      WHERE id = ANY($1::text[]) AND cadence_stopped_at IS NULL
      RETURNING id`, [doomed.map((d) => d.id), REASON]);
  console.log('');
  console.log('Stopped ' + r.rowCount + ' card(s). Bodies are untouched and this is reversible:');
  console.log("  UPDATE outreach_logs SET cadence_stopped_at = NULL, cadence_stop_reason = NULL");
  console.log("   WHERE cadence_stop_reason = '" + REASON + "';");
  process.exit(0);
})().catch((e) => { console.error('clear-unaddressed-cards failed:', e.message); process.exit(1); });
