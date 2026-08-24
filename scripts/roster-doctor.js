#!/usr/bin/env node
// scripts/roster-doctor.js
//
// WHICH TABLE IS THE ROSTER, AND WHICH DATABASE AM I LOOKING AT?
//
// The question that prompted this: "clients has 8 rows and is what the app reads,
// athletes has 0". The code says the opposite -- `clients` appears nowhere in it
// as a table, and `athletes` is read in 24 files. Both cannot be true of the same
// database, so the first thing to establish is WHICH DATABASE each observation
// came from.
//
// This connects through server/store.js, the same module and the same
// DATABASE_URL the app itself uses, so whatever it reports is what the running
// application sees. A psql session pointed somewhere else will not agree with it,
// and that disagreement is the answer rather than a problem.
//
// Read-only. It writes nothing and it is safe to run against production.

'use strict';

const path = require('path');

const HAS_CLIENTS_SQL = `SELECT to_regclass('public.clients') AS t`;

async function main() {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    console.error('DATABASE_URL is not set, so this would report on the wrong database.');
    console.error('  railway run node scripts/roster-doctor.js');
    process.exit(2);
  }
  const store = require(path.join(__dirname, '..', 'server', 'store'));
  await new Promise((r) => setTimeout(r, 2500));
  const q = (sql, p) => store.pool.query(sql, p || []);
  const L = [];

  // ── 1. WHICH DATABASE ─────────────────────────────────────────────────────
  const idr = (await q(
    `SELECT current_database() AS db, current_user AS usr,
            inet_server_addr()::text AS host, inet_server_port() AS port,
            version() AS ver`)).rows[0];
  L.push('');
  L.push('THE DATABASE THE APP IS CONNECTED TO');
  L.push('='.repeat(74));
  L.push('  database  ' + idr.db);
  L.push('  user      ' + idr.usr);
  L.push('  server    ' + (idr.host || '(local socket)') + (idr.port ? ':' + idr.port : ''));
  L.push('');
  L.push('  If a psql session told you something different, it was pointed at a');
  L.push('  different database. This is the one the application reads and writes.');

  // ── 2. DOES EACH TABLE EXIST, AND WHAT IS IN IT ───────────────────────────
  const hasClients = !!(await q(HAS_CLIENTS_SQL)).rows[0].t;
  const hasAthletes = !!(await q(`SELECT to_regclass('public.athletes') AS t`)).rows[0].t;
  L.push('');
  L.push('THE TWO TABLES');
  L.push('='.repeat(74));

  const athN = hasAthletes ? (await q('SELECT COUNT(*)::int n FROM athletes')).rows[0].n : null;
  const cliN = hasClients ? (await q('SELECT COUNT(*)::int n FROM clients')).rows[0].n : null;

  L.push('  athletes  ' + (hasAthletes ? athN + ' row(s)' : 'DOES NOT EXIST'));
  L.push('  clients   ' + (hasClients ? cliN + ' row(s)' : 'DOES NOT EXIST'));
  L.push('');
  L.push('  The code creates and reads `athletes` in 24 files and never mentions');
  L.push('  `clients` as a table anywhere. If `clients` exists here it was made');
  L.push('  outside this codebase.');

  // ── 3. WHO IS IN EACH ─────────────────────────────────────────────────────
  // The decisive comparison: if both hold the same people, one is a copy.
  if (hasAthletes && athN) {
    const rows = (await q(
      `SELECT COALESCE(data->>'name','(no name)') AS name, agent_id,
              (data->>'dob') IS NOT NULL AS has_dob
         FROM athletes ORDER BY created_at ASC LIMIT 15`)).rows;
    L.push('');
    L.push('IN athletes');
    for (const r of rows) L.push('  ' + String(r.name).padEnd(28) + 'agent=' + String(r.agent_id).padEnd(20) + (r.has_dob ? 'dob: yes' : 'dob: —'));
  }
  if (hasClients && cliN) {
    // Column names are unknown -- this table is not ours -- so read them first
    // rather than guessing at data->>'name' and erroring.
    const cols = (await q(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name='clients' ORDER BY ordinal_position`)).rows;
    L.push('');
    L.push('IN clients   (columns: ' + cols.map((c) => c.column_name).join(', ') + ')');
    const nameCol = cols.find((c) => /^(name|full_name|athlete_name)$/i.test(c.column_name));
    const jsonCol = cols.find((c) => c.data_type === 'jsonb');
    if (nameCol) {
      const rows = (await q(`SELECT "${nameCol.column_name}" AS name FROM clients LIMIT 15`)).rows;
      for (const r of rows) L.push('  ' + r.name);
    } else if (jsonCol) {
      const rows = (await q(`SELECT "${jsonCol.column_name}"->>'name' AS name FROM clients LIMIT 15`)).rows;
      for (const r of rows) L.push('  ' + (r.name || '(no name key)'));
    } else {
      L.push('  (no obvious name column; columns listed above)');
    }
  }

  // ── 4. THE COMPLIANCE GATE'S ACTUAL INPUT ─────────────────────────────────
  // Not "does the column exist" but "has this ever produced an age", which is
  // the question that matters for whether the gate has been holding on missing
  // data or on something else.
  L.push('');
  L.push('WHAT THE COMPLIANCE GATE CAN READ');
  L.push('='.repeat(74));
  if (!hasAthletes || !athN) {
    L.push('  athletes is empty, so the gate has NEVER resolved an age for anyone.');
    L.push('  Every restricted-category pitch has been held on unknown age.');
  } else {
    const d = (await q(
      `SELECT COUNT(*)::int total,
              COUNT(*) FILTER (WHERE data->>'dob' IS NOT NULL)::int with_dob
         FROM athletes`)).rows[0];
    L.push('  ' + d.with_dob + ' of ' + d.total + ' athlete(s) have a date of birth.');
    L.push('  The gate reads athletes.data->>\'dob\' in closer.js releaseDue. With no');
    L.push('  dob the age is UNKNOWN and every restricted category holds -- which is');
    L.push('  correct behaviour, and indistinguishable from a gate that is broken.');
  }

  // ── 5. IS THE APP ACTUALLY USING THIS DATA ────────────────────────────────
  // If athletes is empty but there are drafts and queue cards, they must join to
  // something -- and that tells you the roster is not really empty.
  const logs = (await q(`SELECT COUNT(*)::int n FROM outreach_logs`).catch(() => ({ rows: [{ n: null }] }))).rows[0].n;
  const joined = hasAthletes ? (await q(
    `SELECT COUNT(*)::int n FROM outreach_logs l JOIN athletes a ON a.id = l.athlete_id`)
    .catch(() => ({ rows: [{ n: null }] }))).rows[0].n : null;
  L.push('');
  L.push('CROSS-CHECK');
  L.push('='.repeat(74));
  L.push('  outreach_logs rows                    ' + (logs === null ? '(unreadable)' : logs));
  L.push('  ...that join to an athletes row       ' + (joined === null ? '(unreadable)' : joined));
  if (logs && hasAthletes && joined === 0) {
    L.push('');
    L.push('  DRAFTS EXIST BUT NONE JOIN TO athletes. That is the signature of a');
    L.push('  roster that moved: the logs point at athlete ids this table no longer');
    L.push('  has. Do not seed until that is explained.');
  } else if (logs && joined > 0) {
    L.push('');
    L.push('  Drafts join to athletes, so athletes IS the live roster on this');
    L.push('  database and is not empty.');
  }

  L.push('');
  console.log(L.join('\n'));
  await store.pool.end();
}

main().catch((e) => { console.error('roster-doctor failed:', e.message); process.exit(1); });
