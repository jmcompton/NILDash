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
// THE BROWSER THAT HELD BOTH.
//
// An agent signed into the athlete portal to test it. Her JWT went into
// localStorage. From then on every page load ran detectActor(), found a token,
// and put the WHOLE app into athlete mode -- with a live agent session sitting
// right there in a cookie. /api/email/accounts is mapped to the athlete's mailbox
// endpoint, so the agent's Gmail read as disconnected. His tokens were never
// touched.
//
// The escape hatch could not fire either: it clears the token when /api/auth/me
// fails, but in athlete mode that call is itself rewritten to /api/athlete/me with
// her bearer token, which succeeds. The app confirmed it was an athlete using the
// credential that made it one.
//
// Nothing was hand-built here: the actor block is lifted out of index.html and
// executed against a fake browser that holds both credentials at once.
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const IDX = fs.readFileSync(REPO + 'public/index.html', 'utf8');

// ── lift the actor block ────────────────────────────────────────────────────
const FROM = IDX.indexOf("var NIL_ACTOR = { role: 'agent'");
const TO = IDX.indexOf('// The home hero.');
if (FROM === -1 || TO === -1 || TO < FROM) throw new Error('FIXTURE BROKEN: actor block not found');
const SRC = IDX.slice(FROM, TO);
if (!/function detectActor/.test(SRC) || !/installAthleteApiShim/.test(SRC)) {
  throw new Error('FIXTURE BROKEN: actor block does not contain detectActor + the shim');
}

const ATHLETE_JWT = 'eyJhbGciOiJIUzI1NiJ9.FIXTURE-amari.sig';

// A browser just real enough: a localStorage, a URL, a cookie jar the fetch stub
// honours, and a fetch that answers the two identity endpoints differently
// depending on which credential it was given.
function mkBrowser(opts) {
  const o = opts || {};
  const store = {};
  if (o.athleteToken) store.athlete_token = o.athleteToken;
  const calls = [];
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const fetchImpl = async (url, init) => {
    const u = String(url);
    const headers = (init && init.headers) || {};
    const bearer = headers.Authorization || headers.authorization || null;
    // The browser only attaches the cookie when credentials allow it. 'omit'
    // means no cookie; anything else on a same-origin request sends it.
    const creds = init && 'credentials' in init ? init.credentials : 'same-origin';
    const cookieSent = creds !== 'omit' && !!o.agentSession;
    calls.push({ url: u, bearer: bearer, credentials: creds, cookieSent });
    const path = u.split('?')[0];
    const json = (status, body) => ({ ok: status < 400, status,
      clone() { return this; }, json: async () => body });
    if (path === '/api/auth/me') {
      if (cookieSent) return json(200, { id: 'usr_john', name: 'John', email: 'john@nildash.com', role: 'agent' });
      return json(401, { error: 'Not authenticated' });
    }
    if (path === '/api/athlete/me') {
      if (bearer) return json(200, { id: 'self-amari', name: 'Amari Allen', email: 'amari@example.com' });
      return json(401, { error: 'Athlete token required' });
    }
    if (path === '/api/athlete/gmail/status') return json(200, { connected: false });
    if (path === '/api/email/accounts') {
      if (!cookieSent) return json(401, { error: 'Not authenticated' });
      return json(200, [{ id: 'ea_1', email_address: 'john@nildash.com', provider: 'gmail' }]);
    }
    return json(404, {});
  };
  const win = { location: { search: o.search || '', href: 'https://mynildash.com/' + (o.search || '') } };
  win.fetch = fetchImpl;
  const sandbox = new Function(
    'window', 'localStorage', 'URLSearchParams', 'console', 'Response', 'document', 'API_BASE',
    SRC + '\n return { NIL_ACTOR, isAthleteMode, mapAthletePath, needsAthleteAuth, '
        + 'resolveActor: (typeof resolveActor === "function" ? resolveActor : null), '
        + 'exitAthleteMode: (typeof exitAthleteMode === "function" ? exitAthleteMode : null) };')(
    win, localStorage, URLSearchParams, { log() {}, warn() {}, error() {} },
    class Response { constructor(b, i) { this._b = b; Object.assign(this, i); this.ok = true; } async json() { return JSON.parse(this._b); } },
    { getElementById: () => null, querySelector: () => null }, '');
  return { mod: sandbox, store, calls, win, fetch: () => win.fetch };
}

(async () => {
  console.log('-- THE STATE MY BROWSER WAS IN: an agent session AND a leftover athlete JWT --');
  {
    const b = mkBrowser({ athleteToken: ATHLETE_JWT, agentSession: true });
    ok('a resolver exists at all', typeof b.mod.resolveActor === 'function', typeof b.mod.resolveActor);
    if (typeof b.mod.resolveActor === 'function') await b.mod.resolveActor();

    ok('THE APP IS IN AGENT MODE, not athlete mode', b.mod.isAthleteMode() === false, b.mod.NIL_ACTOR.role);
    ok('  the stale athlete token is cleared', b.store.athlete_token === undefined, b.store.athlete_token);
    ok('  and the actor carries no athlete token', !b.mod.NIL_ACTOR.token, b.mod.NIL_ACTOR.token);

    console.log('\n  · which is what was breaking Gmail');
    ok('/api/email/accounts is NOT rewritten to the athlete mailbox',
      !b.mod.isAthleteMode() || b.mod.mapAthletePath('/api/email/accounts') === null,
      b.mod.mapAthletePath('/api/email/accounts'));
    const res = await b.win.fetch('/api/email/accounts');
    const body = await res.json();
    ok('  so the agent gets his own connected mailbox back',
      Array.isArray(body) && body[0] && body[0].email_address === 'john@nildash.com', body);

    console.log('\n  · and the probe that decided it was honest');
    const probe = b.calls.find((c) => c.url.indexOf('/api/auth/me') !== -1);
    ok('the session probe went out', !!probe, b.calls.map((c) => c.url));
    ok('  with the cookie', probe && probe.cookieSent === true, probe);
    ok('  and WITHOUT the athlete bearer token, or it would answer as her',
      probe && !probe.bearer, probe);
    ok('  it was not rewritten to /api/athlete/me by the shim',
      !b.calls.some((c) => c.url.indexOf('/api/athlete/me') !== -1 && c.url.indexOf('/api/auth/me') === -1)
      || !!probe, b.calls.map((c) => c.url));
  }

  console.log('\n-- A REAL ATHLETE, ON HER OWN BROWSER, IS UNAFFECTED --');
  {
    const b = mkBrowser({ athleteToken: ATHLETE_JWT, agentSession: false });
    if (b.mod.resolveActor) await b.mod.resolveActor();
    ok('she is still in athlete mode', b.mod.isAthleteMode() === true, b.mod.NIL_ACTOR.role);
    ok('  her token is kept', b.store.athlete_token === ATHLETE_JWT, b.store.athlete_token);
    ok('  and her routes are still rewritten',
      b.mod.mapAthletePath('/api/email/accounts') === '/api/athlete/gmail/status',
      b.mod.mapAthletePath('/api/email/accounts'));
  }

  console.log('\n-- AN ATHLETE WHO JUST SIGNED IN KEEPS HER SESSION, EVEN ON A SHARED MACHINE --');
  {
    // ?jwt= is an explicit act of signing in, so it beats an ambient agent cookie
    // that happens to be in the same browser. The opposite of the stale-token case:
    // there the token was ambient and the session was live.
    const b = mkBrowser({ search: '?jwt=' + ATHLETE_JWT, agentSession: true });
    if (b.mod.resolveActor) await b.mod.resolveActor();
    ok('the URL token wins', b.mod.isAthleteMode() === true, b.mod.NIL_ACTOR.role);
    ok('  and is stored for the next page load', b.store.athlete_token === ATHLETE_JWT, b.store.athlete_token);
  }

  console.log('\n-- THE ESCAPE HATCH DOES NOT DEPEND ON THE TOKEN BEING INVALID --');
  {
    // A perfectly valid 30-day athlete token, and no agent session to probe with:
    // there must still be a way out.
    const b = mkBrowser({ athleteToken: ATHLETE_JWT, agentSession: false, search: '?actor=agent' });
    ok('?actor=agent leaves athlete mode immediately', b.mod.isAthleteMode() === false, b.mod.NIL_ACTOR.role);
    ok('  clearing the token', b.store.athlete_token === undefined, b.store.athlete_token);
    ok('  without needing a single request', b.calls.length === 0, b.calls.map((c) => c.url));
  }
  {
    // It must also work when the probe cannot run at all (offline, server down).
    const b = mkBrowser({ athleteToken: ATHLETE_JWT, agentSession: true });
    // Both, or the probe would still reach the live stub: it deliberately holds the
    // PRE-SHIM fetch, which is the whole point of __nilRawFetch.
    const down = async () => { throw new Error('network down'); };
    b.win.fetch = down; b.win.__nilRawFetch = down;
    if (b.mod.resolveActor) await b.mod.resolveActor();
    ok('an unreachable server does NOT strand the athlete in agent mode',
      b.mod.isAthleteMode() === true, b.mod.NIL_ACTOR.role);
    ok('  and does not throw', true);
  }
  {
    const b = mkBrowser({ athleteToken: ATHLETE_JWT, agentSession: false });
    ok('exitAthleteMode is callable directly, for a console or a button',
      typeof b.mod.exitAthleteMode === 'function', typeof b.mod.exitAthleteMode);
    if (typeof b.mod.exitAthleteMode === 'function') {
      b.mod.exitAthleteMode('manual');
      ok('  and it works', b.mod.isAthleteMode() === false && b.store.athlete_token === undefined,
        { role: b.mod.NIL_ACTOR.role, tok: b.store.athlete_token });
    } else { ok('  and it works', false, 'not exported'); }
  }

  console.log('\n-- SIGNING IN AS AN AGENT CLEARS THE ATHLETE TOKEN --');
  {
    // Source-level, because doLogin lives outside the lifted block: the agent
    // sign-in path must drop any athlete token before it boots.
    const login = IDX.slice(IDX.indexOf('async function doLogin() {'), IDX.indexOf('async function doSignup() {'));
    ok('doLogin was found', login.length > 200 && /api\/auth\/login/.test(login), login.length);
    ok('it leaves athlete mode on success',
      /exitAthleteMode\(|removeItem\('athlete_token'\)/.test(login), login.slice(-400));
    const signup = IDX.slice(IDX.indexOf('async function doSignup() {'), IDX.indexOf('async function doSignup() {') + 2600);
    ok('and so does agent signup, which also ends in an agent session',
      /exitAthleteMode\(|removeItem\('athlete_token'\)/.test(signup), 'not found in doSignup');
    // The athlete's own login must NOT clear it.
    const athLogin = IDX.slice(IDX.indexOf('async function doAthleteLogin() {'), IDX.indexOf('async function doForcedReset() {'));
    ok('the athlete login does not clear her own token',
      !/exitAthleteMode\(/.test(athLogin), 'athlete login must not exit athlete mode');
  }

  console.log('\n-- THE BOOT PATH ACTUALLY WAITS FOR THE RESOLUTION --');
  {
    const boot = IDX.slice(IDX.indexOf('async function checkSession() {'), IDX.indexOf('async function loadAthletes() {'));
    ok('checkSession resolves the actor before it asks who it is',
      /await resolveActor\(\)/.test(boot) && boot.indexOf('await resolveActor()') < boot.indexOf('/api/auth/me'),
      boot.slice(0, 320));
  }

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
