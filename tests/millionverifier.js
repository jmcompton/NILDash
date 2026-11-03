'use strict';
// ── MAILBOX CHECKS GO TO MILLIONVERIFIER FIRST (MILLIONVERIFIER_API_KEY) ────
// Local test Postgres; both vendors are stand-ins answering a fake fetch.
//
//   - no key: nothing changes, Hunter answers every check;
//   - with the key: MillionVerifier answers, in Hunter's shape, and Hunter is
//     never called, so no Hunter credit is spent on checking;
//   - ok / catch_all / unknown / invalid / disposable map to what the cards
//     already understand (catch-all and unknown stay "unknown", never bad);
//   - a failed MillionVerifier call (out of credits, HTTP error, timeout, an
//     "error" result) is not a verdict: Hunter is asked instead.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('millionverifiertest', { schema: true });
require('./helpers/offlineDns').install();
process.env.HUNTER_API_KEY = 'hunter-test-key';
delete process.env.MILLIONVERIFIER_API_KEY;
delete process.env.HUNTER_PACE_ON;

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const H = require(REPO + 'server/services/hunterLookup.js');
const V = require(REPO + 'server/services/emailVerify.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 500) : '')); } };

let calls = [];
let mvAnswer = { status: 200, body: { result: 'ok', credits: 9999 } };
const fakeFetch = async (url) => {
  const u = String(url);
  if (u.startsWith(H.MV_URL)) {
    calls.push('mv');
    if (mvAnswer.throws) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return { ok: mvAnswer.status === 200, status: mvAnswer.status, json: async () => mvAnswer.body, headers: { get: () => null } };
  }
  calls.push('hunter');
  return { ok: true, status: 200, json: async () => ({ data: { status: 'valid', result: 'deliverable', score: 95 } }), headers: { get: () => null } };
};
const check = (email) => H.verifyEmail(email, { fetchImpl: fakeFetch });

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));

  OUT.push('-- no key: as before --');
  calls = [];
  let v = await check('owner@shop.test');
  ok('without the key, Hunter answers and MillionVerifier is never called', v.ok && v.status === 'valid' && calls.join() === 'hunter' && !v.provider, { v, calls });

  OUT.push('-- with the key --');
  process.env.MILLIONVERIFIER_API_KEY = 'mv-test-key';
  calls = [];
  v = await check('owner@shop.test');
  ok('MillionVerifier answers and Hunter is not called (no Hunter credit spent)', v.ok && v.status === 'valid' && v.provider === 'millionverifier' && calls.join() === 'mv', { v, calls });
  ok('  its answer comes back in Hunter\'s shape', v.result === 'deliverable' && v.acceptAll === false && v.credits === 9999);
  const map = async (result) => { mvAnswer = { status: 200, body: { result } }; calls = []; return check('x@shop.test'); };
  v = await map('catch_all');
  ok('catch_all reads as accept_all, and the card treats it as unknown, never bad', v.status === 'accept_all' && v.acceptAll && V.mapHunter(v.status, v.result).result === 'unknown', v);
  v = await map('unknown');
  ok('unknown stays unknown', v.status === 'unknown' && V.mapHunter(v.status, v.result).result === 'unknown');
  v = await map('invalid');
  ok('invalid holds the card back', v.status === 'invalid' && V.mapHunter(v.status, v.result).result === 'invalid');
  v = await map('disposable');
  ok('disposable holds the card back', V.mapHunter(v.status, v.result).result === 'invalid');
  v = await map('ok');
  ok('ok is a confirmed mailbox', V.mapHunter(v.status, v.result).result === 'valid');

  OUT.push('-- when MillionVerifier fails, Hunter answers --');
  mvAnswer = { status: 200, body: { error: 'Insufficient credits' } };
  calls = []; v = await check('a@shop.test');
  ok('out of credits: Hunter is asked instead', v.ok && v.status === 'valid' && calls.join() === 'mv,hunter' && !v.provider, { v, calls });
  mvAnswer = { status: 500, body: null };
  calls = []; v = await check('b@shop.test');
  ok('an HTTP error: Hunter is asked instead', v.ok && calls.join() === 'mv,hunter', calls);
  mvAnswer = { status: 200, body: { result: 'error' } };
  calls = []; v = await check('c@shop.test');
  ok('an "error" result is not a verdict: Hunter is asked instead', v.ok && calls.join() === 'mv,hunter', calls);
  mvAnswer = { throws: true };
  calls = []; v = await check('d@shop.test');
  ok('a timeout: Hunter is asked instead', v.ok && calls.join() === 'mv,hunter', calls);
  const r = await H.verifyWithMillion('e@shop.test', { fetchImpl: fakeFetch });
  ok('  and the timeout says so in plain words', r && r.ok === false && /timed out/.test(r.why), r);
  ok('hunterOnly skips MillionVerifier', (calls = [], await H.verifyEmail('f@shop.test', { fetchImpl: fakeFetch, hunterOnly: true }), calls.join() === 'hunter'));

  OUT.push('-- wiring --');
  const EV = fs.readFileSync(REPO + 'server/services/emailVerify.js', 'utf8');
  ok('the stored verdict records which vendor answered', /provider: v\.provider \|\| 'hunter'/.test(EV));
  const HL = fs.readFileSync(REPO + 'server/services/hunterLookup.js', 'utf8');
  ok('MillionVerifier is asked before Hunter\'s budget and tonight\'s allowance are touched',
    HL.indexOf('if (MV_ON() && !opts.hunterOnly)') > 0 && HL.indexOf('if (MV_ON() && !opts.hunterOnly)') < HL.indexOf("HP.take('verify')"));

  OUT.push('-- the nightly finder and the send gate: MillionVerifier is outside Hunter\'s limits --');
  {
    process.env.MILLIONVERIFIER_API_KEY = 'mv-test-key';
    const HP = require(REPO + 'server/services/hunterPace.js');
    const VBm = require(REPO + 'server/services/verifyBudget.js');
    const EF = require(REPO + 'server/services/emailFinder.js');
    const SG = require(REPO + 'server/services/sendGate.js');
    const realBlocked = HP.blocked, realAcct = VBm.accountStatus;
    HP.blocked = () => "tonight's Hunter allowance is spent (50 credits)";
    VBm.accountStatus = async () => ({ remaining: 0 });
    const logCount = async () => (await store.pool.query(`SELECT COUNT(*)::int n FROM email_verify_credit_log`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
    const before = await logCount();
    mvAnswer = { status: 200, body: { result: 'ok', credits: 9000 } };
    calls = [];
    const deps = EF.liveDeps(store.pool, { agentId: 'a1', athleteId: 'x1', business: 'Shop', fetchImpl: fakeFetch });
    const got = await deps.verify('owner@pacedshop.com');
    ok('Hunter spent for the night: MillionVerifier still checks the address', got && got.result === 'valid' && calls.join() === 'mv', { got, calls });
    ok('and no Hunter credit is logged for it', (await logCount()) === before);
    calls = [];
    const sg = await SG.liveVerifier(store.pool, { agentId: 'a1', fetchImpl: fakeFetch })('owner@gate.test');
    ok('Hunter\'s month spent: an approved email is checked by MillionVerifier, not held', sg && sg.ok && sg.status === 'valid' && calls.join() === 'mv', { sg, calls });
    mvAnswer = { status: 402, body: { error: 'insufficient credits' } };
    calls = [];
    const held = await SG.liveVerifier(store.pool, { agentId: 'a1', fetchImpl: fakeFetch })('owner@gate2.test');
    ok('MillionVerifier out too: the Hunter limit still applies, nothing sent unchecked', held && held.ok === false && /used up/.test(held.why) && !calls.includes('hunter'), { held, calls });
    const g2 = await EF.liveDeps(store.pool, { fetchImpl: fakeFetch }).verify('owner@pacedshop2.com');
    ok('same in the finder: Hunter paced, no Hunter call', !calls.includes('hunter') && (!g2 || g2.result !== 'valid'));
    HP.blocked = realBlocked; VBm.accountStatus = realAcct;
    delete process.env.MILLIONVERIFIER_API_KEY;
    mvAnswer = { status: 200, body: { result: 'ok', credits: 9999 } };
  }

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
