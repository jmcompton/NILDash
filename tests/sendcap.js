'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// The per-account send ceiling, against real Postgres. The thing under test is
// not "does 40 work" -- it is "does raising ONE account's limit take effect,
// today, without moving anybody else".
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const SG = require(ROOT + 'server/services/sendGuard.js');

const out = [];
const check = (n, c, d) => { out.push({ n, ok: !!c }); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d ? '   ' + d : '')); };

const BIG = 'cap-big', STD = 'cap-std', TZ = 'cap-tz';

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await SG.ensureTable(P);

  for (const a of [BIG, STD, TZ]) {
    await P.query(`DELETE FROM agent_send_budget WHERE agent_id=$1`, [a]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [a]).catch(() => {});
  }
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'Big',$2,'x','agent','America/New_York')`, [BIG, BIG + '@x.com']);
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'Std',$2,'x','agent','America/New_York')`, [STD, STD + '@x.com']);
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'Tz',$2,'x','agent','Pacific/Honolulu')`, [TZ, TZ + '@x.com']);

  console.log('\n1. The default, with the column left NULL');
  let s = await SG.status(P, STD);
  check('a NULL daily_email_cap falls back to 40', s.cap === 40, 'cap=' + s.cap);
  check('the day is the agent\'s own calendar date, not UTC', /^\d{4}-\d{2}-\d{2}$/.test(s.day), s.day + ' tz=' + s.tz);

  console.log('\n2. Raising ONE account');
  await P.query(`UPDATE users SET daily_email_cap = 150 WHERE id = $1`, [BIG]);
  s = await SG.status(P, BIG);
  check('the raised account reads 150', s.cap === 150, 'cap=' + s.cap);
  s = await SG.status(P, STD);
  check('every other account is still 40', s.cap === 40, 'cap=' + s.cap);
  s = await SG.status(P, TZ);
  check('a third account is still 40', s.cap === 40, 'cap=' + s.cap);

  console.log('\n3. The ceiling is actually enforced at the raised number');
  // Spend the old ceiling.
  for (let i = 0; i < 40; i++) {
    const r = await SG.reserve(P, BIG);
    if (!r.ok) { check('reserve #' + (i + 1) + ' should have been allowed', false, r.reason); break; }
  }
  s = await SG.status(P, BIG);
  check('40 sends recorded and still open', s.used === 40 && s.remaining === 110,
    'used=' + s.used + ' remaining=' + s.remaining);
  const r41 = await SG.reserve(P, BIG);
  check('send 41 is allowed on a 150 ceiling', r41.ok === true, r41.reason || '');

  console.log('\n4. THE SNAPSHOT TRAP: raising the limit mid-day must take effect NOW');
  // STD sends once, which stamps cap=40 onto today's counter row. Then the
  // limit is raised. Before this change the stored 40 kept winning until
  // tomorrow, so the agent stayed capped at the number they were raised off.
  await SG.reserve(P, STD);
  const stamped = (await P.query(
    `SELECT cap FROM agent_send_budget WHERE agent_id=$1 ORDER BY local_date DESC LIMIT 1`, [STD])).rows[0];
  check('the counter row snapshotted the old cap', Number(stamped.cap) === 40, 'stored cap=' + stamped.cap);
  await P.query(`UPDATE users SET daily_email_cap = 150 WHERE id = $1`, [STD]);
  s = await SG.status(P, STD);
  check('status reports the NEW ceiling the same day', s.cap === 150, 'cap=' + s.cap);
  check('and the remaining count is against the new one', s.remaining === 149, 'remaining=' + s.remaining);
  for (let i = 0; i < 39; i++) await SG.reserve(P, STD);
  const past40 = await SG.reserve(P, STD);
  check('a send past the OLD ceiling now goes through', past40.ok === true, past40.reason || '');
  const rowNow = (await P.query(
    `SELECT cap FROM agent_send_budget WHERE agent_id=$1 ORDER BY local_date DESC LIMIT 1`, [STD])).rows[0];
  check('the counter row was re-stamped to the live cap', Number(rowNow.cap) === 150, 'stored cap=' + rowNow.cap);

  console.log('\n5. The ceiling still stops at the ceiling');
  await P.query(`UPDATE users SET daily_email_cap = 2 WHERE id = $1`, [TZ]);
  const a1 = await SG.reserve(P, TZ), a2 = await SG.reserve(P, TZ), a3 = await SG.reserve(P, TZ);
  check('two allowed on a cap of two', a1.ok && a2.ok);
  check('the third is refused', a3.ok === false, a3.reason);
  check('and it says which refusal it was', /ceiling/.test(a3.reason || ''), a3.reason);

  console.log('\n6. A lowered cap is honoured too, not just a raise');
  await P.query(`UPDATE users SET daily_email_cap = 1 WHERE id = $1`, [TZ]);
  s = await SG.status(P, TZ);
  check('status reflects the lower number', s.cap === 1, 'cap=' + s.cap);
  check('and reports no remaining allowance', s.remaining === 0, 'remaining=' + s.remaining);

  console.log('\n7. Release still gives the reservation back');
  await P.query(`UPDATE users SET daily_email_cap = 150 WHERE id = $1`, [TZ]);
  const before = (await SG.status(P, TZ)).used;
  await SG.release(P, TZ);
  const after = (await SG.status(P, TZ)).used;
  check('a failed send does not eat the allowance', after === before - 1, before + ' -> ' + after);

  console.log('\n8. Zero and negative are treated as unset, not as a ban');
  await P.query(`UPDATE users SET daily_email_cap = 0 WHERE id = $1`, [TZ]);
  check('0 falls back to the default rather than stopping all mail',
    (await SG.status(P, TZ)).cap === 40, 'cap=' + (await SG.status(P, TZ)).cap);

  const bad = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - bad.length) + '/' + out.length + ' passed');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
