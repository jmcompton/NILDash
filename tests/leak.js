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
// THE LEAK TEST.
//
// The previous suite asserted isolation given a correct principal, and asserted the
// auth door by matching source TEXT. It passed while the live assistant greeted an
// athlete with the agent's name, because it never exercised the one thing that was
// wrong: how the principal is DERIVED when both credentials arrive at once.
//
// So this file starts from the credentials, not from a principal, and runs the real
// assistantAuth. If the derivation is wrong, everything downstream is wrong no
// matter how well the downstream is tested.
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const R = REPO;
const SRV = fs.readFileSync(R + 'server/index.js', 'utf8');
const IDX = fs.readFileSync(R + 'public/index.html', 'utf8');
const CTX = fs.readFileSync(R + 'server/services/assistantContext.js', 'utf8');

// ── lift the real assistantAuth ──────────────────────────────────────────────
const start = SRV.indexOf('function assistantAuth(req, res, next) {');
let d = 0, j = SRV.indexOf('{', start), end = j;
for (; j < SRV.length; j++) { if (SRV[j] === '{') d++; else if (SRV[j] === '}') { d--; if (!d) { end = j; break; } } }
const SRC = SRV.slice(start, end + 1);
if (!/verifyAthleteToken/.test(SRC) || SRC.length < 300) { console.log('FIXTURE BROKEN: ' + SRC.length); process.exit(1); }

let agentGateCalls = 0, athleteGateCalls = 0;
const mk = () => {
  agentGateCalls = 0; athleteGateCalls = 0;
  return new Function('requireAgentSubscription', 'requireAthleteSubscription', 'verifyAthleteToken', 'console',
    SRC + '\n return assistantAuth;')(
    (req, res, next) => { agentGateCalls++; next(); },
    (req, res, next) => { athleteGateCalls++; next(); },
    // Stands in for the real JWT verify: only a token that decodes to an athlete id.
    (req, res, next) => {
      const tok = (req.headers.authorization || '').slice(7);
      if (!tok.startsWith('athlete:')) return res.status(401).json({ error: 'Invalid or expired token' });
      req.athlete = { id: tok.slice(8), role: 'athlete' };
      next();
    },
    { warn() {}, log() {} });
};

const call = (headers, session) => new Promise((resolve) => {
  const auth = mk();
  const req = { headers: headers || {}, session: session || null };
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; resolve({ req, res: this, reached: false }); return this; } };
  auth(req, res, () => resolve({ req, res, reached: true }));
});

const principalOf = (req) => (req.session && req.session.userId)
  ? { kind: 'agent', id: req.session.userId }
  : (req.athletePrincipalId ? { kind: 'athlete', id: req.athletePrincipalId } : null);

(async () => {
  console.log('-- THE CASE THAT LEAKED: an athlete in a browser holding an agent session --');
  const both = await call({ authorization: 'Bearer athlete:amari' }, { userId: 'john-the-agent' });
  ok('the request is allowed through', both.reached === true, both.res.body);
  const p = principalOf(both.req);
  ok('THE PRINCIPAL IS THE ATHLETE, not the agent', p && p.kind === 'athlete', p);
  ok('  and it is HER id, not his', p && p.id === 'amari', p);
  ok('  the athlete subscription gate ran', athleteGateCalls === 1, athleteGateCalls);
  ok('  the AGENT gate did not run at all', agentGateCalls === 0, agentGateCalls);
  ok('  the agent session is neutralised for this request',
    !(both.req.session && both.req.session.userId), both.req.session && both.req.session.userId);

  console.log('\n  · which is what decides the greeting');
  // readContext branches on principal.kind. With the old derivation this was 'agent'
  // and the greeting read John's name and John's pipeline.
  ok('readContext takes the athlete branch for an athlete principal',
    /principal\.kind === 'athlete'\) return readAthleteContext/.test(CTX));
  ok('  and the athlete branch never reads agent_id',
    !/agent_id = \$1/.test(CTX.slice(CTX.indexOf('async function readAthleteContext'),
                                    CTX.indexOf('async function readContext'))));
  ok('  nor the users table, which is where the agent name came from',
    !/FROM users/.test(CTX.slice(CTX.indexOf('async function readAthleteContext'),
                                 CTX.indexOf('async function readContext'))));

  console.log('\n-- AN AGENT ALONE IS COMPLETELY UNCHANGED --');
  const agentOnly = await call({}, { userId: 'john-the-agent' });
  ok('allowed through', agentOnly.reached === true);
  const ap = principalOf(agentOnly.req);
  ok('principal is the agent', ap && ap.kind === 'agent' && ap.id === 'john-the-agent', ap);
  ok('the agent gate ran', agentGateCalls === 1, agentGateCalls);
  ok('the athlete gate did not', athleteGateCalls === 0, athleteGateCalls);

  console.log('\n-- AN ATHLETE ALONE --');
  const athOnly = await call({ authorization: 'Bearer athlete:amari' }, null);
  ok('allowed through', athOnly.reached === true);
  ok('principal is the athlete', principalOf(athOnly.req).kind === 'athlete');
  ok('only the athlete gate ran', athleteGateCalls === 1 && agentGateCalls === 0);

  console.log('\n-- NEITHER, AND FORGERIES --');
  const none = await call({}, null);
  ok('no credential is 401', none.reached === false && none.res.code === 401, none.res.code);
  const badTok = await call({ authorization: 'Bearer not-a-real-token' }, null);
  ok('an unverifiable token is 401, not a fallback to the session',
    badTok.reached === false && badTok.res.code === 401, badTok.res.code);
  // The important one: a forged token must NOT silently downgrade to the agent
  // session that happens to be present.
  const badTokWithSession = await call({ authorization: 'Bearer not-a-real-token' }, { userId: 'john-the-agent' });
  ok('a BAD token alongside a real session is refused, not downgraded to agent',
    badTokWithSession.reached === false, principalOf(badTokWithSession.req));
  ok('  it does not reach the agent gate', agentGateCalls === 0, agentGateCalls);

  console.log('\n-- THE CLIENT MUST NOT SEND THE COOKIE AT ALL --');
  ok('the shim sets credentials to omit', /opts\.credentials = 'omit';/.test(IDX));
  ok('  and no longer deletes the property',
    !/delete opts\.credentials/.test(IDX),
    'delete restores the same-origin default, which SENDS cookies');
  ok('the bearer token is still attached', /'Authorization': 'Bearer ' \+ NIL_ACTOR\.token/.test(IDX));

  console.log('\n-- 2. THE ATHLETE IS THE SUBJECT, NEVER A QUESTION --');
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (req2) {
    if (req2 === '../store') return { pool: { query: async () => ({ rowCount: 0, rows: [] }) } };
    return orig.apply(this, arguments);
  };
  const actions = require(R + 'server/services/assistantActions.js');
  Module._load = orig;

  const PRIYA = { kind: 'athlete', id: 'amari' };
  const sess = () => ({ id: 's1', scans_run: {}, suppressed: [] });
  const rc = (name, args, principal) =>
    actions.resolveCall(name, args, { agentId: principal.id, principal, session: sess() });

  const noArg = await rc('run_deal_scan', {}, PRIYA);
  ok('a scan with NO athleteId succeeds for an athlete', noArg.ok === true, noArg);
  ok('  scoped to her own id', noArg.directive && noArg.directive.athleteId === 'amari', noArg.directive);
  const nullArg = await rc('run_deal_scan', { athleteId: null }, PRIYA);
  ok('a null athleteId is filled in too', nullArg.ok === true, nullArg);
  // The override is also a second lock on isolation.
  const otherArg = await rc('run_deal_scan', { athleteId: 'someone-else' }, PRIYA);
  ok("another athlete's id is OVERRIDDEN, not merely refused", otherArg.ok === true, otherArg);
  ok('  and the scan still runs against HER', otherArg.directive.athleteId === 'amari', otherArg.directive);
  ok('an agent still must name an athlete', (await rc('run_deal_scan', {}, { kind: 'agent', id: 'john' })).ok !== true);

  console.log('\n-- 3. HOME PANELS GET A SHAPE THEY CAN RENDER --');
  const shimStart = IDX.indexOf('var ATHLETE_ADAPTERS = {');
  const shimSrc = IDX.slice(shimStart, IDX.indexOf('(function installAthleteApiShim()'));
  const ADAPT = new Function('NIL_ACTOR', shimSrc + '\n return ATHLETE_ADAPTERS;')({});
  ok('there is a today adapter', typeof ADAPT['/api/agent/today'] === 'function');
  ok('and a home-metrics adapter', typeof ADAPT['/api/agent/home-metrics'] === 'function');

  const HOME = { nilValue: '$14K', activeDeals: [{ brand_name: 'A' }], upcomingCount: 2,
    upcomingDelivs: [{ title: 'Post reel', brand: 'Cafe', event_date: '2020-01-01' },
                     { title: 'Story', brand: 'Gym', event_date: '2999-01-01' }] };
  const today = ADAPT['/api/agent/today'](HOME);
  ok('today returns an actions array', Array.isArray(today.actions), today);
  ok('  one per deliverable', today.actions.length === 2, today.actions.length);
  ok('  with the kind the renderer groups on', today.actions.every((a) => !!a.kind), today.actions);
  ok('  a past date is flagged overdue', today.actions[0].kind === 'overdue_deliverable', today.actions[0]);
  ok('  a future one is not', today.actions[1].kind !== 'overdue_deliverable', today.actions[1]);
  ok('  and a total the renderer reads', today.total === 2, today.total);

  const met = ADAPT['/api/agent/home-metrics'](HOME);
  ok('home-metrics returns a hero', met.hero && typeof met.hero.allTime === 'number', met.hero);
  ok('  with the K suffix expanded', met.hero.allTime === 14000, met.hero.allTime);
  ok('  roster is empty, because an athlete has none', Array.isArray(met.roster) && met.roster.length === 0);
  ok('$1,250 style values parse too', ADAPT['/api/agent/home-metrics']({ nilValue: '$1250' }).hero.allTime === 1250);
  ok('and $0 stays 0', ADAPT['/api/agent/home-metrics']({ nilValue: '$0' }).hero.allTime === 0);

  console.log('\n  · and the loader actually runs');
  ok('loadAgentHome is called on the athlete boot path',
    /showView\('home', document\.getElementById\('homeNavBtn'\)\);[\s\S]{0,320}loadAgentHome\(\);/.test(IDX));
  ok('the Roster card is hidden in athlete mode', /rosterCard\.style\.display = 'none'/.test(IDX));
  ok('and the remaining column takes the full width', /gridTemplateColumns = '1fr'/.test(IDX));

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 3).join('\n')); process.exit(1); });
