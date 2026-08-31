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
// MIGRATING clients -> athletes. A name is a weak key, so the point of this test
// is the failure modes: ambiguity, conflict, and the customer who must not move.
const ROOT = REPO;
const store=require(ROOT+'server/store.js');
const co=require(ROOT+'server/services/compliance.js');
const SEED=require(ROOT+'server/services/seedMarker.js');
const { execSync }=require('child_process');
let F=0; const ok=(n,c,g)=>{if(c)console.log('  PASS '+n);else{F++;console.log('  FAIL '+n+(g!==undefined?'  got='+JSON.stringify(g):''));}};
const ENV='PGHOST=/tmp PGPORT=55432 PGUSER=postgres PGDATABASE=postgres NODE_PATH='+ROOT+'node_modules';
const S=ROOT+'scripts/clients-to-athletes.js';
const run=(a)=>{try{return{code:0,out:execSync(ENV+' node '+S+' '+a+' 2>&1',{encoding:'utf8'})};}
  catch(e){return{code:e.status,out:String(e.stdout||'')+String(e.stderr||'')};}};

(async()=>{
  await new Promise(r=>setTimeout(r, TEST_INIT_WAIT_MS));
  const P=store.pool;
  await P.query('DROP TABLE IF EXISTS clients');
  await P.query("DELETE FROM athletes WHERE agent_id IN ('jm','chris')");
  await P.query("DELETE FROM users WHERE id IN ('jm','chris') OR email IN ('jmcompton04@gmail.com','chris@sarveragency.com')");
  await P.query("INSERT INTO users (id,name,email,password,role) VALUES ('jm','Jonathan Compton','jmcompton04@gmail.com','x','agent'),('chris','Chris Sarver','chris@sarveragency.com','x','agent')");
  const MINE=['Marcus Hall','Kaden House','Priya Nelson','Devon Price','Amber Bretton','Jeremiah Wilkinson','Tia Okafor','Luis Bardales'];
  for(let i=0;i<MINE.length;i++) await P.query("INSERT INTO athletes (id,agent_id,data) VALUES ($1,'jm',$2::jsonb)",['a'+i,JSON.stringify({name:MINE[i],school:'Auburn University'})]);
  for(const [id,n,dob,ig] of [['c1','Tyrell Boone','2001-07-14',44210],['c2','Marisol Vega','2002-02-08',96500],['c3','Andre Whitlock','2000-11-30',18900]])
    await P.query("INSERT INTO athletes (id,agent_id,data) VALUES ($1,'chris',$2::jsonb)",[id,JSON.stringify({name:n,dob,instagram:ig,reachSource:'athlete',reachAsOf:'2026-05-02'})]);
  await P.query('CREATE TABLE clients (id TEXT PRIMARY KEY, agent_id TEXT, data JSONB)');
  const seed={at:'2026-08-24T10:00:00Z',by:'scripts/seed-demo-athletes.js',note:'Fabricated.',fields:['dob','instagram','reachAsOf','reachSource']};
  const DOB=['2004-06-17','2004-01-11','2008-03-19','2003-12-09','2004-04-21','2004-10-27','2007-03-04','2007-05-25'];
  const IG=[16400,26100,30300,28700,8100,33500,14800,33000];
  for(let i=0;i<MINE.length;i++) await P.query('INSERT INTO clients VALUES ($1,$2,$3::jsonb)',
    ['k'+i,'jm',JSON.stringify({name:MINE[i],dob:DOB[i],instagram:IG[i],reachAsOf:'2026-08-24',reachSource:'athlete',_seed:seed})]);
  for(let i=0;i<8;i++) await P.query('INSERT INTO clients VALUES ($1,$2,$3::jsonb)',['x'+i,'jm',JSON.stringify({name:'Former Client '+(i+1),dob:'2000-01-15'})]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('dup','jm','{"name":"Marcus Hall"}'::jsonb)`);
  await P.query(`UPDATE athletes SET data = data || '{"dob":"1998-02-02"}'::jsonb WHERE id='a6'`);

  const chrisBefore=(await P.query("SELECT md5(string_agg(data::text,'|' ORDER BY id)) h FROM athletes WHERE agent_id='chris'")).rows[0].h;
  const clientsBefore=(await P.query('SELECT COUNT(*)::int c FROM clients')).rows[0].c;

  console.log('\n-- the diff says what each table holds --');
  let x=run('--diff');
  ok('it reads the clients shape without assuming it', /clients columns: id, agent_id, data/.test(x.out));
  ok('  and names the rows only clients has', /Former Client 1/.test(x.out));
  ok('  flagging the ambiguous name', /AMBIGUOUS: 2 athletes share this name/.test(x.out));

  console.log('\n-- the dry run writes nothing --');
  x=run('--agent jm');
  ok('it plans the copy', /Kaden House\s+dob=2004-01-11/.test(x.out));
  ok('  and says nothing was written', /Nothing was written/.test(x.out));
  const midDob=(await P.query("SELECT data->>'dob' d FROM athletes WHERE id='a1'")).rows[0].d;
  ok('  athletes is untouched after a dry run', midDob===null, midDob);

  console.log('\n-- guards, same as the seeder --');
  ok('no --agent is refused', run('').code===2);
  ok('--write without --expect-email is refused', run('--agent jm --write').code===2);
  ok("MY EMAIL WITH CHRIS'S ID IS REFUSED", run('--agent chris --write --expect-email jmcompton04@gmail.com').code===2);

  console.log('\n-- the write --');
  x=run('--agent jm --write --expect-email jmcompton04@gmail.com');
  ok('it reports every row it would not guess at', /2 athletes share that name/.test(x.out) && /no athlete of that name/.test(x.out));
  ok('  including a real value it refused to overwrite', /already holds a different dob \(1998-02-02/.test(x.out));
  ok('  and proves the other agent was untouched', /BYTE-IDENTICAL/.test(x.out), x.out.slice(-300));

  const rows=(await P.query("SELECT id,data FROM athletes WHERE agent_id='jm' ORDER BY id")).rows;
  const byName=(n)=>rows.filter(r=>r.data.name===n);
  ok('seven athletes now return a real age',
    rows.filter(r=>co.ageFrom(r.data.dob).known).length===7,
    rows.filter(r=>co.ageFrom(r.data.dob).known).length);
  ok('  the ambiguous name was left alone entirely',
    byName('Marcus Hall').every(r=>!r.data.dob&&!r.data.instagram), byName('Marcus Hall').map(r=>r.data));
  const tia=byName('Tia Okafor')[0].data;
  ok('  the conflicting REAL dob was kept', tia.dob==='1998-02-02', tia.dob);
  ok('  but her seeded reach still came across', tia.instagram===14800, tia.instagram);
  ok('  and the marker says reach is fabricated while her dob is NOT',
    SEED.isSeeded(tia,'instagram') && !SEED.isSeeded(tia,'dob'), SEED.seededFields(tia));
  ok('every migrated value stays MARKED as fabricated',
    byName('Kaden House')[0].data._seed && SEED.isSeeded(byName('Kaden House')[0].data,'dob'),
    SEED.seededFields(byName('Kaden House')[0].data));

  console.log('\n-- nothing else moved --');
  const chrisAfter=(await P.query("SELECT md5(string_agg(data::text,'|' ORDER BY id)) h FROM athletes WHERE agent_id='chris'")).rows[0].h;
  ok("CHRIS SARVER'S ROWS ARE BYTE-IDENTICAL", chrisAfter===chrisBefore, {chrisBefore,chrisAfter});
  const clientsAfter=(await P.query('SELECT COUNT(*)::int c FROM clients')).rows[0].c;
  ok('clients was not modified or dropped', clientsAfter===clientsBefore, {clientsBefore,clientsAfter});
  ok('  and still exists', !!(await P.query("SELECT to_regclass('public.clients') t")).rows[0].t);

  console.log('\n-- re-running changes nothing --');
  const before2=(await P.query("SELECT md5(string_agg(data::text,'|' ORDER BY id)) h FROM athletes WHERE agent_id='jm'")).rows[0].h;
  run('--agent jm --write --expect-email jmcompton04@gmail.com');
  const after2=(await P.query("SELECT md5(string_agg(data::text,'|' ORDER BY id)) h FROM athletes WHERE agent_id='jm'")).rows[0].h;
  ok('a second run is a no-op', before2===after2);

  await P.query('DROP TABLE IF EXISTS clients');
  await P.query("DELETE FROM athletes WHERE agent_id IN ('jm','chris')");
  await P.query("DELETE FROM users WHERE id IN ('jm','chris')");
  console.log('\nfailures: '+F);
  await P.end(); process.exit(F?1:0);
})().catch(e=>{console.error('THREW',e.message);process.exit(1)});
