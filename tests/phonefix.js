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
// A PHONE THAT PASSED AT WRITE TIME MUST SURVIVE THE READ, and a person's direct
// line must be judged on the same evidence the business line is.
process.env.ANTHROPIC_API_KEY='test-not-used';
const ai = require(REPO + 'server/ai.js');
const store = require(REPO + 'server/store.js');

let F = 0;
const ok = (n,c,g) => { if (c) console.log('  PASS '+n); else { F++; console.log('  FAIL '+n+(g!==undefined?'  got='+JSON.stringify(g):'')); } };

let BIZ = null, PERSON = null, STATE = 'AL';
ai._test._setContactSearchImpl(async (p,s,mt,mu,model,source) => {
  if (source !== 'site') return { text: '{"contacts": []}', citations: [], searches: 1 };
  const payload = { contacts: [{ name:'Dana Reed', title:'Owner', email:'d@x.example',
      phone: PERSON, sourceUrl:'https://x.example' }],
    businessPhone: BIZ, state: STATE };
  return { text: JSON.stringify(payload), citations: ['https://x.example'], searches: 1, outTokens: 10 };
});

const run = async (brand) => ai.getBrandContacts(brand, null, 'Birmingham, AL', ai.deepContactCtx({market:null}));

(async () => {
  await new Promise(r => setTimeout(r, 2000));
  const P = store.pool;
  const wipe = () => P.query(`DELETE FROM brand_evidence_cache WHERE brand_key ILIKE $1`, ['%phonefix%']);

  console.log('\n-- 1. the business line survives a re-read --');
  for (const [label, phone] of [['local 205','(205) 555-0134'], ['toll-free 800','(800) 555-0134'],
                                ['toll-free 877','(877) 555-0134']]) {
    await wipe();
    BIZ = phone; PERSON = null;
    const brand = 'PhoneFix Biz ' + label.replace(/\W+/g,'');
    const live = await run(brand);
    const cached = await run(brand);
    ok(`${label}: live=${live.businessPhone?'yes':'NO'} cached=${cached.businessPhone?'yes':'NO'}`,
      !!live.businessPhone && live.businessPhone === cached.businessPhone,
      { live: live.businessPhone, cached: cached.businessPhone });
  }

  console.log('\n-- 2. a WRONG-state number is still refused, at write time --');
  await wipe();
  BIZ = '(307) 555-0134'; PERSON = null; STATE = 'WY';       // Wyoming, market is AL
  const wrong = await run('PhoneFix Biz wrongstate');
  ok('a Wyoming number on an Alabama card is refused', !wrong.businessPhone, wrong.businessPhone);
  const wrongCached = await run('PhoneFix Biz wrongstate');
  ok('  and stays refused on the re-read', !wrongCached.businessPhone, wrongCached.businessPhone);
  STATE = 'AL';

  console.log("\n-- 3. a person's direct line, judged on the reported state --");
  for (const [label, phone, want] of [
    ['local 205',     '(205) 555-0199', true],
    ['toll-free 800', '(800) 555-0199', true],   // was dropped LIVE before the fix
    ['out-of-state',  '(307) 555-0199', false],  // must still be refused
  ]) {
    await wipe();
    BIZ = '(205) 555-0134'; PERSON = phone;
    const live = await run('PhoneFix Person ' + label.replace(/\W+/g,''));
    const dana = (live.contacts||[]).find(c=>c.name==='Dana Reed');
    // A named contact with no direct line is HANDED the business line further
    // down ("ask for Dana"), so presence of a number is not the test -- whether
    // it is HER number is. Compare against the main line.
    const got = !!(dana && dana.phone && dana.phone !== live.businessPhone);
    ok(`${label}: direct line kept=${got} (want ${want})`, got === want, dana && dana.phone);
  }

  console.log('\n-- 4. no reported state -> unchanged from before --');
  await wipe();
  STATE = null; BIZ = '(205) 555-0134'; PERSON = '(800) 555-0199';
  const nostate = await run('PhoneFix Person nostate');
  const d2 = (nostate.contacts||[]).find(c=>c.name==='Dana Reed');
  ok('with no state reported, a toll-free direct line is still refused on area code alone',
    !(d2 && d2.phone && d2.phone !== nostate.businessPhone), d2 && d2.phone);
  STATE = 'AL';

  await wipe();
  console.log('\nfailures: ' + F);
  process.exit(F ? 1 : 0);
})();
