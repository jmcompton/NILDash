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
// A HANDLE FOR A BUSINESS WITH NO WEBSITE.
//
// findInstagram opened with `if (!website) return null`, so a business whose
// domain never resolved was never asked about. No handle means buildCard falls
// through to `call`, which is most of a local slate. The search half of that
// file never needed a domain — it was simply unreachable.
//
// The real findInstagram is driven here. Only the web search is stubbed, so the
// ownership test, the citation rule, the cache and the keying are all shipped code.
const fs = require('fs');
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const IG = require(ROOT + 'server/services/instagramLookup.js');
const Q = require(ROOT + 'server/services/outreachQueue.js');

const out = [];
const check = (n, c, d) => { out.push({ n, ok: !!c }); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d !== undefined ? '   ' + d : '')); };

// A search that answers with a handle and a real profile citation, the shape the
// citation rule demands.
let searches = [];
const searchOk = (handle) => async (prompt) => {
  searches.push(prompt);
  return { text: JSON.stringify({ handle, ownerName: null, bookingEmail: null, bioText: null }),
    citations: ['https://www.instagram.com/' + handle + '/'] };
};
// A model that invents a plausible handle and cites nothing.
const searchUncited = (handle) => async (prompt) => {
  searches.push(prompt);
  return { text: JSON.stringify({ handle }), citations: ['https://example.com/about'] };
};

async function clear(P) {
  await P.query(`DELETE FROM brand_evidence_cache WHERE lane = 'instagram' AND brand_key LIKE '%ignl%'`).catch(() => {});
  await P.query(`DELETE FROM brand_evidence_cache WHERE lane = 'instagram' AND brand_key LIKE 'name:%'`).catch(() => {});
}

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await clear(P);

  console.log('\n1. NO DOMAIN, AND IT STILL FINDS THE HANDLE');
  searches = [];
  const r1 = await IG.findInstagram(null, {
    brand: 'Ignl Coffee Roasters', loc: 'Birmingham, AL', webSearch: searchOk('ignlcoffee'),
  });
  check('a handle comes back with no website at all', !!(r1 && r1.handle === 'ignlcoffee'), JSON.stringify(r1));
  check('  and it says it came from the search', r1 && r1.source === 'search', r1 && r1.source);
  check('  scoped as this business, so it is DM-able', r1 && r1.scope === 'business', r1 && r1.scope);
  check('exactly one search was spent', searches.length === 1, searches.length);
  check('  and it asked by name AND city',
    /Ignl Coffee Roasters/.test(searches[0]) && /Birmingham/.test(searches[0]));

  console.log('\n2. IT IS CACHED UNDER A NAME KEY, NOT A DOMAIN KEY');
  const rows = (await P.query(
    `SELECT brand_key, brand, outcome FROM brand_evidence_cache
      WHERE lane = 'instagram' AND brand_key LIKE 'name:%'`)).rows;
  check('a name-keyed row was written', rows.length === 1, JSON.stringify(rows));
  check('  keyed on the squashed name and city',
    rows[0] && /^name:ignlcofferoasters@birmingham \| v2$/.test(rows[0].brand_key)
      || (rows[0] && /^name:ignlcoffeeroasters@birmingham \| v2$/.test(rows[0].brand_key)),
    rows[0] && rows[0].brand_key);
  check('  and the brand is readable in the row', rows[0] && rows[0].brand === 'Ignl Coffee Roasters',
    rows[0] && rows[0].brand);

  searches = [];
  const again = await IG.findInstagram(null, {
    brand: 'Ignl Coffee Roasters', loc: 'Birmingham, AL', webSearch: searchOk('ignlcoffee'),
  });
  check('the second call is served from cache', again && again.handle === 'ignlcoffee');
  check('  and spends NO search', searches.length === 0, searches.length);

  console.log('\n3. THE RULES DID NOT RELAX ON THE NEW PATH');
  searches = [];
  const uncited = await IG.findInstagram(null, {
    brand: 'Ignl Bakery', loc: 'Hoover, AL', webSearch: searchUncited('ignlbakery'),
  });
  check('an UNCITED handle is discarded, however plausible', uncited === null, JSON.stringify(uncited));

  searches = [];
  const wrong = await IG.findInstagram(null, {
    brand: 'Ignl Chiropractic', loc: 'Hoover, AL', webSearch: searchOk('manaclinics'),
  });
  check('a handle for a different entity is rejected', wrong === null, JSON.stringify(wrong));

  searches = [];
  const national = await IG.findInstagram(null, {
    brand: 'Rally House Ignlville', loc: 'Ignlville, AR', webSearch: searchOk('rally_house'),
  });
  check('a national account is kept but LABELLED brand, not DM-able',
    national && national.handle === 'rally_house' && national.scope === 'brand',
    JSON.stringify(national));

  console.log('\n4. NOTHING TO ASK WITH IS STILL NOTHING');
  check('no website and no brand returns null',
    (await IG.findInstagram(null, { webSearch: searchOk('x') })) === null);
  check('no website and no searcher returns null',
    (await IG.findInstagram(null, { brand: 'Ignl Nowhere' })) === null);

  console.log('\n5. THE DOMAIN PATH IS UNCHANGED');
  // The domain key must stay byte-identical or every existing row is orphaned.
  const SRC = fs.readFileSync(ROOT + 'server/services/instagramLookup.js', 'utf8');
  check('the domain cache key is untouched',
    /function _cacheKey\(domain\) \{ return domain \+ ' \| ' \+ CACHE_V; \}/.test(SRC));
  check('the cache version was NOT bumped, so no existing row is invalidated',
    /const CACHE_V = 'v2';/.test(SRC));
  searches = [];
  const withSite = await IG.findInstagram('https://ignl-nosuchdomain-xyz.test', {
    brand: 'Ignl Site Co', loc: 'Birmingham, AL', webSearch: searchOk('ignlsiteco'),
  });
  check('a site that cannot be fetched still falls through to the search',
    withSite && withSite.handle === 'ignlsiteco', JSON.stringify(withSite));
  const domRow = (await P.query(
    `SELECT brand_key FROM brand_evidence_cache
      WHERE lane='instagram' AND brand_key LIKE 'ignl-nosuchdomain%'`)).rows;
  check('  and is cached under the DOMAIN key, not the name key',
    domRow.length === 1, JSON.stringify(domRow.map((r) => r.brand_key)));

  console.log('\n6. WHAT THIS DOES TO THE CARD');
  // buildCard is what turns a handle into a channel. Same shipped function.
  const ladder = { mainLine: { phone: '205-555-0100' }, tiers: [] };
  const noHandle = Q.buildCard({ brand: 'Ignl Coffee Roasters' }, ladder, { instagram: null });
  check('no handle => the card is a CALL', noHandle.channel === 'call', noHandle.channel);
  const withHandle = Q.buildCard({ brand: 'Ignl Coffee Roasters' }, ladder,
    { instagram: 'ignlcoffee', instagramScope: 'business' });
  check('a handle => the card is a DM', withHandle.channel === 'dm', withHandle.channel);
  check('  and it carries a message to send', !!withHandle.dmText, withHandle.dmText);
  check('  with the phone still on the card as a fallback',
    withHandle.phone === '205-555-0100', withHandle.phone);
  const brandScoped = Q.buildCard({ brand: 'Rally House Ignlville' }, ladder,
    { instagram: 'rally_house', instagramScope: 'brand' });
  check('a national account does NOT become a DM', brandScoped.channel === 'call', brandScoped.channel);
  check('  but the handle is still shown on the card', brandScoped.instagram === 'rally_house');

  console.log('\n7. THE CALLER NO LONGER GATES ON A DOMAIN');
  const AISRC = fs.readFileSync(ROOT + 'server/ai.js', 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('ai.js calls the lookup without a resolved website',
    /if \(_deep && \(effectiveWebsite \|\| brand\)\)/.test(AISRC));
  check('  and no longer requires one', !/if \(_deep && effectiveWebsite\)/.test(AISRC));

  await clear(P);
  const failed = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - failed.length) + '/' + out.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
