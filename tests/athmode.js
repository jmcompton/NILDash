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
// Athlete mode: the endpoint map and the response adapters, LIFTED FROM
// public/index.html so the test cannot pass while the shipped shim says otherwise.
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const R = REPO;
const IDX = fs.readFileSync(R + 'public/index.html', 'utf8');
const SRV = fs.readFileSync(R + 'server/index.js', 'utf8');

// Lift the map, the resolver and the adapters together.
const start = IDX.indexOf('var ATHLETE_ROUTE_MAP = [');
const end = IDX.indexOf('(function installAthleteApiShim()');
if (start === -1 || end === -1 || end < start) { console.log('FIXTURE BROKEN: no shim block'); process.exit(1); }
const SRC = IDX.slice(start, end);
if (SRC.length < 1200) { console.log('FIXTURE BROKEN: shim block is ' + SRC.length); process.exit(1); }

const NIL_ACTOR = { role: 'athlete', athleteId: null, token: 't', me: null };
const sandbox = new Function('NIL_ACTOR',
  SRC + '\n return { mapAthletePath, ATHLETE_ROUTE_MAP, ATHLETE_ADAPTERS };')(NIL_ACTOR);
const { mapAthletePath, ATHLETE_ADAPTERS } = sandbox;

console.log('-- the endpoint map covers the nine views that stay --');
const CASES = [
  ['identity',      '/api/auth/me',              '/api/athlete/me'],
  ['roster',        '/api/athletes',             '/api/athlete/me'],
  ['home metrics',  '/api/agent/home-metrics',   '/api/athlete/home-data'],
  ['home today',    '/api/agent/today',          '/api/athlete/home-data'],
  ['home brief',    '/api/agent/daily-brief',    '/api/athlete/daily-brief'],
  ['deal scan',     '/api/agent/deal-scan',      '/api/athlete/deal-scan'],
  ['scan cache',    '/api/agent/deal-scan/cache','/api/athlete/deal-scan/cache'],
  ['brand contacts','/api/agent/brand-contacts', '/api/athlete/brand-contacts'],
  ['pipeline list', '/api/deals',                '/api/athlete/deal-pipeline'],
  ['pipeline item', '/api/deals/42',             '/api/athlete/deal-pipeline/42'],
  ['rate calc',     '/api/ai/rate',              '/api/athlete/rate-calculator'],
  ['compliance',    '/api/ai/compliance',        '/api/athlete/compliance'],
  ['outreach',      '/api/ai/outreach',          '/api/athlete/write-outreach'],
  ['outreach draft','/api/ai/generate-outreach', '/api/athlete/ai-draft-outreach'],
  ['outreach logs', '/api/outreach/logs',        '/api/athlete/outreach'],
  ['mailbox',       '/api/email/accounts',       '/api/athlete/gmail/status'],
  ['programs list', '/api/programs/schools',     '/api/athlete/programs/schools'],
  ['one program',   '/api/programs/Alabama',     '/api/athlete/programs/Alabama'],
];
for (const [label, from, to] of CASES) {
  ok(label + ': ' + from, mapAthletePath(from) === to, mapAthletePath(from));
}

console.log('\n  · order matters, and is right');
ok('"schools" is not captured by the :school pattern',
  mapAthletePath('/api/programs/schools') === '/api/athlete/programs/schools');
ok('the scan cache is not captured by the bare deal-scan pattern',
  mapAthletePath('/api/agent/deal-scan/cache') === '/api/athlete/deal-scan/cache');

console.log('\n  · anything unmapped is passed through untouched');
for (const p of ['/api/health', '/api/admin/users', '/api/auth/logout', '/api/agent/create-checkout',
                 '/api/university/dashboard', '/api/assistant/session']) {
  ok(p + ' is not rewritten', mapAthletePath(p) === null, mapAthletePath(p));
}

console.log('\n-- every athlete path the map points at actually exists on the server --');
const targets = [...new Set(CASES.map((c) => c[2]))];
const missing = targets.filter((t) => {
  // Strip a trailing dynamic segment before looking for the route registration.
  const base = t.replace(/\/(Alabama|42)$/, '');
  const rx = new RegExp("app\\.(get|post|put|patch|delete)\\('" + base.replace(/[/]/g, '\\/') + "(['/:])");
  return !rx.test(SRV);
});
ok('no mapped target is a route that does not exist', missing.length === 0, missing);

console.log('\n-- the adapters reshape what the SPA reads --');
const ME = {
  id: 'self-1', name: 'Priya Raman', email: 'priya@example.com', sport: 'Soccer',
  school: 'Stanford', position: 'Forward', state: 'CA',
  instagram_followers: 12000, tiktok_followers: 3000, twitter_followers: null,
  agent_id: null, media_kit_slug: 'priya',
};
const me = ATHLETE_ADAPTERS['/api/auth/me'](ME);
ok('identity comes back in the shape bootApp reads', me.role === 'athlete' && me.name === 'Priya Raman', me);
ok('the athlete id is carried as athleteId', me.athleteId === 'self-1');
ok('and stashed on the actor for later calls', NIL_ACTOR.athleteId === 'self-1');
ok('the agent subscribe button is never triggered', me.agentAccess === true);
ok('the assistant does not auto-open for an athlete', me.assistantAutoOpen === false);

const roster = ATHLETE_ADAPTERS['/api/athletes'](ME);
ok('the roster is an array', Array.isArray(roster));
ok('with exactly one entry: them', roster.length === 1 && roster[0].id === 'self-1', roster);
ok('carrying what the client selector renders', roster[0].name === 'Priya Raman' && roster[0].sport === 'Soccer');
ok('and the follower counts the rate calculator needs',
  roster[0].instagram_followers === 12000 && roster[0].tiktok_followers === 3000);
// loadAthletes pins athletes[0] when exactly one comes back and none is selected --
// that single-entry roster IS the "pinned client, no selector" behaviour.
ok('a one-entry roster is what pins the active client',
  /athletes\.length > 0 && !selectedAthleteId/.test(IDX) && /selectedAthleteId = athletes\[0\]\.id/.test(IDX));

console.log('\n-- agent mode is untouched --');
ok('the shim returns early when not in athlete mode', /if \(!isAthleteMode\(\)\) return _fetch\(input, init\);/.test(IDX));
ok('the chrome function returns early too', /function applyAthleteChrome\(\) \{\s*\n\s*if \(!isAthleteMode\(\)\) return;/.test(IDX));
ok('and the hero override does', /async function renderAthleteHero\(\) \{\s*\n\s*if \(!isAthleteMode\(\)\) return;/.test(IDX));
ok('actor defaults to agent, so no token means no change at all',
  /var NIL_ACTOR = \{ role: 'agent'/.test(IDX));

console.log('\n-- the hidden nav is the list that was asked for --');
const hidden = /var ATHLETE_HIDDEN_VIEWS = \[([^\]]*)\]/.exec(IDX)[1]
  .split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
ok('five views are hidden', hidden.length === 5, hidden);
for (const v of ['roster', 'add-athlete', 'commission', 'contract', 'growth']) {
  ok('  ' + v + ' is hidden', hidden.includes(v), hidden);
}
console.log('  · and the nine that stay are NOT hidden');
for (const v of ['home', 'deals', 'pipeline', 'marketing', 'outreach', 'rate', 'programs', 'email-inbox']) {
  ok('  ' + v + ' stays', !hidden.includes(v));
}

console.log('\n-- programs really is registered for athletes, same handler --');
ok('the agent route uses the named handler',
  /app\.get\('\/api\/programs\/schools', requireAuth, _programsSchoolsHandler\);/.test(SRV));
ok('the athlete route uses the SAME handler, not a copy',
  /app\.get\('\/api\/athlete\/programs\/schools', verifyAthleteToken, requireAthleteSubscription, _programsSchoolsHandler\);/.test(SRV));
ok('and so does the per-school one',
  /app\.get\('\/api\/athlete\/programs\/:school', verifyAthleteToken, requireAthleteSubscription, _programsSchoolHandler\);/.test(SRV));
ok('there is exactly one copy of each handler body',
  (SRV.match(/const _programsSchoolsHandler =/g) || []).length === 1
  && (SRV.match(/const _programsSchoolHandler =/g) || []).length === 1);
ok('schools is registered before :school in both pairs',
  SRV.indexOf("'/api/programs/schools'") < SRV.indexOf("app.get('/api/programs/:school'")
  && SRV.indexOf("'/api/athlete/programs/schools'") < SRV.indexOf("'/api/athlete/programs/:school'"));

console.log('\nfailures: ' + f);
process.exit(f ? 1 : 0);
