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
// Its own database, schema built fresh: it empties whole tables and renames
// one, which it must never do to the database every other suite shares.
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('shiftreport', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// The shift report, against real Postgres. The load-bearing assertion is the one
// the whole product rests on: A ROLE WITH NO ROWS REPORTS NOTHING, and a role
// with rows reports exactly what the rows say. Everything else is secondary.
const fs = require('fs');
const ROOT = REPO;
const Module = require('module');
const realLoad = Module._load;
Module._load = function (rq, p, m) {
  if (/^\.\/services\//.test(rq)) return realLoad(ROOT + 'server/' + rq.slice(2), p, m);
  return realLoad.apply(this, arguments);
};
const store = require(ROOT + 'server/store.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

const AG = '00000000-0000-0000-0000-00000000sr01'.replace(/sr01/, 'a101');
const OTHER = '00000000-0000-0000-0000-0000000000a2';
const ATH = '00000000-0000-0000-0000-0000000000b1';
const RUN_AT = '2026-08-20 03:10:00+00';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));

  // The page and the 5:30 email are both built by services/shiftReport, and
  // the route only serves it (the five role cards go to the detail page). The
  // report is read from that one source. This used to eval a block of
  // server/index.js that has since moved into the service, so no route was
  // mounted and every read was express's HTML 404.
  const SRC = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
  const route = SRC.slice(SRC.indexOf("app.get('/api/agent/shift-report'"), SRC.indexOf("app.get('/api/agent/shift-report'") + 600);
  ok('the shift-report route serves the one service', /shiftReport\.buildShiftReport\(store\.pool, req\.session\.userId\)/.test(route), route.slice(0, 200));
  const SR = require(ROOT + 'server/services/shiftReport.js');
  const get = async () => SR.buildShiftReport(store.pool, AG);
  const role = (d, k) => (d.roles || []).find((x) => x.key === k) || null;
  // The queue is { items, overflow, total } now, capped in items.
  const NY = (d) => (d.needsYou && d.needsYou.items) || [];

  const wipe = async () => {
    for (const t of ['outreach_queue_runs', 'outreach_queue', 'outreach_logs', 'brand_engagement',
      'brand_evidence_cache', 'athlete_activity_log', 'athletes']) {
      await store.pool.query(`DELETE FROM ${t}`).catch(() => {});
    }
  };
  await wipe();

  // ── NO RUN AT ALL ─────────────────────────────────────────────────────────
  let d = await get();
  ok('with no run recorded, ran is false', d.run.ran === false, d.run);
  ok('  and NO role cards are emitted at all', (d.roles || []).length === 0, d.roles);
  ok('  no numbers are invented', JSON.stringify(d.roles) === '[]');

  // ── A RUN, BUT EVERY ROLE IDLE ────────────────────────────────────────────
  await store.pool.query(
    `INSERT INTO outreach_queue_runs (agent_id, run_date, filled, details, created_at)
     VALUES ($1,'2026-08-20',0,$2::jsonb,$3)`,
    [AG, JSON.stringify([{ athleteId: ATH, athleteName: 'Jane' }, { athleteId: 'x', athleteName: 'Bo' }]), RUN_AT]);
  d = await get();
  ok('a recorded run reports ran:true', d.run.ran === true, d.run);
  ok('  athletes covered comes from the run details (2)', d.coverage && d.coverage.attempted === 2, d.coverage);
  ok('  five role cards are emitted', (d.roles || []).length === 5, (d.roles || []).length);
  ok('  ALL FIVE report ran:false with no work behind them',
    d.roles.every((r) => r.ran === false), d.roles.map((r) => [r.key, r.ran]));
  ok('  and NONE carries a value, headline or detail',
    d.roles.every((r) => r.value === undefined && r.headline === undefined && r.detail === undefined),
    d.roles);
  ok('  every card still carries its autonomy level', d.roles.every((r) => r.autonomy === 'draft'), d.roles.map((r) => r.autonomy));
  ok('  the roles are in the briefed order',
    d.roles.map((r) => r.key).join(',') === 'scout,researcher,writer,closer,analyst', d.roles.map((r) => r.key));

  // ── SCOUT ─────────────────────────────────────────────────────────────────
  await store.pool.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3::jsonb)`,
    [ATH, AG, JSON.stringify({ name: 'Jane Doe' })]);
  // 3 queue cards kept, in-window.
  for (let i = 0; i < 3; i++) {
    await store.pool.query(
      `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state, dm_text, created_at)
       VALUES ($1,$2,$3,$4,$5,'dm','queued',$6,$7)`,
      [AG, ATH, i, 'brand' + i, 'Brand ' + i, i < 2 ? 'Hi there' : null, RUN_AT]);
  }
  // 5 places rows in-window, but only those tied to THIS agent's ledger count.
  for (let i = 0; i < 5; i++) {
    await store.pool.query(
      `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
       VALUES ($1,'places',$1,$2,'{}'::jsonb,'OK',$3)`, ['brand' + i, 'https://b' + i + '.com', RUN_AT]);
  }
  for (let i = 0; i < 4; i++) {
    await store.pool.query(
      `INSERT INTO brand_engagement (agent_id, athlete_id, lane, brand_key, state)
       VALUES ($1,$2,'local',$3,'shown') ON CONFLICT DO NOTHING`, [AG, ATH, 'brand' + i]).catch(() => {});
  }
  d = await get();
  let sc = role(d, 'scout');
  ok('Scout reports once it has rows', sc.ran === true, sc);
  ok('  kept = 3 queue cards', sc.value === 3, sc.value);
  ok('  checked counts only brands in THIS agent\'s ledger (4 of 5)', /\b(4|four) businesses checked/.test(sc.detail), sc.detail);
  // The athletes covered moved from the card's detail line to the coverage line.
  ok('  and counts the athletes it covered', d.coverage && d.coverage.withWork === 1, d.coverage);

  // The 5th places row belongs to no agent and must never be credited.
  const other = role(await get(), 'scout');
  ok('  a places row with no ledger entry is NOT counted', !/\b(5|five) businesses/.test(other.detail), other.detail);

  // ── RESEARCHER ────────────────────────────────────────────────────────────
  await store.pool.query(
    `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
     VALUES ('brand0','contacts','brand0',NULL,$1::jsonb,'OK',$2)`,
    [JSON.stringify({ contacts: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }), RUN_AT]);
  await store.pool.query(
    `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
     VALUES ('brand1','siteemail','brand1','https://b1.com',$1::jsonb,'OK',$2)`,
    [JSON.stringify({ email: 'owner@b1.com' }), RUN_AT]);
  await store.pool.query(
    `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
     VALUES ('brand2','siteemail','brand2','https://b2.com',$1::jsonb,'OK',$2)`,
    [JSON.stringify({ email: null }), RUN_AT]);
  d = await get();
  const rs = role(d, 'researcher');
  ok('Researcher counts named contacts from the contacts lane (3)', rs.value === 3, rs.value);
  ok('  and emailable from siteemail rows WITH an address (1, not 2)', /^1 with an email/.test(rs.detail), rs.detail);

  // ── WRITER ────────────────────────────────────────────────────────────────
  await store.pool.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, created_at)
     VALUES ('ol1',$1,$2,'Brand 0','draft',$3)`, [AG, ATH, RUN_AT]);
  d = await get();
  const wr = role(d, 'writer');
  ok('Writer counts email drafts plus DM scripts (1 + 2 = 3)', wr.value === 3, wr.value);
  ok('  and splits them in the detail line', /1 email draft, 2 DM scripts/.test(wr.detail), wr.detail);

  // ── CLOSER ────────────────────────────────────────────────────────────────
  await store.pool.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, sent_at, replied_at, created_at)
     VALUES ('ol2',$1,$2,'Brand 1','sent',$3,$3,$3)`, [AG, ATH, RUN_AT]);
  d = await get();
  const cl = role(d, 'closer');
  ok('Closer counts sends in the window', cl.value >= 1, cl.value);
  ok('  and replies that came back', /\b(1|one) reply came back/.test(cl.detail), cl.detail);

  // ── ANALYST ───────────────────────────────────────────────────────────────
  let an = role(d, 'analyst');
  ok('Analyst reports NOTHING while no kit or valuation ran', an.ran === false, an);
  await store.pool.query(
    `INSERT INTO athlete_activity_log (athlete_id, agent_id, activity_type, created_at)
     VALUES ($1,$2,'media_kit_built',$3),($1,$2,'valuation_run',$3)`, [ATH, AG, RUN_AT]);
  d = await get();
  an = role(d, 'analyst');
  ok('  and reports once the log has rows', an.ran === true && an.value === 2, an);
  ok('  naming both kinds', /media kit refreshed/.test(an.headline) && /valuation updated/.test(an.detail), an);

  // ── WINDOW: work outside the bracket is NOT credited to last night ────────
  await store.pool.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, created_at)
     VALUES ('ol_old',$1,$2,'Old','draft', $3::timestamptz - INTERVAL '5 days')`, [AG, ATH, RUN_AT]);
  await store.pool.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, created_at)
     VALUES ('ol_late',$1,$2,'Later','draft', $3::timestamptz + INTERVAL '3 days')`, [AG, ATH, RUN_AT]);
  d = await get();
  ok('a draft from five days ago is NOT counted as last night', role(d, 'writer').value === 3, role(d, 'writer').value);
  ok('  nor one from three days after the run', role(d, 'writer').value === 3, role(d, 'writer').value);

  // ── ANOTHER AGENT'S WORK IS NEVER CREDITED ───────────────────────────────
  await store.pool.query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state, created_at)
     VALUES ($1,$2,9,'zzz','ZZZ','dm','queued',$3)`, [OTHER, ATH, RUN_AT]);
  d = await get();
  ok('another agent\'s queue card is not counted', role(d, 'scout').value === 3, role(d, 'scout').value);

  // ── NEEDS YOU ────────────────────────────────────────────────────────────
  // What waits is what Home would show (services/actionable, one predicate
  // for both), not raw rows: a DM card needs its handle and its message, an
  // email draft its address. The report used to count raw drafts and queued
  // rows and said 118 while Home showed five. So the fixture cards get what
  // makes them workable, and one program card is queued: program cards are
  // counted separately, as their own item.
  await store.pool.query(`UPDATE outreach_queue SET instagram = 'brand' || slot WHERE agent_id = $1 AND dm_text IS NOT NULL`, [AG]);
  await store.pool.query(`UPDATE outreach_logs SET sent_to_email = 'dana@brandzeroshop.com' WHERE id = 'ol1'`);
  await store.pool.query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state, created_at)
     VALUES ($1,$2,7,'prog1','Prog One','program','queued',$3)`, [AG, ATH, RUN_AT]);
  d = await get();
  ok('the queue is capped at five', NY(d).length <= 5, NY(d).length);
  const kinds = NY(d).map((x) => x.kind);
  ok('  a reply becomes an item', kinds.includes('reply'), kinds);
  ok('  cards ready to work become ONE item', kinds.filter((k) => k === 'approve').length === 1, kinds);
  ok('  program cards become their own item', kinds.includes('queue'), kinds);
  ok('  the reply sorts first', NY(d)[0].kind === 'reply', kinds);
  ok('  every item carries one button label and a target',
    NY(d).every((x) => x.actionLabel && x.target), NY(d));
  ok('  and NO item claims a drafted answer exists',
    !NY(d).some((x) => /draft(ed)? (answer|reply)/i.test(x.line)), NY(d).map((x) => x.line));
  ok('  no compliance item is fabricated', !kinds.includes('compliance'), kinds);

  // More than five replies must still cap at five.
  for (let i = 0; i < 8; i++) {
    await store.pool.query(
      `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, replied_at, created_at)
       VALUES ($4,$1,$2,'R' || $4,'sent',$3,$3)`, [AG, ATH, RUN_AT, 'rep' + i]);
  }
  d = await get();
  ok('eight replies still cap the queue at five', NY(d).length === 5, NY(d).length);

  // Empty queue is a real state, not an error.
  await store.pool.query(`DELETE FROM outreach_logs`);
  await store.pool.query(`UPDATE outreach_queue SET state='done'`);
  d = await get();
  ok('with nothing pending the queue is EMPTY, not fabricated', NY(d).length === 0, NY(d));
  ok('  and the run still reports', d.run.ran === true);

  // ── one broken source must not blank the report ──────────────────────────
  await store.pool.query(`ALTER TABLE athlete_activity_log RENAME TO aal_hidden`);
  d = await get();
  ok('a missing table does not blank the whole report', d.run.ran === true && d.roles.length === 5, d.run);
  ok('  the affected role reports nothing rather than a number', role(d, 'analyst').ran === false, role(d, 'analyst'));
  ok('  the others still report', role(d, 'scout').ran === true, role(d, 'scout'));
  ok('  and the failure is recorded, not swallowed', (d.errors || []).length > 0, d.errors);
  await store.pool.query(`ALTER TABLE aal_hidden RENAME TO athlete_activity_log`);

  await wipe();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await store.pool.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.log(OUT.join('\n')); console.error('THREW', e); process.exit(1); });
