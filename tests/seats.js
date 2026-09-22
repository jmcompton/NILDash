'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/seats.js            just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── THE PLAN SETS THE SEAT LIMIT; AN ADMIN CAN OVERRIDE IT FOR ONE ACCOUNT ──
//
// users.seat_override is NULL for everyone, so the plan rules are exactly what
// they were. A number on one account is that account's limit; 0 is no limit.
// Every reader (Add Client, seat-status, the admin page, the roster importer)
// goes through services/seats, so they cannot disagree.

const Seats = require(REPO + 'server/services/seats.js');
const store = require(REPO + 'server/store.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;
const IDS = ['seat-plain', 'seat-nolimit', 'seat-thirty'];

async function main() {
  // ── 1. THE PLAN RULE, UNCHANGED ──────────────────────────────────────────
  OUT.push('-- the plan rule --');
  ok('no plan: 10', Seats.planSeatLimit(null) === 10);
  ok('basic: 10', Seats.planSeatLimit('basic') === 10);
  ok('beta: 10', Seats.planSeatLimit('beta') === 10);
  ok('pro: 20', Seats.planSeatLimit('pro') === 20);
  ok('$499: 20', Seats.planSeatLimit('agency-499') === 20);
  ok('unlimited: none', Seats.planSeatLimit('unlimited') === null);
  ok('enterprise: none', Seats.planSeatLimit('enterprise') === null);
  ok('$599: none', Seats.planSeatLimit('tier-599') === null);

  // ── 2. THE OVERRIDE ──────────────────────────────────────────────────────
  OUT.push('', '-- the override --');
  const plain = Seats.seatLimitFor({ plan: 'beta', plan_tier: 'basic', seat_override: null });
  ok('no override: the plan decides', plain.limit === 10 && plain.source === 'plan' && plain.override === null, plain);
  const none = Seats.seatLimitFor({ plan: 'beta', plan_tier: 'basic', seat_override: 0 });
  ok('override 0: no limit', none.limit === null && none.source === 'override' && none.override === 0, none);
  const thirty = Seats.seatLimitFor({ plan_tier: 'basic', seat_override: 30 });
  ok('override 30: thirty, whatever the plan', thirty.limit === 30 && thirty.source === 'override', thirty);
  const lower = Seats.seatLimitFor({ plan_tier: 'pro', seat_override: 5 });
  ok('an override can also lower a limit', lower.limit === 5 && lower.source === 'override', lower);
  ok('plan_tier wins over plan, as before', Seats.seatLimitFor({ plan: 'beta', plan_tier: 'pro' }).limit === 20);
  ok('a string "0" from a form is read', Seats.seatLimitFor({ plan_tier: 'basic', seat_override: '0' }).limit === null);
  ok('junk in the column is not a limit of NaN: the plan decides', Seats.seatLimitFor({ plan_tier: 'basic', seat_override: 'lots' }).source === 'plan');
  ok('a negative number is ignored', Seats.seatLimitFor({ plan_tier: 'basic', seat_override: -3 }).source === 'plan');
  ok('undefined is the plan', Seats.seatLimitFor({ plan_tier: 'basic' }).source === 'plan');
  ok('the plan message says upgrade', /on your current plan/.test(Seats.limitMessage(plain)));
  ok('the override message does not tell them to upgrade', /set on your account/.test(Seats.limitMessage(thirty)) && !/upgrade/i.test(Seats.limitMessage(thirty)));
  ok('described for the admin page', Seats.describeSeats(plain) === '10 (plan)' && Seats.describeSeats(none) === 'no limit (override)' && Seats.describeSeats(thirty) === '30 (override)');

  // ── 3. THE COLUMN, READ BACK THROUGH getUser ─────────────────────────────
  OUT.push('', '-- the column --');
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const clean = async () => { await P().query(`DELETE FROM users WHERE id = ANY($1)`, [IDS]).catch(() => {}); };
  await clean();
  await P().query(`INSERT INTO users (id,name,email,password,role,plan_tier,seat_override) VALUES
    ('seat-plain','Plain','seat-plain@x.com','x','agent','basic',NULL),
    ('seat-nolimit','Greg','seat-nolimit@x.com','x','agent','basic',0),
    ('seat-thirty','Thirty','seat-thirty@x.com','x','agent','basic',30)`);
  const u1 = await store.getUser('seat-plain'), u2 = await store.getUser('seat-nolimit'), u3 = await store.getUser('seat-thirty');
  ok('a fresh user has no override', u1.seat_override === null && Seats.seatLimitFor(u1).limit === 10);
  ok('an override of 0 reads back as no limit', u2.seat_override === 0 && Seats.seatLimitFor(u2).limit === null && Seats.seatLimitFor(u2).source === 'override', u2.seat_override);
  ok('an override of 30 reads back as 30', u3.seat_override === 30 && Seats.seatLimitFor(u3).limit === 30);
  await P().query(`UPDATE users SET seat_override = NULL WHERE id = 'seat-nolimit'`);
  ok('clearing it puts the account back on its plan', Seats.seatLimitFor(await store.getUser('seat-nolimit')).source === 'plan');
  await clean();

  // ── 4. EVERY READER GOES THROUGH THE ONE RULE ────────────────────────────
  OUT.push('', '-- the readers --');
  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('the old per-plan function is gone from the server', !/function getSeatLimit\(/.test(idx));
  // Add Client's seat check moved into services/athleteCreate.js with the rest
  // of the create path; this kept grepping server/index.js for it and has been
  // red since, though the check itself never moved an inch -- same two lines,
  // same message, one file over. Read where it lives.
  const ac = fs.readFileSync(REPO + 'server/services/athleteCreate.js', 'utf8');
  ok('Add Client reads seatLimitFor and answers with the right message',
    /const seats = Seats\.seatLimitFor\(user\);\s*const seatLimit = seats\.limit;/.test(ac)
    && /error: Seats\.limitMessage\(seats\)/.test(ac));
  ok('seat-status reports the source', /seatSource: seats\.source, seatOverride: seats\.override/.test(idx));
  ok('the admin users list carries seat_override, the athlete count and the description', /seat_override,\s*\(SELECT COUNT\(\*\)::int FROM athletes a WHERE a\.agent_id = users\.id\) AS athletes/.test(idx) && /seats: Seats\.describeSeats\(seats\)/.test(idx));
  ok('POST /api/admin/set-seat-override exists, admin only, writes only seat_override', /app\.post\('\/api\/admin\/set-seat-override'/.test(idx) && /UPDATE users SET seat_override = \$1 WHERE id = \$2/.test(idx) && /set-seat-override'[\s\S]*?user\.email !== ADMIN_EMAIL/.test(idx));
  ok('  and refuses junk', /seatOverride must be null \(plan decides\), 0 \(no limit\) or a positive whole number/.test(idx));
  const st = fs.readFileSync(REPO + 'server/store.js', 'utf8');
  ok('the column is created', /ALTER TABLE users ADD COLUMN IF NOT EXISTS seat_override INT/.test(st));
  const adm = fs.readFileSync(REPO + 'public/admin.html', 'utf8');
  ok('the admin page has a Seats column beside the plan', /<th[^>]*>Change Plan<\/th>\s*<th[^>]*title="How many athletes this account may hold[^"]*">Seats<\/th>/.test(adm));
  ok('  showing taken / limit and whether it is an override', /seatCellHtml\(u\)/.test(adm) && /taken \+ ' \/ ' \+ limit/.test(adm) && /isOverride \? 'override' : 'plan'/.test(adm));
  ok('  with a control: plan default, no limit, or a number', /\['plan', 'Plan default'\], \['0', 'No limit'\]/.test(adm) && /fetch\('\/api\/admin\/set-seat-override'/.test(adm));
  const imp = fs.readFileSync(REPO + 'scripts/import-roster.js', 'utf8');
  ok('the roster importer uses the same rule', /Seats\.seatLimitFor\(u\)/.test(imp) && /seat_override FROM users/.test(imp));

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
