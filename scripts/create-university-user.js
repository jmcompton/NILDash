#!/usr/bin/env node
'use strict';
// ── CREATE A UNIVERSITY ACCOUNT ─────────────────────────────────────────────
//
//   node scripts/create-university-user.js \
//     --email ad@cypress.edu --name "Pat Doe" --university univ-cypress
//
// ADMIN-RUN ONLY, FROM THE COMMAND LINE. There is no HTTP route for this and it
// is deliberately not in the admin script runner: it creates a login, so it
// runs only where someone already has the database credentials (e.g. `railway
// run node scripts/create-university-user.js ...`).
//
// Creates one row in users: role 'university', university_id set, so the
// person signs in at /university through the ordinary account login and sees
// only their own university (requireUniversityMode + the wall in
// middleware/modeGuard). Nothing is written to any agent table.
//
// THE PASSWORD NEVER GOES ON THE COMMAND LINE, where shell history and the
// process list keep it. In order of preference:
//   1. Run it in a terminal: it asks for the password twice, without echoing.
//   2. NILDASH_NEW_USER_PASSWORD in the environment, for a non-interactive run.
//   3. --no-password: the account gets a random password nobody knows, and the
//      person sets their own with "Forgot password" on the sign-in page.
// The password is never printed, logged or stored anywhere but as a bcrypt hash.
//
// IDEMPOTENT, AND IT NEVER OVERWRITES. If the email already belongs to a
// university account for the same university, it says so and changes nothing
// (the password included). If the email belongs to anyone else -- another
// role, another university -- it refuses and exits 1.
const readline = require('readline');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const MIN_PASSWORD = 12;

function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-password') out.noPassword = true;
    else if (a.startsWith('--')) { const k = a.slice(2); const eq = k.indexOf('=');
      if (eq > 0) out[k.slice(0, eq)] = k.slice(eq + 1); else out[k] = argv[++i]; }
  }
  return out;
}

// Refuse a password passed as an argument outright, so it is never "just this once".
function refusesPasswordArg(argv) {
  return argv.some((a) => /^--(password|pass|pw)(=|$)/i.test(a));
}

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('no terminal to ask in'));
    process.stdout.write(prompt);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = () => {};          // echo nothing that is typed
    rl.question('', (v) => { rl.close(); process.stdout.write('\n'); resolve(v); });
  });
}

// The whole decision, testable without a terminal or a live database.
// Returns { ok, created, unchanged, error, user }.
async function createUniversityUser(pool, { email, name, universityId, password }) {
  const norm = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) return { ok: false, error: 'That is not an email address.' };
  const nm = String(name || '').trim();
  if (!nm) return { ok: false, error: 'A name is required.' };
  const uid = String(universityId || '').trim();
  if (!uid) return { ok: false, error: 'A university id is required (e.g. univ-cypress).' };
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return { ok: false, error: `The password must be at least ${MIN_PASSWORD} characters.` };
  }
  const uni = (await pool.query(`SELECT id, name FROM universities WHERE id = $1`, [uid])).rows[0];
  if (!uni) return { ok: false, error: `No university with id "${uid}". Seed it first (e.g. scripts/seed-cypress.js).` };

  const existing = (await pool.query(
    `SELECT id, name, email, role, university_id FROM users WHERE LOWER(TRIM(email)) = $1 LIMIT 1`, [norm])).rows[0];
  if (existing) {
    if (existing.role === 'university' && existing.university_id === uid) {
      return { ok: true, created: false, unchanged: true, university: uni,
        user: { id: existing.id, email: existing.email, name: existing.name } };
    }
    return { ok: false, error: `${norm} already belongs to a ${existing.role || 'user'} account`
      + (existing.university_id ? ` linked to ${existing.university_id}` : '')
      + '. Nothing was changed. Use a different email.' };
  }

  const id = 'user-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO users (id, name, email, password, role, university_id)
     VALUES ($1, $2, $3, $4, 'university', $5)
     ON CONFLICT (email) DO NOTHING RETURNING id`, [id, nm, norm, hash, uid]);
  // Lost a race with another run for the same email: report it, never overwrite.
  if (!r.rowCount) return { ok: false, error: `${norm} was created by something else just now. Nothing was changed.` };
  return { ok: true, created: true, university: uni, user: { id, email: norm, name: nm } };
}

async function main() {
  const argv = process.argv.slice(2);
  if (refusesPasswordArg(argv)) {
    console.error('Refusing: never pass a password on the command line (it stays in shell history and the process list).'
      + '\nRun without it to be asked, or set NILDASH_NEW_USER_PASSWORD, or use --no-password.');
    process.exit(1);
  }
  const a = argsOf(argv);
  if (!a.email || !a.name || !a.university) {
    console.error('Usage: node scripts/create-university-user.js --email <email> --name "<name>" --university <id> [--no-password]');
    process.exit(1);
  }
  let password;
  if (a.noPassword) {
    password = crypto.randomBytes(24).toString('base64url');
  } else if (process.env.NILDASH_NEW_USER_PASSWORD) {
    password = process.env.NILDASH_NEW_USER_PASSWORD;
  } else {
    try {
      password = await askHidden('Password for ' + a.email + ': ');
      const again = await askHidden('Again: ');
      if (password !== again) { console.error('The two entries did not match. Nothing was changed.'); process.exit(1); }
    } catch (_) {
      console.error('No terminal to ask for a password. Set NILDASH_NEW_USER_PASSWORD or use --no-password.');
      process.exit(1);
    }
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  });
  try {
    const r = await createUniversityUser(pool, { email: a.email, name: a.name, universityId: a.university, password });
    if (!r.ok) { console.error('Refused: ' + r.error); process.exitCode = 1; return; }
    if (r.unchanged) {
      console.log(`${r.user.email} is already a university account for ${r.university.name}. Nothing was changed (the password included).`);
    } else {
      console.log(`Created ${r.user.email} (${r.user.name}), role university, for ${r.university.name} (${r.university.id}).`);
      console.log(a.noPassword
        ? 'No password was set that anyone knows. They set one with "Forgot password" at the sign-in page, then sign in at /university.'
        : 'They sign in at /university with the password that was entered.');
    }
  } finally { await pool.end(); }
}

if (require.main === module) main().catch((e) => { console.error('create-university-user: FAILED', e.message); process.exit(1); });

module.exports = { createUniversityUser, argsOf, refusesPasswordArg, MIN_PASSWORD };
