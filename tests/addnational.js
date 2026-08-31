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
// POST /api/agent/deal-scan/add-national, end to end against real Postgres.
// socialProof and ai are stubbed at the module loader, so no network and no
// model call happens. The point of the suite is the four claims:
//   a. an indexed brand comes back with its program page, deal terms and tier
//   b. an unindexed brand is RESEARCHED and inserted, not resolved to a storefront
//   c. placesLookup is never loaded by this route, for any input
//   d. a brand with no verifiable program page is an honest miss, not a storefront
process.env.NODE_ENV = 'test';
// No DATABASE_URL: the pool then reads PG* and skips SSL, which the local
// test server does not speak.
process.env.SESSION_SECRET = 'test';

const Module = require('module');
const path = require('path');
const fs = require('fs');
const ROOT = REPO;

// ── Loader stubs ─────────────────────────────────────────────────────────────
let PLACES_LOADED = false;         // (c): tripwire
let SEARCH_CALLS = [];             // what the route asked the web for
let PROGRAM_CALLS = [];
let SUMMARIZE_CALLS = [];
let SITE_FOR = {};                 // brand -> homepage the search "finds"
let PROGRAM_FOR = {};              // site   -> findProgramUrl result

// pitchRoute/probeSite fetch the real web. Stub global fetch for those hosts,
// and let 127.0.0.1 (the test server itself) through untouched.
const SITES = {};
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  const u = String(url);
  if (/^http:\/\/127\.0\.0\.1/.test(u)) return realFetch(url, init);
  if (/fortress\.example/.test(u)) return { ok: false, status: 403, headers: { get: () => 'text/html' }, text: async () => '' };
  if (/ghost\.example/.test(u)) throw new Error('getaddrinfo ENOTFOUND ghost.example');
  const body = SITES[u];
  if (body === undefined) return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '' };
  return { ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => body };
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const from = parent && parent.filename ? parent.filename : '';
  if (/placesLookup/.test(request)) { PLACES_LOADED = true; }
  // Relative requires in the lifted route resolve against THIS file. Redirect
  // the real modules to their true paths -- pitchRoute is exercised for real.
  if (/services\/pitchRoute/.test(request)) return realLoad(ROOT + 'server/services/pitchRoute.js', parent, isMain);
  if (/services\/socialProof/.test(request)) {
    return {
      SIGNALS: [],
      verifySocialProof: async () => ({ ok: false }),
      findProgramUrl: async (site) => { PROGRAM_CALLS.push(site); return PROGRAM_FOR[site] || null; },
      summarizeProgram: async (text) => { SUMMARIZE_CALLS.push(text); return { summary: 'Ambassadors get a code and 15% commission.', size: 'national' }; },
    };
  }
  return realLoad.apply(this, arguments);
};

const store = require(ROOT + 'server/store.js');
const ai = require(ROOT + 'server/ai.js');
// Stub the one AI call the route makes (official homepage lookup).
ai.oneShotWebSearch = async (prompt) => {
  SEARCH_CALLS.push(prompt);
  const m = prompt.match(/company "([^"]+)"/);
  const brand = m ? m[1] : '';
  return SITE_FOR[brand] || 'NONE';
};

const express = require('express');
const app = express();
app.use(express.json());

// ── Lift the route out of index.js and run it in a bare app ──────────────────
const SRC = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
const START = SRC.indexOf("app.post('/api/agent/deal-scan/add-national'");
const END = SRC.indexOf("app.post('/api/agent/deal-scan/add-business'");
if (START < 0 || END < 0 || END < START) { console.error('could not slice the route'); process.exit(1); }
const ROUTE_SRC = SRC.slice(START, END);

let SESSION_USER = null;
const requireAuth = (req, res, next) => { req.session = { userId: SESSION_USER }; next(); };
const requireAgentSubscription = (req, res, next) => next();
const aiLimiter = (req, res, next) => next();
const isFounderEmail = () => false;
let RATE_OK = true;
const _manualAddRateCheck = () => (RATE_OK ? { ok: true } : { ok: false, scope: 'agent', limit: 25 });
// The real helper, pulled from index.js by the same slice trick.
const LS = SRC.indexOf('async function loadDealScanAthlete(athleteId) {');
const LE = SRC.indexOf("// POST /api/athlete/deal-scan —", LS);
const LOADER_SRC = SRC.slice(LS, LE);

eval(LOADER_SRC + '\n' + ROUTE_SRC);

// ── Fixtures ─────────────────────────────────────────────────────────────────
const http = require('http');
let server, PORT;
async function post(body) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/agent/deal-scan/add-national`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

const AGENT = '00000000-0000-0000-0000-0000000000a1';
const OTHER = '00000000-0000-0000-0000-0000000000a2';
const ATH = '00000000-0000-0000-0000-0000000000b1';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS)); // let store.init() finish

  await store.pool.query(`DELETE FROM social_brands WHERE brand IN ('Gymshark','Red Bull','Nocco','Blank Brand','Gatorade','Silent Co','Fortress','Ghost Corp')`);
  await store.pool.query(`DELETE FROM brand_evidence_cache WHERE lane='natsearch'`);
  await store.pool.query(`DELETE FROM athletes WHERE id=$1`, [ATH]);
  await store.pool.query(`DELETE FROM users WHERE id IN ($1,$2)`, [AGENT, OTHER]);
  await store.pool.query(
    `INSERT INTO users (id, email, password, name, role) VALUES ($1,$2,'x','Test Agent','agent'),($3,$4,'x','Other','agent')`,
    [AGENT, 'a1@test.local', OTHER, 'a2@test.local']);
  await store.pool.query(
    `INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3::jsonb)`,
    [ATH, AGENT, JSON.stringify({ name: 'Jane Doe', sport: 'Softball', school: 'Auburn', instagram: 40000, tiktok: 20000 })]);

  // An indexed brand with everything the customer asked to see on the card.
  await store.pool.query(
    `INSERT INTO social_brands (brand, category, website, sports, tier_min, tier_max, deal_structure,
       est_low, est_high, cadence_note, proof_url, proof_date, offer_summary, brand_size, tier_stated, active)
     VALUES ('Gymshark','apparel','https://gymshark.com',ARRAY['softball','all']::text[],10000,100000,'cash_code',
       500,2000,'Quarterly drops','https://gymshark.com/pages/athletes',CURRENT_DATE,
       'Gymshark Athletes get product plus a paid quarterly campaign.','national',true,true)`);

  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
  SESSION_USER = AGENT;

  // ── (a) index hit ──────────────────────────────────────────────────────────
  PLACES_LOADED = false; PROGRAM_CALLS = []; SEARCH_CALLS = [];
  let r = await post({ athleteId: ATH, brand: 'gymshark' });
  ok('(a) an indexed brand is found', r.status === 200 && r.body.found === true, r.body);
  ok('    marked as coming from the index, not researched', r.body.card && r.body.source === 'index', r.body.source);
  ok('    carrying the program page', r.body.card && /pages\/athletes/.test(r.body.card.proof_url || ''), r.body.card && r.body.card.proof_url);
  ok('    the deal terms', r.body.card && r.body.card.deal_structure === 'cash_code' && r.body.card.est_low === 500, r.body.card && r.body.card.deal_structure);
  ok('    and the tier band', r.body.card && r.body.card.tier_min === 10000 && r.body.card.tier_max === 100000, r.body.card && [r.body.card.tier_min, r.body.card.tier_max]);
  ok('    an index hit costs NO web search', SEARCH_CALLS.length === 0, SEARCH_CALLS.length);
  ok('    and no program-page fetch', PROGRAM_CALLS.length === 0, PROGRAM_CALLS.length);

  // ── (e) fit is scored against the SELECTED athlete ─────────────────────────
  ok('(e) the card is scored against the selected athlete', typeof r.body.card.fitScore === 'number', r.body.card.fitScore);
  ok('    60k combined reach sits inside the 10k-100k band', /inside their stated tier/.test((r.body.card.fitWhy || []).join(' ')), r.body.card.fitWhy);
  ok('    and the sport match is named', /softball/i.test((r.body.card.fitWhy || []).join(' ')), r.body.card.fitWhy);
  const fitJane = r.body.card.fitScore;

  // Same brand, a much smaller athlete -> a lower score, so the number means something.
  const SMALL = '00000000-0000-0000-0000-0000000000b2';
  await store.pool.query(`DELETE FROM athletes WHERE id=$1`, [SMALL]);
  await store.pool.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3::jsonb)`,
    [SMALL, AGENT, JSON.stringify({ name: 'Small Fry', sport: 'Golf', school: 'Auburn', instagram: 400, tiktok: 100 })]);
  const rs = await post({ athleteId: SMALL, brand: 'gymshark' });
  ok('    a 500-follower athlete scores LOWER on the same brand', rs.body.card.fitScore < fitJane, [rs.body.card.fitScore, fitJane]);
  ok('    and is told why', /starts around/.test((rs.body.card.fitWhy || []).join(' ')), rs.body.card.fitWhy);

  // ── (b) not indexed, HAS a program page -> open-program card ──────────────
  SITE_FOR['Red Bull'] = 'https://www.redbull.com';
  PROGRAM_FOR['https://www.redbull.com'] = {
    url: 'https://www.redbull.com/us-en/athletes/apply', via: 'link',
    snippet: 'We sign athletes across every sport.', tierStated: false,
    pageText: 'Red Bull athlete program. Apply to be a Red Bull athlete.',
  };
  PLACES_LOADED = false; PROGRAM_CALLS = []; SUMMARIZE_CALLS = [];
  r = await post({ athleteId: ATH, brand: 'Red Bull' });
  ok('(b) an unindexed brand is researched, not rejected', r.status === 200 && r.body.found === true, r.body);
  ok('    and labelled as researched just now', r.body.source === 'researched', r.body.source);
  ok('    the SAME verify gate ran (findProgramUrl)', PROGRAM_CALLS.length === 1, PROGRAM_CALLS);
  ok('    against the site the web search returned', PROGRAM_CALLS[0] === 'https://www.redbull.com', PROGRAM_CALLS[0]);
  ok('    a program page found -> state open-program', r.body.card.programState === 'open-program', r.body.card.programState);
  ok('    the page was summarised', SUMMARIZE_CALLS.length === 1, SUMMARIZE_CALLS.length);
  ok('    the card comes back scored', typeof r.body.card.fitScore === 'number', r.body.card);
  ok('    and is marked NOT index-grade verified', r.body.card.verified === false, r.body.card.verified);

  // THE HARD CONSTRAINT: a search result never lands in social_brands.
  let ins = await store.pool.query(`SELECT 1 FROM social_brands WHERE brand='Red Bull'`);
  ok('    NOTHING was written to social_brands', ins.rows.length === 0, ins.rows.length);
  const cacheRow = await store.pool.query(`SELECT * FROM brand_evidence_cache WHERE lane='natsearch' AND brand_key='red bull'`);
  ok('    it was cached instead, in its own lane', cacheRow.rows.length === 1, cacheRow.rows.length);

  // Searching it again is served from cache -- free, no second research spend.
  SEARCH_CALLS = []; PROGRAM_CALLS = [];
  const again = await post({ athleteId: ATH, brand: 'Red Bull' });
  ok('    searching it a SECOND time is served from cache', again.body.cached === true, again.body);
  ok('    costing no further web search', SEARCH_CALLS.length === 0 && PROGRAM_CALLS.length === 0, [SEARCH_CALLS.length, PROGRAM_CALLS.length]);
  ok('    and still not in the index', (await store.pool.query(`SELECT 1 FROM social_brands WHERE brand='Red Bull'`)).rows.length === 0);

  // ── (b2) THE REGRESSION: no program page is NOT a decline ────────────────
  // Gatorade's shape -- a real company, no public application form, a
  // partnerships desk reachable from the site.
  SITE_FOR['Gatorade'] = 'https://www.gatorade.com';
  PROGRAM_FOR['https://www.gatorade.com'] = null;      // the gate says no
  SITES['https://www.gatorade.com/'] = `<html><a href="/partnerships">Partnerships</a></html>`;
  SITES['https://www.gatorade.com/partnerships'] = `<html><a href="mailto:partnerships@gatorade.com">Pitch us</a></html>`;
  r = await post({ athleteId: ATH, brand: 'Gatorade' });
  ok('(b2) NO application page still returns a CARD', r.status === 200 && r.body.found === true, r.body);
  ok('     marked direct-pitch', r.body.card.programState === 'direct-pitch', r.body.card.programState);
  ok('     with the partnerships address surfaced', r.body.card.contactEmail === 'partnerships@gatorade.com', r.body.card.contactEmail);
  ok('     typed so the card can label it', r.body.card.contactType === 'partnerships', r.body.card.contactType);
  ok('     the partnerships page linked', /\/partnerships$/.test(r.body.card.partnershipsUrl || ''), r.body.card.partnershipsUrl);
  ok('     and a next step in plain words', /pitch/i.test(r.body.card.nextStep || ''), r.body.card.nextStep);
  ok('     no proof_url invented for a brand with no program page', r.body.card.proof_url === null, r.body.card.proof_url);
  ok('     still nothing written to social_brands', (await store.pool.query(`SELECT 1 FROM social_brands WHERE brand='Gatorade'`)).rows.length === 0);

  // Real company, nothing findable -> unknown, still a card.
  SITE_FOR['Silent Co'] = 'https://silentco.com';
  PROGRAM_FOR['https://silentco.com'] = null;
  SITES['https://silentco.com/'] = `<html><body>We make things.</body></html>`;
  r = await post({ athleteId: ATH, brand: 'Silent Co' });
  ok('(b3) a real company with no route STILL returns a card', r.body.found === true, r.body);
  ok('     marked unknown', r.body.card.programState === 'unknown', r.body.card.programState);
  ok('     and the copy says the company is real', /real company/i.test(r.body.card.nextStep || ''), r.body.card.nextStep);

  // A brand behind bot protection: 403 everywhere. Still a card.
  SITE_FOR['Fortress'] = 'https://fortress.example';
  PROGRAM_FOR['https://fortress.example'] = null;
  r = await post({ athleteId: ATH, brand: 'Fortress' });
  ok('(b4) a brand whose site 403s is NOT declined', r.body.found === true, r.body);
  ok('     it is a real company we simply cannot read', r.body.card.programState === 'unknown', r.body.card.programState);

  // ── (d) the ONLY decline: the company cannot be verified to exist ─────────
  r = await post({ athleteId: ATH, brand: 'Blank Brand' });
  ok('(d) a brand with no findable website is declined', r.body.found === false, r.body);
  ok('    with cannot-verify as the reason', r.body.reason === 'cannot-verify', r.body.reason);
  ok('    and the copy tells the agent what to try', /spelling|legal name|Local tab/i.test(r.body.message || ''), r.body.message);
  ok('    the copy does NOT explain our indexing policy', !/index/i.test(r.body.message || ''), r.body.message);

  SITE_FOR['Ghost Corp'] = 'https://ghost.example';
  r = await post({ athleteId: ATH, brand: 'Ghost Corp' });
  ok('    a domain that does not resolve is declined too', r.body.found === false && r.body.reason === 'cannot-verify', r.body);
  ok('    naming dns as the reason', /dns/i.test(r.body.message || ''), r.body.message);

  // ── (c) placesLookup is never reached, on ANY path ────────────────────────
  ok('(c) placesLookup was NEVER loaded by this route', PLACES_LOADED === false, PLACES_LOADED);
  ok('    and the route source does not mention it', !/placesLookup/.test(ROUTE_SRC), (ROUTE_SRC.match(/places\w*/gi) || []));

  // ── Guards ────────────────────────────────────────────────────────────────
  r = await post({ athleteId: ATH, brand: '' });
  ok('empty brand -> 400', r.status === 400, r);
  r = await post({ brand: 'Gymshark' });
  ok('missing athleteId -> 400, no guessing which athlete', r.status === 400, r);
  r = await post({ athleteId: ATH, brand: 'x'.repeat(200) });
  ok('an absurdly long brand is refused before any spend', r.status === 400, r);
  r = await post({ athleteId: '00000000-0000-0000-0000-00000000ffff', brand: 'Gymshark' });
  ok('an unknown athlete -> 404', r.status === 404, r);
  SESSION_USER = OTHER;
  r = await post({ athleteId: ATH, brand: 'Gymshark' });
  ok("another agent cannot search against someone else's athlete", r.status === 403, r);
  SESSION_USER = AGENT;

  // Rate backstop applies to RESEARCH only, never to a free index hit.
  RATE_OK = false;
  r = await post({ athleteId: ATH, brand: 'Gymshark' });
  ok('at the daily cap an INDEX HIT still works (it costs nothing)', r.status === 200 && r.body.found === true, r.status);
  SITE_FOR['Nocco'] = 'https://nocco.com';
  r = await post({ athleteId: ATH, brand: 'Nocco' });
  ok('  but a research request is capped', r.status === 429, r.status);
  RATE_OK = true;

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  server.close();
  await store.pool.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
