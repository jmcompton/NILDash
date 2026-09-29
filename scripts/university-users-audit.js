'use strict';
// ── WHO IS IN university_users? ─────────────────────────────────────────────
//
// The legacy compliance-portal accounts. The routes that wrote and read them
// (/api/university/register, /login and the rest) were deleted once this
// showed the table empty on production; the university portal signs in
// through the users table (scripts/create-university-user.js). Kept so the
// table can be checked again before it is dropped.
//
// Read-only. No password hash is read, let alone printed.
//
//   node scripts/university-users-audit.js
//   /api/admin/scripts/university-users-audit?text=1
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;

// What a test or throwaway account usually looks like. A hint for the reader,
// never a decision: a real person can have a gmail address.
function looksLikeTest(r) {
  const e = String(r.email || '').toLowerCase();
  const n = String(r.name || '').toLowerCase();
  return /(^|[^a-z])(test|demo|example|fake|asdf|qwerty|foo|bar)([^a-z]|$)/.test(e + ' ' + n)
    || /@(example\.(com|org|net)|test\.com|mailinator\.com|x\.com)$/.test(e)
    || /\+[a-z0-9]*@/.test(e);
}

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  console.log('university_users  ' + new Date().toISOString() + '\n');
  let rows = [];
  try {
    rows = (await P.query(
      `SELECT u.id, u.email, u.name, u.role, u.university_id, v.name AS university, u.created_at
         FROM university_users u LEFT JOIN universities v ON v.id = u.university_id
        ORDER BY u.created_at`)).rows;
  } catch (e) {
    console.log('The table could not be read: ' + e.message);
    try { await P.end(); } catch (_) {}
    process.exit(0);
  }
  const test = rows.filter(looksLikeTest).length;
  console.log(`ROWS: ${rows.length}   look like test accounts: ${test}   do not: ${rows.length - test}\n`);
  if (!rows.length) console.log('Empty. Nothing depends on /api/university/register or /api/university/login.');
  for (const r of rows) {
    console.log(`  ${looksLikeTest(r) ? 'TEST?' : 'REAL?'}  ${String(r.email).padEnd(36)} ${String(r.name || '-').padEnd(24)}`
      + ` ${String(r.role || '-').padEnd(18)} ${String(r.university || r.university_id || '-').padEnd(26)}`
      + ` created ${r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : '-'}`);
  }
  try { await P.end(); } catch (_) {}
  process.exit(0);
}
if (require.main === module) main().catch((e) => { console.error('university-users-audit: FAILED', e.message); process.exit(1); });
module.exports = { looksLikeTest };
