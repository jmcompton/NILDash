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
// A GUESSED HANDLE IS A DM TO A STRANGER UNDER AN ATHLETE'S NAME.
//
// Today: one fetch of the homepage, first instagram.com link in the HTML wins, no
// check that it belongs to the business. Misses ~40% -- no site, JS-rendered
// footer, bot-blocked -- and can return the web designer's account.
//
// This adds a web-search fallback on a MISS ONLY, so the 60% that already work
// cost nothing extra, and holds both paths to the same two rules:
//
//   CITATION   a searched handle is accepted only when a web-search citation URL
//              is literally instagram.com/<handle> and the path segment EQUALS the
//              handle. No citation, discard, whatever the model claims.
//   ENTITY     no token overlap with the business name  -> drop
//              overlap, business name carries a place the handle lacks -> keep and
//                                                          label as the BRAND account
//              overlap, no place qualifier -> keep as this business's account
//
// server/services/instagramLookup.js is required for real, with ../store stubbed
// (no node_modules here), so the SHIPPED functions run.
const Module = require('module');
const path = require('path');
const R = REPO;
let f = 0;
const ok = (n, c, got) => {
  if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); }
  else console.log('  PASS ' + n);
};

// ── stub ../store so the module loads without pg ─────────────────────────────
const CACHE = new Map();
let cacheReads = 0, cacheWrites = 0;
const storeStub = {
  async getBrandEvidence(key, lane) { cacheReads++; const v = CACHE.get(lane + '|' + key); return v ? { evidence: v, outcome: 'OK' } : null; },
  async saveBrandEvidence(key, lane, brand, site, evidence) { cacheWrites++; CACHE.set(lane + '|' + key, evidence); },
};
const _load = Module._load;
Module._load = function (req, parent, isMain) {
  if (/(^|\/)store$/.test(req) || req === '../store') return storeStub;
  if (req === 'pg') return { Pool: function () {} };
  return _load.apply(this, arguments);
};
const IG = require(R + 'server/services/instagramLookup.js');
Module._load = _load;

const fs = require('fs');
const SRC = fs.readFileSync(R + 'server/services/instagramLookup.js', 'utf8');

// ── fetch stub: what the homepage returns ────────────────────────────────────
let PAGE = null, fetchCalls = 0;
global.fetch = async () => {
  fetchCalls++;
  if (PAGE === null) throw new Error('ECONNREFUSED');
  if (typeof PAGE === 'number') return { ok: false, status: PAGE };
  return { ok: true, status: 200, text: async () => PAGE };
};

// ── web-search stub: what the model + web_search returns ─────────────────────
let SEARCH = null, searchCalls = 0;
const webSearch = async () => {
  searchCalls++;
  if (!SEARCH) throw new Error('search failed');
  return SEARCH;
};
const reset = () => { fetchCalls = 0; searchCalls = 0; CACHE.clear(); cacheWrites = 0; };
const answer = (obj, citations) => ({ text: JSON.stringify(obj), citations: citations || [], searches: 1, outTokens: 40, apiMs: 10 });

const OPTS = (brand, loc) => ({ brand, loc, webSearch });

(async () => {
  console.log('-- THE SCRAPE STILL RUNS FIRST, AND A HIT COSTS NOTHING --');
  {
    reset();
    PAGE = '<footer><a href="https://instagram.com/sawsbbq">IG</a></footer>';
    SEARCH = answer({ handle: 'shouldnotbeused' }, ['https://www.instagram.com/shouldnotbeused']);
    const out = await IG.findInstagram('https://sawsbbq.example', OPTS("Saw's BBQ", 'Birmingham, AL'));
    ok('the scraped handle is returned', out && out.handle === 'sawsbbq', out);
    ok('  no web search was run', searchCalls === 0, { searchCalls });
    ok('  and it is marked as coming from the site', out && out.source === 'site', out);
  }

  console.log('\n-- ON A MISS IT SEARCHES, AND THE CITATION RULE DECIDES --');
  {
    reset();
    PAGE = '<html><body>no socials here</body></html>';
    SEARCH = answer({ handle: 'sawsbbq' }, ['https://www.instagram.com/sawsbbq/']);
    const out = await IG.findInstagram('https://sawsbbq.example', OPTS("Saw's BBQ", 'Birmingham, AL'));
    ok('a CITED handle is accepted', out && out.handle === 'sawsbbq', out);
    ok('  exactly one search was run', searchCalls === 1, { searchCalls });
    ok('  and it is marked as coming from search', out && out.source === 'search', out);
  }
  {
    reset();
    PAGE = '<html>nothing</html>';
    SEARCH = answer({ handle: 'sawsbbq' }, []);                    // model asserts, cites nothing
    const out = await IG.findInstagram('https://sawsbbq.example', OPTS("Saw's BBQ", 'Birmingham, AL'));
    ok('an UNCITED handle is discarded however confident the model is', out === null || !out.handle, out);
  }
  {
    reset();
    PAGE = '<html>nothing</html>';
    SEARCH = answer({ handle: 'sawsbbq' }, ['https://www.instagram.com/someoneelse/']);
    const out = await IG.findInstagram('https://sawsbbq.example', OPTS("Saw's BBQ", 'Birmingham, AL'));
    ok('a citation for a DIFFERENT handle does not vouch for it', out === null || !out.handle, out);
  }
  {
    reset();
    PAGE = '<html>nothing</html>';
    SEARCH = answer({ handle: 'sawsbbq' }, ['https://www.instagram.com/p/CxYz123/']);
    const out = await IG.findInstagram('https://sawsbbq.example', OPTS("Saw's BBQ", 'Birmingham, AL'));
    ok('a POST url is not a profile citation', out === null || !out.handle, out);
  }
  {
    reset();
    PAGE = '<html>nothing</html>';
    SEARCH = answer({ handle: 'SawsBBQ' }, ['https://instagram.com/sawsbbq']);
    const out = await IG.findInstagram('https://sawsbbq.example', OPTS("Saw's BBQ", 'Birmingham, AL'));
    ok('the match is case-insensitive', out && out.handle === 'sawsbbq', out);
  }

  console.log('\n-- THE ENTITY RULES, ON YOUR THREE REAL CASES --');
  {
    reset();
    PAGE = '<html>nothing</html>';
    SEARCH = answer({ handle: 'manaclinics' }, ['https://www.instagram.com/manaclinics/']);
    const out = await IG.findInstagram('https://millenniumchiro.example',
      OPTS('Millennium Chiropractic and Rehab', 'Fayetteville, AR'));
    ok('@manaclinics is dropped: no token overlap with Millennium', out === null || !out.handle, out);
  }
  {
    reset();
    PAGE = '<html>nothing</html>';
    SEARCH = answer({ handle: 'rally_house' }, ['https://www.instagram.com/rally_house/']);
    const out = await IG.findInstagram('https://rallyhouse.example',
      OPTS('Rally House Fayetteville', 'Fayetteville, AR'));
    ok('@rally_house is KEPT, not dropped', out && out.handle === 'rally_house', out);
    ok('  but labelled as the brand account, not this location', out && out.scope === 'brand', out);
  }
  {
    reset();
    PAGE = '<html>nothing</html>';
    SEARCH = answer({ handle: 'sawsbbq' }, ['https://www.instagram.com/sawsbbq/']);
    const out = await IG.findInstagram('https://sawsbbq.example', OPTS("Saw's BBQ", 'Birmingham, AL'));
    ok('a local business handle is scoped to the business', out && out.scope === 'business', out);
  }

  console.log('\n-- THE SAME OWNERSHIP TEST APPLIES TO THE SCRAPE --');
  {
    reset();
    // The web designer's account appears BEFORE the business's in the footer.
    PAGE = '<a href="https://instagram.com/pixelcraftstudio">site by</a>'
         + '<a href="https://instagram.com/sawsbbq">follow us</a>';
    SEARCH = null;
    const out = await IG.findInstagram('https://sawsbbq.example', OPTS("Saw's BBQ", 'Birmingham, AL'));
    ok('the FIRST link is skipped when it is not the business', out && out.handle === 'sawsbbq', out);
  }
  {
    reset();
    PAGE = '<a href="https://instagram.com/pixelcraftstudio">site by</a>';
    SEARCH = answer({ handle: 'sawsbbq' }, ['https://www.instagram.com/sawsbbq/']);
    const out = await IG.findInstagram('https://sawsbbq.example', OPTS("Saw's BBQ", 'Birmingham, AL'));
    ok('a page with ONLY a foreign handle counts as a miss', out && out.source === 'search', out);
    ok('  so the search still runs', searchCalls === 1, { searchCalls });
  }
  {
    reset();
    PAGE = '<a href="https://instagram.com/p/abc">post</a><a href="https://instagram.com/sawsbbq">us</a>';
    SEARCH = null;
    const out = await IG.findInstagram('https://sawsbbq.example', OPTS("Saw's BBQ", 'Birmingham, AL'));
    ok('post and reel paths are still skipped', out && out.handle === 'sawsbbq', out);
  }

  console.log('\n-- THE BIO, HONESTLY LABELLED, UNDER THE SAME CITATION RULE --');
  {
    reset();
    PAGE = '<html>nothing</html>';
    SEARCH = answer({
      handle: 'natstateaesthetics', ownerName: 'Dawn Mercer', bookingEmail: 'book@natstate.example',
      bioText: 'Owner Dawn Mercer | Book: book@natstate.example',
    }, ['https://www.instagram.com/natstateaesthetics/']);
    const out = await IG.findInstagram('https://natstate.example',
      OPTS('Natural State Aesthetics', 'Fayetteville, AR'));
    ok('the bio owner comes back', out && out.ownerName === 'Dawn Mercer', out);
    ok('  with the booking email', out && out.bookingEmail === 'book@natstate.example', out);
    ok('  labelled bio-derived, NOT published on the site', out && out.evidenceKind === 'bio', out);
  }
  {
    reset();
    PAGE = '<html>nothing</html>';
    SEARCH = answer({ handle: 'natstateaesthetics', ownerName: 'Dawn Mercer' }, []);
    const out = await IG.findInstagram('https://natstate.example', OPTS('Natural State Aesthetics', 'Fayetteville, AR'));
    ok('an uncited bio yields no owner at all', !out || !out.ownerName, out);
  }

  console.log('\n-- FAILURE MODES STAY SAFE --');
  {
    reset(); PAGE = null; SEARCH = answer({ handle: 'sawsbbq' }, ['https://www.instagram.com/sawsbbq/']);
    const out = await IG.findInstagram('https://sawsbbq.example', OPTS("Saw's BBQ", 'Birmingham, AL'));
    ok('a dead site still reaches the search', out && out.handle === 'sawsbbq', out);
    reset(); PAGE = 403; SEARCH = answer({ handle: 'sawsbbq' }, ['https://www.instagram.com/sawsbbq/']);
    const out2 = await IG.findInstagram('https://sawsbbq.example', OPTS("Saw's BBQ", 'Birmingham, AL'));
    ok('a bot-blocked site still reaches the search', out2 && out2.handle === 'sawsbbq', out2);
    reset(); PAGE = '<html>nothing</html>'; SEARCH = null;
    const out3 = await IG.findInstagram('https://sawsbbq.example', OPTS("Saw's BBQ", 'Birmingham, AL'));
    ok('a thrown search returns null, never a guess', out3 === null || !out3.handle, out3);
    reset(); PAGE = '<html>nothing</html>'; SEARCH = answer({ handle: 'sawsbbq' }, ['https://www.instagram.com/sawsbbq/']);
    const out4 = await IG.findInstagram('https://sawsbbq.example', {});
    ok('no brand and no webSearch means no search, and no crash', searchCalls === 0 && (out4 === null || !out4.handle), { searchCalls, out4 });
  }

  console.log('\n-- CACHING --');
  {
    reset();
    PAGE = '<html>nothing</html>';
    SEARCH = answer({ handle: 'sawsbbq' }, ['https://www.instagram.com/sawsbbq/']);
    await IG.findInstagram('https://sawsbbq.example', OPTS("Saw's BBQ", 'Birmingham, AL'));
    const before = searchCalls;
    const again = await IG.findInstagram('https://sawsbbq.example', OPTS("Saw's BBQ", 'Birmingham, AL'));
    ok('a second lookup is served from cache', searchCalls === before, { before, now: searchCalls });
    ok('  with the scope preserved', again && again.scope === 'business', again);
    ok('the cache key carries a version so pre-check rows are a miss',
      /CACHE_V|_V2|v2/.test(SRC) && /CACHE_V/.test(SRC), (SRC.match(/const CACHE_V.*/) || [])[0]);
  }

  console.log('\n-- THE LADDER LABELS A BRAND ACCOUNT --');
  {
    const { buildContactLadder } = require(R + 'server/services/contactLadder');
    const mk = (extra) => buildContactLadder(Object.assign({ contacts: [], businessPhone: '(479) 521-6340' }, extra),
      { rankOf: () => 7, rootDomain: (u) => String(u || ''), category: null, brand: 'X' });

    const brandL = mk({ instagram: 'rally_house', instagramScope: 'brand' });
    const t3 = (brandL.tiers.find((t) => t.tier === 3) || { rows: [] }).rows;
    const igRow = t3.find((r) => r.channel === 'instagram');
    ok('the brand account is still offered', !!igRow, t3);
    ok('  titled as the national brand, not this location',
      igRow && /national|brand/i.test(igRow.title || ''), igRow && igRow.title);
    ok('  the note says a DM reaches corporate, not the store',
      igRow && /not this location|corporate|head office/i.test(igRow.sourceNote || ''), igRow && igRow.sourceNote);
    ok('  and it is not dressed up as a confident local channel',
      igRow && igRow.confidence === 'Fallback', igRow && igRow.confidence);

    const bizL = mk({ instagram: 'sawsbbq', instagramScope: 'business' });
    const bizRow = (bizL.tiers.find((t) => t.tier === 3) || { rows: [] }).rows.find((r) => r.channel === 'instagram');
    ok('a business account is unchanged', bizRow && /Business Instagram/i.test(bizRow.title || ''), bizRow && bizRow.title);
    ok('  and keeps its Likely confidence', bizRow && bizRow.confidence === 'Likely', bizRow && bizRow.confidence);

    const legacy = mk({ instagram: 'sawsbbq' });   // no scope: a cached row
    const legacyRow = (legacy.tiers.find((t) => t.tier === 3) || { rows: [] }).rows.find((r) => r.channel === 'instagram');
    ok('a handle with no scope behaves exactly as before', legacyRow && /Business Instagram/i.test(legacyRow.title || ''), legacyRow && legacyRow.title);
  }

  console.log('\n-- EVERY CALLER GETS A STRING HANDLE, NOT THE RECORD --');
  {
    // findInstagram returns a record now. The DM endpoint used to forward its
    // return value straight to the client, which concatenates it into a URL --
    // handing back the record rendered "instagram.com/[object Object]".
    const IDX = fs.readFileSync(R + 'server/index.js', 'utf8');
    const ep = IDX.slice(IDX.indexOf("app.post('/api/agent/brand-instagram'"), IDX.indexOf("app.post('/api/athlete/brand-contacts'"));
    ok('the DM endpoint unwraps .handle', /handle: \(out && out\.handle\) \|\| null/.test(ep), ep.match(/res\.json\(.*/));
    ok('  and passes the brand through so the ownership test can run',
      /findInstagram\(website, brand/.test(ep), (ep.match(/findInstagram\(.*/) || [])[0]);
    const OE = fs.readFileSync(R + 'public/outreach-engine.js', 'utf8');
    ok('  the client sends a brand', /brand-instagram[\s\S]{0,400}brand: brand/.test(OE));
    ok('  and says when the handle is the brand account',
      /scope === 'brand'[\s\S]{0,60}Open brand @/.test(OE));
    // ai.js must hand the ladder the scope, or the label never renders.
    const AI = fs.readFileSync(R + 'server/ai.js', 'utf8');
    ok('ai.js sets instagramScope on the result', /res\.instagramScope = ig\.scope/.test(AI));
    ok('  and returns it from getBrandContacts', /instagramScope: res\.instagramScope/.test(AI));
    ok('  and passes brand + webSearch into the lookup',
      /findInstagram\(effectiveWebsite, \{[\s\S]{0,120}webSearch: _contactWebSearchRaw/.test(AI));
    ok('  a bio-derived owner is scoped unclear, never Tier 1',
      /source: 'instagram',[\s\S]{0,80}affiliationScope: 'unclear'/.test(AI));
    ok('  and a bio address is never labelled published',
      /emailSource: _bioEmail \? 'bio' : null/.test(AI));
  }

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => {
  console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 5).join('\n'));
  console.log('\nfailures: ' + (f + 1));
  process.exit(1);
});
