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
// THE MEASUREMENT HAS TO BE RIGHT OR THE QUALITY BAR IS SET ON A WRONG NUMBER.
//
// Two rules in the brief are easy to state and easy to get quietly wrong:
//   - a general inbox is NOT a personal email
//   - a name reachable only through the main line does NOT have a direct channel
//
// Both are checked here against ladders built by the SHIPPED buildContactLadder
// from realistic contact payloads, not against hand-written row objects -- a
// hand-written row would just restate the assertion.
const path = require('path');
const R = REPO;
const S = require(R + 'scripts/ladder-sample.js');
const { buildContactLadder } = require(R + 'server/services/contactLadder');

let f = 0;
const ok = (n, c, got) => {
  if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); }
  else console.log('  PASS ' + n);
};

// The real rank function, so titles land in the tiers they land in for real.
const ai_rank = (() => {
  const fs = require('fs');
  const src = fs.readFileSync(R + 'server/ai.js', 'utf8');
  const start = src.indexOf('function _contactAuthorityRank(title) {');
  let d = 0, j = src.indexOf('{', start), end = j;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { end = j; break; } } }
  return new Function(src.slice(start, end + 1) + '\n return _contactAuthorityRank;')();
})();

const mk = (res, brand) => buildContactLadder(res, {
  rankOf: ai_rank, rootDomain: (u) => String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0],
  category: null, brand: brand || 'X',
});
const row = (brand, res) => S.classify(brand, res, mk(res, brand), { served: 'web', cost: S.costOf({}, 6000) });

console.log('-- A GENERAL INBOX IS NOT A PERSONAL EMAIL --');
{
  // The exact shape that produced "no named contact, call the shop": a published
  // shop mailbox, a main line, and nobody's name.
  const r = row('Inbox Only Co', {
    contacts: [], genericInbox: 'info@inboxonly.example', personalInbox: null,
    businessPhone: '(479) 521-6340', website: 'https://inboxonly.example',
  });
  ok('no named person', r.named === false, r.named);
  ok('  and NO personal email', r.personalEmail === false, r.personalEmail);
  ok('  it is reported as general-inbox-only', r.generalInboxOnly === true, r.generalInboxOnly);
  ok('  the phone is still counted', r.phone === true, r.phone);
  ok('  and it never counts toward named+direct', r.namedPlusDirect === false, r.namedPlusDirect);
}
{
  // A named person WITH their own address, plus a shop inbox. Not inbox-only.
  const r = row('Both Co', {
    contacts: [{ name: 'Dawn Mercer', title: 'Owner', email: 'dawn@bothco.example', source: 'site', confidence: 'high', sourceUrl: 'https://bothco.example/about' }],
    genericInbox: 'info@bothco.example', businessPhone: '(479) 555-0100', website: 'https://bothco.example',
  });
  ok('a named person plus an inbox is NOT inbox-only', r.generalInboxOnly === false, r.generalInboxOnly);
  ok('  the personal email is counted', r.personalEmail === true, r.personalEmail);
  ok('  and it is the named person\'s, not the shop\'s',
    r.personalEmailAddr === 'dawn@bothco.example', r.personalEmailAddr);
}

console.log('\n-- A NAME ON THE MAIN LINE IS NOT A DIRECT CHANNEL --');
{
  // Found by name, no email, no own number: getBrandContacts donates the main line
  // so the card is actionable. That is "ask for Bryan", not a channel to Bryan.
  const r = row('Main Line Only', {
    contacts: [{ name: 'Bryan Hembree', title: 'Owner', email: null, phone: '(479) 521-6340', source: 'chamber', confidence: 'medium' }],
    genericInbox: null, businessPhone: '(479) 521-6340', website: null,
  });
  ok('the person IS named', r.named === true, r.named);
  ok('  and is the top contact', r.topName === 'Bryan Hembree', r.topName);
  ok('  their channel is the main line', r.topChannel === 'mainline', r.topChannel);
  ok('  so there is NO direct channel', r.directChannel === false, r.directChannel);
  ok('  and named+direct is FALSE despite a named owner',
    r.namedPlusDirect === false, r.namedPlusDirect);
  ok('  no personal email either', r.personalEmail === false, r.personalEmail);
}
{
  // The same owner with a genuinely different number is direct.
  const r = row('Own Line', {
    contacts: [{ name: 'Bryan Hembree', title: 'Owner', email: null, phone: '(479) 200-1111', source: 'chamber', confidence: 'medium' }],
    businessPhone: '(479) 521-6340', genericInbox: null, website: null,
  });
  ok('a DIFFERENT number is a direct channel', r.directChannel === true, r.topChannel);
  ok('  and it counts as named+direct', r.namedPlusDirect === true, r.namedPlusDirect);
}
{
  // A DM is a direct channel too, and the brief asks for Instagram separately.
  const r = row('Handle Co', {
    contacts: [{ name: 'Sara Vance', title: 'Owner', email: null, phone: null, source: 'site', confidence: 'high' }],
    businessPhone: null, genericInbox: null, instagram: 'saravance', website: 'https://handleco.example',
  });
  ok('instagram is reported', r.instagram === 'saravance', r.instagram);
  ok('  a handle carrying her name rides her row', r.topChannel === 'instagram', r.topChannel);
  ok('  which is a direct channel', r.namedPlusDirect === true, r.namedPlusDirect);
}
{
  // A BUSINESS handle is a business channel, not a route to the named person.
  const r = row('Biz Handle Co', {
    contacts: [{ name: 'Sara Vance', title: 'Owner', email: null, phone: null, source: 'site', confidence: 'high' }],
    businessPhone: '(479) 521-6340', genericInbox: null, instagram: 'bizhandleco', website: 'https://bizhandleco.example',
  });
  ok('the business handle is still reported', r.instagram === 'bizhandleco', r.instagram);
  ok('  but she is only on the main line', r.topChannel === 'mainline', r.topChannel);
  ok('  so named+direct is FALSE', r.namedPlusDirect === false, r.namedPlusDirect);
}

console.log('\n-- A HUNTER ADDRESS IS A PERSONAL EMAIL, BUT NOT A PUBLISHED ONE --');
{
  // Hunter is funded and back in the ladder, so this block asserts the CURRENT
  // rule rather than the one that held while it was removed. The distinction
  // emailKind exists to draw: a Hunter address is a real personal email, but no
  // source published it against this person, so it must never be counted as
  // published -- that is what keeps the greeting guard from greeting someone by
  // a first name we only inferred. The two measurements DIVERGING here is the
  // invariant now; them collapsing back together would mean the tag was lost.
  const r = row('Paid Lookup Co', {
    contacts: [{ name: 'Dana Kessler', title: 'Company contact (not confirmed owner)',
      email: 'dkessler@paid.example', emailSource: 'hunter', source: 'hunter' }],
    businessPhone: null, genericInbox: null, website: 'https://paid.example',
  });
  ok('it still counts as a personal email', r.personalEmail === true, r.personalEmail);
  ok('  but the ladder does NOT call it published',
    r.personalEmailPublished === false, r.personalEmailPublished);
  ok('  the two measurements diverge, which is what emailKind is for',
    r.personalEmail !== r.personalEmailPublished, [r.personalEmail, r.personalEmailPublished]);
  const L = mk({ contacts: [{ name: 'Dana Kessler', title: 'Owner', email: 'd@x.example' }] }, 'X');
  ok('  no ladder row can be marked "pattern"',
    !JSON.stringify(L).includes('pattern'), (JSON.stringify(L).match(/.{0,40}pattern.{0,20}/) || [])[0]);
  void S;
}

console.log('\n-- A NAME WITH NO CHANNEL AT ALL IS NOT SILENTLY DROPPED --');
{
  const r = row('Nothing Co', {
    contacts: [{ name: 'Gil Pruitt', title: 'Owner', email: null, phone: null, source: 'news', confidence: 'medium' }],
    businessPhone: null, genericInbox: null, website: null,
  });
  ok('he is not on the ladder', r.named === false, r.namedCount);
  ok('  but he IS reported as unreachable', r.unreachable.length === 1, r.unreachable);
  ok('  so "named" never overstates what is actionable', r.namedPlusDirect === false, r.namedPlusDirect);
}

console.log('\n-- THE SOURCE ATTRIBUTION IS PER PERSON --');
{
  const r = row('Multi Source', {
    contacts: [
      { name: 'A One', title: 'Owner', email: 'a@ms.example', source: 'site' },
      { name: 'B Two', title: 'General Manager', email: null, phone: '(479) 200-3333', source: 'chamber' },
    ],
    businessPhone: '(479) 521-6340', genericInbox: null, website: 'https://ms.example',
  });
  ok('site is credited', (r.bySource.site || []).indexOf('A One') !== -1, r.bySource);
  ok('  chamber is credited', (r.bySource.chamber || []).indexOf('B Two') !== -1, r.bySource);
  const t = S.sourceTable([r]);
  ok('  and the yield table counts both', t.length === 2, t);
  ok('  one person each', t.every((x) => x.people === 1), t);
}

console.log('\n-- THE SUMMARY COUNTS AND PERCENTAGES --');
{
  const rows = [
    row('a', { contacts: [{ name: 'N One', title: 'Owner', email: 'n@a.example', source: 'site' }], businessPhone: '(1) 111-1111', website: 'https://a.example' }),
    row('b', { contacts: [{ name: 'N Two', title: 'Owner', source: 'chamber' }], businessPhone: '(1) 222-2222' }),
    row('c', { contacts: [], genericInbox: 'info@c.example', businessPhone: '(1) 333-3333' }),
    row('d', { contacts: [], businessPhone: '(1) 444-4444', instagram: 'dco' }),
  ];
  const s = S.summarize(rows);
  const get = (label) => s.metrics.find((m) => m.label.trim().startsWith(label));
  ok('4 businesses', s.n === 4, s.n);
  ok('  2 named', get('Named person found').count === 2, get('Named person found'));
  ok('  1 personal email (50% of 4)',
    get('Personal email found').count === 1 && get('Personal email found').pct === 25,
    get('Personal email found'));
  ok('  1 inbox-only', get('General inbox only').count === 1, get('General inbox only'));
  ok('  1 instagram', get('Instagram found').count === 1, get('Instagram found'));
  ok('  4 phones', get('Phone found').count === 4, get('Phone found'));
  ok('  and only ONE named+direct, because b is main-line only',
    get('NAMED PERSON').count === 1, get('NAMED PERSON'));
  ok('percentages are of the sample, not of the named subset',
    get('NAMED PERSON').pct === 25, get('NAMED PERSON').pct);
}

console.log('\n-- THE COST MODEL --');
{
  // $10 per 1,000 searches; Haiku 4.5 at $1/M in and $5/M out.
  const c = S.costOf({ sources: 3, searches: 6, outTokens: 2700 }, 6000);
  ok('web search is $0.01 each', Math.abs(c.search - 0.06) < 1e-9, c.search);
  ok('  output at $5/M', Math.abs(c.output - (2700 / 1e6) * 5) < 1e-9, c.output);
  ok('  input counts search results AND the prompt',
    c.inTok === 6 * 6000 + 3 * 700, c.inTok);
  ok('  the total is the three added up',
    Math.abs(c.total - (c.search + c.output + c.input)) < 1e-12, c);
  ok('a cached business costs nothing', S.costOf({}, 6000).total === 0, S.costOf({}, 6000));

  const p = S.projectPerBusiness(6000, 3, 7, 2);
  ok('the floor is a 3-source wave', p.low > 0.09 && p.low < 0.14, p.low);
  ok('  the ceiling is all 7 sources', p.high > 0.22 && p.high < 0.33, p.high);
  ok('  and 20 businesses is well over $1.40, which is the point',
    p.low * 20 > 1.4, { low20: p.low * 20, high20: p.high * 20 });
  console.log('       measured projection: $' + (p.low * 20).toFixed(2) + ' to $' + (p.high * 20).toFixed(2) + ' for 20');
}

console.log('\n-- THE METER READS THE REAL LOG LINES --');
{
  // Copied from the shipped console.log format in ai.js, and from the line the
  // user pasted out of production.
  const m = S.newMeter();
  S.feedMeter(m, '[brand-contacts] source=chamber ms=4508 found=4 tier1=yes searches=2 outTokens=612 apiMs=4501 rawLen=900 status=ran parsed=4');
  S.feedMeter(m, '[brand-contacts] source=site ms=3100 found=0 tier1=no searches=1 outTokens=210 apiMs=3090 rawLen=120 status=ran parsed=0');
  S.feedMeter(m, '[dealScan] contacts brand=Pack Rat Outdoor Center found=5 named=4 withEmail=1 withPhone=2 source=web');
  ok('two sources counted', m.sources === 2, m.sources);
  ok('  three searches summed', m.searches === 3, m.searches);
  ok('  output tokens summed', m.outTokens === 822, m.outTokens);
  ok('  and the run is marked as live, not cache', m.served === 'web', m.served);
  ok('  per-source detail is kept', m.perSource[0].source === 'chamber' && m.perSource[0].tier1 === true, m.perSource);

  const m2 = S.newMeter();
  S.feedMeter(m2, '[dealScan] contacts brand=Cached Co found=3 named=2 withEmail=1 withPhone=1 source=cache');
  ok('a cache hit is detected', m2.served === 'cache', m2.served);
  ok('  with no sources and no searches', m2.sources === 0 && m2.searches === 0, m2);
}

console.log('\n-- THE REPORT ACTUALLY RENDERS --');
{
  // A formatting crash AFTER a paid twenty-business run would throw the whole
  // measurement away, so the renderers are exercised on the awkward cases: a
  // failed lookup, a cache hit, an apostrophe, and a business with nothing.
  const rows = [
    row("Arsaga's at the Depot", { contacts: [{ name: 'Cary Arsaga', title: 'Owner', email: 'cary@arsagas.example', source: 'site' }], businessPhone: '(479) 521-1000', instagram: 'arsagas', website: 'https://arsagas.example' }),
    row('Empty Co', { contacts: [], businessPhone: null, genericInbox: null }),
    Object.assign(row('Cached Co', { contacts: [], genericInbox: 'info@cached.example', businessPhone: '(1) 222-2222' }), { served: 'cache' }),
    Object.assign(row('Broken Co', {}), { served: 'ERROR', error: 'timeout-15s' }),
  ];
  let table = null, summary = null, threw = null;
  try {
    table = S.renderTable(rows);
    summary = S.renderSummary(S.summarize(rows), {
      search: 0.12, output: 0.014, input: 0.076, total: 0.21,
      searches: 12, outTokens: 2800, inTok: 74100, cached: 1, priced: 4, hunter: 2,
    }, { city: 'Fayetteville', state: 'AR', inTok: 6000 });
  } catch (e) { threw = e; }
  ok('the table renders without throwing', !threw, threw && threw.message);
  ok('  every business has a line', table && rows.every((r) => table.indexOf(r.brand.slice(0, 20)) !== -1), null);
  ok('  a cache hit shows as cache, not $0.000', /cache/.test(table || ''), null);
  ok('  the columns line up', (() => {
    const lines = (table || '').split('\n');
    return lines.length > 2 && new Set(lines.map((l) => l.length)).size === 1;
  })(), (table || '').split('\n').map((l) => l.length));
  ok('the summary renders', !!summary && /SUMMARY/.test(summary), null);
  ok('  it states the two rules in words',
    /never counts a general inbox/.test(summary) && /never counts a name reachable only via the main line/.test(summary), null);
  ok('  the estimated line is labelled ESTIMATED',
    /ESTIMATED at 6000 tok\/search/.test(summary), null);
  ok('  the measured lines are labelled measured',
    (summary.match(/measured/g) || []).length === 2, (summary.match(/measured/g) || []).length);
  ok('  and the non-Anthropic costs are called out, not folded in',
    /Not included, not billed by Anthropic/.test(summary), null);
}

console.log('\n-- THE SCRIPT DOES NOT TOUCH PRODUCT CODE --');
{
  const fs = require('fs');
  const src = fs.readFileSync(R + 'scripts/ladder-sample.js', 'utf8');
  ok('it calls the shipped deep ctx', /ai\.deepContactCtx\(\{ market: null \}\)/.test(src));
  ok('  and the shipped lookup', /ai\.getBrandContacts\(brand, null, region,/.test(src));
  ok('  and the shipped ladder builder', /buildContactLadder\(res, \{/.test(src));
  ok('  it never sets the test seam', !/_setContactSearchImpl/.test(src));
  ok('  never reaches into ai._test', !/ai\._test/.test(src));
  ok('  and writes nothing to the database itself', !/INSERT INTO|UPDATE |pool\.query/.test(src));
  // READ-ONLY, stated as a property of the SCRIPT rather than of one commit. This
  // used to diff `git status` and exclude scripts/, which asserted something true
  // of the commit that introduced it and nothing about the file -- so it broke the
  // first time unrelated work touched server/. What actually matters is that the
  // sampler reaches product code only through entry points that compute and return.
  const imports = (src.match(/require\(['"]\.\.\/server\/[^'"]+['"]\)/g) || [])
    .map((m) => m.replace(/require\(['"]|['"]\)/g, ''));
  ok('it imports only the two read-only entry points',
    imports.length === 2
      && imports.indexOf('../server/ai') !== -1
      && imports.indexOf('../server/services/contactLadder') !== -1, imports);
  ok('  and imports nothing from server/ at load time (so --dry-run needs no deps)',
    src.indexOf("const ai = require('../server/ai')") > src.indexOf('async function main('), null);
}

console.log('\nfailures: ' + f);
process.exit(f ? 1 : 0);
