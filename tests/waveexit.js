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
// Two findings from the live logs.
//
// 2. "[waves] satisfied after wave 1 (3 source(s))" fired with every wave-one
//    source reporting tier1=no. Only 3 of 7 sources ran; site, linkedin, news and
//    chamber never executed.
//
// 3. The card path keys on "fayetteville, ar" and the outreach workflow on
//    "fayetteville, arkansas", so one business occupied two cache rows.
//
// Both are executed here, not read: the SHIPPED wave runner is driven with fake
// sources, and the SHIPPED cache-key expressions are lifted and compared.
const fs = require('fs'), Module = require('module');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const R = REPO;
const AI = fs.readFileSync(R + 'server/ai.js', 'utf8');
const CD = fs.readFileSync(R + 'server/services/contactDiscovery.js', 'utf8');
const PL = fs.readFileSync(R + 'server/services/placesLookup.js', 'utf8');

// Brace-match a function body. The opening brace is found AFTER the parameter
// list closes, because a default parameter -- `opts = {}` -- puts a brace inside
// the signature and a naive indexOf('{') lifts that instead of the body.
function liftFn(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) throw new Error('FIXTURE BROKEN: ' + sig);
  let i = src.indexOf('(', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (!depth) { i++; break; } }
  }
  let j = src.indexOf('{', i), d = 0, end = j;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { end = j; break; } } }
  const out = src.slice(start, end + 1);
  if (out.length < 60) throw new Error('FIXTURE BROKEN: lifted only ' + out.length + ' chars for ' + sig);
  return out;
}

// ── the shipped pieces ───────────────────────────────────────────────────────
const runSourceWaves = new Function('console',
  liftFn(AI, 'async function runSourceWaves(') + '\n return runSourceWaves;')({ log() {} });
// Both lifted functions delegate to services/contactRank now, so the binding
// their module scope has must be handed in.
const _CR = require(R + 'server/services/contactRank');
const rankOf = new Function('_CR', liftFn(AI, 'function _contactAuthorityRank(title) {') + '\n return _contactAuthorityRank;')(_CR);
const TIER1 = JSON.parse((AI.match(/const _TIER1_RANKS = (\[[^\]]*\]);/) || [])[1]);
const mergeContacts = new Function('_contactAuthorityRank', '_CR',
  liftFn(AI, 'function _mergeNameKey(name) {') + '\n' + liftFn(AI, 'function _mergeContacts(all) {') + '\n return _mergeContacts;')(rankOf, _CR);

// The exit rule, lifted out of _fetchBrandContacts exactly as written.
const isSatSrc = (AI.match(/isSatisfied: \(all\) => \{[\s\S]*?\n      \},/) || [])[0];
if (!isSatSrc) throw new Error('FIXTURE BROKEN: isSatisfied not found');
const mkIsSatisfied = (manualLadder) => new Function(
  '_mergeContacts', '_contactAuthorityRank', '_TIER1_RANKS', 'manualLadder',
  'return (' + isSatSrc.replace(/^isSatisfied: /, '').replace(/,$/, '') + ');'
)(mergeContacts, rankOf, TIER1, manualLadder);

// ── fixtures: what the live Millennium wave 1 looked like ───────────────────
// Three sources ran. None found a decision maker. One returned a receptionist,
// whose title _contactAuthorityRank does not recognise -> rank 7.
const RECEPTIONIST = { name: 'Dawn Mercer', title: 'Patient Care Coordinator', email: null, phone: null };
const OWNER = { name: 'Scott Duca', title: 'Owner', email: 'scott@millenniumchiro.com', phone: null };
const src = (source, contacts) => ({ source, contacts, kept: contacts.length, ms: 10, status: 'ran' });

(async () => {
  console.log('-- WHAT THE RANKER THINKS OF THAT TITLE --');
  {
    ok('a patient care coordinator is not Tier 1',
      TIER1.indexOf(rankOf(RECEPTIONIST.title)) === -1, rankOf(RECEPTIONIST.title));
    ok('  and an owner is', TIER1.indexOf(rankOf(OWNER.title)) !== -1, rankOf(OWNER.title));
    // The number itself is not the point and I named the wrong one first: this title
    // matches /coordinator/ and ranks 6, not the unrecognised-title 7. What matters is
    // the property -- it is not a decision maker, yet it sits below the
    // registered-agent floor of 9, so the scan exit rule treats it as good enough.
    ok('  it ranks below the registered-agent floor of 9, which is what the scan rule tests',
      rankOf(RECEPTIONIST.title) < 9 && TIER1.indexOf(rankOf(RECEPTIONIST.title)) === -1,
      rankOf(RECEPTIONIST.title));
    ok('  and a wholly unrecognised title ranks 7, also below the floor',
      rankOf('Wellness Guide') === 7, rankOf('Wellness Guide'));
  }

  console.log('\n-- THE EXIT RULE ON THE DEEP PATH --');
  {
    const wave1 = [src('registry', []), src('facebook', [RECEPTIONIST]), src('maps', [])];
    ok('DEEP: a receptionist does NOT satisfy the ladder',
      mkIsSatisfied(true)(wave1) === false, mkIsSatisfied(true)(wave1));
    ok('  an owner does', mkIsSatisfied(true)([src('site', [OWNER])]) === true);
    // This is the rule the workflow path was actually running under.
    ok('SCAN rule: the SAME receptionist satisfies it, which is the bug',
      mkIsSatisfied(false)(wave1) === true, mkIsSatisfied(false)(wave1));
  }

  console.log('\n-- SO THE FAN-OUT MUST RUN PAST WAVE 1 --');
  {
    const SOURCES = ['site', 'facebook', 'chamber', 'linkedin', 'maps', 'news', 'registry'];
    const ran = [];
    const runOne = async (s) => {
      ran.push(s);
      // Only the site knows the owner. Everything else finds the receptionist or nothing.
      if (s === 'site') return src(s, [OWNER]);
      if (s === 'facebook') return src(s, [RECEPTIONIST]);
      return src(s, []);
    };
    const out = await runSourceWaves(SOURCES, runOne, {
      wallBudgetMs: 40000, label: 'test',
      hasWin: (r) => (r.contacts || []).some((c) => TIER1.indexOf(rankOf(c.title)) !== -1),
      isSatisfied: mkIsSatisfied(true),
    });
    ok('the owner is found', out.results.some((r) => (r.contacts || []).some((c) => c.name === 'Scott Duca')), ran);

    // And with the scan rule, on a business where the owner is NOT in wave 1.
    const ran2 = [];
    const runOne2 = async (s) => {
      ran2.push(s);
      if (s === 'registry') return src(s, [RECEPTIONIST]);   // wave 1 under the scan order
      if (s === 'site') return src(s, [OWNER]);              // wave 2 under the scan order
      return src(s, []);
    };
    const SCAN_ORDER = ['registry', 'facebook', 'maps', 'news', 'chamber', 'site', 'linkedin'];
    const stopped = await runSourceWaves(SCAN_ORDER, runOne2, {
      wallBudgetMs: 22000, label: 'test',
      hasWin: (r) => (r.contacts || []).some((c) => TIER1.indexOf(rankOf(c.title)) !== -1),
      isSatisfied: mkIsSatisfied(false),
    });
    ok('under the SCAN rule the search stops after wave 1', stopped.wavesRun === 1, stopped.wavesRun);
    ok('  having never run site', ran2.indexOf('site') === -1, ran2);
    ok('  and the owner is never found',
      !stopped.results.some((r) => (r.contacts || []).some((c) => c.name === 'Scott Duca')), ran2);

    const ran3 = [];
    const runOne3 = async (s) => {
      ran3.push(s);
      if (s === 'registry') return src(s, [RECEPTIONIST]);
      if (s === 'site') return src(s, [OWNER]);
      return src(s, []);
    };
    const kept = await runSourceWaves(SCAN_ORDER, runOne3, {
      wallBudgetMs: 40000, label: 'test',
      hasWin: (r) => (r.contacts || []).some((c) => TIER1.indexOf(rankOf(c.title)) !== -1),
      isSatisfied: mkIsSatisfied(true),
    });
    ok('under the DEEP rule it keeps going and finds him', ran3.indexOf('site') !== -1, ran3);
    ok('  and stops once he is found, not after all seven', kept.wavesRun < 3, kept.wavesRun);
  }

  console.log('\n-- THE WORKFLOW PATH NOW USES THE DEEP CTX --');
  {
    ok('contactDiscovery no longer passes a bare enrichEmail',
      !/getBrandContacts\([^)]*\{ enrichEmail: true \}\)/.test(CD), (CD.match(/getBrandContacts\([\s\S]{0,200}/) || [])[0]);
    ok('  it uses the shared builder', /deepContactCtx\(/.test(CD), null);
    // Guarded: an absent builder must FAIL and let the region assertions below still
    // run, rather than throwing and hiding half the report.
    const hasBuilder = /function deepContactCtx\(/.test(AI);
    ok('a shared deep-ctx builder exists', hasBuilder, hasBuilder);
    const c = hasBuilder
      ? new Function('MANUAL_SOURCE_ORDER', liftFn(AI, 'function deepContactCtx(opts) {') + '\n return deepContactCtx;')(['site', 'facebook'])({ market: null })
      : {};
    ok('the shared ctx sets stopAtTier1', c.stopAtTier1 === true, c);
    ok('  and enrichEmail', c.enrichEmail === true, c);
    ok('  and site-first source order', (c.sourceOrder || [])[0] === 'site', c.sourceOrder);
    // Every getBrandContacts call in index.js is either the cheap card pass inside
    // _brandContactsBatch or a deep one built by the shared ctx. Nothing hand-rolls
    // a deep ctx any more.
    const IDXSRC = fs.readFileSync(R + 'server/index.js', 'utf8');
    ok('index.js hand-rolls no deep ctx',
      !/enrichEmail: true,\s*\n\s*sourceOrder/.test(IDXSRC) && !/ctx\.stopAtTier1 = true/.test(IDXSRC),
      (IDXSRC.match(/enrichEmail: true[\s\S]{0,80}/) || [])[0]);
    for (const [file, src2] of [['index.js', fs.readFileSync(R + 'server/index.js', 'utf8')], ['contactDiscovery.js', CD],
      ['ladderPrewarm.js', fs.readFileSync(R + 'server/services/ladderPrewarm.js', 'utf8')]]) {
      ok(`  ${file} declares no local sourceOrder/stopAtTier1 pair`,
        !/sourceOrder: ai\.MANUAL_SOURCE_ORDER,\s*\n\s*stopAtTier1: true/.test(src2), file);
    }
  }

  console.log('\n-- THE REGION IS ONE CANONICAL FORM --');
  {
    const { canonicalRegion } = require(R + 'server/services/regionKey.js');
    ok('"Fayetteville, AR" and "Fayetteville, Arkansas" collide',
      canonicalRegion('Fayetteville, AR') === canonicalRegion('Fayetteville, Arkansas'),
      [canonicalRegion('Fayetteville, AR'), canonicalRegion('Fayetteville, Arkansas')]);
    ok('  as does a lowercase spelling', canonicalRegion('fayetteville, arkansas') === canonicalRegion('Fayetteville, AR'));
    ok('  and one with extra whitespace', canonicalRegion('  Fayetteville ,  AR ') === canonicalRegion('Fayetteville, AR'),
      canonicalRegion('  Fayetteville ,  AR '));
    ok('a full street address reduces to the same place',
      canonicalRegion('123 W Dickson St, Fayetteville, AR 72701') === canonicalRegion('Fayetteville, AR'),
      canonicalRegion('123 W Dickson St, Fayetteville, AR 72701'));
    ok('  and so does one with a ZIP+4',
      canonicalRegion('123 W Dickson St, Fayetteville, AR 72701-1234') === canonicalRegion('Fayetteville, AR'));
    ok('DIFFERENT towns do not collide',
      canonicalRegion('Fayetteville, AR') !== canonicalRegion('Fayetteville, NC'),
      [canonicalRegion('Fayetteville, AR'), canonicalRegion('Fayetteville, NC')]);
    ok('  nor do two towns in the same state',
      canonicalRegion('Fayetteville, AR') !== canonicalRegion('Bentonville, AR'));
    ok('an empty region stays empty', canonicalRegion('') === '' && canonicalRegion(null) === '');
    ok('an unrecognisable region is still tidied rather than dropped',
      canonicalRegion('  Somewhere   Odd ') === 'somewhere odd', canonicalRegion('  Somewhere   Odd '));
  }

  console.log('\n-- AND BOTH CACHE KEYS USE IT --');
  {
    const contactsKey = (AI.match(/const _locKey = canonicalRegion\(loc\);\s*\n\s*const cacheKey = \(_locKey[^;]*;/) || [])[0];
    ok('the contacts key is built from the canonical region', !!contactsKey, contactsKey);
    ok('  not from the raw locationHint', !/const cacheKey = \(loc \?/.test(AI), null);
    ok('the Places key is too', /const l = canonicalRegion\(loc\);/.test(PL), (PL.match(/function _key[\s\S]{0,200}/) || [])[0]);

    // The two spellings must produce ONE row, end to end.
    const { canonicalRegion } = require(R + 'server/services/regionKey.js');
    const mkContactsKey = contactsKey
      ? new Function('brand', 'loc', 'manualLadder', 'canonicalRegion', contactsKey + '\n return cacheKey;')
      : () => 'NO KEY EXPRESSION';
    const a = mkContactsKey('Millennium Chiropractic and Rehab', 'Fayetteville, AR', true, canonicalRegion);
    const b = mkContactsKey('Millennium Chiropractic and Rehab', 'Fayetteville, Arkansas', true, canonicalRegion);
    ok('the card path and the workflow path resolve to ONE contacts key', a === b, [a, b]);
    ok('  and it is still the manual key', / \| manual$/.test(a), a);
  }

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
