'use strict';
// ── THE PROTECT COLLEGE SPORTS ACT RULE SET (services/pcsa) ────────────────
// Local test Postgres for the agent profile; every rule is a pure lookup.
//
//   - the 5% fee cap, contracts in writing and inside eligibility;
//   - the 5-year clock and the one free transfer, with the exceptions;
//   - the $600 / 5-day / 30-day report;
//   - a business purpose for every deal, normal pay from collectives, boosters
//     over $50,000, conferences and school staff;
//   - registered + certified = PCSA-ready; the profile is kept;
//   - pending until it is law: the source line says so;
//   - the routes, the page and the NIL Go filing are wired.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('pcsatest', { schema: true });
require('./helpers/offlineDns').install();
delete process.env.PCSA_STATUS;

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const S = require(REPO + 'server/services/pcsa.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 500) : '')); } };
const NOW = new Date('2026-11-02T18:00:00Z');

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));

  OUT.push('-- the agent fee --');
  ok('5% of a $20,000 deal is fine', S.agentFee({ dealValue: 20000, feePct: 5 }).level === 'ok');
  const over = S.agentFee({ dealValue: 20000, feePct: 10 });
  ok('10% is over the cap, and it says the most he can charge', over.level === 'flag' && /\$1,000/.test(over.text), over.text);
  ok('a dollar fee works too', S.agentFee({ dealValue: 10000, feeAmount: 800 }).level === 'flag');
  ok('a fraction reads as a fraction', S.agentFee({ dealValue: 10000, feePct: 0.04 }).level === 'ok');
  ok('no fee on file: unknown, with the most allowed', S.agentFee({ dealValue: 30000 }).level === 'unknown' && S.agentFee({ dealValue: 30000 }).maxFee === 1500);
  ok('no value: unknown, never fine', S.agentFee({}).level === 'unknown');

  OUT.push('-- eligibility and transfers --');
  let e = S.eligibility({ birthDate: '2004-03-10', firstEnrollment: '2022-08-20', transfers: [{}], now: NOW });
  ok('the clock starts with the earlier of the year after he turned 19 and his first enrollment', e.clockStart === '2022-23' && e.lastYear === '2026-27', e);
  ok('years left counts this season', e.yearsLeft === 1, e.yearsLeft);
  ok('one transfer used: warned the next one costs a year', e.findings.some((f) => f.rule === 'transfer' && f.level === 'warn'));
  e = S.eligibility({ birthDate: '2005-01-05', firstEnrollment: '2023-08-20', transfers: [{}, {}], now: NOW });
  ok('a second transfer with no exception loses a year', e.lostYear === true && e.yearsLeft === 1 && e.findings.some((f) => f.rule === 'transfer' && f.level === 'flag'), e);
  e = S.eligibility({ birthDate: '2005-01-05', firstEnrollment: '2023-08-20', transfers: [{}, { exception: 'head_coach_departed' }], now: NOW });
  ok('a second transfer after the head coach left loses nothing', !e.lostYear && e.yearsLeft === 2 && /head coach left/.test(e.findings.find((f) => f.rule === 'transfer').text), e);
  ok('no dates: unknown, never assumed', S.eligibility({ transfers: [], now: NOW }).findings[0].level === 'unknown');
  ok('first transfer: nothing lost', S.eligibility({ birthDate: '2005-01-05', now: NOW }).findings.some((f) => f.rule === 'transfer' && f.level === 'ok'));

  OUT.push('-- the contract --');
  ok('ends after eligibility: flagged', S.contractTerm({ endDate: '2029-06-30', eligibilityEnds: '2027-07-31' })[0].level === 'flag');
  ok('ends inside eligibility: fine', S.contractTerm({ endDate: '2027-05-31', eligibilityEnds: '2027-07-31' })[0].level === 'ok');
  ok('not in writing: flagged', S.contractTerm({ inWriting: false, endDate: '2027-01-01', eligibilityEnds: '2027-07-31' })[0].rule === 'agencyContract');
  ok('no end date: unknown', S.contractTerm({})[0].level === 'unknown');

  OUT.push('-- the report --');
  let d = S.disclosure({ value: 500, now: NOW });
  ok('$500 alone: no report yet', d.required === false);
  d = S.disclosure({ value: 500, priorTwelveMonths: 200, now: NOW });
  ok('$500 on top of $200 this year: over $600, report it', d.required === true);
  d = S.disclosure({ value: 2000, signedAt: '2026-11-01', now: NOW });
  ok('signed Nov 1: due Nov 6, 4 days left', d.dueBy === '2026-11-06' && d.daysLeft === 4 && d.level === 'ok', d);
  d = S.disclosure({ value: 2000, signedAt: '2026-10-20', paidAt: '2026-10-25', now: NOW });
  ok('signed Oct 20: the earlier deadline wins, and it is late', d.dueBy === '2026-10-25' && d.level === 'flag' && /late/.test(d.text), d);
  ok('not Division I: the bill\'s rule does not apply', S.disclosure({ value: 5000, division: 'II' }).required === false);

  OUT.push('-- the business purpose --');
  let p = S.nilPurpose({ payerType: 'collective', value: 150000, comparableHigh: 27785 });
  ok('a collective paying for nothing named, far above comparable players: both flagged', p.length === 2 && p.every((f) => f.level === 'flag'), p.map((f) => f.text));
  p = S.nilPurpose({ payerType: 'business', deliverables: '3 posts; 1 appearance', value: 5000 });
  ok('a business with work named: fine, and no pay test for an ordinary business', p.length === 1 && p[0].level === 'ok');
  p = S.nilPurpose({ payerType: 'business', deliverables: ['1 post'], value: 90000, comparableHigh: 30000, boosterLifetime: 75000 });
  ok('a business owner who gave over $50,000 is a booster: the pay test applies', p.some((f) => f.rule === 'commensurate' && f.level === 'flag'));
  ok('a deal with the school is rev-share: not tested', S.nilPurpose({ payerType: 'school' })[0].level === 'ok');
  ok('a collective with no comparable on file: checked, not passed', S.nilPurpose({ payerType: 'collective', deliverables: ['2 posts'], value: 9000 }).some((f) => f.level === 'warn'));

  OUT.push('-- the agent --');
  ok('registered and certified: PCSA-ready', S.agentProfile({ registeredState: 'al', associationCertified: true }).ready === true);
  ok('registered, not certified: says what is missing', /certify that registration to the NCAA/.test(S.agentProfile({ registeredState: 'AL' }).text));
  ok('an NFLPA certification counts as registration', S.agentProfile({ proAssociation: 'NFLPA', associationCertified: true }).ready === true);
  await S.ensureTable(store.pool);
  let prof = await S.saveProfile(store.pool, 'u-1', { registeredState: 'tx', registrationNumber: 'A-123', associationCertified: true });
  ok('the profile is kept and checked', prof.registeredState === 'TX' && prof.check.ready === true);
  prof = await S.getProfile(store.pool, 'u-2');
  ok('no profile yet: not ready', prof.check.ready === false);
  const bad = await S.saveProfile(store.pool, 'u-1', { registeredState: 'Texas' }).then(() => null, (x) => x);
  ok('a state that is not a two-letter code is refused', bad && bad.status === 400);

  OUT.push('-- one deal --');
  const r = S.checkDeal({ value: 150000, feePct: 8, payerType: 'collective', endDate: '2030-01-01', signedAt: '2026-10-20' },
    { birthDate: '2005-01-05', firstEnrollment: '2023-08-20', transfers: [{}, {}] }, { now: NOW });
  ok('every rule runs: fee, contract, report, purpose, pay', ['agentFee', 'contractTerm', 'disclosure', 'nilPurpose', 'commensurate'].every((k) => r.findings.some((f) => f.rule === k)), r.findings.map((f) => f.rule));
  ok('the eligibility comes along, with the lost year', r.eligibility.lostYear === true);
  ok('pending: the summary and the source say so', r.status === 'pending' && /if the bill becomes law/.test(r.summary) && /pending in the House/.test(r.findings[0].source));
  process.env.PCSA_STATUS = 'law';
  ok('once it is law, the source drops the pending line', !/pending/.test(S.checkDeal({ value: 1000 }, {}).source));
  delete process.env.PCSA_STATUS;

  OUT.push('-- wiring --');
  const IX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('the page and the rules are public', IX.includes("app.get('/compliance'") && IX.includes("app.get('/api/pcsa/rules'"));
  ok('the profile and the check need a signed-in user', ["app.get('/api/pcsa/profile', requireAuth", "app.put('/api/pcsa/profile', requireAuth", "app.post('/api/pcsa/check', requireAuth"].every((x) => IX.includes(x)));
  const filing = require(REPO + 'server/services/compliance.js').prepareDisclosureFiling({ value: '$2,000', brand: 'Grill', closedAt: '2026-11-01' }, { name: 'J', school: 'X' });
  ok('the NIL Go filing carries the PCSA deadline', filing.required && filing.pcsaDeadline && filing.pcsaDeadline.required === true && !!filing.pcsaDeadline.dueBy, filing.pcsaDeadline);
  const PAGE = fs.readFileSync(REPO + 'server/views/pcsa.html', 'utf8');
  ok('the page escapes what it shows and says it is not legal advice', /const esc = /.test(PAGE) && /not legal advice/.test(PAGE));

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
