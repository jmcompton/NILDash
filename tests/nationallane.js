'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/nationallane.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE NATIONAL LANE: BRANDS THAT BUY ENDORSEMENTS, TIERED TO THE ATHLETE ──
// deal_comps (nilCompJob) extracted "collective name or brand name" from NIL
// news and getTopNilComps served the same list to everyone: collectives,
// athletic programs, On3. The job now keeps only a company that paid for an
// endorsement, and the list is ranked by how close each brand's deals are to
// this athlete's reach and sport.
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const J = require(REPO + 'server/nilCompJob.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };

async function main() {
  OUT.push('-- the job keeps companies that bought an endorsement --');
  ok('a brand deal is kept', J.acceptDeal({ brand: 'Raising Canes', athlete_name: 'A', payer_type: 'brand' }) === null);
  const refused = [{ brand: 'Yea Alabama', payer_type: 'collective' }, { brand: 'On3 NIL Valuation' }, { brand: 'Texas A&M Aggies' },
    { brand: 'College Football 2026 Cover Star' }, { brand: 'Penn State Collective' }, { brand: 'Opendorse', payer_type: 'platform' }, { brand: null }]
    .filter((d) => J.acceptDeal({ athlete_name: 'A', ...d }) === null);
  ok('collectives, programs, valuation sites, events and platforms are refused', refused.length === 0, refused);
  const src = fs.readFileSync(REPO + 'server/nilCompJob.js', 'utf8');
  ok('the extraction asks for the COMPANY that paid, and names what is not one', /the COMPANY that paid the athlete for an endorsement/.test(src)
    && /NEVER an NIL collective/.test(src) && !/collective name or brand name/.test(src));
  ok('  the searches look for brand endorsements, not collective payments or valuations', !J.SEARCH_QUERIES.some((q) => /collective|valuation|On3/i.test(q)));
  ok('  and the save runs acceptDeal before anything is written', /const why = acceptDeal\(deal\);/.test(src));

  OUT.push('', '-- getTopNilComps is tiered to the athlete --');
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await P.query(`DELETE FROM deal_comps WHERE source = 'nl-test'`);
  const deal = (brand, followers, sport, daysAgo) => P.query(
    `INSERT INTO deal_comps (sport, brand, followers, deal_value, athlete_name, source, created_at) VALUES ($1,$2,$3,5000,'A','nl-test', NOW() - ($4 || ' days')::interval)`,
    [sport, brand, followers, String(daysAgo)]);
  // Big Brand: only deals with 2M-follower stars, most recent. Mid Brand: deals
  // with 20-40k athletes in football. Hoop Brand: 30k basketball. Collective: newest of all.
  await deal('NL Big Brand', 2000000, 'football', 1); await deal('NL Big Brand', 3000000, 'football', 1);
  await deal('NL Mid Brand', 20000, 'football', 20); await deal('NL Mid Brand', 40000, 'football', 25);
  await deal('NL Hoop Brand', 30000, 'basketball', 30);
  await deal('NL Fund Collective', 30000, 'football', 0);
  await deal('NL Oregon Ducks', 30000, 'football', 0);
  const mine = (list) => list.map((b) => b.brand).filter((b) => /^NL /.test(b));
  const forMid = mine(await store.getTopNilComps(20, 2, { instagram: 25000, sport: 'Football' }));
  ok('a 25k-follower football player gets the brand that buys athletes like them first', forMid[0] === 'NL Mid Brand', forMid);
  ok('  and the star-only brand sinks below the ones in their range', forMid.indexOf('NL Big Brand') > forMid.indexOf('NL Hoop Brand'), forMid);
  ok('  no collective and no team, however recent', !forMid.includes('NL Fund Collective') && !forMid.includes('NL Oregon Ducks'), forMid);
  const forStar = mine(await store.getTopNilComps(20, 2, { instagram: 2500000, sport: 'Football' }));
  ok('a 2.5M-follower star gets the star brand first', forStar[0] === 'NL Big Brand', forStar);
  const forHoop = mine(await store.getTopNilComps(20, 2, { instagram: 25000, sport: 'Basketball' }));
  ok('a basketball player of the same reach gets the basketball brand ahead of the football one', forHoop.indexOf('NL Hoop Brand') < forHoop.indexOf('NL Mid Brand'), forHoop);
  const top = (await store.getTopNilComps(20, 2, { instagram: 25000, sport: 'Football' })).find((b) => b.brand === 'NL Mid Brand');
  ok('  the reason travels with the brand', top && /2 deals with an athlete of similar reach/.test(top.why || '') && /in Football/.test(top.why || ''), top);
  const noAth = mine(await store.getTopNilComps(20, 2));
  ok('with no athlete it still serves the lane (most recent first), never a collective', noAth.length === 3 && noAth[0] === 'NL Big Brand', noAth);
  ok('the Scout passes the athlete to it', /nationalCandidates\(pool, \{ limit, store, athlete \}\)/.test(fs.readFileSync(REPO + 'server/services/scout.js', 'utf8')));
  await P.query(`DELETE FROM deal_comps WHERE source = 'nl-test'`);
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
