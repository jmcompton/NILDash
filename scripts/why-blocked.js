#!/usr/bin/env node
'use strict';
// ── WHY AN ATHLETE IS "BLOCKED: NO AGE ON FILE" ──────────────────────────────
//
//   node scripts/why-blocked.js "Noah Carpenter"
//   node scripts/why-blocked.js "Noah Carpenter" --agent cs@9091sportsagency.com
//
// Report only. Writes nothing.
//
// The Home page blocks an athlete when the row it selected has neither a date
// of birth nor an over-18 answer. The agent ticks the box, saves, and it comes
// back blocked. Every path between the checkbox and that line has been run in
// a test and holds the value -- so when it does not in production, the answer
// is in the data, and this prints the data:
//
//   1. EVERY athlete row with that name, not the first. Two rows with one name
//      is the usual cause: the agent edits the copy the roster shows first and
//      Home blocks on the copy that holds the cards.
//   2. For each row: the stored over18 and dob EXACTLY as the readers see them
//      (jsonb ->> text), when the row was last written, and Home's verdict.
//   3. The user rows for the owning agent, and whether a second user row
//      differs only by email case -- a PUT from the other session is a 403
//      the form used to swallow.
//   4. Open compliance holds on the athlete's drafts and the age fact each was
//      filed with. A hold filed while the age was unknown stayed open until
//      cc-auto-clear; this shows which ones those are.

const store = require('../server/store');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;

process.exitCode = 1;
let settled = false;
process.on('beforeExit', () => { if (!settled) { console.log('why-blocked: main() never settled. Exiting 1.'); process.exit(1); } });
function fail(where, e) { const m = `why-blocked: FAILED (${where}): ${e && e.message ? e.message : e}`; console.log(m); console.error(m); settled = true; process.exit(1); }
function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; }
const positional = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !(all[i - 1] || '').startsWith('--'));

function target() {
  const url = process.env.DATABASE_URL;
  if (url) { try { const u = new URL(url); return `DATABASE_URL -> ${u.hostname}${u.pathname} (ssl)`; } catch (_) { return 'DATABASE_URL'; } }
  return `PG* env -> ${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}`;
}

// The same test Home makes (services/homeQueue.js): text 'true'/'false' from
// jsonb ->>, or a dob.
function homeAgeKnown(row) {
  return !!(row.dob || row.over18 === 'true' || row.over18 === 'false');
}

async function main() {
  const name = positional[0];
  const agentEmail = arg('agent', null);
  if (!name) return fail('args', new Error('give the athlete name in quotes, e.g. "Noah Carpenter"'));
  console.log(`why-blocked: connecting via ${target()}`);
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;

  let rows;
  try {
    rows = (await P.query(
      `SELECT a.id, a.agent_id, a.created_at, a.updated_at,
              a.data->>'name' AS name, a.data->>'school' AS school, a.data->>'city' AS city,
              a.data->>'athleteType' AS athlete_type, a.athlete_type AS athlete_type_col,
              a.data->>'over18' AS over18, jsonb_typeof(a.data->'over18') AS over18_type,
              a.data->>'dob' AS dob, a.data->>'year' AS year,
              u.email AS agent_email,
              (SELECT COUNT(*)::int FROM outreach_queue q WHERE q.athlete_id = a.id AND q.state = 'queued') AS pending_cards,
              (SELECT COUNT(*)::int FROM outreach_logs l WHERE l.athlete_id = a.id) AS drafts,
              (SELECT COUNT(*)::int FROM compliance_holds h WHERE h.athlete_id = a.id AND h.resolved_at IS NULL) AS open_holds
         FROM athletes a
         LEFT JOIN users u ON u.id = a.agent_id
        WHERE LOWER(TRIM(a.data->>'name')) = LOWER(TRIM($1))
          ${agentEmail ? 'AND LOWER(TRIM(u.email)) = LOWER(TRIM($2))' : ''}
        ORDER BY a.created_at ASC`, agentEmail ? [name, agentEmail] : [name])).rows;
  } catch (e) { return fail('athletes', e); }

  console.log(`why-blocked: connected. ${rows.length} athlete row(s) named "${name}".`);
  if (!rows.length) { console.log('\nNo athlete by that name. Check the spelling on the roster. Done.\n'); settled = true; process.exit(0); }
  if (rows.length > 1) {
    console.log(`\n!! ${rows.length} ROWS SHARE THIS NAME. The roster lists them all; Home selects ONE of them (the one`);
    console.log('   with pending cards, else the oldest). Ticking the box on a different copy changes nothing on Home.');
  }

  for (const r of rows) {
    const known = homeAgeKnown(r);
    console.log(`\n── ${r.id}  (${r.agent_email || 'agent ' + r.agent_id})`);
    console.log(`   name=${r.name}  type=${r.athlete_type || r.athlete_type_col || 'college'}  school=${r.school || '-'}  city=${r.city || '-'}  year=${r.year || '-'}`);
    console.log(`   over18=${r.over18 === null ? 'NOT SET' : JSON.stringify(r.over18)} (jsonb ${r.over18_type || 'absent'})  dob=${r.dob ? 'on file' : 'NOT SET'}`);
    console.log(`   created=${String(r.created_at).slice(0, 24)}  last written=${String(r.updated_at).slice(0, 24)}`);
    console.log(`   pending cards=${r.pending_cards}  drafts=${r.drafts}  open holds=${r.open_holds}`);
    console.log(`   HOME VERDICT: ${known ? 'age known -- NOT blocked' : 'BLOCKED "no age on file"'}${r.pending_cards ? '  <- this is the copy Home shows' : ''}`);

    // The holds on this row's drafts, with the age fact they were filed with.
    let holds = [];
    try {
      holds = (await P.query(
        `SELECT h.id, h.outreach_log_id, h.brand_name, h.rule_key, h.severity, h.created_at,
                h.facts->'age'->>'known' AS age_known, h.facts->'age'->>'source' AS age_source,
                h.facts->>'stateCode' AS state_code
           FROM compliance_holds h
          WHERE h.athlete_id = $1 AND h.resolved_at IS NULL
          ORDER BY h.created_at ASC`, [r.id])).rows;
    } catch (e) { return fail('holds', e); }
    for (const h of holds) {
      console.log(`     hold #${h.id} ${String(h.created_at).slice(0, 10)}  ${(h.brand_name || '').padEnd(28)} ${h.rule_key.padEnd(22)} ${h.severity.padEnd(5)} filed with age known=${h.age_known}${h.age_source ? ' (' + h.age_source + ')' : ''} state=${h.state_code || 'none'}`);
    }
    const stale = holds.filter((h) => h.age_known === 'false');
    if (known && stale.length) {
      console.log(`   !! ${stale.length} hold(s) were filed while the age was UNKNOWN and are still open. The gate stops at an open`);
      console.log('      hold before re-reading the athlete, so these outlast the checkbox. The deploy after cc-auto-clear');
      console.log('      resolves them on the next release tick; before it, override or cancel each one.');
    }
  }

  // The owning agents' user rows, and the case-only twins.
  const agentIds = [...new Set(rows.map((r) => r.agent_id).filter(Boolean))];
  for (const aid of agentIds) {
    let u;
    try {
      u = (await P.query(`SELECT id, email, role FROM users WHERE id = $1`, [aid])).rows[0];
    } catch (e) { return fail('users', e); }
    if (!u) { console.log(`\n!! agent_id ${aid} HAS NO USERS ROW. Every PUT on these athletes is refused (403) and the old form said "updated".`); continue; }
    let twins = [];
    try {
      twins = (await P.query(
        `SELECT id, email, role, created_at FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) AND id <> $2`, [u.email, u.id])).rows;
    } catch (e) { return fail('twins', e); }
    console.log(`\nagent ${u.email} (${u.id}, ${u.role})`);
    if (twins.length) {
      console.log(`!! ${twins.length} OTHER USER ROW(S) WITH THE SAME EMAIL, differing only by case/whitespace:`);
      for (const t of twins) console.log(`     ${t.id}  ${JSON.stringify(t.email)}  ${t.role}  ${String(t.created_at).slice(0, 10)}`);
      console.log('   A session on the other row sees a different roster and its PUT on this athlete is a 403.');
    } else {
      console.log('   one user row, no case twins.');
    }
  }

  console.log('\nDone.\n');
  settled = true;
  await P.end().catch(() => {});
  process.exit(0);
}
main().catch((e) => fail('main', e));
