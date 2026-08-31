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
// The assistant's athlete path, with the isolation guarantee as the main subject.
// resolveCall and redeemPending are LIFTED FROM the shipped service and executed.
const fs = require('fs');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const R = REPO;
const ACT = fs.readFileSync(R + 'server/services/assistantActions.js', 'utf8');
const RT = fs.readFileSync(R + 'server/routes/assistant.js', 'utf8');
const SRV = fs.readFileSync(R + 'server/index.js', 'utf8');
const CTX = fs.readFileSync(R + 'server/services/assistantContext.js', 'utf8');
const IDX = fs.readFileSync(R + 'public/index.html', 'utf8');

// Load the real module with pg stubbed. Ownership for an AGENT hits the DB; the
// stub answers "yes" for exactly one pairing so a wrong-athlete request is a real
// miss rather than a stub that says yes to everything.
const Module = require('module');
const origResolve = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === '../store') {
    return { pool: { query: async (sql, params) => {
      if (/FROM athletes WHERE id=\$1 AND agent_id=\$2/.test(sql)) {
        const [athleteId, agentId] = params;
        return { rowCount: (agentId === 'agent-1' && athleteId === 'ath-of-agent-1') ? 1 : 0, rows: [] };
      }
      if (/INSERT INTO assistant_pending_actions/.test(sql)) return { rowCount: 1, rows: [] };
      if (/UPDATE assistant_pending_actions/.test(sql)) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    } } };
  }
  return origResolve.apply(this, arguments);
};
const actions = require(R + 'server/services/assistantActions.js');
Module._load = origResolve;

const AGENT = { kind: 'agent', id: 'agent-1' };
const PRIYA = { kind: 'athlete', id: 'self-priya' };
const OTHER = 'self-someone-else';
const session = { id: 's1', scans_run: {}, suppressed: [] };
const freshSession = () => JSON.parse(JSON.stringify(session));
const call = (name, args, principal) =>
  actions.resolveCall(name, args, { agentId: principal.id, principal, session: freshSession() });

(async () => {
  console.log('-- SHE CANNOT REACH ANOTHER ATHLETE, WHATEVER THE MODEL ASKS FOR --');
  // The GUARANTEE is "no action ever touches another athlete's data", not "the call
  // is refused". Refusal was the old mechanism; the id is now overridden with her
  // own before the ownership check, which also stops the assistant asking "which
  // athlete?". Asserting the outcome rather than the mechanism keeps this test
  // honest across either implementation.
  for (const target of [OTHER, 'ath-of-agent-1', '', null, 'self-priya-2']) {
    const r = await call('run_deal_scan', { athleteId: target }, PRIYA);
    const touched = r.directive && r.directive.athleteId;
    ok('run_deal_scan never acts on ' + JSON.stringify(target),
      !touched || touched === 'self-priya', r);
  }
  const mine = await call('run_deal_scan', { athleteId: 'self-priya' }, PRIYA);
  ok('but her OWN scan is allowed', mine.ok === true, mine);
  ok('  and it resolves to a directive scoped to her id',
    mine.directive && mine.directive.athleteId === 'self-priya', mine.directive);

  console.log('\n  · the same guard holds for every ownership-checked action');
  const owns = Object.keys(actions.ACTIONS).filter((k) => actions.ACTIONS[k].ownsAthlete);
  ok('there are ownership-checked actions', owns.length >= 2, owns);
  for (const name of owns) {
    const r = await call(name, { athleteId: OTHER, brand: 'X', body: 'x', subject: 's', to: 'a@b.com', stage: 'Closed', dealId: 'd1' }, PRIYA);
    const touched = (r.directive && r.directive.athleteId)
      || (r.confirm && r.confirm.args && r.confirm.args.athleteId);
    ok('  ' + name + ' never acts on another athlete',
      !touched || touched === 'self-priya', r);
  }

  console.log('\n-- AGENT BEHAVIOUR IS UNCHANGED --');
  const a1 = await call('run_deal_scan', { athleteId: 'ath-of-agent-1' }, AGENT);
  ok('an agent can scan their own roster athlete', a1.ok === true, a1);
  const a2 = await call('run_deal_scan', { athleteId: OTHER }, AGENT);
  ok('and is refused someone else\'s', a2.ok !== true, a2);
  ok('a caller with NO principal is treated as an agent, as before',
    (await actions.resolveCall('run_deal_scan', { athleteId: 'ath-of-agent-1' },
      { agentId: 'agent-1', session: freshSession() })).ok === true);

  console.log('\n-- DEFAULT DENY: an athlete only gets the named actions --');
  const allowed = /const ATHLETE_ALLOWED_ACTIONS = new Set\(\[([\s\S]*?)\]\)/.exec(ACT)[1]
    .split(',').map((x) => (x.match(/'([^']+)'/) || [])[1]).filter(Boolean);
  ok('the allowlist is explicit', allowed.length >= 4, allowed);
  ok('run_deal_scan is allowed', allowed.includes('run_deal_scan'));
  ok('send_outreach is allowed', allowed.includes('send_outreach'));
  const denied = Object.keys(actions.ACTIONS).filter((k) => !allowed.includes(k));
  ok('some actions are denied to athletes', denied.length > 0, denied);
  for (const name of denied) {
    const r = await call(name, { name: 'X', sport: 'S', school: 'C', athleteId: 'self-priya', tab: 'deals' }, PRIYA);
    ok('  ' + name + ' is refused for an athlete', r.ok !== true, r);
  }
  ok('add_athlete specifically is denied', denied.includes('add_athlete'), denied);
  ok('delete_athlete specifically is denied', denied.includes('delete_athlete'), denied);
  // A new action added later must be closed to athletes until named.
  ok('the allowlist is a Set membership test, so new actions are closed by default',
    /principal\.kind === 'athlete' && !ATHLETE_ALLOWED_ACTIONS\.has\(name\)/.test(ACT));

  console.log('\n-- CONFIRM TIER STILL REQUIRES A BUTTON --');
  const confirmActions = Object.keys(actions.ACTIONS).filter((k) => actions.ACTIONS[k].tier === 'confirm');
  ok('there are confirm-tier actions', confirmActions.length > 0, confirmActions);
  for (const name of confirmActions) {
    if (!allowed.includes(name)) continue;
    const r = await call(name, { athleteId: 'self-priya', brand: 'Cafe', subject: 's', body: 'b', to: 'a@b.com' }, PRIYA);
    ok('  ' + name + ' returns a token, NOT a directive',
      r.ok === true ? (!!r.confirm && !r.directive) : true, r);
  }
  ok('the ownership recheck at redeem takes a principal, not a bare id',
    /async function redeemPending\(agentId, token, principal\)/.test(ACT));
  ok('and redeem re-checks ownership before executing',
    /if \(action\.ownsAthlete && !\(await _ownsAthlete\(principal, args\.athleteId\)\)\)/.test(ACT));
  ok('the route passes the principal through to redeem',
    /redeemPending\(agentId, req\.body && req\.body\.token, principal\)/.test(RT));

  console.log('\n-- THE AUTH DOOR --');
  ok('the route reads req.principal, never the session directly',
    !/const agentId = req\.session\.userId/.test(RT));
  ok('an agent session is checked FIRST and wins',
    /if \(req\.session && req\.session\.userId\) \{\s*\n\s*return requireAgentSubscription/.test(SRV));
  ok('an athlete presents a bearer token', /auth\.startsWith\('Bearer '\)/.test(SRV));
  ok('verified by the SIGNED token, not a body field',
    /verifyAthleteToken\(req, res, function \(\)/.test(SRV));
  ok('and held to the athlete subscription gate', /return requireAthleteSubscription\(req, res, next\)/.test(SRV));
  ok('no credential at all is still 401',
    /return res\.status\(401\)\.json\(\{ error: 'Not authenticated' \}\);/.test(SRV));
  ok('the principal kind comes from the credential, never the request body',
    !/req\.body[\s\S]{0,40}principal/.test(SRV));

  console.log('\n-- SHE CAN ASK ABOUT HERSELF --');
  ok('there is an athlete-shaped context reader', /async function readAthleteContext\(/.test(CTX));
  ok('readContext branches on the principal', /principal\.kind === 'athlete'\) return readAthleteContext/.test(CTX));
  ok('it reads HER rows, keyed by athlete_id', /WHERE athlete_id = \$1/.test(CTX));
  ok('and her own athletes row for name and sport', /FROM athletes WHERE id = \$1/.test(CTX));
  ok('her mailbox comes from the athletes columns, not email_accounts',
    /gmail_refresh_token IS NOT NULL AS gmail_connected/.test(CTX) && !/FROM email_accounts WHERE athlete_id/.test(CTX));
  ok('roster is exactly her', /roster: m\.id \? \[\{ id: m\.id/.test(CTX));

  console.log('\n-- THE CLIENT ACTUALLY SENDS THE TOKEN --');
  ok('assistant paths are an authed passthrough', /ATHLETE_AUTH_PASSTHROUGH = \[\s*\n\s*\/\^\\\/api\\\/assistant/.test(IDX));
  ok('a passthrough path keeps its URL', /if \(!mapped\) mapped = path;/.test(IDX));
  ok('but still gets the Authorization header',
    /'Authorization': 'Bearer ' \+ NIL_ACTOR\.token/.test(IDX));
  ok('and an unmapped, non-passthrough path is left entirely alone',
    /if \(!mapped && !needsAthleteAuth\(path\)\) return _fetch\(input, init\);/.test(IDX));

  console.log('\n-- AI COMMAND READS AS SECOND PERSON --');
  ok('the ACTIVE CLIENT bar stays hidden on every view',
    /includes\(id\)\s*\n\s*&& !\(typeof isAthleteMode === 'function' && isAthleteMode\(\)\)/.test(IDX));
  ok('"Ask about <name>" becomes "Ask about you"',
    (IDX.match(/isAthleteMode\(\) \? 'you' : ath\.name/g) || []).length === 2);
  ok('the placeholder drops "my client"',
    /What are my best deals right now\?' or 'What should I charge\?'/.test(IDX));
  ok('the quick button is "My Best Deals"', /\['My Best Deals',/.test(IDX));
  ok('and its prompt is first person about herself',
    /'What are my best NIL deals right now and what should I charge\?'/.test(IDX));
  ok('"What To Charge" no longer names Nike',
    /\['What To Charge',\s*'What should I charge for an Instagram reel deal\?'\]/.test(IDX));
  ok('the buttons are built as elements, not concatenated onclick strings',
    /addEventListener\('click', function \(\) \{ setPrompt\(q\[1\]\); \}\)/.test(IDX));

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 3).join('\n')); process.exit(1); });
