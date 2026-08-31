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
// THE DIVERGENCE, REPRODUCED. Builds the exact shape the user described --
// a night that claimed at 1am and finished at 3am, an on-demand fill at 11am
// triggered by the agent's own page load, and a reply that landed at 9am --
// then asserts the 7am email and the midday page agree about the NIGHT, and
// that the day's additions are reported as their own thing.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const shiftReport = require(ROOT + 'server/services/shiftReport.js');
const { renderShiftEmail } = require(ROOT + 'server/services/shiftEmail.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const AG = 'drift-agent';

// Fixed clock offsets, relative to "now", so the test does not depend on wall time.
const H = (n) => new Date(Date.now() - n * 3600e3);

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    for (const t of ['outreach_logs', 'outreach_queue', 'outreach_queue_runs', 'athletes'])
      await P.query(`DELETE FROM ${t} WHERE agent_id=$1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'Jonathan C','d@x.com','x','agent','America/Chicago')`, [AG]);
  for (const [id, nm] of [['d-a1', 'Marcus Hall'], ['d-a2', 'Kaden House']]) {
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`,
      [id, AG, JSON.stringify({ name: nm, school: 'Auburn University' })]);
  }

  // THE NIGHT: claimed 12h ago, finished 10h ago, two athletes attempted.
  await P.query(
    `INSERT INTO outreach_queue_runs (agent_id, run_date, filled, details, created_at, finished_at)
     VALUES ($1, CURRENT_DATE, 2, $2::jsonb, $3, $4)`,
    [AG, JSON.stringify([{ athleteId: 'd-a1', athleteName: 'Marcus Hall', filled: 2 },
      { athleteId: 'd-a2', athleteName: 'Kaden House', filled: 0, note: 'no market resolved' }]),
    H(12), H(10)]);

  // outreach_queue.id is a serial integer, not a text id.
  //
  // EVERY SEEDED ROW NOW CARRIES A REACHABLE CHANNEL, and it has to. This file
  // is about the page and the email agreeing, and they now agree by BOTH asking
  // server/services/actionable.js what an agent can act on today -- which means
  // a DM card needs a handle and a message, and a draft needs an address. Seeded
  // without one, a row is correctly counted by neither, which is the agreement
  // working rather than the report going quiet.
  const card = (id, ath, slot, at, dm) => P.query(
    `INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,
                                 dm_text,instagram,created_at)
     VALUES ($1,$2,$3,$4,$5,'dm','queued',$6,$7,$8)`,
    [AG, ath, slot, 'k' + id, 'B' + id, dm || 'Hi — a quick idea.', 'h' + id, at]);
  const draft = (id, ath, brand, at) => P.query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,created_at)
     VALUES ($1,$2,$3,$4,'Hi','<p>x</p>','draft',$5,$6)`,
    [id, AG, ath, brand, 'owner-' + id + '@x.example', at]);

  // Written by the NIGHT, inside the run.
  await card('d-c1', 'd-a1', 1, H(11), 'dm one');
  await card('d-c2', 'd-a1', 2, H(11), 'dm two');
  await draft('d-d1', 'd-a1', 'Kessler Auto', H(11));
  await draft('d-d2', 'd-a1', 'Toomer Drugs', H(11));

  // ── 1. THE 7AM READ ──────────────────────────────────────────────────────
  const morning = await shiftReport.buildShiftReport(P, AG);
  ok('the night is reported as finished', morning.run.finished === true, morning.run);
  ok('  and not as still running', morning.run.inProgress === false, morning.run.inProgress);
  const nightSentence = morning.sentence;
  const nightCoverage = morning.coverage.line;
  ok('  the sentence counts the night', /wrote four pitches/.test(nightSentence), nightSentence);
  ok('  across both athletes attempted', /1 of 2 athletes/.test(nightCoverage), nightCoverage);
  ok('  nothing was added during the day yet', morning.added === null, morning.added);

  // ── 2. THE DAY HAPPENS ───────────────────────────────────────────────────
  // The agent opens the queue; runOnDemandFills places the slots the night left
  // empty. Under the old flat 12-hour window every one of these counted as part
  // of "last night" -- this is the exact cause of the numbers the user saw.
  await card('d-c3', 'd-a1', 3, H(1), 'dm three');
  await card('d-c4', 'd-a2', 1, H(1), 'dm four');
  for (let i = 0; i < 10; i++) await draft('d-x' + i, 'd-a2', 'Midday Brand ' + i, H(1));
  // And a reply lands at 9am, after the email went. On a SENT pitch, which is
  // the only kind that can be replied to -- mutating a draft into a reply would
  // leave it counted as still waiting on approval, which is not a real state.
  await P.query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_at,replied_at)
     VALUES ('d-r1',$1,'d-a2','Ourisman Chevrolet of Bowie','Hi','<p>x</p>','sent',$2,$3)`,
    [AG, H(30), H(3)]);

  const midday = await shiftReport.buildShiftReport(P, AG);

  // ── THE ASSERTION THE WHOLE FIX EXISTS FOR ───────────────────────────────
  ok('THE PAGE AND THE EMAIL AGREE ON THE NIGHT',
    midday.sentence === nightSentence, { morning: nightSentence, midday: midday.sentence });
  ok('  and on how many athletes it covered',
    midday.coverage.line === nightCoverage, { morning: nightCoverage, midday: midday.coverage.line });
  ok('  the day\'s work is counted separately, not backdated',
    midday.added && midday.added.cards === 2 && midday.added.drafts === 10, midday.added);
  ok('  and said in its own words',
    !!(midday.added && /added since, while you were working/.test(midday.added.line)),
    midday.added && midday.added.line);

  // ── 3. AN UNFINISHED RUN IS NOT PRESENTED AS A FINISHED ONE ──────────────
  // A run claimed two hours ago that has stamped no end is still writing.
  await P.query(`UPDATE outreach_queue_runs SET finished_at = NULL, created_at = $2
                  WHERE agent_id = $1`, [AG, H(2)]);
  const partial = await shiftReport.buildShiftReport(P, AG);
  ok('a run with no end stamp reads as in progress',
    partial.run.inProgress === true && partial.run.finished === false, partial.run);
  // Past the 12-hour ceiling it is abandoned, not in progress -- otherwise a
  // crashed night would hold the email back forever.
  await P.query(`UPDATE outreach_queue_runs SET created_at = $2 WHERE agent_id = $1`, [AG, H(30)]);
  const abandoned = await shiftReport.buildShiftReport(P, AG);
  ok('  but past the ceiling it is abandoned, not in progress',
    abandoned.run.inProgress === false, abandoned.run);
  await P.query(`UPDATE outreach_queue_runs SET finished_at = $2, created_at = $3
                  WHERE agent_id = $1`, [AG, H(10), H(12)]);

  // ── 4. THE EMAIL ─────────────────────────────────────────────────────────
  const rep = await shiftReport.buildShiftReport(P, AG);
  const mail = renderShiftEmail(rep, { appUrl: 'https://mynildash.com', agentName: 'Jonathan C' });

  ok('THE SUBJECT NAMES THE BRAND THAT REPLIED',
    /^Ourisman Chevrolet of Bowie replied/.test(mail.subject), mail.subject);
  ok('  it is not a broken item count', !/thing need you/.test(mail.subject), mail.subject);
  ok('  and it carries what is waiting', /pitches ready/.test(mail.subject), mail.subject);

  ok('THE REPLY IS IN THE EMAIL BODY',
    /Ourisman Chevrolet of Bowie replied about Kaden House/.test(mail.html), null);
  ok('  in its own block above everything else',
    mail.html.indexOf('A BRAND REPLIED') > -1
    && mail.html.indexOf('A BRAND REPLIED') < mail.html.indexOf('NEEDS YOU'), null);
  ok('  and it is not also repeated inside Needs you',
    (mail.html.match(/Ourisman Chevrolet of Bowie replied/g) || []).length === 1,
    (mail.html.match(/Ourisman Chevrolet of Bowie replied/g) || []).length);
  ok('  the plain text carries it too',
    /A BRAND REPLIED[\s\S]*Ourisman Chevrolet of Bowie replied/.test(mail.text), null);

  ok('READY TO SEND IS IN THE EMAIL', /READY TO SEND/.test(mail.html), null);
  ok('  naming the athlete it is for', /Kaden House · 10 pitches/.test(mail.html), null);
  ok('  and the businesses by name', /Midday Brand 0/.test(mail.html), null);
  ok('  with one approve action, not one per pitch',
    (mail.html.match(/Read them and approve/g) || []).length === 1, null);
  ok('  it still says who picks the timing', /You do not pick the time/.test(mail.html), null);
  ok('  the plain text carries it too', /READY TO SEND[\s\S]*Kaden House/.test(mail.text), null);
  ok('  the only action is no longer "Open queue" alone',
    /Read them and approve/.test(mail.html), null);

  // ── 5. AN IN-FLIGHT RUN SAYS SO IN THE MAIL ──────────────────────────────
  rep.run.inProgress = true;
  const m2 = renderShiftEmail(rep, { appUrl: 'https://mynildash.com', agentName: 'Jonathan C' });
  ok('an email sent mid-run says the run was still going',
    /still going when this was sent/.test(m2.html), null);

  // ── 6. NO REPLY, NO FALSE CLAIM ──────────────────────────────────────────
  await P.query(`UPDATE outreach_logs SET replied_at = NULL WHERE agent_id = $1`, [AG]);
  const rep3 = await shiftReport.buildShiftReport(P, AG);
  const m3 = renderShiftEmail(rep3, { appUrl: 'https://mynildash.com' });
  // CHANGED DELIBERATELY: THE WHOLE MORNING, NOT THE EMAIL SUBSET. This asserted
  // "12 pitches ready to send" while four DM cards were also waiting -- the
  // subject named the part that approving sends and silently dropped the rest.
  // In production that part is about 18% of a night's work, so the subject was
  // consistently a smaller morning than the agent had, and a different number
  // from the one Home showed them thirty seconds later.
  ok('with no reply the subject names the WHOLE pile, not just the emails',
    /^16 cards ready to work$/.test(m3.subject), m3.subject);
  ok('  and no reply block is rendered', !/BRAND REPLIED/.test(m3.html), null);

  // When the pile IS all email, the more specific wording is still the one used
  // -- "ready to send" says something "ready to work" does not.
  await P.query(`UPDATE outreach_queue SET state = 'skipped' WHERE agent_id = $1`, [AG]);
  const m4 = renderShiftEmail(await shiftReport.buildShiftReport(P, AG), {});
  ok('  but an all-email pile keeps the sharper wording',
    /^12 pitches ready to send$/.test(m4.subject), m4.subject);
  await P.query(`UPDATE outreach_queue SET state = 'queued' WHERE agent_id = $1`, [AG]);

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
