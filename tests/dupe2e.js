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
// The duplicate the customer saw, end to end, against real Postgres.
const ROOT = REPO;
const store=require(ROOT+'server/store.js');
const Scout=require(ROOT+'server/services/scout.js');
const BI=require(ROOT+'server/services/brandIdentity.js');
const out=[]; const check=(n,c,d)=>{out.push({n,ok:!!c});console.log((c?'  PASS  ':'  FAIL  ')+n+(d?'   '+d:''));};

const AG='dp-agent', ATH='dp-ath', MKT='birmingham-al';

(async()=>{
  await new Promise(r=>setTimeout(r, TEST_INIT_WAIT_MS));
  const P=store.pool;
  for(const t of ['outreach_queue','brand_engagement','outreach_logs','athletes'])
    await P.query(`DELETE FROM ${t} WHERE agent_id=$1`,[AG]).catch(()=>{});
  await P.query(`DELETE FROM outreach_queue WHERE athlete_id=$1`,[ATH]).catch(()=>{});
  await P.query(`DELETE FROM brand_engagement WHERE athlete_id=$1`,[ATH]).catch(()=>{});
  await P.query(`DELETE FROM market_business_seen WHERE market_key=$1`,[MKT]).catch(()=>{});
  await P.query(`DELETE FROM users WHERE id=$1`,[AG]).catch(()=>{});
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'J','dp@x.com','x','agent')`,[AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
    [ATH,AG,JSON.stringify({name:'Marcus Johnson',school:'Birmingham, AL',dob:'2004-09-02'})]);

  console.log('\n1. THE UNIQUE INDEX');
  const ins=async(slot,name,ident)=>{
    try{
      const r=await P.query(
        `INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,state,lane,identity_key)
         VALUES ($1,$2,$3,$4,$5,'queued','local',$6) ON CONFLICT DO NOTHING RETURNING id`,
        [AG,ATH,slot,name,name,ident]);
      return r.rowCount>0;
    }catch(e){ return 'ERR:'+e.message.slice(0,40); }
  };
  check('first card writes', await ins(1,'Cahaba Brewing Company','place:ChIJabc')===true);
  const second=await ins(2,'Cahaba Brewing Co.','place:ChIJabc');
  check('the same business in a DIFFERENT slot is refused by the database',
    second===false, 'wrote='+JSON.stringify(second));
  check('a genuinely different business still writes',
    await ins(2,'Trak Shak','name:trak shak@'+MKT)===true);
  const q1=(await P.query(`SELECT COUNT(*)::int n FROM outreach_queue WHERE athlete_id=$1 AND state='queued'`,[ATH])).rows[0].n;
  check('two cards queued, not three', q1===2, 'n='+q1);

  console.log('\n2. A SENT CARD DOES NOT BLOCK THE BUSINESS FOREVER');
  await P.query(`UPDATE outreach_queue SET state='sent' WHERE slot=1 AND athlete_id=$1`,[ATH]);
  check('with the old card sent, the business can be queued again',
    await ins(1,'Cahaba Brewing Company','place:ChIJabc')===true);
  await P.query(`DELETE FROM outreach_queue WHERE athlete_id=$1`,[ATH]);

  console.log('\n3. THE SLATE: two pools, two spellings, one business');
  // brand_engagement carries a place_id key; the market pool carries only a name.
  await P.query(
    `INSERT INTO brand_engagement (agent_id,athlete_id,brand_key,brand_name,state,lane,last_shown_at)
     VALUES ($1,$2,'place:ChIJcahaba','Cahaba Brewing Company','shown','local',NOW())`,[AG,ATH]);
  for(const b of ['Cahaba Brewing Co.','Trak Shak','Trak Shak Inc','Onyx Coffee Lab (Homewood)','Onyx Coffee Lab'])
    await P.query(`INSERT INTO market_business_seen (market_key,brand) VALUES ($1,$2)
                   ON CONFLICT DO NOTHING`,[MKT,b]);

  const slate=await Scout.assembleSlate(P,{
    agentId:AG, store,
    athlete:{id:ATH, hasLocalMarket:true, marketKey:MKT, school:'Birmingham, AL'},
    limit:20});
  const names=slate.picks.map(p=>p.brand_name);
  console.log('    slate: '+names.join(' | '));
  const keys=slate.picks.map(p=>BI.keyOf(p,{market:MKT}));
  check('no two picks share an identity', new Set(keys).size===keys.length,
    keys.join(', '));
  check('Cahaba appears once', names.filter(n=>/Cahaba/i.test(n)).length===1);
  check('Trak Shak appears once', names.filter(n=>/Trak Shak/i.test(n)).length===1);
  check('Onyx appears once', names.filter(n=>/Onyx/i.test(n)).length===1);

  console.log('\n4. THE MARKET POOL NO LONGER LIES ABOUT brand_key');
  const poolRows=await Scout.localCandidates(P,{agentId:AG,
    athlete:{id:ATH,hasLocalMarket:true,marketKey:MKT,school:'Birmingham, AL'},limit:20});
  const mp=poolRows.rows.filter(r=>r.pool==='market-pool');
  check('market-pool rows carry a NULL brand_key, not a display name',
    mp.length>0 && mp.every(r=>r.brand_key===null), 'sample='+JSON.stringify(mp[0]||null));
  check('and they carry the market_key instead',
    mp.every(r=>r.market_key===MKT), 'market_key='+(mp[0]||{}).market_key);

  console.log('\n5. ALREADY QUEUED -> NOT AGAIN TONIGHT, DESPITE A NAME VARIANT');
  await P.query(
    `INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,state,lane,identity_key)
     VALUES ($1,$2,1,'x','Trak Shak Inc','queued','local',$3)`,
    [AG,ATH,BI.keyOf({brand_name:'Trak Shak Inc',market_key:MKT})]);
  const slate2=await Scout.assembleSlate(P,{
    agentId:AG, store,
    athlete:{id:ATH, hasLocalMarket:true, marketKey:MKT, school:'Birmingham, AL'},
    limit:20});
  const n2=slate2.picks.map(p=>p.brand_name);
  console.log('    slate: '+n2.join(' | '));
  check('the queued business does not come back under another spelling',
    !n2.some(n=>/Trak Shak/i.test(n)), n2.join(', '));

  const bad=out.filter(x=>!x.ok);
  console.log('\n'+(out.length-bad.length)+'/'+out.length+' passed');
  process.exit(bad.length?1:0);
})().catch(e=>{console.error('THREW',e);process.exit(1);});
