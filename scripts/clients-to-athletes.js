#!/usr/bin/env node
// scripts/clients-to-athletes.js
//
// Move the seeded date-of-birth and reach values from `clients` into `athletes`,
// which is the table the application actually reads, and report the difference
// between the two rather than assuming one is a copy of the other.
//
// Usage:
//   DATABASE_URL=... node scripts/clients-to-athletes.js --diff
//   DATABASE_URL=... node scripts/clients-to-athletes.js --agent <id>
//   DATABASE_URL=... node scripts/clients-to-athletes.js --agent <id> --write --expect-email you@example.com
//
//   --diff                every row in both tables, side by side. Read-only.
//   --agent <id>          REQUIRED to migrate. Whose roster. No default.
//   --expect-email <addr> REQUIRED with --write, must match that agent's email.
//
// WHAT IT COPIES, AND NOTHING ELSE: dob, instagram, tiktok, reachAsOf,
// reachSource, and the _seed marker that says those values are fabricated. It
// does not copy names, schools, sports or anything else -- `athletes` is the live
// table and its own fields are the ones the app has been running on.
//
// MATCHED BY NAME WITHIN AGENT, and a name is a weak key, so the failure modes
// are reported rather than resolved:
//   - a name in clients matching NO athlete            -> reported, skipped
//   - a name matching MORE THAN ONE athlete            -> reported, skipped
//   - an athlete whose name is in neither              -> reported
//   - a field already holding a DIFFERENT real value   -> reported, skipped
// Nothing is guessed. A row this script is unsure about is a row it leaves alone
// and names in the output.
//
// DROPS NOTHING. It writes to athletes and never deletes, truncates or alters
// clients. Whatever clients is for, it is still there afterwards.
//
// The same scoping guards as the seeder, for the same reason: there is a live
// paying customer on this database.

'use strict';

const path = require('path');
const SEED = require(path.join(__dirname, '..', 'server', 'services', 'seedMarker'));

const argv = process.argv.slice(2);
const has = (f) => argv.indexOf('--' + f) !== -1;
const val = (f, d) => {
  const i = argv.indexOf('--' + f);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const DIFF = has('diff');
const WRITE = has('write');
const AGENT = val('agent', null);
const EXPECT_EMAIL = val('expect-email', null);

const COPY = ['dob', 'instagram', 'tiktok', 'reachAsOf', 'reachSource'];
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');

// `clients` is not ours, so its shape is read rather than assumed.
async function readClients(pool) {
  const cols = (await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'clients' ORDER BY ordinal_position`)).rows;
  if (!cols.length) return null;
  const names = cols.map((c) => c.column_name);
  const jsonCol = (cols.find((c) => c.data_type === 'jsonb') || {}).column_name;
  const nameCol = names.find((c) => /^(name|full_name|athlete_name)$/i.test(c));
  const agentCol = names.find((c) => /^(agent_id|agentid|owner_id)$/i.test(c));
  const idCol = names.find((c) => /^id$/i.test(c));
  const rows = (await pool.query(`SELECT * FROM clients`)).rows;
  return {
    cols: names, jsonCol, nameCol, agentCol, idCol,
    rows: rows.map((r) => {
      const j = jsonCol && r[jsonCol] && typeof r[jsonCol] === 'object' ? r[jsonCol] : {};
      return {
        raw: r, json: j,
        id: idCol ? r[idCol] : null,
        agent: agentCol ? r[agentCol] : (j.agent_id || null),
        name: nameCol ? r[nameCol] : (j.name || null),
        vals: COPY.reduce((o, k) => { if (j[k] !== undefined) o[k] = j[k]; else if (r[k] !== undefined && r[k] !== null) o[k] = r[k]; return o; }, {}),
        seed: j[SEED.KEY] || null,
      };
    }),
  };
}

async function main() {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    console.error('DATABASE_URL is not set. Refusing to run against an unknown database.');
    process.exit(2);
  }
  const store = require(path.join(__dirname, '..', 'server', 'store'));
  await new Promise((r) => setTimeout(r, 2500));
  const P = store.pool;

  const hasClients = !!(await P.query(`SELECT to_regclass('public.clients') AS t`)).rows[0].t;
  if (!hasClients) {
    console.log('There is no `clients` table on this database. Nothing to migrate.');
    await P.end(); return;
  }
  const C = await readClients(P);
  const athletes = (await P.query(
    `SELECT id, agent_id, data FROM athletes ORDER BY created_at ASC`)).rows;

  // ── --diff: what is in each, side by side ────────────────────────────────
  if (DIFF) {
    const L = [];
    L.push('');
    L.push('clients columns: ' + C.cols.join(', '));
    L.push('  name column: ' + (C.nameCol || '(none found — using ' + C.jsonCol + "->>'name')"));
    L.push('  agent column: ' + (C.agentCol || '(none found)'));
    L.push('');
    L.push('ROW COUNTS   clients ' + C.rows.length + '   athletes ' + athletes.length);
    L.push('');
    const aByKey = new Map();
    for (const a of athletes) {
      const k = (a.agent_id || '') + '|' + norm(a.data && a.data.name);
      if (!aByKey.has(k)) aByKey.set(k, []);
      aByKey.get(k).push(a);
    }
    const cKeys = new Set(C.rows.map((c) => (c.agent || '') + '|' + norm(c.name)));

    L.push('IN CLIENTS BUT NOT IN ATHLETES  (this is what clients holds that athletes does not)');
    L.push('='.repeat(76));
    let onlyC = 0;
    for (const c of C.rows) {
      const k = (c.agent || '') + '|' + norm(c.name);
      if (aByKey.has(k)) continue;
      onlyC++;
      L.push('  ' + String(c.name || '(no name)').padEnd(28) + 'agent=' + String(c.agent || '(none)').padEnd(18)
        + (c.vals.dob ? 'dob ' : '') + (c.vals.instagram ? 'ig ' : '') + (c.seed ? '[seeded]' : ''));
    }
    if (!onlyC) L.push('  none — every clients row has a matching athlete');

    L.push('');
    L.push('IN ATHLETES BUT NOT IN CLIENTS');
    L.push('='.repeat(76));
    let onlyA = 0;
    for (const a of athletes) {
      const k = (a.agent_id || '') + '|' + norm(a.data && a.data.name);
      if (cKeys.has(k)) continue;
      onlyA++;
      L.push('  ' + String((a.data && a.data.name) || '(no name)').padEnd(28) + 'agent=' + a.agent_id);
    }
    if (!onlyA) L.push('  none');

    L.push('');
    L.push('IN BOTH  (candidates for the migration)');
    L.push('='.repeat(76));
    L.push('  NAME'.padEnd(30) + 'AGENT'.padEnd(16) + 'clients has'.padEnd(38) + 'athletes has');
    for (const c of C.rows) {
      const k = (c.agent || '') + '|' + norm(c.name);
      const m = aByKey.get(k);
      if (!m) continue;
      const ad = (m[0].data) || {};
      const hasC = COPY.filter((f) => c.vals[f] !== undefined && c.vals[f] !== null && c.vals[f] !== '');
      const hasA = COPY.filter((f) => ad[f] !== undefined && ad[f] !== null && ad[f] !== '');
      L.push('  ' + String(c.name).slice(0, 28).padEnd(30) + String(c.agent).slice(0, 14).padEnd(16)
        + (hasC.join(',') || '—').padEnd(38) + (hasA.join(',') || '—')
        + (m.length > 1 ? '   AMBIGUOUS: ' + m.length + ' athletes share this name' : ''));
    }
    L.push('');
    console.log(L.join('\n'));
    await P.end(); return;
  }

  // ── migrate ──────────────────────────────────────────────────────────────
  if (!AGENT) {
    console.error('--agent <id> is required to migrate. There is no default roster.');
    console.error('Run --diff first to see what is in each table. That is read-only.');
    await P.end(); process.exit(2);
  }
  const who = (await P.query(`SELECT id, name, email FROM users WHERE id = $1`, [AGENT])).rows[0];
  if (!who) {
    console.error('No user with id "' + AGENT + '". Nothing read, nothing written.');
    await P.end(); process.exit(2);
  }
  if (WRITE) {
    if (!EXPECT_EMAIL) {
      console.error('--write requires --expect-email <address> matching the agent id.');
      console.error('  agent ' + who.name + ' (' + who.id + ')   email ' + who.email);
      await P.end(); process.exit(2);
    }
    if (norm(EXPECT_EMAIL) !== norm(who.email)) {
      console.error('REFUSING TO WRITE: --agent ' + AGENT + ' belongs to ' + who.name
        + ' <' + who.email + '>, not ' + EXPECT_EMAIL + '.');
      await P.end(); process.exit(2);
    }
  }

  // Snapshot EVERY OTHER AGENT before touching anything, so "nobody else was
  // affected" is demonstrated rather than asserted.
  const othersBefore = (await P.query(
    `SELECT id, agent_id, data FROM athletes WHERE agent_id IS DISTINCT FROM $1 ORDER BY id`, [AGENT])).rows;
  const othersHash = JSON.stringify(othersBefore);

  const mine = athletes.filter((a) => a.agent_id === AGENT);
  const byName = new Map();
  for (const a of mine) {
    const k = norm(a.data && a.data.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(a);
  }

  const plan = [], problems = [];
  for (const c of C.rows) {
    if (c.agent !== AGENT) continue;
    const k = norm(c.name);
    const m = byName.get(k) || [];
    if (!m.length) { problems.push({ why: 'no athlete of that name', name: c.name }); continue; }
    if (m.length > 1) { problems.push({ why: m.length + ' athletes share that name — cannot tell which', name: c.name }); continue; }
    const a = m[0];
    const ad = a.data || {};
    const write = {}, kept = [];
    for (const f of COPY) {
      const from = c.vals[f];
      if (from === undefined || from === null || from === '') continue;
      const held = ad[f];
      const realHeld = held !== undefined && held !== null && held !== '' && !SEED.isSeeded(ad, f);
      // A real value already in athletes wins. clients is the copy here.
      if (realHeld && String(held) !== String(from)) {
        problems.push({ why: `athletes already holds a different ${f} (${held} vs ${from}) — kept the athletes value`, name: c.name });
        kept.push(f);
        continue;
      }
      if (String(held) === String(from)) continue;    // already identical
      write[f] = from;
    }
    if (Object.keys(write).length) plan.push({ athlete: a, name: c.name, write, seed: c.seed, kept });
  }

  console.log('');
  console.log('MIGRATE clients -> athletes' + (WRITE ? '' : '   (DRY RUN — nothing will be written)'));
  console.log('  agent     ' + who.name + '  (' + who.id + ')');
  console.log('  email     ' + who.email);
  console.log('  scope     agent_id = ' + JSON.stringify(AGENT) + ' only. clients is never modified.');
  console.log('='.repeat(76));
  if (!plan.length) console.log('  nothing to copy — athletes already holds these values, or nothing matched');
  for (const p of plan) {
    console.log('  ' + String(p.name).padEnd(28)
      + Object.entries(p.write).map(([k, v]) => k + '=' + v).join(' ')
      + (p.seed ? '   [carrying the seeded marker]' : ''));
  }
  if (problems.length) {
    console.log('');
    console.log('NOT MIGRATED — reported rather than guessed');
    console.log('-'.repeat(76));
    for (const p of problems) console.log('  ' + String(p.name || '(no name)').padEnd(28) + p.why);
  }

  if (WRITE) {
    for (const p of plan) {
      // The seeded marker travels with the values, so migrated fabricated data
      // stays visibly fabricated. Without this the migration would launder demo
      // data into something indistinguishable from real.
      const patch = Object.assign({}, p.write);
      if (p.seed) {
        patch[SEED.KEY] = SEED.stamp(p.athlete.data, Object.keys(p.write),
          { by: p.seed.by || 'clients migration', at: p.seed.at, note: p.seed.note });
      }
      await P.query(
        `UPDATE athletes SET data = data || $2::jsonb, updated_at = NOW()
          WHERE id = $1 AND agent_id = $3`,
        [p.athlete.id, JSON.stringify(patch), AGENT]);
    }
    const othersAfter = JSON.stringify((await P.query(
      `SELECT id, agent_id, data FROM athletes WHERE agent_id IS DISTINCT FROM $1 ORDER BY id`, [AGENT])).rows);
    console.log('');
    console.log(othersAfter === othersHash
      ? 'EVERY OTHER AGENT\'S ROWS ARE BYTE-IDENTICAL (' + othersBefore.length + ' row(s) compared).'
      : '*** OTHER AGENTS CHANGED. This should be impossible. Investigate before continuing. ***');
    console.log(plan.length + ' athlete(s) updated. clients was not modified.');
  } else {
    console.log('');
    console.log('Nothing was written. Re-run with --write --expect-email ' + who.email + ' to apply.');
  }
  await P.end();
}

main().catch((e) => { console.error('migration failed:', e.message); process.exit(1); });
