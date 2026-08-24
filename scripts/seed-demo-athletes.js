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
//   DATABASE_URL=... node scripts/seed-demo-athletes.js                 # dry run
//   DATABASE_URL=... node scripts/seed-demo-athletes.js --write         # do it
//   DATABASE_URL=... node scripts/seed-demo-athletes.js --list          # what is seeded
//   DATABASE_URL=... node scripts/seed-demo-athletes.js --unseed --write # remove it all
//
//   --agent <id>   restrict to one agent's roster (default: every athlete)
//   --force        overwrite values that are NOT marked as seeded
//
// THREE SAFETY RULES, because this writes to a live database:
//   1. DRY RUN BY DEFAULT. It prints every change and writes nothing without
//      --write.
//   2. IT NEVER OVERWRITES A REAL VALUE. A field that already holds a value not
//      marked as seeded is left alone and reported as skipped. --force overrides,
//      and says loudly that it is doing so. This is the rule that stops a demo
//      seeder destroying an athlete's actual birthday.
//   3. IT IS DETERMINISTIC. Values derive from the athlete's id, so re-running
//      produces identical output and a second run is a no-op rather than a
//      reshuffle.

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

  const where = AGENT ? 'WHERE agent_id = $1' : '';
  const params = AGENT ? [AGENT] : [];
  const rows = (await store.pool.query(
    `SELECT id, agent_id, data FROM athletes ${where} ORDER BY created_at ASC`, params)).rows;

  if (!rows.length) {
    console.log('No athletes found' + (AGENT ? ' for agent ' + AGENT : '') + '.');
    await store.pool.end(); return;
  }

  // ── --list ────────────────────────────────────────────────────────────────
  if (LIST) {
    console.log('\nSEEDED VALUES ON THE ROSTER');
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
          `UPDATE athletes SET data = (data - $2::text[]) - '${SEED.KEY}', updated_at = NOW() WHERE id = $1`,
          [r.id, f]);
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
      `UPDATE athletes SET data = data || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [p.row.id, JSON.stringify(patch)]);
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
