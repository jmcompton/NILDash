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
// THE DOMAIN GATE, END TO END.
//
// The bug it fixes is not "a wrong URL was stored". It is that a wrong URL was
// TRUSTED: written into the model's prompt as fact, scraped for an address, paid
// for at Hunter, and then used as the yardstick every email was judged against --
// which inverted the cross-domain warning and pointed the agent at the wrong
// company while flagging the right one as suspect.
const ROOT = REPO;
const fs = require('fs');
const gate = require(ROOT + 'server/services/domainGate.js');
const CL = require(ROOT + 'server/services/contactLadder.js');
const SE = require(ROOT + 'server/services/siteEmail.js');

let F = 0;
const ok = (n, c, g) => { if (c) console.log('  PASS ' + n); else { F++; console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

// ── 1. THE FIVE REPORTED FAILURES ────────────────────────────────────────────
console.log('\n-- 1. the Birmingham run --');
const REPORTED = [
  ['Post Office Pies', 'https://davenportspizza.com'],
  ['Homewood Cycle & Fitness', 'https://cahabacycles.com'],
  ['Homewood Cycle & Fitness', 'https://three15studio.com'],
  ['Onyx Coffee Lab', 'https://daysolcoffeelab.co'],
  ['Millennium Chiropractic', 'https://pillarchiropractic.com'],
];
for (const [b, w] of REPORTED) {
  const v = gate.checkDomain(b, w);
  ok(`${b} does NOT own ${w.replace('https://', '')}`, v.ok === false, v);
}
// And the reason names the words it looked for, so the log is diagnosable.
const r1 = gate.checkDomain('Onyx Coffee Lab', 'https://daysolcoffeelab.co');
ok('  the reason names the distinctive words it wanted', /onyx/.test(r1.reason), r1.reason);
ok('  and does NOT count the trade word it shares', !/matched/.test(String(r1.matchedOn)), r1.matchedOn);

// ── 2. IT MUST NOT EAT THE RIGHT ANSWER ──────────────────────────────────────
console.log('\n-- 2. the same businesses, their real domains --');
const REAL = [
  ['Post Office Pies', 'https://postofficepies.com', 'post'],
  ['Homewood Cycle & Fitness', 'https://homewoodcycle.com', 'homewood'],
  ['Onyx Coffee Lab', 'https://onyxcoffeelab.com', 'onyx'],
  ['Millennium Chiropractic', 'https://millenniumchiro.com', 'millennium'],
  // Shapes named in the existing comments, which must keep working.
  ['EW Motion Therapy', 'https://ewmotiontherapy.com', 'motion'],
  ['Cahaba Cycles', 'https://cahabacycles.com', 'cahaba'],
  ['Rick Hendrick BMW Charleston', 'https://rickhendrickbmw.com', 'rick'],
  ['Continental Bakery', 'https://continentalbakery.com', 'continental'],
  ['Pack Rat Outdoor Center', 'https://packratoutdoor.com', 'pack'],
];
for (const [b, w, on] of REAL) {
  const v = gate.checkDomain(b, w);
  ok(`${b} DOES own ${w.replace('https://', '')}`, v.ok === true && v.matchedOn === on, v);
}
// A dropped location word does not change the domain test.
ok('a subdomain does not defeat it',
  gate.checkDomain('Onyx Coffee Lab', 'https://shop.onyxcoffeelab.com').ok === true);
ok('a path does not defeat it',
  gate.checkDomain('Onyx Coffee Lab', 'https://onyxcoffeelab.com/about/team').ok === true);
ok('a hyphen does not defeat it',
  gate.checkDomain('Post Office Pies', 'https://post-office-pies.com').ok === true);

// ── 3. A TRADE WORD IS NOT EVIDENCE ──────────────────────────────────────────
console.log('\n-- 3. the words that caused it --');
for (const w of ['cycle', 'lab', 'chiropractic']) {
  ok(`"${w}" no longer counts as a distinctive word`, !SE.nameTokens('Foo ' + w).includes(w));
}
ok('  but a place name still does', SE.nameTokens('Cahaba Cycles').includes('cahaba'));
ok('  and so does an ordinary distinctive word', SE.nameTokens('Onyx Coffee Lab').includes('onyx'));
// The report's own function had the same hole, through a different door.
ok('the coverage report no longer matches a bare trade word either',
  SE.domainMatchesBusiness('Millennium Chiropractic', 'https://chiropractic.com').plausible === false,
  SE.domainMatchesBusiness('Millennium Chiropractic', 'https://chiropractic.com'));
ok('  while a real truncation still matches',
  SE.domainMatchesBusiness('Cycle Therapy', 'https://cycletherapyllc.com').plausible === true);

// ── 4. A NAME MADE ONLY OF TRADE WORDS ───────────────────────────────────────
console.log('\n-- 4. when the name itself says nothing --');
const gen = gate.checkDomain('Cycle Therapy', 'https://cahabacycles.com');
ok('a name of pure trade words cannot confirm a stranger domain', gen.ok === false, gen);
ok('  under its own code, not the same one as a mismatch',
  gen.code === 'no-distinctive-word', gen.code);
ok('  but the WHOLE name still confirms its own domain',
  gate.checkDomain('Cycle Therapy', 'https://cycletherapy.com').ok === true);
ok('  and a partial overlap does not',
  gate.checkDomain('Cycle Therapy', 'https://cycle.com').ok === false);

// ── 5. PLATFORM PAGES ARE NOT A DOMAIN TO BUY AGAINST ────────────────────────
console.log('\n-- 5. facebook.com is not this business --');
for (const [b, w] of [['Post Office Pies', 'https://facebook.com/postofficepies'],
  ['Onyx Coffee Lab', 'https://yelp.com/biz/onyx-coffee'],
  ['Square Deal Auto', 'https://square.site/squaredeal']]) {
  const v = gate.checkDomain(b, w);
  ok(`${w.replace('https://', '').slice(0, 28)} is not a business domain`,
    v.ok === false && v.code === 'third-party-host', v);
}
ok('  Square Deal Auto did not pass on the word "square"',
  gate.checkDomain('Square Deal Auto', 'https://square.site/x').matchedOn === null);

// ── 6. TWO CANDIDATES: THE SECOND GETS A LOOK ────────────────────────────────
console.log('\n-- 6. a bad first candidate is no longer the end of it --');
const p1 = gate.pickWebsite('Onyx Coffee Lab',
  ['https://daysolcoffeelab.co', 'https://onyxcoffeelab.com']);
ok('the bad stored URL is skipped and the good Places one used',
  p1.website === 'https://onyxcoffeelab.com', p1);
ok('  and it reports no drop, because one candidate worked', p1.dropped === null);
ok('  while still logging the rejected one', p1.drops.length === 1, p1.drops);
const p2 = gate.pickWebsite('Onyx Coffee Lab', ['https://daysolcoffeelab.co', null]);
ok('with nothing usable the website is null', p2.website === null, p2);
ok('  and the reason is carried, not swallowed', /onyx/.test(p2.dropped.reason), p2.dropped);

// ── 7. THE CROSS-DOMAIN GUARD STOPS RUNNING BACKWARDS ────────────────────────
// This is the consequence that made a wrong website worse than no website.
console.log('\n-- 7. the guard no longer accuses the right address --');
const rootFn = (u) => String(u || '').replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
ok('with the WRONG site, the real address used to be flagged (still would be)',
  /Different domain/.test(String(CL.crossDomainNote(
    'hello@postofficepies.com', 'https://davenportspizza.com', rootFn))));
ok('  so with NO confirmed site it says nothing at all',
  CL.crossDomainNote('hello@postofficepies.com', null, rootFn, false) === null);
ok('  and refuses even if a URL is passed anyway',
  CL.crossDomainNote('hello@postofficepies.com', 'https://davenportspizza.com', rootFn, false) === null,
  CL.crossDomainNote('hello@postofficepies.com', 'https://davenportspizza.com', rootFn, false));
ok('  a CONFIRMED site still warns on a genuine mismatch',
  /eskridgeandwhite/.test(String(CL.crossDomainNote(
    'info@eskridgeandwhite.com', 'https://ewmotiontherapy.com', rootFn, true))));
ok('  and stays silent when they agree',
  CL.crossDomainNote('info@ewmotiontherapy.com', 'https://ewmotiontherapy.com', rootFn, true) === null);

// ── 8. THE LADDER: STILL RUNS, AND SAYS WHY THERE IS NO SITE ─────────────────
console.log('\n-- 8. the business still runs, and the card says so --');
const res = {
  contacts: [{ name: 'Dave Horn', title: 'Owner', email: 'dave@postofficepies.com',
    emailSource: 'published', source: 'site', sourceUrl: 'https://x.com', confidence: 'high' }],
  businessPhone: '(205) 555-0100',
  website: null,
  websiteDropped: { url: 'https://davenportspizza.com', code: 'name-absent',
    reason: 'no distinctive word of "Post Office Pies" appears in davenportspizza.com' },
};
const L = CL.buildContactLadder(res, { rankOf: () => 0, rootDomain: rootFn, brand: 'Post Office Pies' });
const row = L.tiers.flatMap((t) => t.rows).find((r) => r.name === 'Dave Horn');
ok('the contact the other sources found is still on the ladder', !!row, L.tiers);
ok('  at tier 1', L.hasTier1 === true, L.topTier);
ok('  and his address is NOT accused of being a different domain',
  !row.emailDomainNote, row && row.emailDomainNote);
ok('the dropped website is on the card', !!L.websiteNote, L.websiteNote);
ok('  naming the domain that was rejected', /davenportspizza\.com/.test(L.websiteNote), L.websiteNote);
ok('  and saying contacts came from elsewhere, not that the business is dead',
  /other sources/.test(L.websiteNote), L.websiteNote);
ok('  with a code the page can count', L.websiteDroppedCode === 'name-absent', L.websiteDroppedCode);
// A confirmed website leaves the card exactly as it was.
const L2 = CL.buildContactLadder({ ...res, website: 'https://postofficepies.com', websiteDropped: null },
  { rankOf: () => 0, rootDomain: rootFn, brand: 'Post Office Pies' });
ok('a confirmed website adds no note at all', L2.websiteNote === null, L2.websiteNote);

// A dropped site must not be resurrected through opts.website.
const L3 = CL.buildContactLadder(res, { rankOf: () => 0, rootDomain: rootFn,
  brand: 'Post Office Pies', website: 'https://davenportspizza.com' });
const row3 = L3.tiers.flatMap((t) => t.rows).find((r) => r.name === 'Dave Horn');
ok('opts.website CANNOT smuggle the rejected domain back in as ground truth',
  !row3.emailDomainNote, row3 && row3.emailDomainNote);

// ── 9. contactLadder STAYS PURE ──────────────────────────────────────────────
// It renders cards. If it starts requiring domainGate it drags in siteEmail and
// a pg pool, and every card render opens a database connection.
console.log('\n-- 9. the renderer holds no database connection --');
const clSrc = fs.readFileSync(ROOT + 'server/services/contactLadder.js', 'utf8');
ok('contactLadder does not require domainGate', !/require\(.*domainGate/.test(clSrc));
ok('  nor siteEmail', !/require\(.*siteEmail/.test(clSrc));
ok('  nor store', !/require\(.*store/.test(clSrc));

// ── 10. THE PROMPT ───────────────────────────────────────────────────────────
// Item 6: unchanged with a domain, and with none it must not invite the model to
// substitute the nearest same-trade business -- the failure arriving another way.
console.log('\n-- 10. the site prompt --');
const aiSrc = fs.readFileSync(ROOT + 'server/ai.js', 'utf8');
// Lift the real function by balancing braces, so the test runs the shipped text
// rather than a paraphrase of it.
function liftFn(src, name) {
  const start = src.indexOf('function ' + name);
  if (start < 0) throw new Error('no such function: ' + name);
  let i = src.indexOf('{', start), depth = 0, inStr = null, esc = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (inStr) { if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}
const _sourceLead = new Function('stateName',
  'return ' + liftFn(aiSrc, '_sourceLead'))((s) => (s === 'AL' ? 'Alabama' : s));
const withDom = _sourceLead('site', 'Onyx Coffee Lab', 'Birmingham, AL', 'onyxcoffeelab.com', 'AL');
const noDom = _sourceLead('site', 'Onyx Coffee Lab', 'Birmingham, AL', null, 'AL');
const EXPECTED_WITH = 'Search the business\'s OWN website for "Onyx Coffee Lab" in Birmingham, AL'
  + ' (onyxcoffeelab.com): its team, about, staff, and contact pages.'
  + ' Extract named people with the titles the site states, and any published email or phone.';
ok('with a domain the prompt is byte-identical to before', withDom === EXPECTED_WITH, withDom);
ok('with NO domain it says so', /NO confirmed domain/.test(noDom), noDom);
ok('  and forbids a similarly named business', /similarly named business/.test(noDom));
ok('  and forbids another business in the same trade', /same trade/.test(noDom));
ok('  and still ends with the same extraction instruction',
  noDom.endsWith('Extract named people with the titles the site states, and any published email or phone.'));
// Every other source lead is untouched.
for (const s of ['registry', 'facebook', 'maps', 'news', 'chamber', 'linkedin']) {
  const a = _sourceLead(s, 'Onyx Coffee Lab', 'Birmingham, AL', 'onyxcoffeelab.com', 'AL');
  const b = _sourceLead(s, 'Onyx Coffee Lab', 'Birmingham, AL', null, 'AL');
  ok(`  ${s} is unchanged by the domain being null`, a === b);
}

// ── 11. THE GATE IS ACTUALLY WIRED IN, AHEAD OF THE SPENDERS ─────────────────
console.log('\n-- 11. it runs before anything is scraped or bought --');
const gb = aiSrc.slice(aiSrc.indexOf('async function getBrandContacts'));
const gbBody = gb.slice(0, gb.indexOf('\n}\n'));
const at = (s) => gbBody.indexOf(s);
ok('the gate runs inside getBrandContacts', at('pickWebsite(brand') > -1);
ok('  BEFORE the Instagram scrape', at('pickWebsite(brand') < at('findInstagram'), [at('pickWebsite(brand'), at('findInstagram')]);
ok('  BEFORE the contact fan-out', at('pickWebsite(brand') < at('_fetchBrandContacts(brand, effectiveWebsite'));
ok('  BEFORE the site-email scrape', at('pickWebsite(brand') < at('findSiteEmail'));
ok('  BEFORE Hunter spends a credit', at('pickWebsite(brand') < at('_hunterEligible'));
ok('the returned website is the GATED one, not re-derived from Places',
  /website: effectiveWebsite, websiteDropped/.test(gbBody)
  && !/website: \(places && places\.website\)/.test(gbBody));
ok('and the drop is logged', /\[domain-gate\]/.test(gbBody));

// ── 12. THE CARD CANNOT POST THE REJECTED URL BACK ───────────────────────────
// It outranks the Places one on the next call, so leaving it on the card is a
// way round the gate rather than a cosmetic problem.
console.log('\n-- 12. the rejected URL does not survive on the client --');
for (const f of ['public/index.html', 'public/outreach-engine.js']) {
  const src = fs.readFileSync(ROOT + f, 'utf8').replace(/\/\/[^\n]*/g, '');
  ok(`${f} clears the card's website when the gate dropped it`,
    /if \(row\.websiteDropped\) d\.website = null;/.test(src));
}
const idx = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
ok('Add a Business puts the GATED website on the card',
  /card\.website = contacts\.website \|\| null;/.test(idx));
const html = fs.readFileSync(ROOT + 'public/index.html', 'utf8').replace(/<!--[\s\S]*?-->/g, '');
ok('the ladder renderer shows the note', /L\.websiteNote/.test(html));

console.log('\nfailures: ' + F);
process.exit(F ? 1 : 0);
