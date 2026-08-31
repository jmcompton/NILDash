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
const f = require(REPO + 'server/services/signupFunnel.js');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}
const NOW = Date.parse('2026-08-11T12:00:00Z');
const PAST = '2026-08-01T00:00:00Z';
const FUTURE = '2026-08-20T00:00:00Z';

console.log('-- the step list is what was asked for --');
ok('six steps in order',
  f.FUNNEL_STEPS.map((s) => s.key).join(' -> ')
    === 'signed_up -> set_password -> logged_in -> added_athlete -> ran_scan -> sent_outreach',
  f.FUNNEL_STEPS.map((s) => s.key));

console.log('-- a fully activated agent --');
const full = f.classifyFunnelUser({
  id: 'u1', name: 'Fixture Aldridge', email: 'a@x.com', role: 'agent',
  last_login: PAST, password_reset_required: false, athletes: 3, scans: 5, outreach: 2,
}, NOW);
ok('reached the last step', full.reached === 5, full.reached);
ok('not stuck anywhere', full.stuckAt === null, full.stuckAt);
ok('no note, they logged in', full.note === null, full.note);
ok('appears in Agent Activity', full.inAgentActivity === true, full.inAgentActivity);

console.log('-- invited, link issued, never used, now expired --');
const cold = f.classifyFunnelUser({
  id: 'u2', name: 'Fixture Bramwell', email: 'b@x.com', role: 'agent',
  last_login: null, password_reset_required: true, athletes: 0, scans: 0, outreach: 0,
  reset_tokens: 1, reset_used: false, reset_expires: PAST,
}, NOW);
ok('stuck at set_password', cold.stuckAt === 'set_password', cold.stuckAt);
ok('reached only signed_up', cold.reached === 0, cold.reached);
ok('note names the expired link', /EXPIRED/.test(cold.note), cold.note);
ok('reset_expired computed', cold.reset_expired === true, cold.reset_expired);

console.log('-- link still valid, not used yet --');
const waiting = f.classifyFunnelUser({
  id: 'u3', email: 'c@x.com', role: 'agent', last_login: null,
  password_reset_required: true, reset_tokens: 1, reset_used: false, reset_expires: FUTURE,
}, NOW);
ok('note says still valid', /still valid/.test(waiting.note), waiting.note);
ok('not marked expired', waiting.reset_expired === false, waiting.reset_expired);

console.log('-- link WAS used but they never logged in: the reset flow is not the blocker --');
const usedNoLogin = f.classifyFunnelUser({
  id: 'u4', email: 'd@x.com', role: 'agent', last_login: null,
  password_reset_required: false, reset_tokens: 1, reset_used: true, reset_expires: PAST,
}, NOW);
ok('stuck at logged_in, not set_password', usedNoLogin.stuckAt === 'logged_in', usedNoLogin.stuckAt);
ok('note distinguishes this case', /WAS used/.test(usedNoLogin.note), usedNoLogin.note);

console.log('-- no link ever issued --');
const noLink = f.classifyFunnelUser({
  id: 'u5', email: 'e@x.com', role: 'agent', last_login: null,
  password_reset_required: true, reset_tokens: 0,
}, NOW);
ok('note says no link was issued', /was ever issued/.test(noLink.note), noLink.note);

console.log('-- THE BRYCE CASE: in User Plans, not in Agent Activity --');
const bryce = f.classifyFunnelUser({
  id: 'u6', name: 'Bryce Johnson', email: 'bryce@x.com', role: 'university',
  last_login: null, password_reset_required: false, subscription_status: 'trialing',
}, NOW);
ok('role university is NOT shown by Agent Activity', bryce.inAgentActivity === false, bryce.inAgentActivity);
ok('but the funnel still classifies him', bryce.stuckAt === 'logged_in', bryce.stuckAt);

const archived = f.classifyFunnelUser({
  id: 'u7', name: 'Fixture Castellan', email: 'g@x.com', role: 'agent',
  archived: true, last_login: PAST, password_reset_required: false,
}, NOW);
ok('an archived agent is also hidden from Agent Activity', archived.inAgentActivity === false,
  archived.inAgentActivity);
const athleteRole = f.classifyFunnelUser({ id: 'u8', email: 'h@x.com', role: 'athlete' }, NOW);
ok('role athlete is hidden too', athleteRole.inAgentActivity === false, athleteRole.inAgentActivity);
ok('role admin IS shown',
  f.classifyFunnelUser({ id: 'u9', email: 'i@x.com', role: 'admin' }, NOW).inAgentActivity === true, null);
ok('a null role is hidden, which is worth seeing',
  f.classifyFunnelUser({ id: 'u10', email: 'j@x.com', role: null }, NOW).inAgentActivity === false, null);

console.log('-- out of order: invited but already ran scans --');
const weird = f.classifyFunnelUser({
  id: 'u11', name: 'Fixture Danforth', email: 'k@x.com', role: 'agent',
  last_login: PAST, password_reset_required: true, athletes: 2, scans: 4, outreach: 1,
}, NOW);
ok('counted at the earliest unmet step', weird.stuckAt === 'set_password', weird.stuckAt);
ok('later completed steps are reported, not hidden',
  weird.anomalies.join(',') === 'logged_in,added_athlete,ran_scan,sent_outreach', weird.anomalies);
ok('raw truth is preserved alongside', weird.raw.ran_scan === true, weird.raw);

console.log('-- counts are monotonic and add up --');
const rows = [
  { id: 'a', email: 'a@x.com', role: 'agent', last_login: PAST, password_reset_required: false, athletes: 1, scans: 1, outreach: 1 },
  { id: 'b', email: 'b@x.com', role: 'agent', last_login: PAST, password_reset_required: false, athletes: 1, scans: 1, outreach: 0 },
  { id: 'c', email: 'c@x.com', role: 'agent', last_login: PAST, password_reset_required: false, athletes: 1, scans: 0, outreach: 0 },
  { id: 'd', email: 'd@x.com', role: 'agent', last_login: PAST, password_reset_required: false, athletes: 0, scans: 0, outreach: 0 },
  { id: 'e', email: 'e@x.com', role: 'agent', last_login: null, password_reset_required: false, reset_tokens: 1, reset_used: true },
  { id: 'f', email: 'f@x.com', role: 'agent', last_login: null, password_reset_required: true, reset_tokens: 1, reset_used: false, reset_expires: PAST },
  { id: 'g', email: 'g@x.com', role: 'university', last_login: null, password_reset_required: false },
];
const out = f.buildFunnel(rows, NOW);
const by = {}; out.steps.forEach((s) => { by[s.key] = s; });
ok('total counted', out.total === 7, out.total);
ok('signed_up = 7', by.signed_up.reached === 7, by.signed_up.reached);
ok('set_password = 6 (one invited)', by.set_password.reached === 6, by.set_password.reached);
ok('logged_in = 4', by.logged_in.reached === 4, by.logged_in.reached);
ok('added_athlete = 3', by.added_athlete.reached === 3, by.added_athlete.reached);
ok('ran_scan = 2', by.ran_scan.reached === 2, by.ran_scan.reached);
ok('sent_outreach = 1', by.sent_outreach.reached === 1, by.sent_outreach.reached);
ok('each step count is <= the one before',
  out.steps.every((s, i) => i === 0 || s.reached <= out.steps[i - 1].reached),
  out.steps.map((s) => s.reached));
const stuckTotal = out.steps.reduce((n, s) => n + s.stuck.length, 0);
ok('everyone is either stuck somewhere or finished',
  stuckTotal + by.sent_outreach.reached === out.total, { stuckTotal, done: by.sent_outreach.reached });

console.log('-- stuck lists name people and carry the reason --');
ok('two people stuck at logged_in', by.logged_in.stuck.length === 2, by.logged_in.stuck.map((p) => p.email));
ok('their notes are attached', by.logged_in.stuck.every((p) => !!p.note), by.logged_in.stuck);
ok('one stuck at set_password', by.set_password.stuck.length === 1, by.set_password.stuck);
ok('one stuck at added_athlete', by.added_athlete.stuck.length === 1, by.added_athlete.stuck);

console.log('-- the missing-from-Agent-Activity list --');
ok('exactly the university account', out.missingFromAgentActivity.length === 1
  && out.missingFromAgentActivity[0].role === 'university', out.missingFromAgentActivity);

console.log('-- honesty about what the data cannot say --');
ok('the delivery-log limit is stated in the payload',
  /cannot be distinguished from an email never delivered/.test(out.note), out.note);

console.log('-- empty input does not throw --');
const empty = f.buildFunnel([], NOW);
ok('total 0', empty.total === 0, empty.total);
ok('all steps zero', empty.steps.every((s) => s.reached === 0), empty.steps.map((s) => s.reached));

console.log('');
console.log('failures: ' + fails);
process.exit(fails ? 1 : 0);
