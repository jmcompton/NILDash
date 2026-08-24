#!/usr/bin/env node
// scripts/seed-demo-athletes.js
//
// FABRICATED dates of birth and follower counts for a demo roster, so the
// compliance gate has an age to read and the media kit has a number to show
// without anyone typing eight forms.
//
// EVERY VALUE IT WRITES IS MARKED. data._seed records which fields were
// fabricated, when, and by what, so "is this number real" has an exact answer in
// three months instead of a guess. The marker is per FIELD and clears itself the
// moment a real value replaces a seeded one -- see services/seedMarker.
//
// Usage:
//   DATABASE_URL=... node scripts/seed-demo-athletes.js --agent <id>
//   DATABASE_URL=... node scripts/seed-demo-athletes.js --agent <id> --write --expect-email you@example.com
//   DATABASE_URL=... node scripts/seed-demo-athletes.js --agent <id> --list
//   DATABASE_URL=... node scripts/seed-demo-athletes.js --audit            # every roster, counts only
//   DATABASE_URL=... node scripts/seed-demo-athletes.js --agent <id> --unseed --write --expect-email ...
//
//   --agent <id>          REQUIRED. Whose roster. There is no default.
//   --expect-email <addr> REQUIRED with --write. Must match the agent id's own
//                         email, so a mistyped id fails instead of seeding a
//                         stranger.
//   --force               overwrite values that are NOT marked as seeded
//
// SCOPING, BECAUSE THIS DATABASE HAS REAL CUSTOMERS ON IT.
//
// This script used to default to EVERY athlete when --agent was omitted. On a
// database with a paying customer's roster in it, one forgotten flag would have
// written fabricated birthdays and follower counts over real athletes. That
// default is gone. There is no "the first agent", no "the only admin", no
// inferred owner: an explicit id or it refuses to start.
//
// Four things stand between a typo and someone else's data:
//   1. --agent is REQUIRED. No flag, no run.
//   2. The id must resolve to a real user, and the script prints WHO -- name,
//      email, roster size -- before it shows a plan or writes anything.
//   3. --write additionally requires --expect-email to match that user's own
//      address. A mistyped id now has to be mistyped consistently in two places
//      to do damage, and an id belonging to someone else fails on the mismatch.
//   4. Every statement binds agent_id as a parameter. The seed and unseed paths
//      have no code path that reaches a row outside the named roster.
//
// --audit reads every agent and reports COUNTS ONLY -- how many athletes on each
// roster carry fabricated values, no names and no numbers. That is the check for
// "has any demo data reached a real customer", and it answers it without opening
// anybody's roster.
//
// THREE SAFETY RULES for the write itself:
//   1. DRY RUN BY DEFAULT. It prints every change and writes nothing without
//      --write.
//   2. IT NEVER OVERWRITES A REAL VALUE. A field that already holds a value not
//      marked as seeded is left alone and reported as skipped. --force overrides,
//      and says loudly that it is doing so.
//   3. IT IS DETERMINISTIC. Values derive from the athlete's id, so re-running
//      produces identical output and a second run is a no-op.

'use strict';

const path = require('path');
const SEED = require(path.join(__dirname, '..', 'server', 'services', 'seedMarker'));

const argv = process.argv.slice(2);
const has = (f) => argv.indexOf('--' + f) !== -1;
const val = (f, d) => {
  const i = argv.indexOf('--' + f);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const WRITE = has('write');
const FORCE = has('force');
const LIST = has('list');
const UNSEED = has('unseed');
const AGENT = val('agent', null);
const EXPECT_EMAIL = val('expect-email', null);
const AUDIT = has('audit');
const BY = 'scripts/seed-demo-athletes.js';

// ── Deterministic values from the athlete id ────────────────────────────────
// A hash, not Math.random: the same roster seeded twice gets the same numbers, so
// a second run changes nothing and a screenshot taken last week still matches.
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) {
    h ^= String(s).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

// Ages 18 to 22, and no birthday within BIRTHDAY_CLEARANCE days of today in
// either direction. The brief said "none in the last year", which I have taken as
// "nobody's age should have just changed or be about to" -- a birthday that lands
// mid-demo would silently move someone's age and, at the 18 boundary, their
// compliance treatment. Nobody here is near that boundary anyway; this is belt
// and braces.
const BIRTHDAY_CLEARANCE = 45;

// Born (age years + offset days) ago. SUBTRACTING the offset is load-bearing: an
// earlier birth date means an OLDER athlete, so the result is exactly `age`. The
// first version added the offset, which pushed birthdays later and produced a
// 17-year-old on a roster specified as adults — caught by the dry run, which is
// why the dry run is the default. A minor is not a cosmetic error here: the
// compliance gate hard-blocks a minor on alcohol, so one wrong birthday quietly
// changes what the product does.
//
// The athlete's last birthday was `offset` days ago and the next is 365-offset
// away, both at least BIRTHDAY_CLEARANCE, so no age changes mid-demo.
function dobFor(id, now) {
  const h = hash(id + ':dob');
  const age = 18 + (h % 5);                       // 18..22
  const today = new Date(now);
  const span = 365 - (BIRTHDAY_CLEARANCE * 2);
  const offset = BIRTHDAY_CLEARANCE + ((h >> 3) % span);
  const b = new Date(Date.UTC(today.getUTCFullYear() - age, today.getUTCMonth(), today.getUTCDate()));
  b.setUTCDate(b.getUTCDate() - offset);
  return b.toISOString().slice(0, 10);
}

function ageOn(dob, now) {
  const d = new Date(dob), r = new Date(now);
  let y = r.getUTCFullYear() - d.getUTCFullYear();
  const m = r.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && r.getUTCDate() < d.getUTCDate())) y--;
  return y;
}
function daysToBirthday(dob, now) {
  const d = new Date(dob), r = new Date(now);
  let next = new Date(Date.UTC(r.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (next.getTime() < r.getTime()) next = new Date(Date.UTC(r.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate()));
  const last = new Date(Date.UTC(next.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate()));
  return { until: Math.round((next - r) / 86400000), since: Math.round((r - last) / 86400000) };
}

// 8,000 to 40,000, spread rather than clustered. TikTok on roughly half, so the
// roster is not uniform -- a demo where every athlete looks identical teaches
// nothing about how the product handles variety.
function reachFor(id) {
  const h = hash(id + ':ig');
  const instagram = 8000 + (h % 32001);
  const hasTiktok = ((h >> 5) % 3) !== 0;
  const tiktok = hasTiktok ? 1500 + ((hash(id + ':tt')) % 12000) : null;
  return { instagram: Math.round(instagram / 100) * 100,
    tiktok: tiktok === null ? null : Math.round(tiktok / 100) * 100 };
}

const FIELDS = ['dob', 'instagram', 'tiktok', 'reachAsOf', 'reachSource'];

async function main() {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    console.error('DATABASE_URL is not set. Refusing to run against an unknown database.');
    console.error('  DATABASE_URL=... node scripts/seed-demo-athletes.js');
    console.error('  railway run node scripts/seed-demo-athletes.js');
    process.exit(2);
  }
  const store = require(path.join(__dirname, '..', 'server', 'store'));
  await new Promise((r) => setTimeout(r, 2500));   // init() is fire-and-forget

  // ── --audit: every roster, counts only ────────────────────────────────────
  // The one command that reads across accounts, and it reads no athlete names
  // and no values. It exists to answer "has any fabricated data reached a real
  // customer", which is a question you cannot answer by looking at your own
  // roster.
  if (AUDIT) {
    const rowsA = (await store.pool.query(
      `SELECT a.agent_id, COALESCE(u.name,'(unknown)') AS agent_name, u.email,
              COUNT(*)::int AS athletes,
              COUNT(*) FILTER (WHERE a.data ? '${SEED.KEY}')::int AS seeded
         FROM athletes a LEFT JOIN users u ON u.id = a.agent_id
        GROUP BY a.agent_id, u.name, u.email
        ORDER BY seeded DESC, athletes DESC`)).rows;
    console.log('\nSEEDED DATA ACROSS EVERY ROSTER  (counts only, no names, no values)');
    console.log('='.repeat(78));
    console.log('AGENT'.padEnd(26) + 'EMAIL'.padEnd(30) + 'ATHLETES'.padEnd(10) + 'SEEDED');
    console.log('-'.repeat(78));
    for (const r of rowsA) {
      console.log(String(r.agent_name).slice(0, 25).padEnd(26)
        + String(r.email || '—').slice(0, 29).padEnd(30)
        + String(r.athletes).padEnd(10)
        + (r.seeded ? String(r.seeded) + '  <-- FABRICATED' : '0'));
    }
    const dirty = rowsA.filter((r) => r.seeded > 0);
    console.log('-'.repeat(78));
    console.log(dirty.length
      ? dirty.length + ' roster(s) carry fabricated values: '
        + dirty.map((r) => r.agent_name + ' (' + r.seeded + ')').join(', ')
      : 'No fabricated values anywhere on this database.');
    await store.pool.end(); return;
  }

  // ── --agent IS REQUIRED. There is no default and no inference. ────────────
  if (!AGENT) {
    console.error('--agent <id> is required. This script has no default roster.');
    console.error('');
    console.error('It used to fall back to EVERY athlete on the database, which on a');
    console.error('database with real customers means one forgotten flag writes fabricated');
    console.error('birthdays over somebody\'s actual roster. Name the agent explicitly.');
    console.error('');
    console.error('  node scripts/seed-demo-athletes.js --agent <id>');
    console.error('  node scripts/seed-demo-athletes.js --audit     # who has seeded data');
    process.exit(2);
  }

  // The id must be a real user, and we say who before doing anything at all.
  const who = (await store.pool.query(
    `SELECT id, name, email, role FROM users WHERE id = $1`, [AGENT])).rows[0];
  if (!who) {
    console.error('No user with id "' + AGENT + '".');
    console.error('Nothing was read and nothing was written. Check the id and try again.');
    console.error('A mistyped id fails here rather than resolving to somebody else.');
    await store.pool.end();
    process.exit(2);
  }

  // ── --write must name the account in TWO ways that agree ──────────────────
  // A typo in the id can land on a real customer. Requiring the email as well
  // means it would have to be mistyped consistently in two places, and an id
  // belonging to someone else fails on the mismatch rather than seeding them.
  if (WRITE) {
    if (!EXPECT_EMAIL) {
      console.error('--write requires --expect-email <address>, matching the agent id above.');
      console.error('');
      console.error('  agent    ' + who.name + '  (' + who.id + ')');
      console.error('  email    ' + who.email);
      console.error('');
      console.error('Re-run with --expect-email ' + who.email + ' if that is the right roster.');
      await store.pool.end();
      process.exit(2);
    }
    if (String(EXPECT_EMAIL).trim().toLowerCase() !== String(who.email || '').trim().toLowerCase()) {
      console.error('REFUSING TO WRITE: the agent id and the expected email do not match.');
      console.error('');
      console.error('  --agent ' + AGENT + '  belongs to  ' + who.name + '  <' + who.email + '>');
      console.error('  --expect-email ' + EXPECT_EMAIL);
      console.error('');
      console.error('This is the check that stops a mistyped id writing to the wrong roster.');
      await store.pool.end();
      process.exit(2);
    }
  }

  const rows = (await store.pool.query(
    `SELECT id, agent_id, data FROM athletes WHERE agent_id = $1 ORDER BY created_at ASC`,
    [AGENT])).rows;

  // WHOSE ROSTER, stated before the plan and before any write, every time.
  console.log('');
  console.log('ROSTER');
  console.log('  agent     ' + who.name + '  (' + who.id + ')');
  console.log('  email     ' + who.email);
  console.log('  athletes  ' + rows.length);
  console.log('  scope     this roster only. Every statement below binds agent_id = ' + JSON.stringify(AGENT) + '.');

  if (!rows.length) {
    console.log('\nNo athletes on this roster. Nothing to do.');
    await store.pool.end(); return;
  }

  // ── --list ────────────────────────────────────────────────────────────────
  if (LIST) {
    console.log('\nSEEDED VALUES ON ' + String(who.name).toUpperCase() + "'S ROSTER");
    console.log('  ' + who.email + '   (' + who.id + ')');
    console.log('='.repeat(78));
    let any = 0;
    for (const r of rows) {
      const f = SEED.seededFields(r.data);
      const nm = (r.data && r.data.name) || r.id;
      if (!f.length) { console.log('  ' + nm.padEnd(24) + 'nothing seeded'); continue; }
      any++;
      const s = r.data[SEED.KEY];
      console.log('  ' + nm.padEnd(24) + 'SEEDED: ' + f.join(', '));
      console.log('  ' + ' '.repeat(24) + 'by ' + s.by + ' on ' + String(s.at).slice(0, 10));
    }
    console.log('\n' + any + ' of ' + rows.length + ' athlete(s) still carry fabricated values.');
    console.log('A field stops being listed here the moment a real value replaces it.');
    console.log('This is ONE roster. For every roster on the database, run --audit.');
    await store.pool.end(); return;
  }

  // ── --unseed ──────────────────────────────────────────────────────────────
  if (UNSEED) {
    console.log('\nREMOVING SEEDED VALUES' + (WRITE ? '' : '  (dry run)'));
    console.log('='.repeat(78));
    let n = 0;
    for (const r of rows) {
      const f = SEED.seededFields(r.data);
      if (!f.length) continue;
      n++;
      console.log('  ' + ((r.data && r.data.name) || r.id).padEnd(24) + 'clearing ' + f.join(', '));
      if (WRITE) {
        // Remove the seeded FIELDS themselves as well as the marker: leaving the
        // values behind unmarked is precisely the outcome this whole file exists
        // to prevent.
        await store.pool.query(
          // agent_id bound as well as the row id: belt and braces, so even a bug
          // in row selection above cannot reach a row outside this roster.
          `UPDATE athletes SET data = (data - $2::text[]) - '${SEED.KEY}', updated_at = NOW()
            WHERE id = $1 AND agent_id = $3`,
          [r.id, f, AGENT]);
      }
    }
    console.log('\n' + n + ' athlete(s) ' + (WRITE ? 'cleared.' : 'would be cleared. Re-run with --write.'));
    await store.pool.end(); return;
  }

  // ── seed ──────────────────────────────────────────────────────────────────
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const plan = [];
  for (const r of rows) {
    const d = r.data || {};
    const dob = dobFor(r.id, now);
    const reach = reachFor(r.id);
    const want = { dob, instagram: reach.instagram, reachAsOf: today, reachSource: 'athlete' };
    if (reach.tiktok !== null) want.tiktok = reach.tiktok;

    const write = {}, skipped = [];
    for (const k of Object.keys(want)) {
      const held = d[k];
      const isReal = held !== undefined && held !== null && held !== '' && !SEED.isSeeded(d, k);
      if (isReal && !FORCE) { skipped.push(k); continue; }
      write[k] = want[k];
    }
    plan.push({ row: r, name: d.name || r.id, write, skipped, dob, reach });
  }

  // VALIDATE BEFORE WRITING ANYTHING. This originally sat in the footer, AFTER
  // the write loop, where it could report a problem it had already committed.
  // CHECKED, NOT CLAIMED. The first version of this line asserted "all adults"
  // from the intended range rather than the produced values, and printed it
  // cheerfully above a 17-year-old. A summary that restates the intent proves
  // nothing; this reads the dates that were actually generated.
  const ages = plan.map((p) => ageOn(p.dob, now));
  const minors = plan.filter((p) => ageOn(p.dob, now) < 18);
  const tooClose = plan.filter((p) => {
    const b = daysToBirthday(p.dob, now);
    return Math.min(b.until, b.since) < BIRTHDAY_CLEARANCE;
  });
  if (minors.length) {
    console.error('\nREFUSING TO WRITE: ' + minors.length + ' athlete(s) would be under 18 — '
      + minors.map((p) => `${p.name} (${ageOn(p.dob, now)})`).join(', '));
    console.error('The roster was specified as adults, and a minor changes what the compliance');
    console.error('gate does: alcohol and gambling become hard blocks rather than holds.');
    await store.pool.end();
    process.exit(1);
  }
  if (tooClose.length) {
    console.error('\nREFUSING TO WRITE: ' + tooClose.length + ' birthday(s) fall within '
      + BIRTHDAY_CLEARANCE + ' days of today, so an age could change mid-demo.');
    await store.pool.end();
    process.exit(1);
  }

  console.log('\nSEEDING DEMO ATHLETES' + (WRITE ? '' : '  (DRY RUN — nothing will be written)'));
  if (FORCE) console.log('--force: REAL values will be overwritten and marked as seeded.');
  console.log('='.repeat(78));
  console.log('NAME'.padEnd(22) + 'DOB'.padEnd(13) + 'AGE'.padEnd(5) + 'BDAY'.padEnd(10) + 'IG'.padEnd(9) + 'TT'.padEnd(9) + 'SKIPPED');
  console.log('-'.repeat(78));
  let writes = 0;
  for (const p of plan) {
    const b = daysToBirthday(p.dob, now);
    const bday = Math.min(b.until, b.since) + 'd';
    console.log(
      String(p.name).slice(0, 21).padEnd(22)
      + p.dob.padEnd(13)
      + String(ageOn(p.dob, now)).padEnd(5)
      + bday.padEnd(10)
      + String(p.reach.instagram).padEnd(9)
      + String(p.reach.tiktok === null ? '—' : p.reach.tiktok).padEnd(9)
      + (p.skipped.length ? p.skipped.join(',') + ' (real, kept)' : ''));
    if (!Object.keys(p.write).length) continue;
    writes++;
    if (!WRITE) continue;
    const marker = SEED.stamp(p.row.data, Object.keys(p.write), { by: BY, at: now.toISOString() });
    const patch = Object.assign({}, p.write, { [SEED.KEY]: marker });
    await store.pool.query(
      // Same here: the roster is named in the statement itself, not only in the
      // query that produced the row.
      `UPDATE athletes SET data = data || $2::jsonb, updated_at = NOW()
        WHERE id = $1 AND agent_id = $3`,
      [p.row.id, JSON.stringify(patch), AGENT]);
  }

  console.log('-'.repeat(78));
  console.log('BDAY is days to the nearest birthday, kept clear of today so nobody\'s age');
  console.log('changes mid-demo. Ages ' + Math.min(...ages) + ' to ' + Math.max(...ages) + '.');
  console.log('All ' + plan.length + ' are adults and no birthday is within '
    + BIRTHDAY_CLEARANCE + ' days. Both checked against the dates above, not assumed.');
  console.log('');
  console.log(writes + ' of ' + plan.length + ' athlete(s) ' + (WRITE ? 'seeded.' : 'would be seeded.'));
  console.log('Every value written is marked in data._seed and listed by --list.');
  if (!WRITE) console.log('\nNothing was written. Re-run with --write to apply.');
  await store.pool.end();
}

main().catch((e) => { console.error('seed failed:', e.message); process.exit(1); });
