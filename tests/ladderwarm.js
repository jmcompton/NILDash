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
// The ladder, warmed at scan time.
//
// The whole thing turns on ONE property: the warm must call getBrandContacts with
// the same arguments the click path calls it with, because the cache key is built
// from those arguments. Warm a different key and nothing fails -- the click simply
// misses, pays the full ~30s, and the warm was money burned in silence.
//
// So this test does not check that the warm "ran". It lifts the deep ctx the SHIPPED
// route builds, and asserts the warm produces the same one, and that both resolve to
// the same cache key using the SHIPPED key expression out of ai.js.
const fs = require('fs'), Module = require('module');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const R = REPO;
const SRV = fs.readFileSync(R + 'server/index.js', 'utf8');
const AI = fs.readFileSync(R + 'server/ai.js', 'utf8');

// ── load the shipped module with ai injected ────────────────────────────────
let calls = [];
let RESULT = null;
let THROW = null;
const origLoad = Module._load;
Module._load = function (req) {
  if (req === '../ai') return {
    MANUAL_SOURCE_ORDER: ['site', 'facebook', 'chamber', 'linkedin', 'maps', 'news', 'registry'],
    // The REAL builder, lifted from ai.js, so deepCtx delegates to the shipped rule
    // rather than to a stub that could agree with a wrong implementation.
    deepContactCtx: (function () {
      const src = AI.slice(AI.indexOf('function deepContactCtx(opts) {'));
      let d = 0, j = src.indexOf('{', src.indexOf(')')), end = j;
      for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) { end = j; break; } } }
      return new Function('MANUAL_SOURCE_ORDER', src.slice(0, end + 1) + '\n return deepContactCtx;')(
        ['site', 'facebook', 'chamber', 'linkedin', 'maps', 'news', 'registry']);
    })(),
    getBrandContacts: async (brand, website, loc, ctx) => {
      calls.push({ brand, website, loc, ctx });
      if (THROW) throw new Error(THROW);
      return RESULT;
    },
  };
  return origLoad.apply(this, arguments);
};
delete require.cache[require.resolve(R + 'server/services/ladderPrewarm.js')];
const lp = require(R + 'server/services/ladderPrewarm.js');
Module._load = origLoad;

const card = (brand, extra) => Object.assign({
  brand, website: 'https://' + brand.toLowerCase().replace(/\W+/g, '') + '.com',
  region: 'Birmingham, AL', market: 'school', category: 'gym',
}, extra || {});
const LADDER = { contacts: [{ name: 'Dana Kessler', title: 'Owner', email: 'd@x.com' }], businessPhone: '(205) 555-0142' };
const reset = () => { calls = []; THROW = null; RESULT = LADDER; };

(async () => {
  console.log('-- THE ONE THING THAT MATTERS: the same cache key as the click --');
  {
    // The route and the warm now call the SAME builder, so instead of comparing two
    // hand-built objects this asserts that neither side builds one at all -- which is
    // the property that actually prevents drift.
    const rt = SRV.slice(SRV.indexOf('async function _brandContactsBatch'), SRV.indexOf("app.post('/api/agent/brand-contacts'"));
    ok('the route builds its deep ctx from the shared builder',
      /ai\.deepContactCtx\(/.test(rt), (rt.match(/const ctx = deep[\s\S]{0,200}/) || [])[0]);
    ok('  and hand-rolls none of it', !/ctx\.stopAtTier1 = true/.test(rt), null);
    const LP = fs.readFileSync(R + 'server/services/ladderPrewarm.js', 'utf8');
    ok('the warm does too', /ai\.deepContactCtx\(/.test(LP), null);

    const routeCtx = require(R + 'server/services/ladderPrewarm.js').deepCtx(
      { market: 'school', isFranchise: false });
    const warmCtx = lp.deepCtx(card('Iron Tribe', { market: 'school' }));
    ok('enrichEmail matches', warmCtx.enrichEmail === routeCtx.enrichEmail, [warmCtx.enrichEmail, routeCtx.enrichEmail]);
    ok('stopAtTier1 matches', warmCtx.stopAtTier1 === routeCtx.stopAtTier1, [warmCtx.stopAtTier1, routeCtx.stopAtTier1]);
    ok('sourceOrder matches',
      JSON.stringify(warmCtx.sourceOrder) === JSON.stringify(routeCtx.sourceOrder), [warmCtx.sourceOrder, routeCtx.sourceOrder]);
    ok('market matches', warmCtx.market === routeCtx.market, [warmCtx.market, routeCtx.market]);

    // And now the key itself, built by the SHIPPED expression.
    const keyLine = (AI.match(/const _locKey = canonicalRegion\(loc\);\s*\n\s*const cacheKey = \(_locKey[^;]*;/) || [])[0];
    ok('the cache key expression was lifted from ai.js', !!keyLine, keyLine);
    const { canonicalRegion } = require(R + 'server/services/regionKey.js');
    const mkKey = new Function('brand', 'loc', 'opts', 'canonicalRegion',
      'const manualLadder = !!(opts && opts.stopAtTier1);\n' + keyLine + '\n return cacheKey;');

    reset();
    await lp.prewarmLadders({ cards: [card('Iron Tribe')], topN: 1 });
    ok('the warm called the resolver once', calls.length === 1, calls.length);
    const warmKey = mkKey(calls[0].brand, calls[0].loc, calls[0].ctx, canonicalRegion);
    // What the CLICK produces, from the payload the browser sends for that card.
    const clickKey = mkKey('Iron Tribe', 'Birmingham, AL', routeCtx, canonicalRegion);
    ok('THE WARM AND THE CLICK RESOLVE TO THE SAME KEY', warmKey === clickKey, { warmKey, clickKey });
    ok('  and it is the manual-ladder key, not the scan one', / \| manual$/.test(warmKey), warmKey);
    ok('  built from the region, so two towns do not share a row',
      warmKey.indexOf('birmingham, al') !== -1, warmKey);
    ok('  and the workflow\'s spelling of the SAME town lands on it too',
      mkKey('Iron Tribe', 'Birmingham, Alabama', routeCtx, canonicalRegion) === clickKey,
      [mkKey('Iron Tribe', 'Birmingham, Alabama', routeCtx, canonicalRegion), clickKey]);
    const otherTown = mkKey('Iron Tribe', 'Nashville, TN', routeCtx, canonicalRegion);
    ok('  a different region is a different key', otherTown !== clickKey, [otherTown, clickKey]);
  }

  console.log('\n-- IT WARMS THE TOP CARDS, IN ORDER, AND ONLY A FEW --');
  {
    reset();
    const cards = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map((b) => card(b));
    await lp.prewarmLadders({ cards });
    ok('three by default, not ten', calls.length === 3, calls.length);
    ok('  and they are the first three', JSON.stringify(calls.map((c) => c.brand)) === '["A","B","C"]',
      calls.map((c) => c.brand));
    ok('the default is stated, not hidden', lp.TOP_N === 3, lp.TOP_N);
  }
  {
    reset();
    await lp.prewarmLadders({ cards: [card('A'), card('B')], topN: 0 });
    ok('topN 0 warms nothing', calls.length === 0, calls.length);
    reset();
    await lp.prewarmLadders({ cards: [] });
    ok('no cards is a no-op', calls.length === 0, calls.length);
  }

  console.log('\n-- IT CANNOT TAKE THE SCAN DOWN --');
  {
    reset();
    THROW = 'places exploded';
    const t = await lp.prewarmLadders({ cards: [card('A')], topN: 1 });
    ok('a throwing resolver is caught', t.failed === 1, t);
    ok('  and reported, not swallowed', t.warmed === 0, t);
  }
  {
    reset();
    let n = 0;
    Module._load = function (req) {
      if (req === '../ai') return {
        MANUAL_SOURCE_ORDER: ['site'],
        deepContactCtx: () => ({ enrichEmail: true, sourceOrder: ['site'], stopAtTier1: true, market: null }),
        getBrandContacts: async (brand) => { n++; if (brand === 'B') throw new Error('one bad brand'); calls.push({ brand }); return LADDER; },
      };
      return origLoad.apply(this, arguments);
    };
    delete require.cache[require.resolve(R + 'server/services/ladderPrewarm.js')];
    const lp2 = require(R + 'server/services/ladderPrewarm.js');
    Module._load = origLoad;
    const t = await lp2.prewarmLadders({ cards: [card('A'), card('B'), card('C')] });
    ok('one dead business does not stop the others', t.warmed === 2 && t.failed === 1, t);
    ok('  all three were attempted', n === 3, n);
  }
  {
    reset();
    const t = await lp.prewarmLadders({ cards: [{ website: 'https://x.com' }], topN: 1 });
    ok('a card with no brand is skipped, not called', calls.length === 0 && t.skipped === 1, [calls.length, t]);
  }

  console.log('\n-- THE LINE SAYS WHETHER IT FOUND ANYONE --');
  {
    reset();
    RESULT = { contacts: [], businessPhone: '(205) 555-0142' };
    const t = await lp.prewarmLadders({ cards: [card('A')], topN: 1 });
    ok('a warm that found nobody is counted as warmed', t.warmed === 1, t);
    ok('  but NOT as having a named person', t.withNames === 0, t);
    reset();
    const t2 = await lp.prewarmLadders({ cards: [card('A')], topN: 1 });
    ok('and one that did is', t2.withNames === 1, t2);
  }

  console.log('\n-- IT IS WIRED AFTER THE RESPONSE, LIKE THE DRAFT PRE-WARM --');
  {
    const scan = SRV.slice(SRV.indexOf("app.post('/api/agent/deal-scan'"), SRV.indexOf("app.post('/api/agent/deal-scan/worked'"));
    const resAt = scan.indexOf('res.json({ opportunities');
    const warmAt = scan.indexOf('prewarmLadders');
    ok('the warm is wired into the scan', warmAt !== -1, null);
    ok('  AFTER res.json, so it cannot slow the scan down', warmAt > resAt, { resAt, warmAt });
    ok('  and it is not awaited', /_ladders\.prewarmLadders\([\s\S]{0,120}\.catch\(/.test(scan), null);
    ok('  inside its own try/catch, so a scan that succeeded cannot fail after',
      /try \{\s*\n\s*const _ladders = require/.test(scan), null);
  }

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
