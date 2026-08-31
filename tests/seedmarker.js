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
// SEEDED VALUES ARE MARKED, AND THE MARKER STAYS HONEST. Demo data becomes
// production data by being indistinguishable from it, so the two properties that
// matter are: the seeder never destroys a real value, and the marker clears the
// moment a real value replaces a seeded one. Both are asserted against a real
// database and the real endpoints, not against the helper in isolation.
const store=require(REPO + 'server/store.js');
const SEED=require(REPO + 'server/services/seedMarker.js');
const fs=require('fs');
const SRC=fs.readFileSync(REPO + 'server/index.js','utf8');
const ROOT = REPO;
function handlerFor(m,e){const st=SRC.indexOf(m),en=SRC.indexOf(e,st);
  const b=SRC.slice(SRC.indexOf('{',SRC.indexOf('async (req, res)',st)),en);
  const fn=new Function('store','require','req','res','return (async (req,res)=>'+b.slice(0,b.lastIndexOf('}')+1)+')(req,res);');
  return (rq,rs)=>fn(store,(x)=>require(x.replace(/^\.\//,ROOT+'server/')),rq,rs);}
const mkRes=()=>{const r={code:200,body:null,status(c){r.code=c;return r;},json(v){r.body=v;return r;}};return r;};
let F=0; const ok=(n,c,g)=>{if(c)console.log('  PASS '+n);else{F++;console.log('  FAIL '+n+(g!==undefined?'  got='+JSON.stringify(g):''));}};

(async()=>{
  await new Promise(r=>setTimeout(r, TEST_INIT_WAIT_MS));
  const P=store.pool;
  // Build the roster this test operates on, so it does not depend on a previous run.
  await P.query("DELETE FROM athletes WHERE agent_id='seed-demo'");
  const NAMES=['Marcus Hall','Kaden House','Priya Nelson','Devon Price','Amber Bretton','Jeremiah Wilkinson','Tia Okafor','Luis Bardales'];
  for(let i=0;i<NAMES.length;i++)
    await P.query("INSERT INTO athletes (id,agent_id,data) VALUES ($1,'seed-demo',$2::jsonb)",
      ['sd-'+i, JSON.stringify({name:NAMES[i],school:'Auburn University',sport:'football'})]);
  // A SECOND, REAL ROSTER ON THE SAME DATABASE. Every scoping assertion below is
  // meaningless without one: "it only touched my rows" is only a claim if there
  // are other rows it could have touched.
  await P.query("DELETE FROM athletes WHERE agent_id='chris-sarver'");
  await P.query("DELETE FROM users WHERE id IN ('seed-demo','chris-sarver')");
  await P.query("INSERT INTO users (id,name,email,password,role) VALUES ('seed-demo','Jonathan Compton','jmcompton04@gmail.com','x','agent')");
  await P.query("INSERT INTO users (id,name,email,password,role) VALUES ('chris-sarver','Chris Sarver','chris@sarveragency.com','x','agent')");
  const HIS=[['cs-1','Tyrell Boone','2001-07-14',44210],['cs-2','Marisol Vega','2002-02-08',96500],['cs-3','Andre Whitlock','2000-11-30',18900]];
  for(const [id,name,dob,ig] of HIS)
    await P.query("INSERT INTO athletes (id,agent_id,data) VALUES ($1,'chris-sarver',$2::jsonb)",
      [id,JSON.stringify({name,school:'Ole Miss',sport:'basketball',dob,instagram:ig,reachSource:'athlete',reachAsOf:'2026-05-02'})]);
  const HIS_BEFORE=JSON.stringify((await P.query("SELECT data FROM athletes WHERE agent_id='chris-sarver' ORDER BY id")).rows);

  const SEEDER=REPO + 'scripts/seed-demo-athletes.js';
  const ENVV='PGHOST=/tmp PGPORT=55432 PGUSER=postgres PGDATABASE=postgres NODE_PATH=node_modules';
  const tryRun=(args)=>{ try { return { code:0, out:require('child_process').execSync(ENVV+' node '+SEEDER+' '+args+' 2>&1',{encoding:'utf8'}) }; }
    catch(e){ return { code:e.status, out:String(e.stdout||'')+String(e.stderr||'') }; } };

  console.log('\n-- it cannot touch a roster you did not name --');
  let x=tryRun('');
  ok('no --agent is refused', x.code===2, x.code);
  ok('  and says there is no default', /no default roster/.test(x.out), x.out.split('\n')[0]);
  x=tryRun('--agent does-not-exist');
  ok('an unknown id is refused', x.code===2, x.code);
  ok('  rather than resolving to somebody else', /fails here rather than resolving/.test(x.out), null);
  x=tryRun('--agent seed-demo --write');
  ok('--write without --expect-email is refused', x.code===2, x.code);
  x=tryRun('--agent chris-sarver --write --expect-email jmcompton04@gmail.com');
  ok('MY EMAIL WITH HIS ID IS REFUSED', x.code===2, x.code);
  ok('  naming both sides of the mismatch',
    /chris-sarver.*belongs to.*Chris Sarver/.test(x.out) && /jmcompton04@gmail.com/.test(x.out), null);

  console.log('\n-- the dry run says whose roster before anything happens --');
  x=tryRun('--agent seed-demo');
  ok('it names the agent', /Jonathan Compton/.test(x.out) && /seed-demo/.test(x.out));
  ok('  their email', /jmcompton04@gmail\.com/.test(x.out));
  ok('  the roster size', /athletes  8/.test(x.out), (x.out.match(/athletes\s+\d+/)||[])[0]);
  ok('  and states the scope in the statement itself', /binds agent_id = "seed-demo"/.test(x.out));
  ok('  and writes nothing', /Nothing was written/.test(x.out));

  require('child_process').execSync(ENVV+" node "+SEEDER+" --agent seed-demo --write --expect-email jmcompton04@gmail.com",{encoding:'utf8'});

  console.log('\n-- the real customer is untouched --');
  const HIS_AFTER=JSON.stringify((await P.query("SELECT data FROM athletes WHERE agent_id='chris-sarver' ORDER BY id")).rows);
  ok("CHRIS SARVER'S ROSTER IS BYTE-IDENTICAL", HIS_AFTER===HIS_BEFORE, null);
  const hisSeeded=(await P.query("SELECT COUNT(*)::int n FROM athletes WHERE agent_id='chris-sarver' AND data ? '_seed'")).rows[0].n;
  ok('  and none of it is marked seeded', hisSeeded===0, hisSeeded);
  x=tryRun('--audit');
  ok('--audit shows fabricated data on MY roster', /Jonathan Compton.*8\s+<-- FABRICATED/.test(x.out), null);
  ok('  and zero on his', /Chris Sarver.*3\s+0/.test(x.out), (x.out.match(/Chris Sarver.*/)||[])[0]);
  ok('  without printing any of his athletes', !/Tyrell Boone|Marisol Vega|Andre Whitlock/.test(x.out), null);
  x=tryRun('--agent seed-demo --list');
  ok('--list names whose roster it is showing', /JONATHAN COMPTON'S ROSTER/.test(x.out), null);
  ok('  and points at --audit for the rest', /run --audit/.test(x.out), null);

  console.log('\n-- the seeded roster is all adults, checked not claimed --');
  const all=(await P.query("SELECT data FROM athletes WHERE agent_id='seed-demo' ORDER BY id")).rows.map(r=>r.data);
  const co=require(REPO + 'server/services/compliance.js');
  const ages=all.map(a=>co.ageFrom(a.dob).years);
  ok('every athlete has a date of birth', all.every(a=>!!a.dob), all.map(a=>a.dob));
  ok('  all are 18 or over', ages.every(y=>y>=18), ages);
  ok('  and none over 22', ages.every(y=>y<=22), ages);
  ok('  spread, not identical', new Set(ages).size>=3, ages);
  const igs=all.map(a=>a.instagram);
  ok('follower counts are 8,000 to 40,000', igs.every(n=>n>=8000&&n<=40000), igs);
  ok('  and varied', new Set(igs).size===igs.length, igs);
  ok('every count is stamped with today', all.every(a=>a.reachAsOf===new Date().toISOString().slice(0,10)), all.map(a=>a.reachAsOf));
  ok('  and source athlete', all.every(a=>a.reachSource==='athlete'), all.map(a=>a.reachSource));
  ok('EVERY seeded athlete is marked', all.every(a=>SEED.seededFields(a).length>0), all.map(a=>SEED.seededFields(a).length));
  const get=async(id)=>(await P.query("SELECT data FROM athletes WHERE id=$1",[id])).rows[0].data;

  console.log('\n-- a REAL value is never clobbered by the seeder --');
  // Marcus Hall already has a seeded dob. Replace it with a real one (no marker).
  await P.query("UPDATE athletes SET data = jsonb_set(data,'{dob}','\"1999-01-02\"') WHERE id='sd-0'");
  await P.query(`UPDATE athletes SET data = ${SEED.clearSql('data','$1::text[]')} WHERE id='sd-0'`, [['dob']]);
  let d=await get('sd-0');
  ok('the dob is now real (not in the marker)', !SEED.isSeeded(d,'dob'), SEED.seededFields(d));
  const { execSync }=require('child_process');
  const out=execSync("PGHOST=/tmp PGPORT=55432 PGUSER=postgres PGDATABASE=postgres NODE_PATH=node_modules node scripts/seed-demo-athletes.js --agent seed-demo --write --expect-email jmcompton04@gmail.com 2>&1",{encoding:'utf8'});
  d=await get('sd-0');
  ok('  the seeder LEFT IT ALONE', d.dob==='1999-01-02', d.dob);
  ok('  and said so', /dob.*real, kept/.test(out), (out.match(/Marcus Hall.*/)||[])[0]);
  ok('  while still seeding the other fields', SEED.isSeeded(d,'instagram'), SEED.seededFields(d));

  console.log('\n-- onboarding UNMARKS the field it replaces --');
  const reachH=handlerFor("app.post('/api/athlete/onboarding/reach'","\n// GET /api/athlete/onboarding/status");
  let before=await get('sd-1');
  ok('instagram starts seeded', SEED.isSeeded(before,'instagram'), SEED.seededFields(before));
  let r=mkRes();
  await reachH({athlete:{id:'sd-1'},body:{instagram:'21500'}},r);
  let after=await get('sd-1');
  ok('  the athlete\'s real number is stored', after.instagram===21500, after.instagram);
  ok('  and instagram is NO LONGER marked seeded', !SEED.isSeeded(after,'instagram'), SEED.seededFields(after));
  ok('  but dob is still marked, because it was not touched', SEED.isSeeded(after,'dob'), SEED.seededFields(after));

  console.log('\n-- the marker disappears entirely once nothing is fabricated --');
  const profileH=handlerFor("app.post('/api/athlete/onboarding/profile'","\n// POST /api/athlete/onboarding/photo");
  r=mkRes(); await profileH({athlete:{id:'sd-1'},body:{dob:'2005-06-15'}},r);
  // clear the remaining seeded fields the same way a real write would
  await P.query(`UPDATE athletes SET data = ${SEED.clearSql('data','$1::text[]')} WHERE id='sd-1'`,[['reachAsOf','reachSource','tiktok']]);
  const fin=await get('sd-1');
  ok('  no seeded fields left', SEED.seededFields(fin).length===0, SEED.seededFields(fin));
  ok('  and the _seed key is GONE, not an empty husk', fin._seed===undefined, fin._seed);

  console.log('\nfailures: '+F);
  await P.query("DELETE FROM athletes WHERE agent_id='seed-demo'");
  await P.end(); process.exit(F?1:0);
})().catch(e=>{console.error('THREW',e.message);process.exit(1)});
