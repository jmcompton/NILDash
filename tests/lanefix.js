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
const store = require(ROOT+'server/store.js');
const Closer = require(ROOT+'server/services/closer.js');
let F=0; const ok=(n,c,g)=>{if(c)console.log('  PASS '+n);else{F++;console.log('  FAIL '+n+(g!==undefined?'  got='+JSON.stringify(g):''));}};

console.log('\n-- 1. an unknown lane is never shown as Local --');
ok('null lane does not read as Local', Closer.laneLabel({ lane:null, biz_address:'1 A St, Sunnyvale, CA 94085' }) === 'Lane not recorded',
  Closer.laneLabel({ lane:null, biz_address:'1 A St, Sunnyvale, CA 94085' }));
ok('  and does NOT borrow the city either', !/Sunnyvale/.test(Closer.laneLabel({ lane:null, biz_address:'1 A St, Sunnyvale, CA 94085' })));
ok('national still reads National', Closer.laneLabel({ lane:'national' }) === 'National');
ok('social still reads DTC', Closer.laneLabel({ lane:'social' }) === 'DTC');
ok('a real local card still shows its city',
  Closer.laneLabel({ lane:'local', biz_address:'1 Main St, College Park, MD 20740' }) === 'Local · College Park');
ok('local with no address shows no city', Closer.laneLabel({ lane:'local', biz_address:null }) === 'Local');

console.log('\n-- 2. placeholders are rejected, real names are not --');
const P = store.placeholderReason;
for (const [name, want] of [
  ['Core Physical Therapy (or similar local PT/chiro near campus)', true],
  ['Any local coffee shop near campus', true],
  ['a gym, e.g. Planet Fitness', true],
  ['PT/chiro clinic', true],
  ['Something Long '.repeat(6), true],
  ['Post Office Pies', false],
  ["Saw's BBQ", false],
  ['Smith & Sons (Est. 1974)', false],
  ['Ben & Jerry’s', false],
  ['Chick-fil-A', false],
  ['TrimTab Brewing Company', false],
]) {
  const why = P(name);
  ok(`${want?'REJECT':'keep  '} "${name.slice(0,42)}"`, (!!why) === want, why);
}

(async () => {
  await new Promise(r=>setTimeout(r, TEST_INIT_WAIT_MS));
  const Pg = store.pool;
  console.log('\n-- 3. the rejection is recorded, not dropped --');
  await Pg.query(`DELETE FROM market_business_rejected WHERE market_key='lanefix-mkt'`).catch(()=>{});
  await Pg.query(`DELETE FROM market_business_seen WHERE market_key='lanefix-mkt'`).catch(()=>{});
  await store.markMarketNewcomers('lanefix-mkt',
    ['Post Office Pies', 'Core Physical Therapy (or similar local PT/chiro near campus)', 'Trak Shak']);
  const kept = (await Pg.query(`SELECT brand FROM market_business_seen WHERE market_key='lanefix-mkt' ORDER BY brand`)).rows.map(r=>r.brand);
  const rej  = (await Pg.query(`SELECT brand, reason FROM market_business_rejected WHERE market_key='lanefix-mkt'`)).rows;
  ok('the two real businesses were kept', kept.length===2 && kept.includes('Post Office Pies'), kept);
  ok('the placeholder was NOT written as a business', !kept.some(b=>/or similar/.test(b)), kept);
  ok('  and it IS on the rejected record', rej.length===1 && /Core Physical/.test(rej[0].brand), rej);
  ok('  with a reason a person can read', /bracket|campus|example|slash|character/.test(rej[0].reason||''), rej[0]&&rej[0].reason);
  await Pg.query(`DELETE FROM market_business_rejected WHERE market_key='lanefix-mkt'`);
  await Pg.query(`DELETE FROM market_business_seen WHERE market_key='lanefix-mkt'`);
  console.log('\nfailures: '+F);
  process.exit(F?1:0);
})();
