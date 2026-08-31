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
// The rewritten shift report: the sentence, the caps, the ordering, the coverage
// gap, the draft audit, and page/email parity from ONE source.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const SR = require(ROOT + 'server/services/shiftReport.js');
const { renderShiftEmail } = require(ROOT + 'server/services/shiftEmail.js');
const SW = require(ROOT + 'server/services/sendWindow.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

const AG = 'agent-shift-1';
const ATH = 'ath-shift-1';
const RUN_AT = '2026-08-20 03:10:00+00';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const wipe = async () => {
    // Scoped to THIS suite's own rows. A blanket DELETE here corrupted other
    // suites sharing the same test database.
    for (const t of ['outreach_queue_runs', 'outreach_queue', 'outreach_logs',
      'brand_engagement', 'athlete_activity_log', 'deals', 'brand_match_scores']) {
      await P.query(`DELETE FROM ${t} WHERE agent_id = $1`, [AG]).catch(() => {});
    }
    await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM brand_evidence_cache WHERE brand_key LIKE 'bk%'`).catch(() => {});
  };
  await wipe();
  const rep = () => SR.buildShiftReport(P, AG);

  // ── NO RUN ────────────────────────────────────────────────────────────────
  let d = await rep();
  ok('no run -> ran:false and no sentence', d.run.ran === false && d.sentence === null, d.run);

  // ── A RUN OVER 8 ATHLETES, ONLY 5 GET WORK — THE COUNT MISMATCH ──────────
  const details = [];
  for (let i = 0; i < 8; i++) details.push({ athleteId: 'a' + i, athleteName: 'Athlete ' + i, filled: i < 5 ? 1 : 0 });
  await P.query(`INSERT INTO outreach_queue_runs (agent_id, run_date, filled, details, created_at)
                 VALUES ($1,'2026-08-20',5,$2::jsonb,$3)`, [AG, JSON.stringify(details), RUN_AT]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3::jsonb)`,
    [ATH, AG, JSON.stringify({ name: 'Jane Doe', school: 'Auburn, AL' })]);
  for (let i = 0; i < 5; i++) {
    await P.query(
      `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state, created_at)
       VALUES ($1,$2,$3,$4,$5,'dm','queued',$6)`, [AG, 'a' + i, i, 'bk' + i, 'Brand ' + i, RUN_AT]);
  }
  d = await rep();
  const cov = d.coverage;
  ok('THE MISMATCH: attempted 8, with work 5', cov.attempted === 8 && cov.withWork === 5, cov);
  ok('  the gap is 3 real athletes, not a bug', cov.blank === 3, cov.blank);
  ok('  and the line SAYS so instead of printing two numbers',
    /Across 5 of 8 athletes — 3 had nothing new to work/.test(cov.line), cov.line);
  ok('  naming who got nothing', cov.blankNames.length === 3, cov.blankNames);

  // With every athlete filled, the line is the simple one.
  await P.query(`UPDATE outreach_queue_runs SET details = $2::jsonb WHERE agent_id=$1`,
    [AG, JSON.stringify(details.slice(0, 5))]);
  d = await rep();
  ok('  when nobody is missed the line is plain', /^Across five athletes$/.test(d.coverage.line), d.coverage.line);
  await P.query(`UPDATE outreach_queue_runs SET details = $2::jsonb WHERE agent_id=$1`, [AG, JSON.stringify(details)]);

  // ── THE SENTENCE ─────────────────────────────────────────────────────────
  for (let i = 0; i < 5; i++) {
    await P.query(`INSERT INTO brand_engagement (agent_id, athlete_id, lane, brand_key, state)
                   VALUES ($1,$2,'local',$3,'shown') ON CONFLICT DO NOTHING`, [AG, ATH, 'bk' + i]).catch(() => {});
    await P.query(`INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
                   VALUES ($1,'places',$1,$2,'{}'::jsonb,'OK',$3)`, ['bk' + i, 'https://b' + i + '.com', RUN_AT]);
  }
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, sent_at, replied_at, created_at)
                 VALUES ('s1',$1,$2,'B','sent',$3,$3,$3),('s2',$1,$2,'C','sent',$3,$3,$3)`, [AG, ATH, RUN_AT]);
  d = await rep();
  ok('the sentence names only roles that did something',
    /^Your team checked five businesses and sent two\./.test(d.sentence), d.sentence);
  ok('  a role with nothing is ABSENT, not named with a zero',
    !/contact|pitch|media kit/.test(d.sentence), d.sentence);
  ok('  replies get their own clause', /Two replies came back\./.test(d.sentence), d.sentence);
  ok('  small numbers are words, as in prose', / five businesses/.test(d.sentence), d.sentence);

  // Ten-plus uses digits.
  for (let i = 5; i < 20; i++) {
    await P.query(`INSERT INTO brand_engagement (agent_id, athlete_id, lane, brand_key, state)
                   VALUES ($1,$2,'local',$3,'shown') ON CONFLICT DO NOTHING`, [AG, ATH, 'bk' + i]).catch(() => {});
    await P.query(`INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,outcome,refreshed_at)
                   VALUES ($1,'places',$1,$2,'{}'::jsonb,'OK',$3)`, ['bk' + i, 'https://b' + i + '.com', RUN_AT]);
  }
  d = await rep();
  ok('  twenty is a digit, not a word', /checked 20 businesses/.test(d.sentence), d.sentence);

  // A run that produced nothing says so rather than rendering an empty string.
  await P.query(`DELETE FROM brand_evidence_cache WHERE brand_key LIKE 'bk%'`);
  await P.query(`DELETE FROM outreach_logs WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]);
  d = await rep();
  ok('a run that found nothing says so', /ran last night and found nothing/.test(d.sentence), d.sentence);

  // ── THE 155 PROBLEM, RESTATED ────────────────────────────────────────────
  //
  // The old rule was "an item may never contain a pile": 155 drafts became one
  // item claiming to represent the highest-fit ten, with the other 145 named as
  // waiting. Two things about it are now wrong.
  //
  //   THE HIGHEST-FIT TEN cannot be picked. The report and Home order the same
  //   pile through server/services/actionable.js, and that ordering does not use
  //   compatibility_score -- brand_match_scores has no brand_key, joins on an
  //   exact lowercase brand_name, and reaches 4% of queue cards.
  //
  //   THE PILE IS THE POINT. The number this item prints is now the number Home
  //   prints, on purpose: an agent read "10 pitches ready for you" in an email
  //   and opened a page whose tabs summed to something else. There is nothing
  //   left to hide, because the count is now what an agent can actually act on
  //   rather than every row in the table.
  //
  // What has NOT changed: the item is still ONE line, and it still never becomes
  // 155 rendered decisions in an inbox.
  await P.query(`DELETE FROM outreach_logs WHERE agent_id = $1`, [AG]);
  for (let i = 0; i < 155; i++) {
    await P.query(
      `INSERT INTO brand_match_scores (id, agent_id, athlete_id, brand_name, compatibility_score)
       VALUES ($1,$2,$3,$4,$5)`, ['ms' + i, AG, ATH, 'B' + i, i]);
    await P.query(
      `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, created_at)
       VALUES ($1,$2,$3,$4,'draft', NOW() - ($5 || ' days')::interval)`,
      ['d' + i, AG, ATH, 'B' + i, String(i % 40)]);
  }
  // NOT ONE OF THEM HAS AN ADDRESS, which is the real production shape: 19 of 20
  // drafts are born unaddressed. Home shows none of these, so the report must
  // not announce 155 of them.
  d = await rep();
  ok('155 ADDRESSLESS drafts produce no ready-to-work item, the same as Home',
    !d.needsYou.items.find((x) => x.kind === 'approve'),
    JSON.stringify((d.needsYou.items || []).map((x) => x.kind)));
  ok('  but the audit still counts every one of them, so nothing vanishes',
    d.draftAudit.pending === 155, d.draftAudit.pending);

  await P.query(`UPDATE outreach_logs SET sent_to_email = 'owner@' || LOWER(brand_name) || '.example'
                  WHERE agent_id = $1`, [AG]);
  d = await rep();
  const ap = d.needsYou.items.find((x) => x.kind === 'approve');
  ok('addressed, they become ONE item', !!ap && ap.count === 155, ap && ap.count);
  ok('  reading "155 cards ready to work"', /^155 cards ready to work$/.test(ap.line), ap.line);
  ok('  which is the number Home would show across its tabs', ap.total === 155, ap.total);
  ok('  with the channel mix underneath', /155 to approve and send/.test(ap.detail || ''), ap.detail);
  ok('  and it is still ONE line, not 155', d.needsYou.items.length < 5, d.needsYou.items.length);

  // ── DRAFT AUDIT: the answer to "is anything consuming this?" ─────────────
  const da = d.draftAudit;
  ok('the audit counts what is pending', da.pending === 155, da.pending);
  ok('  how many were EVER sent', da.everSent === 0, da.everSent);
  ok('  the send-through rate', da.sendThroughPct === 0, da.sendThroughPct);
  ok('  and the age of the oldest still waiting', da.oldestDraftAgeDays >= 38, da.oldestDraftAgeDays);
  ok('  plus how many are past the expiry line', da.stale > 0, da.stale);

  const before = da.pending;
  const expired = await SR.expireStaleDrafts(P, AG);
  ok('expiry removes the stale ones from the queue', expired === da.stale, [expired, da.stale]);
  d = await rep();
  ok('  pending drops by exactly that many', d.draftAudit.pending === before - expired, d.draftAudit.pending);
  ok('  they are EXPIRED, not deleted', d.draftAudit.expired === expired, d.draftAudit.expired);
  const body = await P.query(`SELECT status FROM outreach_logs WHERE id='d39'`);
  ok('  and the row survives with its body', body.rows.length === 1, body.rows);

  // ── QUEUE ORDER AND OVERFLOW ─────────────────────────────────────────────
  await P.query(`DELETE FROM outreach_logs WHERE agent_id = $1`, [AG]);
  for (let i = 0; i < 8; i++) {
    await P.query(
      `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, replied_at, created_at)
       VALUES ($1,$2,$3,$4,'sent',NOW(),NOW())`, ['r' + i, AG, ATH, 'Replier ' + i]);
  }
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, created_at)
                 VALUES ('dr1',$1,$2,'D','draft',NOW())`, [AG, ATH]);
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state)
                 VALUES ($1,$2,1,'q1','Q','dm','queued')`, [AG, ATH]);
  d = await rep();
  const nu = d.needsYou;
  ok('the queue shows exactly five', nu.items.length === 5, nu.items.length);
  ok('  replies come FIRST — a human is waiting',
    nu.items.slice(0, 5).every((x) => x.kind === 'reply'), nu.items.map((x) => x.kind));
  ok('  overflow is a COUNT, not a list', typeof nu.overflow === 'number' && nu.overflow > 0, nu.overflow);
  ok('  and the total is honest', nu.total === nu.items.length + nu.overflow, [nu.total, nu.overflow]);

  // With few replies, the order is replies -> the morning's work -> programmes.
  //
  // THE SEED HAD TO GROW A REACHABLE CHANNEL ON EVERY ROW. It used to insert a
  // draft with no address and a DM card with no handle and no message, and both
  // still counted, because the report counted rows rather than work. They are
  // now judged the way Home judges them -- an email needs an address, a DM needs
  // a handle and something to send -- so an unreachable row is correctly absent
  // from both. The 'queue' item is programme applications, which are excluded
  // from the mixed queue and counted on their own.
  await P.query(`DELETE FROM outreach_logs WHERE agent_id = $1 AND id LIKE 'r%' AND id <> 'r0'`, [AG]);
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, sent_to_email, created_at)
                 VALUES ('dr2',$1,$2,'D2','draft','owner@d2.example',NOW())`, [AG, ATH]);
  await P.query(`UPDATE outreach_logs SET sent_to_email = 'owner@d1.example' WHERE id = 'dr1'`);
  await P.query(`UPDATE outreach_queue SET instagram = 'qshop', dm_text = 'Hi — a quick idea.'
                  WHERE agent_id = $1 AND brand_name = 'Q'`, [AG]);
  await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state, program_url)
                 VALUES ($1,$2,2,'q2','ProgBrand','program','queued','https://x.example/apply')`, [AG, ATH]);
  d = await rep();
  ok('order is replies, then the morning\'s work, then programmes',
    d.needsYou.items.map((x) => x.kind).join(',') === 'reply,approve,queue',
    d.needsYou.items.map((x) => x.kind));
  const ord = d.needsYou.items.find((x) => x.kind === 'approve');
  ok('  and the work item counts the email AND the DM', ord.total === 3, ord && ord.total);
  ok('  the programme item counts only the programme',
    d.needsYou.items.find((x) => x.kind === 'queue').total === 1);

  // ── MOVING ───────────────────────────────────────────────────────────────
  await P.query(`INSERT INTO deals (id, agent_id, athlete_id, data) VALUES
      ('dl1',$1,$2,'{"stage":"Closed","value":"5000"}'::jsonb),
      ('dl2',$1,$2,'{"stage":"Negotiating","value":"3000"}'::jsonb),
      ('dl3',$1,$2,'{"stage":"Lost","value":"9999"}'::jsonb)`, [AG, ATH]);
  d = await rep();
  // MOVING IS OFF NOW, by request: the deals table takes rows from the demo
  // seeder, from an auto-created Prospecting row per scanned brand, and from a
  // public form booking the midpoint of a budget bracket, so neither figure is
  // defensible. The assertions below moved from "the report carries the figures"
  // to "the report carries nothing" plus "the maths is still right when the flag
  // is on", which is what the code now claims.
  ok('moving is absent from the report while MOVING_ENABLED is off', d.moving === null, d.moving);
  {
    const SRmod = require(ROOT + 'server/services/shiftReport.js');
    ok('  and the flag is what turns it off', SRmod.MOVING_ENABLED === false);
    // The query itself is unchanged; run it directly to prove the maths still
    // holds for whenever the figures become trustworthy enough to show.
    const rows = (await P.query(
      `SELECT COALESCE(SUM(COALESCE(NULLIF(data->>'value',''),'0')::numeric)
                FILTER (WHERE data->>'stage' = 'Closed'),0)::numeric AS earned,
              COALESCE(SUM(COALESCE(NULLIF(data->>'value',''),'0')::numeric)
                FILTER (WHERE data->>'stage' <> 'Closed'
                          AND data->>'stage' NOT IN ('Lost','Dead','Rejected','Declined')),0)::numeric AS inflight,
              COUNT(*) FILTER (WHERE data->>'stage' <> 'Closed'
                          AND data->>'stage' NOT IN ('Lost','Dead','Rejected','Declined'))::int AS n
         FROM deals WHERE agent_id = $1`, [AG])).rows[0];
    ok('  earned would count Closed only (5000)', Number(rows.earned) === 5000, rows.earned);
    ok('  in flight would count live deals (3000)', Number(rows.inflight) === 3000, rows.inflight);
    ok('  and a Lost deal would be in NEITHER figure', rows.n === 1, rows);
  }

  // ── PAGE AND EMAIL ARE ONE SOURCE ────────────────────────────────────────
  const mail = renderShiftEmail(d, { appUrl: 'https://app.test', agentName: 'Sam Rivera' });
  ok('the email carries the SAME sentence', mail.html.indexOf(d.sentence) !== -1
    || mail.text.indexOf(d.sentence) !== -1, d.sentence);
  // Every item still reaches the email -- but the approve item is now rendered
  // by READY TO SEND, which names the athletes it is for, rather than a second
  // time as a bare count. Printing both gave one pile two different numbers.
  ok('  every item still reaches the email',
    d.needsYou.items.every((it) => it.kind === 'approve'
      ? /READY TO SEND/.test(mail.text)
      : mail.text.indexOf(it.line) !== -1), mail.text);
  ok('  and the draft pile is counted once, not twice',
    (mail.text.match(/ready for you/g) || []).length === 0, mail.text);
  ok('  the same overflow line', d.needsYou.overflow === 0 || /more waiting\./.test(mail.text), mail.text);
  ok('  buttons deep-link into the app', /https:\/\/app\.test\/\?view=/.test(mail.html), mail.html.slice(0, 200));
  // THE SUBJECT SAYS WHAT HAPPENED, not how many rows are on a list. It used to
  // read "1 thing need you this morning" -- ungrammatical, and identical whether
  // a brand had replied or five cards were simply sitting there.
  ok('  the subject names the brand that replied',
    /^Replier 0 replied/.test(mail.subject), mail.subject);
  ok('  and never counts internal items', !/thing[s]? need you/.test(mail.subject), mail.subject);
  ok('  it greets by first name only', /Good morning, Sam\./.test(mail.html), mail.subject);
  ok('  and has a plain-text alternative', mail.text.length > 20, mail.text.length);

  // Nothing waiting -> a different subject, still honest.
  const quiet = JSON.parse(JSON.stringify(d));
  quiet.needsYou = { items: [], overflow: 0, total: 0 };
  // The batch has to be emptied too. Clearing needsYou alone leaves pitches
  // genuinely waiting on approval, and "nothing needs you" over a full Ready to
  // send block would be the email lying.
  quiet.closer = Object.assign({}, quiet.closer, { pendingApproval: 0, byAthlete: [] });
  const qm = renderShiftEmail(quiet, { appUrl: 'https://app.test' });
  ok('an empty queue gets its own subject', /nothing needs you/i.test(qm.subject), qm.subject);
  ok('  and says so in the body', /Nothing needs you right now/.test(qm.html), qm.subject);

  // ── SEND WINDOW ──────────────────────────────────────────────────────────
  const sat = new Date('2026-08-22T03:00:00Z');              // Saturday
  const slot = SW.nextSendSlot(sat, { businessAddress: '1 Main St, Birmingham, AL 35203', key: 'k' });
  const p = SW.partsIn(slot.at, slot.timezone);
  ok('a Saturday draft releases on a WEEKDAY', [2, 3, 4].indexOf(p.dow) !== -1, p);
  ok('  never a weekend', p.dow !== 0 && p.dow !== 6, p.dow);
  ok('  mid-morning local', p.minutes >= 570 && p.minutes <= 660, p.minutes);
  ok('  in the RECIPIENT\'s timezone, not ours', slot.timezone === 'America/Chicago', slot.timezone);
  const ca = SW.nextSendSlot(sat, { businessAddress: '9 Ocean Ave, Santa Monica, CA 90401', key: 'k' });
  ok('  a California business gets Pacific', ca.timezone === 'America/Los_Angeles', ca.timezone);
  ok('  and lands mid-morning THERE', (() => { const q = SW.partsIn(ca.at, ca.timezone); return q.minutes >= 570 && q.minutes <= 660; })());
  ok('  an unknown location falls back to Central, not UTC',
    SW.nextSendSlot(sat, { key: 'k' }).timezone === 'America/Chicago');
  // 3am is never sendable, in any zone.
  ok('3am is never a legal send time', !SW.isSendable(new Date('2026-08-25T08:07:00Z'), { businessAddress: 'x, AL' }));
  // Monday and Friday are excluded.
  for (const day of ['2026-08-24T15:00:00Z', '2026-08-28T15:00:00Z']) {
    ok('  ' + day.slice(0, 10) + ' (Mon/Fri) is not sendable',
      !SW.isSendable(new Date(day), { businessAddress: 'x, AL' }));
  }
  // The slot is deterministic: the same draft always resolves to the same minute.
  ok('the slot is deterministic for a given draft',
    SW.nextSendSlot(sat, { key: 'abc' }).at.getTime() === SW.nextSendSlot(sat, { key: 'abc' }).at.getTime());
  ok('  and spread across the window by key',
    SW.slotMinute('abc') !== SW.slotMinute('xyz'));

  await wipe();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
