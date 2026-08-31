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
const fs=require('fs');
const src=fs.readFileSync(REPO + 'server/ai.js','utf8');
const fn=src.match(/async function runSourceWaves\(sources, runOne, opts = \{\}\) \{[\s\S]*?\n\}/)[0];
const m={}; new Function('module','console', fn+'\nmodule.run=runSourceWaves;')(m,{log(){}});
const run=m.run;
const sleep=(ms,v)=>new Promise(r=>setTimeout(()=>r(v),ms));

(async()=>{
  let fails=0;
  const chk=(n,c)=>{ if(!c){fails++;console.log('  FAIL '+n);} else console.log('  PASS '+n); };

  // 1. Parallel: 3 sources at 200ms each should finish in ~200ms, not 600ms.
  let t=Date.now();
  let r=await run(['a','b','c'], s=>sleep(200,{s,win:false}), {waveSize:3});
  const el=Date.now()-t;
  chk('wave runs in parallel ('+el+'ms for 3x200ms)', el<400 && r.results.length===3);

  // 2. Straggler cut: 2 fast (one a win) + 1 slow -> returns without the slow one.
  t=Date.now();
  r=await run(['fast1','fast2','slow'], s=> s==='slow'?sleep(3000,{s,win:false}):sleep(100,{s,win:s==='fast1'}),
              {waveSize:3, hasWin:x=>x.win});
  const el2=Date.now()-t;
  chk('straggler cut after a win ('+el2+'ms, got '+r.results.length+'/3)', el2<1200 && r.results.length===2);

  // 3. NO cut without a win: must wait for all three.
  t=Date.now();
  r=await run(['f1','f2','slow'], s=> s==='slow'?sleep(700,{s,win:false}):sleep(50,{s,win:false}),
              {waveSize:3, hasWin:x=>x.win});
  chk('no cut without a win (waited '+(Date.now()-t)+'ms, got '+r.results.length+')', r.results.length===3);

  // 4. isSatisfied stops wave 2 from running.
  r=await run(['a','b','c','d','e','f'], s=>sleep(20,{s}), {waveSize:3, isSatisfied:all=>all.length>=3});
  chk('early exit between waves (wavesRun='+r.wavesRun+')', r.wavesRun===1 && r.results.length===3);

  // 5. A throwing source does not kill the wave.
  r=await run(['ok','boom'], s=> s==='boom'?Promise.reject(new Error('x')):sleep(20,{s}), {waveSize:2});
  chk('throwing source tolerated (got '+r.results.length+')', r.results.length===1);

  // 6. Wall budget stops further waves.
  r=await run(['a','b','c','d'], s=>sleep(120,{s}), {waveSize:2, wallBudgetMs:50});
  chk('wall budget stops wave 2 (wavesRun='+r.wavesRun+')', r.wavesRun===1);

  console.log('\nfailures: '+fails);
})();
