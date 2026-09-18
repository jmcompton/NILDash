'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js               every suite, against the committed baseline
//   node tests/agentemail.js        just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── THE ONE REASON TO EMAIL AN AGENT: NEW PITCHES ARE READY ─────────────────
//
// The daily report, the weekly digest, the deliverable reminders and the
// media-kit-opened alert are off, in one place (services/agentEmail), not in
// env flags. The nightly digest is the only agent email, only on a night that
// placed cards, subject "3 pitches ready, Fri Sep 18". Password reset, account
// verification, the brand-inquiry forward and business replies are untouched.

const store = require(REPO + 'server/store.js');
const AE = require(REPO + 'server/services/agentEmail.js');
const ND = require(REPO + 'server/services/nightlyDigest.js');
const WJ = require(REPO + 'server/jobs/weeklyDigest.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');
const FRI = Date.parse('2026-09-18T14:00:00Z');

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const idx = src('server/index.js');

  // ── THE SWITCH ───────────────────────────────────────────────────────────
  ok('the nightly digest is the only agent email that sends', AE.enabled('nightlyDigest') === true
    && ['shiftReport', 'weeklyDigest', 'deliverableDigest', 'mediaKitOpened'].every((k) => AE.enabled(k) === false), AE.SENDS);
  ok('  an unknown kind is off', AE.enabled('anythingElse') === false);
  ok('  the switch is frozen: not an env flag, not flippable at runtime', Object.isFrozen(AE.SENDS));
  ok('  and it says what still sends and why', AE.STILL_SENDS.length === 1 && AE.STILL_SENDS[0].kind === 'nightlyDigest' && /placed at least one new card/.test(AE.STILL_SENDS[0].trigger));

  // ── THE DAILY REPORT IS OFF FOR EVERYONE ─────────────────────────────────
  const shiftFn = idx.slice(idx.indexOf('async function _sendDueShiftReports'), idx.indexOf('async function _sendDueShiftReports') + 700);
  ok('the daily report sender refuses before it reads the roster', /if \(!require\('\.\/services\/agentEmail'\)\.enabled\('shiftReport'\)\) return;/.test(shiftFn) && shiftFn.indexOf("enabled('shiftReport')") < shiftFn.indexOf('FROM users'));
  ok('  and its ticker is not armed', /if \(AE\.enabled\('shiftReport'\)\) \{\s*setInterval\(\(\) => \{ _sendDueShiftReports/.test(idx));
  ok('  the preview route stays, so the report can still be read', /app\.get\('\/api\/agent\/report-preview'/.test(idx));
  ok('  the settings page says so and hides the schedule controls', /You get one email: new pitches are ready/.test(src('public/index.html')) && /The daily report below is no longer emailed/.test(src('public/index.html')));

  // ── THE WEEKLY DIGEST AND THE DELIVERABLE REMINDERS ARE OFF ──────────────
  ok('the weekly digest scheduler is off whatever the env flag says', /process\.env\.WEEKLY_DIGEST_ENABLED === '1' && require\('\.\/services\/agentEmail'\)\.enabled\('weeklyDigest'\)/.test(idx));
  const wk = await WJ.run({ force: true, nowMs: FRI, noAi: true });
  ok('  and a real run sends nothing', wk.off === true && wk.sent === 0 && wk.considered === 0, wk);
  ok('  the dry run still builds, so the numbers can be read', /if \(!dryRun && !require\('\.\.\/services\/agentEmail'\)\.enabled\('weeklyDigest'\)\)/.test(src('server/jobs/weeklyDigest.js')));
  const delFn = idx.slice(idx.indexOf('async function _sendDueDeliverableDigests'), idx.indexOf('async function _sendDueDeliverableDigests') + 400);
  ok('the deliverable reminder sender refuses first', /if \(!require\('\.\/services\/agentEmail'\)\.enabled\('deliverableDigest'\)\) return;/.test(delFn));
  ok('  and its ticker is not armed', /if \(AE\.enabled\('deliverableDigest'\)\) \{\s*setInterval\(\(\) => \{ _sendDueDeliverableDigests/.test(idx));
  ok('the media-kit-opened alert is off', /if \(!require\('\.\/services\/agentEmail'\)\.enabled\('mediaKitOpened'\)\) return;/.test(idx.slice(idx.indexOf('async function notifyKitOpened'), idx.indexOf('async function notifyKitOpened') + 400)));

  // ── THE NIGHTLY DIGEST: ONLY WITH PITCHES, COUNT AND DATE IN THE SUBJECT ─
  ok('the subject is the count and the date', ND.render({ rows: [{ name: 'A', place: '', count: 3 }], reviewUrl: 'u', unsubUrl: '', date: FRI, tz: 'America/Chicago' }).subject === '3 pitches ready, Fri Sep 18');
  ok('  singular', ND.subjectFor(1) === '1 pitch ready');
  const AG = 'ae-agent';
  await P.query(`DELETE FROM nightly_digest_sends WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz) VALUES ($1,'Ae','ae@ae.example','x','agent','America/Chicago')`, [AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('ae-a1',$1,'{"name":"Ae One","school":"Auburn University"}'::jsonb)`, [AG]);
  let sent = 0;
  const none = await ND.sendForRun(P, { agentId: AG, runDate: '2026-09-18', details: [{ athleteId: 'ae-a1', filled: 0 }] }, { now: FRI, send: async () => { sent++; return { data: { id: 'x' } }; } });
  ok('no pitches, no email', none.sent === false && sent === 0 && /no new cards/.test(none.reason), none);
  ok('  and nothing is claimed or logged for that night', (await P.query(`SELECT COUNT(*)::int AS n FROM nightly_digest_sends WHERE agent_id=$1`, [AG])).rows[0].n === 0);
  let msg = null;
  const some = await ND.sendForRun(P, { agentId: AG, runDate: '2026-09-18', details: [{ athleteId: 'ae-a1', filled: 3 }] }, { now: FRI, send: async (m) => { msg = m; sent++; return { data: { id: 'x' } }; } });
  ok('three pitches: one email, "3 pitches ready, Fri Sep 18"', some.sent === true && sent === 1 && msg && msg.subject === '3 pitches ready, Fri Sep 18', msg && msg.subject);
  await P.query(`DELETE FROM nightly_digest_sends WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});

  // ── LEFT ALONE ───────────────────────────────────────────────────────────
  ok('password reset still sends', /requestReset\(/.test(idx) && !/agentEmail/.test(src('server/services/passwordReset.js')));
  ok('account verification still sends', (idx.match(/subject: 'Verify your NILDash account'/g) || []).length >= 1 && !/enabled\('verify/.test(idx));
  ok('the brand-inquiry forward still sends (a business writing to the agent)', /subject: `Brand inquiry for \$\{ath\.name/.test(idx) && !/enabled\('inquiry'\)/.test(idx));
  ok('business replies are captured, not gated', !/agentEmail/.test(src('server/routes/resendInbound.js')));

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await store.pool.end().catch(() => {});
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('agentemail: FAILED', e); process.exit(1); });
