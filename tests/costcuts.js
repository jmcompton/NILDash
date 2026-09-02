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
// Pure-logic assertions for the three cost changes, plus source-order checks
// read straight out of the shipped ai.js text (it can't be require()'d without
// the full env, but the constants are unambiguous in source).
'use strict';
const fs = require('fs');
const Q = require(REPO + 'server/services/outreachQueue.js');

let OUT = [], FAIL = 0;
function ok(n, c, got) { if (c) OUT.push('PASS ' + n); else { FAIL++; OUT.push('FAIL ' + n + (got !== undefined ? '  got=' + JSON.stringify(got) : '')); } }

// ── CHANGE 1: source order by measured yield ────────────────────────────────
const aiSrc = fs.readFileSync(REPO + 'server/ai.js', 'utf8');
const leanLine = /const LEAN_SOURCE_ORDER = (\[[^\]]*\])/.exec(aiSrc);
ok('LEAN_SOURCE_ORDER exists in ai.js', !!leanLine);
const lean = JSON.parse(leanLine[1].replace(/'/g, '"'));
ok('chamber runs FIRST (highest measured yield)', lean[0] === 'chamber', lean);
ok('site runs SECOND', lean[1] === 'site', lean);
ok('facebook runs THIRD', lean[2] === 'facebook', lean);
ok('news is NOT in the lean order (found almost nobody, cost the most)', lean.indexOf('news') === -1, lean);
ok('linkedin is NOT in the lean order', lean.indexOf('linkedin') === -1, lean);
ok('registry is NOT in the lean order (0 Tier 1 across the tuning sample)', lean.indexOf('registry') === -1, lean);
ok('lean order is exactly 3 sources, down from 7', lean.length === 3, lean);

const waveLine = /const LEAN_WAVE_SIZE = (\d+)/.exec(aiSrc);
ok('LEAN_WAVE_SIZE is 2, so wave 1 is chamber+site and nothing else',
  waveLine && waveLine[1] === '2', waveLine && waveLine[1]);
ok('deepContactCtx({lean:true}) selects the lean order',
  /sourceOrder: lean \? LEAN_SOURCE_ORDER : MANUAL_SOURCE_ORDER/.test(aiSrc));
ok('deepContactCtx passes waveSize only in the lean lane',
  /waveSize: lean \? LEAN_WAVE_SIZE : null/.test(aiSrc));
ok('waveSize is threaded into _fetchBrandContacts opts',
  /waveSize: \(ctx && ctx\.waveSize\) \|\| null/.test(aiSrc));
ok('  and on into runSourceWaves', /waveSize: \(opts && opts\.waveSize\) \|\| null/.test(aiSrc));
ok('MANUAL_SOURCE_ORDER (manual Add a Business) is UNCHANGED — still all 7',
  /const MANUAL_SOURCE_ORDER = \['site', 'facebook', 'chamber', 'linkedin', 'maps', 'news', 'registry'\]/.test(aiSrc));

const jobSrc = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
ok('the queue job actually asks for the lean lane', /deepContactCtx\(\{ market: null, lean: true \}\)/.test(jobSrc));

// ── CHANGE 2: prescreen ─────────────────────────────────────────────────────
const closed = Q.prescreen({ businessStatus: 'CLOSED_PERMANENTLY', website: 'https://x.com' });
ok('permanently closed -> HARD SKIP before spending', closed.skip === true, closed);
ok('  and the reason names the status', /closed permanently/.test(closed.reason), closed.reason);
ok('CLOSED_TEMPORARILY also skips', Q.prescreen({ businessStatus: 'CLOSED_TEMPORARILY' }).skip === true);

const noSite = Q.prescreen({ businessStatus: 'OPERATIONAL', website: null });
ok('no website -> NOT a hard skip (uncalibrated signal, flagged only)', noSite.skip === false, noSite);
ok('  but flagged high risk', noSite.risk === 'high', noSite);

const notFound = Q.prescreen(null);
ok('not in Places at all -> flagged high risk, not skipped', notFound.skip === false && notFound.risk === 'high', notFound);

const good = Q.prescreen({ businessStatus: 'OPERATIONAL', website: 'https://onyx.com', rating: 4.8 });
ok('an operational business with a site passes prescreen', good.skip === false && good.risk === 'normal', good);
ok('  with no reason attached', good.reason === null, good);

const facts = Q.placesFacts({ businessStatus: 'OPERATIONAL', website: 'https://x.com', phone: '(479) 555-1212', primaryType: 'restaurant', rating: 4.5, userRatingCount: 120 });
ok('placesFacts records every calibration field', facts.found === true && facts.hasWebsite === true
  && facts.hasPhone === true && facts.primaryType === 'restaurant' && facts.rating === 4.5
  && facts.userRatingCount === 120, facts);
ok('placesFacts(null) records the not-found case rather than throwing', Q.placesFacts(null).found === false);
ok('the job attaches places facts to EVERY tried outcome (queued, rejected, error, prescreen_skip)',
  (jobSrc.match(/places: facts/g) || []).length >= 4,
  (jobSrc.match(/places: facts/g) || []).length);

// ── CHANGE 3: on demand, and backoff ────────────────────────────────────────
// RAISED TO FIVE. One slot was the whole reason a night produced one card: the
// slate the Scout is asked for is openSlots * MAX_ATTEMPTS_PER_SLOT, so one slot
// meant three businesses evaluated, however many the Scout actually had. It was
// 1 to protect a $0.50 cap that is now $3.00 and allocated per athlete.
ok('NIGHTLY_SLOTS fills the athlete\'s slots, not one of them',
  Q.NIGHTLY_SLOTS === Q.SLOTS_PER_ATHLETE && Q.NIGHTLY_SLOTS === 5, Q.NIGHTLY_SLOTS);
// Five now. The night still keeps ONE card fresh (NIGHTLY_SLOTS); the cap is
// what an athlete may hold, and the Writer refusing means fewer is normal.
ok('SLOTS_PER_ATHLETE is five', Q.SLOTS_PER_ATHLETE === 5, Q.SLOTS_PER_ATHLETE);
ok('on-demand cap is $0.15, separate from the nightly $0.50', Q.DEFAULT_ONDEMAND_USD === 0.15, Q.DEFAULT_ONDEMAND_USD);
// The nightly cap moved to $3.00; the on-demand cap did not. They are separate
// budgets for separate situations -- on-demand runs while the agent watches.
ok('  and the nightly cap is the bigger, separate one',
  Q.DEFAULT_AGENT_NIGHTLY_USD >= 3 && Q.DEFAULT_AGENT_NIGHTLY_USD > Q.DEFAULT_ONDEMAND_USD,
  Q.DEFAULT_AGENT_NIGHTLY_USD);
ok('BACKOFF_NIGHTS is 3', Q.BACKOFF_NIGHTS === 3, Q.BACKOFF_NIGHTS);
ok('pausedNote says it has STOPPED spending', /Nothing is being spent/.test(Q.pausedNote(3)), Q.pausedNote(3));
// THE WAY OUT CHANGED, AND IT IS A BETTER ONE. This required the words "Deal
// Scan", i.e. the agent doing something manual -- which, when nothing in the
// codebase could clear paused_at, was not actually a way out at all. Six
// athletes read that sentence for nine days. The note now names the automatic
// retry AND the manual override, so the guard checks for an exit, not for a
// particular instruction.
ok('  and tells the agent the way out',
  /try again automatically/i.test(Q.pausedNote(3)) && /resume/i.test(Q.pausedNote(3)),
  Q.pausedNote(3));

ok('the nightly loop passes maxSlots: NIGHTLY_SLOTS', /maxSlots: Q\.NIGHTLY_SLOTS/.test(jobSrc));
ok('fillAthlete honours maxSlots', /if \(ctx\.maxSlots && open\.length > ctx\.maxSlots\)/.test(jobSrc));
ok('on-demand does NOT pass maxSlots (it fills whatever the night left)',
  !/fillOnDemand[\s\S]{0,800}maxSlots/.test(jobSrc));
ok('on-demand claims per athlete per DAY before spending',
  /INSERT INTO outreach_queue_ondemand \(athlete_id, run_date\)[\s\S]{0,120}ON CONFLICT \(athlete_id, run_date\) DO NOTHING/.test(jobSrc));
ok('  and bails out when the claim was already taken', /if \(!\(claim\.rowCount > 0\)\) return \{ filled: 0, spent: 0, claimed: false \}/.test(jobSrc));
ok('on-demand uses its OWN budget object, not the nightly cap',
  /Q\.newBudget\(ONDEMAND_CAP_USD\)/.test(jobSrc));

// backoff wiring
// candidatesFor is gone -- the Scout assembles the slate now -- and the old
// assertion pointed at it by name, so indexOf returned -1 and the comparison
// could never fail for the reason it was written for.
ok('fillAthlete refuses to spend on a paused athlete BEFORE any lookup',
  jobSrc.indexOf('await Scout.assembleSlate') > 0
  && jobSrc.indexOf('if (state && state.paused_at)') < jobSrc.indexOf('await Scout.assembleSlate'));
ok('a night with no spend does not count toward the pause',
  /if \(!\(spent > 0\)\) return;/.test(jobSrc));
ok('a filled night RESETS the counter and clears the pause',
  /consecutive_failures = 0, last_attempt_date = \$2,\s*\n\s*paused_at = NULL, paused_reason = NULL/.test(jobSrc));
ok('the same date cannot double-count',
  /WHEN outreach_queue_athlete_state\.last_attempt_date = \$2/.test(jobSrc));
ok('pausing happens at BACKOFF_NIGHTS', /if \(failures >= Q\.BACKOFF_NIGHTS\)/.test(jobSrc));
ok('on-demand failures count toward the same backoff',
  /if \(!r\.paused\) \{[\s\S]{0,400}?await recordAttempt/.test(jobSrc));

// route + client
const idxSrc = fs.readFileSync(REPO + 'server/index.js', 'utf8');
ok('the GET route returns paused athletes', /res\.json\(\{ groups, waiting: OQ\.waitingOnYou\(rows\), outcomes: OQ\.OUTCOMES, lastRun, paused \}\)/.test(idxSrc));
// NB: match the CALL site, not the `async function runOnDemandFills(agentId)`
// definition above the route, which the bare name also matches.
ok('on-demand fill runs AFTER the response, not blocking it',
  idxSrc.indexOf('res.json({ groups, waiting: OQ.waitingOnYou(rows), outcomes: OQ.OUTCOMES, lastRun, paused })')
    < idxSrc.indexOf('runOnDemandFills(agentId).catch'));
ok('  and it is deferred via setImmediate rather than awaited in the handler',
  /setImmediate\(\(\) => \{ runOnDemandFills\(agentId\)\.catch/.test(idxSrc));
ok('on-demand is gated on the same ENABLED flag as the nightly job',
  /function OQfillOnDemandEnabled\(\)[\s\S]{0,160}require\('\.\/jobs\/outreachQueue'\)\.ENABLED/.test(idxSrc));

const htmlSrc = fs.readFileSync(REPO + 'public/index.html', 'utf8');
// ── THESE MOVED TO HOME ─────────────────────────────────────────────────────
// The Outreach tab carried a second copy of the morning queue, and the paused
// surface lived on it. That copy is gone -- Home is the only place cards are
// worked -- so the same three claims are asserted against Home's renderer. The
// BEHAVIOUR is unchanged: a paused athlete is marked on their tab, and opening
// them shows why and offers Resume rather than an ordinary empty queue.
ok('the client reads data.paused', /\(d\.paused \|\| \[\]\)\.forEach/.test(htmlSrc));
ok('paused outranks the ordinary empty state', /if \(!d\.cards\.length && _paused\) \{/.test(htmlSrc));
ok('the paused tab is visually marked', /_pausedIds\[a\.id\] \? ' paused' : ''/.test(htmlSrc));

OUT.push(''); OUT.push('failures: ' + FAIL);
console.log(OUT.join('\n'));
process.exit(FAIL ? 1 : 0);
