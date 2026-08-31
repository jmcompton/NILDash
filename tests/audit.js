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
// LAST NIGHT'S AUDIT: the address that never reached the draft, the budget that
// was a race rather than a budget, and the epoch that read as 20689 days.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const Q = require(ROOT + 'server/services/outreachQueue.js');
const DA = require(ROOT + 'server/services/draftAddress.js');
const A = require(ROOT + 'server/services/closerAllocator.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'au-agent';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM brand_evidence_cache WHERE brand LIKE 'Audit %'`).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'A','au@x.com','x','agent','America/Chicago')`, [AG]);

  // ── ITEM 3: THE ADDRESS THAT EXISTED AND NEVER REACHED THE ROW ───────────
  await P.query(
    `INSERT INTO brand_evidence_cache (brand_key, lane, brand, website, evidence, outcome, refreshed_at)
     VALUES ('site:kessler.example | v1','siteemail','Audit Kessler Auto','https://kessler.example',
             $1::jsonb,'OK',NOW())`,
    [JSON.stringify({ email: 'DANA@Kessler.example', type: 'personal', corporate: false,
      sourceUrl: 'https://kessler.example/contact', siteRoot: 'kessler.example' })]);
  await P.query(
    `INSERT INTO brand_evidence_cache (brand_key, lane, brand, website, evidence, outcome, refreshed_at)
     VALUES ('site:franchise.example | v1','siteemail','Audit Franchise Co','https://franchise.example',
             $1::jsonb,'OK',NOW())`,
    [JSON.stringify({ email: 'hq@franchise.example', type: 'generic', corporate: true,
      siteRoot: 'franchise.example' })]);

  const hit = await DA.lookupOne(P, 'Audit Kessler Auto');
  ok('THE ADDRESS IS FINDABLE FROM THE BRAND NAME', !!hit && hit.email === 'dana@kessler.example', hit);
  ok('  normalised to lower case', hit.email === hit.email.toLowerCase(), hit.email);
  ok('  and tagged by kind', hit.kind === 'personal', hit);
  const corp = await DA.lookupOne(P, 'Audit Franchise Co');
  ok('  a franchise HQ inbox is tagged corporate, not passed off as the owner',
    corp.kind === 'corporate' && corp.corporate === true, corp);
  ok('a brand with nothing cached returns null, not a guess',
    (await DA.lookupOne(P, 'Audit Never Checked')) === null);

  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('au-a1',$1,$2::jsonb)`,
    [AG, JSON.stringify({ name: 'Client One', school: 'Auburn University' })]);
  for (const [id, brand] of [['au-l1', 'Audit Kessler Auto'], ['au-l2', 'Audit Franchise Co'],
                             ['au-l3', 'Audit Never Checked']]) {
    await P.query(
      `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status)
       VALUES ($1,$2,'au-a1',$3,'Hi','<p>x</p>','draft')`, [id, AG, brand]);
  }
  const before = (await P.query(
    `SELECT COUNT(*)::int n FROM outreach_logs WHERE agent_id=$1 AND sent_to_email IS NOT NULL`,
    [AG])).rows[0].n;
  ok('the drafts start with NO address, which is the bug', before === 0, before);

  const att = await DA.attach(P, { agentId: AG });
  ok('THE BACKFILL ATTACHES THE ADDRESSES THAT EXIST', att.attached === 2, att);
  ok('  and reports the one with none rather than inventing it', att.missing === 1, att);
  const rows = (await P.query(
    `SELECT id, sent_to_email, email_kind FROM outreach_logs WHERE agent_id=$1 ORDER BY id`, [AG])).rows;
  ok('  the address is on the row now', rows[0].sent_to_email === 'dana@kessler.example', rows[0]);
  ok('  with its kind', rows[0].email_kind === 'personal', rows[0]);
  ok('  and the unknown one stays null', rows[2].sent_to_email === null, rows[2]);

  // AN EXISTING ADDRESS IS NEVER OVERWRITTEN.
  await P.query(`UPDATE outreach_logs SET sent_to_email='owner@real.example' WHERE id='au-l3'`);
  await DA.attach(P, { agentId: AG });
  ok('an address already on a row is NOT overwritten',
    (await P.query(`SELECT sent_to_email FROM outreach_logs WHERE id='au-l3'`)).rows[0].sent_to_email
      === 'owner@real.example');

  // The draft insert itself carries the column now.
  const fs = require('fs');
  const PW = fs.readFileSync(ROOT + 'server/services/draftPrewarm.js', 'utf8');
  ok('NEW DRAFTS ARE BORN WITH AN ADDRESS', /sent_to_email, email_kind/.test(PW), null);
  ok('  looked up, not invented', /lookupOne\(pool, brand\)/.test(PW), null);

  // ── ITEM 1: THE BUDGET IS ALLOCATED, NOT A RACE ──────────────────────────
  ok('the nightly cap is no longer fifty cents', Q.DEFAULT_AGENT_NIGHTLY_USD >= 3,
    Q.DEFAULT_AGENT_NIGHTLY_USD);

  const b = Q.newBudget(3.00);
  b.openFor(6);
  ok('SIX ATHLETES EACH GET A SHARE', Math.abs(b.shareOf() - 0.5) < 1e-9, b.shareOf());
  ok('  an athlete can spend inside their share', b.canSpend(0.06) === true);
  b.spend(0.5);
  ok('  and is stopped at it', b.canSpend(0.06) === false, b.shareLeft());
  ok('  WITHOUT the night being over', b.canSpendFromPot(0.06) === true, b.remaining());

  // THE UNSPENT SHARE FLOWS FORWARD.
  const b2 = Q.newBudget(3.00);
  b2.openFor(6); b2.spend(0.10);          // athlete 1 was cheap
  b2.openFor(5);
  ok('AN UNSPENT SHARE IS NOT LOST — it funds the rest',
    b2.shareOf() > 0.5, b2.shareOf());
  ok('  computed from what is actually left', Math.abs(b2.shareOf() - (2.90 / 5)) < 1e-9, b2.shareOf());

  // THE LAST ATHLETE IS NOT STARVED BY THE ORDERING.
  const b3 = Q.newBudget(3.00);
  let served = 0;
  for (let i = 0; i < 6; i++) {
    b3.openFor(6 - i);
    if (b3.canSpend(0.06)) { b3.spend(0.06); served++; }
  }
  ok('EVERY ATHLETE IN A SIX-ATHLETE ROSTER GETS SERVED', served === 6, served);

  // The old behaviour, for contrast: a flat cap with no shares starved the tail.
  const flat = Q.newBudget(0.50);
  let flatServed = 0;
  for (let i = 0; i < 6; i++) {
    for (let k = 0; k < 3; k++) if (flat.canSpendFromPot(0.06)) flat.spend(0.06);
    if (flat.spent() < 0.50) flatServed++;
  }
  ok('  where the old flat 50c cap ran out partway', flat.spent() >= 0.48, flat.spent());

  // The reason names WHICH limit stopped it.
  const bs = Q.newBudget(3.00); bs.openFor(6); bs.spend(0.5);
  ok('a share-exhausted athlete is told the money is held for others',
    /share of tonight/.test(Q.slotSkipReason(bs, 0.06)), Q.slotSkipReason(bs, 0.06));
  const bc = Q.newBudget(0.06); bc.openFor(1); bc.spend(0.06);
  ok('  and a truly spent night says the cap is gone',
    /night's cap is spent/.test(Q.slotSkipReason(bc, 0.06)), Q.slotSkipReason(bc, 0.06));

  // ── COST IS MEASURED, NOT ASSUMED ────────────────────────────────────────
  ok('a lookup is priced from real counts',
    Q.priceOf({ webSearches: 3, aiCalls: 3 }) === 0.039,
    Q.priceOf({ webSearches: 3, aiCalls: 3 }));
  ok('  a cached lookup with no calls costs nothing',
    Q.priceOf({ webSearches: 0, aiCalls: 0 }) === 0);
  const sum = Q.costSummary([
    [{ cached: false, cost: 0.039 }, { cached: true, cost: 0 }],
    [{ cached: false, cost: 0.02 }],
  ]);
  ok('the run reports a per-athlete figure', sum.athletes === 2, sum);
  ok('  and a per-paid-lookup figure', sum.perPaidLookupUsd > 0, sum);
  ok('  counting cached lookups separately', sum.cachedLookups === 1, sum);

  const JOB = fs.readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the job charges the MEASURED cost, not the ceiling',
    /let realCost = out\.cached \? 0 : Q\.priceOf\(meter\)/.test(JOB), null);
  // A zero on an UNCACHED lookup means the meter failed, not that the lookup was
  // free. Charging it as free would silently switch off both the cap and the
  // backoff, which only records a night that actually spent.
  ok('  but an uncached lookup is never treated as free',
    /if \(!out\.cached && realCost <= 0\)[\s\S]{0,120}realCost = LOOKUP_CEILING_USD/.test(JOB), null);
  ok('  and it says the measurement failed rather than going quiet',
    /the meter[\s\S]{0,80}recorded no calls/.test(JOB), null);
  ok('  while still reserving at the ceiling before spending',
    /canSpend\(LOOKUP_CEILING_USD\)/.test(JOB), null);
  ok('  and one athlete\'s share no longer ends the night',
    /if \(r\.cappedOut\) \{/.test(JOB) && /const potGone = !budget\.canSpendFromPot/.test(JOB), null);

  // ── ITEM 4: THE EPOCH BUG ────────────────────────────────────────────────
  const sig = await A.gatherSignals(P, AG);
  const one = sig.find((x) => x.id === 'au-a1');
  ok('AN ATHLETE NEVER SENT FOR READS AS NEVER, NOT 1970',
    one.daysSinceTouch === null, one.daysSinceTouch);
  ok('  and is flagged neverTouched', one.neverTouched === true, one);
  const plan = A.allocate(sig, 10);
  const pick = plan.picks.find((p) => p.athleteId === 'au-a1');
  ok('  so the reason says nothing sent YET, not 20689 days',
    pick && /nothing sent yet/.test(pick.reason), pick && pick.reason);
  ok('  and no reason anywhere claims a five-digit day count',
    !plan.picks.some((p) => /\d{4,} days/.test(p.reason || '')), plan.picks.map((p) => p.reason));

  // A real send date still measures correctly.
  await P.query(`UPDATE outreach_logs SET sent_at = NOW() - INTERVAL '9 days', status='sent' WHERE id='au-l1'`);
  const sig2 = await A.gatherSignals(P, AG);
  const two = sig2.find((x) => x.id === 'au-a1');
  ok('a real last-sent date measures correctly',
    two.daysSinceTouch > 8.5 && two.daysSinceTouch < 9.5, two.daysSinceTouch);
  ok('  and neverTouched is now false', two.neverTouched === false, two);

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
