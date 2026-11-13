'use strict';
//   node tests/planceiling.js
//
// ── THE HUNTER CEILINGS FOLLOW THE PLAN
// Nov 13: the plan went to Growth while HUNTER_MONTHLY_BUDGET still said
// 1,800. Each read of Hunter's account now sets the ceilings from the plan's
// real size (90% of it), the larger of that and the environment value wins,
// and a failed read never shrinks anything.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
delete process.env.HUNTER_MONTHLY_BUDGET;
delete process.env.HUNTER_MONTHLY_VERIFY_BUDGET;
delete process.env.HOME_VERIFY_MONTHLY_CAP;
delete process.env.HUNTER_RESERVE_PCT;
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

async function main() {
  const HL = require(REPO + 'server/services/hunterLookup.js');
  const HP = require(REPO + 'server/services/hunterPace.js');
  const VB = require(REPO + 'server/services/verifyBudget.js');
  const envSearch = HL.searchBudget(), envVerify = HL.verifyBudget();
  ok('before any read: the environment values', envSearch > 0 && envVerify > 0 && VB.liveCap() === envVerify, { envSearch, envVerify });

  const growth = HP.parseAccount({ data: { plan_name: 'Growth', reset_date: '2026-12-13', requests: { credits: { used: 40, available: 10000 } } } });
  const c = HL.ceilingsFromAccount(growth);
  ok('Growth, 10,000 credits: 9,000 searches (1 credit), 18,000 checks (half a credit)', c && c.search === 9000 && c.verify === 18000, c);
  HL.setAccountCeilings(growth);
  ok('the search ceiling is the plan now', HL.searchBudget() === 9000, HL.searchBudget());
  ok('the verification ceiling too', HL.verifyBudget() === 18000, HL.verifyBudget());
  ok('  and the send gate\'s verification pool follows it', VB.liveCap() === 18000, VB.liveCap());

  HL.setAccountCeilings({ ok: false, error: 'Hunter did not answer in 10s' });
  ok('a failed read changes nothing', HL.searchBudget() === 9000 && HL.verifyBudget() === 18000);
  const tiny = HP.parseAccount({ data: { plan_name: 'Free', requests: { credits: { used: 0, available: 50 } } } });
  HL.setAccountCeilings(tiny);
  ok('a smaller plan never goes below the environment value', HL.searchBudget() === envSearch && HL.verifyBudget() === envVerify,
    { s: HL.searchBudget(), v: HL.verifyBudget() });
  const split = HL.ceilingsFromAccount(HP.parseAccount({ data: { requests: { searches: { used: 0, available: 5000 }, verifications: { used: 0, available: 10000 } } } }));
  ok('an older plan with two pools: 90% of each', split && split.search === 4500 && split.verify === 9000, split);

  const src = require('fs').readFileSync(REPO + 'server/services/hunterPace.js', 'utf8');
  ok('every account read sets the ceilings', /setAccountCeilings\(acct\)/.test(src));
  const idx = require('fs').readFileSync(REPO + 'server/index.js', 'utf8');
  ok('the admin page says where the cap came from', /budgetFrom/.test(idx));

  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
