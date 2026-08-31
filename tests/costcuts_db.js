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
// Real Postgres, real schema (server/store.js's own init()), real fillAthlete /
// fillOnDemand / recordAttempt. ai.getBrandContacts and lookupPlace are stubbed
// so nothing is spent and outcomes are scripted -- everything else is shipped code.
//
// Run: PGHOST=/tmp PGPORT=55432 PGUSER=postgres PGDATABASE=costtest \
//      NODE_PATH=node_modules node this.js
'use strict';

const Module = require('module');
const originalLoad = Module._load;

// Scripted stubs, swapped per scenario.
const stub = {
  places: () => ({ businessStatus: 'OPERATIONAL', website: 'https://x.com', phone: '(479) 555-1212' }),
  contacts: () => ({ contacts: [], businessPhone: null, cached: false }),
  placesCalls: [],
  contactCalls: [],
};

Module._load = function (request, parent) {
  const m = originalLoad.apply(this, arguments);
  if (request === '../services/placesLookup') {
    return { ...m, lookupPlace: async (b, loc) => { stub.placesCalls.push({ b, loc }); return stub.places(b); } };
  }
  return m;
};

const store = require(REPO + 'server/store');
const ai = require(REPO + 'server/ai');
const Q = require(REPO + 'server/services/outreachQueue');

// Stub the one function that costs money, on the real ai module object.
ai.getBrandContacts = async (brand, site, region, ctx) => {
  stub.contactCalls.push({ brand, region, ctx });
  return stub.contacts(brand);
};

const job = require(REPO + 'server/jobs/outreachQueue');

let OUT = [], FAIL = 0;
function ok(n, c, got) { if (c) OUT.push('PASS ' + n); else { FAIL++; OUT.push('FAIL ' + n + (got !== undefined ? '  got=' + JSON.stringify(got) : '')); } }

const PASSING = () => ({
  contacts: [{ name: 'Dana Reed', title: 'Owner', phone: '(479) 555-9999', affiliationScope: 'this-location', confidence: 'high', source: 'chamber' }],
  businessPhone: '(479) 555-1212', cached: false, instagram: null, instagramScope: null,
});
const FAILING = () => ({ contacts: [], businessPhone: null, cached: false });

async function reset(pool) {
  await pool.query('DELETE FROM outreach_queue');
  await pool.query('DELETE FROM outreach_queue_runs');
  await pool.query('DELETE FROM outreach_queue_athlete_state');
  await pool.query('DELETE FROM outreach_queue_ondemand');
  await pool.query('DELETE FROM brand_engagement');
  await pool.query("DELETE FROM athletes WHERE id LIKE 'ath_c%'");
  await pool.query("DELETE FROM users WHERE id LIKE 'agent_c%'");
  stub.placesCalls.length = 0; stub.contactCalls.length = 0;
}

async function seed(pool, athId, nCands) {
  await pool.query(`INSERT INTO users (id,name,email,password,role) VALUES ('agent_c1','A','a-c1@x.com','x','agent') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,'agent_c1',$2) ON CONFLICT (id) DO NOTHING`,
    // A SCHOOL, not just a hometown. The hometown fallback was deliberately
    // removed -- an athlete whose school does not resolve no longer gets
    // businesses in the town they grew up in -- so a fixture that relies on it
    // is testing behaviour the product no longer has.
    [athId, JSON.stringify({ name: 'Test Athlete', school: 'University of Arkansas', hometown: 'Fayetteville, AR' })]);
  for (let i = 0; i < nCands; i++) {
    await pool.query(
      `INSERT INTO brand_engagement (agent_id,athlete_id,brand_key,brand_name,state,last_shown_at)
       VALUES ('agent_c1',$1,$2,$3,'shown',NOW()) ON CONFLICT DO NOTHING`,
      [athId, 'bk' + i, 'Business ' + i]);
  }
}

async function main() {
  await new Promise((r) => setTimeout(r, 2000));
  const pool = store.pool;

  // ── 1. THE NIGHT NOW FILLS ALL FIVE ──────────────────────────────────────
  // This section used to assert nightly=1 card. NIGHTLY_SLOTS was raised to 5
  // because it is what caps the slate the Scout is asked for -- one slot meant
  // three businesses evaluated, however many the Scout had, and that was the
  // whole reason a night produced one card per athlete. The cost guard that
  // justified 1 is now a $3.00 cap allocated per athlete rather than raced for.
  await reset(pool); await seed(pool, 'ath_c1', 9);
  stub.contacts = PASSING;
  let budget = Q.newBudget(job.CAP_USD);
  let r = await job.fillAthlete(pool, {
    agentId: 'agent_c1', athleteId: 'ath_c1', athleteName: 'T', budget,
    region: 'Fayetteville, AR', maxSlots: Q.NIGHTLY_SLOTS,
  });
  ok('nightly fills all five slots when the candidates are there', r.filled === 5, r.filled);
  let n = (await pool.query(`SELECT COUNT(*)::int c FROM outreach_queue WHERE athlete_id='ath_c1' AND state='queued'`)).rows[0].c;
  ok('  and five rows are in the queue', n === 5, n);
  ok('  one lookup per card placed, no more', stub.contactCalls.length === 5, stub.contactCalls.length);
  ok('  and never more than maxSlots, whatever the pool holds', r.filled <= Q.NIGHTLY_SLOTS, r.filled);
  ok('  and it asked for the LEAN source order', stub.contactCalls[0].ctx.sourceOrder.join(',') === 'chamber,site,facebook', stub.contactCalls[0].ctx.sourceOrder);
  ok('  with waveSize 2', stub.contactCalls[0].ctx.waveSize === 2, stub.contactCalls[0].ctx.waveSize);

  // ── 2. ON DEMAND IS NOW MOSTLY A NO-OP, AND THAT IS CORRECT ──────────────
  // The night fills every slot, so opening an athlete usually finds nothing left
  // to fill. What still has to hold is the CLAIM: one per athlete per day, so an
  // agent flipping between athletes all morning cannot re-trigger spending.
  stub.contactCalls.length = 0;
  const ath = { id: 'ath_c1', agent_id: 'agent_c1', name: 'T', school: 'University of Arkansas', hometown: 'Fayetteville, AR' };
  let od = await job.fillOnDemand(pool, ath);
  ok('first open of the day still claims', od.claimed === true, od);
  ok('  and fills nothing, because the night already did', od.filled === 0, od);
  n = (await pool.query(`SELECT COUNT(*)::int c FROM outreach_queue WHERE athlete_id='ath_c1' AND state='queued'`)).rows[0].c;
  ok('  the queue still holds five, not ten', n === 5, n);

  const callsAfterFirst = stub.contactCalls.length;
  let od2 = await job.fillOnDemand(pool, ath);
  ok('SECOND open the same day does NOT claim again', od2.claimed === false, od2);
  ok('  and spends nothing (no further lookups)', stub.contactCalls.length === callsAfterFirst, stub.contactCalls.length);
  let od3 = await job.fillOnDemand(pool, ath);
  ok('  nor does a third', od3.claimed === false && stub.contactCalls.length === callsAfterFirst);
  const odRow = (await pool.query(`SELECT * FROM outreach_queue_ondemand WHERE athlete_id='ath_c1'`)).rows;
  ok('  exactly one on-demand claim row exists for the day', odRow.length === 1, odRow.length);
  ok('  and tomorrow is a fresh claim', (await job.fillOnDemand(pool, ath, { runDate: '2099-01-01' })).claimed === true);

  // ── 3. On-demand budget is its own $0.15, separate from the nightly ───────
  ok('ONDEMAND_CAP_USD is 0.15', job.ONDEMAND_CAP_USD === 0.15, job.ONDEMAND_CAP_USD);
  // The ceiling must be small enough that the on-demand cap can actually buy a
  // lookup, or on-demand claims its day and fills nothing, forever.
  ok('a single lean lookup FITS inside the on-demand cap', job.LOOKUP_CEILING_USD <= job.ONDEMAND_CAP_USD, job.LOOKUP_CEILING_USD);
  ok('  and the cap buys at least the two slots the night left empty',
    Math.floor(job.ONDEMAND_CAP_USD / job.LOOKUP_CEILING_USD) >= 2,
    { cap: job.ONDEMAND_CAP_USD, ceiling: job.LOOKUP_CEILING_USD });
  await reset(pool); await seed(pool, 'ath_c2', 9);
  stub.contacts = PASSING;
  const od4 = await job.fillOnDemand(pool, { id: 'ath_c2', agent_id: 'agent_c1', name: 'T2', hometown: 'Fayetteville, AR' });
  ok('on-demand can never exceed its own $0.15 cap', od4.spent <= 0.15 + 1e-9, od4.spent);

  // ── 4. Prescreen skips a closed business WITHOUT a paid lookup ────────────
  await reset(pool); await seed(pool, 'ath_c3', 3);
  stub.places = () => ({ businessStatus: 'CLOSED_PERMANENTLY', website: 'https://x.com' });
  stub.contacts = PASSING;
  budget = Q.newBudget(job.CAP_USD);
  r = await job.fillAthlete(pool, { agentId: 'agent_c1', athleteId: 'ath_c3', athleteName: 'T3', budget, region: 'Fayetteville, AR' });
  ok('every candidate closed -> nothing queued', r.filled === 0, r.filled);
  ok('  and NOT ONE paid lookup was made', stub.contactCalls.length === 0, stub.contactCalls.length);
  ok('  budget spent stays at zero', budget.spent() === 0, budget.spent());
  ok('  each is recorded as prescreen_skip', r.tried.every((t) => t.result === 'prescreen_skip'), r.tried);
  ok('  with the Places facts attached for calibration', r.tried[0].places && r.tried[0].places.businessStatus === 'CLOSED_PERMANENTLY', r.tried[0]);

  // ── 5. Backoff: 3 failed nights -> paused, then spends nothing ────────────
  await reset(pool); await seed(pool, 'ath_c4', 30);
  stub.places = () => ({ businessStatus: 'OPERATIONAL', website: 'https://x.com' });
  stub.contacts = FAILING;
  for (let night = 1; night <= 3; night++) {
    const b = Q.newBudget(job.CAP_USD);
    const rr = await job.fillAthlete(pool, {
      agentId: 'agent_c1', athleteId: 'ath_c4', athleteName: 'T4', budget: b,
      region: 'Fayetteville, AR', maxSlots: Q.NIGHTLY_SLOTS,
    });
    await job.recordAttempt(pool, 'ath_c4', { filled: rr.filled, spent: b.spent(), runDate: '2026-08-0' + night });
    const st = await job.athleteState(pool, 'ath_c4');
    if (night < 3) ok(`after night ${night}: counted, not yet paused`, st.consecutive_failures === night && !st.paused_at, st);
    else ok(`after night ${night}: PAUSED`, st.consecutive_failures === 3 && !!st.paused_at, st);
  }
  stub.contactCalls.length = 0;
  stub.placesCalls.length = 0;   // the 3 failed nights above each made Places calls
  const b4 = Q.newBudget(job.CAP_USD);
  const paused = await job.fillAthlete(pool, {
    agentId: 'agent_c1', athleteId: 'ath_c4', athleteName: 'T4', budget: b4,
    region: 'Fayetteville, AR', maxSlots: Q.NIGHTLY_SLOTS,
  });
  ok('night 4 on a paused athlete: reports paused', paused.paused === true, paused);
  ok('  spends NOTHING', b4.spent() === 0 && stub.contactCalls.length === 0, { spent: b4.spent(), calls: stub.contactCalls.length });
  ok('  and not even a Places call is made', stub.placesCalls.length === 0, stub.placesCalls.length);
  ok('  the note explains it stopped', /Nothing is being spent/.test(paused.note), paused.note);

  // ── 6. Same-day re-run cannot double-count toward the pause ──────────────
  await reset(pool); await seed(pool, 'ath_c5', 30);
  stub.contacts = FAILING;
  await job.recordAttempt(pool, 'ath_c5', { filled: 0, spent: 0.26, runDate: '2026-08-01' });
  await job.recordAttempt(pool, 'ath_c5', { filled: 0, spent: 0.26, runDate: '2026-08-01' });
  await job.recordAttempt(pool, 'ath_c5', { filled: 0, spent: 0.26, runDate: '2026-08-01' });
  let st5 = await job.athleteState(pool, 'ath_c5');
  ok('three attempts on the SAME date count as one night', st5.consecutive_failures === 1, st5);
  ok('  so it is not paused', !st5.paused_at, st5);

  // ── 7. A night that spends nothing does not count ────────────────────────
  await job.recordAttempt(pool, 'ath_c5', { filled: 0, spent: 0, runDate: '2026-08-02' });
  st5 = await job.athleteState(pool, 'ath_c5');
  ok('a zero-spend night (no candidates) does not advance the counter', st5.consecutive_failures === 1, st5);

  // ── 8. A success resets and un-pauses ────────────────────────────────────
  await job.recordAttempt(pool, 'ath_c5', { filled: 0, spent: 0.26, runDate: '2026-08-03' });
  await job.recordAttempt(pool, 'ath_c5', { filled: 0, spent: 0.26, runDate: '2026-08-04' });
  st5 = await job.athleteState(pool, 'ath_c5');
  ok('two more failed nights -> paused', st5.consecutive_failures === 3 && !!st5.paused_at, st5);
  await job.recordAttempt(pool, 'ath_c5', { filled: 1, spent: 0.26, runDate: '2026-08-05' });
  st5 = await job.athleteState(pool, 'ath_c5');
  ok('one successful fill RESETS the counter', st5.consecutive_failures === 0, st5);
  ok('  and clears the pause', !st5.paused_at, st5);

  OUT.push(''); OUT.push('failures: ' + FAIL);
  console.log(OUT.join('\n'));
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => { console.error('THREW', e); process.exit(1); });
