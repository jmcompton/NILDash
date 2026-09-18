'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js                 every suite, against the committed baseline
//   node tests/emptyreports.js        just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── NOTHING TO SAY, NOTHING SENT; AND THE DATE IN EVERY SUBJECT ─────────────
//
// One agent with no athletes and no cards got 29 daily reports in 30 days,
// every one "nothing needs you", every one under the same subject. Now: no
// athletes, no report; a report with nothing in it is not sent; and every
// recurring email (daily report, nightly digest, weekly digest, deliverable
// reminders) carries its date in the subject.

const store = require(REPO + 'server/store.js');
const SR = require(REPO + 'server/services/sendRules.js');
const SE = require(REPO + 'server/services/shiftEmail.js');
const ND = require(REPO + 'server/services/nightlyDigest.js');
const DD = require(REPO + 'server/services/deliverableDigest.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');
const FRI = Date.parse('2026-09-18T14:00:00Z');   // Friday 9am Central

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  // ── THE DATE LABEL ───────────────────────────────────────────────────────
  ok('the day label reads "Fri Sep 18"', SR.dayLabel(FRI, 'America/Chicago') === 'Fri Sep 18', SR.dayLabel(FRI, 'America/Chicago'));
  ok('  in the agent\'s own timezone: 9am Central is still Thursday in Honolulu? no, Friday 4am', SR.dayLabel(FRI, 'Pacific/Honolulu') === 'Fri Sep 18');
  ok('  but 11pm Central on the 18th is the 19th in Sydney', SR.dayLabel(Date.parse('2026-09-19T04:00:00Z'), 'Australia/Sydney') === 'Sat Sep 19', SR.dayLabel(Date.parse('2026-09-19T04:00:00Z'), 'Australia/Sydney'));
  ok('withDate appends it', SR.withDate('3 pitches ready to send', FRI, 'America/Chicago') === '3 pitches ready to send, Fri Sep 18');
  ok('  and never twice', SR.withDate('3 pitches ready to send, Fri Sep 18', FRI, 'America/Chicago') === '3 pitches ready to send, Fri Sep 18');
  ok('  an unknown zone falls back rather than throwing', /, \w{3} \w{3} \d{1,2}$/.test(SR.withDate('x', FRI, 'Nowhere/Nothing')));

  // ── IS THERE ANYTHING IN THE REPORT? ────────────────────────────────────
  const empty = { run: { ran: true }, needsYou: { items: [] }, closer: { pendingApproval: 0 }, moving: null, stat: { kept: 0, contacts: 0, drafts: 0, sent: 0 }, faults: null, verifyBudget: null };
  ok('a report with no item, no batch, no overnight work and no fault has nothing to say', SE.hasSomethingToSay(empty) === false);
  ok('  nor does a report for an agent whose team never ran', SE.hasSomethingToSay({ run: { ran: false }, needsYou: { items: [] } }) === false);
  ok('  nor an empty object', SE.hasSomethingToSay({}) === false && SE.hasSomethingToSay(null) === false);
  ok('one item to act on is something to say', SE.hasSomethingToSay({ ...empty, needsYou: { items: [{ kind: 'approve', count: 1 }] } }) === true);
  ok('  so is a batch waiting on the one decision', SE.hasSomethingToSay({ ...empty, closer: { pendingApproval: 3 } }) === true);
  ok('  so is work the team did overnight', SE.hasSomethingToSay({ ...empty, stat: { kept: 4, contacts: 0, drafts: 0, sent: 0 } }) === true);
  ok('  so is a pitch that went out', SE.hasSomethingToSay({ ...empty, stat: { kept: 0, contacts: 0, drafts: 0, sent: 2 } }) === true);
  ok('  so is a fault the agent has to fix', SE.hasSomethingToSay({ ...empty, faults: { count: 2, athletes: ['a', 'b'] } }) === true);
  ok('  so is money moving', SE.hasSomethingToSay({ ...empty, moving: { earnedCount: 1, inFlightCount: 0 } }) === true);
  ok('  so is a budget warning', SE.hasSomethingToSay({ ...empty, verifyBudget: { low: true } }) === true);

  // ── THE DATE IN THE SUBJECT, EVERY RECURRING EMAIL ──────────────────────
  const mail = SE.renderShiftEmail(empty, { appUrl: 'https://x.test', agentName: 'Sam', date: FRI, tz: 'America/Chicago' });
  ok('the daily report subject carries the date', /, Fri Sep 18$/.test(mail.subject), mail.subject);
  const mail2 = SE.renderShiftEmail(empty, { appUrl: 'https://x.test', agentName: 'Sam', date: FRI + 86400000, tz: 'America/Chicago' });
  ok('  so two mornings are two different emails', mail.subject !== mail2.subject && /, Sat Sep 19$/.test(mail2.subject), mail2.subject);
  ok('  and the content still leads', /^Your team worked last night/.test(mail.subject), mail.subject);
  const nd = ND.render({ rows: [{ name: 'A', place: 'B', count: 1 }], reviewUrl: 'https://x.test/', unsubUrl: 'https://x.test/u', date: FRI, tz: 'America/Chicago' });
  ok('the nightly digest subject carries the date', nd.subject === 'Your athletes have new pitches ready, Fri Sep 18', nd.subject);
  const dd = DD.renderDigestEmail({ overdue: [{ id: 1 }], tomorrow: [], soon: [], total: 1, actionable: 1 }, { appUrl: 'https://x.test', date: FRI, tz: 'America/Chicago' });
  ok('the deliverable reminders subject carries the date', dd.subject === '1 deliverable overdue, Fri Sep 18', dd.subject);
  const wk = src('server/jobs/weeklyDigest.js');
  ok('the weekly digest subject carries the week it covers', /withDate\(digest\.buildSubject\(d\), weekStart/.test(wk) && /week of/.test(wk));

  // ── THE SENDERS SKIP, SILENTLY, BEFORE THE CLAIM ────────────────────────
  const idx = src('server/index.js');
  const shiftFn = idx.slice(idx.indexOf('async function _sendDueShiftReports'), idx.indexOf('async function _sendDueShiftReports') + 6000);
  ok('the daily report is not sent to an agent with no athletes', /SELECT COUNT\(\*\)::int AS n FROM athletes WHERE agent_id = \$1[\s\S]{0,80}if \(!\(roster\.rows\[0\] && roster\.rows\[0\]\.n > 0\)\) continue;/.test(shiftFn));
  ok('  nor when the report has nothing in it', /if \(!require\('\.\/services\/shiftEmail'\)\.hasSomethingToSay\(rep\)\) continue;/.test(shiftFn));
  ok('  both decided BEFORE the day is claimed', shiftFn.indexOf('hasSomethingToSay(rep)') < shiftFn.indexOf('INSERT INTO shift_report_sends'));
  ok('  and silently: no log line for a skipped agent', !/nothing to say/.test(shiftFn.slice(shiftFn.indexOf('hasSomethingToSay(rep)'), shiftFn.indexOf('hasSomethingToSay(rep)') + 60)));
  ok('  the report is rendered with the date and the agent\'s zone', /renderShiftEmail\(rep, \{ appUrl, agentName: u\.name, date: now, tz \}\)/.test(shiftFn));
  ok('  and the subject that went out is recorded', /UPDATE shift_report_sends SET items=\$3, subject=\$4/.test(shiftFn));
  ok('the deliverable reminders already skip an agent with nothing due, and now record the subject', /if \(!d\.actionable\) continue;/.test(idx) && /UPDATE deliverable_reminder_sends SET items=\$3, subject=\$4/.test(idx));
  ok('the nightly digest already skips a night with no new cards, and now records the subject', /if \(!rows\.length \|\| !cards\) return \{ sent: false, reason: 'no new cards'/.test(src('server/services/nightlyDigest.js')) && /UPDATE nightly_digest_sends SET subject = \$2/.test(src('server/services/nightlyDigest.js')));
  ok('the weekly digest skips an agent with no athletes', /EXISTS \(SELECT 1 FROM athletes a WHERE a\.agent_id = users\.id\)/.test(wk));
  ok('  and already skips one with nothing to say', /if \(!digest\.shouldSend\(d\)\)/.test(wk));
  ok('the subject columns exist on every daily send log', /ALTER TABLE shift_report_sends ADD COLUMN IF NOT EXISTS subject TEXT/.test(src('server/store.js')) && /ALTER TABLE deliverable_reminder_sends ADD COLUMN IF NOT EXISTS subject TEXT/.test(src('server/store.js')) && /ALTER TABLE nightly_digest_sends ADD COLUMN IF NOT EXISTS subject TEXT/.test(src('server/store.js')));
  ok('  and the email-history page reads them', /s\.subject, s\.items FROM shift_report_sends/.test(src('server/services/sendRules.js')) && /subject: r\.subject \|\| 'Your athletes have new pitches ready'/.test(src('server/services/sendRules.js')));
  ok('GET /api/admin/empty-reports says who is getting an empty daily report', /app\.get\('\/api\/admin\/empty-reports', requireAuth/.test(idx) && /gettingEmptyReports/.test(idx) && /wouldBeSkippedToday/.test(idx));

  // ── END TO END: the nightly digest sendForRun writes the dated subject ──
  const AG = 'er-agent';
  await P.query(`DELETE FROM nightly_digest_sends WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM email_suppression WHERE email='er@er.example'`).catch(() => {});
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz) VALUES ($1,'Er','er@er.example','x','agent','America/New_York')`, [AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ('er-a1',$1,'{"name":"Er One","school":"Auburn University"}'::jsonb)`, [AG]);
  let sentMsg = null;
  const r = await ND.sendForRun(P, { agentId: AG, runDate: '2026-09-18', details: [{ athleteId: 'er-a1', filled: 2 }] }, { now: FRI, send: async (m) => { sentMsg = m; return { data: { id: 'x' } }; } });
  ok('the nightly digest goes out dated', r.sent === true && sentMsg && sentMsg.subject === 'Your athletes have new pitches ready, Fri Sep 18', sentMsg && sentMsg.subject);
  const rec = (await P.query(`SELECT subject FROM nightly_digest_sends WHERE agent_id=$1`, [AG])).rows[0];
  ok('  and the subject is on its send row', rec && rec.subject === 'Your athletes have new pitches ready, Fri Sep 18', rec);
  const hist = await SR.history(P, 'er@er.example', { days: 30, now: FRI + 3600000 });
  ok('  so the email-history page shows it by that subject', hist.some((h) => h.system === 'nightly-digest' && h.subject === 'Your athletes have new pitches ready, Fri Sep 18'), hist);
  await P.query(`DELETE FROM nightly_digest_sends WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await store.pool.end().catch(() => {});
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('emptyreports: FAILED', e); process.exit(1); });
