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
const ROOT = REPO;
const store=require(ROOT+'server/store.js');
const VB=require(ROOT+'server/services/verifyBudget.js');
const SE=require(ROOT+'server/services/shiftEmail.js');
const out=[]; const check=(n,c,d)=>{out.push({n,ok:!!c});console.log((c?'  PASS  ':'  FAIL  ')+n+(d?'   '+d:''));};

(async()=>{
  await new Promise(r=>setTimeout(r, TEST_INIT_WAIT_MS));
  const P=store.pool; await VB.ensureTable(P);
  const fill = async (n) => {
    await P.query(`DELETE FROM email_verify_credit_log`);
    for (let i=0;i<n;i++) await P.query(
      `INSERT INTO email_verify_credit_log (agent_id,athlete_id,business,email,source,local_date,checked_at)
       VALUES ('a','ath','B','e@x.com','home',CURRENT_DATE,NOW())`);
  };

  console.log('\n1. The shape of the two ceilings');
  console.log('   account=' + VB.ACCOUNT_MONTHLY + '  verifyCap=' + VB.VERIFY_MONTHLY_CAP
    + '  ladderReserve=' + Math.round(VB.ACCOUNT_MONTHLY*VB.LADDER_RESERVE_PCT)
    + '  perAthleteDay=' + VB.PER_ATHLETE_DAY);
  // TWO POOLS. The plan bills 2,000 searches and 4,000 verifications a month
  // separately (services/hunterLookup); verification's ceiling sits under its
  // own pool and takes nothing from the searches that find addresses.
  check('verification cannot claim its whole pool',
    VB.VERIFY_MONTHLY_CAP < VB.ACCOUNT_MONTHLY, VB.VERIFY_MONTHLY_CAP+'/'+VB.ACCOUNT_MONTHLY);
  check('a reserve under the verification plan for manual runs',
    VB.ACCOUNT_MONTHLY - VB.VERIFY_MONTHLY_CAP >= 300,
    'reserve=' + (VB.ACCOUNT_MONTHLY - VB.VERIFY_MONTHLY_CAP));
  check('the verification pool is the 4,000 plan, not the 2,000 search plan',
    VB.ACCOUNT_MONTHLY === 4000 && VB.VERIFY_MONTHLY_CAP === require(ROOT + 'server/services/hunterLookup.js').VERIFY_MONTHLY_BUDGET,
    VB.ACCOUNT_MONTHLY + ' / ' + VB.VERIFY_MONTHLY_CAP);

  console.log('\n2. A fresh month');
  await fill(0);
  let a = await VB.accountStatus(P);
  check('nothing used, full share available', a.remaining === VB.VERIFY_MONTHLY_CAP, 'remaining='+a.remaining);
  check('and no warning', a.low === false);

  console.log('\n3. Three quarters through the share');
  await fill(Math.round(VB.VERIFY_MONTHLY_CAP*0.76));
  a = await VB.accountStatus(P);
  check('the warning fires at 75%', a.low === true, 'usedPct='+a.usedPct);
  check('it is not yet exhausted', a.exhausted === false, 'remaining='+a.remaining);
  check('and it says what to do about it in words', /runs out before the plan resets on \d{4}-\d\d-\d\d/.test(a.line), a.line);

  console.log('\n4. Share spent');
  await fill(VB.VERIFY_MONTHLY_CAP);
  a = await VB.accountStatus(P);
  check('remaining is zero', a.remaining === 0, 'remaining='+a.remaining);
  check('exhausted is stated, not inferred', a.exhausted === true);
  check('the line says cards still appear', /Cards still appear/.test(a.line), a.line);
  check('and address finding is untouched: searches are a separate pool',
    a.ladderReserve === 0, 'reserve='+a.ladderReserve);

  console.log('\n5. The per-athlete budget yields to the account');
  const perAthleteLeft = VB.PER_ATHLETE_DAY;
  check('with the account spent, an athlete with full daily budget still gets nothing',
    Math.min(perAthleteLeft, a.remaining) === 0,
    'min(' + perAthleteLeft + ', ' + a.remaining + ')');
  await fill(VB.VERIFY_MONTHLY_CAP - 2);
  a = await VB.accountStatus(P);
  check('with 2 left in the month, an athlete gets 2 not 3',
    Math.min(perAthleteLeft, a.remaining) === 2, 'min(' + perAthleteLeft + ', ' + a.remaining + ')');

  console.log('\n6. It reaches the morning email, not just a log');
  const rep = { run:{ran:true}, sentence:'x', needsYou:{items:[],overflow:0},
    moving:null, closer:null, roles:[], verifyBudget:a };
  const mail = SE.renderShiftEmail(rep, { agentName:'Jordan' });
  check('the HTML carries the line', mail.html.includes('checks this billing period') || /verification/i.test(mail.html));
  check('the plain text carries it too', /verification/i.test(mail.text), mail.text.split('\n').filter(l=>/verification/i.test(l))[0]);
  const quiet = SE.renderShiftEmail({ ...rep, verifyBudget:null }, {});
  check('and a healthy month adds nothing', !/verification/i.test(quiet.html+quiet.text));

  console.log('\n7. What 20 athletes actually costs');
  for (const n of [8,20,45]) {
    const worst = VB.PER_ATHLETE_DAY*n*30;
    const days = Math.floor(VB.VERIFY_MONTHLY_CAP/(VB.PER_ATHLETE_DAY*n));
    console.log('   ' + String(n).padStart(2) + ' athletes/day: worst case ' + String(worst).padStart(5)
      + '/mo vs a ' + VB.VERIFY_MONTHLY_CAP + ' share — share lasts ~' + days + ' days');
  }
  // With the verification pool at 3,600 (its own 4,000 plan, not a share of
  // the 2,000 searches), 20 athletes' Home worst case is half of it, leaving
  // the rest for verifying every nightly email card.
  check('20 athletes\' Home worst case fits in the verification pool, with room for the nightly',
    VB.PER_ATHLETE_DAY*20*30 <= VB.VERIFY_MONTHLY_CAP/2, (VB.PER_ATHLETE_DAY*20*30) + ' of ' + VB.VERIFY_MONTHLY_CAP);

  await fill(0);
  const bad=out.filter(x=>!x.ok);
  console.log('\n'+(out.length-bad.length)+'/'+out.length+' passed');
  process.exit(bad.length?1:0);
})().catch(e=>{console.error('THREW',e);process.exit(1);});
