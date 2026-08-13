'use strict';
// Make the program map sport-aware at the SCHEMA level. Schema only: no basketball
// code, no path lists, no sport-guard changes.
//
// WHAT IT DOES
//   program_staff    UNIQUE (school, role, name)  ->  (school, sport, role, name)
//   program_source   PRIMARY KEY (school)         ->  (school, sport)
//                    football_staff_url                -> staff_url
//                    football_staff_url_discovered_via -> staff_url_discovered_via
//   program_contact  PRIMARY KEY (school)         ->  (school, sport)
//                    football_office_phone             -> office_phone
//                    football_office_phone_source_url  -> office_phone_source_url
//   every existing row gets sport = 'football'
//
// WHY IT IS SAFE
// Every constraint change is a WIDENING. (school, sport, role, name) is implied by
// (school, role, name) once sport is constant, so no existing row can violate the
// new constraint, and the same holds for both primary keys. The backfill writes a
// constant into a column that is currently NULL everywhere. Renames preserve data.
// Nothing here deletes or overwrites a value.
//
// This runs inside ONE transaction. Dry run executes every statement and then rolls
// back, so what you see in a dry run is the real database's response to the real
// SQL, not a prediction of it.
//
// DEPLOY ORDER does not matter: ensureSchema() is called from store.js init, so a
// container that boots before the CLI is run migrates itself. Running the CLI first
// is still preferable because it shows you the counts.

const TABLES = ['program_staff', 'program_source', 'program_contact'];

async function tableExists(db, table) {
  const r = await db.query('SELECT to_regclass($1) AS t', ['public.' + table]);
  return !!(r.rows[0] && r.rows[0].t);
}

async function columnExists(db, table, column) {
  const r = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]);
  return r.rows.length > 0;
}

// Normalise whatever the driver hands back for a column list.
//
// This is where the first dry run died with ".slice is not a function". pg_attribute
// .attname is of type `name`, so ARRAY(...) over it yields name[] (OID 1003), which
// node-postgres does not parse into a JS array: it arrives as the raw literal
// "{school,role,name}". The query below now casts to text[] so the driver parses it,
// and this function still handles the string form, because relying on one driver's
// type table to be complete is what caused the crash in the first place.
function _colNames(raw) {
  if (Array.isArray(raw)) return raw.map(String);
  if (raw == null) return [];
  if (typeof raw === 'string') {
    // Postgres array literal: {a,b,c}, with quotes around anything unusual.
    const inner = raw.replace(/^\{/, '').replace(/\}$/, '');
    if (!inner) return [];
    return inner.split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  }
  // Anything else (int2vector, a Buffer, some future driver shape): say exactly what
  // arrived rather than throwing an error that names the symptom and not the cause.
  console.warn('[programSport] unexpected constraint column type:'
    + ` typeof=${typeof raw} ctor=${raw && raw.constructor && raw.constructor.name} value=${JSON.stringify(raw)}`);
  return [];
}

// Find a UNIQUE or PRIMARY KEY constraint by the exact column set it covers, in any
// order. Names are not assumed: a table created by an older migration may carry a
// different auto-generated name than the one this code would produce today.
async function constraintOn(db, table, columns, type) {
  const r = await db.query(`
    SELECT c.conname,
           ARRAY(SELECT a.attname::text FROM unnest(c.conkey) k
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
                 ORDER BY a.attname)::text[] AS cols
    FROM pg_constraint c
    WHERE c.conrelid = $1::regclass AND c.contype = $2
  `, ['public.' + table, type]);
  const want = [...columns].sort().join(',');
  const hit = r.rows.find((row) => _colNames(row.cols).sort().join(',') === want);
  return hit ? hit.conname : null;
}

// Every constraint on a table, for the CLI to print. Seeing the real names and
// column sets is what turns "none found" from a mystery into a fact.
async function constraintsFor(db, table) {
  if (!(await tableExists(db, table))) return [];
  const r = await db.query(`
    SELECT c.conname, c.contype,
           ARRAY(SELECT a.attname::text FROM unnest(c.conkey) k
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
                 ORDER BY a.attname)::text[] AS cols
    FROM pg_constraint c
    WHERE c.conrelid = $1::regclass AND c.contype IN ('p','u')
    ORDER BY c.conname
  `, ['public.' + table]);
  return r.rows.map((row) => ({
    name: row.conname,
    type: row.contype === 'p' ? 'PRIMARY KEY' : 'UNIQUE',
    cols: _colNames(row.cols),
    rawCols: row.cols,
  }));
}

async function counts(db) {
  const out = {};
  for (const t of TABLES) {
    if (!(await tableExists(db, t))) { out[t] = null; continue; }
    const hasSport = await columnExists(db, t, 'sport');
    const total = await db.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
    const row = { rows: total.rows[0].n, bySport: null, nullSport: null };
    if (hasSport) {
      const bs = await db.query(
        `SELECT COALESCE(sport, '(null)') AS sport, COUNT(*)::int AS n FROM ${t} GROUP BY 1 ORDER BY 1`);
      row.bySport = bs.rows;
      row.nullSport = (bs.rows.find((x) => x.sport === '(null)') || { n: 0 }).n;
    }
    out[t] = row;
  }
  return out;
}

// What state is the schema in? Reported rather than assumed, so a partially applied
// migration is visible instead of producing a confusing error.
async function inspect(db) {
  const state = {};
  for (const t of TABLES) {
    if (!(await tableExists(db, t))) { state[t] = { exists: false }; continue; }
    state[t] = {
      exists: true,
      hasSport: await columnExists(db, t, 'sport'),
    };
  }
  if (state.program_staff.exists) {
    state.program_staff.oldUnique = await constraintOn(db, 'program_staff', ['school', 'role', 'name'], 'u');
    state.program_staff.newUnique = await constraintOn(db, 'program_staff', ['school', 'sport', 'role', 'name'], 'u');
  }
  if (state.program_source.exists) {
    state.program_source.oldPk = await constraintOn(db, 'program_source', ['school'], 'p');
    state.program_source.newPk = await constraintOn(db, 'program_source', ['school', 'sport'], 'p');
    state.program_source.oldCols = {
      football_staff_url: await columnExists(db, 'program_source', 'football_staff_url'),
      football_staff_url_discovered_via: await columnExists(db, 'program_source', 'football_staff_url_discovered_via'),
    };
    state.program_source.newCols = {
      staff_url: await columnExists(db, 'program_source', 'staff_url'),
      staff_url_discovered_via: await columnExists(db, 'program_source', 'staff_url_discovered_via'),
    };
  }
  if (state.program_contact.exists) {
    state.program_contact.oldPk = await constraintOn(db, 'program_contact', ['school'], 'p');
    state.program_contact.newPk = await constraintOn(db, 'program_contact', ['school', 'sport'], 'p');
    state.program_contact.oldCols = {
      football_office_phone: await columnExists(db, 'program_contact', 'football_office_phone'),
      football_office_phone_source_url: await columnExists(db, 'program_contact', 'football_office_phone_source_url'),
    };
    state.program_contact.newCols = {
      office_phone: await columnExists(db, 'program_contact', 'office_phone'),
      office_phone_source_url: await columnExists(db, 'program_contact', 'office_phone_source_url'),
    };
  }
  return state;
}

// Build the statement list for the CURRENT state. Every step is conditional, so
// running this twice is a no-op the second time.
async function plan(db) {
  const s = await inspect(db);
  const steps = [];
  const add = (sql, why) => steps.push({ sql, why });

  const RENAMES = {
    program_source: [
      ['football_staff_url', 'staff_url'],
      ['football_staff_url_discovered_via', 'staff_url_discovered_via'],
    ],
    program_contact: [
      ['football_office_phone', 'office_phone'],
      ['football_office_phone_source_url', 'office_phone_source_url'],
    ],
  };

  for (const t of TABLES) {
    if (!s[t] || !s[t].exists) continue;

    // 1. sport column, backfilled to football. Everything currently stored is
    //    football, so a constant is correct rather than a guess.
    if (!s[t].hasSport) add(`ALTER TABLE ${t} ADD COLUMN sport TEXT`, `${t}: add sport`);
    add(`UPDATE ${t} SET sport = 'football' WHERE sport IS NULL`, `${t}: backfill sport='football'`);
    add(`ALTER TABLE ${t} ALTER COLUMN sport SET DEFAULT 'football'`, `${t}: default sport`);
    add(`ALTER TABLE ${t} ALTER COLUMN sport SET NOT NULL`, `${t}: sport NOT NULL`);

    // 2. renames, only if the old name is still there and the new one is not.
    for (const [from, to] of (RENAMES[t] || [])) {
      const hasOld = s[t].oldCols && s[t].oldCols[from];
      const hasNew = s[t].newCols && s[t].newCols[to];
      if (hasOld && !hasNew) add(`ALTER TABLE ${t} RENAME COLUMN ${from} TO ${to}`, `${t}: ${from} -> ${to}`);
    }
  }

  // 3. program_staff: widen the unique constraint. Widening, so no row can conflict.
  if (s.program_staff.exists && !s.program_staff.newUnique) {
    if (s.program_staff.oldUnique) {
      add(`ALTER TABLE program_staff DROP CONSTRAINT "${s.program_staff.oldUnique}"`,
        `program_staff: drop UNIQUE (school, role, name) [${s.program_staff.oldUnique}]`);
    }
    add('ALTER TABLE program_staff ADD CONSTRAINT program_staff_school_sport_role_name_key UNIQUE (school, sport, role, name)',
      'program_staff: add UNIQUE (school, sport, role, name)');
  }

  // 4. program_source / program_contact: composite primary key.
  for (const t of ['program_source', 'program_contact']) {
    if (!s[t].exists || s[t].newPk) continue;
    if (s[t].oldPk) add(`ALTER TABLE ${t} DROP CONSTRAINT "${s[t].oldPk}"`, `${t}: drop PRIMARY KEY (school) [${s[t].oldPk}]`);
    add(`ALTER TABLE ${t} ADD CONSTRAINT ${t}_school_sport_pkey PRIMARY KEY (school, sport)`,
      `${t}: add PRIMARY KEY (school, sport)`);
  }

  // 5. an index that matches how every read filters now.
  for (const t of TABLES) {
    if (!s[t] || !s[t].exists) continue;
    add(`CREATE INDEX IF NOT EXISTS idx_${t}_school_sport ON ${t} (school, sport)`, `${t}: index (school, sport)`);
  }

  return { state: s, steps };
}

// Reverse it. Only valid while every row is still football: restoring
// UNIQUE (school, role, name) would fail the moment two sports share a school, and
// that failure is the correct outcome rather than something to force past.
async function rollbackPlan(db) {
  const s = await inspect(db);
  const steps = [];
  const add = (sql, why) => steps.push({ sql, why });
  const blockers = [];

  for (const t of TABLES) {
    if (!s[t] || !s[t].exists || !s[t].hasSport) continue;
    const r = await db.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE sport IS DISTINCT FROM 'football'`);
    if (r.rows[0].n > 0) blockers.push(`${t} has ${r.rows[0].n} row(s) whose sport is not football`);
  }
  if (blockers.length) return { blockers, steps: [], state: s };

  if (s.program_staff.exists && s.program_staff.newUnique) {
    add(`ALTER TABLE program_staff DROP CONSTRAINT "${s.program_staff.newUnique}"`, 'program_staff: drop the widened UNIQUE');
    add('ALTER TABLE program_staff ADD CONSTRAINT program_staff_school_role_name_key UNIQUE (school, role, name)',
      'program_staff: restore UNIQUE (school, role, name)');
  }
  for (const t of ['program_source', 'program_contact']) {
    if (!s[t].exists || !s[t].newPk) continue;
    add(`ALTER TABLE ${t} DROP CONSTRAINT "${s[t].newPk}"`, `${t}: drop the composite PK`);
    add(`ALTER TABLE ${t} ADD CONSTRAINT ${t}_pkey PRIMARY KEY (school)`, `${t}: restore PRIMARY KEY (school)`);
  }
  const UNRENAME = {
    program_source: [['staff_url', 'football_staff_url'], ['staff_url_discovered_via', 'football_staff_url_discovered_via']],
    program_contact: [['office_phone', 'football_office_phone'], ['office_phone_source_url', 'football_office_phone_source_url']],
  };
  for (const [t, pairs] of Object.entries(UNRENAME)) {
    if (!s[t].exists) continue;
    for (const [from, to] of pairs) {
      if (s[t].newCols && s[t].newCols[from]) add(`ALTER TABLE ${t} RENAME COLUMN ${from} TO ${to}`, `${t}: ${from} -> ${to}`);
    }
  }
  // sport itself is left in place and left populated: dropping it would discard the
  // only thing distinguishing rows if the migration is re-applied later, and an
  // unused column costs nothing.
  for (const t of TABLES) {
    if (!s[t] || !s[t].exists || !s[t].hasSport) continue;
    add(`ALTER TABLE ${t} ALTER COLUMN sport DROP NOT NULL`, `${t}: sport nullable again`);
  }
  return { blockers: [], steps, state: s };
}

// Run a step list inside one transaction. commit=false executes everything and then
// rolls back, which is what makes the dry run a real rehearsal rather than a guess.
async function run(pool, steps, { commit }) {
  const client = await pool.connect();
  const executed = [];
  try {
    await client.query('BEGIN');
    for (const step of steps) {
      await client.query(step.sql);
      executed.push(step);
    }
    const after = await counts(client);
    if (commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return { ok: true, executed, after, committed: !!commit };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, executed, error: e.message, failedAt: executed.length, committed: false };
  } finally {
    client.release();
  }
}

// Called from store.js init so a container that boots before the CLI is run does not
// serve traffic against the old shape. Idempotent: a no-op once applied.
async function ensureSchema(pool) {
  try {
    const { steps } = await plan(pool);
    if (!steps.length) return { applied: 0 };
    const res = await run(pool, steps, { commit: true });
    if (!res.ok) {
      console.error('[programSport] schema migration FAILED, rolled back:', res.error);
      return { applied: 0, error: res.error };
    }
    console.log(`[programSport] schema migration applied (${res.executed.length} statement(s))`);
    return { applied: res.executed.length };
  } catch (e) {
    console.error('[programSport] schema migration error:', e.message);
    return { applied: 0, error: e.message };
  }
}

module.exports = { TABLES, counts, inspect, plan, rollbackPlan, run, ensureSchema, constraintOn, constraintsFor, columnExists, _colNames };
