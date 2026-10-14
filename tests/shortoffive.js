'use strict';
// Needs the test Postgres. Sends nothing: the send is stubbed.
//
//   node tests/shortoffive.js
//
// ── THE 5:30 LIST: ATHLETES SHORT OF FIVE VERIFIED EMAILS ───────────────────
// services/shortOfFive. With EMAIL_FIVE_ON, at 5:30am Central, the admin gets
// one email naming every athlete holding fewer than five email cards with a
// verified address for a named person, and why -- from the night's record.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const store = require(REPO + 'server/store.js');
const S5 = require(REPO + 'server/services/shortOfFive.js');

let F = 0, N = 0;
const ok = (c, m, d) => { N++; console.log((c ? 'PASS ' : 'FAIL ') + m + (c || d === undefined ? '' : '   ' + JSON.stringify(d).slice(0, 700))); if (!c) F++; };

const AG = 's5-agent';
const DAY = '2026-10-14';
const AT = (hh, mm) => Date.parse(`${DAY}T${String(hh + 5).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);   // CDT = UTC-5

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await S5.ensureTable(P);
  const clean = async () => {
    await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]);
    await P.query(`DELETE FROM outreach_queue_runs WHERE agent_id = $1`, [AG]);
    await P.query(`DELETE FROM users WHERE id = $1`, [AG]);
    await P.query(`DELETE FROM short_five_alerts WHERE alert_date = $1`, [DAY]);
  };
  await clean();

  console.log('\nthe reason, from the night\'s record');
  {
    const d = { athleteId: 'x', filled: 2, loop: { stop: 'ladder' }, tried: [
      { stage: 'email', result: 'rejected', reason: 'no verified email for a named person (no format verified)' },
      { stage: 'email', result: 'rejected', reason: 'no verified email for a named person (no format verified)' },
      { stage: 'email', result: 'rejected', reason: 'no verified email for a named person (no website found)' },
      { stage: 'selection', result: 'rejected', reason: 'a national chain location (buckle), skipped before any lookup' },
      { result: 'deferred', reason: 'the mailbox check could not run (try 1 of 3)' },
      { result: 'no_angle', reason: 'nothing connects' },
      { result: 'queued' }, { result: 'queued' }] };
    const why = S5.reasonFor(d, { verified: 2, other: 1, otherExpires: '2026-10-18T00:00:00Z' }, { finished_at: new Date() });
    ok(/stopped by every source of businesses, with nothing new left/.test(why), 'says what stopped the night', why);
    ok(/8 businesses tried; 3 dropped with no verified email \(2 no format verified, 1 no website found\)/.test(why), '  how many were dropped, and why, counted', why);
    ok(/1 chain or non-email lane skipped at selection/.test(why) && /1 check\(s\) that could not run, retried/.test(why) && /1 refused by the writer/.test(why), '  chains skipped, checks retried, writer refusals', why);
    ok(/also on the page: 1 earlier DM, call or unverified card, which no longer hold a slot \(first expires 2026-10-18\)/.test(why), '  and earlier cards that do not count, said as NOT holding a slot (they no longer do)', why);
    ok(/the fill crashed for this athlete: boom/.test(S5.reasonFor({ error: 'boom' }, null, { finished_at: new Date() })), 'a crash says so');
    ok(/did not run/.test(S5.reasonFor(null, null, null)), 'no run says so');
    ok(/had not finished by 5:30/.test(S5.reasonFor({ tried: [] }, null, { finished_at: null })), 'an unfinished run says so');
  }

  console.log('\nwho is short, from the queue');
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'Sam Agent','s5@x.test','x','agent')`, [AG]);
  await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, filled, details, finished_at) VALUES ($1, $2, 7, $3, NOW())`, [AG, DAY, JSON.stringify([
    { athleteId: 's5-full', athleteName: 'Full Five', filled: 5, tried: [] },
    { athleteId: 's5-short', athleteName: 'Two Short', filled: 2, loop: { stop: 'cost' }, tried: [{ stage: 'email', result: 'rejected', reason: 'no verified email for a named person (no website found)' }] },
  ])]);
  let slot = 1;
  const card = async (ath, ch, verified) => P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, email_verified)
    VALUES ($1,$2,$3,$4,$4,$5,$6)`, [AG, ath, slot++ % 5 + 1, `S5 ${ath} ${slot}`, ch, verified]);
  for (let i = 0; i < 5; i++) await card('s5-full', 'email', true);
  slot = 0;
  await card('s5-short', 'email', true); await card('s5-short', 'email', true);
  await card('s5-short', 'dm', false); await card('s5-short', 'email', false);
  const rep = await S5.collect(P, { now: AT(5, 45) });
  const mine = rep.short.filter((s) => /^s5-/.test(s.athleteId));
  ok(mine.length === 1 && mine[0].athlete === 'Two Short' && mine[0].verified === 2, 'the athlete with two verified is listed; the one with five is not', mine);
  ok(/stopped by the per-athlete cost ceiling/.test(mine[0].reason) && /also on the page: 2 earlier DM, call or unverified cards, which no longer hold a slot/.test(mine[0].reason),
    '  with the reason: the stop, and the two cards that do not count (a DM and an unverified email)', mine[0].reason);
  const msg = S5.render({ ...rep, short: mine, athletes: 2 });
  ok(/1 athlete under 5 verified emails \(2026-10-14\)/.test(msg.subject) && /Sam Agent\n  Two Short: 2 of 5 \(2 placed tonight\)\./.test(msg.text), 'the email names the agent and the athlete, with the count', msg.text.slice(0, 300));

  console.log('\nonce, at 5:30 Central, only with EMAIL_FIVE_ON');
  const sent = [];
  const send = async (m) => { sent.push(m); };
  delete process.env.EMAIL_FIVE_ON;
  ok((await S5.runOnce(P, { now: AT(5, 45), send })).skipped === 'EMAIL_FIVE_ON is not set' && !sent.length, 'switch off: nothing');
  process.env.EMAIL_FIVE_ON = '1';
  ok((await S5.runOnce(P, { now: AT(5, 15), send })).skipped === 'before 5:30am Central' && !sent.length, '5:15: not yet');
  const r1 = await S5.runOnce(P, { now: AT(5, 35), send });
  ok(r1.status === 'sent' && sent.length === 1, '5:35: sent', r1.status || r1.skipped);
  const r2 = await S5.runOnce(P, { now: AT(5, 50), send });
  ok(/already sent/.test(r2.skipped || '') && sent.length === 1, '  and only once that morning', r2.skipped);
  ok(S5.windowOpen(AT(11, 59)) && !S5.windowOpen(AT(12, 0)) && !S5.windowOpen(AT(5, 29)), 'the window is 5:30 to noon Central');

  // A morning with nobody short sends nothing.
  await P.query(`DELETE FROM short_five_alerts WHERE alert_date = $1`, [DAY]);
  await P.query(`UPDATE outreach_queue SET email_verified = TRUE, channel = 'email' WHERE agent_id = $1`, [AG]);
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, email_verified) VALUES ($1,'s5-short',5,'S5 extra','S5 extra','email',TRUE)
    ON CONFLICT DO NOTHING`, [AG]);
  const sentBefore = sent.length;
  const r3 = await S5.runOnce(P, { now: AT(6, 0), send });
  const mine3 = (r3.report && r3.report.short || []).filter((s) => /^s5-/.test(s.athleteId));
  ok(mine3.length === 0, 'when every athlete holds five verified, nobody of ours is listed', mine3);
  if (r3.report.short.length === 0) ok(r3.status === 'clear' && sent.length === sentBefore, '  and a morning with nobody short sends nothing', r3.status);

  delete process.env.EMAIL_FIVE_ON;
  await clean();
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('THREW', e.stack); process.exit(1); });
