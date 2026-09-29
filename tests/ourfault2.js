'use strict';
// Runs against the local test Postgres. No network beyond localhost.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/ourfault2.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE RULE, PART 2 (services/ourFault) ────────────────────────────────────
// A failure on our side is never recorded as a fact about their market and
// never counts toward a pause. The nightly fill, the sends, the digests and
// the scheduled jobs, for university and agent alike.
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const OF = require(REPO + 'server/services/ourFault.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 400) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');
const strip = (s) => s.replace(/\/\/[^\n]*/g, '');
// A pool that fails every query whose SQL matches `re`.
const failing = (P, re, msg) => ({ query: (sql, params) => (re.test(typeof sql === 'string' ? sql : sql.text)
  ? Promise.reject(new Error(msg || 'relation does not exist')) : P.query(sql, params)) });

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const Scout = require(REPO + 'server/services/scout.js');
  const job = require(REPO + 'server/jobs/outreachQueue.js');

  // ── 1. ONE PLACE DECIDES HOW A NIGHT WITH OUR FAILURES READS ──────────────
  OUT.push('-- the fill: our failures are faults, never market facts --');
  const A = job.applyFaultRule;
  const drawn = { filled: 0, open: 5, tried: [{ brand: 'X', result: 'rejected' }], note: 'Cypress, CA is worked out for Maya...', emptyReason: Scout.EMPTY.MARKET_EXHAUSTED };
  const r1 = A(drawn, [{ service: 'discovery', reason: 'every discovery search failed (8): search:serper: HTTP 403' }]);
  ok('a zero night with a fault reads our-fault, not worked out', r1.emptyReason === Scout.EMPTY.FAULT && /our failure, not this market: discovery: every discovery search failed/.test(r1.note) && !/worked out/.test(r1.note), r1);
  ok('  and carries the faults for the run row', r1.faults === 1 && r1.nightFaults.length === 1);
  const r2 = A({ filled: 0, open: 5, tried: [{ brand: 'Y', result: 'error', fault: true, reason: 'contact lookup failed on our side' }, { brand: 'Z', result: 'rejected' }], emptyReason: Scout.EMPTY.BELOW_BAR, note: '2 businesses tried, none passed the bar' }, []);
  ok('a per-business fault alone is enough, the note names it', r2.emptyReason === Scout.EMPTY.FAULT && /contact lookup failed on our side/.test(r2.note), r2.note);
  const r3 = A({ filled: 2, open: 5, tried: [], emptyReason: null, note: null }, [{ service: 'google-places', reason: 'x' }]);
  ok('a night that still placed cards keeps its result, with the fault recorded', r3.filled === 2 && r3.emptyReason === null && r3.faults === 1);
  const r4 = A({ filled: 0, open: 0, tried: [], emptyReason: Scout.EMPTY.SLOTS_FULL, note: 'all 5 slots already hold work' }, [{ service: 'x', reason: 'y' }]);
  ok('  full slots, a pause or the cap are not rewritten', r4.emptyReason === Scout.EMPTY.SLOTS_FULL);
  ok('  no faults: untouched', A(drawn, []) === drawn);

  // The pause: any fault means the night measured us.
  const ATH = 'of2-ath';
  await P.query(`DELETE FROM outreach_queue_athlete_state WHERE athlete_id = $1`, [ATH]);
  await job.recordAttempt(P, ATH, { filled: 0, spent: 0.2, runDate: '2031-02-01', faults: 1, tried: [{}, {}, {}, {}], systemic: false });
  let st = (await P.query(`SELECT consecutive_failures FROM outreach_queue_athlete_state WHERE athlete_id = $1`, [ATH])).rows[0];
  ok('one fault among four attempts never counts toward the pause (it used to need all four)', !st, st);
  await job.recordAttempt(P, ATH, { filled: 0, spent: 0.2, runDate: '2031-02-02', faults: 0, tried: [{}], systemic: false });
  st = (await P.query(`SELECT consecutive_failures FROM outreach_queue_athlete_state WHERE athlete_id = $1`, [ATH])).rows[0];
  ok('  a night with no faults still counts, as before', st && st.consecutive_failures === 1, st);
  await P.query(`DELETE FROM outreach_queue_athlete_state WHERE athlete_id = $1`, [ATH]);

  let thrown = null;
  try { await job.expireStaleCards(failing(P, /UPDATE outreach_queue/, 'column "expired_at" does not exist'), { agentId: 'of2-agent' }); }
  catch (e) { thrown = e; }
  ok('card expiry failing is a fault, not "every slot is full"', OF.isOurFault(thrown) && /expired_at/.test(thrown.message), thrown && thrown.message);

  const od = await job.fillOnDemand(failing(P, /INSERT INTO outreach_queue_ondemand/, 'permission denied'),
    { id: 'of2-ath2', agent_id: 'of2-agent', name: 'Maya', agent_name: 'John Mark Compton', agent_email: 'x@x.test', data: {} }, {});
  ok('an on-demand claim that failed says so, never "already filled"', od.fault === true && /permission denied/.test(od.reason), od);

  const loc = await Scout.localCandidates(failing(P, /market_business_seen|brand_engagement/, 'column m.evidence does not exist'),
    { agentId: 'of2-agent', athlete: { id: 'of2-ath', hasLocalMarket: true, marketKey: 'cypress, ca' }, limit: 3 });
  ok('a scout pool query that failed is a fault, not an exhausted market', loc.reason === Scout.EMPTY.FAULT && loc.exhausted === false
    && /pool query failed/.test(loc.faults[0].reason), loc);

  const J = strip(read('server/jobs/outreachQueue.js'));
  ok('discovery: a thrown scan or a _fault empty is a fault, and the claim is handed back',
    /if \(result && result\._fault\) \{\s*faultOf\('discovery'/.test(J) && (J.match(/Claims\.releaseDiscovery\(/g) || []).length === 2);
  ok('  a failed widen is handed back too', /Deepen\.releaseDeepen\(pool, widenKey/.test(J));
  ok('  a failed market refill is a fault for every athlete in that market, not silence', /market refill for \$\{profile\.marketKey\} failed earlier tonight/.test(J));
  ok('  the worked-out note is never written on a night with our failures', /if \(stop && filled < open\.length && !nightFaults\.length && !tried\.some\(\(t\) => t && t\.fault\)\)/.test(J));
  ok('contacts ERROR/TIMEOUT, owner search, Instagram and the writer each record a fault, not a rejection',
    /out\.outcome === 'ERROR' \|\| out\.outcome === 'TIMEOUT'/.test(J) && (J.match(/owner search failed on our side/g) || []).length === 2
    && /instagram lookup failed on our side/.test(J) && (J.match(/the writer failed on our side/g) || []).length === 2);
  ok('  a Places outage per business is a fault, not "not on Places"', /lookupPlaceResult\(cand\.brand_name/.test(J) && /faultOf\('google-places', `lookup unavailable/.test(J));
  ok('  a school we could not look up is a fault, not "no school matched"', /could not look up where \$\{school\} is/.test(J) && /regionFault: _ctx\.fault \|\| null/.test(J));
  ok('the run row carries every athlete\'s faults', /nightFaults: r\.nightFaults \|\| \[\]/.test(J));
  const AIsrc = strip(read('server/ai.js'));
  ok('discovery tags an all-searches-failed empty as _fault, not _poolExhausted', /empty\._fault = why/.test(AIsrc) && /empty\._fault = _why/.test(AIsrc));

  // ── 2. SENDS, DIGESTS AND MAIL ────────────────────────────────────────────
  OUT.push('', '-- sends, digests and mail --');
  const RC = require(REPO + 'server/services/resendChecked.js');
  const fake = RC.checked({ emails: { send: async () => ({ data: null, error: { name: 'validation_error', message: 'The mynildash.com domain is not verified' } }) } });
  let rerr = null;
  try { await fake.emails.send({ to: 'a@b.test' }); } catch (e) { rerr = e; }
  ok('a Resend { error } result throws with Resend\'s words', rerr && /domain is not verified/.test(rerr.message) && rerr.ourFault === true, rerr && rerr.message);
  const liveResend = [];
  (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = _tp.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (f.name.endsWith('.js') && f.name !== 'resendChecked.js' && /new Resend\(/.test(strip(fs.readFileSync(p, 'utf8')))) liveResend.push(p.replace(REPO, ''));
  } })(REPO + 'server');
  ok('  and every Resend client in server/ is made through it', liveResend.length === 0, liveResend);

  const SG = require(REPO + 'server/services/sendGuard.js');
  const dis = SG.classifyError(Object.assign(new Error('Gmail API has not been used in project 123456 before or it is disabled.'),
    { code: 403, errors: [{ reason: 'accessNotConfigured' }] }));
  ok('Gmail "API disabled" is our failure, not "reconnect your mailbox", with Google\'s words', dis.kind === 'api-disabled' && dis.ourFault === true
    && /not your mailbox/.test(dis.detail) && /has not been used in project/.test(dis.detail), dis);
  const scope = SG.classifyError(Object.assign(new Error('Request had insufficient authentication scopes.'), { code: 403, errors: [{ reason: 'insufficientPermissions' }] }));
  ok('  a missing scope is still the checkbox the agent has to tick', scope.kind === 'scope');

  const REL = strip(read('server/jobs/closerRelease.js'));
  ok('a release tick that throws is recorded as a fault', /record\('release-queue', e\.message/.test(REL));
  const CR = strip(read('server/services/crypto.js'));
  ok('a token that will not decrypt is recorded, naming the key that probably changed', /record\('token-encryption'/.test(CR) && /EMAIL_ENCRYPTION_KEY/.test(CR));

  // The digest: a hold is written down; a failure after the claim never strands it.
  const ND = require(REPO + 'server/services/nightlyDigest.js');
  const AG = 'of2-digest-agent';
  await P.query(`DELETE FROM nightly_digest_sends WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM users WHERE id = $1`, [AG]);
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1, 'Digest Agent', 'of2-digest@x.test', 'x', 'agent')`, [AG]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('of2-dath', $1, '{"name":"Dee","school":"Cypress College"}') ON CONFLICT (id) DO NOTHING`, [AG]);
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state) VALUES ($1, 'of2-dath', 1, 'of2-b', 'OF2 Biz', 'call', 'queued')`, [AG]).catch(() => {});
  const details = [{ athleteId: 'of2-dath', athleteName: 'Dee', filled: 1 }];
  const savedList = process.env.NIGHTLY_DIGEST_ALLOWLIST;
  process.env.NIGHTLY_DIGEST_ALLOWLIST = 'someone-else@x.test';
  const held = await ND.sendForRun(P, { agentId: AG, runDate: '2031-02-03', details }, { send: async () => ({ data: { id: 'x' } }) });
  const heldRow = (await P.query(`SELECT status, error FROM nightly_digest_sends WHERE agent_id = $1 AND run_date = '2031-02-03'`, [AG])).rows[0];
  ok('a digest held by the allowlist is written down as held, not silence', held.held === true && heldRow && heldRow.status === 'held', [held, heldRow]);
  process.env.NIGHTLY_DIGEST_ALLOWLIST = '';
  const after = await ND.sendForRun(P, { agentId: AG, runDate: '2031-02-03', details }, { send: async () => ({ data: { id: 'prov-1' } }) });
  const afterRow = (await P.query(`SELECT status FROM nightly_digest_sends WHERE agent_id = $1 AND run_date = '2031-02-03'`, [AG])).rows[0];
  ok('  lifting the list lets the same night send over the held row', after.sent === true && afterRow.status === 'sent', [after, afterRow]);
  const failed = await ND.sendForRun(P, { agentId: AG, runDate: '2031-02-04', details },
    { send: async () => { throw new Error('Resend refused the email: API key is invalid'); } });
  const failRow = (await P.query(`SELECT status, error FROM nightly_digest_sends WHERE agent_id = $1 AND run_date = '2031-02-04'`, [AG])).rows[0];
  ok('a refused digest is marked failed with the reason, never left "claimed"', !failed.sent && failRow && failRow.status === 'failed' && /API key is invalid/.test(failRow.error), failRow);
  if (savedList === undefined) delete process.env.NIGHTLY_DIGEST_ALLOWLIST; else process.env.NIGHTLY_DIGEST_ALLOWLIST = savedList;
  await P.query(`DELETE FROM nightly_digest_sends WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM users WHERE id = $1`, [AG]);

  // ── 3. THE SCHEDULED JOBS, AGENT AND UNIVERSITY ───────────────────────────
  OUT.push('', '-- scheduled jobs, agent and university --');
  const SP = require(REPO + 'server/services/socialProof.js');
  const unreach = await SP.findProgramUrl('http://127.0.0.1:9', { reportFault: true });
  ok('social discovery: an unreachable homepage is a fault, not "no program page"', unreach && typeof unreach.fault === 'string', unreach);
  ok('  and callers that did not ask still get null', (await SP.findProgramUrl('http://127.0.0.1:9')) === null);
  const SD = strip(read('server/jobs/socialDiscovery.js'));
  ok('  an unreachable brand is not permanently rejected; all searches failing exits non-zero', /if \(found && found\.fault\)/.test(SD) && /summary\.searchFailures >= summary\.queriesRun/.test(SD) && /throw f;/.test(SD));
  const NC = strip(read('server/nilCompJob.js'));
  ok('NIL comps: a failed search is null, not [], and the run row carries the failures', /_searchErrors\.push\(e\.message\);\s*return null;/.test(NC)
    && /failed_queries, error\) VALUES/.test(NC) && /process\.exit\(1\);/.test(NC));
  const RS = strip(read('server/services/university/RosterAutomationScheduler.js'));
  ok('university scheduler: a failed query is logged FAILED and recorded, never an idle tick', /if \(univRows\.error\)/.test(RS) && /record\('university-scheduler'/.test(RS));
  const IP = strip(read('server/services/university/IngestionPipeline.js'));
  ok('university ingestion: a failed queue read says so, not "0 events"', /return \{ \.\.\.processResult, error: 'queue fetch failed: '/.test(IP));
  const TS = strip(read('server/services/teamScan.js'));
  ok('team scan: an ask that could not be written hands the business back for the night', /DELETE FROM university_research_claims WHERE team_id = \$1 AND brand_key = \$2 AND night = \$3/.test(TS));

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await P.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('ourfault2: FAILED', e); process.exit(1); });
