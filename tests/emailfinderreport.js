'use strict';
// No database needed.
//
//   node tests/emailfinderreport.js
//
// ── WHY A DM OR CALL CARD DID NOT GET AN EMAIL ──────────────────────────────
// services/emailFinderReport.classify reads the night's record for a card and
// names the first reason that explains it. Each reason is reachable from a
// record the overnight fill really writes.
const path = require('path');
const REPO = path.join(__dirname, '..') + path.sep;
const R = require(REPO + 'server/services/emailFinderReport.js');

let F = 0, N = 0;
const ok = (c, m) => { N++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) F++; };
const card = { channel: 'dm', lane: 'local', email_note: null, email_tier: null };
const steps = (s1, s2, s3) => [`1:website, named person=${s1}`, `2:Hunter=${s2}`, `3:web search=${s3 || 'skipped'}`];
const tried = (why, extra) => ({ brand: 'Joe\'s Pizza', result: 'queued', why: { website: 'https://www.joespizza.com', ladderEmails: [], refusedKinds: [], addressSteps: steps('miss (fetched-empty)', 'miss (no surname match and no pattern)'), ...why }, ...(extra || {}) });
const hunterNone = new Map([['joespizza.com', { outcome: 'NONE', evidence: { found: false, emails: [] } }]]);

ok(R.parseStep('1:website, named person=miss (fetched-empty)').detail === 'fetched-empty', 'parses a ladder step');
ok(R.rootOf('shop.joespizza.co.uk') === 'joespizza.co.uk' && R.hostOf('https://www.Joe.com/x') === 'joe.com', 'host and root domain');

const is = (got, want, m) => ok(got.reason === want, `${m}: ${got.reason}`);
is(R.classify(card, null), 'never tried', 'no record of the business');
is(R.classify({ ...card, lane: 'program' }, null), 'never tried', 'a program card');
is(R.classify(card, tried({ addressSteps: [] })), 'never tried', 'ladder did not run');
is(R.classify(card, tried({ addressSteps: steps('miss (fetched-empty)', 'miss (Hunter failed (TIMEOUT: 10s))') })), 'timed out', 'Hunter timed out');
is(R.classify(card, tried({}), { hunterTimeouts: new Set(['joespizza.com']) }), 'timed out', 'Hunter timeout fault for the domain');
is(R.classify(card, tried({ website: null, addressSteps: steps('miss (no confirmed website)', 'skipped (no confirmed domain, so Hunter was not called)') })), 'no website or domain found', 'no website');
is(R.classify(card, tried({ websiteDropped: { code: 'parked', reason: 'parked domain' } })), 'no website or domain found', 'website dropped');
is(R.classify(card, tried({}, { emailCheck: { undeliverable: [{ email: 'joe@joespizza.com', reason: 'no MX' }] } })), 'email found but verification said invalid', 'undeliverable');
is(R.classify({ ...card, email_tier: 4 }, tried({})), 'rejected as a role address', 'Tier 4 only');
is(R.classify(card, tried({}), { site: new Map([['joespizza.com', { rejected: [{ raw: 'careers@joespizza.com', reason: 'careers@ is never a NIL contact' }] }]]) }), 'rejected as a role address', 'role address on the site');
is(R.classify(card, tried({}), { site: new Map([['joespizza.com', { rejected: [{ raw: 'joe@gmail.com', reason: 'domain does not match the website' }] }]]) }), 'rejected as domain mismatch', 'domain mismatch');
is(R.classify(card, tried({ ladderEmails: [{ tier: 2, kind: 'published' }] })), "an address was found, but not the named person's", 'address not the greeted person\'s');
is(R.classify(card, tried({ refusedKinds: ['searched'] })), 'found by web search (a kind never sent to)', 'searched address');
is(R.classify(card, tried({ addressSteps: steps('miss (fetched-empty)', 'miss (no surname match, and nobody named to build an address for)') })), 'owner name missing so no pattern guess', 'nobody named');
is(R.classify(card, tried({})), 'Hunter monthly budget hit (inferred)', 'Hunter due, nothing recorded');
is(R.classify({ ...card, thisMonth: true }, tried({}), { underBudgetThisMonth: true }), 'Hunter not asked, with no record why', 'this month, under the cap: not the budget');
is(R.classify({ ...card, thisMonth: false }, tried({}), { underBudgetThisMonth: true }), 'Hunter monthly budget hit (inferred)', 'last month: may have been the budget');
is(R.classify(card, tried({}), { hunter: hunterNone }), 'Hunter domain search empty', 'Hunter NONE');
is(R.classify(card, tried({ addressSteps: steps('miss (fetched-empty)', 'skipped (no Hunter key)') })), 'site scrape found nothing', 'site empty, Hunter not the miss');
ok(R.classify(card, tried({})).site === 'fetched-empty', 'carries the site outcome');

// Every reason the report counts is one classify can give, and the two that
// cannot happen at night are printed with why, never as a measured zero.
const text = R.format({ days: 7, cards: 3, mix: { dm: 2, email: 1 }, rows: [{ ...card, brand_name: 'Joe', night: '2026-10-13', agent_name: 'A', ...R.classify(card, null) }], budget: { used: 10, ladderUsed: 8, verifyUsed: 2, budget: 1800, remaining: 1790 } },
  { plan: 'Starter', resetDate: '2026-11-01', searches: { used: 400, available: 500 } });
ok(R.REASONS.every((k) => text.includes(k)), 'every reason is printed');
ok(/per-athlete daily verify budget hit: cannot cause/.test(text), 'the impossible reason says why');

// After the email finder: its record on the card says why.
const fin = (finder, verify) => tried({ finder: { before: 'dm', after: 'dm', verify: verify || null, finder } });
is(R.classify(card, fin({ stop: 'catch-all domain, and no confirmed pattern built a passing address' })), 'verification said unknown / catch-all', 'finder: catch-all domain');
is(R.classify(card, fin({ stop: 'verification could not run' })), 'verification could not run', 'finder: verification could not run');
is(R.classify(card, fin({ stop: 'no format verified', steps: ['common format ({first}.{last}): tom.smith@x.com invalid'] })), 'every likely address tried, none verified', 'finder: every format invalid');
is(R.classify(card, fin({ stop: "Domino's is a chain location and dominos.com is the chain's corporate domain" })), "a chain's corporate domain", 'finder: corporate domain');
is(R.classify(card, fin({ stop: 'no website found' })), 'no website or domain found', 'finder: no website found');
is(R.classify(card, fin(null, { email: 'tom@x.com', verdict: 'invalid', pass: false })), 'email found but verification said invalid', 'finder: the card\'s own address invalid');
ok(/10 of the 1800/.test(text) && /searches: 400 used of 500/.test(text), 'Hunter: our count and the plan');

console.log(`\n${N - F}/${N} passed`);
process.exit(F ? 1 : 0);
