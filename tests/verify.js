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
const EV=require(ROOT+'server/services/emailVerify.js');
const H=require(ROOT+'server/services/homeQueue.js');
const sup=require(ROOT+'server/services/suppression.js');
let F=0; const ok=(n,c,g)=>{if(c)console.log('  PASS '+n);else{F++;console.log('  FAIL '+n+(g!==undefined?'  got='+JSON.stringify(g):''));}};
const AG='ev-agent', ATH='ev-ath';

(async()=>{
  await new Promise(r=>setTimeout(r, TEST_INIT_WAIT_MS));
  const P=store.pool;

  console.log('\n-- 1. Hunter status mapping: only a definite no is invalid --');
  for (const [st,want] of [['valid','valid'],['invalid','invalid'],['disposable','invalid'],
    ['accept_all','unknown'],['webmail','unknown'],['unknown','unknown'],['something_new','unknown'],[null,'unknown']]) {
    ok(`"${st}" -> ${want}`, EV.mapHunter(st).result===want, EV.mapHunter(st));
  }

  console.log('\n-- 2. MX: a real domain, a dead one, and a failure that is not a verdict --');
  const memo=new Map();
  const live=await EV.hasMx('gmail.com',memo);
  ok('gmail.com has mail servers', live.ok===true, live);
  const dead=await EV.hasMx('this-domain-should-not-exist-xyzzy-9182.com',memo);
  ok('a nonexistent domain is a real NO', dead.ok===false, dead);
  ok('  and says why in words', /does not exist|no mail server/.test(dead.why), dead.why);
  ok('memoised per domain, not per address', memo.size===2, memo.size);

  console.log('\n-- 3. verifyMany: no key -> unknown, and NOT cached as a finding --');
  await P.query(`DELETE FROM email_verification WHERE email LIKE '%@gmail.com'`).catch(()=>{});
  let r=await EV.verifyMany(P,['someone@gmail.com'],{});
  ok('MX passed but no verifier -> unknown', r.get('someone@gmail.com').result==='unknown', r.get('someone@gmail.com'));
  const rows=(await P.query(`SELECT * FROM email_verification WHERE email='someone@gmail.com'`)).rows;
  ok('  and nothing was written', rows.length===0, rows.length);

  console.log('\n-- 4. a dead domain IS cached, because it is a real answer --');
  await P.query(`DELETE FROM email_verification WHERE email LIKE '%xyzzy%'`).catch(()=>{});
  r=await EV.verifyMany(P,['a@this-domain-should-not-exist-xyzzy-9182.com'],{});
  ok('invalid', r.get('a@this-domain-should-not-exist-xyzzy-9182.com').result==='invalid');
  const c=(await P.query(`SELECT result,source FROM email_verification WHERE email LIKE '%xyzzy%'`)).rows[0];
  ok('  recorded, sourced to mx', c && c.result==='invalid' && c.source==='mx', c);

  console.log('\n-- 5. a verifier OUTAGE is unknown, never invalid --');
  await P.query(`DELETE FROM email_verification WHERE email='out@gmail.com'`).catch(()=>{});
  r=await EV.verifyMany(P,['out@gmail.com'],{verifier:async()=>({ok:false,why:'Hunter timed out'})});
  ok('an unreachable verifier is unknown', r.get('out@gmail.com').result==='unknown', r.get('out@gmail.com'));
  ok('  and is not cached', (await P.query(`SELECT 1 FROM email_verification WHERE email='out@gmail.com'`)).rows.length===0);

  console.log('\n-- 6. Home holds back the known-bad, shows the unknown --');
  for (const t of ['outreach_logs','outreach_queue','athletes']) await P.query(`DELETE FROM ${t} WHERE agent_id=$1`,[AG]).catch(()=>{});
  await P.query(`DELETE FROM users WHERE id=$1`,[AG]).catch(()=>{});
  await P.query(`DELETE FROM email_verification WHERE email LIKE '%@ev.example'`).catch(()=>{});
  await P.query(`DELETE FROM email_suppression WHERE email LIKE '%@ev.example'`).catch(()=>{});
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'A','ev@x.com','x','agent')`,[AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,[ATH,AG,JSON.stringify({name:'Eve Test',school:'Alabama',dob:'2004-01-01'})]);
  const mk=async(id,brand,email)=>{
    await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email)
      VALUES ($1,$2,$3,$4,'S','<p>Hi,</p><p>A real reason to back this athlete goes here.</p>','draft',$5)`,[id,AG,ATH,brand,email]);
  };
  await mk('ev1','Good Co','good@ev.example');
  await mk('ev2','Bounced Co','bounced@ev.example');
  await mk('ev3','Dead Co','dead@ev.example');
  await mk('ev4','Catchall Co','catchall@ev.example');
  await P.query(`INSERT INTO email_verification (email,result,detail,source) VALUES
    ('good@ev.example','valid','confirmed','hunter'),
    ('dead@ev.example','invalid','the verifier says invalid','hunter'),
    ('catchall@ev.example','unknown','the verifier says accept_all','hunter')`);
  await sup.suppress(P,'bounced@ev.example',{reason:'hard bounce'});

  const h=await H.buildHome(P,AG,{athleteId:ATH});
  const shown=h.cards.map(c=>c.business).sort();
  ok('the bounced address never reaches a card', !shown.includes('Bounced Co'), shown);
  ok('the verified-bad address never reaches a card', !shown.includes('Dead Co'), shown);
  ok('the confirmed one is shown', shown.includes('Good Co'), shown);
  ok('THE CATCH-ALL ONE IS SHOWN', shown.includes('Catchall Co'), shown);
  ok('  marked unverified rather than hidden',
    (h.cards.find(c=>c.business==='Catchall Co')||{}).verified==='unknown',
    (h.cards.find(c=>c.business==='Catchall Co')||{}).verified);
  ok('  and the confirmed one says so',
    (h.cards.find(c=>c.business==='Good Co')||{}).verified==='valid');
  ok('both held-back cards are REPORTED, not silently missing', h.withheld.length===2, h.withheld);
  ok('  each with a reason', h.withheld.every(w=>w.why && w.why.length>8), h.withheld);
  ok('no read errors', h.errors.length===0, h.errors);

  for (const t of ['outreach_logs','outreach_queue','athletes']) await P.query(`DELETE FROM ${t} WHERE agent_id=$1`,[AG]).catch(()=>{});
  await P.query(`DELETE FROM users WHERE id=$1`,[AG]).catch(()=>{});
  await P.query(`DELETE FROM email_verification WHERE email LIKE '%@ev.example' OR email LIKE '%xyzzy%'`).catch(()=>{});
  await P.query(`DELETE FROM email_suppression WHERE email LIKE '%@ev.example'`).catch(()=>{});
  console.log('\nfailures: '+F);
  process.exit(F?1:0);
})().catch(e=>{console.error('THREW',e);process.exit(1);});
