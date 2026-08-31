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
// THE ADDRESS LADDER: ORDER, STOPPING, AND WHAT EACH STEP IS ALLOWED TO CLAIM.
//
// Five rungs, each weaker than the one above, and the cost of a rung is only
// worth paying if the rungs above it genuinely failed. So the test that matters
// is not "does it find an address" but "did it stop at the first hit, and did it
// refuse to spend on the steps below".
const ROOT = REPO;
const fs = require('fs');

let F = 0;
const ok = (n, c, g) => { if (c) console.log('  PASS ' + n); else { F++; console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

const PE = require(ROOT + 'server/services/personEmailSearch.js');
const CL = require(ROOT + 'server/services/contactLadder.js');
const DR = require(ROOT + 'server/services/domainResolve.js');
const SE = require(ROOT + 'server/services/siteEmail.js');

// ── 1. STEP 3 CANNOT HAND OVER A GUESS ───────────────────────────────────────
// The expensive failure is a constructed address: dave@postofficepies.com is a
// very good guess and a bounced first send is worse than no send.
console.log('\n-- 1. step 3 refuses a constructed address --');
const CITE = ['https://postofficepies.com/about'];
ok('a published address WITH a matching citation is accepted',
  PE._screen({ email: 'dave@postofficepies.com', sourceUrl: 'https://postofficepies.com/about', published: true },
    'found on the about page', CITE).email === 'dave@postofficepies.com');

ok('the SAME address with no citation is refused',
  PE._screen({ email: 'dave@postofficepies.com', sourceUrl: 'https://postofficepies.com/about', published: true },
    'found on the about page', []).email === null);
ok('  and says why', /citation/.test(PE._screen({ email: 'a@b.com', sourceUrl: 'https://b.com/x', published: true }, 't', []).why));

ok('a citation to a DIFFERENT host does not vouch for it',
  PE._screen({ email: 'dave@postofficepies.com', sourceUrl: 'https://postofficepies.com/about', published: true },
    'x', ['https://yelp.com/biz/post-office-pies']).email === null);

for (const hedge of ['this is the likely format', 'I inferred the address from the domain',
  'their standard format is first@domain', 'probably dave@postofficepies.com']) {
  ok(`a hedged answer is refused ("${hedge.slice(0, 24)}...")`,
    PE._screen({ email: 'dave@postofficepies.com', sourceUrl: CITE[0], published: true }, hedge, CITE).email === null);
}
ok('published:false is refused',
  PE._screen({ email: 'a@b.com', sourceUrl: 'https://b.com/x', published: false }, 't', ['https://b.com/x']).email === null);
ok('a non-address is refused', PE._screen({ email: 'not-an-email', sourceUrl: 'https://b.com', published: true }, 't', ['https://b.com']).email === null);

// The prompt must not invite invention.
const pp = PE._prompt('Dave Horn', 'Post Office Pies', 'Birmingham, AL', 'postofficepies.com');
ok('the prompt names the person rather than asking who works there', /Person: Dave Horn/.test(pp));
ok('  and forbids constructing one from the domain', /Do NOT construct/.test(pp));
ok('  and says null is the expected answer', /right answer and is expected/.test(pp));

// ── 2. THE CAP IS A CAP ──────────────────────────────────────────────────────
console.log('\n-- 2. two searches, and it is spent on the attempt --');
(async () => {
  let calls = 0;
  const web = async () => { calls++; return { text: '{"email": null}', citations: [], searches: 1 }; };
  const budget = { left: 2 };
  for (const who of ['A Person', 'B Person', 'C Person', 'D Person']) {
    await PE.findPersonEmail(who, { brand: 'Cap Test Co', webSearch: web, budget, force: true });
  }
  ok('four people, two searches', calls === 2, calls);
  ok('  and the budget is exhausted, not negative', budget.left === 0, budget.left);

  // ── 3. DOMAIN RESOLUTION GOES THROUGH THE SAME GATE ────────────────────────
  console.log('\n-- 3. a searched domain is not trusted for being searched --');
  const web2 = (payload, cites) => async () => ({ text: JSON.stringify(payload), citations: cites || [], searches: 1 });

  const wrong = await DR.resolveDomain('Post Office Pies',
    { webSearch: web2({ website: 'https://davenportspizza.com' }), force: true });
  ok('the search returning a DIFFERENT pizza place is rejected', wrong.website === null, wrong);
  ok('  and the rejection is on the record', wrong.tried.length === 1 && wrong.tried[0].code === 'name-absent', wrong.tried);

  const right = await DR.resolveDomain('Post Office Pies',
    { webSearch: web2({ website: 'https://postofficepies.com' }), force: true });
  ok('the real domain is accepted', right.website === 'https://postofficepies.com', right);
  ok('  naming what matched', right.matchedOn === 'post', right.matchedOn);

  // A citation can rescue a bad stated answer.
  const rescued = await DR.resolveDomain('Onyx Coffee Lab',
    { webSearch: web2({ website: 'https://daysolcoffeelab.co' }, ['https://onyxcoffeelab.com/about']), force: true });
  ok('a citation to the real site rescues a wrong stated answer',
    rescued.website === 'https://onyxcoffeelab.com/about', rescued);

  // A platform page is not a domain.
  const fb = await DR.resolveDomain('Post Office Pies',
    { webSearch: web2({ website: 'https://facebook.com/postofficepies' }), force: true });
  ok('a Facebook page is not accepted as the domain', fb.website === null, fb);

  // A failed search must not be cached as "this business has no website".
  const boom = await DR.resolveDomain('Post Office Pies',
    { webSearch: async () => { throw new Error('429'); }, force: true });
  ok('a failed search returns no domain', boom.website === null);
  ok('  and is reported as a failure, not as an absence', /search failed/.test(boom.reason), boom.reason);

  // ── 4. THE SITE SCRAPE ANSWERS TWO QUESTIONS FROM ONE FETCH ────────────────
  console.log('\n-- 4. one scrape, a person for step 1 and an inbox for step 4 --');
  const HTML = `<html><body>
    <a href="/contact">Contact</a>
    <a href="mailto:dave.horn@postofficepies.com">Dave</a>
    <a href="mailto:info@postofficepies.com">General</a>
  </body></html>`;
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => HTML,
    headers: { get: () => 'text/html' } });
  const se = await SE.findSiteEmail('https://postofficepies.com', { brand: 'Post Office Pies', fetchImpl, force: true });
  ok('the named person is found', se.personalEmail === 'dave.horn@postofficepies.com', se.personalEmail);
  ok('  and the general inbox is kept SEPARATELY, not instead', se.roleEmail === 'info@postofficepies.com', se.roleEmail);
  ok('  the single best address is still the person', se.email === 'dave.horn@postofficepies.com' && se.type === 'personal');

  // ── 5. WHAT EACH STEP MAY CLAIM ────────────────────────────────────────────
  // greetingGuard greets by first name on 'published' and nothing else, so the
  // label decides whether a stranger gets "Hi Dave".
  console.log('\n-- 5. a searched address is not a published one --');
  const mk = (emailSource) => CL.buildContactLadder({
    contacts: [{ name: 'Dave Horn', title: 'Owner', email: 'dave@postofficepies.com',
      emailSource, source: 'site', sourceUrl: 'https://postofficepies.com', confidence: 'high' }],
    website: 'https://postofficepies.com',
  }, { rankOf: () => 0, rootDomain: (u) => String(u).replace(/^https?:\/\//, '').split('/')[0], brand: 'Post Office Pies' });
  const kindOf = (src) => {
    const L = mk(src);
    const r = L.tiers.flatMap((t) => t.rows).find((x) => x.name === 'Dave Horn');
    return r && r.emailKind;
  };
  ok('published stays published', kindOf('published') === 'published', kindOf('published'));
  ok('hunter stays hunter', kindOf('hunter') === 'hunter', kindOf('hunter'));
  ok('SEARCHED is not announced as published', kindOf('searched') === 'searched', kindOf('searched'));
  ok('BIO is not announced as published either', kindOf('bio') === 'bio', kindOf('bio'));
  ok('an unrecognised source fails closed', kindOf('something-new') === 'unverified', kindOf('something-new'));

  // ── 6. THE WIRING, IN ORDER ────────────────────────────────────────────────
  console.log('\n-- 6. the order, and what each step is allowed to spend --');
  const AI = fs.readFileSync(ROOT + 'server/ai.js', 'utf8');
  const gb = AI.slice(AI.indexOf('async function getBrandContacts'));
  const body = gb.slice(0, gb.indexOf('\n}\n'));
  const at = (s) => body.indexOf(s);
  ok('domain resolution runs only on a total miss', /if \(!effectiveWebsite && \(_deep \|\| localityRequired\)\)/.test(body));
  ok('  and before the site scrape', at('resolveDomain') < at('findSiteEmail'));
  ok('the site scrape no longer needs a market to run',
    /\(_deep \|\| localityRequired\) && effectiveWebsite/.test(body));
  ok('  and runs BEFORE Hunter', at('findSiteEmail') < at('_hunterEligible'));
  ok('Hunter re-checks the domain at the point of spend', at('_hunterDomainOk') < at('_hunterEligible'));
  ok('  and will not run without a confirmed one', /_hunterEligible = \(_deep \|\| localityRequired\) && _hunterDomainOk/.test(body));
  ok('  nor when a step above already produced an address', /_addr\.step === null && !_seFoundEmail/.test(body));
  ok('step 3 runs only when 1 and 2 both failed', /if \(_deep && _addr\.step === null\) \{/.test(body));
  ok('  and after Hunter', at('findPersonEmail') > at('_hunterEligible'));
  ok('  capped, from one constant', /_PERSON_SEARCH_CAP = parseInt\(process\.env\.PERSON_EMAIL_SEARCH_CAP/.test(body));
  ok('step 4 is the general inbox, below the search', at("_addr.step = 4") > at('findPersonEmail'));
  ok('step 5 is the form, last', at("_addr.step = 5") > at("_addr.step = 4"));
  ok('a searched address is tagged, not passed off as published',
    /emailSource = 'searched'/.test(body) || /emailSource: 'searched'/.test(body));
  ok('the ladder and its cost are reported', /\[address-ladder\]/.test(body) && /res\.addressLadder = _addr/.test(body));
  ok('and returned to the caller', /addressLadder: res\.addressLadder/.test(AI));

  console.log('\nfailures: ' + F);
  process.exit(F ? 1 : 0);
})();
