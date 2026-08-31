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
// Does the agent social-stats lookup actually return an engagement rate?
// The route body is LIFTED FROM server/index.js and executed with the two lanes
// stubbed, so this reports what the shipped code does, not what it looks like.
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const SRV = fs.readFileSync(REPO + 'server/index.js', 'utf8');

const sig = "app.post('/api/athletes/:id/fetch-social-stats'";
const s = SRV.indexOf(sig);
const bodyStart = SRV.indexOf('{', SRV.indexOf('async (req, res) =>', s));
let d = 0, j = bodyStart, end = j;
for (; j < SRV.length; j++) { if (SRV[j] === '{') d++; else if (SRV[j] === '}') { d--; if (!d) { end = j; break; } } }
const SRC = SRV.slice(bodyStart + 1, end);
if (!/fetchInstagramPageMeta/.test(SRC) || SRC.length < 800) { console.log('FIXTURE BROKEN: ' + SRC.length); process.exit(1); }

// Lift the real suggestion helper too — it is part of what the caller receives.
const fnStart = SRV.indexOf('function engagementSuggestion(');
let d2 = 0, k = SRV.indexOf('{', fnStart), e2 = k;
for (; k < SRV.length; k++) { if (SRV[k] === '{') d2++; else if (SRV[k] === '}') { d2--; if (!d2) { e2 = k; break; } } }
const engagementSuggestion = new Function(SRV.slice(fnStart, e2 + 1) + '\n return engagementSuggestion;')();

const run = new Function(
  'req', 'res', 'store', 'normalizeHandle', 'fetchInstagramPageMeta',
  'fetchInstagramStatsViaSearch', 'engagementSuggestion', 'ADMIN_EMAIL', 'console',
  'return (async () => {' + SRC + '})();');

const mkRes = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const call = async (lane1, lane2) => {
  const res = mkRes();
  await run(
    { params: { id: 'new' }, body: { instagramHandle: 'priya.raman' }, session: { userId: 'u1' } },
    res,
    { getAthlete: async () => null, getUser: async () => ({ email: 'a@b.com' }), saveAthlete: async () => {} },
    (h) => String(h || '').replace(/^@/, '').trim().toLowerCase(),
    async () => lane1,
    async () => lane2,
    engagementSuggestion,
    'admin@x.com',
    { log() {}, warn() {} }
  );
  return res.body;
};

const LANE2_EMPTY = { followers: null, engagement_rate: null, source: null, confidence: 'low', found: false };

(async () => {
  console.log('-- WHAT THE LOOKUP COVERS --');
  ok('the request field is instagramHandle only', /req\.body\.instagramHandle/.test(SRC) && !/tiktokHandle|twitterHandle/.test(SRC));
  ok('there is no TikTok lane anywhere in the route', !/tiktok/i.test(SRC));
  ok('and no Twitter/X lane', !/twitter|(^|\W)x\.com/i.test(SRC));
  ok('the response reports followers', /followers,/.test(SRC));
  ok('posts', /posts,/.test(SRC));
  ok('and an engagement_rate field', /engagement_rate: engagement/.test(SRC));

  console.log('\n-- LANE 1 HIT: the fast, high-confidence, common path --');
  const a = await call({ followers: 45000, posts: 320 }, LANE2_EMPTY);
  ok('followers come back', a.followers === 45000, a.followers);
  ok('posts come back', a.posts === 320, a.posts);
  ok('confidence is high', a.confidence === 'high', a.confidence);
  // The finding.
  ok('ENGAGEMENT RATE IS NULL', a.engagement_rate === null, a.engagement_rate);
  ok('and its source is null too', a.engagement_source === null, a.engagement_source);
  ok('a suggestion string is returned instead', typeof a.engagement_suggestion === 'string', a.engagement_suggestion);
  ok('  the suggestion is a RANGE, not a number the form could store',
    /typically run \d+ to \d+ percent/.test(a.engagement_suggestion), a.engagement_suggestion);
  ok('lane 2 is never even called when lane 1 hits',
    /if \(page && page\.followers !== null\) \{[\s\S]{0,400}\} else \{[\s\S]{0,200}fetchInstagramStatsViaSearch/.test(SRC));

  console.log('\n-- LANE 1 MISS, LANE 2 WITH A RATE --');
  const b = await call(null, { followers: 12000, engagement_rate: 4.2, source: 'socialblade', confidence: 'medium', found: true });
  ok('followers come back', b.followers === 12000, b.followers);
  ok('and THIS time an engagement rate does', b.engagement_rate === 4.2, b.engagement_rate);
  ok('tagged as coming from web search', b.engagement_source === 'web_search', b.engagement_source);
  ok('no suggestion, because a real value was found', b.engagement_suggestion === null, b.engagement_suggestion);

  console.log('\n-- LANE 1 MISS, LANE 2 WITHOUT A RATE (the usual small-account case) --');
  const c = await call(null, { followers: 900, engagement_rate: null, source: 'profile snippet', confidence: 'low', found: true });
  ok('followers still come back', c.followers === 900);
  ok('engagement is null', c.engagement_rate === null);
  ok('and the suggestion is tier-appropriate', /4 to 8 percent/.test(c.engagement_suggestion), c.engagement_suggestion);

  console.log('\n-- BOTH LANES MISS --');
  const e = await call(null, LANE2_EMPTY);
  ok('found is false', e.found === false, e.found);
  ok('nothing is invented for followers', e.followers === null);
  ok('nor for engagement', e.engagement_rate === null);

  console.log('\n-- WHAT THE ADD CLIENT FORM DOES WITH IT --');
  const IDX = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  const fn = IDX.slice(IDX.indexOf('const r = await fetch(`${API_BASE}/api/athletes/new/fetch-social-stats`'));
  const block = fn.slice(0, fn.indexOf('function obUseSample'));
  ok('it shows followers when present', /followers'\)/.test(block) || /followers'/.test(block));
  ok('it shows the engagement rate when present', /engagement_rate !== null/.test(block));
  // CORRECTED. The step-1 fetch block does not mention the suggestion, but the
  // REVIEW step further down the file does render it next to a manual field. The
  // first version of this assertion sliced only the fetch handler and I read the
  // narrow result as "the form never surfaces it", which was wrong.
  ok('the step-1 status line does not mention the suggestion',
    !/engagement_suggestion/.test(block));
  ok('but the review step DOES render it', /obStats && obStats\.engagement_suggestion/.test(IDX));
  ok('so a lane-1 hit shows followers and simply no engagement at all',
    /Found ' \+ bits\.join/.test(block));

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message); process.exit(1); });

// ── appended: option 2, both forms ───────────────────────────────────────────
(async () => {
  const SRV2 = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  const ATH = fs.readFileSync(REPO + 'public/athletes.html', 'utf8');
  const IDX2 = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  let g = 0;
  const ok2 = (n, c, got) => { if (!c) { g++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };

  console.log('\n-- THE SIGNUP LOOKUP --');
  const rt = SRV2.slice(SRV2.indexOf("app.post('/api/athlete/social-preview'"),
                        SRV2.indexOf("app.post('/api/athlete/self-signup'"));
  ok2('the endpoint exists', rt.length > 400, rt.length);
  ok2('it is rate limited twice over', /authLimiter, statsLimiter/.test(rt));
  ok2('it runs the SAME lane-1 function the agent route uses', /fetchInstagramPageMeta\(handle\)/.test(rt));
  ok2('it does NOT run the paid web-search lane', !/fetchInstagramStatsViaSearch/.test(rt));
  ok2('it writes nothing', !/saveAthlete|UPDATE athletes|INSERT INTO/.test(rt));
  ok2('engagement_rate is explicitly null, not omitted', /engagement_rate: null/.test(rt));
  ok2('and the suggestion is always returned', /engagement_suggestion: engagementSuggestion\(/.test(rt));
  ok2('it reuses the shared normalizeHandle', /normalizeHandle\(req\.body\.instagramHandle\)/.test(rt));

  console.log('\n-- ATHLETE SIGNUP FORM --');
  ok2('there is a handle input', /id="s-ig-handle"/.test(ATH));
  ok2('and a Look up button wired to the lookup', /onclick="fetchMyStats\(\)"/.test(ATH));
  ok2('the handler calls the public endpoint', /fetch\('\/api\/athlete\/social-preview'/.test(ATH));
  ok2('a hit fills the follower field', /document\.getElementById\('s-ig'\)\.value = d\.followers/.test(ATH));
  ok2('there is a MANUAL engagement field', /id="s-eng"/.test(ATH));
  ok2('with helper text beside it', /id="s-eng-help"/.test(ATH));
  ok2('the helper is replaced by the server suggestion', /help\.textContent = d\.engagement_suggestion/.test(ATH));
  ok2('the helper has an honest default before any lookup',
    /Not published anywhere public\. Typical range is 1 to 5 percent\./.test(ATH));
  ok2('a miss says so and points at manual entry', /enter your counts by hand/.test(ATH));
  ok2('the form sends the engagement value', /engagement: parseFloat\(document\.getElementById\('s-eng'\)\.value\) \|\| null/.test(ATH));
  ok2('and the handle', /instagram_handle: \(document\.getElementById\('s-ig-handle'\)/.test(ATH));

  console.log('\n-- IT IS ACTUALLY STORED --');
  const su = SRV2.slice(SRV2.indexOf("app.post('/api/athlete/self-signup'"));
  ok2('self-signup destructures engagement', /instagram_handle, engagement \} = req\.body/.test(su));
  ok2('and writes it into the data JSON nilViewVal reads', /engagement: \(Number\.isFinite\(parseFloat\(engagement\)\)/.test(su));
  ok2('a zero or blank stores null, not 0', /parseFloat\(engagement\) > 0\)\s*\n?\s*\? parseFloat\(engagement\) : null/.test(su));
  // The 3.0 default this used to assert is GONE -- see engagement.js. What matters
  // for this suite is only that nilViewVal still reads the field the form stores.
  ok2('nilViewVal still reads athlete.engagement', /parseFloat\(athlete\.engagement\)/
    .test(fs.readFileSync(REPO + 'server/benchmarks.js', 'utf8')));
  ok2('  and no longer invents 3.0 when it is missing',
    !/athlete\.engagement\) \|\| 3\.0/.test(fs.readFileSync(REPO + 'server/benchmarks.js', 'utf8')));

  console.log('\n-- AGENT ADD CLIENT ALREADY DOES THIS --');
  ok2('the review step renders the suggestion', /obStats && obStats\.engagement_suggestion/.test(IDX2));
  ok2('next to a manual engagement input', /id="ob-rev-engagement"/.test(IDX2));
  ok2('with an honest fallback string', /No published rate found\. Typical range is 1 to 5 percent\./.test(IDX2));

  console.log('\nappended failures: ' + g);
  process.exit(g ? 1 : 0);
})();
